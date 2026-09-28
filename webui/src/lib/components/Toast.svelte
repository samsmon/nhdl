<script>
  import gsap from 'gsap';
  import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';

  let toastEl = $state(null);

  $effect(() => {
    const t = appStore.toast;
    if (t && toastEl) {
      gsap.fromTo(
        toastEl,
        { opacity: 0, y: 12, scale: 0.96 },
        { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power2.out' }
      );
    }
  });
</script>

{#if appStore.toast}
  <div
    bind:this={toastEl}
    class="fixed bottom-9 right-4 z-50 flex items-center gap-2 px-3.5 py-2 rounded-md border shadow-2xl text-xs font-mono
      {appStore.toast.type === 'error'
        ? 'bg-[#2a1215] border-[#f87171]/50 text-[#f87171]'
        : appStore.toast.type === 'success'
          ? 'bg-[#172610] border-[#a3e635]/50 text-[#a3e635]'
          : 'bg-[var(--bg-elevated)] border-[var(--border-strong)] text-white'}"
    role="status"
  >
    {#if appStore.toast.type === 'error'}
      <AlertTriangle class="w-4 h-4 shrink-0" />
    {:else if appStore.toast.type === 'success'}
      <CheckCircle2 class="w-4 h-4 shrink-0" />
    {:else}
      <Info class="w-4 h-4 text-[#38bdf8] shrink-0" />
    {/if}
    <span>{appStore.toast.message}</span>
    <button
      type="button"
      onclick={() => (appStore.toast = null)}
      class="ml-1 text-[var(--text-secondary)] hover:text-white cursor-pointer"
    >
      <X class="w-3.5 h-3.5" />
    </button>
  </div>
{/if}
