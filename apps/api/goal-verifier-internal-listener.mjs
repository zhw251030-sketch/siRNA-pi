const verificationPath = /^\/v1\/goal-verifications\/[0-9a-f-]{36}\/(bundle|message|artifact|evidence|check|attempt|search|fetch)$/;
const goalPath = /^\/v1\/tasks\/([0-9a-f-]{36})\/goal$/i;

function header(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  if (count !== 1 || typeof request.headers[name] !== 'string') {
    throw Object.assign(new Error('Task capability unavailable'), {status: 401});
  }
  return request.headers[name];
}

function authorizeGoal(request, leases, call) {
  if (!leases || typeof leases.authorize !== 'function') {
    throw Object.assign(new Error('Task Goal API unavailable'), {status: 503});
  }
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header(request, 'authorization'));
  if (!match) throw Object.assign(new Error('Task capability unavailable'), {status: 401});
  return leases.authorize({
    token: match[1],
    taskId: header(request, 'x-sirna-task-id'),
    agentTurnId: header(request, 'x-sirna-agent-turn-id'),
    call,
  });
}

function errorResponse(response, status, message) {
  if (response.destroyed || response.writableEnded) return;
  const safeStatus = [400, 401, 403, 404, 405, 409, 503].includes(status) ? status : 500;
  response.writeHead(safeStatus, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify({error: message}));
}

function allowed(request, goalEnabled) {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host ?? ''}`); }
  catch { return false; }
  if (request.method === 'GET' && url.pathname === '/health') return true;
  if (goalEnabled && goalPath.test(url.pathname) && ['GET', 'POST', 'PATCH'].includes(request.method)) return true;
  return request.method === 'POST' && verificationPath.test(url.pathname);
}

/**
 * Keep the host listener useful only for the isolated verifier. The normal
 * web listener keeps the complete application API on loopback: this wrapper
 * prevents an internal-network client from reaching task or tool routes.
 */
export function createGoalVerifierInternalHandler(requestHandler, {goalApi, leases} = {}) {
  if (typeof requestHandler !== 'function') throw new TypeError('requestHandler is required');
  return (request, response) => {
    let url;
    try { url = new URL(request.url, `http://${request.headers.host ?? ''}`); }
    catch { request.resume(); return errorResponse(response, 400, 'Invalid request URL'); }
    const goalMatch = goalPath.exec(url.pathname);
    if (goalMatch && goalApi && leases && ['GET', 'POST', 'PATCH'].includes(request.method)) {
      const call = request.method !== 'GET';
      try {
        const taskId = header(request, 'x-sirna-task-id');
        if (taskId !== goalMatch[1]) throw Object.assign(new Error('Task capability unavailable'), {status: 401});
        const handle = authorizeGoal(request, leases, call);
        return handle.run(() => goalApi.handle(request, response, goalMatch[1])).catch(error => {
          request.resume();
          errorResponse(response, error?.status ?? 500, error?.message ?? 'Goal API unavailable');
        });
      } catch (error) {
        request.resume();
        errorResponse(response, error?.status ?? 500, error?.message ?? 'Goal API unavailable');
        return;
      }
    }
    if (allowed(request, Boolean(goalApi && leases))) return requestHandler(request, response);
    request.resume();
    errorResponse(response, 404, '此内部端口只提供 Goal verifier 和任务级 Goal 访问。');
  };
}

export { verificationPath as GOAL_VERIFIER_INTERNAL_PATH, goalPath as GOAL_INTERNAL_PATH };
