<script>
  import { BookOpen, FileText, FolderOpen, LogOut } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { onOpenLibrary, onOpenLogs, onOpenFolderPicker } = $props();

  async function handleLogout() {
    try {
      await api.logout();
    } catch {}
    window.location.reload();
  }
</script>

<header class="gsap-panel flex items-center justify-between border-b border-[#2a2a2a] pb-3 shrink-0">
  <div class="flex items-center gap-3">
    <div class="w-6 h-6 rounded bg-[#a3e635] text-black flex items-center justify-center font-bold font-mono text-xs tracking-tighter">
      &gt;_
    </div>
    <h1 class="text-base font-semibold tracking-tight text-white uppercase font-mono">NHDL_DAEMON</h1>
    <div
      class="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#181818] border border-[#2a2a2a] text-[10px] font-mono uppercase tracking-wider"
      title={appStore.sseStatus === 'connected'
        ? 'Real-time SSE stream active (/api/events)'
        : appStore.sseStatus === 'reconnecting'
          ? 'Reconnecting to SSE stream...'
          : appStore.sseStatus === 'polling'
            ? 'Fallback polling active (/api/status)'
            : 'Disconnected'}
    >
      <span
        class="w-1.5 h-1.5 rounded-full {appStore.sseStatus === 'connected'
          ? 'bg-[#a3e635]'
          : appStore.sseStatus === 'reconnecting' || appStore.sseStatus === 'polling'
            ? 'bg-amber-400 animate-pulse'
            : 'bg-[#666]'}"
      ></span>
      <span class="text-[#888]">
        {appStore.sseStatus === 'connected'
          ? 'SSE'
          : appStore.sseStatus === 'reconnecting'
            ? 'RETRY'
            : appStore.sseStatus === 'polling'
              ? 'POLL'
              : 'OFFLINE'}
      </span>
    </div>
  </div>

  <div class="flex items-center gap-2">
    <button
      onclick={onOpenLibrary}
      class="flex items-center gap-2 bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] px-3 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer text-[#a3e635]"
      title="View Downloaded Library"
    >
      <BookOpen class="w-3.5 h-3.5" />
      <span class="hidden sm:inline">Library</span>
    </button>

    <button
      onclick={onOpenLogs}
      class="flex items-center gap-2 bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] px-3 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer text-[#ccc]"
      title="View System Logs"
    >
      <FileText class="w-3.5 h-3.5 text-[#888]" />
      <span class="hidden sm:inline">Logs</span>
    </button>

    <button
      onclick={onOpenFolderPicker}
      class="hidden sm:flex items-center gap-2 bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] px-3 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer group"
      title={appStore.downloadDir || 'Using default directory'}
    >
      <FolderOpen class="w-3.5 h-3.5 text-[#a3e635] shrink-0" />
      <span class="text-[#888] group-hover:text-white transition-colors truncate max-w-[140px] md:max-w-[260px]">
        {appStore.downloadDir || 'Select Folder'}
      </span>
      <span class="text-[10px] text-[#555] border-l border-[#2a2a2a] pl-2">Change</span>
    </button>

    {#if appStore.authRequired}
      <button
        onclick={handleLogout}
        class="flex items-center gap-2 bg-[#181818] hover:bg-[#222] border border-[#2a2a2a] px-3 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer text-[#888] hover:text-white"
        title="Logout"
      >
        <LogOut class="w-3.5 h-3.5" />
        <span class="hidden sm:inline">Logout</span>
      </button>
    {/if}
  </div>
</header>
