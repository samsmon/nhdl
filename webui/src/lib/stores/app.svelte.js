import { SvelteMap } from 'svelte/reactivity';
import * as api from '../api.js';
import { urlKey, matchesSourceFilter, countBySource } from '../sources.js';
import { TYPE_ORDER, matchesTypeFilter, countByType } from '../contentType.js';
import { isQueuedStatus, parseAddedAt, cooldownInfo } from '../queueView.js';

// Reactive item map keyed by galleryId string so SSE `item` updates mutate
// only the affected entry without replacing the entire collection.
const itemsById = new SvelteMap();
const libraryById = new SvelteMap();

function buildRawListFromMap(map) {
  if (map.size === 0) return '';
  const rows = Array.from(map.values());
  const lines = [];
  let currentBatch = null;
  for (const row of rows) {
    const b = row.batch || 1;
    if (b !== currentBatch) {
      currentBatch = b;
      const fmtSuffix = row.format ? ` FORMAT=${row.format}` : '';
      lines.push(`# BATCH ${b}${fmtSuffix}`);
    }
    const rawUrl = String(row.url || '').split(' | ')[0].trim() || String(row.galleryId);
    const lineBody = row.title ? `${rawUrl} | ${row.title}` : rawUrl;
    lines.push(`[${row.status}] ${lineBody}`);
  }
  return lines.join('\n');
}

export function extractGalleryId(str) {
  if (!str) return null;
  return urlKey(str);
}

export function parseItemUrl(urlStr) {
  const parts = String(urlStr || '').split(' | ');
  const rawUrl = parts[0].trim();
  const title = parts.length > 1 ? parts.slice(1).join(' | ').trim() : null;
  const id = urlKey(rawUrl) || rawUrl;
  return { rawUrl, id, title };
}

export function getItemRawStatus(item) {
  if (!item) return 'PENDING';
  const raw = String(item.rawStatus || item.status || 'PENDING').toUpperCase();
  if (raw === 'ON_PROGRESS') return 'ON_PROGRESS';
  if (raw === 'STOPPED') return 'STOPPED';
  if (raw === 'DONE') return 'DONE';
  if (raw === 'SKIPPED' || raw.startsWith('SKIPPED')) return 'SKIPPED';
  if (raw === 'PAUSED' || raw.startsWith('PAUSED')) return 'PAUSED';
  if (raw === 'COOLDOWN' || raw.startsWith('COOLDOWN')) return 'COOLDOWN';
  if (raw === 'ERROR' || raw.startsWith('ERROR')) return 'ERROR';
  return 'PENDING';
}

export function getStatusCategory(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'DONE') return 'done';
  if (s === 'SKIPPED' || s.startsWith('SKIPPED')) return 'skipped';
  if (s === 'STOPPED') return 'stopped';
  if (s === 'ERROR' || s.startsWith('ERROR')) return 'error';
  if (s === 'PAUSED' || s.startsWith('PAUSED') || s === 'COOLDOWN' || s.startsWith('COOLDOWN')) return 'paused';
  if (s === 'PENDING') return 'pending';
  return 'active';
}

export function matchesSidebarFilter(item, statusFilter) {
  if (!statusFilter || statusFilter === 'all') return true;
  const raw = getItemRawStatus(item);
  if (statusFilter === 'downloading') return raw === 'ON_PROGRESS';
  if (statusFilter === 'queued') return isQueuedStatus(raw);
  if (statusFilter === 'completed') return raw === 'DONE' || raw === 'SKIPPED';
  if (statusFilter === 'stopped') return raw === 'STOPPED';
  if (statusFilter === 'failed') return raw === 'ERROR' || raw === 'COOLDOWN' || raw === 'PAUSED';
  return true;
}

export function getStatusReason(status) {
  const s = String(status || '');
  const idx = s.indexOf(' - ');
  return idx !== -1 ? s.slice(idx + 3) : null;
}

export function isDeletableStatus(status) {
  return Boolean(status);
}

class AppStore {
  batchCount = $state(1);
  rawList = $state('');
  isEditingRaw = $state(false);
  errors = $state('');
  liveProgress = $state(null);
  engineStatus = $state('IDLE');
  autoContinueBatches = $state(true);

  downloadDir = $state('');
  downloadFormat = $state('cbz');
  hasApiKey = $state(false);
  maskedKey = $state('');
  authRequired = $state(false);

