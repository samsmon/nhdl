<script>
  import {
    FolderOpen,
    Folder,
    CornerLeftUp,
    HardDrive,
    X,
    CheckCircle2,
    AlertTriangle,
    RefreshCw,
    Database,
    Download,
    Upload,
    Archive,
    Trash2,
    FileJson,
    Clock
  } from 'lucide-svelte';
  import gsap from 'gsap';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { open, onClose } = $props();

  let activeTab = $state('general'); // 'general' | 'database'

  let fsCurrentPath = $state('');
  let fsParentPath = $state(null);
  let fsDirectories = $state([]);
  let fsDrives = $state([]);

  let apiKeyInput = $state('');
  let apiKeyVerifying = $state(false);
  let apiKeyVerifyResult = $state(null);

  // Database Tab State
  let dbInfo = $state(null);
  let backups = $state([]);
  let dbLoading = $state(false);
  let backupLoading = $state(false);

  // Import State
  let importFile = $state(null);
  let importMode = $state('merge'); // 'merge' | 'replace'
  let importConfirmChecked = $state(false);
  let importLoading = $state(false);

  // Restore State
  let confirmingRestore = $state(null);
  let restoreLoading = $state(false);

  // Delete Backup State
  let deletingBackup = $state(null);

  // Engine Pause prompt state (Point 2)
  let engineNeedsPause = $state(false);
  let pausingEngine = $state(false);

  // Pre-import backup display state (Point 3)
  let lastPreImportBackup = $state(null);

  // Scheduled backup settings state (Point 4)
  let backupIntervalInput = $state(24);
  let backupKeepInput = $state(7);
  let savingBackupSettings = $state(false);

  let nextBackupDisplay = $derived.by(() => {
    const hours = Number(dbInfo?.backupIntervalHours ?? backupIntervalInput);
    if (!Number.isFinite(hours) || hours <= 0) return 'Disabled (interval = 0)';
    if (!dbInfo?.lastBackupAt) return 'Pending / Soon';
    const last = new Date(dbInfo.lastBackupAt).getTime();
    if (isNaN(last)) return 'Pending / Soon';
    const nextMs = last + hours * 3600 * 1000;
    const diffMs = nextMs - Date.now();
    if (diffMs <= 0) return 'Due now';
    return formatDate(new Date(nextMs).toISOString());
  });

  async function handleSaveBackupSettings() {
    savingBackupSettings = true;
    try {
      await api.saveBackupSettings({
        backupIntervalHours: Number(backupIntervalInput),
        backupKeep: Number(backupKeepInput)
      });
      appStore.showToast('Backup schedule settings saved', 'success');
      await loadDbData();
    } catch (e) {
      appStore.showToast(e.message || 'Failed to save backup settings', 'error');
    } finally {
      savingBackupSettings = false;
    }
  }

  async function handlePauseEngine() {
    pausingEngine = true;
    try {
      await api.sendControl('pause');
      engineNeedsPause = false;
      appStore.showToast('Engine paused', 'info');
    } catch (e) {
      appStore.showToast(e.message || 'Failed to pause engine', 'error');
    } finally {
      pausingEngine = false;
    }
  }

  let dialogEl = $state(null);

  $effect(() => {
    if (open) {
      apiKeyInput = '';
      apiKeyVerifyResult = null;
      browseDirectory(appStore.downloadDir || '');
      loadDbData();
    }
  });

  $effect(() => {
    if (open && dialogEl) {
      gsap.fromTo(
        dialogEl,
        { opacity: 0, scale: 0.96, y: -8 },
        { opacity: 1, scale: 1, y: 0, duration: 0.18, ease: 'power2.out' }
      );
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

  async function loadDbData() {
    dbLoading = true;
    try {
      const [info, list] = await Promise.all([
        api.fetchDbInfo(),
        api.fetchDbBackups()
      ]);
      dbInfo = info;
      backups = list || [];
      if (info?.backupIntervalHours !== undefined) {
        backupIntervalInput = info.backupIntervalHours;
      }
      if (info?.backupKeep !== undefined) {
        backupKeepInput = info.backupKeep;
      }
    } catch (e) {
      appStore.showToast(e.message || 'Failed to load database info', 'error');
    } finally {
      dbLoading = false;
    }
  }

  async function handleCreateBackup() {
    backupLoading = true;
    try {
      const res = await api.createDbBackup();
      appStore.showToast(`Backup created: ${res.filename}`, 'success');
      backups = await api.fetchDbBackups();
    } catch (e) {
      appStore.showToast(e.message || 'Failed to create backup', 'error');
    } finally {
      backupLoading = false;
    }
  }

  async function handleRestoreBackup(filename) {
    restoreLoading = true;
    engineNeedsPause = false;
    try {
      const res = await api.restoreDbBackup(filename, 'replace');
      if (res.preImportBackup) {
        lastPreImportBackup = res.preImportBackup;
        appStore.showToast(`Database restored from ${filename} (Pre-import backup: ${res.preImportBackup})`, 'success', 6000);
      } else {
        appStore.showToast(`Database restored from ${filename}`, 'success');
      }
      confirmingRestore = null;
      await appStore.loadConfig();
      appStore.refreshLibraryIndex();
      await loadDbData();
    } catch (e) {
      if (e.needsPause || e.message?.includes('Pause engine first') || e.status === 409) {
        engineNeedsPause = true;
      }
      appStore.showToast(e.message || 'Failed to restore backup', 'error');
    } finally {
      restoreLoading = false;
    }
  }

  async function handleDeleteBackup(filename) {
    deletingBackup = filename;
    try {
      await api.deleteDbBackup(filename);
      appStore.showToast(`Deleted backup: ${filename}`, 'info');
      backups = await api.fetchDbBackups();
    } catch (e) {
      appStore.showToast(e.message || 'Failed to delete backup', 'error');
    } finally {
      deletingBackup = null;
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (file) {
      importFile = file;
      importConfirmChecked = false;
    }
  }

  function handleFileDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.endsWith('.json')) {
      importFile = file;
      importConfirmChecked = false;
    }
  }

  async function executeImport() {
    if (!importFile) return;
    if (importMode === 'replace' && !importConfirmChecked) return;

    importLoading = true;
    engineNeedsPause = false;
    try {
      const text = await importFile.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON file format');
      }

      const dataPayload = parsed.data || parsed;
      const res = await api.importDbData(dataPayload, importMode);
      const queueCount = res.imported?.queue ?? 0;
      const libCount = res.imported?.library ?? 0;
      if (res.preImportBackup) {
        lastPreImportBackup = res.preImportBackup;
        appStore.showToast(
          `Import complete (${importMode} mode): ${queueCount} queue, ${libCount} library items. Pre-import backup: ${res.preImportBackup}`,
          'success',
          6000
        );
      } else {
        appStore.showToast(
          `Import complete (${importMode} mode): ${queueCount} queue, ${libCount} library items`,
          'success'
        );
      }
      importFile = null;
      importConfirmChecked = false;
      await appStore.loadConfig();
      appStore.refreshLibraryIndex();
      await loadDbData();
    } catch (e) {
      if (e.needsPause || e.message?.includes('Pause engine first') || e.status === 409) {
        engineNeedsPause = true;
      }
      appStore.showToast(e.message || 'Failed to import database', 'error');
    } finally {
      importLoading = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
  }

  function formatDate(isoStr) {
    if (!isoStr) return '-';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString();
    } catch {
      return isoStr;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
    <div bind:this={dialogEl} class="bg-[#161616] border border-[#2a2a2a] rounded-md w-full max-w-xl flex flex-col max-h-[85vh] overflow-hidden shadow-2xl">
      <!-- Title Header -->
      <div class="bg-[#1c1c1c] px-4 py-3 border-b border-[#2a2a2a] flex justify-between items-center">
        <div class="flex items-center gap-2">
          <FolderOpen class="w-4 h-4 text-[#a3e635]" />
          <span class="text-xs font-mono uppercase tracking-wider text-white font-semibold">Settings</span>
        </div>
        <button onclick={onClose} class="text-[#888] hover:text-white cursor-pointer" title="Close">
          <X class="w-4 h-4" />
        </button>
      </div>

      <!-- Navigation Tabs -->
      <div class="bg-[#141414] px-4 border-b border-[#2a2a2a] flex items-center gap-4">
        <button
          onclick={() => activeTab = 'general'}
          class="py-2 px-1 border-b-2 text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer {activeTab === 'general'
            ? 'border-[#a3e635] text-white font-semibold'
            : 'border-transparent text-[#777] hover:text-[#ccc]'}"
        >
          <FolderOpen class="w-3.5 h-3.5" />
          <span>General & Downloads</span>
        </button>
        <button
          onclick={() => { activeTab = 'database'; loadDbData(); }}
          class="py-2 px-1 border-b-2 text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer {activeTab === 'database'
            ? 'border-[#a3e635] text-white font-semibold'
            : 'border-transparent text-[#777] hover:text-[#ccc]'}"
        >
          <Database class="w-3.5 h-3.5" />
          <span>Database</span>
        </button>
      </div>

      {#if activeTab === 'general'}
        <!-- General & Downloads Tab Body -->
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
              .CBZ
            </button>
            <button
              onclick={() => setDownloadFormat('zip')}
              class="px-2.5 py-1 rounded cursor-pointer transition-colors {appStore.downloadFormat === 'zip'
                ? 'bg-[#a3e635] text-black font-bold'
                : 'text-[#888] hover:text-white'}"
            >
              .ZIP
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

        <div class="p-2 overflow-y-auto flex-1 space-y-1 max-h-[280px] custom-scrollbar">
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
      {:else}
        <!-- Database Tab Body -->
        <div class="p-4 overflow-y-auto flex-1 space-y-4 max-h-[58vh] custom-scrollbar text-xs font-mono">
          {#if engineNeedsPause}
            <div class="bg-[#2a1315] border border-[#f87171]/40 rounded p-2.5 flex items-center justify-between gap-3 text-[#fca5a5]">
              <div class="flex items-center gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0 text-[#f87171]" />
                <span class="text-xs">Engine is running or downloading. Pause engine first.</span>
              </div>
              <button
                onclick={handlePauseEngine}
                disabled={pausingEngine}
                class="px-2.5 py-1 rounded bg-[#f87171] hover:bg-[#ef4444] text-black font-semibold text-xs cursor-pointer shrink-0 disabled:opacity-50"
              >
                {pausingEngine ? 'Pausing...' : 'Pause Engine'}
              </button>
            </div>
          {/if}

          {#if lastPreImportBackup}
            <div class="bg-[#1c2612] border border-[#a3e635]/40 rounded p-2.5 flex items-center justify-between gap-2 text-[#d9f99d]">
              <div class="flex items-center gap-2 min-w-0">
                <Archive class="w-4 h-4 text-[#a3e635] shrink-0" />
                <span class="truncate">Pre-import backup created: <strong class="text-white font-mono">{lastPreImportBackup}</strong></span>
              </div>
              <button
                onclick={() => lastPreImportBackup = null}
                class="text-[#888] hover:text-white text-[11px] cursor-pointer shrink-0 ml-2"
              >
                Dismiss
              </button>
            </div>
          {/if}

          <!-- 1. Database Info Header Card -->
          <div class="bg-[#121212] border border-[#262626] rounded p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-start gap-3">
              <div class="p-2 rounded bg-[#1c1c1c] border border-[#2a2a2a] text-[#a3e635] shrink-0">
                <Database class="w-5 h-5" />
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-white uppercase tracking-wider">
                    {dbInfo?.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
                  </span>
                  {#if dbInfo?.connected}
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-[#a3e635]/15 text-[#a3e635] border border-[#a3e635]/30">
                      Connected
                    </span>
                  {:else}
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                      Disconnected
                    </span>
                  {/if}
                </div>
                <div class="text-[11px] text-[#888] mt-1 break-all">
                  {#if dbInfo?.type === 'postgres'}
                    <span>Host: <strong class="text-[#ccc]">{dbInfo?.host || 'localhost'}:{dbInfo?.port || 5432}</strong> | DB: <strong class="text-[#ccc]">{dbInfo?.database || 'nhdl'}</strong></span>
                  {:else}
                    <span>Path: <strong class="text-[#ccc]">{dbInfo?.path || 'data/nhdl.db'}</strong></span>
                  {/if}
                </div>
              </div>
            </div>

            <!-- Quick Action: Export & Backup Now buttons -->
            <div class="flex items-center gap-2 shrink-0">
              <a
                href="/api/db/export"
                download
                class="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#222] hover:bg-[#2d2d2d] text-white border border-[#333] transition-colors cursor-pointer"
                title="Download database export as JSON"
              >
                <Download class="w-3.5 h-3.5 text-[#a3e635]" />
                <span>Export DB</span>
              </a>
              <button
                onclick={handleCreateBackup}
                disabled={backupLoading}
                class="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#a3e635] hover:bg-[#bef264] text-black font-semibold transition-colors cursor-pointer disabled:opacity-50"
                title="Create immediate backup in data/backups/"
              >
                <Archive class="w-3.5 h-3.5" />
                <span>{backupLoading ? 'Backing up...' : 'Backup Now'}</span>
              </button>
            </div>
          </div>

          <!-- 2. Import Database Section -->
          <div class="bg-[#121212] border border-[#262626] rounded p-3 space-y-3">
            <div class="flex items-center gap-2 border-b border-[#222] pb-2">
              <Upload class="w-4 h-4 text-[#a3e635]" />
              <span class="font-semibold text-white uppercase tracking-wider">Import Database</span>
            </div>

            <!-- Drop Zone / File Picker -->
            <div
              role="region"
              aria-label="Database import file drop zone"
              ondragover={(e) => e.preventDefault()}
              ondrop={handleFileDrop}
              class="border border-dashed border-[#333] hover:border-[#a3e635] rounded-md p-4 text-center bg-[#0d0d0d] transition-colors cursor-pointer relative"
            >
              <input
                type="file"
                accept=".json"
                onchange={handleFileSelect}
                class="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
              {#if importFile}
                <div class="flex items-center justify-center gap-2 text-white">
                  <FileJson class="w-4 h-4 text-[#a3e635]" />
                  <span class="font-semibold">{importFile.name}</span>
                  <span class="text-[#777]">({formatBytes(importFile.size)})</span>
                </div>
                <p class="text-[11px] text-[#666] mt-1">Click or drag another file to replace</p>
              {:else}
                <Upload class="w-6 h-6 text-[#555] mx-auto mb-1" />
                <p class="text-[#aaa]">Drag & drop a database export JSON file here, or click to browse</p>
                <p class="text-[10px] text-[#555] mt-1">Accepts .json exported from NHDL (SQLite or PostgreSQL)</p>
              {/if}
            </div>

            {#if importFile}
              <!-- Mode Selection -->
              <div class="bg-[#161616] p-2.5 rounded border border-[#262626] space-y-2">
                <span class="text-[11px] text-[#888] uppercase tracking-wider block">Import Mode</span>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label
                    class="flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors {importMode === 'merge' ? 'bg-[#1c2612] border-[#a3e635]/40 text-white' : 'bg-[#141414] border-[#222] text-[#888]'}"
                  >
                    <input
                      type="radio"
                      name="importMode"
                      value="merge"
                      bind:group={importMode}
                      class="mt-0.5 accent-[#a3e635]"
                    />
                    <div>
                      <div class="font-semibold text-white">Merge (Skip duplicates)</div>
                      <div class="text-[10px] text-[#777] mt-0.5">Keeps existing entries; only inserts new queue and library items.</div>
                    </div>
                  </label>
                  <label
                    class="flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors {importMode === 'replace' ? 'bg-[#2a1315] border-[#f87171]/40 text-white' : 'bg-[#141414] border-[#222] text-[#888]'}"
                  >
                    <input
                      type="radio"
                      name="importMode"
                      value="replace"
                      bind:group={importMode}
                      class="mt-0.5 accent-[#f87171]"
                    />
                    <div>
                      <div class="font-semibold text-[#f87171]">Replace all data</div>
                      <div class="text-[10px] text-[#777] mt-0.5">Clears all existing tables before importing new records.</div>
                    </div>
                  </label>
                </div>

                {#if importMode === 'replace'}
                  <div class="bg-[#2e1518] border border-[#f87171]/40 rounded p-2.5 flex items-start gap-2 text-[#fca5a5]">
                    <AlertTriangle class="w-4 h-4 shrink-0 text-[#f87171] mt-0.5" />
                    <div class="space-y-1.5 flex-1">
                      <span class="font-semibold block">Warning: Overwrite Risk</span>
                      <p class="text-[11px] text-[#fca5a5]/80">This will permanently delete and replace all existing queue, library, settings, and events in the database.</p>
                      <label class="flex items-center gap-2 pt-1 cursor-pointer text-white font-semibold">
                        <input
                          type="checkbox"
                          bind:checked={importConfirmChecked}
                          class="accent-[#f87171] rounded"
                        />
                        <span class="text-[11px]">I confirm replacing all current database records</span>
                      </label>
                    </div>
                  </div>
                {/if}

                <div class="flex justify-end gap-2 pt-1">
                  <button
                    onclick={() => { importFile = null; importConfirmChecked = false; }}
                    class="px-3 py-1.5 rounded bg-[#222] hover:bg-[#333] text-[#aaa] transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onclick={executeImport}
                    disabled={importLoading || (importMode === 'replace' && !importConfirmChecked)}
                    class="px-3 py-1.5 rounded font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed {importMode === 'replace' ? 'bg-[#f87171] hover:bg-[#ef4444] text-black' : 'bg-[#a3e635] hover:bg-[#bef264] text-black'}"
                  >
                    {importLoading ? 'Importing...' : 'Start Import'}
                  </button>
                </div>
              </div>
            {/if}
          </div>

          <!-- 3. Scheduled Backups Settings Section (Point 4) -->
          <div class="bg-[#121212] border border-[#262626] rounded p-3 space-y-3">
            <div class="flex items-center justify-between border-b border-[#222] pb-2">
              <div class="flex items-center gap-2">
                <Clock class="w-4 h-4 text-[#a3e635]" />
                <span class="font-semibold text-white uppercase tracking-wider">Scheduled Backups</span>
              </div>
              <div class="flex flex-wrap items-center gap-3 text-[10px]">
                {#if dbInfo?.lastBackupAt}
                  <span class="text-[#888]">Last: {formatDate(dbInfo.lastBackupAt)}</span>
                {/if}
                <span class="text-[#a3e635]">Next: {nextBackupDisplay}</span>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label for="backup-interval-input" class="block text-[11px] text-[#aaa] mb-1 font-semibold">
                  Backup Interval (Hours)
                </label>
                <input
                  id="backup-interval-input"
                  type="number"
                  min="0"
                  max="720"
                  bind:value={backupIntervalInput}
                  class="w-full bg-[#1c1c1c] border border-[#333] focus:border-[#a3e635] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  placeholder="24"
                />
                <span class="text-[10px] text-[#666] mt-0.5 block">0 = disabled, default 24h</span>
              </div>

              <div>
                <label for="backup-keep-input" class="block text-[11px] text-[#aaa] mb-1 font-semibold">
                  Backups to Keep
                </label>
                <input
                  id="backup-keep-input"
                  type="number"
                  min="1"
                  max="100"
                  bind:value={backupKeepInput}
                  class="w-full bg-[#1c1c1c] border border-[#333] focus:border-[#a3e635] rounded px-2.5 py-1.5 text-xs text-white outline-none"
                  placeholder="7"
                />
                <span class="text-[10px] text-[#666] mt-0.5 block">Max backup snapshots retained (default 7)</span>
              </div>
            </div>

            <div class="flex items-center justify-between pt-1">
              <span class="text-[10px] text-[#666] break-all">
                Directory: {dbInfo?.backupDir || 'data/backups'}
              </span>
              <button
                onclick={handleSaveBackupSettings}
                disabled={savingBackupSettings}
                class="px-3 py-1.5 rounded bg-[#a3e635] hover:bg-[#bef264] text-black font-semibold text-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {savingBackupSettings ? 'Saving...' : 'Save Schedule'}
              </button>
            </div>
          </div>

          <!-- 4. Local Backups List Section -->
          <div class="bg-[#121212] border border-[#262626] rounded p-3 space-y-3">
            <div class="flex items-center justify-between border-b border-[#222] pb-2">
              <div class="flex items-center gap-2">
                <Archive class="w-4 h-4 text-[#a3e635]" />
                <span class="font-semibold text-white uppercase tracking-wider">Stored Backups</span>
                <span class="text-[10px] text-[#666]">({backups.length} / {backupKeepInput || 7} kept)</span>
              </div>
              <button
                onclick={loadDbData}
                class="text-[#777] hover:text-white transition-colors cursor-pointer"
                title="Refresh backups list"
              >
                <RefreshCw class="w-3.5 h-3.5" />
              </button>
            </div>

            {#if confirmingRestore}
              <div class="bg-[#2a1315] border border-[#f87171]/40 rounded p-3 space-y-2">
                <div class="flex items-start gap-2 text-[#fca5a5]">
                  <AlertTriangle class="w-4 h-4 shrink-0 text-[#f87171] mt-0.5" />
                  <div>
                    <span class="font-semibold block">Restore Confirmation</span>
                    <p class="text-[11px] text-[#fca5a5]/90 mt-0.5">
                      Are you sure you want to restore <code class="text-white bg-black/40 px-1 py-0.5 rounded">{confirmingRestore}</code>?
                      This will overwrite all existing database data with the backup contents.
                    </p>
                  </div>
                </div>
                <div class="flex justify-end gap-2 pt-1">
                  <button
                    onclick={() => confirmingRestore = null}
                    disabled={restoreLoading}
                    class="px-2.5 py-1 rounded bg-[#222] hover:bg-[#333] text-[#aaa] transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onclick={() => handleRestoreBackup(confirmingRestore)}
                    disabled={restoreLoading}
                    class="px-3 py-1 rounded bg-[#f87171] hover:bg-[#ef4444] text-black font-semibold transition-colors cursor-pointer"
                  >
                    {restoreLoading ? 'Restoring...' : 'Confirm Restore'}
                  </button>
                </div>
              </div>
            {/if}

            {#if backups.length === 0}
              <div class="text-center py-6 text-[#555]">
                No backup files found in <code class="text-[#777]">data/backups/</code>.
              </div>
            {:else}
              <div class="space-y-1.5 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                {#each backups as b (b.filename)}
                  <div class="flex items-center justify-between p-2 rounded bg-[#161616] border border-[#222] hover:border-[#333] transition-colors">
                    <div class="min-w-0 flex-1 pr-2">
                      <div class="font-semibold text-white truncate text-xs">{b.filename}</div>
                      <div class="text-[10px] text-[#777] flex items-center gap-2 mt-0.5">
                        <span>{formatBytes(b.size)}</span>
                        <span>•</span>
                        <span>{formatDate(b.createdAt)}</span>
                      </div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      <button
                        onclick={() => confirmingRestore = b.filename}
                        class="px-2 py-1 rounded text-[11px] bg-[#222] hover:bg-[#2d2d2d] text-[#a3e635] border border-[#333] transition-colors cursor-pointer"
                        title="Restore this backup"
                      >
                        Restore
                      </button>
                      <button
                        onclick={() => handleDeleteBackup(b.filename)}
                        disabled={deletingBackup === b.filename}
                        class="p-1 rounded text-[#777] hover:text-[#f87171] hover:bg-[#251515] transition-colors cursor-pointer"
                        title="Delete this backup"
                      >
                        <Trash2 class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="bg-[#1c1c1c] px-4 py-3 border-t border-[#2a2a2a] flex justify-end">
          <button
            onclick={onClose}
            class="px-4 py-1.5 rounded text-xs font-mono text-black font-semibold bg-[#a3e635] hover:bg-[#bef264] transition-colors cursor-pointer"
          >
            CLOSE
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
