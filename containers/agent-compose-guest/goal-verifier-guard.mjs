// Independent verification must be a read-only MCP role. Keep this guard in
// the guest as a second boundary after the Compose agent declaration.
export default function goalVerifierGuard(pi) {
  if (process.env.SIRNA_GOAL_VERIFIER !== '1') return;
  const reason = 'Goal verifier is restricted to immutable verification MCP tools.';
  pi.on('session_start', async () => { pi.setActiveTools(['mcp']); });
  pi.on('tool_call', async (event, ctx) => {
    const name = String(event?.toolName ?? '');
    if (name === 'mcp' || name.startsWith('goal_verifier_tools_')) return;
    ctx?.abort?.();
    return {block: true, reason, terminate: true};
  });
  pi.on('message_end', (event, ctx) => {
    if (event?.message?.role !== 'assistant' || !Array.isArray(event.message.content)) return;
    if (event.message.content.some(block => block?.type === 'toolCall' && block.name !== 'mcp')) {
      ctx?.abort?.();
      return {message: {...event.message, stopReason: 'aborted', errorMessage: reason}};
    }
  });
}
