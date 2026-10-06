<script>
  import {
    Layers,
    Download,
    Clock,
    CheckCircle2,
    OctagonPause,
    AlertCircle,
    FolderGit2,
    Globe,
    X
  } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import { sourceLabel } from '../sources.js';

  const counts = $derived(appStore.filterCounts);

  const sourceItems = $derived(
    counts.sources.map((s) => ({ ...s, label: sourceLabel(s.id, appStore.sources) }))
  );

  const statusItems = $derived([
    { id: 'all', label: 'All', count: counts.all, icon: Layers, color: 'text-[#e5e5e5]' },
    { id: 'downloading', label: 'Downloading', count: counts.downloading, icon: Download, color: 'text-[#38bdf8]' },
    { id: 'queued', label: 'Queue', count: counts.queued, icon: Clock, color: 'text-[#94a3b8]' },
    { id: 'completed', label: 'Completed', count: counts.completed, icon: CheckCircle2, color: 'text-[#a3e635]' },
    { id: 'stopped', label: 'Stopped', count: counts.stopped, icon: OctagonPause, color: 'text-[#f59e0b]' },
    { id: 'failed', label: 'Failed', count: counts.failed, icon: AlertCircle, color: 'text-[#f87171]' }
  ]);
</script>

<!-- Mobile Drawer Backdrop (< 768px) -->
{#if appStore.mobileSidebarOpen}
  <div
    class="fixed inset-0 bg-black/70 z-40 md:hidden"
    onclick={() => (appStore.mobileSidebarOpen = false)}
    role="presentation"
  ></div>
{/if}

<aside
  class="w-52 bg-[var(--bg-surface)] border-r border-[var(--border-subtle)] flex flex-col shrink-0 select-none z-40
    fixed md:static inset-y-0 left-0 transition-transform duration-200 ease-out
    {appStore.mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}"
>
  <!-- Mobile header -->
  <div class="md:hidden px-3 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
    <span class="text-xs font-mono uppercase tracking-wider font-bold text-white">Filters</span>
    <button
      type="button"
      onclick={() => (appStore.mobileSidebarOpen = false)}
      class="text-[var(--text-secondary)] hover:text-white cursor-pointer"
    >
      <X class="w-4 h-4" />
    </button>
  </div>

  <!-- Status Filters -->
  <div class="p-2 flex flex-col gap-0.5">
    <div class="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
      Status
    </div>
    {#each statusItems as item (item.id)}
      {@const Icon = item.icon}
      {@const active = appStore.statusFilter === item.id}
      <button
        type="button"
        onclick={() => appStore.setStatusFilter(item.id)}
        class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {active
          ? 'bg-[var(--bg-selected-focus)] text-white font-semibold border border-[var(--accent)]/40'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white border border-transparent'}"
      >
        <div class="flex items-center gap-2 truncate">
          <Icon class="w-3.5 h-3.5 shrink-0 {item.color}" />
          <span class="truncate">{item.label}</span>
        </div>
        <span
          class="text-[11px] px-1.5 py-0.2 rounded font-mono {active
            ? 'bg-[var(--accent)] text-black font-bold'
            : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}"
        >
          {item.count}
        </span>
      </button>
    {/each}
  </div>

  {#if sourceItems.length > 0}
    <div class="p-2 pt-0 flex flex-col gap-0.5">
      <div class="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
        Source
      </div>
      {#each sourceItems as s (s.id)}
        {@const active = appStore.sourceFilter === s.id}
        <button
          type="button"
          onclick={() => appStore.setSourceFilter(s.id)}
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {active
            ? 'bg-[var(--bg-selected-focus)] text-white font-semibold border border-[var(--accent)]/40'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white border border-transparent'}"
        >
          <div class="flex items-center gap-2 truncate">
            <Globe class="w-3.5 h-3.5 shrink-0 text-[#7dd3fc]" />
            <span class="truncate">{s.label}</span>
          </div>
          <span class="text-[11px] px-1.5 rounded font-mono {active ? 'bg-[var(--accent)] text-black font-bold' : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'}">{s.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="h-px bg-[var(--border-subtle)] mx-2 my-1"></div>

  <!-- Batch Filters -->
  <div class="px-2 pt-1 pb-2 flex-1 flex flex-col min-h-0">
    <div class="px-2 py-1 flex items-center justify-between">
      <span class="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] font-semibold">
        Batches ({counts.batches.length})
      </span>
      {#if appStore.batchFilter !== null}
        <button
          type="button"
          onclick={() => appStore.setBatchFilter(null)}
          class="text-[10px] font-mono text-[var(--accent)] hover:underline cursor-pointer"
        >
          Reset
        </button>
      {/if}
    </div>

    <div class="flex-1 overflow-y-auto custom-scrollbar space-y-0.5 pr-0.5">
      <button
        type="button"
        onclick={() => appStore.setBatchFilter(null)}
        class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {appStore.batchFilter === null
          ? 'bg-[var(--bg-elevated)] text-white font-semibold'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white'}"
      >
        <div class="flex items-center gap-2 truncate">
          <FolderGit2 class="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <span>All Batches</span>
        </div>
        <span class="text-[10px] text-[var(--text-muted)]">{counts.all}</span>
      </button>

      {#each counts.batches as b (b.num)}
        {@const active = appStore.batchFilter === b.num}
        <button
          type="button"
          onclick={() => appStore.setBatchFilter(b.num)}
          class="w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer {active
            ? 'bg-[var(--bg-selected-focus)] text-white font-semibold border border-[var(--accent)]/40'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white border border-transparent'}"
        >
          <div class="flex items-center gap-2 truncate">
            <span
              class="w-1.5 h-1.5 rounded-full shrink-0 {b.active > 0
                ? 'bg-[#38bdf8] animate-pulse'
                : b.done === b.count && b.count > 0
                  ? 'bg-[#a3e635]'
                  : 'bg-[#666]'}"
            ></span>
            <span class="truncate">Batch #{b.num}</span>
          </div>
          <span class="text-[10px] font-mono text-[var(--text-secondary)]">
            {b.done}/{b.count}
          </span>
        </button>
      {/each}
    </div>
  </div>
</aside>
