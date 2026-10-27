#!/bin/sh
# Start the web API with the private bridge listener required by the isolated verifier.
set -eu
project_root=/home/hanwen/Project/project/siNRA-pi
if [ "$(uname -s)" != Linux ] || [ "$(id -un)" != hanwen ]; then
  printf '%s\n' 'Run on the Linux server as hanwen, without sudo.' >&2
  exit 2
fi
if [ "$(realpath "$project_root")" != "$project_root" ]; then
  printf '%s\n' 'Refusing a redirected project directory.' >&2
  exit 2
fi
api_host=${SIRNA_GOAL_VERIFIER_API_HOST:-172.18.0.1}
api_port=${SIRNA_GOAL_VERIFIER_API_PORT:-3001}
exec env SIRNA_GOAL_VERIFICATION=agent-compose \
  SIRNA_GOAL_VERIFIER_API_HOST="$api_host" \
  SIRNA_GOAL_VERIFIER_API_PORT="$api_port" \
  /home/hanwen/.nvm/versions/node/v24.16.0/bin/node "$project_root/apps/api/bootstrap.mjs"
