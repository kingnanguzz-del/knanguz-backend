const express = require('express');
const crypto = require('crypto');
const path = require('path');
const AdmZip = require('adm-zip');

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
const premiumCodes = new Map();
const proCodes = new Map();
const pendingSubscribers = new Map();

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

// Detect framework from ZIP contents
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

// Get build command and output dir for each framework
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
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
</head><body>
<div id="root"></div>
<script src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel">
${code}
const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(React.createElement(App));
<\/script>
</body></html>`;
  }
  if (lang === 'vue') {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
</head><body>
<div id="app"></div>
<script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
<script>
${code}
Vue.createApp(App).mount('#app');
<\/script>
</body></html>`;
  }
  if (lang === 'angular') {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
</head><body>
<div id="app" style="font-family:sans-serif;padding:20px;background:#0f172a;color:#fff;">
<h2>Angular Support</h2>
<p>For full Angular apps, please use the ZIP upload feature under Pro.</p>
</div>
</body></html>`;
  }
  if (lang === 'svelte') {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
<style>body{font-family:sans-serif;padding:20px;background:#0f172a;color:#fff;}</style>
</head><body>
<h2>Svelte Support</h2>
<p>Compile your Svelte app at 
<a href="https://svelte.dev/repl" style="color:#34d399">svelte.dev/repl</a>
then paste the output HTML using HTML/CSS/JS option.</p>
</body></html>`;
  }
  return code;
}

function generateCode(deviceId, tier) {
  const raw = `${deviceId}-${tier}-${Date.now()}-${Math.random()}`;
  const code = crypto.createHash('sha256').update(raw).digest('hex')
    .substring(0, 16).toUpperCase();
  return code.match(/.{1,4}/g).join('-');
}

function checkAccess(deviceId, code, tier) {
  const store = tier === 'pro' ? proCodes : premiumCodes;
  const record = store.get(code);
  if (!record) return { valid: false, reason: 'Invalid code' };
  if (record.revoked) return { valid: false, reason: 'Code revoked' };
  if (record.deviceId !== deviceId) return { valid: false, reason: 'Code not valid for this device' };
  if (Date.now() > record.expiresAt) return { valid: false, reason: 'Code expired' };
  return { valid: true };
}

// -----------------------------------------------------------------------
// PUBLIC ENDPOINTS
// -----------------------------------------------------------------------

app.post('/api/subscribe-request', (req, res) => {
  const { deviceId, tier = 'premium' } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  pendingSubscribers.set(`${deviceId}-${tier}`, {
    deviceId, tier, requestedAt: Date.now(),
  });
  return res.json({ ok: true });
});

