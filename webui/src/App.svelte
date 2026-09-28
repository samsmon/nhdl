<script>
  import { appStore } from './lib/stores/app.svelte.js';
  import Toolbar from './lib/components/Toolbar.svelte';
  import SidebarFilter from './lib/components/SidebarFilter.svelte';
  import VirtualQueueTable from './lib/components/VirtualQueueTable.svelte';
  import DetailPanel from './lib/components/DetailPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import AddDialog from './lib/components/AddDialog.svelte';
  import DeleteConfirmDialog from './lib/components/DeleteConfirmDialog.svelte';
  import FolderPickerModal from './lib/components/FolderPickerModal.svelte';
  import LibraryModal from './lib/components/LibraryModal.svelte';
  import LogsModal from './lib/components/LogsModal.svelte';
  import Toast from './lib/components/Toast.svelte';

  let showAddDialog = $state(false);
  let showDeleteConfirm = $state(false);
  let showFolderPicker = $state(false);
  let showLibraryModal = $state(false);
  let showLogsModal = $state(false);

  $effect(() => {
    appStore.loadConfig();
    appStore.connectSSE();

    return () => {
      appStore.disconnectSSE();
    };
  });
</script>

<main
  class="h-screen w-screen overflow-hidden bg-[var(--bg-base)] text-[var(--text-primary)] font-sans selection:bg-[var(--accent)] selection:text-black flex flex-col"
>
  <!-- Top Toolbar -->
  <Toolbar
    onOpenAdd={() => (showAddDialog = true)}
    onRequestDelete={() => (showDeleteConfirm = true)}
    onOpenLibrary={() => (showLibraryModal = true)}
    onOpenSettings={() => (showFolderPicker = true)}
    onOpenLogs={() => (showLogsModal = true)}
  />

  <!-- Middle Workspace: Left Sidebar Filter + Right (Virtual Queue Table + Tabbed Detail Panel) -->
  <div class="flex-1 flex min-h-0 min-w-0 overflow-hidden relative">
    <SidebarFilter />

    <div class="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      <VirtualQueueTable
        onRequestDelete={() => (showDeleteConfirm = true)}
      />

      <DetailPanel />
    </div>
  </div>

  <!-- Bottom Status Bar -->
  <StatusBar />

  <!-- Dialogs & Modals -->
  <AddDialog
    open={showAddDialog}
    onClose={() => (showAddDialog = false)}
  />

  <DeleteConfirmDialog
    open={showDeleteConfirm}
    ids={Array.from(appStore.selectedIds)}
    onClose={() => (showDeleteConfirm = false)}
  />

  <FolderPickerModal
    open={showFolderPicker}
    onClose={() => (showFolderPicker = false)}
  />

  <LibraryModal
    open={showLibraryModal}
    onClose={() => {
      showLibraryModal = false;
      appStore.refreshLibraryIndex();
    }}
  />

  <LogsModal
    open={showLogsModal}
    onClose={() => (showLogsModal = false)}
  />

  <Toast />
</main>
