<script>
  import {
    BookOpen,
    RefreshCw,
    X,
    Search,
    CheckSquare,
    Square,
    Archive,
    Pencil,
    Plus,
    ExternalLink
  } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';
  import { itemSource, sourceLabel } from '../sources.js';
  import { itemType, typeLabel, typeBadgeClass } from '../contentType.js';

  let { open, onClose } = $props();

  let libraryItems = $state([]);
  let libraryCount = $state(0);
  let librarySearch = $state('');
  let librarySource = $state('all');
  let libraryType = $state('all');
  let rescanLoading = $state(false);
  let rescanMessage = $state('');
  let rescanTimeout = null;

  let editingId = $state(null);
  let editingName = $state('');
  let renameSaving = $state(false);
  let renameError = $state('');
  let compressingId = $state(null);

  let selectedLibraryIds = $state(new Set());
  let batchCompressing = $state(false);
  let batchCompressProgress = $state(null);
  let batchCompressPollTimer = null;

  let librarySourceOptions = $derived(
    Array.from(new Set(libraryItems.map(itemSource))).map(id => ({ id, label: sourceLabel(id, appStore.sources) }))
  );

  let libraryTypeOptions = $derived(['comic', 'manga', 'other'].filter(t => libraryItems.some(i => itemType(i) === t)));

  let filteredLibrary = $derived(
    libraryItems.filter(item => {
      if (librarySource !== 'all' && itemSource(item) !== librarySource) return false;
      if (libraryType !== 'all' && itemType(item) !== libraryType) return false;
      if (!librarySearch.trim()) return true;
      const q = librarySearch.toLowerCase();
      return (
        String(item.id).toLowerCase().includes(q) ||
        item.title?.toLowerCase().includes(q) ||
        item.artist?.toLowerCase().includes(q)
      );
    })
  );

  let convertibleFilteredIds = $derived(
    filteredLibrary
      .filter(i => !i.skipped && i.format !== 'cbz' && i.format !== 'zip')
      .map(i => i.id)
  );

  let allConvertibleSelected = $derived(
    convertibleFilteredIds.length > 0 &&
      convertibleFilteredIds.every(id => selectedLibraryIds.has(id))
  );

  async function refreshLibrary() {
    try {
      const data = await api.fetchLibrary();
      libraryItems = data.items || [];
      libraryCount = data.count || 0;
    } catch {}
  }

  function showRescanMsg(msg, ms = 4000) {
    rescanMessage = msg;
    if (rescanTimeout) clearTimeout(rescanTimeout);
    if (ms > 0) {
      rescanTimeout = setTimeout(() => {
        rescanMessage = '';
      }, ms);
    }
  }

  $effect(() => {
    if (open) {
      refreshLibrary();
      api.fetchCompressStatus()
        .then(s => {
          if (s && s.running) {
            batchCompressing = true;
            batchCompressProgress = s;
            startBatchCompressPoll();
          }
        })
        .catch(() => {});

      return () => {
        if (batchCompressPollTimer) {
          clearInterval(batchCompressPollTimer);
          batchCompressPollTimer = null;
        }
      };
    }
  });

  function toggleSelectLibrary(id) {
    const next = new Set(selectedLibraryIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedLibraryIds = next;
  }

  function toggleSelectAllConvertible() {
    const next = new Set(selectedLibraryIds);
    if (allConvertibleSelected) {
      for (const id of convertibleFilteredIds) next.delete(id);
    } else {
      for (const id of convertibleFilteredIds) next.add(id);
    }
    selectedLibraryIds = next;
  }

  function clearLibrarySelection() {
    selectedLibraryIds = new Set();
  }

  function startBatchCompressPoll() {
    if (batchCompressPollTimer) clearInterval(batchCompressPollTimer);
    batchCompressPollTimer = setInterval(async () => {
      try {
        const s = await api.fetchCompressStatus();
        batchCompressProgress = s;
        await refreshLibrary();
        if (!s.running) {
          clearInterval(batchCompressPollTimer);
          batchCompressPollTimer = null;
          batchCompressing = false;
          selectedLibraryIds = new Set();
          showRescanMsg(
            `Converted ${s.converted} to .cbz (${s.skipped} already CBZ, ${s.failed} failed)`
          );
        }
      } catch {
        clearInterval(batchCompressPollTimer);
        batchCompressPollTimer = null;
        batchCompressing = false;
      }
    }, 600);
  }

  async function runBatchCompressToCbz() {
    const ids = Array.from(selectedLibraryIds);
    if (ids.length === 0 || batchCompressing) return;
    batchCompressing = true;
    try {
      const data = await api.startBatchCompress(ids, 'cbz');
      if (!data.success) {
        showRescanMsg(`Error: ${data.error || 'Batch compress failed'}`);
        batchCompressing = false;
        return;
      }
      batchCompressProgress = data;
      startBatchCompressPoll();
    } catch (e) {
      showRescanMsg(`Error: ${e.message}`);
      batchCompressing = false;
    }
  }

  async function runRescanLibrary() {
    rescanLoading = true;
    rescanMessage = '';
    try {
      const data = await api.rescanLibrary();
      await refreshLibrary();
      if (data.aborted) {
        showRescanMsg(`Rescan aborted: ${data.reason || 'Download folder unavailable'}`, 5000);
      } else {
        showRescanMsg(`Verified ${data.remaining} present, pruned ${data.removed} missing`);
      }
    } catch {}
    rescanLoading = false;
  }

  async function reenqueueFromLibrary(item) {
    try {
      const data = await api.importQueue(String(item.id), '');
      if (data.success) {
        await appStore.syncStatusOnce();
        showRescanMsg(`Re-queued #${item.id} into Batch #${data.batch}`, 3000);
      }
    } catch {}
  }

  function startEditLibrary(item) {
    editingId = item.id;
    renameError = '';
    if (item.path) {
      const base = item.path.split(/[\\/]/).pop() || item.title || item.id;
      editingName = base.replace(/\.(cbz|zip)$/i, '');
    } else {
      editingName = item.title || item.id;
    }
  }

  function cancelEditLibrary() {
    editingId = null;
    editingName = '';
    renameError = '';
  }

  async function saveEditLibrary(item) {
    if (!editingName.trim()) {
      renameError = 'Name cannot be empty';
      return;
    }
    renameSaving = true;
    renameError = '';
    try {
      const data = await api.renameLibraryEntry(item.id, editingName.trim());
      if (!data.success) {
        renameError = data.error || 'Rename failed';
      } else {
        await refreshLibrary();
        cancelEditLibrary();
      }
    } catch (e) {
      renameError = e.message;
    } finally {
      renameSaving = false;
    }
  }

  async function compressLibraryItem(item, ext = 'cbz') {
    compressingId = item.id;
    try {
      const data = await api.compressLibraryEntry(item.id, ext);
      if (data.success) {
        await refreshLibrary();
        showRescanMsg(
          data.skipped ? `Already .${ext}` : `Converted #${item.id} to .${ext}`,
          3000
        );
      } else {
        showRescanMsg(`Error: ${data.error}`, 4000);
      }
    } catch (e) {
      showRescanMsg(`Error: ${e.message}`, 4000);
    } finally {
      compressingId = null;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
    <div class="bg-[#161616] border border-[#2a2a2a] rounded-md w-full max-w-4xl flex flex-col h-[80vh] overflow-hidden shadow-2xl">
      <div class="bg-[#1c1c1c] px-4 py-3 border-b border-[#2a2a2a] flex justify-between items-center gap-3">
        <div class="flex items-center gap-2.5">
          <BookOpen class="w-4 h-4 text-[#a3e635]" />
          <span class="text-xs font-mono uppercase tracking-wider text-white font-semibold">Downloaded Library</span>
          <span class="text-[11px] font-mono bg-[#111] text-[#a3e635] px-2 py-0.5 rounded border border-[#2a2a2a]">
            {libraryCount} Total
          </span>
        </div>
        <div class="flex items-center gap-2">
          {#if rescanMessage}
            <span class="text-[11px] font-mono text-[#a3e635]">{rescanMessage}</span>
          {/if}
          <button
            onclick={runRescanLibrary}
            disabled={rescanLoading}
            class="flex items-center gap-1.5 bg-[#222] hover:bg-[#2c2c2c] border border-[#333] px-2.5 py-1 rounded text-[11px] font-mono text-[#ccc] hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            title="Verify folders on disk and remove missing entries"
          >
            <RefreshCw class="w-3.5 h-3.5 text-[#a3e635] {rescanLoading ? 'animate-spin' : ''}" />
            <span>Rescan</span>
          </button>
          <button onclick={onClose} class="text-[#888] hover:text-white cursor-pointer">
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="bg-[#121212] px-4 py-2.5 border-b border-[#262626] flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <Search class="w-3.5 h-3.5 text-[#666]" />
          <input
            type="text"
            bind:value={librarySearch}
            placeholder="Search by ID, title, or artist..."
            class="w-full bg-transparent text-xs font-mono text-white focus:outline-none"
          />
          {#if librarySourceOptions.length > 1}
            <select bind:value={librarySource} class="bg-[var(--bg-elevated)] text-xs font-mono text-white border border-[var(--border-subtle)] rounded px-2 py-1">
              <option value="all">All sources</option>
              {#each librarySourceOptions as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          {/if}
          {#if libraryTypeOptions.length > 0}
            <select bind:value={libraryType} class="bg-[var(--bg-elevated)] text-xs font-mono text-white border border-[var(--border-subtle)] rounded px-2 py-1">
              <option value="all">All types</option>
              {#each libraryTypeOptions as t (t)}
                <option value={t}>{typeLabel(t)}</option>
              {/each}
            </select>
          {/if}
          {#if librarySearch}
            <button onclick={() => (librarySearch = '')} class="text-[10px] font-mono text-[#666] hover:text-white cursor-pointer">
              CLEAR
            </button>
          {/if}
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[#1e1e1e] text-[11px] font-mono">
          <div class="flex items-center gap-2">
            <button
              onclick={toggleSelectAllConvertible}
              disabled={convertibleFilteredIds.length === 0 || batchCompressing}
              class="flex items-center gap-1.5 px-2 py-1 rounded bg-[#1b1b1b] hover:bg-[#252525] border border-[#2a2a2a] text-[#ccc] hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="Select all folder-format galleries in current view"
            >
              {#if allConvertibleSelected}
                <CheckSquare class="w-3.5 h-3.5 text-[#a3e635]" />
              {:else}
                <Square class="w-3.5 h-3.5 text-[#888]" />
              {/if}
              <span>Select all folders ({convertibleFilteredIds.length})</span>
            </button>

            {#if selectedLibraryIds.size > 0}
              <button
                onclick={clearLibrarySelection}
                disabled={batchCompressing}
                class="px-2 py-1 rounded text-[10px] uppercase text-[#888] hover:text-white bg-[#181818] border border-[#2a2a2a] cursor-pointer disabled:opacity-40"
              >
                Clear ({selectedLibraryIds.size})
              </button>
            {/if}
          </div>

          <button
            onclick={runBatchCompressToCbz}
            disabled={selectedLibraryIds.size === 0 || batchCompressing}
            class="flex items-center gap-1.5 px-3 py-1 rounded font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed {selectedLibraryIds.size > 0
              ? 'bg-[#a3e635] hover:bg-[#bef264] text-black'
              : 'bg-[#1b1b1b] text-[#666] border border-[#2a2a2a]'}"
          >
            <Archive class="w-3.5 h-3.5 {batchCompressing ? 'animate-bounce' : ''}" />
            <span>
              {#if batchCompressing}
                Converting...
              {:else}
                Convert {selectedLibraryIds.size > 0 ? selectedLibraryIds.size : ''} to .CBZ
              {/if}
            </span>
          </button>
        </div>

        {#if batchCompressProgress && (batchCompressing || batchCompressProgress.done > 0)}
          {@const bpPct =
            batchCompressProgress.total > 0
              ? Math.round((batchCompressProgress.done / batchCompressProgress.total) * 100)
              : 0}
          <div class="flex flex-col gap-1 pt-1">
            <div class="flex items-center justify-between text-[10px] font-mono text-[#aaa]">
              <span class="truncate">
                {#if batchCompressProgress.running}
                  Converting #{batchCompressProgress.currentId}: {batchCompressProgress.currentTitle || ''}
                {:else}
                  Done — {batchCompressProgress.converted} converted, {batchCompressProgress.skipped} skipped, {batchCompressProgress.failed} failed
                {/if}
              </span>
              <span class="text-[#a3e635] shrink-0 ml-2">
                {batchCompressProgress.done}/{batchCompressProgress.total} ({bpPct}%)
              </span>
            </div>
            <div class="w-full h-1.5 bg-[#0a0a0a] rounded overflow-hidden border border-[#262626]">
              <div class="h-full bg-[#a3e635] transition-all duration-200" style="width: {bpPct}%"></div>
            </div>
          </div>
        {/if}
      </div>

      <div class="p-3 overflow-y-auto flex-1 space-y-1.5 bg-[#0e0e0e] custom-scrollbar">
        {#if filteredLibrary.length === 0}
          <div class="h-40 flex items-center justify-center text-[#555] font-mono text-xs">
            {libraryItems.length === 0 ? 'LIBRARY_IS_EMPTY' : 'NO_MATCHING_RESULTS'}
          </div>
        {:else}
          {#each filteredLibrary as item (item.id)}
            <div class="flex items-center justify-between gap-3 px-3 py-2 rounded bg-[#141414] border border-[#222] hover:border-[#333] text-xs font-mono">
              {#if !item.skipped && item.format !== 'cbz' && item.format !== 'zip'}
                <button
                  onclick={() => toggleSelectLibrary(item.id)}
                  disabled={batchCompressing}
                  class="text-[#888] hover:text-[#a3e635] transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                  title="Select for batch .CBZ conversion"
                >
                  {#if selectedLibraryIds.has(item.id)}
                    <CheckSquare class="w-4 h-4 text-[#a3e635]" />
                  {:else}
                    <Square class="w-4 h-4" />
                  {/if}
                </button>
              {:else}
                <div class="w-4 shrink-0"></div>
              {/if}
              <div class="flex flex-col min-w-0 flex-1 gap-0.5">
                {#if editingId === item.id}
                  <div class="flex items-center gap-1.5">
                    <input
                      type="text"
                      bind:value={editingName}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') saveEditLibrary(item);
                        if (e.key === 'Escape') cancelEditLibrary();
                      }}
                      class="flex-1 bg-[#0a0a0a] border border-[#a3e635] rounded px-2 py-1 text-xs font-mono text-white focus:outline-none"
                    />
                    <button
                      onclick={() => saveEditLibrary(item)}
                      disabled={renameSaving}
                      class="px-2 py-1 rounded bg-[#a3e635] text-black font-bold text-[10px] uppercase cursor-pointer disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onclick={cancelEditLibrary}
                      class="px-2 py-1 rounded bg-[#242424] text-[#aaa] hover:text-white text-[10px] uppercase cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                  {#if renameError}
                    <span class="text-[10px] text-red-400">{renameError}</span>
                  {/if}
                {:else}
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-[#a3e635] shrink-0 font-bold">#{item.id}</span>
                    {#if item.skipped}
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-[#222] text-[#888]">
                        SKIPPED ({item.reason || 'Filter'})
                      </span>
                    {:else if item.artist && item.artist !== 'Other' && item.artist !== 'Unknown'}
                      <span class="text-[10px] px-1.5 py-0.5 rounded bg-[#1f2912] text-[#a3e635] border border-[#a3e635]/20 shrink-0">
                        {item.artist}
                      </span>
                    {/if}
                    {#if item.format === 'cbz' || item.format === 'zip'}
                      <span class="text-[9px] px-1.5 py-0.5 rounded bg-[#242424] text-white border border-[#3a3a3a] uppercase shrink-0">
                        .{item.format}
                      </span>
                    {/if}
                    <span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase bg-[#1e293b] text-[#7dd3fc] border border-[#334155] shrink-0">{sourceLabel(itemSource(item), appStore.sources)}</span>
                    {#if itemType(item)}<span class="px-1 py-0.5 rounded text-[9px] font-mono uppercase shrink-0 {typeBadgeClass(itemType(item))}">{typeLabel(itemType(item))}</span>{/if}
                    <span class="text-white truncate" title={item.title}>{item.title}</span>
                  </div>
                  {#if item.path}
                    <span class="text-[10px] text-[#666] truncate">{item.path}</span>
                  {/if}
                {/if}
              </div>

              <div class="flex items-center gap-2 shrink-0 text-[11px] text-[#888]">
                {#if item.pages}
                  <span>{item.pages}p</span>
                {/if}
                {#if !item.skipped && editingId !== item.id}
                  <button
                    onclick={() => startEditLibrary(item)}
                    class="text-[#666] hover:text-white p-1 rounded hover:bg-[#222] transition-colors cursor-pointer"
                    title="Rename file / folder on disk"
                  >
                    <Pencil class="w-3.5 h-3.5" />
                  </button>
                  {#if item.format !== 'cbz' && item.format !== 'zip'}
                    <button
                      onclick={() => compressLibraryItem(item, 'cbz')}
                      disabled={compressingId === item.id}
                      class="text-[#666] hover:text-[#a3e635] p-1 rounded hover:bg-[#a3e635]/10 transition-colors cursor-pointer disabled:opacity-50"
                      title="Convert folder to .CBZ archive (Komikku / Mihon compatible)"
                    >
                      <Archive class="w-3.5 h-3.5 {compressingId === item.id ? 'animate-bounce text-[#a3e635]' : ''}" />
                    </button>
                  {/if}
                {/if}
                <button
                  onclick={() => reenqueueFromLibrary(item)}
                  class="text-[#a3e635]/80 hover:text-[#a3e635] hover:bg-[#a3e635]/10 p-1 rounded transition-colors cursor-pointer"
                  title="Add back to queue (re-download if missing)"
                >
                  <Plus class="w-3.5 h-3.5" />
                </button>
                <a
                  href={`https://nhentai.net/g/${item.id}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-[#666] hover:text-white p-1 rounded hover:bg-[#222] transition-colors"
                  title="Open on nhentai"
                >
                  <ExternalLink class="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
