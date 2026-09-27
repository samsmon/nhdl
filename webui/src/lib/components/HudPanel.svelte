<script>
  import { Play, Pause, RotateCcw } from 'lucide-svelte';
  import { flip } from 'svelte/animate';
  import { fade } from 'svelte/transition';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  async function controlEngine(action) {
    try {
      await api.sendControl(action);
      await appStore.syncStatusOnce();
    } catch {}
  }
</script>

<div class="gsap-panel bg-[#161616] border border-[#2a2a2a] rounded-md p-3.5 flex flex-col gap-2.5 relative overflow-hidden shrink-0">
  {#if appStore.hud.isActive}
    <div
      class="absolute bottom-0 left-0 h-0.5 bg-[#a3e635] transition-all duration-300"
      style="width: {appStore.hud.percentage}%"
    ></div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2.5 min-w-0">
      <div class="relative flex items-center justify-center w-2.5 h-2.5 shrink-0">
        {#if appStore.engineStatus === 'RUNNING' && appStore.hud.isActive}
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#a3e635] opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-[#a3e635]"></span>
        {:else if appStore.engineStatus === 'PAUSED'}
          <span class="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        {:else if appStore.engineStatus === 'COOLDOWN'}
          <span class="animate-pulse relative inline-flex rounded-full h-2 w-2 bg-white"></span>
        {:else}
          <span class="relative inline-flex rounded-full h-2 w-2 bg-[#444]"></span>
        {/if}
      </div>
      <span class="text-[11px] font-mono uppercase tracking-wider text-[#888] shrink-0">{appStore.engineStatus}:</span>
      <span class="text-xs font-mono text-white truncate max-w-[200px] sm:max-w-md md:max-w-xl">{appStore.hud.url}</span>
    </div>

    <div class="flex items-center gap-1.5 bg-[#0e0e0e] p-1 rounded border border-[#262626]">
      {#if appStore.engineStatus === 'RUNNING'}
        <button
          onclick={() => controlEngine('pause')}
          class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-amber-400 hover:bg-amber-400/10 transition-colors cursor-pointer"
          title="Pause Execution"
        >
          <Pause class="w-3.5 h-3.5 fill-current" /> PAUSE
        </button>
      {:else if appStore.engineStatus === 'PAUSED'}
        <button
          onclick={() => controlEngine('resume')}
          class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-[#a3e635] hover:bg-[#a3e635]/10 transition-colors cursor-pointer"
          title="Resume Execution"
        >
          <Play class="w-3.5 h-3.5 fill-current" /> RESUME
        </button>
      {:else}
        <button
          onclick={() => controlEngine('start')}
          class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-[#a3e635] hover:bg-[#a3e635]/10 transition-colors cursor-pointer"
          title="Start Queue"
        >
          <Play class="w-3.5 h-3.5 fill-current" /> START
        </button>
      {/if}

      <div class="w-[1px] h-3.5 bg-[#262626]"></div>

      <button
        onclick={() => controlEngine('restart')}
        class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono text-[#a0a0a0] hover:text-white hover:bg-[#222] transition-colors cursor-pointer"
        title="Stop and Restart Batch"
      >
        <RotateCcw class="w-3.5 h-3.5" /> RESTART
      </button>
    </div>
  </div>

  <div class="flex flex-col gap-1.5">
    <div class="flex justify-between items-end">
      <div class="flex items-center gap-2">
        <span
          class="text-sm font-medium tracking-tight {appStore.hud.statusText.includes('RATE LIMITED') ||
          appStore.hud.statusText.includes('ERROR') ||
          appStore.hud.statusText.includes('PAUSED')
            ? 'text-white font-bold underline decoration-1 underline-offset-4'
            : appStore.hud.isActive
              ? 'text-[#a3e635]'
              : 'text-[#666]'}"
        >
          {appStore.hud.statusText}
        </span>

        {#if appStore.engineStatus === 'COOLDOWN' || appStore.hud.statusText.includes('RATE LIMITED') || appStore.hud.statusText.includes('Cooldown')}
          <button
            onclick={() => appStore.triggerForceRetry()}
            class="bg-white text-black hover:bg-[#ccc] px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider font-bold transition-colors cursor-pointer animate-pulse"
          >
            FORCE RETRY NOW
          </button>
        {/if}
      </div>
      {#if appStore.hud.total > 0}
        <span class="text-xs font-mono text-[#888]">
          {appStore.hud.current} / {appStore.hud.total} <span class="text-white font-semibold">({appStore.hud.percentage}%)</span>
        </span>
      {/if}
    </div>

    <div class="w-full h-2 bg-[#0e0e0e] rounded overflow-hidden border border-[#222]">
      <div
        class="h-full transition-all duration-300 ease-out {appStore.hud.statusText.includes('RATE LIMITED')
          ? 'bg-white'
          : appStore.engineStatus === 'PAUSED'
            ? 'bg-amber-500'
            : 'bg-[#a3e635]'}"
        style="width: {appStore.hud.percentage}%"
      ></div>
    </div>
  </div>

  {#if appStore.hud.activePages && appStore.hud.activePages.length > 0}
    <div class="mt-2 pt-2.5 border-t border-[#222] flex flex-col gap-1.5">
      <div class="flex items-center justify-between text-[10px] font-mono text-[#666] uppercase tracking-wider">
        <span>Active Download Streams</span>
        <span>({appStore.hud.activePages.length} / 3 max concurrency)</span>
      </div>
      {#each appStore.hud.activePages as page (page.pageNum)}
        <div
          animate:flip={{ duration: 250 }}
          in:fade={{ duration: 150 }}
          out:fade={{ duration: 150 }}
          class="flex items-center gap-3 text-xs font-mono bg-[#111] px-2.5 py-1.5 rounded border border-[#262626]"
        >
          <span class="text-[#a3e635] w-14 shrink-0 font-bold">Page {page.pageNum}</span>
          <div class="flex-1 h-1.5 bg-[#080808] rounded overflow-hidden">
            <div
              class="h-full {page.status === 'Retrying'
                ? 'bg-amber-500'
                : 'bg-[#a3e635]'} transition-all duration-150"
              style="width: {page.progress}%"
            ></div>
          </div>
          <span class="text-[10px] text-[#888] w-20 text-right shrink-0 truncate">{page.status} ({page.progress}%)</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
