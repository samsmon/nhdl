import { SvelteMap } from 'svelte/reactivity';
import * as api from '../api.js';

// Reactive item map keyed by galleryId string so SSE `item` updates mutate
// only the affected entry without replacing the entire collection.
const itemsById = new SvelteMap();

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
    const rawUrl = String(row.url || '').split(' | ')[0].trim() || `https://nhentai.net/g/${row.galleryId}/`;
    const lineBody = row.title ? `${rawUrl} | ${row.title}` : rawUrl;
    lines.push(`[${row.status}] ${lineBody}`);
  }
  return lines.join('\n');
}

export function extractGalleryId(str) {
  if (!str) return null;
  const s = String(str).trim();
  const urlMatch = s.match(/\/g\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  const bareMatch = s.match(/^(\d+)$/);
  if (bareMatch) return bareMatch[1];
  return null;
}

export function parseItemUrl(urlStr) {
  const parts = String(urlStr || '').split(' | ');
  const rawUrl = parts[0].trim();
  const title = parts.length > 1 ? parts.slice(1).join(' | ').trim() : null;
  const idMatch = rawUrl.match(/\/g\/(\d+)/);
  const id = idMatch ? idMatch[1] : rawUrl;
  return { rawUrl, id, title };
}

export function getStatusCategory(status) {
  const s = String(status || '');
  if (s === 'DONE') return 'done';
  if (s.startsWith('SKIPPED')) return 'skipped';
  if (s.startsWith('ERROR')) return 'error';
  if (s.startsWith('PAUSED') || s.startsWith('COOLDOWN')) return 'paused';
  if (s === 'PENDING') return 'pending';
  return 'active';
}

export function getStatusReason(status) {
  const s = String(status || '');
  const idx = s.indexOf(' - ');
  return idx !== -1 ? s.slice(idx + 3) : null;
}

export function isDeletableStatus(status) {
  const s = String(status || '');
  return (
    s === 'PENDING' ||
    s === 'DONE' ||
    s.startsWith('SKIPPED') ||
    s.startsWith('ERROR') ||
    s.startsWith('PAUSED') ||
    s.startsWith('COOLDOWN')
  );
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
  downloadFormat = $state('folder');
  hasApiKey = $state(false);
  maskedKey = $state('');
  authRequired = $state(false);

  queueSearch = $state('');
  queueFilter = $state('all'); // 'all' | 'done' | 'active' | 'pending' | 'failed'
  collapsedBatches = $state({});
  retryFeedback = $state('');

  // SSE connection state: 'connected' | 'reconnecting' | 'disconnected' | 'polling'
  sseStatus = $state('disconnected');

  #eventSource = null;
  #reconnectTimer = null;
  #reconnectAttempt = 0;
  #fallbackPollInterval = null;
  #retryFeedbackTimeout = null;

  items = $derived(Array.from(itemsById.values()));

  doneCount = $derived(
    this.items.filter(i => i.status === 'DONE' || String(i.status).startsWith('SKIPPED')).length
  );

  hud = $derived.by(() => {
    const activeItem = this.items.find(
      i =>
        i.status !== 'PENDING' &&
        i.status !== 'DONE' &&
        !String(i.status).startsWith('ERROR') &&
        !String(i.status).startsWith('SKIPPED') &&
        !String(i.status).startsWith('PAUSED')
    );

    if (this.liveProgress) {
      return {
        isActive: true,
        url: this.liveProgress.galleryTitle
          ? `nhentai.net/g/${this.liveProgress.galleryId} — ${this.liveProgress.galleryTitle}`
          : activeItem
            ? activeItem.url
            : `nhentai.net/g/${this.liveProgress.galleryId}`,
        statusText: this.liveProgress.status,
        current: this.liveProgress.pageCurrent,
        total: this.liveProgress.pageTotal,
        percentage:
          this.liveProgress.pageTotal > 0
            ? Math.round((this.liveProgress.pageCurrent / this.liveProgress.pageTotal) * 100)
            : 0,
        activePages: this.liveProgress.activePages || [],
        activeGalleryId: this.liveProgress.galleryId || null
      };
    }

    if (!activeItem) {
      return {
        isActive: false,
        url: 'None',
        statusText: 'System Idle / Waiting for queue...',
        current: 0,
        total: 0,
        percentage: 0,
        activePages: [],
        activeGalleryId: null
      };
    }

    const match = String(activeItem.status).match(/(\d+)\/(\d+)/);
    let current = 0;
    let total = 0;
    let percentage = 0;
    if (match) {
      current = parseInt(match[1], 10);
      total = parseInt(match[2], 10);
      percentage = total > 0 ? Math.round((current / total) * 100) : 0;
    }

    return {
      isActive: true,
      url: activeItem.url,
      statusText: activeItem.status,
      current,
      total,
      percentage,
      activePages: [],
      activeGalleryId: null
    };
  });

  activeBatchNum = $derived.by(() => {
    const firstActive = this.items.find(
      i => i.status !== 'DONE' && !String(i.status).startsWith('SKIPPED')
    );
    return firstActive ? firstActive.batch || 1 : null;
  });

  batches = $derived.by(() => {
    const map = new Map();
    for (const item of this.items) {
      const b = item.batch || 1;
      if (!map.has(b)) map.set(b, []);
      map.get(b).push(item);
    }
    const nums = Array.from(map.keys()).sort((a, b) => a - b);
    const q = this.queueSearch.trim().toLowerCase();
    const filter = this.queueFilter;

    return nums.map(num => {
      const list = map.get(num);
      const done = list.filter(
        i => i.status === 'DONE' || String(i.status).startsWith('SKIPPED')
      ).length;
      const total = list.length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const isActive = num === this.activeBatchNum;
      const collapsed =
        num in this.collapsedBatches
          ? this.collapsedBatches[num]
          : pct === 100 && !isActive && nums.length > 1;

      // Filter items once per batch inside $derived
      const filteredItems = list.filter(item => {
        if (filter !== 'all') {
          const cat = getStatusCategory(item.status);
          if (filter === 'done' && cat !== 'done' && cat !== 'skipped') return false;
          if (filter === 'active' && cat !== 'active') return false;
          if (filter === 'pending' && cat !== 'pending') return false;
          if (filter === 'failed' && cat !== 'error' && cat !== 'paused') return false;
        }
        if (q) {
          const hay = `${item.url} ${item.status} ${item.title || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      return {
        num,
        items: list,
        filteredItems,
        done,
        total,
        pct,
        isActive,
        collapsed
      };
    });
  });

  visibleBatches = $derived.by(() => {
    const hasFilter = this.queueFilter !== 'all' || this.queueSearch.trim() !== '';
    if (!hasFilter) return this.batches;
    return this.batches.filter(b => b.filteredItems.length > 0);
  });

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
    } else if ((action === 'batch_deleted' || action === 'cleared') && Array.isArray(evt.removedIds)) {
      for (const id of evt.removedIds) {
        itemsById.delete(String(id));
      }
    }

    if (!this.isEditingRaw) {
      this.rawList = buildRawListFromMap(itemsById);
    }
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
    } catch (e) {
      // Ignore transient network errors
    }
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
        // Also fetch initial errors/rawList once on connect
        this.syncStatusOnce();
      };

      es.addEventListener('snapshot', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applySnapshot(payload);
        } catch {}
      });

      es.addEventListener('item', e => {
        try {
          const payload = JSON.parse(e.data);
          this.applyItemEvent(payload);
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
      this.downloadFormat = data.downloadFormat || 'folder';
      this.hasApiKey = !!data.hasApiKey;
      this.maskedKey = data.maskedKey || '';
      this.authRequired = !!data.authRequired;
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
        if (galleryId) {
          this.setRetryFeedback(`Queued #${galleryId} for retry`);
        } else if (data.started) {
          this.setRetryFeedback(
            data.resetCount > 0 ? `Reset ${data.resetCount} & started` : 'Started engine'
          );
        } else {
          this.setRetryFeedback(
            data.resetCount > 0 ? `Reset ${data.resetCount} + retrying` : 'Skipping cooldown'
          );
        }
      }
    } catch {
      this.setRetryFeedback('Retry failed');
    }
  }
}

export const appStore = new AppStore();
