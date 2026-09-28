<script>
  import {
    Plus,
    Play,
    Pause,
    Trash2,
    ChevronsUp,
    ChevronUp,
    ChevronDown,
    ChevronsDown,
    Power,
    RotateCcw,
    BookOpen,
    Settings,
    FileText,
    Menu,
    LogOut
  } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let {
    onOpenAdd,
    onRequestDelete,
    onOpenLibrary,
    onOpenSettings,
    onOpenLogs
  } = $props();

  const caps = $derived(appStore.selectionCapabilities);
  const isEnginePaused = $derived(
    appStore.engineStatus === 'PAUSED' || appStore.engineStatus === 'IDLE'
  );
  const isEngineCooldown = $derived(
    String(appStore.engineStatus || '').startsWith('COOLDOWN')
  );

  async function toggleEngine() {
    const action = isEnginePaused ? 'resume' : 'pause';
    await api.sendControl(action);
    appStore.showToast(
      action === 'resume' ? 'Engine started / resumed' : 'Engine paused',
      'info'
    );
  }

  async function restartEngine() {
    await api.sendControl('restart');
    appStore.showToast('Engine restarted', 'info');
  }

  async function handleLogout() {
    await api.logout();
    window.location.reload();
  }
</script>

<header
  class="h-11 bg-[var(--bg-toolbar)] border-b border-[var(--border-subtle)] px-2.5 flex items-center justify-between gap-1.5 shrink-0 select-none overflow-x-auto custom-scrollbar"
>
  <!-- Left: Brand + Mobile Drawer Trigger + Queue Item Actions -->
  <div class="flex items-center gap-1 shrink-0">
    <button
      type="button"
      onclick={() => (appStore.mobileSidebarOpen = !appStore.mobileSidebarOpen)}
      class="md:hidden p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-white cursor-pointer"
      title="Toggle Filters"
      aria-label="Toggle Filters"
    >
      <Menu class="w-4 h-4" />
    </button>

    <div class="flex items-center gap-1.5 pr-2 mr-1 border-r border-[var(--border-subtle)]">
      <span class="w-2 h-2 rounded-full bg-[var(--accent)]"></span>
      <span class="font-mono font-bold text-xs tracking-wider text-white hidden sm:inline">
        NHDL
      </span>
    </div>

    <!-- Add Target -->
    <button
      type="button"
      onclick={onOpenAdd}
      class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-mono font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black transition-colors cursor-pointer"
      title="Add Links / Upload list.txt"
    >
      <Plus class="w-3.5 h-3.5 stroke-[2.5]" />
      <span>Add</span>
    </button>

    <div class="h-4 w-px bg-[var(--border-subtle)] mx-1"></div>

    <!-- Item Resume / Pause / Delete -->
    <button
      type="button"
      disabled={!caps.canResume}
      onclick={() => appStore.resumeSelected()}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled: pointer-events-none text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      title="Resume Selected (Space)"
    >
      <Play class="w-3.5 h-3.5 text-[#a3e635]" />
      <span class="hidden lg:inline">Resume</span>
    </button>

    <button
      type="button"
      disabled={!caps.canPause}
      onclick={() => appStore.pauseSelected()}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      title="Pause Selected (Space)"
    >
      <Pause class="w-3.5 h-3.5 text-[#f59e0b]" />
      <span class="hidden lg:inline">Pause</span>
    </button>

    <button
      type="button"
      disabled={!caps.canDelete}
      onclick={onRequestDelete}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      title="Delete Selected from Queue (Delete)"
    >
      <Trash2 class="w-3.5 h-3.5 text-[#f87171]" />
      <span class="hidden lg:inline">Delete</span>
    </button>

    <div class="h-4 w-px bg-[var(--border-subtle)] mx-1"></div>

    <!-- Priority Controls: top / up / down / bottom -->
    <div class="flex items-center gap-0.5" role="group" aria-label="Priority Controls">
      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => appStore.changePriority('top')}
        class="p-1.5 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]"
        title="Move to Top Priority"
      >
        <ChevronsUp class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => appStore.changePriority('up')}
        class="p-1.5 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]"
        title="Move Priority Up"
      >
        <ChevronUp class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => appStore.changePriority('down')}
        class="p-1.5 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]"
        title="Move Priority Down"
      >
        <ChevronDown class="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => appStore.changePriority('bottom')}
        class="p-1.5 rounded text-xs font-mono transition-colors cursor-pointer disabled:opacity-35 disabled:pointer-events-none text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]"
        title="Move to Bottom Priority"
      >
        <ChevronsDown class="w-3.5 h-3.5" />
      </button>
    </div>
  </div>

  <!-- Right: Engine Start/Pause, Library, Settings, Logs -->
  <div class="flex items-center gap-1 shrink-0">
    {#if isEngineCooldown}
      <button
        type="button"
        onclick={() => appStore.triggerForceRetry()}
        class="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono bg-[#f59e0b]/20 border border-[#f59e0b]/40 text-[#fbbf24] hover:bg-[#f59e0b]/30 cursor-pointer"
        title="Skip Cooldown & Force Retry"
      >
        <RotateCcw class="w-3 h-3" />
        <span class="hidden sm:inline">Skip Cooldown</span>
      </button>
    {/if}

    <button
      type="button"
      onclick={toggleEngine}
      class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-colors cursor-pointer {isEnginePaused
        ? 'bg-[#1f2912] border-[#a3e635]/40 text-[#a3e635] hover:bg-[#2b3a18]'
        : 'bg-[#291d12] border-[#f59e0b]/40 text-[#fbbf24] hover:bg-[#382717]'}"
      title={isEnginePaused ? 'Start / Resume Engine' : 'Pause Engine'}
    >
      <Power class="w-3.5 h-3.5" />
      <span>{isEnginePaused ? 'Start Engine' : 'Pause Engine'}</span>
    </button>

    <button
      type="button"
      onclick={restartEngine}
      class="p-1.5 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] transition-colors cursor-pointer hidden sm:flex"
      title="Restart Engine"
    >
      <RotateCcw class="w-3.5 h-3.5" />
    </button>

    <div class="h-4 w-px bg-[var(--border-subtle)] mx-1"></div>

    <button
      type="button"
      onclick={onOpenLibrary}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      title="Open Library Manager (Compress / Rename / Rescan)"
    >
      <BookOpen class="w-3.5 h-3.5 text-[#a3e635]" />
      <span class="hidden md:inline">Library</span>
    </button>

    <button
      type="button"
      onclick={onOpenSettings}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      title="Settings (Download Folder, Format, Auto-Continue, API Key)"
    >
      <Settings class="w-3.5 h-3.5 text-[#38bdf8]" />
      <span class="hidden md:inline">Settings</span>
    </button>

    <button
      type="button"
      onclick={onOpenLogs}
      class="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
      title="Activity Logs"
    >
      <FileText class="w-3.5 h-3.5 text-[#a1a1aa]" />
      <span class="hidden md:inline">Logs</span>
    </button>

    {#if appStore.authRequired}
      <button
        type="button"
        onclick={handleLogout}
        class="p-1.5 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-[#f87171] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
        title="Logout"
      >
        <LogOut class="w-3.5 h-3.5" />
      </button>
    {/if}
  </div>
</header>
