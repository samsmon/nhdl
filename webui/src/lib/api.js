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
  const { data } = await requestJson('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: content, replace: true })
  });
  return data;
}

export async function importQueue(text, format = '') {
  const { data } = await requestJson('/api/queue/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, replace: false, format })
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
  return {
    ...data,
    hasApiKey: data.hasApiKey ?? data.apiKeyConfigured ?? false,
    maskedKey: data.maskedKey ?? data.apiKeyMasked ?? ''
  };
}

export async function saveConfig(payload) {
  const { data } = await requestJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return {
    ...data,
    hasApiKey: data.hasApiKey ?? data.apiKeyConfigured ?? false,
    maskedKey: data.maskedKey ?? data.apiKeyMasked ?? ''
  };
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
  const items = (data.items || []).map(item => ({
    ...item,
    artist: item.artist ?? item.author ?? null,
    path: item.path ?? item.folder ?? null,
    format: item.format ?? item.archiveExt ?? (item.archived ? 'cbz' : 'folder')
  }));
  return {
    ...data,
    items,
    count: data.count ?? data.total ?? items.length
  };
}

export async function rescanLibrary() {
  const { data } = await requestJson('/api/library/rescan', {
    method: 'POST'
  });
  return {
    ...data,
    remaining: data.remaining ?? data.unchanged ?? 0,
    removed: data.removed ?? data.pruned ?? 0
  };
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
  const { data } = await requestJson('/api/library/batch-compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, ext })
  });
  return data;
}

export async function fetchCompressStatus() {
  const { data } = await requestJson('/api/library/compress-status');
  const job = data.job || data;
  return {
    ...job,
    running: !!(job && job.startedAt && !job.finishedAt)
  };
}

export async function pauseQueueItems(ids) {
  const { data } = await requestJson('/api/queue/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  return data;
}

export async function resumeQueueItems(ids) {
  const { data } = await requestJson('/api/queue/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  return data;
}

export async function deleteQueueItems(ids) {
  const { data } = await requestJson('/api/queue/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  });
  return data;
}

export async function setQueuePriority(ids, action) {
  const { data } = await requestJson('/api/queue/priority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action })
  });
  return data;
}

export async function fetchLogs(limit = 500) {
  const query = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  const { data } = await requestJson(`/api/logs${query}`);
  return {
    ...data,
    logs: data.logs ?? data.log ?? ''
  };
}

export async function fetchGalleryLogs(galleryId, limit = 200) {
  const { data } = await requestJson(
    `/api/logs?galleryId=${encodeURIComponent(galleryId)}&limit=${encodeURIComponent(limit)}`
  );
  return Array.isArray(data) ? data : [];
}

export async function browseFs(dirPath = '') {
  const { data } = await requestJson(`/api/fs/browse?path=${encodeURIComponent(dirPath || '')}`);
  return data;
}

export async function logout() {
  const { data } = await requestJson('/api/logout', {
    method: 'POST'
  });
  return data;
}

export async function fetchDbInfo() {
  const { data } = await requestJson('/api/db/info');
  return data;
}

export async function fetchDbBackups() {
  const { data } = await requestJson('/api/db/backups');
  return data?.backups || [];
}

export async function createDbBackup() {
  const { ok, data } = await requestJson('/api/db/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  if (!ok) throw new Error(data?.error || 'Failed to create backup');
  return data;
}

export async function restoreDbBackup(filename, mode = 'replace') {
  const { ok, status, data } = await requestJson('/api/db/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, mode })
  });
  if (!ok) {
    const err = new Error(data?.error || 'Failed to restore backup');
    err.status = status;
    err.needsPause = data?.needsPause;
    throw err;
  }
  return data;
}

export async function deleteDbBackup(filename) {
  const { ok, data } = await requestJson(`/api/db/backups/${encodeURIComponent(filename)}`, {
    method: 'DELETE'
  });
  if (!ok) throw new Error(data?.error || 'Failed to delete backup');
  return data;
}

export async function importDbData(dataPayload, mode = 'merge') {
  const { ok, status, data } = await requestJson('/api/db/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, data: dataPayload })
  });
  if (!ok) {
    const err = new Error(data?.error || 'Failed to import database');
    err.status = status;
    err.needsPause = data?.needsPause;
    throw err;
  }
  return data;
}

export async function saveBackupSettings(settings) {
  const { ok, data } = await requestJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  if (!ok) throw new Error(data?.error || 'Failed to save backup settings');
  return data;
}

