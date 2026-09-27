<script>
  import { AlertTriangle, Trash2, X } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { batch, onClose } = $props();

  async function confirmDeleteBatch() {
    if (!batch) return;
    const batchNum = batch.num;
    onClose();

    const lines = appStore.rawList.split(/\r?\n/);
    let currentBatch = 1;
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const bMatch = trimmed.match(/^#\s*BATCH\s+(\d+)/i);
      if (bMatch) {
        currentBatch = parseInt(bMatch[1], 10);
        if (currentBatch !== batchNum) kept.push(line);
        continue;
      }
      if (!trimmed || trimmed.startsWith('#')) {
        if (currentBatch !== batchNum) kept.push(line);
        continue;
      }
      if (currentBatch !== batchNum) {
        kept.push(line);
      }
    }
    const newRaw = kept.join('\n').trim() + '\n';
    appStore.rawList = newRaw;
    await api.saveQueue(newRaw);
    await appStore.syncStatusOnce();
  }
</script>

{#if batch}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
    <div class="bg-[#161616] border border-[#2a2a2a] rounded-md w-full max-w-md flex flex-col overflow-hidden shadow-2xl">
      <div class="bg-[#1c1c1c] px-4 py-3 border-b border-[#2a2a2a] flex justify-between items-center">
        <div class="flex items-center gap-2">
          <AlertTriangle class="w-4 h-4 text-red-400" />
          <span class="text-xs font-mono uppercase tracking-wider text-white font-semibold">
            Delete Batch #{batch.num}
          </span>
        </div>
        <button onclick={onClose} class="text-[#888] hover:text-white cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="p-4 flex flex-col gap-3 text-xs font-mono text-[#ccc]">
        <p>
          Remove <span class="text-white font-bold">Batch #{batch.num}</span> and all
          <span class="text-white font-bold">{batch.total}</span>
          {batch.total === 1 ? 'item' : 'items'} in it from the queue?
        </p>
        {#if batch.done > 0}
          <p class="text-[11px] text-[#888] bg-[#111] border border-[#262626] rounded px-2.5 py-2">
            Already downloaded galleries in your Library folder will not be deleted from disk.
          </p>
        {/if}
      </div>

      <div class="bg-[#1c1c1c] px-4 py-3 border-t border-[#2a2a2a] flex justify-end gap-2">
        <button
          onclick={onClose}
          class="px-4 py-1.5 rounded text-xs font-mono text-[#aaa] hover:text-white bg-[#242424] hover:bg-[#333] transition-colors cursor-pointer"
        >
          CANCEL
        </button>
        <button
          onclick={confirmDeleteBatch}
          class="px-4 py-1.5 rounded text-xs font-mono text-black font-semibold bg-red-500 hover:bg-red-400 transition-colors cursor-pointer flex items-center gap-1.5"
        >
          <Trash2 class="w-3.5 h-3.5" /> DELETE BATCH
        </button>
      </div>
    </div>
  </div>
{/if}
