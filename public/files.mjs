// Read requests are independent; the app reserves the current task during upload.
const previewLimit = 256 * 1024;
const downloadLimit = 50_000_000;
const uploadLimit = 600_000;
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
  const empty = { files: [], workspaceState: null, synchronization: null, warning: '', listStatus: 'idle', error: '', reason: '', preview: null, uploadStatus: 'idle', uploadMessage: '' };
  let state = { taskId: null, ...empty };
  let listVersion = 0;
  let previewVersion = 0;
  let uploadVersion = 0;
  let listAbort;
  let previewAbort;
  let uploadAbort;
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
      uploadVersion += 1;
      uploadAbort?.abort();
      uploadAbort = null;
      update({ taskId, ...empty });
    },
    async uploadFile(file) {
      if (!state.taskId || state.uploadStatus === 'loading') return null;
      if (!file || typeof file.name !== 'string' || !file.name.trim() || ['.', '..'].includes(file.name)
        || /[\\/\u0000-\u001f\u007f]/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > uploadLimit) {
        update({ uploadStatus: 'error', uploadMessage: '请选择非空文件，大小不超过 600,000 字节；文件名不能包含路径。' });
        return null;
      }
      const taskId = state.taskId;
      const version = ++uploadVersion;
      uploadAbort = new AbortController();
      const signal = uploadAbort.signal;
      let submitted = false;
      update({ uploadStatus: 'loading', uploadMessage: '正在读取并上传文件，请等待结果…' });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (version !== uploadVersion) return null;
        if (bytes.byteLength !== file.size) throw new Error('file size changed');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        submitted = true;
        const response = await fetcher(`/v1/tasks/${encodeURIComponent(taskId)}/files`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ name: file.name, contentBase64: btoa(binary) }),
        });
        if (version !== uploadVersion) return null;
        if (!response.ok) {
          const message = response.status === 409 ? '无法上传：已有同名文件或当前任务状态不允许上传。请刷新核对，已有文件不会被覆盖。'
            : response.status === 413 ? '文件过大，请选择不超过 600,000 字节的文件。'
              : response.status === 400 ? '文件内容或文件名不符合要求，请检查后重新选择。'
                : '上传结果尚未确认，保存可能成功，请刷新核对后再操作。';
          update({ uploadStatus: 'error', uploadMessage: message });
          return null;
        }
        const body = await response.json();
        if (version !== uploadVersion) return null;
        if (response.status !== 201 || !validFile(body?.file) || body.file.kind !== 'input' || body.file.name !== file.name || body.file.size !== bytes.byteLength) throw new Error('invalid upload response');
        update({ uploadStatus: 'success', uploadMessage: body.synchronization === 'pending'
          ? '文件已保存，但同步到执行环境尚未确认；下次执行前会重试。请在消息中说明文件名和任务要求。'
          : '文件已保存，下次执行会使用这些输入资料。请在消息中说明文件名和任务要求。' });
        return body.file;
      } catch {
        if (version !== uploadVersion) return null;
        update({ uploadStatus: 'error', uploadMessage: submitted
          ? '连接中断或响应不完整，保存可能成功，请刷新核对；不会自动重试上传。'
          : '无法读取所选文件，请重新选择后上传。' });
        return null;
      } finally {
        if (version === uploadVersion) uploadAbort = null;
      }
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
        update({ files: body.state === 'ready' ? body.files : [], workspaceState: body.state, listStatus: 'ready', reason: typeof body.reason === 'string' ? body.reason : '',
          synchronization: ['current', 'cached', 'unprepared'].includes(body.synchronization) ? body.synchronization : null,
          warning: typeof body.warning === 'string' ? body.warning : '' });
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
        const synchronization = response.headers.get('X-Task-Files-Sync');
        const syncState = synchronization === 'cached'
          ? { synchronization, warning: state.warning || '当前预览来自已归档的文件，尚未确认与执行环境一致，请刷新文件核对。' }
          : synchronization === 'current' ? { synchronization, warning: '' } : {};
        update({ ...syncState, preview: { file, status: 'ready', text, error: '' } });
      } catch (error) {
        if (version !== previewVersion) return;
        update({ preview: { file, status: 'error', text: '', error: error instanceof Error ? error.message : '预览读取失败，请下载查看。' } });
      }
    },
  };
}
