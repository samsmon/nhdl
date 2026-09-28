<script>
  import { Search, X, ArrowUp, ArrowDown } from 'lucide-svelte';
  import { appStore, getItemRawStatus, parseItemUrl } from '../stores/app.svelte.js';
  import ContextMenu from './ContextMenu.svelte';

  let { onRequestDelete } = $props();

  const ROW_HEIGHT = 32;
  const OVERSCAN = 10;
  const STORAGE_KEY = 'nhdl_col_widths_v1';

  const DEFAULT_WIDTHS = {
    order: 54,
    title: 280,
    galleryId: 90,
    status: 112,
    progress: 136,
    pages: 84,
    speed: 86,
    eta: 76,
    batch: 66,
    format: 68
  };

  function loadWidths() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return { ...DEFAULT_WIDTHS, ...parsed };
        }
      }
    } catch {}
    return { ...DEFAULT_WIDTHS };
  }

  function saveWidths(widths) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {}
  }

  let colWidths = $state(loadWidths());
  let viewportEl = $state(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(500);
  let isMobile = $state(typeof window !== 'undefined' ? window.innerWidth < 768 : false);

  let contextMenu = $state({ open: false, x: 0, y: 0 });

  const desktopColumns = [
    { id: 'order', label: '#', minWidth: 44, align: 'text-right' },
    { id: 'title', label: 'Judul', minWidth: 160, align: 'text-left', flex: true },
    { id: 'galleryId', label: 'ID', minWidth: 72, align: 'text-left' },
    { id: 'status', label: 'Status', minWidth: 92, align: 'text-left' },
    { id: 'progress', label: 'Progress', minWidth: 108, align: 'text-left' },
    { id: 'pages', label: 'Halaman', minWidth: 70, align: 'text-right' },
    { id: 'speed', label: 'Speed', minWidth: 72, align: 'text-right' },
    { id: 'eta', label: 'ETA', minWidth: 64, align: 'text-right' },
    { id: 'batch', label: 'Batch', minWidth: 56, align: 'text-right' },
    { id: 'format', label: 'Format', minWidth: 60, align: 'text-center' }
  ];

  const mobileColumns = [
    { id: 'title', label: 'Judul', align: 'text-left', flex: true },
    { id: 'status', label: 'Status', width: '88px', align: 'text-left' },
    { id: 'progress', label: 'Progress', width: '92px', align: 'text-left' }
  ];

  const gridTemplate = $derived.by(() => {
    if (isMobile) {
      return 'minmax(0, 1fr) 88px 92px';
    }
    return desktopColumns
      .map(c => (c.flex ? `minmax(${colWidths[c.id]}px, 1fr)` : `${colWidths[c.id]}px`))
      .join(' ');
  });

  const rows = $derived(appStore.filteredAndSortedItems);
  const totalHeight = $derived(rows.length * ROW_HEIGHT);

  const startIndex = $derived(
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  );
  const endIndex = $derived(
    Math.min(
      rows.length,
      Math.ceil((scrollTop + Math.max(viewportHeight, 320)) / ROW_HEIGHT) + OVERSCAN
    )
  );
  const visibleRows = $derived(rows.slice(startIndex, endIndex));
  const offsetY = $derived(startIndex * ROW_HEIGHT);

  // Keep scrollTop clamped when filtered list shrinks so viewport never sits in blank space
  $effect(() => {
    const maxScroll = Math.max(0, rows.length * ROW_HEIGHT - viewportHeight);
    if (scrollTop > maxScroll && viewportEl) {
      viewportEl.scrollTop = maxScroll;
      scrollTop = maxScroll;
    }
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      isMobile = window.innerWidth < 768;
      if (viewportEl) {
        viewportHeight = viewportEl.clientHeight || 500;
      }
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  function handleScroll(e) {
    scrollTop = e.currentTarget.scrollTop;
  }

  function startColumnResize(e, colId, minWidth) {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const initialWidth = colWidths[colId] || DEFAULT_WIDTHS[colId] || 80;

    function onMove(moveEvt) {
      const delta = moveEvt.clientX - startX;
      const nextWidth = Math.max(minWidth, Math.round(initialWidth + delta));
      colWidths = { ...colWidths, [colId]: nextWidth };
    }

    function onUp() {
      saveWidths(colWidths);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function scrollToIndexIfNeeded(index) {
    if (!viewportEl || index < 0) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewTop = viewportEl.scrollTop;
    const viewBottom = viewTop + viewportEl.clientHeight;

    if (rowTop < viewTop) {
      viewportEl.scrollTop = rowTop;
      scrollTop = rowTop;
    } else if (rowBottom > viewBottom) {
      const nextTop = rowBottom - viewportEl.clientHeight;
      viewportEl.scrollTop = nextTop;
      scrollTop = nextTop;
    }
  }

  function handleKeyDown(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      appStore.selectAllVisible();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = appStore.moveFocus(1, e.shiftKey);
      scrollToIndexIfNeeded(nextIdx);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIdx = appStore.moveFocus(-1, e.shiftKey);
      scrollToIndexIfNeeded(nextIdx);
      return;
    }
    if (e.key === 'Delete') {
      if (appStore.selectionCapabilities.canDelete) {
        e.preventDefault();
        onRequestDelete();
      }
      return;
    }
    if (e.key === ' ') {
      if (appStore.selectionCapabilities.hasSelection) {
        e.preventDefault();
        appStore.togglePauseResumeSelected();
      }
    }
  }

  function handleRowClick(item, e) {
    appStore.selectRow(item.galleryId, e);
    if (isMobile) {
      appStore.mobileDetailOpen = true;
    }
  }

  function handleRowContextMenu(item, e) {
    e.preventDefault();
    appStore.ensureContextSelection(item.galleryId);
    contextMenu = { open: true, x: e.clientX, y: e.clientY };
  }

  function formatRowTitle(item) {
    if (item.title) return item.title;
    const parsed = parseItemUrl(item.url);
    return parsed.title || `Gallery #${item.galleryId}`;
  }

  function getStatusBadgeClass(raw) {
    switch (raw) {
      case 'ON_PROGRESS':
        return 'bg-[#38bdf8]/15 text-[#38bdf8] border-[#38bdf8]/40';
      case 'PENDING':
        return 'bg-[#94a3b8]/10 text-[#94a3b8] border-[#94a3b8]/30';
      case 'DONE':
        return 'bg-[#a3e635]/15 text-[#a3e635] border-[#a3e635]/40';
      case 'SKIPPED':
        return 'bg-[#a3e635]/10 text-[#84cc16] border-[#a3e635]/25';
      case 'STOPPED':
        return 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/40';
      case 'PAUSED':
      case 'COOLDOWN':
        return 'bg-[#fbbf24]/15 text-[#fbbf24] border-[#fbbf24]/40';
      case 'ERROR':
        return 'bg-[#f87171]/15 text-[#f87171] border-[#f87171]/40';
      default:
        return 'bg-[#262626] text-[#a1a1aa] border-[#383838]';
    }
  }

  function getRowProgress(item, lp) {
    const raw = getItemRawStatus(item);
    const isLive = lp && Number(lp.galleryId) === Number(item.galleryId);
    const done = isLive
      ? (lp.completed ?? lp.downloadedPages ?? item.pagesDone ?? 0)
      : (item.pagesDone ?? 0);
    const total = isLive
      ? (lp.total ?? lp.totalPages ?? item.pagesTotal ?? 0)
      : (item.pagesTotal ?? 0);

    let pct = 0;
    if (total > 0) {
      pct = Math.min(100, Math.round((done / total) * 100));
    } else if (raw === 'DONE' || raw === 'SKIPPED') {
      pct = 100;
    }
    return { done, total, pct, isLive };
  }

  function formatSpeed(lp, isLive) {
    if (!isLive || !lp) return '—';
    const kbps = lp.speedKBps ?? (lp.speedBps ? Math.round(lp.speedBps / 1024) : 0);
    if (!kbps || kbps <= 0) return '0 KB/s';
    if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
    return `${kbps} KB/s`;
  }

  function formatEta(lp, isLive, done, total) {
    if (!isLive || !lp) return '—';
    if (typeof lp.etaSeconds === 'number' && lp.etaSeconds >= 0) {
      const s = Math.round(lp.etaSeconds);
      if (s < 60) return `${s}s`;
      return `${Math.floor(s / 60)}m ${s % 60}s`;
    }
    const kbps = lp.speedKBps ?? 0;
    const remPages = Math.max(0, (total || 0) - (done || 0));
    if (kbps <= 0 || remPages === 0) return '—';
    // Estimate ~250KB per page when only page speed is known
    const estSec = Math.max(1, Math.round((remPages * 250) / kbps));
    if (estSec < 60) return `${estSec}s`;
    return `${Math.floor(estSec / 60)}m ${estSec % 60}s`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="flex-1 flex flex-col min-h-0 min-w-0 bg-[var(--bg-base)] select-none focus:outline-none overflow-hidden"
  tabindex="0"
  onkeydown={handleKeyDown}
  aria-label="Queue Virtual Table"
>
  <!-- Search & Filter Bar above Table -->
  <div class="h-9 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] px-2.5 flex items-center justify-between gap-2 shrink-0">
    <div class="relative flex-1 max-w-md flex items-center">
      <Search class="w-3.5 h-3.5 text-[var(--text-muted)] absolute left-2.5 pointer-events-none" />
      <input
        type="text"
        bind:value={appStore.searchQuery}
        placeholder="Filter by title, gallery ID, or status..."
        class="w-full bg-[#0a0a0a] border border-[var(--border-subtle)] focus:border-[var(--accent)] rounded pl-8 pr-7 py-1 text-xs font-mono text-white focus:outline-none"
      />
      {#if appStore.searchQuery}
        <button
          type="button"
          onclick={() => (appStore.searchQuery = '')}
          class="absolute right-2 text-[var(--text-muted)] hover:text-white cursor-pointer"
          aria-label="Clear search"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      {/if}
    </div>

    <div class="flex items-center gap-2 text-[11px] font-mono text-[var(--text-secondary)] shrink-0">
      {#if appStore.selectedIds.size > 0}
        <span class="text-[var(--accent)] font-semibold">
          {appStore.selectedIds.size} selected
        </span>
        <span class="text-[var(--border-strong)]">·</span>
      {/if}
      <span>Showing <strong class="text-white">{rows.length}</strong> / {appStore.items.length}</span>
    </div>
  </div>

  <!-- Column Headers -->
  <div
    style="grid-template-columns: {gridTemplate};"
    class="grid h-7 bg-[var(--bg-elevated)] border-b border-[var(--border-strong)] text-[11px] font-mono font-semibold text-[var(--text-secondary)] uppercase tracking-wider shrink-0 items-center"
    role="row"
  >
    {#each isMobile ? mobileColumns : desktopColumns as col (col.id)}
      <div class="relative h-full flex items-center px-2 overflow-hidden border-r border-[var(--border-subtle)] last:border-r-0">
        <button
          type="button"
          onclick={() => appStore.toggleSort(col.id)}
          class="w-full h-full flex items-center gap-1 cursor-pointer hover:text-white truncate {col.align === 'text-right'
            ? 'justify-end'
            : col.align === 'text-center'
              ? 'justify-center'
              : 'justify-start'}"
        >
          <span class="truncate">{col.label}</span>
          {#if appStore.sortColumn === col.id}
            {#if appStore.sortDirection === 'asc'}
              <ArrowUp class="w-3 h-3 text-[var(--accent)] shrink-0" />
            {:else}
              <ArrowDown class="w-3 h-3 text-[var(--accent)] shrink-0" />
            {/if}
          {/if}
        </button>

        {#if !isMobile && !col.flex}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            onmousedown={(e) => startColumnResize(e, col.id, col.minWidth)}
            class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--accent)]/60 z-10"
            role="separator"
            aria-orientation="vertical"
          ></div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Virtualized Table Viewport -->
  <div
    bind:this={viewportEl}
    bind:clientHeight={viewportHeight}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar relative"
  >
    {#if rows.length === 0}
      <div class="h-full min-h-[180px] flex flex-col items-center justify-center text-xs font-mono text-[var(--text-muted)] gap-1">
        <span>No queue items match the current filter.</span>
      </div>
    {:else}
      <div style="height: {totalHeight}px; position: relative; width: 100%;">
        <div
          style="position: absolute; top: 0; left: 0; right: 0; transform: translateY({offsetY}px); will-change: transform;"
        >
          {#each visibleRows as item (item.galleryId)}
            {@const gid = Number(item.galleryId)}
            {@const isSelected = appStore.selectedIds.has(gid)}
            {@const isFocused = Number(appStore.focusedId) === gid}
            {@const raw = getItemRawStatus(item)}
            {@const prog = getRowProgress(item, appStore.liveProgress)}
            {@const rank = appStore.rankById.get(gid) ?? item.id}
            {@const fmt = (item.format || appStore.downloadFormat || 'cbz').toUpperCase()}

            <div
              style="height: {ROW_HEIGHT}px; grid-template-columns: {gridTemplate};"
              onclick={(e) => handleRowClick(item, e)}
              onkeydown={(e) => e.key === 'Enter' && handleRowClick(item, e)}
              oncontextmenu={(e) => handleRowContextMenu(item, e)}
              class="grid items-center text-xs font-mono border-b border-[var(--border-subtle)]/70 cursor-pointer transition-colors {isSelected
                ? isFocused
                  ? 'bg-[var(--bg-selected-focus)] text-white'
                  : 'bg-[var(--bg-selected)] text-white'
                : 'hover:bg-[var(--bg-hover)] text-[var(--text-primary)]'}"
              role="row"
              tabindex="-1"
              aria-selected={isSelected}
              data-gallery-id={gid}
            >
              {#if isMobile}
                <!-- Mobile (< 768px): Judul, Status, Progress -->
                <div class="px-2 truncate font-sans text-xs" title={formatRowTitle(item)}>
                  <span class="text-[var(--text-muted)] font-mono mr-1">#{gid}</span>
                  <span>{formatRowTitle(item)}</span>
                </div>
                <div class="px-1.5 flex items-center">
                  <span class="px-1.5 py-0.5 text-[10px] rounded border truncate {getStatusBadgeClass(raw)}">
                    {raw}
                  </span>
                </div>
                <div class="px-2 flex items-center gap-1.5">
                  <div class="flex-1 h-1.5 bg-[#1e1e1e] rounded overflow-hidden">
                    <div
                      style="width: {prog.pct}%;"
                      class="h-full {raw === 'DONE' || raw === 'SKIPPED'
                        ? 'bg-[#a3e635]'
                        : raw === 'ON_PROGRESS'
                          ? 'bg-[#38bdf8]'
                          : raw === 'STOPPED'
                            ? 'bg-[#f59e0b]'
                            : raw === 'ERROR'
                              ? 'bg-[#f87171]'
                              : 'bg-[#64748b]'}"
                    ></div>
                  </div>
                  <span class="text-[10px] w-7 text-right">{prog.pct}%</span>
                </div>
              {:else}
                <!-- Desktop: #, Judul, ID, Status, Progress, Halaman, Speed, ETA, Batch, Format -->
                <div class="px-2 text-right text-[11px] text-[var(--text-muted)] truncate">
                  {rank}
                </div>
                <div class="px-2 truncate font-sans text-xs" title={formatRowTitle(item)}>
                  {formatRowTitle(item)}
                </div>
                <div class="px-2 text-[11px] text-[var(--text-secondary)] truncate">
                  {gid}
                </div>
                <div class="px-2 flex items-center overflow-hidden">
                  <span
                    class="px-1.5 py-0.2 text-[10px] rounded border truncate {getStatusBadgeClass(raw)}"
                    title={item.status}
                  >
                    {raw}
                  </span>
                </div>
                <div class="px-2 flex items-center gap-1.5">
                  <div class="flex-1 h-1.5 bg-[#1e1e1e] rounded overflow-hidden">
                    <div
                      style="width: {prog.pct}%;"
                      class="h-full {raw === 'DONE' || raw === 'SKIPPED'
                        ? 'bg-[#a3e635]'
                        : raw === 'ON_PROGRESS'
                          ? 'bg-[#38bdf8]'
                          : raw === 'STOPPED'
                            ? 'bg-[#f59e0b]'
                            : raw === 'ERROR'
                              ? 'bg-[#f87171]'
                              : 'bg-[#64748b]'}"
                    ></div>
                  </div>
                  <span class="text-[10px] text-[var(--text-secondary)] w-8 text-right">{prog.pct}%</span>
                </div>
                <div class="px-2 text-right text-[11px] text-[var(--text-secondary)] truncate">
                  {prog.done}/{prog.total || '—'}
                </div>
                <div class="px-2 text-right text-[11px] {prog.isLive ? 'text-[#38bdf8] font-semibold' : 'text-[var(--text-muted)]'} truncate">
                  {formatSpeed(appStore.liveProgress, prog.isLive)}
                </div>
                <div class="px-2 text-right text-[11px] {prog.isLive ? 'text-white' : 'text-[var(--text-muted)]'} truncate">
                  {formatEta(appStore.liveProgress, prog.isLive, prog.done, prog.total)}
                </div>
                <div class="px-2 text-right text-[11px] text-[var(--text-secondary)] truncate">
                  #{item.batch || 1}
                </div>
                <div class="px-2 text-center text-[10px] text-[var(--text-secondary)] truncate">
                  {fmt}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <ContextMenu
    open={contextMenu.open}
    x={contextMenu.x}
    y={contextMenu.y}
    onClose={() => (contextMenu = { ...contextMenu, open: false })}
    {onRequestDelete}
  />
</section>
