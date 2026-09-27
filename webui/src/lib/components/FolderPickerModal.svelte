<script>
  import {
    FolderOpen,
    Folder,
    CornerLeftUp,
    HardDrive,
    X,
    CheckCircle2,
    AlertTriangle,
    RefreshCw
  } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { open, onClose } = $props();

  let fsCurrentPath = $state('');
  let fsParentPath = $state(null);
  let fsDirectories = $state([]);
  let fsDrives = $state([]);

  let apiKeyInput = $state('');
  let apiKeyVerifying = $state(false);
  let apiKeyVerifyResult = $state(null);

  $effect(() => {
    if (open) {
      apiKeyInput = '';
      apiKeyVerifyResult = null;
      browseDirectory(appStore.downloadDir || '');
    }
  });

  async function browseDirectory(dirPath) {
    try {
      const data = await api.browseFs(dirPath);
      if (!data.error) {
        fsCurrentPath = data.currentPath;
        fsParentPath = data.parentPath;
        fsDirectories = data.directories || [];
        fsDrives = data.drives || [];
      }
    } catch {}
  }

  async function selectCurrentFolder() {
    try {
      const data = await api.saveConfig({ downloadDir: fsCurrentPath });
      if (data.success) {
        appStore.downloadDir = data.downloadDir;
        onClose();
      }
    } catch {}
  }

  async function setDownloadFormat(fmt) {
    try {
      const data = await api.saveConfig({ downloadFormat: fmt });
      if (data.success) {
        appStore.downloadFormat = data.downloadFormat;
      }
    } catch {}
  }

  async function toggleAutoContinueBatches() {
    const next = !appStore.autoContinueBatches;
    try {
      const data = await api.saveConfig({ autoContinueBatches: next });
      if (data.success) {
        appStore.autoContinueBatches = data.autoContinueBatches;
      }
    } catch {}
  }

  async function saveApiKey() {
    try {
      const data = await api.saveConfig({ apiKey: apiKeyInput.trim() });
      if (data.success) {
        appStore.hasApiKey = !!data.hasApiKey;
        appStore.maskedKey = data.maskedKey || '';
        apiKeyInput = '';
        apiKeyVerifyResult = null;
      }
    } catch {}
  }

  async function verifyApiKeyNow() {
    apiKeyVerifying = true;
    apiKeyVerifyResult = null;
    try {
      const data = await api.verifyApiKey(apiKeyInput.trim());
      if (data.valid) {
        apiKeyVerifyResult = { ok: true, msg: data.username ? `Valid (${data.username})` : 'Valid' };
      } else {
        apiKeyVerifyResult = { ok: false, msg: data.error || 'Invalid' };
      }
    } catch (e) {
      apiKeyVerifyResult = { ok: false, msg: e.message };
    } finally {
      apiKeyVerifying = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
    <div class="bg-[#161616] border border-[#2a2a2a] rounded-md w-full max-w-xl flex flex-col max-h-[80vh] overflow-hidden shadow-2xl">
      <div class="bg-[#1c1c1c] px-4 py-3 border-b border-[#2a2a2a] flex justify-between items-center">
        <div class="flex items-center gap-2">
          <FolderOpen class="w-4 h-4 text-[#a3e635]" />
          <span class="text-xs font-mono uppercase tracking-wider text-white font-semibold">Select Download Directory</span>
        </div>
        <button onclick={onClose} class="text-[#888] hover:text-white cursor-pointer">
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="bg-[#141414] px-4 py-2.5 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <span class="text-[11px] font-mono uppercase tracking-wider text-[#888]">Save galleries as</span>
        <div class="flex items-center gap-1 bg-[#0a0a0a] p-1 rounded border border-[#262626] text-xs font-mono">
          <button
            onclick={() => setDownloadFormat('folder')}
            class="px-2.5 py-1 rounded cursor-pointer transition-colors {appStore.downloadFormat === 'folder'
              ? 'bg-[#a3e635] text-black font-bold'
              : 'text-[#888] hover:text-white'}"
          >
            FOLDER
          </button>
          <button
            onclick={() => setDownloadFormat('cbz')}
            class="px-2.5 py-1 rounded cursor-pointer transition-colors {appStore.downloadFormat === 'cbz'
              ? 'bg-[#a3e635] text-black font-bold'
              : 'text-[#888] hover:text-white'}"
          >
            .CBZ (Komikku / Mihon)
          </button>
        </div>
      </div>

      <div class="bg-[#141414] px-4 py-2.5 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <div class="flex flex-col">
          <span class="text-[11px] font-mono uppercase tracking-wider text-[#888]">After a batch finishes</span>
          <span class="text-[10px] font-mono text-[#555]">
            {appStore.autoContinueBatches ? 'Immediately start the next batch' : 'Pause and wait for manual Start'}
          </span>
        </div>
        <div class="flex items-center gap-1 bg-[#0a0a0a] p-1 rounded border border-[#262626] text-xs font-mono shrink-0">
          <button
            onclick={() => !appStore.autoContinueBatches && toggleAutoContinueBatches()}
            class="px-2.5 py-1 rounded cursor-pointer transition-colors {appStore.autoContinueBatches
              ? 'bg-[#a3e635] text-black font-bold'
              : 'text-[#888] hover:text-white'}"
          >
            AUTO
          </button>
          <button
            onclick={() => appStore.autoContinueBatches && toggleAutoContinueBatches()}
            class="px-2.5 py-1 rounded cursor-pointer transition-colors {!appStore.autoContinueBatches
              ? 'bg-[#a3e635] text-black font-bold'
              : 'text-[#888] hover:text-white'}"
          >
            WAIT
          </button>
        </div>
      </div>

      <div class="bg-[#141414] px-4 py-2.5 border-b border-[#2a2a2a] flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-mono uppercase tracking-wider text-[#888]">nhentai API Key</span>
          {#if appStore.hasApiKey}
            <span class="text-[10px] font-mono text-[#a3e635] bg-[#a3e635]/10 border border-[#a3e635]/30 px-1.5 py-0.5 rounded">
              SET: {appStore.maskedKey}
            </span>
          {:else}
            <span class="text-[10px] font-mono text-[#666]">NOT SET</span>
          {/if}
        </div>
        <div class="flex items-center gap-1.5">
          <input
            type="password"
            bind:value={apiKeyInput}
            placeholder={appStore.hasApiKey ? 'Enter new key to replace (or leave blank & click Clear)...' : 'Paste API key from nhentai account settings...'}
            class="flex-1 bg-[#0a0a0a] border border-[#262626] rounded px-2.5 py-1 text-xs font-mono text-white focus:outline-none focus:border-[#a3e635]"
          />
          <button
            onclick={saveApiKey}
            class="px-2.5 py-1 rounded text-xs font-mono bg-[#a3e635] hover:bg-[#bef264] text-black font-bold cursor-pointer"
          >
            {apiKeyInput.trim() ? 'SAVE' : appStore.hasApiKey ? 'CLEAR' : 'SAVE'}
          </button>
          {#if appStore.hasApiKey || apiKeyInput.trim()}
            <button
              onclick={verifyApiKeyNow}
              disabled={apiKeyVerifying}
              class="px-2.5 py-1 rounded text-xs font-mono bg-[#242424] hover:bg-[#333] text-white border border-[#383838] cursor-pointer disabled:opacity-50"
            >
              {apiKeyVerifying ? '...' : 'VERIFY'}
            </button>
          {/if}
        </div>
        {#if apiKeyVerifyResult}
          <div class="text-[11px] font-mono {apiKeyVerifyResult.ok ? 'text-[#a3e635]' : 'text-red-400'}">
            {apiKeyVerifyResult.ok ? '✓ ' : '✗ '}{apiKeyVerifyResult.msg}
          </div>
        {/if}
      </div>

      {#if fsDrives && fsDrives.length > 0}
        <div class="bg-[#141414] px-3 py-2 border-b border-[#2a2a2a] flex items-center gap-1.5 overflow-x-auto">
          <HardDrive class="w-3.5 h-3.5 text-[#666] shrink-0 mr-1" />
          {#each fsDrives as drive (drive)}
            <button
              onclick={() => browseDirectory(drive)}
              class="px-2 py-0.5 rounded text-xs font-mono transition-colors cursor-pointer {fsCurrentPath.startsWith(drive)
                ? 'bg-[#a3e635] text-black font-bold'
                : 'bg-[#222] text-[#aaa] hover:bg-[#333] hover:text-white'}"
            >
              {drive}
            </button>
          {/each}
        </div>
      {/if}

      <div class="bg-[#0e0e0e] px-3 py-2 border-b border-[#262626] flex items-center gap-2">
        {#if fsParentPath}
          <button
            onclick={() => browseDirectory(fsParentPath)}
            class="p-1.5 bg-[#1c1c1c] hover:bg-[#282828] border border-[#333] rounded text-[#ccc] transition-colors cursor-pointer shrink-0"
            title="Up one level"
          >
            <CornerLeftUp class="w-3.5 h-3.5" />
          </button>
        {/if}
        <div class="text-xs font-mono text-[#a3e635] truncate select-all">{fsCurrentPath}</div>
      </div>

      <div class="p-2 overflow-y-auto flex-1 space-y-1 max-h-[340px] custom-scrollbar">
        {#if fsDirectories.length === 0}
          <div class="h-32 flex items-center justify-center text-[#555] font-mono text-xs">
            No subdirectories found
          </div>
        {:else}
          {#each fsDirectories as dir (dir.path)}
            <button
              onclick={() => browseDirectory(dir.path)}
              class="w-full flex items-center gap-2.5 px-3 py-2 rounded hover:bg-[#202020] text-left transition-colors text-xs font-mono text-[#ccc] hover:text-white cursor-pointer"
            >
              <Folder class="w-4 h-4 text-[#a3e635] shrink-0" />
              <span class="truncate">{dir.name}</span>
            </button>
          {/each}
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
          onclick={selectCurrentFolder}
          class="px-4 py-1.5 rounded text-xs font-mono text-black font-semibold bg-[#a3e635] hover:bg-[#bef264] transition-colors cursor-pointer"
        >
          SELECT THIS FOLDER
        </button>
      </div>
    </div>
  </div>
{/if}
