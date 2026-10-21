#!/bin/sh
set -eu

pi_agent_dir=${PI_CODING_AGENT_DIR:-/root/.pi/agent}
if [ "$pi_agent_dir" != /root/.pi/agent ]; then
  echo 'Pi state directory must be /root/.pi/agent.' >&2
  exit 1
fi
export PI_CODING_AGENT_DIR="$pi_agent_dir"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 SIRNA_TOOL_CURATOR=1
umask 077
mkdir -p "$PI_CODING_AGENT_DIR"
cp /opt/sirna-pi/settings.json "$PI_CODING_AGENT_DIR/settings.json"

# Official runner arguments include model, native session and positional prompt.
# Pi parses flags after that positional prompt; force restrictions last.
# --no-extensions disables discovery, but the explicit -e guard still loads.
exec /usr/bin/node /opt/sirna-pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  "$@" --no-tools --exclude-tools '*' \
  --no-extensions -e /opt/sirna-pi/curator-guard.mjs \
  --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve --offline --thinking off
