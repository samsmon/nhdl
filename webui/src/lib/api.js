// Central HTTP client for NHDL Daemon REST API (see docs/API.md).
// Components and stores must call these helpers instead of invoking fetch() directly.

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.reload();
    throw new Error('Unauthorized');
  }
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function fetchStatus() {
  const { data } = await requestJson('/api/status');
  return data;
}

export async function saveQueue(content) {
  const { data } = await requestJson('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  return data;
}

export async function importQueue(text, format = '') {
  const { data } = await requestJson('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, format })
  });
  return data;
}

export async function sendControl(action) {
  const { data } = await requestJson('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  return data;
}

export async function triggerRetry(galleryId = null) {
  const payload = galleryId !== null && galleryId !== undefined ? { galleryId } : {};
  const { data } = await requestJson('/api/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return data;
}

export async function fetchConfig() {
  const { data } = await requestJson('/api/config');
  return data;
}

export async function saveConfig(payload) {
  const { data } = await requestJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return data;
}

export async function verifyApiKey(apiKey) {
  const { data } = await requestJson('/api/config/verify-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey })
  });
  return data;
}

export async function fetchLibrary() {
  const { data } = await requestJson('/api/library');
  return data;
}

export async function rescanLibrary() {
  const { data } = await requestJson('/api/library/rescan', {
    method: 'POST'
  });
  return data;
}

export async function renameLibraryEntry(id, newName) {
  const { data } = await requestJson('/api/library/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, newName })
  });
  return data;
}

export async function compressLibraryEntry(id, ext = 'cbz') {
  const { data } = await requestJson('/api/library/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ext })
  });
  return data;
}

export async function startBatchCompress(ids, ext = 'cbz') {
  const { data } = await requestJson('/api/library/compress-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, ext })
  });
  return data;
}

export async function fetchCompressStatus() {
  const { data } = await requestJson('/api/library/compress-status');
  return data;
}

export async function fetchLogs(limit = 500) {
  const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const { data } = await requestJson(`/api/logs${query}`);
  return data;
}

export async function browseFs(dirPath = '') {
  const { data } = await requestJson(`/api/fs?path=${encodeURIComponent(dirPath || '')}`);
  return data;
}

export async function logout() {
  const { data } = await requestJson('/api/logout', {
    method: 'POST'
  });
  return data;
}
