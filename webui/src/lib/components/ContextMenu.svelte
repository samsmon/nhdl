<script>
  import gsap from 'gsap';
  import {
    Play,
    Pause,
    Trash2,
    ChevronsUp,
    ChevronUp,
    ChevronDown,
    ChevronsDown,
    RotateCcw,
    ExternalLink
  } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';

  let { x = 0, y = 0, open = false, onClose, onRequestDelete } = $props();

  let menuEl = $state(null);
  let posX = $state(0);
  let posY = $state(0);

  const caps = $derived(appStore.selectionCapabilities);
  const selectedItem = $derived(appStore.selectedItem);

  $effect(() => {
    if (open) {
      const menuWidth = 196;
      const menuHeight = 280;
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
      posX = Math.max(8, Math.min(x, vw - menuWidth - 8));
      posY = Math.max(8, Math.min(y, vh - menuHeight - 8));

      if (menuEl) {
        gsap.fromTo(
          menuEl,
          { opacity: 0, scale: 0.94, y: -4 },
          { opacity: 1, scale: 1, y: 0, duration: 0.14, ease: 'power2.out' }
        );
      }
    }
  });

  function runAction(fn) {
    fn();
    onClose();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-50"
    onclick={onClose}
    oncontextmenu={(e) => {
      e.preventDefault();
      onClose();
    }}
    role="presentation"
  >
    <div
      bind:this={menuEl}
      style="left: {posX}px; top: {posY}px;"
      class="fixed w-48 bg-[var(--bg-elevated)] border border-[var(--border-strong)] rounded-md shadow-2xl py-1 text-xs font-mono text-[var(--text-primary)] select-none z-50"
      onclick={(e) => e.stopPropagation()}
      role="group"
      aria-label="Queue Item Actions"
    >
      <div class="px-3 py-1 text-[10px] text-[var(--text-muted)] border-b border-[var(--border-subtle)] truncate">
        {caps.count} selected
      </div>

      <button
        type="button"
        disabled={!caps.canResume}
        onclick={() => runAction(() => appStore.resumeSelected())}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <Play class="w-3.5 h-3.5 text-[#a3e635]" />
        <span>Resume</span>
      </button>

      <button
        type="button"
        disabled={!caps.canPause}
        onclick={() => runAction(() => appStore.pauseSelected())}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <Pause class="w-3.5 h-3.5 text-[#f59e0b]" />
        <span>Pause</span>
      </button>

      {#if selectedItem}
        <button
          type="button"
          onclick={() => runAction(() => appStore.triggerForceRetry(selectedItem.galleryId))}
          class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] cursor-pointer text-left"
        >
          <RotateCcw class="w-3.5 h-3.5 text-[#38bdf8]" />
          <span>Force Retry</span>
        </button>
      {/if}

      <div class="h-px bg-[var(--border-subtle)] my-1"></div>

      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => runAction(() => appStore.changePriority('top'))}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <ChevronsUp class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <span>Priority: Top</span>
      </button>

      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => runAction(() => appStore.changePriority('up'))}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <ChevronUp class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <span>Priority: Up</span>
      </button>

      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => runAction(() => appStore.changePriority('down'))}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <ChevronDown class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <span>Priority: Down</span>
      </button>

      <button
        type="button"
        disabled={!caps.canPriority}
        onclick={() => runAction(() => appStore.changePriority('bottom'))}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <ChevronsDown class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
        <span>Priority: Bottom</span>
      </button>

      <div class="h-px bg-[var(--border-subtle)] my-1"></div>

      <button
        type="button"
        disabled={!caps.canDelete}
        onclick={() => runAction(onRequestDelete)}
        class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[#f87171] disabled:opacity-35 disabled:pointer-events-none cursor-pointer text-left"
      >
        <Trash2 class="w-3.5 h-3.5" />
        <span>Delete from Queue</span>
      </button>

      {#if selectedItem}
        <a
          href="https://nhentai.net/g/{selectedItem.galleryId}/"
          target="_blank"
          rel="noopener noreferrer"
          onclick={onClose}
          class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-white cursor-pointer"
        >
          <ExternalLink class="w-3.5 h-3.5" />
          <span>Open Gallery Link</span>
        </a>
      {/if}
    </div>
  </div>
{/if}
