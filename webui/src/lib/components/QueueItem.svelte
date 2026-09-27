<script>
  import {
    CheckCircle2,
    AlertTriangle,
    RefreshCw,
    Clock,
    ExternalLink,
    Info,
    Trash2
  } from 'lucide-svelte';
  import {
    appStore,
    parseItemUrl,
    getStatusReason,
    isDeletableStatus,
    extractGalleryId
  } from '../stores/app.svelte.js';

  let { item, confirmingDeleteKey, onRequestDelete } = $props();

  let parsed = $derived(parseItemUrl(item.url));
  let reason = $derived(getStatusReason(item.status));
  let gid = $derived(item.galleryId ? String(item.galleryId) : extractGalleryId(parsed.rawUrl));
  let isCurrentlyDownloading = $derived(
    appStore.engineStatus === 'RUNNING' &&
      appStore.hud.activeGalleryId &&
      gid === String(appStore.hud.activeGalleryId)
  );
  let itemKey = $derived(`${item.batch || 1}:${parsed.rawUrl}`);
</script>

<div class="queue-item-row group flex items-center justify-between gap-2.5 px-2.5 py-2 hover:bg-[#1a1a1a] transition-colors text-xs font-mono">
  <div class="flex items-center gap-2.5 min-w-0 flex-1">
    {#if item.status === 'DONE'}
      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#a3e635]/10 text-[#a3e635] border border-[#a3e635]/20 shrink-0 w-24 justify-center">
        <CheckCircle2 class="w-3 h-3" /> DONE
      </span>
    {:else if item.status.startsWith('ERROR')}
      <div class="flex items-center gap-1 shrink-0">
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-black text-white border border-white w-24 justify-center truncate"
          title={item.status}
        >
          <AlertTriangle class="w-3 h-3 shrink-0" /> FAIL
        </span>
        {#if reason}
          <span class="relative group/tip inline-flex items-center text-white/70 hover:text-white cursor-help">
            <Info class="w-3.5 h-3.5" />
            <span class="pointer-events-none opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 absolute left-5 top-1/2 -translate-y-1/2 z-30 bg-black text-white border border-white rounded px-2 py-1 text-[11px] font-mono whitespace-nowrap shadow-xl">
              {reason}
            </span>
          </span>
        {/if}
      </div>
    {:else if item.status.startsWith('PAUSED') || item.status.startsWith('COOLDOWN')}
      <div class="flex items-center gap-1 shrink-0">
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-500 border border-amber-500/30 w-24 justify-center truncate"
          title={item.status}
        >
          <AlertTriangle class="w-3 h-3 shrink-0" /> PAUSED
        </span>
        {#if reason}
          <span class="relative group/tip inline-flex items-center text-amber-400/70 hover:text-amber-300 cursor-help">
            <Info class="w-3.5 h-3.5" />
            <span class="pointer-events-none opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 absolute left-5 top-1/2 -translate-y-1/2 z-30 bg-[#1a1408] text-amber-300 border border-amber-500/40 rounded px-2 py-1 text-[11px] font-mono whitespace-nowrap shadow-xl">
              {reason}
            </span>
          </span>
        {/if}
      </div>
    {:else if item.status !== 'PENDING' && !item.status.startsWith('SKIPPED')}
      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#a3e635] text-black font-bold shrink-0 w-24 justify-center">
        <RefreshCw class="w-3 h-3 animate-spin" /> ACTIVE
      </span>
    {:else if item.status.startsWith('SKIPPED')}
      <div class="flex items-center gap-1 shrink-0">
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#222] text-[#888] border border-[#333] w-24 justify-center truncate"
          title={item.status}
        >
          SKIPPED
        </span>
        {#if reason}
          <span class="relative group/tip inline-flex items-center text-[#666] hover:text-[#aaa] cursor-help">
            <Info class="w-3.5 h-3.5" />
            <span class="pointer-events-none opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 absolute left-5 top-1/2 -translate-y-1/2 z-30 bg-[#181818] text-[#ddd] border border-[#3a3a3a] rounded px-2 py-1 text-[11px] font-mono whitespace-nowrap shadow-xl">
              {reason}
            </span>
          </span>
        {/if}
      </div>
    {:else}
      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#181818] text-[#666] border border-[#262626] shrink-0 w-24 justify-center">
        <Clock class="w-3 h-3" /> PENDING
      </span>
    {/if}

    <div class="flex items-center gap-2 min-w-0 flex-1">
      {#if parsed.title}
        <span class="text-[#888] text-[10px] shrink-0">#{parsed.id}</span>
        <span
          class="truncate {item.status === 'DONE'
            ? 'text-[#555] line-through'
            : item.status !== 'PENDING'
              ? 'text-white font-semibold'
              : 'text-[#bbb]'}"
          title={parsed.title}
        >
          {parsed.title}
        </span>
      {:else}
        <span
          class="truncate {item.status === 'DONE'
            ? 'text-[#555] line-through'
            : item.status !== 'PENDING'
              ? 'text-white font-semibold'
              : 'text-[#bbb]'}"
        >
          {parsed.rawUrl}
        </span>
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-1 shrink-0">
    {#if item.status !== 'DONE' && !isCurrentlyDownloading}
      <button
        onclick={() => appStore.triggerForceRetry(gid)}
        class="text-[#a3e635]/80 hover:text-[#a3e635] hover:bg-[#a3e635]/10 p-1 rounded transition-colors cursor-pointer"
        title={item.status === 'PENDING' ? 'Prioritize & start engine if idle' : 'Reset to PENDING and retry now'}
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>
    {/if}

    <a
      href={parsed.rawUrl.startsWith('http') ? parsed.rawUrl : `https://${parsed.rawUrl}`}
      target="_blank"
      rel="noopener noreferrer"
      class="text-[#666] hover:text-white transition-colors p-1 rounded hover:bg-[#222]"
      title="Open in new tab"
    >
      <ExternalLink class="w-3.5 h-3.5" />
    </a>

    {#if isDeletableStatus(item.status)}
      <button
        onclick={() => onRequestDelete(item, itemKey)}
        class="p-1 rounded transition-colors cursor-pointer {confirmingDeleteKey === itemKey
          ? 'bg-red-500 text-black font-bold px-1.5'
          : 'text-[#666] hover:text-red-400 hover:bg-red-500/10'}"
        title={confirmingDeleteKey === itemKey ? 'Click again to confirm delete' : 'Remove from queue'}
      >
        {#if confirmingDeleteKey === itemKey}
          <span class="text-[10px] font-mono uppercase">Sure?</span>
        {:else}
          <Trash2 class="w-3.5 h-3.5" />
        {/if}
      </button>
    {/if}
  </div>
</div>

<style>
  .queue-item-row {
    content-visibility: auto;
    contain-intrinsic-size: auto none auto 36px;
  }
</style>