  // Filter & Search state (Fase 4 B2)
  statusFilter = $state('all'); // 'all' | 'downloading' | 'queued' | 'completed' | 'stopped' | 'failed'
  batchFilter = $state(null); // null | number
  sourceFilter = $state('all'); // 'all' | provider id
  typeFilter = $state('all'); // 'all' | 'comic' | 'manga' | 'other'
  sources = $state([]); // [{ id, label }] from GET /api/config
  searchQuery = $state('');

  // Backward-compatible aliases
  queueSearch = $derived(this.searchQuery);
  queueFilter = $derived(this.statusFilter);
  collapsedBatches = $state({});
  retryFeedback = $state('');

  // Table Sort state (Fase 4 B3)
  sortColumn = $state('order'); // 'order' | 'title' | 'galleryId' | 'status' | 'progress' | 'pages' | 'speed' | 'eta' | 'batch' | 'format' | 'createdAt'
  sortDirection = $state('asc'); // 'asc' | 'desc'

  // Multi-select & Focus state (Fase 4 B3 & B4)
  selectedIds = $state(new Set());
  focusedId = $state(null);
  anchorId = $state(null);

  // Detail Panel & Responsive Drawer/Sheet state (Fase 4 B4 & B7)
  detailCollapsed = $state(false);
  detailHeight = $state(230);
  detailTab = $state('general'); // 'general' | 'pages' | 'log'
  mobileSidebarOpen = $state(false);
  mobileDetailOpen = $state(false);

  // Toast state (Fase 4 B6)
  toast = $state(null);

  // SSE connection state: 'connected' | 'reconnecting' | 'disconnected' | 'polling'
  sseStatus = $state('disconnected');

  #eventSource = null;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #fallbackPollInterval = null;
  #retryFeedbackTimeout = null;
  #toastTimeout = null;
  #rawListSyncTimer = null;

  items = $derived(Array.from(itemsById.values()));

  // Single-pass real-time counts for Sidebar Filter & Status Bar
  filterCounts = $derived.by(() => {
    let all = 0;
    let downloading = 0;
    let queued = 0; // Queue view: PENDING + ON_PROGRESS
    let pending = 0; // PENDING only (status bar, so Active/Queued do not double count)
    let completed = 0;
    let stopped = 0;
    let failed = 0;
    const batchMap = new Map();
    const sourceCounts = countBySource(this.items);
    const typeCounts = countByType(this.items);

    for (const item of this.items) {
      all++;
      const raw = getItemRawStatus(item);
      if (isQueuedStatus(raw)) queued++;
      if (raw === 'ON_PROGRESS') downloading++;
      else if (raw === 'PENDING') pending++;
      else if (raw === 'DONE' || raw === 'SKIPPED') completed++;
      else if (raw === 'STOPPED') stopped++;
      else if (raw === 'ERROR' || raw === 'COOLDOWN' || raw === 'PAUSED') failed++;

      const b = item.batch || 1;
      let entry = batchMap.get(b);
      if (!entry) {
        entry = { num: b, count: 0, done: 0, active: 0 };
        batchMap.set(b, entry);
      }
      entry.count++;
      if (raw === 'DONE' || raw === 'SKIPPED') entry.done++;
      if (raw === 'ON_PROGRESS') entry.active++;
    }

    const batches = Array.from(batchMap.values()).sort((a, b) => a.num - b.num);

    return {
      all,
      downloading,
      queued,
      pending,
      completed,
      stopped,
      failed,
      batches,
      sources: Array.from(sourceCounts.entries()).map(([id, count]) => ({ id, count })),
      types: TYPE_ORDER.filter((id) => typeCounts.has(id)).map((id) => ({ id, count: typeCounts.get(id) }))
    };
  });

  doneCount = $derived(this.filterCounts.completed);

