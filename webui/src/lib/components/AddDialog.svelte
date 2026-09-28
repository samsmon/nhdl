<script>
  import gsap from 'gsap';
  import { Plus, Upload, Download, X, FileText, Save } from 'lucide-svelte';
  import { appStore } from '../stores/app.svelte.js';
  import * as api from '../api.js';

  let { open, onClose } = $props();

  let dialogEl = $state(null);
  let mode = $state('add'); // 'add' | 'raw'
  let textInput = $state('');
  let format = $state('cbz');
  let submitting = $state(false);
  let errorMsg = $state('');
  let fileInputEl = $state(null);

  $effect(() => {
    if (open) {
      errorMsg = '';
      format = appStore.downloadFormat || 'cbz';
      if (dialogEl) {
        gsap.fromTo(
          dialogEl,
          { opacity: 0, scale: 0.96, y: -8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.18, ease: 'power2.out' }
        );
      }
    }
  });

  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      textInput = textInput.trim() ? `${textInput.trim()}\n${content}` : content;
    } catch {
      errorMsg = 'Failed to read file';
    } finally {
      if (fileInputEl) fileInputEl.value = '';
    }
  }

  async function handleSubmit() {
    if (!textInput.trim()) {
      errorMsg = 'Please paste at least one link or gallery ID, or upload a list.txt file.';
      return;
    }
    submitting = true;
    errorMsg = '';
    try {
      const res = await api.importQueue(textInput, format);
      if (!res.success) {
        errorMsg = res.error || 'Failed to add items';
        return;
      }
      textInput = '';
      appStore.showToast(
        `Added ${res.added} item(s) (${res.duplicates || 0} existing)`,
        'success'
      );
      onClose();
    } catch (e) {
      errorMsg = e.message || 'Network error';
    } finally {
      submitting = false;
    }
  }

  async function handleSaveRaw() {
    submitting = true;
    try {
      appStore.isEditingRaw = false;
      await api.saveQueue(appStore.rawList);
      appStore.showToast('Saved raw queue list', 'success');
      onClose();
    } catch {
      errorMsg = 'Failed to save raw list';
    } finally {
      submitting = false;
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 bg-black/75 backdrop-blur-xs z-50 flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Add Galleries to Queue"
  >
    <div
      bind:this={dialogEl}
      class="bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-md w-full max-w-lg flex flex-col overflow-hidden shadow-2xl"
    >
      <div class="bg-[var(--bg-elevated)] px-4 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div class="flex items-center gap-3">
          <button
            type="button"
            onclick={() => (mode = 'add')}
            class="text-xs font-mono uppercase tracking-wider font-semibold cursor-pointer pb-0.5 border-b-2 transition-colors {mode === 'add'
              ? 'text-[var(--accent)] border-[var(--accent)]'
              : 'text-[var(--text-secondary)] border-transparent hover:text-white'}"
          >
            Add Links / Upload
          </button>
          <button
            type="button"
            onclick={() => (mode = 'raw')}
            class="text-xs font-mono uppercase tracking-wider font-semibold cursor-pointer pb-0.5 border-b-2 transition-colors {mode === 'raw'
              ? 'text-[var(--accent)] border-[var(--accent)]'
              : 'text-[var(--text-secondary)] border-transparent hover:text-white'}"
          >
            Raw list.txt Editor
          </button>
        </div>
        <button
          type="button"
          onclick={onClose}
          class="text-[var(--text-secondary)] hover:text-white cursor-pointer"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      {#if mode === 'add'}
        <div class="p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-mono text-[var(--text-secondary)]">
              Paste URLs, 6-digit gallery IDs, or <code class="text-[var(--accent)]"># BATCH N FORMAT=cbz</code>
            </span>
            <input
              bind:this={fileInputEl}
              type="file"
              accept=".txt,text/plain"
              onchange={handleFileSelect}
              class="hidden"
            />
            <button
              type="button"
              onclick={() => fileInputEl?.click()}
              class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)] border border-[var(--border-strong)] text-white cursor-pointer shrink-0"
            >
              <Upload class="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>Upload list.txt</span>
            </button>
          </div>

          <textarea
            bind:value={textInput}
            rows="7"
            placeholder="https://certain.site/g/123456/&#10;468614&#10;# BATCH 2 FORMAT=cbz"
            onkeydown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && handleSubmit()}
            class="w-full bg-[#0a0a0a] border border-[var(--border-strong)] rounded p-3 text-xs font-mono text-white focus:outline-none focus:border-[var(--accent)] resize-y custom-scrollbar"
          ></textarea>

          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono text-[var(--text-secondary)] uppercase">Target Format:</span>
              <div class="flex items-center gap-1 bg-[#0a0a0a] p-1 rounded border border-[var(--border-subtle)] text-xs font-mono">
                {#each ['cbz', 'zip', 'folder'] as fmt (fmt)}
                  <button
                    type="button"
                    onclick={() => (format = fmt)}
                    class="px-2.5 py-0.5 rounded uppercase cursor-pointer transition-colors {format === fmt
                      ? 'bg-[var(--accent)] text-black font-bold'
                      : 'text-[var(--text-secondary)] hover:text-white'}"
                  >
                    {fmt}
                  </button>
                {/each}
              </div>
            </div>

            <a
              href="/api/queue/export"
              download="list.txt"
              class="flex items-center gap-1 text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--accent)]"
            >
              <Download class="w-3.5 h-3.5" />
              <span>Export list.txt</span>
            </a>
          </div>

          {#if errorMsg}
            <div class="text-xs font-mono text-[#f87171] bg-[#f87171]/10 border border-[#f87171]/30 px-3 py-1.5 rounded">
              {errorMsg}
            </div>
          {/if}
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
            disabled={submitting}
            onclick={handleSubmit}
            class="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-mono font-bold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black cursor-pointer disabled:opacity-50"
          >
            <Plus class="w-3.5 h-3.5 stroke-[2.5]" />
            <span>{submitting ? 'Importing...' : 'Add to Queue'}</span>
          </button>
        </div>
      {:else}
        <div class="p-4 flex flex-col gap-2.5">
          <span class="text-xs font-mono text-[var(--text-secondary)]">
            Directly edit or overwrite queue state in <code class="text-[var(--accent)]">list.txt</code> format:
          </span>
          <textarea
            bind:value={appStore.rawList}
            rows="9"
            onfocus={() => (appStore.isEditingRaw = true)}
            onblur={() => (appStore.isEditingRaw = false)}
            class="w-full bg-[#0a0a0a] border border-[var(--border-strong)] rounded p-3 text-xs font-mono text-[#ccc] focus:text-white focus:outline-none focus:border-[var(--accent)] resize-y custom-scrollbar"
          ></textarea>
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
            disabled={submitting}
            onclick={handleSaveRaw}
            class="flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-mono font-bold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black cursor-pointer disabled:opacity-50"
          >
            <Save class="w-3.5 h-3.5" />
            <span>Overwrite Queue</span>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
