<script>
  import { Search, Trash2, X } from 'lucide-svelte';
  import { appStore, parseItemUrl } from '../stores/app.svelte.js';
  import * as api from '../api.js';
  import BatchGroup from './BatchGroup.svelte';

  let { onOpenDeleteBatchModal } = $props();

  let confirmingClearCompleted = $state(false);
  let confirmingClearTimeout = null;
  let confirmingDeleteKey = $state(null);
  let confirmingDeleteTimeout = null;

  let overallPct = $derived(
    appStore.items.length > 0
      ? Math.round((appStore.doneCount / appStore.items.length) * 100)
      : 0
  );

  function serializeQueueExcluding(predicate) {
    const lines = appStore.rawList.split(/\r?\n/);
    let currentBatch = 1;
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const bMatch = trimmed.match(/^#\s*BATCH\s+(\d+)/i);
      if (bMatch) {
        currentBatch = parseInt(bMatch[1], 10);
        kept.push(line);
        continue;
      }
      if (!trimmed || trimmed.startsWith('#')) {
        kept.push(line);
        continue;
      }
      const m = trimmed.match(/^\[(.*?)\]\s*(.*)$/);
      const status = m ? m[1] : 'PENDING';
      const url = m ? m[2] : trimmed;
      if (!predicate({ status, url, batch: currentBatch, rawLine: line })) {
        kept.push(line);
      }
    }
    return kept.join('\n').trim() + '\n';
  }

  async function clearCompleted() {
    if (!confirmingClearCompleted) {
      confirmingClearCompleted = true;
      if (confirmingClearTimeout) clearTimeout(confirmingClearTimeout);
      confirmingClearTimeout = setTimeout(() => {
        confirmingClearCompleted = false;
      }, 3000);
      return;
    }
    confirmingClearCompleted = false;
    if (confirmingClearTimeout) clearTimeout(confirmingClearTimeout);

    const newRaw = serializeQueueExcluding(
      row => row.status === 'DONE' || row.status.startsWith('SKIPPED')
    );
    appStore.rawList = newRaw;
    await api.saveQueue(newRaw);
    await appStore.syncStatusOnce();
  }

  async function deleteItem(item, key) {
    if (confirmingDeleteKey !== key) {
      confirmingDeleteKey = key;
      if (confirmingDeleteTimeout) clearTimeout(confirmingDeleteTimeout);
      confirmingDeleteTimeout = setTimeout(() => {
        confirmingDeleteKey = null;
      }, 3000);
      return;
    }
    confirmingDeleteKey = null;
    if (confirmingDeleteTimeout) clearTimeout(confirmingDeleteTimeout);

    const targetRaw = parseItemUrl(item.url).rawUrl;
    const targetBatch = item.batch || 1;
    let removed = false;
    const newRaw = serializeQueueExcluding(row => {
      if (removed) return false;
      const rowRaw = parseItemUrl(row.url).rawUrl;
      if (row.batch === targetBatch && rowRaw === targetRaw) {
        removed = true;
        return true;
      }
      return false;
    });
    appStore.rawList = newRaw;
    await api.saveQueue(newRaw);
    await appStore.syncStatusOnce();
  }
</script>

<div class="gsap-panel lg:col-span-7 flex flex-col bg-[#161616] border border-[#2a2a2a] rounded-md overflow-hidden lg:min-h-0">
  <div class="bg-[#1c1c1c] px-4 py-2.5 border-b border-[#2a2a2a] flex flex-col gap-2 shrink-0">
    <div class="flex justify-between items-center gap-2">
      <span class="text-xs font-mono uppercase tracking-wider text-[#a0a0a0]">Execution Queue</span>
      <div class="flex items-center gap-2">
        {#if appStore.retryFeedback}
          <span class="text-[10px] font-mono text-[#a3e635] bg-[#a3e635]/10 border border-[#a3e635]/30 px-2 py-0.5 rounded">
            {appStore.retryFeedback}
          </span>
        {/if}
        {#if appStore.doneCount > 0}
          <button
            onclick={clearCompleted}
            class="flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded border transition-colors cursor-pointer {confirmingClearCompleted
              ? 'bg-red-500 text-black border-red-400 font-bold'
              : 'bg-[#111] text-[#888] hover:text-white border-[#2a2a2a]'}"
            title="Remove all DONE and SKIPPED items from queue"
          >
            <Trash2 class="w-3 h-3" />
            {confirmingClearCompleted ? 'Confirm Clear?' : 'Clear Completed'}
          </button>
        {/if}
        <span class="text-xs font-mono bg-[#111] text-[#a3e635] px-2 py-0.5 rounded border border-[#2a2a2a]">
          {appStore.doneCount} / {appStore.items.length} Done
        </span>
      </div>
    </div>

    {#if appStore.items.length > 0}
      <div class="w-full h-1 bg-[#0e0e0e] rounded overflow-hidden">
        <div
          class="h-full bg-[#a3e635] transition-all duration-300"
          style="width: {overallPct}%"
        ></div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
        <div class="relative flex-1 min-w-[140px]">
          <Search class="w-3 h-3 text-[#666] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            bind:value={appStore.queueSearch}
            placeholder="Filter queue (ID, title, status)..."
            class="w-full bg-[#111] border border-[#262626] rounded pl-6 pr-6 py-1 text-[11px] font-mono text-white focus:outline-none focus:border-[#a3e635]"
          />
          {#if appStore.queueSearch}
            <button
              onclick={() => (appStore.queueSearch = '')}
              class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#666] hover:text-white cursor-pointer"
            >
              <X class="w-3 h-3" />
            </button>
          {/if}
        </div>
        <div class="flex items-center gap-1 text-[10px] font-mono">
          {#each ['all', 'active', 'pending', 'done', 'failed'] as f (f)}
            <button
              onclick={() => (appStore.queueFilter = f)}
              class="px-2 py-1 rounded uppercase cursor-pointer border transition-colors {appStore.queueFilter === f
                ? 'bg-[#a3e635] text-black border-[#a3e635] font-bold'
                : 'bg-[#111] text-[#888] border-[#262626] hover:text-white'}"
            >
              {f}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="p-2 overflow-y-auto flex-1 max-h-[450px] lg:max-h-none space-y-2 custom-scrollbar">
    {#if appStore.items.length === 0}
      <div class="h-40 flex items-center justify-center text-[#555] font-mono text-xs">
        QUEUE_IS_EMPTY
      </div>
    {:else if appStore.visibleBatches.length === 0}
      <div class="h-40 flex items-center justify-center text-[#555] font-mono text-xs">
        NO_MATCHING_ITEMS
      </div>
    {:else}
      {#each appStore.visibleBatches as batch (batch.num)}
        <BatchGroup
          {batch}
          {confirmingDeleteKey}
          onRequestDeleteItem={deleteItem}
          onRequestDeleteBatch={onOpenDeleteBatchModal}
        />
      {/each}
    {/if}
  </div>
</div>
