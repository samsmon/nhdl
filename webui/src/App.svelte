<script>
  import gsap from 'gsap';
  import { appStore } from './lib/stores/app.svelte.js';
  import Header from './lib/components/Header.svelte';
  import HudPanel from './lib/components/HudPanel.svelte';
  import QueuePanel from './lib/components/QueuePanel.svelte';
  import RightSidebar from './lib/components/RightSidebar.svelte';
  import FolderPickerModal from './lib/components/FolderPickerModal.svelte';
  import DeleteBatchModal from './lib/components/DeleteBatchModal.svelte';
  import LibraryModal from './lib/components/LibraryModal.svelte';
  import LogsModal from './lib/components/LogsModal.svelte';

  let showFolderPicker = $state(false);
  let showLibraryModal = $state(false);
  let showLogsModal = $state(false);
  let deleteBatchModal = $state(null);

  $effect(() => {
    appStore.loadConfig();
    appStore.connectSSE();

    gsap.from('.gsap-panel', {
      y: 12,
      opacity: 0,
      duration: 0.4,
      stagger: 0.08,
      ease: 'power2.out',
      clearProps: 'all'
    });

    return () => {
      appStore.disconnectSSE();
    };
  });
</script>

<main class="min-h-screen lg:h-screen lg:overflow-hidden bg-[#111111] text-[#e0e0e0] p-3 md:p-4 font-sans selection:bg-[#a3e635] selection:text-black flex flex-col">
  <div class="w-full max-w-[1600px] mx-auto flex flex-col gap-3 flex-1 min-h-0">
    <Header
      onOpenLibrary={() => (showLibraryModal = true)}
      onOpenLogs={() => (showLogsModal = true)}
      onOpenFolderPicker={() => (showFolderPicker = true)}
    />

    <HudPanel />

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-3 flex-1 min-h-0">
      <QueuePanel
        onOpenDeleteBatchModal={(batch) => (deleteBatchModal = batch)}
      />

      <RightSidebar
        onOpenFolderPicker={() => (showFolderPicker = true)}
      />
    </div>
  </div>

  <FolderPickerModal
    open={showFolderPicker}
    onClose={() => (showFolderPicker = false)}
  />

  <DeleteBatchModal
    batch={deleteBatchModal}
    onClose={() => (deleteBatchModal = null)}
  />

  <LibraryModal
    open={showLibraryModal}
    onClose={() => (showLibraryModal = false)}
  />

  <LogsModal
    open={showLogsModal}
    onClose={() => (showLogsModal = false)}
  />
</main>

<style>
  :global(.custom-scrollbar::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
  }
  :global(.custom-scrollbar::-webkit-scrollbar-track) {
    background: #111111;
  }
  :global(.custom-scrollbar::-webkit-scrollbar-thumb) {
    background: #2a2a2a;
    border-radius: 3px;
  }
  :global(.custom-scrollbar::-webkit-scrollbar-thumb:hover) {
    background: #444444;
  }
</style>
