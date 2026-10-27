const verificationPath = /^\/v1\/goal-verifications\/[0-9a-f-]{36}\/(bundle|message|artifact|evidence|check|attempt|search|fetch)$/;

function allowed(request) {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host ?? ''}`); }
  catch { return false; }
  if (request.method === 'GET' && url.pathname === '/health') return true;
  return request.method === 'POST' && verificationPath.test(url.pathname);
}

/**
 * Keep the host listener useful only for the isolated verifier. The normal
 * web listener keeps the complete application API on loopback: this wrapper
 * prevents an internal-network client from reaching task or tool routes.
 */
export function createGoalVerifierInternalHandler(requestHandler) {
  if (typeof requestHandler !== 'function') throw new TypeError('requestHandler is required');
  return (request, response) => {
    if (allowed(request)) return requestHandler(request, response);
    request.resume();
    response.writeHead(404, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(JSON.stringify({error: '此内部端口只提供 Goal verifier 访问。'}));
  };
}

export { verificationPath as GOAL_VERIFIER_INTERNAL_PATH };
