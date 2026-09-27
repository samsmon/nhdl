<script>
  import { ChevronDown, ChevronRight, Trash2 } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import QueueItem from './QueueItem.svelte';

  let { batch, confirmingDeleteKey, onRequestDeleteItem, onRequestDeleteBatch } = $props();

  let batchFormat = $derived(
    batch.items.find(i => i.format)?.format || appStore.downloadFormat || 'folder'
  );
</script>

<div class="border border-[#242424] rounded bg-[#121212]">
  <div class="w-full flex items-center justify-between gap-2 px-3 py-2 bg-[#171717] hover:bg-[#1e1e1e] transition-colors text-xs font-mono">
    <button
      onclick={() => appStore.toggleBatchCollapse(batch.num, batch.collapsed)}
      class="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
    >
      {#if batch.collapsed}
        <ChevronRight class="w-3.5 h-3.5 text-[#888] shrink-0" />
      {:else}
        <ChevronDown class="w-3.5 h-3.5 text-[#888] shrink-0" />
      {/if}
      <span class="font-bold uppercase tracking-wider {batch.isActive ? 'text-[#a3e635]' : 'text-white'}">
        BATCH #{batch.num}
      </span>
      {#if batch.isActive}
        <span class="text-[9px] px-1.5 py-0.5 rounded bg-[#a3e635]/15 text-[#a3e635] border border-[#a3e635]/30 uppercase">
          ACTIVE
        </span>
      {:else if batch.pct === 100}
        <span class="text-[9px] px-1.5 py-0.5 rounded bg-[#222] text-[#888] uppercase">COMPLETE</span>
      {/if}
      <span
        class="text-[9px] px-1.5 py-0.5 rounded bg-[#181818] text-[#aaa] border border-[#2a2a2a] uppercase"
        title="Target format for this batch"
      >
        {batchFormat === 'cbz' ? '.CBZ' : batchFormat === 'zip' ? '.ZIP' : 'FOLDER'}
      </span>
    </button>

    <div class="flex items-center gap-2.5 shrink-0">
      <div class="w-20 h-1.5 bg-[#0a0a0a] rounded overflow-hidden border border-[#262626] hidden sm:block">
        <div class="h-full bg-[#a3e635] transition-all duration-300" style="width: {batch.pct}%"></div>
      </div>
      <span class="text-[11px] text-[#888] w-16 text-right">{batch.done}/{batch.total}</span>
      <button
        onclick={(e) => {
          e.stopPropagation();
          onRequestDeleteBatch(batch);
        }}
        class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-[#1f1414] hover:bg-red-500/20 text-red-400 hover:text-red-300 border border-red-500/30 transition-colors cursor-pointer"
        title="Delete entire batch #{batch.num}"
      >
        <Trash2 class="w-3 h-3" />
        <span class="hidden sm:inline">Delete</span>
      </button>
    </div>
  </div>

  {#if !batch.collapsed}
    <div class="divide-y divide-[#1e1e1e]">
      {#each batch.filteredItems as item (`${item.batch || 1}:${item.galleryId || item.url}`)}
        <QueueItem
          {item}
          {confirmingDeleteKey}
          onRequestDelete={onRequestDeleteItem}
        />
      {/each}
    </div>
  {/if}
</div>
