const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const {
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  BUILD_CALLBACK_SECRET,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

const GITHUB_API = 'https://api.github.com';
const builds = new Map();

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

  if (lang === 'svelte') {
    // Svelte needs a build step — we wrap it in a note for now
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
<style>body{font-family:sans-serif;padding:20px;background:#0f172a;color:#fff;}</style>
</head><body>
<h2>⚠️ Svelte Support</h2>
<p>Svelte requires a compile step. Please compile your Svelte app to HTML/JS first using the Svelte REPL at <a href="https://svelte.dev/repl" style="color:#34d399">svelte.dev/repl</a>, then paste the output HTML here using the HTML/CSS/JS option.</p>
</body></html>`;
  }

  return code;
}

app.post('/api/build', async (req, res) => {
  try {
    const { appName, packageId, htmlCode, iconBase64, iconMime, lang } = req.body || {};

    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({ error: 'appName is required.' });
    }
    if (!packageId || !/^([a-zA-Z][a-zA-Z0-9_]*\.)+[a-zA-Z][a-zA-Z0-9_]*$/.test(packageId)) {
      return res.status(400).json({ error: 'A valid packageId is required.' });
    }
    if (!htmlCode || typeof htmlCode !== 'string') {
      return res.status(400).json({ error: 'htmlCode is required.' });
    }
    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !BUILD_CALLBACK_SECRET) {
      return res.status(500).json({ error: 'Server is not configured with GitHub credentials.' });
    }

    // Handle framework code compilation
    let finalHtml = htmlCode;
    if (htmlCode.startsWith('__FRAMEWORK__')) {
      const parts = htmlCode.split('__CODE__');
      const frameworkLang = parts[0].replace('__FRAMEWORK__', '');
      const rawCode = parts[1] || '';
      finalHtml = compileFrameworkCode(frameworkLang, rawCode, appName);
    }

    const buildId = crypto.randomUUID();
    const htmlPath = `builds/${buildId}/index.html`;

    builds.set(buildId, {
      status: 'queued',
      appName,
      packageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      downloadUrl: null,
      error: null,
    });

    await commitFile(
      htmlPath,
      Buffer.from(finalHtml, 'utf-8').toString('base64'),
      `knanGuz: add html payload ${buildId}`
    );

    let iconPath = null;
    if (iconBase64 && iconMime) {
      const ext = iconMime === 'image/png' ? 'png' : iconMime === 'image/webp' ? 'webp' : 'jpg';
      iconPath = `builds/${buildId}/icon.${ext}`;
      await commitFile(
        iconPath,
        iconBase64,
        `knanGuz: add icon payload ${buildId}`
      );
    }

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
            payload_path: htmlPath,
            icon_path: iconPath || '',
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
    status: record.status,
    appName: record.appName,
    packageId: record.packageId,
    downloadUrl: record.downloadUrl,
    error: record.error,
  });
});

app.post('/api/build-complete', (req, res) => {
  const secret = req.header('X-Callback-Secret');
  if (secret !== BUILD_CALLBACK_SECRET) {
    return res.status(401).json({ error: 'Invalid callback secret.' });
  }
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

app.listen(PORT, () => {
  console.log(`[knanGuz] Server listening on port ${PORT}`);
  setInterval(() => {
    fetch(`${PUBLIC_BASE_URL}/healthz`)
      .then(() => console.log('[knanGuz] Keep-alive ping sent'))
      .catch(() => console.log('[knanGuz] Keep-alive ping failed'));
  }, 4 * 60 * 1000);
});
