// Task-file requests are independent of chat and lifecycle requests.
const previewLimit = 256 * 1024;
const downloadLimit = 50_000_000;
const textExtensions = new Set(['txt', 'md', 'csv', 'tsv', 'tab', 'aln', 'json', 'yaml', 'yml', 'fa', 'fasta', 'fna', 'fastq', 'fq']);

export function taskFileUrl(taskId, file, download = false) {
  const path = `/v1/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(file.kind)}/${encodeURIComponent(file.name)}`;
  return download ? `${path}?download=true` : path;
}

export function canPreviewFile(file) {
  const extension = typeof file?.name === 'string' ? file.name.split('/').at(-1).match(/\.([^.]+)$/)?.[1].toLowerCase() : '';
  return textExtensions.has(extension) && Number.isSafeInteger(file?.size) && file.size >= 0 && file.size <= previewLimit;
}

export function canDownloadFile(file) {
  return Number.isSafeInteger(file?.size) && file.size >= 0 && file.size <= downloadLimit;
}

function validFile(file) {
  return file && typeof file.id === 'string' && ['input', 'output'].includes(file.kind)
    && typeof file.name === 'string' && file.name.length > 0 && !/[\\\u0000-\u001f]/.test(file.name)
    && file.name.split('/').every((part) => part && part !== '.' && part !== '..')
    && Number.isSafeInteger(file.size) && file.size >= 0
    && typeof file.sha256 === 'string' && typeof file.modifiedAt === 'string';
}

async function responseError(response) {
  const body = await response.json().catch(() => null);
  return new Error(typeof body?.error === 'string' ? body.error : `文件请求失败（HTTP ${response.status}），请重试。`);
}

export function createTaskFiles({ fetcher = fetch, onChange = () => {} } = {}) {
  let state = { taskId: null, files: [], workspaceState: null, listStatus: 'idle', error: '', reason: '', preview: null };
  let listVersion = 0;
  let previewVersion = 0;
  let listAbort;
  let previewAbort;
  function update(patch) { state = { ...state, ...patch }; onChange(state); }
  function invalidatePreview() {
    previewVersion += 1;
    previewAbort?.abort();
    previewAbort = null;
  }

  return {
    get state() { return state; },
    setTask(taskId) {
      listVersion += 1;
      listAbort?.abort();
      listAbort = null;
      invalidatePreview();
      update({ taskId, files: [], workspaceState: null, listStatus: 'idle', error: '', reason: '', preview: null });
    },
    async refresh() {
      if (!state.taskId) return;
      const taskId = state.taskId;
      const version = ++listVersion;
      listAbort?.abort();
      listAbort = new AbortController();
      invalidatePreview();
      update({ files: [], workspaceState: null, listStatus: 'loading', error: '', reason: '', preview: null });
      try {
        const response = await fetcher(`/v1/tasks/${encodeURIComponent(taskId)}/files`, { signal: listAbort.signal, cache: 'no-store' });
        if (!response.ok) throw await responseError(response);
        const body = await response.json();
        if (!['ready', 'unprepared', 'unsupported'].includes(body?.state) || !Array.isArray(body.files) || !body.files.every(validFile)) {
          throw new Error('服务器返回的文件列表不完整，请刷新文件。');
        }
        if (version !== listVersion) return;
        update({ files: body.state === 'ready' ? body.files : [], workspaceState: body.state, listStatus: 'ready', reason: typeof body.reason === 'string' ? body.reason : '' });
      } catch (error) {
        if (version !== listVersion) return;
        update({ files: [], listStatus: 'error', error: error instanceof Error ? error.message : '文件列表读取失败，请重试。' });
      }
    },
    closePreview() {
      invalidatePreview();
      update({ preview: null });
    },
    async previewFile(file) {
      if (!state.taskId || !state.files.includes(file) || !canPreviewFile(file)) return;
      const taskId = state.taskId;
      invalidatePreview();
      const version = previewVersion;
      previewAbort = new AbortController();
      update({ preview: { file, status: 'loading', text: '', error: '' } });
      try {
        const response = await fetcher(taskFileUrl(taskId, file), { signal: previewAbort.signal, cache: 'no-store' });
        if (!response.ok) throw await responseError(response);
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > previewLimit) throw new Error('文件已超过 256 KiB 预览上限，请下载查看。');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (version !== previewVersion) return;
        update({ preview: { file, status: 'ready', text, error: '' } });
      } catch (error) {
        if (version !== previewVersion) return;
        update({ preview: { file, status: 'error', text: '', error: error instanceof Error ? error.message : '预览读取失败，请下载查看。' } });
      }
    },
  };
}
