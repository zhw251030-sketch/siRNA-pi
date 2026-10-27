#!/bin/sh
set -eu

# Agent Compose mounts this provider directory and manages models.json here.
pi_agent_dir=${PI_CODING_AGENT_DIR:-/root/.pi/agent}
if [ "$pi_agent_dir" != /root/.pi/agent ]; then
  echo 'Pi state directory must be /root/.pi/agent.' >&2
  exit 1
fi

export PI_CODING_AGENT_DIR="$pi_agent_dir"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
umask 077
mkdir -p "$PI_CODING_AGENT_DIR"
cp /opt/sirna-pi/settings.json "$PI_CODING_AGENT_DIR/settings.json"

if [ "${SIRNA_GOAL_VERIFIER:-}" = "1" ]; then
  exec /usr/bin/node /opt/sirna-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
    --no-extensions -e /opt/sirna-pi/goal-verifier-guard.mjs \
    --no-skills --no-prompt-templates --no-themes --no-context-files \
    --no-approve --offline --tools mcp --thinking off "$@"
fi

# Preserve the runner's model, prompt, session directory and resume arguments.
exec /usr/bin/node /opt/sirna-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --no-extensions --no-mcp --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-approve --offline \
  --tools read,write,mcp --thinking off "$@"
