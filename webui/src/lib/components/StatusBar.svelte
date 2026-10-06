<script>
  import { AlertTriangle, Activity, Wifi, WifiOff, Gauge } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';

  const counts = $derived(appStore.filterCounts);
  const statusStr = $derived(String(appStore.engineStatus || 'IDLE'));
  const isFolderWarning = $derived(
    statusStr.toLowerCase().includes('unavailable') ||
      statusStr.toLowerCase().includes('empty while library') ||
      statusStr.toLowerCase().includes('missing')
  );

  const speedText = $derived.by(() => {
    const kbps = appStore.hud.speedKBps || 0;
    if (kbps <= 0) return '0 KB/s';
    if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
    return `${kbps} KB/s`;
  });

  const sseBadge = $derived.by(() => {
    switch (appStore.sseStatus) {
      case 'connected':
        return { label: 'SSE Live', dot: 'bg-[#a3e635]', text: 'text-[#a3e635]' };
      case 'reconnecting':
        return { label: 'Reconnecting...', dot: 'bg-[#fbbf24] animate-pulse', text: 'text-[#fbbf24]' };
      case 'polling':
        return { label: 'Polling (3s)', dot: 'bg-[#38bdf8]', text: 'text-[#38bdf8]' };
      default:
        return { label: 'Offline', dot: 'bg-[#f87171]', text: 'text-[#f87171]' };
    }
  });
</script>

<footer
  class="h-7 bg-[var(--bg-toolbar)] border-t border-[var(--border-subtle)] px-3 flex items-center justify-between gap-3 text-[11px] font-mono text-[var(--text-secondary)] shrink-0 select-none overflow-x-auto custom-scrollbar"
>
  <!-- Left: Engine Status (with warning highlight when Download folder unavailable) -->
  <div class="flex items-center gap-2 shrink-0">
    {#if isFolderWarning}
      <div
        class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#fbbf24]/20 border border-[#fbbf24]/50 text-[#fbbf24] font-semibold"
      >
        <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
        <span>{statusStr}</span>
      </div>
    {:else}
      <div class="flex items-center gap-1.5">
        <Activity
          class="w-3.5 h-3.5 {statusStr === 'RUNNING'
            ? 'text-[#38bdf8]'
            : statusStr === 'PAUSED'
              ? 'text-[#f59e0b]'
              : 'text-[var(--text-muted)]'}"
        />
        <span class="uppercase font-semibold text-white">{statusStr}</span>
      </div>
    {/if}

    {#if appStore.hud.isActive}
      <span class="hidden lg:inline text-[var(--text-muted)]">·</span>
      <span class="hidden lg:inline text-[#38bdf8] truncate max-w-[260px]">
        {appStore.hud.url} ({appStore.hud.percentage}%)
      </span>
    {/if}
  </div>

  <!-- Center: Counters (Active / Queued / Done / Stopped / Failed) -->
  <div class="hidden sm:flex items-center gap-3 shrink-0">
    <span>Active: <strong class="text-[#38bdf8]">{counts.downloading}</strong></span>
    <span>Queued: <strong class="text-white">{counts.pending}</strong></span>
    <span>Done: <strong class="text-[#a3e635]">{counts.completed}</strong></span>
    {#if counts.stopped > 0}
      <span>Stopped: <strong class="text-[#f59e0b]">{counts.stopped}</strong></span>
    {/if}
    <span>Failed: <strong class="text-[#f87171]">{counts.failed}</strong></span>
  </div>

  <!-- Right: Total Speed & SSE Connection Status -->
  <div class="flex items-center gap-3 shrink-0">
    <div class="flex items-center gap-1 text-white">
      <Gauge class="w-3.5 h-3.5 text-[#38bdf8]" />
      <span>{speedText}</span>
    </div>

    <div class="h-3.5 w-px bg-[var(--border-subtle)]"></div>

    <div class="flex items-center gap-1.5 {sseBadge.text}">
      <span class="w-2 h-2 rounded-full {sseBadge.dot}"></span>
      <span>{sseBadge.label}</span>
    </div>
  </div>
</footer>
