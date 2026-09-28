<script>
  import gsap from 'gsap';
  import { AlertTriangle, Trash2, X } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';

  let { open, ids = [], onClose } = $props();

  let dialogEl = $state(null);
  let deleting = $state(false);

  $effect(() => {
    if (open && dialogEl) {
      gsap.fromTo(
        dialogEl,
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.16, ease: 'power2.out' }
      );
    }
  });

  async function confirmDelete() {
    deleting = true;
    try {
      await appStore.deleteSelected(ids);
      onClose();
    } finally {
      deleting = false;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 bg-black/75 backdrop-blur-xs z-50 flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Confirm Delete from Queue"
  >
    <div
      bind:this={dialogEl}
      class="bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-md w-full max-w-md overflow-hidden shadow-2xl"
    >
      <div class="bg-[var(--bg-elevated)] px-4 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div class="flex items-center gap-2">
          <AlertTriangle class="w-4 h-4 text-[#f87171]" />
          <span class="text-xs font-mono uppercase tracking-wider font-semibold text-white">
            Remove from Queue
          </span>
        </div>
        <button
          type="button"
          onclick={onClose}
          class="text-[var(--text-secondary)] hover:text-white cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="p-4 text-xs font-mono text-[var(--text-secondary)] space-y-2">
        <p class="text-white">
          Remove <span class="text-[#f87171] font-bold">{ids.length}</span> selected item{ids.length === 1 ? '' : 's'} from the queue?
        </p>
        <p class="text-[11px] text-[var(--text-muted)]">
          Downloaded files on disk and entries in your Library will NOT be deleted. Any active download among these items will be safely stopped at the next page boundary first.
        </p>
      </div>

      <div class="bg-[var(--bg-elevated)] px-4 py-2.5 border-t border-[var(--border-subtle)] flex justify-end gap-2">
        <button
          type="button"
          onclick={onClose}
          class="px-3.5 py-1.5 rounded text-xs font-mono text-[var(--text-secondary)] hover:text-white bg-[var(--bg-surface)] border border-[var(--border-strong)] cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={deleting}
          onclick={confirmDelete}
          class="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-mono font-bold bg-[#f87171] hover:bg-[#ef4444] text-black cursor-pointer disabled:opacity-50"
        >
          <Trash2 class="w-3.5 h-3.5" />
          <span>{deleting ? 'Removing...' : 'Remove'}</span>
        </button>
      </div>
    </div>
  </div>
{/if}
