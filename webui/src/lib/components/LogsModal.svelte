<script>
  import { FileText, Download, X } from 'lucide-svelte';
  import * as api from '../api.js';

  let { open, onClose } = $props();

  let activityLogs = $state('Loading logs...');
  let logsInterval = null;

  async function refreshLogs() {
    try {
      const data = await api.fetchLogs();
      activityLogs = data.logs || 'Log file is empty.';
    } catch {
      activityLogs = 'Error loading logs.';
    }
  }

  $effect(() => {
    if (open) {
      refreshLogs();
      logsInterval = setInterval(refreshLogs, 2000);
      return () => {
        if (logsInterval) {
          clearInterval(logsInterval);
          logsInterval = null;
        }
      };
    }
  });

  function downloadLogs() {
    const blob = new Blob([activityLogs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nhdl-activity-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
</script>

{#if open}
  <div class="fixed inset-0 bg-black/80 backdrop-blur-xs z-50 flex items-center justify-center p-4">
    <div class="bg-[#161616] border border-[#2a2a2a] rounded-md w-full max-w-4xl flex flex-col h-[80vh] overflow-hidden shadow-2xl">
      <div class="bg-[#1c1c1c] px-4 py-3 border-b border-[#2a2a2a] flex justify-between items-center">
        <div class="flex items-center gap-2">
          <FileText class="w-4 h-4 text-[#a3e635]" />
          <span class="text-xs font-mono uppercase tracking-wider text-white font-semibold">System Activity Log</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            onclick={downloadLogs}
            class="flex items-center gap-1.5 bg-[#222] hover:bg-[#2c2c2c] border border-[#333] px-2.5 py-1 rounded text-[11px] font-mono text-[#ccc] hover:text-white transition-colors cursor-pointer"
            title="Download log as .log file"
          >
            <Download class="w-3.5 h-3.5 text-[#a3e635]" />
            <span>Download</span>
          </button>
          <button onclick={onClose} class="text-[#888] hover:text-white cursor-pointer">
            <X class="w-4 h-4" />
          </button>
        </div>
      </div>

      <div class="p-4 overflow-y-auto flex-1 bg-[#0a0a0a] font-mono text-xs text-[#bbb] custom-scrollbar">
        <pre class="whitespace-pre-wrap leading-relaxed">{activityLogs}</pre>
      </div>
    </div>
  </div>
{/if}