  // Priority rank (# column): 1..N ordered by priority DESC, id ASC
  rankedItems = $derived.by(() => {
    const copy = this.items.slice();
    copy.sort((a, b) => {
      const pa = Number(a.priority) || 0;
      const pb = Number(b.priority) || 0;
      if (pb !== pa) return pb - pa;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    return copy;
  });

  rankById = $derived.by(() => {
    const map = new Map();
    const ranked = this.rankedItems;
    for (let i = 0; i < ranked.length; i++) {
      map.set(String(ranked[i].galleryId), i + 1);
    }
    return map;
  });

  // Gallery key of the first PENDING item in rank order (the next one the engine will take).
  nextPendingId = $derived.by(() => {
    for (const item of this.rankedItems) {
      if (getItemRawStatus(item) === 'PENDING') return String(item.galleryId);
    }
    return null;
  });

  // Cooldown countdown for the list chip: { kind, remaining, message } | null
  cooldown = $derived(cooldownInfo(this.liveProgress, this.engineStatus));

  // Filtered and sorted array for VirtualQueueTable
  filteredAndSortedItems = $derived.by(() => {
    const sf = this.statusFilter;
    const bf = this.batchFilter;
    const srcf = this.sourceFilter;
    const tf = this.typeFilter;
    const q = this.searchQuery.trim().toLowerCase();
    const col = this.sortColumn;
    const dir = this.sortDirection === 'desc' ? -1 : 1;
    const ranks = this.rankById;
    const defaultFmt = this.downloadFormat || 'cbz';

    const filtered = [];
    for (const item of this.items) {
      if (sf !== 'all' && !matchesSidebarFilter(item, sf)) continue;
      if (bf !== null && (item.batch || 1) !== bf) continue;
      if (!matchesSourceFilter(item, srcf)) continue;
      if (!matchesTypeFilter(item, tf)) continue;
      if (q) {
        const gidStr = String(item.galleryId || '');
        const titleStr = String(item.title || '').toLowerCase();
        const urlStr = String(item.url || '').toLowerCase();
        const statusStr = String(item.status || '').toLowerCase();
        if (
          !gidStr.includes(q) &&
          !titleStr.includes(q) &&
          !urlStr.includes(q) &&
          !statusStr.includes(q)
        ) {
          continue;
        }
      }
      filtered.push(item);
    }

    const activeGid =
      col === 'speed' || col === 'eta' ? String(this.liveProgress?.galleryId ?? '') : '';

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (col) {
        case 'order': {
          const ra = ranks.get(String(a.galleryId)) ?? 999999;
          const rb = ranks.get(String(b.galleryId)) ?? 999999;
          cmp = ra - rb;
          break;
        }
        case 'title': {
          const ta = (a.title || parseItemUrl(a.url).title || `Gallery #${a.galleryId}`).toLowerCase();
          const tb = (b.title || parseItemUrl(b.url).title || `Gallery #${b.galleryId}`).toLowerCase();
          cmp = ta < tb ? -1 : ta > tb ? 1 : 0;
          break;
        }
        case 'galleryId': {
          cmp = String(a.galleryId).localeCompare(String(b.galleryId), undefined, { numeric: true });
          break;
        }
        case 'status': {
          const sa = String(a.rawStatus || a.status || '');
          const sb = String(b.rawStatus || b.status || '');
          cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
          break;
        }
        case 'progress': {
          const pa = a.pagesTotal > 0 ? a.pagesDone / a.pagesTotal : getItemRawStatus(a) === 'DONE' ? 1 : 0;
          const pb = b.pagesTotal > 0 ? b.pagesDone / b.pagesTotal : getItemRawStatus(b) === 'DONE' ? 1 : 0;
          cmp = pa - pb;
          break;
        }
        case 'pages': {
          cmp = (Number(a.pagesTotal) || 0) - (Number(b.pagesTotal) || 0);
          if (cmp === 0) cmp = (Number(a.pagesDone) || 0) - (Number(b.pagesDone) || 0);
          break;
        }
        case 'speed':
        case 'eta': {
          const ia = activeGid && String(a.galleryId) === activeGid ? 1 : 0;
          const ib = activeGid && String(b.galleryId) === activeGid ? 1 : 0;
          cmp = ib - ia;
          break;
        }
        case 'batch': {
          cmp = (Number(a.batch) || 1) - (Number(b.batch) || 1);
          break;
        }
        case 'createdAt': {
          const ta = parseAddedAt(a.createdAt)?.getTime();
          const tb = parseAddedAt(b.createdAt)?.getTime();
          // invalid/unknown dates always sort last, regardless of direction
          if (ta === undefined || tb === undefined) {
            if (ta === tb) {
              cmp = 0;
              break;
            }
            return ta === undefined ? 1 : -1;
          }
          cmp = ta - tb;
          break;
        }
        case 'format': {
          const fa = String(a.format || defaultFmt);
          const fb = String(b.format || defaultFmt);
          cmp = fa < fb ? -1 : fa > fb ? 1 : 0;
          break;
        }
        default:
          cmp = (Number(a.id) || 0) - (Number(b.id) || 0);
      }
      if (cmp === 0) {
        return (Number(a.id) || 0) - (Number(b.id) || 0);
      }
      return cmp * dir;
    });

    return filtered;
  });

