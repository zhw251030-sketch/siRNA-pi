#!/bin/sh
# Start only the manager; this does not create a task or call a model.
set -eu
project_root=/home/hanwen/Project/project/siNRA-pi
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: sh scripts/start-project-agent-compose.sh' >&2
  exit 2
fi
/home/hanwen/.nvm/versions/node/v24.16.0/bin/node "$project_root/scripts/prepare-agent-compose.mjs"
exec sh "$project_root/scripts/project-docker.sh" compose \
  --project-name sirna-pi --env-file /dev/null --file "$project_root/compose.yml" \
  up --detach --wait --wait-timeout 120 agent-compose
