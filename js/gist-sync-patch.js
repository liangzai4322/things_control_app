(() => {
  const STORAGE_KEY = 'taskbox_data';
  const BAD_TOKEN_KEY = 'taskbox_gist_bad_token';
  const GIST_OWNER = 'liangzai4322';
  const GIST_ID = 'dee00431619fe628079ffa9713994fc7';
  const GIST_API_URL = `https://api.github.com/gists/${GIST_ID}`;
  const GIST_RAW_BASE = `https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw`;
  const FILES = {
    taskbox: 'taskbox-backup.json',
    points: 'mock-points.json',
    pavilion: 'pavilion.json',
    tower: 'tower.json',
  };
  const RAW_URLS = Object.fromEntries(
    Object.values(FILES).map((filename) => [filename, `${GIST_RAW_BASE}/${filename}`])
  );
  const LEGACY_GIST_IDS = new Set([
    GIST_ID,
    '90218455bf94dbce57dedabb07fa386a',
    '6a56c7352da690f8aeca47262361243b',
  ]);
  const OLD_REPO_MARK = 'raw.githubusercontent.com/liangzai4322/things-control-data/';
  const oldFetch = window.fetch.bind(window);
  const SECRET_VALUE_PATTERNS = [
    /ghp_[A-Za-z0-9]{36}/g,
    /github_pat_[A-Za-z0-9_]+/g,
    /gho_[A-Za-z0-9]{36}/g,
    /ghu_[A-Za-z0-9]{36}/g,
    /ghs_[A-Za-z0-9]{36}/g,
    /ghr_[A-Za-z0-9]{36}/g,
    /sk-[A-Za-z0-9_-]{20,}/g,
    /https:\/\/flomoapp\.com\/iwh\/[^\s"']+/g,
  ];

  function readData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function cleanToken(value = '') {
    const token = String(value).trim().replace(/^\[|\]$/g, '');
    return token.startsWith('$2a$') ? '' : token;
  }

  function scrubSecrets(value = '') {
    return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, ''), String(value));
  }

  function getHeader(headers, name) {
    if (!headers) return '';
    if (headers instanceof Headers) return headers.get(name) || '';
    const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : '';
  }

  function getBearerToken(headers) {
    return String(getHeader(headers, 'Authorization')).replace(/^Bearer\s+/i, '').trim();
  }

  function tokenFingerprint(token = '') {
    const value = cleanToken(token);
    if (!value) return '';
    return `${value.slice(0, 6)}:${value.slice(-6)}`;
  }

  function readBadToken() {
    try {
      return JSON.parse(localStorage.getItem(BAD_TOKEN_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function isTokenBlocked(token) {
    const blocked = readBadToken();
    if (!blocked || blocked.fingerprint !== tokenFingerprint(token)) return false;
    return Date.now() - Number(blocked.at || 0) < 10 * 60 * 1000;
  }

  function rememberBadToken(token, status) {
    const fingerprint = tokenFingerprint(token);
    if (!fingerprint) return;
    localStorage.setItem(BAD_TOKEN_KEY, JSON.stringify({ fingerprint, status, at: Date.now() }));
  }

  function showAuthFailedToast() {
    window.TaskBoxApp?.showToast?.('GitHub Token 无效或缺少 gist 权限，已本地保存，暂停云端写回');
  }

  function filenameFromUrl(url = '') {
    const decoded = decodeURIComponent(String(url));
    return Object.values(FILES).find((filename) => decoded.includes(`/${filename}`) || decoded.endsWith(filename)) || '';
  }

  function gistIdFromUrl(url = '') {
    const match = String(url).match(/(?:gist\.githubusercontent\.com\/[^/]+\/|api\.github\.com\/gists\/)([a-f0-9]+)/i);
    return match ? match[1] : '';
  }

  function isManagedLegacySource(url = '') {
    const gistId = gistIdFromUrl(url);
    return Boolean((gistId && LEGACY_GIST_IDS.has(gistId)) || String(url).includes(OLD_REPO_MARK));
  }

  function normalizeUrl(value, filename) {
    const url = String(value || '').trim();
    if (!url || isManagedLegacySource(url)) return RAW_URLS[filename];
    return url;
  }

  function withGistSettings(data) {
    const next = data && typeof data === 'object' ? { ...data } : {};
    const settings = { ...(next.settings || {}) };
    const token = cleanToken(settings.githubToken || settings.cloudToken || '');
    next.settings = {
      ...settings,
      cloudEnabled: true,
      cloudProvider: 'gist',
      cloudEndpoint: normalizeUrl(settings.cloudEndpoint, FILES.taskbox),
      pointsDataUrl: normalizeUrl(settings.pointsDataUrl, FILES.points),
      pavilionDataUrl: normalizeUrl(settings.pavilionDataUrl, FILES.pavilion),
      towerDataUrl: normalizeUrl(settings.towerDataUrl, FILES.tower),
      cloudToken: '',
      githubToken: settings.githubToken || token,
    };
    next.meta = { ...(next.meta || {}), updatedAt: next.meta?.updatedAt || new Date().toISOString() };
    return next;
  }

  function hasLocalTaskboxData(data) {
    return Boolean(data && (Array.isArray(data.boxes) || Array.isArray(data.tasks)));
  }

  function getWriteToken(headers) {
    return getBearerToken(headers) || cleanToken(readData()?.settings?.githubToken || readData()?.settings?.cloudToken || '');
  }

  async function buildGistApiPayload() {
    const entries = await Promise.all(Object.values(FILES).map(async (filename) => {
      const response = await oldFetch(RAW_URLS[filename], { cache: 'no-store' });
      const content = response.ok ? await response.text() : '';
      return [filename, { content, raw_url: RAW_URLS[filename] }];
    }));
    return new Response(JSON.stringify({ files: Object.fromEntries(entries) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async function patchGistFile(filename, content, token) {
    const clean = cleanToken(token);
    if (!clean || isTokenBlocked(clean)) {
      if (clean) showAuthFailedToast();
      return new Response(JSON.stringify({ message: 'gist_auth_blocked' }), { status: 401 });
    }

    const response = await oldFetch(GIST_API_URL, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${clean}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: { [filename]: { content: scrubSecrets(content) } } }),
    });
    if (response.status === 401 || response.status === 403) {
      rememberBadToken(clean, response.status);
      showAuthFailedToast();
    }
    return response;
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const filename = filenameFromUrl(url);

    if (method === 'GET' && filename && isManagedLegacySource(url)) {
      return oldFetch(RAW_URLS[filename], { cache: init.cache || 'no-store' });
    }

    if (method === 'GET' && String(url || '').includes('api.github.com/gists/') && isManagedLegacySource(url)) {
      return buildGistApiPayload();
    }

    if ((method === 'PATCH' || method === 'PUT') && filename && isManagedLegacySource(url)) {
      const rawBody = typeof init.body === 'string' ? init.body : JSON.stringify(init.body || {});
      let content = rawBody;
      try {
        const parsed = JSON.parse(rawBody);
        content = parsed.files?.[filename]?.content || JSON.stringify(parsed, null, 2);
      } catch {
        // Keep the original body for raw PUT compatibility.
      }
      return patchGistFile(filename, content, getWriteToken(init.headers));
    }

    if (method === 'PATCH' && String(url || '').replace(/\/$/, '') === GIST_API_URL) {
      const token = getBearerToken(init.headers);
      if (token && isTokenBlocked(token)) {
        showAuthFailedToast();
        return new Response(JSON.stringify({ message: 'gist_auth_blocked' }), { status: 401 });
      }
      const response = await oldFetch(input, init);
      if (response.status === 401 || response.status === 403) {
        rememberBadToken(token, response.status);
        showAuthFailedToast();
      }
      return response;
    }

    return oldFetch(input, init);
  };

  async function primeFromGist() {
    const local = readData();
    if (hasLocalTaskboxData(local)) {
      writeData(withGistSettings(local));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await oldFetch(RAW_URLS[FILES.taskbox], { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const remote = await response.json();
      writeData(withGistSettings(remote));
    } catch {
      // Do not block app boot if the first remote read is slow or unavailable.
    } finally {
      clearTimeout(timer);
    }
  }

  window.__taskboxGistPatchReady = Promise.race([
    primeFromGist(),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
})();