  selectedItem = $derived.by(() => {
    if (this.focusedId !== null) {
      const item = itemsById.get(String(this.focusedId));
      if (item) return item;
    }
    if (this.selectedIds.size > 0) {
      const firstId = this.selectedIds.values().next().value;
      const item = itemsById.get(String(firstId));
      if (item) return item;
    }
    return null;
  });

  selectedLibraryEntry = $derived.by(() => {
    const item = this.selectedItem;
    if (!item) return null;
    return libraryById.get(String(item.galleryId)) || null;
  });

  selectionCapabilities = $derived.by(() => {
    const count = this.selectedIds.size;
    if (count === 0) {
      return {
        count: 0,
        hasSelection: false,
        canResume: false,
        canPause: false,
        canDelete: false,
        canPriority: false
      };
    }
    let canResume = false;
    let canPause = false;
    for (const gid of this.selectedIds) {
      const item = itemsById.get(String(gid));
      if (!item) continue;
      const raw = getItemRawStatus(item);
      if (raw === 'STOPPED' || raw === 'ERROR' || raw === 'COOLDOWN' || raw === 'PAUSED') {
        canResume = true;
      }
      if (
        raw === 'PENDING' ||
        raw === 'ON_PROGRESS' ||
        raw === 'ERROR' ||
        raw === 'COOLDOWN' ||
        raw === 'PAUSED'
      ) {
        canPause = true;
      }
    }
    return {
      count,
      hasSelection: true,
      canResume,
      canPause,
      canDelete: true,
      canPriority: true
    };
  });

  hud = $derived.by(() => {
    const lp = this.liveProgress;
    if (lp) {
      const done = lp.completed ?? lp.downloadedPages ?? lp.pageCurrent ?? 0;
      const total = lp.total ?? lp.totalPages ?? lp.pageTotal ?? 0;
      const pct = lp.percent ?? lp.pagePercentage ?? (total > 0 ? Math.round((done / total) * 100) : 0);
      return {
        isActive: true,
        url: lp.title ? `#${lp.galleryId} — ${lp.title}` : `#${lp.galleryId || ''}`,
        statusText: lp.message || lp.status || 'Downloading',
        current: done,
        total,
        percentage: pct,
        activePages: lp.activePages || [],
        activeGalleryId: lp.galleryId ? String(lp.galleryId) : null,
        speedKBps: lp.speedKBps ?? (lp.speedBps ? Math.round(lp.speedBps / 1024) : 0)
      };
    }

    return {
      isActive: false,
      url: 'None',
      statusText: 'System Idle / Waiting for queue...',
      current: 0,
      total: 0,
      percentage: 0,
      activePages: [],
      activeGalleryId: null,
      speedKBps: 0
    };
  });

