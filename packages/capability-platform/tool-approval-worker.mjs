import {ToolApprovalStore} from './tool-approval-store.mjs';

const MAX_NOTIFICATION_BYTES = 2048;

function boundedText(value, limit = 256) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function approvalNotification(job, terminal) {
  const notification = {
    protocolVersion: 'sirna-tool-approval/v1',
    jobId: job.id,
    proposalId: job.proposalId,
    requestedBy: boundedText(job.requestedBy, 120),
    status: terminal.status,
    approved: terminal.status === 'succeeded' && terminal.approved === true,
    activated: terminal.status === 'succeeded' && terminal.activated === true,
  };
  if (Buffer.byteLength(JSON.stringify(notification), 'utf8') > MAX_NOTIFICATION_BYTES) {
    throw new Error('Approval notification exceeds bounded size');
  }
  return notification;
}

export function createToolApproval({root, store, approve, onError = () => {}, onSettled} = {}) {
  if (!store || typeof store.claim !== 'function' || typeof store.finish !== 'function') throw new Error('Approval store is required');
  if (typeof approve !== 'function') throw new Error('Approval function is required');
  if (typeof onError !== 'function') throw new Error('Invalid approval error callback');
  if (onSettled !== undefined && typeof onSettled !== 'function') throw new Error('Invalid approval settled callback');

  let started = false;
  let accepting = true;
  let pump = null;
  let wakeRequested = false;

  function notify(job, terminal) {
    if (typeof onSettled !== 'function') return;
    let notification;
    try { notification = approvalNotification(job, terminal); }
    catch (error) { try { onError(error, job); } catch {} return; }
    try { Promise.resolve(onSettled(notification)).catch(() => {}); } catch {}
  }

  function reportError(error, job) {
    try { onError(error, job); } catch {}
  }

  function wake() {
    if (!started || !accepting) return;
    if (pump) { wakeRequested = true; return; }
    wakeRequested = false;
    pump = Promise.resolve().then(async () => {
      while (accepting) {
        const job = store.claim();
        if (!job) break;
        let terminal;
        try {
          const result = await approve(job.proposalId, job.requestedBy);
          terminal = store.finish(job.id, result);
        } catch (error) {
          const committed = error?.approved === true && (error?.activated === true || error?.versionActivated === true);
          if (committed) {
            terminal = store.finish(job.id, {approved: true, activated: true});
            notify(job, terminal);
            reportError(error, job);
            continue;
          }
          terminal = store.finish(job.id, {error: boundedText(error?.message ?? String(error), 2000)});
          notify(job, terminal);
          reportError(error, job);
          continue;
        }
        notify(job, terminal);
      }
    }).catch(error => { reportError(error); }).finally(() => {
      pump = null;
      if (wakeRequested) wake();
    });
  }

  return {
    start() {
      if (!started) {
        store.interruptRunning();
        started = true;
        if (store.halted()) accepting = false;
        wake();
      }
      return Promise.resolve();
    },
    status() { return {accepting: accepting && !store.halted(), halted: store.halted()}; },
    enqueue(proposalId, requestId, {approvedBy} = {}) {
      if (!accepting) throw new Error('Approval worker is stopping');
      const result = store.enqueue(proposalId, requestId, {approvedBy});
      wake();
      return result;
    },
    latest(proposalId) { return store.latest(proposalId); },
    list() { return store.list(); },
    async drain() { while (pump) await pump; },
    async stop() { accepting = false; if (pump) await pump; },
  };
}

export {ToolApprovalStore};
