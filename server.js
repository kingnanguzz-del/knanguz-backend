const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  BUILD_CALLBACK_SECRET,
  PUBLIC_BASE_URL,
  ADMIN_PASSWORD,
  ADMIN_PATH,
  PORT = 3000,
} = process.env;

const GITHUB_API = 'https://api.github.com';
const builds = new Map();

// ===== TEMPORARY: set to false to bring payment restrictions back =====
const FREE_MODE = true;

// -----------------------------------------------------------------------
// PERSISTENT STORAGE
// -----------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const CODES_FILE = path.join(DATA_DIR, 'codes.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const AUTHORIZED_FILE = path.join(DATA_DIR, 'authorized.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error('loadJSON error:', e.message); }
  return fallback;
}

function saveJSON(file, data) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error('saveJSON error:', e.message); }
}

let codesStore = loadJSON(CODES_FILE, {});
let subscribersStore = loadJSON(SUBSCRIBERS_FILE, {});
let authorizedStore = loadJSON(AUTHORIZED_FILE, {});

function saveCodes() { saveJSON(CODES_FILE, codesStore); }
function saveSubscribers() { saveJSON(SUBSCRIBERS_FILE, subscribersStore); }
function saveAuthorized() { saveJSON(AUTHORIZED_FILE, authorizedStore); }

// -----------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------
function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