  showToast(message, type = 'info', duration = 3000) {
    this.toast = { message, type, id: Date.now() };
    if (this.#toastTimeout) clearTimeout(this.#toastTimeout);
    if (duration > 0) {
      this.#toastTimeout = setTimeout(() => {
        this.toast = null;
      }, duration);
    }
  }

  setStatusFilter(filter) {
    this.statusFilter = filter;
    this.mobileSidebarOpen = false;
  }

  setTypeFilter(id) {
    this.typeFilter = this.typeFilter === id ? 'all' : id;
  }

  setSourceFilter(id) {
    this.sourceFilter = this.sourceFilter === id ? 'all' : id;
    this.mobileSidebarOpen = false;
  }

  setBatchFilter(batchNum) {
    this.batchFilter = this.batchFilter === batchNum ? null : batchNum;
    this.mobileSidebarOpen = false;
  }

  toggleSort(column) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
  }

  selectRow(galleryId, event = {}) {
    if (galleryId === null || galleryId === undefined || galleryId === '') return;
    const gid = String(galleryId);

    const isCtrl = !!(event.ctrlKey || event.metaKey);
    const isShift = !!event.shiftKey;

    if (isShift && this.anchorId !== null) {
      const list = this.filteredAndSortedItems;
      const idxA = list.findIndex(i => String(i.galleryId) === String(this.anchorId));
      const idxB = list.findIndex(i => String(i.galleryId) === gid);
      if (idxA !== -1 && idxB !== -1) {
        const start = Math.min(idxA, idxB);
        const end = Math.max(idxA, idxB);
        const nextSet = isCtrl ? new Set(this.selectedIds) : new Set();
        for (let i = start; i <= end; i++) {
          nextSet.add(String(list[i].galleryId));
        }
        this.selectedIds = nextSet;
        this.focusedId = gid;
        return;
      }
    }

    if (isCtrl) {
      const nextSet = new Set(this.selectedIds);
      if (nextSet.has(gid)) {
        nextSet.delete(gid);
      } else {
        nextSet.add(gid);
      }
      this.selectedIds = nextSet;
      this.focusedId = gid;
      this.anchorId = gid;
      return;
    }

    this.selectedIds = new Set([gid]);
    this.focusedId = gid;
    this.anchorId = gid;
  }

  ensureContextSelection(galleryId) {
    if (galleryId === null || galleryId === undefined || galleryId === '') return;
    const gid = String(galleryId);
    if (!this.selectedIds.has(gid)) {
      this.selectedIds = new Set([gid]);
      this.anchorId = gid;
    }
    this.focusedId = gid;
  }

  selectAllVisible() {
    const nextSet = new Set();
    for (const item of this.filteredAndSortedItems) {
      nextSet.add(String(item.galleryId));
    }
    this.selectedIds = nextSet;
    if (this.focusedId === null && this.filteredAndSortedItems.length > 0) {
      this.focusedId = String(this.filteredAndSortedItems[0].galleryId);
    }
  }

  clearSelection() {
    this.selectedIds = new Set();
  }

  moveFocus(delta, shiftKey = false) {
    const list = this.filteredAndSortedItems;
    if (list.length === 0) return -1;

    let currentIndex = this.focusedId !== null
      ? list.findIndex(i => String(i.galleryId) === String(this.focusedId))
      : -1;

    let nextIndex = currentIndex === -1 ? 0 : Math.max(0, Math.min(list.length - 1, currentIndex + delta));
    const nextGid = String(list[nextIndex].galleryId);

    if (shiftKey) {
      if (this.anchorId === null) {
        this.anchorId = currentIndex !== -1 ? String(list[currentIndex].galleryId) : nextGid;
      }
      const anchorIdx = list.findIndex(i => String(i.galleryId) === String(this.anchorId));
      const start = Math.min(anchorIdx !== -1 ? anchorIdx : nextIndex, nextIndex);
      const end = Math.max(anchorIdx !== -1 ? anchorIdx : nextIndex, nextIndex);
      const nextSet = new Set();
      for (let i = start; i <= end; i++) {
        nextSet.add(String(list[i].galleryId));
      }
      this.selectedIds = nextSet;
    } else {
      this.selectedIds = new Set([nextGid]);
      this.anchorId = nextGid;
    }

    this.focusedId = nextGid;
    return nextIndex;
  }

  async pauseSelected(ids = Array.from(this.selectedIds)) {
    if (!ids || ids.length === 0) return;
    try {
      const res = await api.pauseQueueItems(ids);
      if (res.success) {
        this.showToast(`Paused ${res.paused} item(s)`, 'info');
      }
    } catch {
      this.showToast('Failed to pause items', 'error');
    }
  }

  async resumeSelected(ids = Array.from(this.selectedIds)) {
    if (!ids || ids.length === 0) return;
    try {
      const res = await api.resumeQueueItems(ids);
      if (res.success) {
        this.showToast(`Resumed ${res.resumed} item(s)`, 'success');
      }
    } catch {
      this.showToast('Failed to resume items', 'error');
    }
  }

  async togglePauseResumeSelected() {
    const ids = Array.from(this.selectedIds);
    if (ids.length === 0) return;
    const hasActiveOrPending = ids.some(id => {
      const item = itemsById.get(String(id));
      if (!item) return false;
      const raw = getItemRawStatus(item);
      return raw === 'PENDING' || raw === 'ON_PROGRESS';
    });
    if (hasActiveOrPending) {
      await this.pauseSelected(ids);
    } else {
      await this.resumeSelected(ids);
    }
  }

  async deleteSelected(ids = Array.from(this.selectedIds)) {
    if (!ids || ids.length === 0) return;
    try {
      const res = await api.deleteQueueItems(ids);
      if (res.success) {
        const nextSet = new Set(this.selectedIds);
        for (const id of ids) nextSet.delete(String(id));
        this.selectedIds = nextSet;
        if (this.focusedId !== null && ids.map(String).includes(String(this.focusedId))) {
          this.focusedId = nextSet.size > 0 ? nextSet.values().next().value : null;
        }
        this.showToast(`Deleted ${res.deleted} item(s) from queue`, 'info');
      }
    } catch {
      this.showToast('Failed to delete items', 'error');
    }
  }

  async changePriority(action, ids = Array.from(this.selectedIds)) {
    if (!ids || ids.length === 0) return;
    try {
      const res = await api.setQueuePriority(ids, action);
      if (res.success) {
        this.showToast(`Priority (${action.toUpperCase()}) updated for ${res.updated} item(s)`, 'info');
      }
    } catch {
      this.showToast('Failed to update priority', 'error');
    }
  }

  async refreshLibraryIndex() {
    try {
      const data = await api.fetchLibrary();
      libraryById.clear();
      for (const entry of data.items || []) {
        libraryById.set(String(entry.id), entry);
      }
    } catch {}
  }

  applySnapshot(data) {
    if (!data) return;
    if (Array.isArray(data.items)) {
      itemsById.clear();
      for (const item of data.items) {
        const key = String(item.galleryId || extractGalleryId(item.url) || item.id);
        itemsById.set(key, item);
      }
    }
    if (typeof data.batchCount === 'number') this.batchCount = data.batchCount;
    if (typeof data.engineStatus === 'string') this.engineStatus = data.engineStatus;
    if ('liveProgress' in data) this.liveProgress = data.liveProgress;
    if (typeof data.autoContinueBatches === 'boolean') {
      this.autoContinueBatches = data.autoContinueBatches;
    }
    if (typeof data.errors === 'string') this.errors = data.errors;
    if (!this.isEditingRaw) {
      this.rawList =
        typeof data.rawList === 'string' ? data.rawList : buildRawListFromMap(itemsById);
    }
  }

  applyItemEvent(evt) {
    if (!evt) return;
    if (typeof evt.batchCount === 'number') {
      this.batchCount = evt.batchCount;
    }

    const action = evt.type;
    if ((action === 'inserted' || action === 'updated') && evt.item) {
      const key = String(evt.item.galleryId || extractGalleryId(evt.item.url) || evt.item.id);
      itemsById.set(key, evt.item);
    } else if (action === 'deleted' && evt.galleryId !== undefined) {
      itemsById.delete(String(evt.galleryId));
      if (this.selectedIds.has(String(evt.galleryId))) {
        const nextSet = new Set(this.selectedIds);
        nextSet.delete(String(evt.galleryId));
        this.selectedIds = nextSet;
      }
    } else if (action === 'batch_deleted' && evt.batch !== undefined) {
      for (const [k, v] of itemsById.entries()) {
        if ((v.batch || 1) === evt.batch) {
          itemsById.delete(k);
        }
      }
    } else if (
      (action === 'batch_deleted' || action === 'cleared') &&
      Array.isArray(evt.removedIds)
    ) {
      for (const id of evt.removedIds) {
        itemsById.delete(String(id));
      }
    } else if (action === 'reordered' && Array.isArray(evt.items)) {
      for (const entry of evt.items) {
        const key = String(entry.galleryId);
        const existing = itemsById.get(key);
        if (existing) {
          itemsById.set(key, { ...existing, priority: Number(entry.priority) });
        }
      }
    }

    if (!this.isEditingRaw) {
      this.#scheduleRawListSync();
    }
  }

  #scheduleRawListSync() {
    if (this.#rawListSyncTimer) return;
    this.#rawListSyncTimer = setTimeout(() => {
      this.#rawListSyncTimer = null;
      if (!this.isEditingRaw) {
        this.rawList = buildRawListFromMap(itemsById);
      }
    }, 80);
  }

  applyProgressEvent(evt) {
    if (!evt) return;
    if ('liveProgress' in evt) this.liveProgress = evt.liveProgress;
    if (typeof evt.engineStatus === 'string') this.engineStatus = evt.engineStatus;
  }

  applyEngineEvent(evt) {
    if (!evt) return;
    if (typeof evt.engineStatus === 'string') this.engineStatus = evt.engineStatus;
    if ('liveProgress' in evt) this.liveProgress = evt.liveProgress;
    if (typeof evt.autoContinueBatches === 'boolean') {
      this.autoContinueBatches = evt.autoContinueBatches;
    }
  }

  async syncStatusOnce() {
    try {
      const data = await api.fetchStatus();
      this.applySnapshot(data);
    } catch {}
  }

  startFallbackPolling() {
    if (this.#fallbackPollInterval) return;
    this.sseStatus = 'polling';
    this.syncStatusOnce();
    this.#fallbackPollInterval = setInterval(() => {
      this.syncStatusOnce();
    }, 3000);
  }

  stopFallbackPolling() {
    if (this.#fallbackPollInterval) {
      clearInterval(this.#fallbackPollInterval);
      this.#fallbackPollInterval = null;
    }
  }

  connectSSE() {
    this.disconnectSSE();

    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      this.startFallbackPolling();
      return;
    }

    try {
      const es = new EventSource('/api/events');
      this.#eventSource = es;

      es.onopen = () => {
        this.#reconnectAttempt = 0;
        this.stopFallbackPolling();
        this.sseStatus = 'connected';
        this.syncStatusOnce();
        this.refreshLibraryIndex();
      };

      es.addEventListener('snapshot', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applySnapshot(payload);
        } catch {}
      });

      es.addEventListener('reloaded', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applySnapshot(payload);
          this.refreshLibraryIndex();
        } catch {}
      });

      es.addEventListener('item', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applyItemEvent(payload);
          if (payload.item && payload.item.rawStatus === 'DONE') {
            this.refreshLibraryIndex();
          }
        } catch {}
      });

      es.addEventListener('progress', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applyProgressEvent(payload);
        } catch {}
      });

      es.addEventListener('engine', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applyEngineEvent(payload);
        } catch {}
      });

      es.onerror = () => {
        if (this.#eventSource) {
          this.#eventSource.close();
          this.#eventSource = null;
        }
        this.#scheduleReconnect();
      };
    } catch {
      this.startFallbackPolling();
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    const backoffSchedule = [1000, 2000, 5000, 10000];
    const delay =
      backoffSchedule[Math.min(this.#reconnectAttempt, backoffSchedule.length - 1)];
    this.#reconnectAttempt++;

    if (this.#reconnectAttempt >= 3 && !this.#fallbackPollInterval) {
      this.startFallbackPolling();
    } else {
      this.sseStatus = 'reconnecting';
    }

    this.#reconnectTimer = setTimeout(() => {
      this.connectSSE();
    }, delay);
  }

  disconnectSSE() {
    if (this.#rawListSyncTimer) {
      clearTimeout(this.#rawListSyncTimer);
      this.#rawListSyncTimer = null;
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#eventSource) {
      this.#eventSource.close();
      this.#eventSource = null;
    }
    this.stopFallbackPolling();
    this.sseStatus = 'disconnected';
  }

  async loadConfig() {
    try {
      const data = await api.fetchConfig();
      this.downloadDir = data.downloadDir || '';
      this.downloadFormat = data.downloadFormat || 'cbz';
      this.hasApiKey = !!data.hasApiKey;
      this.maskedKey = data.maskedKey || '';
      this.authRequired = !!data.authRequired;
      this.sources = Array.isArray(data.sources) ? data.sources : [];
      if (typeof data.autoContinueBatches === 'boolean') {
        this.autoContinueBatches = data.autoContinueBatches;
      }
    } catch {}
  }

  toggleBatchCollapse(num, currentVal) {
    this.collapsedBatches = { ...this.collapsedBatches, [num]: !currentVal };
  }

  setRetryFeedback(msg, ms = 3000) {
    this.retryFeedback = msg;
    if (this.#retryFeedbackTimeout) clearTimeout(this.#retryFeedbackTimeout);
    if (msg && ms > 0) {
      this.#retryFeedbackTimeout = setTimeout(() => {
        this.retryFeedback = '';
      }, ms);
    }
  }

  async triggerForceRetry(galleryId = null) {
    try {
      this.setRetryFeedback(galleryId ? `Retrying #${galleryId}...` : 'Signaling retry...', 0);
      const data = await api.triggerRetry(galleryId);
      if (data.success) {
        this.showToast(galleryId ? `Queued #${galleryId} for retry` : 'Force retry triggered', 'info');
        this.setRetryFeedback(galleryId ? `Queued #${galleryId} for retry` : 'Force retry triggered');
      }
    } catch {
      this.setRetryFeedback('Retry failed');
    }
  }
}

export const appStore = new AppStore();
