// Dedicated read-only role: declaration is empty and execution fails closed,
// including tools proposed by a provider without a matching declaration.
export default function curatorGuard(pi) {
  const reason='Independent Curator is read-only; all tool calls are forbidden.';
  let requests=0;
  pi.on('session_start', async () => { pi.setActiveTools([]); });
  pi.on('before_provider_request', (_event,ctx) => {if(++requests>1)ctx.abort();});
  // Unknown tools bypass Pi's tool_call hook. Reject the assistant's intent
  // before the native loop dispatches tools or schedules another response.
  // Preserve original tool-call content for the native session audit.
  pi.on('message_end', (event,ctx) => {
    if(event.message?.role==='assistant' && Array.isArray(event.message.content) && event.message.content.some(block=>block.type==='toolCall')) {
      ctx.abort();
      return {message:{...event.message,stopReason:'aborted',errorMessage:reason}};
    }
  });
  // Defense in depth for future SDK paths and directly invoked tool hooks.
  pi.on('tool_execution_start', (_event,ctx) => {ctx.abort();});
  pi.on('tool_call', async (_event,ctx) => {ctx?.abort();return {block:true,reason,terminate:true};});
}