app.post('/api/verify-premium', (req, res) => {
  const { deviceId, code, tier = 'premium' } = req.body || {};
  if (!deviceId || !code) return res.status(400).json({ valid: false, reason: 'Missing fields' });
  const result = checkAccess(deviceId, code.toUpperCase().replace(/\s/g, ''), tier);
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

    // Check premium for framework code builds
    const isPremiumLang = ['react', 'vue', 'svelte', 'angular'].includes(lang);
    if (isPremiumLang && buildMode !== 'zip') {
      if (!deviceId || !premiumCode) {
        return res.status(403).json({ error: 'Premium required for this language.' });
      }
      const check = checkAccess(deviceId, premiumCode.toUpperCase().replace(/\s/g, ''), 'premium');
      if (!check.valid) {
        return res.status(403).json({ error: `Premium access denied: ${check.reason}` });
      }
    }

    // Check pro for ZIP builds
    if (buildMode === 'zip') {
      if (!deviceId || !proCode) {
        return res.status(403).json({ error: 'Pro required for ZIP builds.' });
      }
      const check = checkAccess(deviceId, proCode.toUpperCase().replace(/\s/g, ''), 'pro');
      if (!check.valid) {
        return res.status(403).json({ error: `Pro access denied: ${check.reason}` });
      }
    }

    const buildId = crypto.randomUUID();
    let finalHtml = '';
    let zipPath = null;
    let detectedFramework = 'html';
    let buildConfig = null;

    if (buildMode === 'zip' && zipBase64) {
      // Handle ZIP upload
      const zipBuffer = Buffer.from(zipBase64, 'base64');
      const zip = new AdmZip(zipBuffer);
      const fileList = zip.getEntries().map(e => e.entryName);
      detectedFramework = detectFramework(fileList);
      buildConfig = getBuildConfig(detectedFramework);

      // Commit ZIP to repo
      zipPath = `builds/${buildId}/project.zip`;
      await commitFile(
        zipPath,
        zipBase64,
        `knanGuz: add zip payload ${buildId}`
      );
    } else {
      // Handle code paste
      if (!htmlCode || typeof htmlCode !== 'string') {
        return res.status(400).json({ error: 'htmlCode is required.' });
      }
      if (htmlCode.startsWith('__FRAMEWORK__')) {
        const parts = htmlCode.split('__CODE__');
        const frameworkLang = parts[0].replace('__FRAMEWORK__', '');
        const rawCode = parts[1] || '';
        finalHtml = compileFrameworkCode(frameworkLang, rawCode, appName);
      } else {
        finalHtml = htmlCode;
      }
      const htmlPath = `builds/${buildId}/index.html`;
      await commitFile(
        htmlPath,
        Buffer.from(finalHtml, 'utf-8').toString('base64'),
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

    // ICON FIX: wait 3 seconds so GitHub registers all commits before dispatch
    await new Promise(r => setTimeout(r, 3000));

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
            build_install: buildConfig ? buildConfig.install : '',
            build_cmd: buildConfig ? buildConfig.build : '',
            build_out_dir: buildConfig ? buildConfig.outDir : '',
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
  const subscribers = Array.from(pendingSubscribers.values())
    .sort((a, b) => b.requestedAt - a.requestedAt);
  const premiumUsers = Array.from(premiumCodes.entries()).map(([code, data]) => ({
    code, ...data, tier: 'premium', expired: Date.now() > data.expiresAt,
  }));
  const proUsers = Array.from(proCodes.entries()).map(([code, data]) => ({
    code, ...data, tier: 'pro', expired: Date.now() > data.expiresAt,
  }));
  return res.json({ subscribers, premiumUsers: [...premiumUsers, ...proUsers] });
});

app.post('/api/admin/generate-code', adminAuth, (req, res) => {
  const { deviceId, tier = 'premium' } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const code = generateCode(deviceId, tier);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const store = tier === 'pro' ? proCodes : premiumCodes;
  store.set(code, { deviceId, tier, createdAt: Date.now(), expiresAt, revoked: false });
  pendingSubscribers.delete(`${deviceId}-${tier}`);
  return res.json({ code, expiresAt, tier });
});

app.post('/api/admin/revoke-code', adminAuth, (req, res) => {
  const { code } = req.body || {};
  let record = premiumCodes.get(code) || proCodes.get(code);
  if (!record) return res.status(404).json({ error: 'Code not found' });
  record.revoked = true;
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
    <input id="adminPwd" type="password" placeholder="Enter admin password"
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

  <div class="bg-slate-800 rounded-2xl p-6">
    <h2 class="text-sm font-semibold uppercase tracking-wider text-emerald-400 mb-4">📥 Pending Subscribers</h2>
    <div id="subscribersList"><p class="text-xs text-slate-500">Loading...</p></div>
  </div>

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
    renderPremium(data.premiumUsers || []);
  }

  function renderSubscribers(list) {
    const el = document.getElementById('subscribersList');
    if (!list.length) { el.innerHTML = '<p class="text-xs text-slate-500">No pending subscribers.</p>'; return; }
    el.innerHTML = list.map(s => \`
      <div class="bg-slate-900 rounded-xl p-4 flex items-center justify-between gap-4 mb-3">
        <div>
          <p class="text-xs text-slate-400">Device ID</p>
          <p class="text-sm font-mono text-slate-200">\${s.deviceId}</p>
          <p class="text-xs text-slate-500 mt-1">\${new Date(s.requestedAt).toLocaleString()}</p>
        </div>
        <div class="flex gap-2">
          <button onclick="generateCode('\${s.deviceId}', 'premium')"
            class="bg-yellow-600 hover:bg-yellow-500 text-white font-semibold rounded-lg px-3 py-2 text-xs">
            Premium $5
          </button>
          <button onclick="generateCode('\${s.deviceId}', 'pro')"
            class="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg px-3 py-2 text-xs">
            Pro $10
          </button>
        </div>
      </div>
    \`).join('');
  }

  function renderPremium(list) {
    const el = document.getElementById('premiumList');
    if (!list.length) { el.innerHTML = '<p class="text-xs text-slate-500">No users yet.</p>'; return; }
    el.innerHTML = list.map(u => \`
      <div class="bg-slate-900 rounded-xl p-4 mb-3">
        <div class="flex items-center justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-mono bg-emerald-900 text-emerald-300 px-2 py-1 rounded">\${u.code}</span>
              <span class="text-xs px-2 py-1 rounded \${u.tier === 'pro' ? 'bg-blue-900 text-blue-300' : 'bg-yellow-900 text-yellow-300'}">\${u.tier?.toUpperCase()}</span>
              \${u.revoked ? '<span class="text-xs text-red-400">REVOKED</span>' : ''}
              \${u.expired && !u.revoked ? '<span class="text-xs text-yellow-400">EXPIRED</span>' : ''}
              \${!u.revoked && !u.expired ? '<span class="text-xs text-emerald-400">ACTIVE</span>' : ''}
            </div>
            <p class="text-xs text-slate-500">Device: \${u.deviceId}</p>
            <p class="text-xs text-slate-500">Expires: \${new Date(u.expiresAt).toLocaleDateString()}</p>
          </div>
          <div class="flex gap-2">
            <button onclick="copyCode('\${u.code}')" class="bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg px-3 py-2 text-xs">Copy</button>
            \${!u.revoked ? \`<button onclick="revokeCode('\${u.code}')" class="bg-red-900 hover:bg-red-800 text-red-300 rounded-lg px-3 py-2 text-xs">Revoke</button>\` : ''}
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
      await navigator.clipboard.writeText(data.code);
      alert(\`\${tier.toUpperCase()} code generated and copied!\\n\\n\${data.code}\\n\\nExpires: \${new Date(data.expiresAt).toLocaleDateString()}\`);
      loadDashboard();
    }
  }

  async function revokeCode(code) {
    if (!confirm('Revoke this code?')) return;
    await fetch('/api/admin/revoke-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': adminPassword },
      body: JSON.stringify({ code })
    });
    loadDashboard();
  }

  function copyCode(code) { navigator.clipboard.writeText(code); alert('Copied: ' + code); }
  document.getElementById('adminPwd').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
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
