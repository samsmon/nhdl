<script>
  import { Plus, Save, FolderOpen } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { onOpenFolderPicker } = $props();

  let newUrl = $state('');
  let insertFormat = $state('');
  let extractNotice = $state('');
  let extractNoticeTimeout = null;

  // Keep insertFormat synced to default downloadFormat initially when downloadFormat loads
  $effect(() => {
    if (!insertFormat && appStore.downloadFormat) {
      insertFormat = appStore.downloadFormat;
    }
  });

  function showNotice(msg, ms = 3000) {
    extractNotice = msg;
    if (extractNoticeTimeout) clearTimeout(extractNoticeTimeout);
    if (ms > 0) {
      extractNoticeTimeout = setTimeout(() => {
        extractNotice = '';
      }, ms);
    }
  }

  async function addTarget() {
    if (!newUrl.trim()) return;
    try {
      const data = await api.importQueue(newUrl, insertFormat);
      if (!data.success) {
        showNotice(data.error || 'Import failed');
        return;
      }
      newUrl = '';
      await appStore.syncStatusOnce();

      const parts = [`Added ${data.added} URL${data.added > 1 ? 's' : ''}`];
      if (data.alreadyDone > 0) parts.push(`${data.alreadyDone} already in library`);
      if (data.duplicates > 0) parts.push(`${data.duplicates} dup skipped`);
      if (data.ignored > 0) parts.push(`${data.ignored} ignored`);
      showNotice(`${parts.join(' · ')} (Batch #${data.batch})`, 4000);
    } catch {
      showNotice('Network error while importing');
    }
  }

  async function saveRawQueue() {
    appStore.isEditingRaw = false;
    await api.saveQueue(appStore.rawList);
    await appStore.syncStatusOnce();
  }
</script>

<div class="gsap-panel lg:col-span-5 flex flex-col gap-3 lg:min-h-0">
  <button
    onclick={onOpenFolderPicker}
    class="sm:hidden flex items-center justify-between bg-[#161616] border border-[#2a2a2a] px-3.5 py-2.5 rounded-md text-xs font-mono"
  >
    <div class="flex items-center gap-2 truncate">
      <FolderOpen class="w-4 h-4 text-[#a3e635] shrink-0" />
      <span class="text-[#aaa] truncate">{appStore.downloadDir || 'Select Download Folder'}</span>
    </div>
    <span class="text-[10px] text-[#a3e635] uppercase shrink-0 ml-2">Change</span>
  </button>

  <div class="bg-[#161616] border border-[#2a2a2a] rounded-md p-3.5 flex flex-col gap-2.5 shrink-0">
    <div class="flex items-center justify-between">
      <span class="text-xs font-mono uppercase tracking-wider text-[#a0a0a0]">Insert Target</span>
      {#if extractNotice}
        <span class="text-[10px] font-mono text-[#a3e635]">{extractNotice}</span>
      {/if}
    </div>
    <textarea
      bind:value={newUrl}
      placeholder="Paste nhentai URLs, bare 6-digit IDs, or any text containing them (Ctrl+Enter to submit)..."
      rows="3"
      onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && addTarget()}
      class="w-full bg-[#0e0e0e] border border-[#262626] rounded px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-[#a3e635] transition-colors resize-none"
    ></textarea>
    <div class="flex items-center gap-2">
      <div class="flex items-center gap-1.5 bg-[#0e0e0e] border border-[#262626] rounded px-2.5 py-1.5 text-[11px] font-mono text-[#aaa] shrink-0">
        <span class="text-[#666] uppercase text-[10px]">Format:</span>
        <select
          bind:value={insertFormat}
          class="bg-transparent text-white font-bold uppercase focus:outline-none cursor-pointer"
          title="Format for this batch"
        >
          <option value="folder" class="bg-[#161616]">Folder</option>
          <option value="zip" class="bg-[#161616]">.ZIP</option>
          <option value="cbz" class="bg-[#161616]">.CBZ</option>
        </select>
      </div>
      <button
        onclick={addTarget}
        class="flex-1 bg-[#a3e635] hover:bg-[#bef264] text-black font-semibold px-3.5 py-2 rounded text-xs font-mono transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
      >
        <Plus class="w-4 h-4 stroke-[2.5]" /> ADD TO QUEUE
      </button>
    </div>
  </div>

  <div class="bg-[#161616] border border-[#2a2a2a] rounded-md flex flex-col flex-1 min-h-[200px] lg:min-h-0 overflow-hidden">
    <div class="bg-[#1c1c1c] px-4 py-2 border-b border-[#2a2a2a] flex justify-between items-center shrink-0">
      <span class="text-xs font-mono uppercase tracking-wider text-[#a0a0a0]">Raw Memory [list.txt]</span>
      <button
        onclick={saveRawQueue}
        class="bg-[#242424] hover:bg-[#333] text-white border border-[#383838] px-2.5 py-1 rounded text-[11px] font-mono transition-colors flex items-center gap-1.5 cursor-pointer"
      >
        <Save class="w-3 h-3 text-[#a3e635]" /> OVERWRITE
      </button>
    </div>
    <textarea
      bind:value={appStore.rawList}
      onfocus={() => (appStore.isEditingRaw = true)}
      onblur={() => (appStore.isEditingRaw = false)}
      class="w-full flex-1 bg-[#0e0e0e] p-3 text-[11px] font-mono text-[#999] focus:text-white focus:outline-none resize-none leading-relaxed custom-scrollbar"
      placeholder="# Raw list.txt content..."
    ></textarea>
  </div>

  {#if appStore.errors && appStore.errors.trim().length > 0}
    <div class="bg-black border border-white rounded-md p-3 max-h-32 overflow-y-auto custom-scrollbar shrink-0">
      <div class="text-[10px] font-mono uppercase tracking-wider text-white font-bold mb-1 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-white"></span> System Faults
      </div>
      <pre class="text-[11px] font-mono text-[#ccc] whitespace-pre-wrap leading-tight">{appStore.errors}</pre>
    </div>
  {/if}
</div>