async function commitFile(filePath, base64Content, message) {
  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: githubHeaders(),
      body: JSON.stringify({ message, content: base64Content }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub Contents API failed: ${res.status} ${err}`);
  }
}

function detectFramework(fileList) {
  const files = fileList.map(f => f.toLowerCase());
  const hasFile = (name) => files.some(f => f.endsWith(name) || f.includes('/' + name));
  const hasExt = (ext) => files.some(f => f.endsWith(ext));
  if (hasFile('angular.json')) return 'angular';
  if (hasFile('next.config.js') || hasFile('next.config.ts')) return 'nextjs';
  if (hasFile('nuxt.config.js') || hasFile('nuxt.config.ts')) return 'nuxt';
  if (hasFile('svelte.config.js')) return 'svelte';
  if (hasFile('vue.config.js') || hasExt('.vue')) return 'vue';
  if (hasExt('.jsx') || hasExt('.tsx')) return 'react';
  if (hasFile('package.json')) return 'node';
  if (hasFile('index.html')) return 'html';
  return 'unknown';
}

function getBuildConfig(framework) {
  const configs = {
    react:   { install: 'npm install', build: 'npm run build', outDir: 'build' },
    vue:     { install: 'npm install', build: 'npm run build', outDir: 'dist' },
    angular: { install: 'npm install', build: 'npx ng build --configuration production', outDir: 'dist' },
    nextjs:  { install: 'npm install', build: 'npm run build && npm run export', outDir: 'out' },
    nuxt:    { install: 'npm install', build: 'npm run generate', outDir: 'dist' },
    svelte:  { install: 'npm install', build: 'npm run build', outDir: 'public' },
    node:    { install: 'npm install', build: 'npm run build', outDir: 'dist' },
    html:    { install: '', build: '', outDir: '.' },
    unknown: { install: 'npm install --if-present', build: 'npm run build --if-present', outDir: 'dist' },
  };
  return configs[framework] || configs.unknown;
}

function compileFrameworkCode(lang, code, appName) {
  if (lang === 'react') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title></head><body>
<div id="root"></div>
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel">
${code}
const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(React.createElement(App));
<\/script></body></html>`;
  }
  if (lang === 'vue') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title></head><body>
<div id="app"></div>
<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
<script>${code}
Vue.createApp(App).mount('#app');
<\/script></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title></head><body>${code}</body></html>`;
}

function generateCode(deviceId, tier) {
  const raw = `${deviceId}-${tier}-${Date.now()}-${Math.random()}`;
  const code = crypto.createHash('sha256').update(raw).digest('hex')
    .substring(0, 16).toUpperCase();
  return code.match(/.{1,4}/g).join('-');
}

function checkAccess(deviceId, code, tier) {
  if (FREE_MODE) return { valid: true, source: 'free-mode' };
  // Check manual authorization first — permanent, no expiry
  const manualAuth = authorizedStore[deviceId];
  if (manualAuth && !manualAuth.revoked) {
    if (manualAuth.tier === tier || manualAuth.tier === 'pro') {
      return { valid: true, source: 'manual' };
    }
  }
  // Check code-based access
  if (!code) return { valid: false, reason: 'No code provided' };
  const cleanCode = code.toUpperCase().replace(/\s/g, '');
  const record = codesStore[cleanCode];
  if (!record) return { valid: false, reason: 'Invalid code' };
  if (record.revoked) return { valid: false, reason: 'Code has been revoked' };
  if (record.deviceId !== deviceId) return { valid: false, reason: 'Code not valid for this device' };
  if (record.expiresAt && Date.now() > record.expiresAt) return { valid: false, reason: 'Code has expired' };
  if (record.tier !== tier && !(record.tier === 'pro' && tier === 'premium')) {
    return { valid: false, reason: `This code is for ${record.tier}, not ${tier}` };
  }
  return { valid: true, source: 'code' };
}

// -----------------------------------------------------------------------
// PUBLIC ENDPOINTS
// -----------------------------------------------------------------------

app.post('/api/subscribe-request', (req, res) => {
  const { deviceId, tier = 'premium' } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const key = `${deviceId}-${tier}`;
  subscribersStore[key] = { deviceId, tier, requestedAt: Date.now() };
  saveSubscribers();
  return res.json({ ok: true });
});

app.post('/api/verify-premium', (req, res) => {
  const { deviceId, code, tier = 'premium' } = req.body || {};
  if (!deviceId) return res.status(400).json({ valid: false, reason: 'Missing deviceId' });
  const result = checkAccess(deviceId, code || '', tier);
  return res.json(result);
});

app.post('/api/build', async (req, res) => {
  try {
    const {
      appName, packageId, htmlCode,
      iconBase64, iconMime, lang,
      deviceId, premiumCode, proCode,
      zipBase64, buildMode,
    } = req.body || {};

    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({ error: 'appName is required.' });
    }
    if (!packageId || !/^([a-zA-Z][a-zA-Z0-9_]*\.)+[a-zA-Z][a-zA-Z0-9_]*$/.test(packageId)) {
      return res.status(400).json({ error: 'A valid packageId is required.' });
    }
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !BUILD_CALLBACK_SECRET) {
      return res.status(500).json({ error: 'Server is not configured.' });
    }

    // Check premium for framework builds
    const isPremiumLang = ['react', 'vue', 'svelte', 'angular'].includes(lang);
    if (isPremiumLang && buildMode !== 'zip') {
      const check = checkAccess(deviceId || '', premiumCode || '', 'premium');
      if (!check.valid) {
        return res.status(403).json({ error: `Premium access denied: ${check.reason}` });
      }
    }

    // Check pro for ZIP builds
    if (buildMode === 'zip') {
      const check = checkAccess(deviceId || '', proCode || '', 'pro');
      if (!check.valid) {
        return res.status(403).json({ error: `Pro access denied: ${check.reason}` });
      }
    }

    const buildId = crypto.randomUUID();
    let zipPath = null;
    let detectedFramework = 'html';
    let buildConfig = null;

    if (buildMode === 'zip' && zipBase64) {
      const AdmZip = require('adm-zip');
      const zipBuffer = Buffer.from(zipBase64, 'base64');
      const zip = new AdmZip(zipBuffer);
      const fileList = zip.getEntries().map(e => e.entryName);
      detectedFramework = detectFramework(fileList);
      buildConfig = getBuildConfig(detectedFramework);
      zipPath = `builds/${buildId}/project.zip`;
      await commitFile(zipPath, zipBase64, `knanGuz: add zip payload ${buildId}`);
    } else {
      if (!htmlCode || typeof htmlCode !== 'string') {
        return res.status(400).json({ error: 'htmlCode is required.' });
      }
      let compiledHtml = htmlCode;
      if (htmlCode.startsWith('__FRAMEWORK__')) {
        const parts = htmlCode.split('__CODE__');
        const frameworkLang = parts[0].replace('__FRAMEWORK__', '');
        const rawCode = parts[1] || '';
        compiledHtml = compileFrameworkCode(frameworkLang, rawCode, appName);
      }
      const htmlPath = `builds/${buildId}/index.html`;
      await commitFile(
        htmlPath,
        Buffer.from(compiledHtml, 'utf-8').toString('base64'),
        `knanGuz: add html payload ${buildId}`
      );
    }

    // Commit icon if uploaded
    let iconPath = null;
    if (iconBase64 && iconMime) {
      const ext = iconMime === 'image/png' ? 'png' : iconMime === 'image/webp' ? 'webp' : 'jpg';
      iconPath = `builds/${buildId}/icon.${ext}`;
      await commitFile(iconPath, iconBase64, `knanGuz: add icon payload ${buildId}`);
    }

    builds.set(buildId, {
      status: 'queued', appName, packageId,
      createdAt: Date.now(), updatedAt: Date.now(),
      downloadUrl: null, error: null,
    });

    // Wait 3 seconds so GitHub registers all commits before dispatch
    await new Promise(r => setTimeout(r, 3000));

    // Build config packed into one string to stay under 10 property limit
    const buildConfigStr = buildConfig
      ? `${buildConfig.install}||${buildConfig.build}||${buildConfig.outDir}`
      : '||||dist';

    const dispatchRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: githubHeaders(),
        body: JSON.stringify({
          event_type: 'build-apk',
          client_payload: {
            build_id: buildId,
            app_name: appName,
            package_id: packageId,
            payload_path: buildMode === 'zip' ? '' : `builds/${buildId}/index.html`,
            zip_path: zipPath || '',
            icon_path: iconPath || '',
            framework: detectedFramework,
            build_config: buildConfigStr,
            callback_url: `${PUBLIC_BASE_URL}/api/build-complete`,
          },
        }),
      }
    );

    if (!dispatchRes.ok) {
      const errText = await dispatchRes.text();
      throw new Error(`GitHub dispatch failed: ${dispatchRes.status} ${errText}`);
    }

    const record = builds.get(buildId);
    record.status = 'dispatched';
    record.updatedAt = Date.now();

    return res.json({ buildId });
  } catch (err) {
    console.error('[knanGuz] /api/build error:', err);
    return res.status(500).json({ error: err.message || 'Failed to start build.' });
  }
});

app.get('/api/status/:buildId', (req, res) => {
  const record = builds.get(req.params.buildId);
  if (!record) return res.status(404).json({ error: 'Unknown buildId.' });
  return res.json({
    status: record.status, appName: record.appName,
    packageId: record.packageId, downloadUrl: record.downloadUrl,
    error: record.error,
  });
});

app.post('/api/build-complete', (req, res) => {
  const secret = req.header('X-Callback-Secret');
  if (secret !== BUILD_CALLBACK_SECRET) return res.status(401).json({ error: 'Invalid secret.' });
  const { build_id, status, download_url, error } = req.body || {};
  const record = builds.get(build_id);
  if (!record) return res.status(404).json({ error: 'Unknown build_id.' });
  record.status = status || record.status;
  record.updatedAt = Date.now();
  if (download_url) record.downloadUrl = download_url;
  if (error) record.error = error;
  builds.set(build_id, record);
  return res.json({ ok: true });
});

app.get('/healthz', (_req, res) => res.send('ok'));

// -----------------------------------------------------------------------
// ADMIN ENDPOINTS
// -----------------------------------------------------------------------

function adminAuth(req, res, next) {
  if (req.header('X-Admin-Password') !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  const subscribers = Object.values(subscribersStore)
    .sort((a, b) => b.requestedAt - a.requestedAt);
  const codeUsers = Object.entries(codesStore).map(([code, data]) => ({
    code, ...data, expired: data.expiresAt && Date.now() > data.expiresAt, source: 'code',
  }));
  const manualUsers = Object.entries(authorizedStore).map(([deviceId, data]) => ({
    deviceId, ...data, source: 'manual', code: 'MANUAL',
  }));
  return res.json({
    subscribers,
    premiumUsers: [...codeUsers, ...manualUsers].sort((a, b) => b.createdAt - a.createdAt),
  });
});

app.post('/api/admin/generate-code', adminAuth, (req, res) => {
  const { deviceId, tier = 'premium' } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const code = generateCode(deviceId, tier);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  codesStore[code] = { deviceId, tier, createdAt: Date.now(), expiresAt, revoked: false };
  saveCodes();
  delete subscribersStore[`${deviceId}-${tier}`];
  saveSubscribers();
  return res.json({ code, expiresAt, tier });
});

app.post('/api/admin/authorize', adminAuth, (req, res) => {
  const { deviceId, tier = 'premium', note = '' } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  authorizedStore[deviceId] = {
    tier, authorizedAt: Date.now(),
    createdAt: Date.now(),
    revoked: false, note,
  };
  saveAuthorized();
  delete subscribersStore[`${deviceId}-${tier}`];
  saveSubscribers();
  return res.json({ ok: true, deviceId, tier });
});

app.post('/api/admin/revoke', adminAuth, (req, res) => {
  const { code, deviceId } = req.body || {};
  if (code && codesStore[code]) {
    codesStore[code].revoked = true;
    saveCodes();
  }
  if (deviceId && authorizedStore[deviceId]) {
    authorizedStore[deviceId].revoked = true;
    saveAuthorized();
  }
  return res.json({ ok: true });
});

app.get(`/${ADMIN_PATH || 'admin'}`, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>knanGuz Admin</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">

<div id="loginScreen" class="flex items-center justify-center min-h-screen">
  <div class="bg-slate-800 rounded-2xl p-8 w-80 space-y-4">
    <h1 class="text-xl font-bold text-emerald-400 text-center">🔐 knanGuz Admin</h1>
    <input id="adminPwd" type="password" placeholder="Admin password"
      class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
    <button onclick="login()"
      class="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold rounded-lg py-2 text-sm">
      Login
    </button>
    <p id="loginError" class="text-xs text-red-400 hidden text-center">Wrong password</p>
  </div>
</div>

<div id="dashboard" class="hidden max-w-4xl mx-auto px-6 py-8 space-y-8">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold text-emerald-400">knanGuz Admin</h1>
    <button onclick="logout()" class="text-xs text-slate-400 hover:text-slate-200">Logout</button>
  </div>

  <!-- Manual Authorize -->
  <div class="bg-slate-800 rounded-2xl p-6">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-400 mb-2">⚡ Manual Authorization</h2>
    <p class="text-xs text-slate-400 mb-4">Authorize any device ID directly — permanent, no expiry, no code needed.</p>
    <div class="space-y-3">
      <input id="manualDeviceId" type="text" placeholder="Device ID (XXXX-XXXX-XXXX-XXXX)"
        class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
      <input id="manualNote" type="text" placeholder="Note (e.g. paid via M-Pesa KES 500)"
        class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
      <div class="flex gap-3">
        <button onclick="manualAuthorize('premium')"
          class="flex-1 bg-yellow-600 hover:bg-yellow-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
          ⭐ Authorize Premium
        </button>
        <button onclick="manualAuthorize('pro')"
          class="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg px-4 py-2 text-sm">
          🚀 Authorize Pro
        </button>
      </div>
    </div>
    <p id="manualMsg" class="text-xs text-emerald-400 hidden mt-3"></p>
  </div>

  <!-- Pending Subscribers -->
  <div class="bg-slate-800 rounded-2xl p-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-400">📥 Pending Subscribers</h2>
      <button onclick="loadDashboard()" class="text-xs text-slate-400 hover:text-slate-200">🔄 Refresh</button>
    </div>
    <div id="subscribersList"><p class="text-xs text-slate-500">Loading...</p></div>
  </div>

  <!-- Active Users -->
  <div class="bg-slate-800 rounded-2xl p-6">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-400 mb-4">⭐ Active Users</h2>
    <div id="premiumList"><p class="text-xs text-slate-500">Loading...</p></div>
  </div>
</div>

<script>
  let adminPassword = '';

  async function login() {
    const pwd = document.getElementById('adminPwd').value;
    const res = await fetch('/api/admin/dashboard', { headers: { 'X-Admin-Password': pwd } });
    if (res.status === 401) { document.getElementById('loginError').classList.remove('hidden'); return; }
    adminPassword = pwd;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    loadDashboard();
  }

  function logout() {
    adminPassword = '';
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
  }

  async function loadDashboard() {
    const res = await fetch('/api/admin/dashboard', { headers: { 'X-Admin-Password': adminPassword } });
    const data = await res.json();
    renderSubscribers(data.subscribers || []);
    renderUsers(data.premiumUsers || []);
  }

  async function manualAuthorize(tier) {
    const deviceId = document.getElementById('manualDeviceId').value.trim();
    const note = document.getElementById('manualNote').value.trim();
    const msg = document.getElementById('manualMsg');
    if (!deviceId) { alert('Please enter a Device ID'); return; }
    const res = await fetch('/api/admin/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify({ deviceId, tier, note })
    });
    const data = await res.json();
    if (data.ok) {
      msg.textContent = '✅ ' + deviceId + ' authorized as ' + tier.toUpperCase() + ' — permanent!';
      msg.classList.remove('hidden');
      document.getElementById('manualDeviceId').value = '';
      document.getElementById('manualNote').value = '';
      loadDashboard();
    }
  }

  function renderSubscribers(list) {
    const el = document.getElementById('subscribersList');
    if (!list.length) { el.innerHTML = '<p class="text-xs text-slate-500">No pending subscribers.</p>'; return; }
    el.innerHTML = list.map(s => \`
      <div class="bg-slate-900 rounded-xl p-4 mb-3">
        <p class="text-xs text-slate-400">Device ID</p>
        <p class="text-sm font-mono text-slate-200 break-all mb-1">\${s.deviceId}</p>
        <p class="text-xs text-slate-500 mb-3">\${s.tier?.toUpperCase()} · \${new Date(s.requestedAt).toLocaleString()}</p>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="generateCode('\${s.deviceId}', 'premium')"
            class="bg-yellow-700 hover:bg-yellow-600 text-white font-semibold rounded-lg px-3 py-2 text-xs">
            ⭐ Code Premium
          </button>
          <button onclick="generateCode('\${s.deviceId}', 'pro')"
            class="bg-blue-700 hover:bg-blue-600 text-white font-semibold rounded-lg px-3 py-2 text-xs">
            🚀 Code Pro
          </button>
          <button onclick="quickAuthorize('\${s.deviceId}', 'premium')"
            class="bg-yellow-900 hover:bg-yellow-800 text-yellow-200 font-semibold rounded-lg px-3 py-2 text-xs">
            ⚡ Auth Premium
          </button>
          <button onclick="quickAuthorize('\${s.deviceId}', 'pro')"
            class="bg-blue-900 hover:bg-blue-800 text-blue-200 font-semibold rounded-lg px-3 py-2 text-xs">
            ⚡ Auth Pro
          </button>
        </div>
      </div>
    \`).join('');
  }

  function renderUsers(list) {
    const el = document.getElementById('premiumList');
    if (!list.length) { el.innerHTML = '<p class="text-xs text-slate-500">No users yet.</p>'; return; }
    el.innerHTML = list.map(u => \`
      <div class="bg-slate-900 rounded-xl p-4 mb-3">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              <span class="text-xs font-mono bg-slate-800 text-slate-300 px-2 py-1 rounded">\${u.code}</span>
              <span class="text-xs px-2 py-1 rounded \${u.tier === 'pro' ? 'bg-blue-900 text-blue-300' : 'bg-yellow-900 text-yellow-300'}">\${u.tier?.toUpperCase()}</span>
              \${u.source === 'manual' ? '<span class="text-xs bg-emerald-900 text-emerald-300 px-2 py-1 rounded">MANUAL</span>' : ''}
              \${u.revoked ? '<span class="text-xs text-red-400">REVOKED</span>' : '<span class="text-xs text-emerald-400">ACTIVE</span>'}
              \${u.expired && !u.revoked ? '<span class="text-xs text-yellow-400">EXPIRED</span>' : ''}
            </div>
            <p class="text-xs text-slate-500 break-all">Device: \${u.deviceId}</p>
            \${u.note ? \`<p class="text-xs text-slate-500">Note: \${u.note}</p>\` : ''}
            \${u.expiresAt
              ? \`<p class="text-xs text-slate-500">Expires: \${new Date(u.expiresAt).toLocaleDateString()}</p>\`
              : '<p class="text-xs text-emerald-600 font-semibold">No expiry — permanent</p>'}
          </div>
          <div class="flex gap-2 flex-shrink-0">
            \${u.code !== 'MANUAL' ? \`<button onclick="copyCode('\${u.code}')" class="bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg px-3 py-2 text-xs">Copy</button>\` : ''}
            \${!u.revoked ? \`<button onclick="revokeUser('\${u.code}', '\${u.deviceId}')" class="bg-red-900 hover:bg-red-800 text-red-300 rounded-lg px-3 py-2 text-xs">Revoke</button>\` : ''}
          </div>
        </div>
      </div>
    \`).join('');
  }

  async function generateCode(deviceId, tier) {
    const res = await fetch('/api/admin/generate-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify({ deviceId, tier })
    });
    const data = await res.json();
    if (data.code) {
      await navigator.clipboard.writeText(data.code).catch(() => {});
      alert(tier.toUpperCase() + ' code generated!\\n\\n' + data.code + '\\n\\nExpires: ' + new Date(data.expiresAt).toLocaleDateString() + '\\n\\nCopied! Send to user via WhatsApp.');
      loadDashboard();
    }
  }

  async function quickAuthorize(deviceId, tier) {
    if (!confirm('Permanently authorize ' + deviceId + ' as ' + tier.toUpperCase() + '?\\nNo expiry — revocable anytime.')) return;
    const res = await fetch('/api/admin/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify({ deviceId, tier, note: 'Quick auth from subscriber list' })
    });
    const data = await res.json();
    if (data.ok) { alert('✅ Authorized as ' + tier.toUpperCase() + '!'); loadDashboard(); }
  }

  async function revokeUser(code, deviceId) {
    if (!confirm('Revoke this access?')) return;
    await fetch('/api/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify({ code: code !== 'MANUAL' ? code : undefined, deviceId })
    });
    loadDashboard();
  }

  function copyCode(code) {
    navigator.clipboard.writeText(code).catch(() => {});
    alert('Copied: ' + code);
  }

  document.getElementById('adminPwd').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[knanGuz] Server listening on port ${PORT}`);
  setInterval(() => {
    fetch(`${PUBLIC_BASE_URL}/healthz`)
      .then(() => console.log('[knanGuz] Keep-alive ping sent'))
      .catch(() => console.log('[knanGuz] Keep-alive ping failed'));
  }, 4 * 60 * 1000);
});
