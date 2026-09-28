<script>
  import gsap from 'gsap';
  import {
    ChevronDown,
    ChevronUp,
    Info,
    FileSpreadsheet,
    ScrollText,
    ExternalLink,
    RefreshCw,
    FolderCheck,
    X
  } from 'lucide-svelte';
  import { appStore, getItemRawStatus, parseItemUrl } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  const HEIGHT_STORAGE_KEY = 'nhdl_detail_height_v1';

  function loadDetailHeight() {
    try {
      const v = parseInt(localStorage.getItem(HEIGHT_STORAGE_KEY) || '', 10);
      if (Number.isFinite(v) && v >= 120 && v <= 520) return v;
    } catch {}
    return 220;
  }

  function saveDetailHeight(h) {
    try {
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(h));
    } catch {}
  }

  let panelHeight = $state(loadDetailHeight());
  let bodyEl = $state(null);
  let galleryLogs = $state([]);
  let logsLoading = $state(false);

  const item = $derived(appStore.selectedItem);
  const libEntry = $derived(appStore.selectedLibraryEntry);
  const lp = $derived(appStore.liveProgress);
  const isItemLive = $derived(
    Boolean(item && lp && Number(lp.galleryId) === Number(item.galleryId))
  );

  // Fetch per-gallery logs when selected item or its updatedAt changes
  $effect(() => {
    const gid = item?.galleryId;
    const updated = item?.updatedAt;
    const status = item?.status;
    if (!gid) {
      galleryLogs = [];
      return;
    }
    loadGalleryLogs(gid);
  });

  async function loadGalleryLogs(gid = item?.galleryId) {
    if (!gid) return;
    logsLoading = true;
    try {
      const rows = await api.fetchGalleryLogs(gid, 200);
      if (Number(item?.galleryId) === Number(gid)) {
        galleryLogs = rows;
      }
    } catch {
      if (Number(item?.galleryId) === Number(gid)) {
        galleryLogs = [];
      }
    } finally {
      logsLoading = false;
    }
  }

  function toggleCollapse() {
    const next = !appStore.detailCollapsed;
    if (bodyEl) {
      if (next) {
        gsap.to(bodyEl, {
          height: 0,
          opacity: 0,
          duration: 0.18,
          ease: 'power2.inOut',
          onComplete: () => {
            appStore.detailCollapsed = true;
          }
        });
      } else {
        appStore.detailCollapsed = false;
        gsap.fromTo(
          bodyEl,
          { height: 0, opacity: 0 },
          { height: panelHeight, opacity: 1, duration: 0.2, ease: 'power2.out' }
        );
      }
    } else {
      appStore.detailCollapsed = next;
    }
  }

  function startHeightResize(e) {
    if (appStore.detailCollapsed) return;
    e.preventDefault();
    const startY = e.clientY;
    const initialH = panelHeight;

    function onMove(moveEvt) {
      const delta = startY - moveEvt.clientY;
      const nextH = Math.max(120, Math.min(500, Math.round(initialH + delta)));
      panelHeight = nextH;
    }

    function onUp() {
      saveDetailHeight(panelHeight);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function displayTitle(it) {
    if (!it) return '—';
    return it.title || parseItemUrl(it.url).title || `Gallery #${it.galleryId}`;
  }
</script>

<!-- Mobile Bottom Sheet Backdrop (< 768px) -->
{#if appStore.mobileDetailOpen && item}
  <div
    class="fixed inset-0 bg-black/70 z-40 md:hidden"
    onclick={() => (appStore.mobileDetailOpen = false)}
    role="presentation"
  ></div>
{/if}

<section
  class="bg-[var(--bg-surface)] border-t border-[var(--border-strong)] flex flex-col shrink-0 select-none z-40
    fixed inset-x-0 bottom-0 md:static transition-transform duration-200 ease-out
    {appStore.mobileDetailOpen ? 'translate-y-0' : 'translate-y-full md:translate-y-0'}"
  aria-label="Gallery Detail Panel"
>
  <!-- Top Resize Handle (Desktop) -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    onmousedown={startHeightResize}
    class="hidden md:block h-1 w-full cursor-row-resize hover:bg-[var(--accent)]/60 transition-colors"
    role="separator"
    aria-orientation="horizontal"
  ></div>

  <!-- Tab Bar Header -->
  <div class="h-8 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] px-3 flex items-center justify-between gap-2 shrink-0">
    <div class="flex items-center gap-1">
      <button
        type="button"
        onclick={() => {
          appStore.detailTab = 'general';
          if (appStore.detailCollapsed) toggleCollapse();
        }}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono cursor-pointer transition-colors {appStore.detailTab === 'general' && !appStore.detailCollapsed
          ? 'bg-[var(--bg-surface)] text-[var(--accent)] font-semibold border border-[var(--border-strong)]'
          : 'text-[var(--text-secondary)] hover:text-white'}"
      >
        <Info class="w-3.5 h-3.5" />
        <span>General</span>
      </button>

      <button
        type="button"
        onclick={() => {
          appStore.detailTab = 'pages';
          if (appStore.detailCollapsed) toggleCollapse();
        }}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono cursor-pointer transition-colors {appStore.detailTab === 'pages' && !appStore.detailCollapsed
          ? 'bg-[var(--bg-surface)] text-[var(--accent)] font-semibold border border-[var(--border-strong)]'
          : 'text-[var(--text-secondary)] hover:text-white'}"
      >
        <FileSpreadsheet class="w-3.5 h-3.5" />
        <span>Pages</span>
        {#if isItemLive && lp?.activePages?.length}
          <span class="px-1 py-0.2 rounded text-[10px] bg-[#38bdf8]/20 text-[#38bdf8]">
            {lp.activePages.length}
          </span>
        {/if}
      </button>

      <button
        type="button"
        onclick={() => {
          appStore.detailTab = 'log';
          if (appStore.detailCollapsed) toggleCollapse();
        }}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono cursor-pointer transition-colors {appStore.detailTab === 'log' && !appStore.detailCollapsed
          ? 'bg-[var(--bg-surface)] text-[var(--accent)] font-semibold border border-[var(--border-strong)]'
          : 'text-[var(--text-secondary)] hover:text-white'}"
      >
        <ScrollText class="w-3.5 h-3.5" />
        <span>Log ({galleryLogs.length})</span>
      </button>
    </div>

    <div class="flex items-center gap-2">
      {#if item}
        <span class="text-[11px] font-mono text-[var(--text-secondary)] truncate max-w-[240px] hidden sm:inline">
          #{item.galleryId} — {displayTitle(item)}
        </span>
      {/if}

      <!-- Desktop Collapse / Expand button -->
      <button
        type="button"
        onclick={toggleCollapse}
        class="hidden md:flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] cursor-pointer"
        title={appStore.detailCollapsed ? 'Expand Detail Panel' : 'Collapse Detail Panel'}
      >
        {#if appStore.detailCollapsed}
          <ChevronUp class="w-3.5 h-3.5" />
        {:else}
          <ChevronDown class="w-3.5 h-3.5" />
        {/if}
      </button>

      <!-- Mobile Close Sheet button -->
      <button
        type="button"
        onclick={() => (appStore.mobileDetailOpen = false)}
        class="md:hidden p-1 text-[var(--text-secondary)] hover:text-white cursor-pointer"
        aria-label="Close Detail Sheet"
      >
        <X class="w-4 h-4" />
      </button>
    </div>
  </div>

  <!-- Tab Content Body -->
  {#if !appStore.detailCollapsed}
    <div
      bind:this={bodyEl}
      style="height: {panelHeight}px;"
      class="overflow-y-auto custom-scrollbar p-3 text-xs font-mono"
    >
      {#if !item}
        <div class="h-full flex items-center justify-center text-[var(--text-muted)]">
          Select an item in the queue table to inspect its details, page progress, or gallery logs.
        </div>
      {:else if appStore.detailTab === 'general'}
        {@const raw = getItemRawStatus(item)}
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
          <div class="col-span-1 md:col-span-2 lg:col-span-3 flex items-baseline gap-2 border-b border-[var(--border-subtle)] pb-1.5">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Judul:</span>
            <span class="text-white font-sans font-medium select-all break-all">{displayTitle(item)}</span>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Gallery ID:</span>
            <span class="text-white select-all">{item.galleryId}</span>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Link:</span>
            <a
              href="https://nhentai.net/g/{item.galleryId}/"
              target="_blank"
              rel="noopener noreferrer"
              class="text-[var(--accent)] hover:underline flex items-center gap-1 truncate"
            >
              <span>https://certain.site/g/{item.galleryId}/</span>
              <ExternalLink class="w-3 h-3 shrink-0" />
            </a>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Status:</span>
            <span class="text-white font-semibold">{raw}</span>
            {#if item.error}
              <span class="text-[#f87171] truncate" title={item.error}>({item.error})</span>
            {/if}
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Batch / Format:</span>
            <span class="text-white">
              Batch #{item.batch || 1} · {(item.format || appStore.downloadFormat || 'cbz').toUpperCase()}
            </span>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Retries:</span>
            <span class="text-white">{item.retries || 0}</span>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Created / Updated:</span>
            <span class="text-[var(--text-secondary)] truncate">
              {item.createdAt || '—'} / {item.updatedAt || '—'}
            </span>
          </div>

          <div class="col-span-1 md:col-span-2 lg:col-span-3 flex items-center gap-2 pt-1 border-t border-[var(--border-subtle)]">
            <span class="text-[var(--text-muted)] w-24 shrink-0 uppercase text-[10px]">Library Path:</span>
            {#if libEntry && (libEntry.path || libEntry.folder)}
              <div class="flex items-center gap-1.5 text-[#a3e635] select-all break-all">
                <FolderCheck class="w-3.5 h-3.5 shrink-0" />
                <span>{libEntry.path || libEntry.folder}</span>
              </div>
            {:else}
              <span class="text-[var(--text-muted)]">
                {raw === 'DONE' || raw === 'SKIPPED' ? 'In download directory' : 'Not yet in library'}
              </span>
            {/if}
          </div>
        </div>
      {:else if appStore.detailTab === 'pages'}
        {@const done = isItemLive ? (lp?.completed ?? item.pagesDone ?? 0) : (item.pagesDone ?? 0)}
        {@const total = isItemLive ? (lp?.total ?? item.pagesTotal ?? 0) : (item.pagesTotal ?? 0)}
        {@const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0}

        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between bg-[var(--bg-elevated)] border border-[var(--border-subtle)] px-3 py-2 rounded">
            <div class="flex items-center gap-3">
              <span class="text-white font-semibold">
                Pages: {done} / {total || '—'} ({pct}%)
              </span>
              {#if isItemLive}
                <span class="px-1.5 py-0.5 rounded text-[10px] bg-[#38bdf8]/20 text-[#38bdf8]">
                  Active Download ({lp.speedKBps || 0} KB/s)
                </span>
              {/if}
            </div>
            {#if !isItemLive && lp?.galleryId}
              <button
                type="button"
                onclick={() => appStore.selectRow(Number(lp.galleryId))}
                class="text-[11px] text-[#38bdf8] hover:underline cursor-pointer"
              >
                Jump to active #{lp.galleryId}
              </button>
            {/if}
          </div>

          {#if isItemLive && Array.isArray(lp?.activePages) && lp.activePages.length > 0}
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {#each lp.activePages as p (p.page)}
                <div class="bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded p-2.5 flex flex-col gap-1.5">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-white">Page #{p.page}</span>
                    <span class="text-[10px] text-[var(--text-secondary)]">
                      Attempt #{p.attempt || 1} · {p.percent || 0}%
                    </span>
                  </div>
                  <div class="w-full h-1.5 bg-[#111] rounded overflow-hidden">
                    <div
                      style="width: {p.percent || 0}%;"
                      class="h-full bg-[#38bdf8]"
                    ></div>
                  </div>
                  <div class="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                    <span>{Math.round((p.bytesReceived || 0) / 1024)} / {Math.round((p.totalBytes || 0) / 1024)} KB</span>
                    {#if p.lastError}
                      <span class="text-[#f87171] truncate max-w-[140px]" title={p.lastError}>
                        {p.lastError}
                      </span>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-[var(--text-secondary)] bg-[var(--bg-elevated)]/60 border border-[var(--border-subtle)] rounded p-3">
              {#if getItemRawStatus(item) === 'DONE' || getItemRawStatus(item) === 'SKIPPED'}
                All {total || done} pages have been verified and saved.
              {:else if getItemRawStatus(item) === 'STOPPED'}
                Gallery is paused at {done} / {total || '—'} pages. Click Resume to continue from page {done + 1}.
              {:else}
                Waiting in queue ({done} / {total || '—'} pages completed).
              {/if}
            </div>
          {/if}
        </div>
      {:else if appStore.detailTab === 'log'}
        <div class="flex flex-col gap-2 h-full">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-[var(--text-secondary)]">
              Events for Gallery <strong class="text-white">#{item.galleryId}</strong>
            </span>
            <button
              type="button"
              onclick={() => loadGalleryLogs(item.galleryId)}
              class="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-white cursor-pointer"
            >
              <RefreshCw class="w-3 h-3 {logsLoading ? 'animate-spin' : ''}" />
              <span>Refresh</span>
            </button>
          </div>

          {#if galleryLogs.length === 0}
            <div class="flex-1 flex items-center justify-center text-[var(--text-muted)] py-6">
              {logsLoading ? 'Loading gallery logs...' : `No events recorded yet for gallery #${item.galleryId}.`}
            </div>
          {:else}
            <div class="space-y-1">
              {#each galleryLogs as entry, i (i)}
                <div class="flex items-start gap-2 py-0.5 border-b border-[var(--border-subtle)]/40 leading-relaxed">
                  <span class="text-[var(--text-muted)] shrink-0">{entry.ts}</span>
                  <span
                    class="px-1 rounded text-[10px] uppercase shrink-0 {entry.level === 'error'
                      ? 'bg-[#f87171]/20 text-[#f87171]'
                      : entry.level === 'warn'
                        ? 'bg-[#fbbf24]/20 text-[#fbbf24]'
                        : 'bg-[#38bdf8]/15 text-[#38bdf8]'}"
                  >
                    {entry.level}
                  </span>
                  <span class="text-[var(--text-primary)] break-all">{entry.message}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
