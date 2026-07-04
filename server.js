const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
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

app.post('/api/build', async (req, res) => {
  try {
    const { appName, packageId, htmlCode } = req.body || {};

    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({ error: 'appName is required.' });
    }
    if (!packageId || !/^([a-zA-Z][a-zA-Z0-9_]*\.)+[a-zA-Z][a-zA-Z0-9_]*$/.test(packageId)) {
      return res.status(400).json({ error: 'A valid packageId is required.' });
    }
    if (!htmlCode || typeof htmlCode !== 'string') {
      return res.status(400).json({ error: 'htmlCode is required.' });
    }

    const buildId = crypto.randomUUID();
    const filePath = `builds/${buildId}/index.html`;

    builds.set(buildId, {
      status: 'queued',
      appName,
      packageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      downloadUrl: null,
      error: null,
    });

    const putRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: githubHeaders(),
        body: JSON.stringify({
          message: `knanGuz: add build payload ${buildId}`,
          content: Buffer.from(htmlCode, 'utf-8').toString('base64'),
        }),
      }
    );

    if (!putRes.ok) {
      const errText = await putRes.text();
      throw new Error(`GitHub Contents API failed: ${putRes.status} ${errText}`);
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
            payload_path: filePath,
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
  if (!record) {
    return res.status(404).json({ error: 'Unknown buildId.' });
  }
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
  if (!record) {
    return res.status(404).json({ error: 'Unknown build_id.' });
  }

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
});
