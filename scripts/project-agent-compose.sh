#!/bin/sh
# Reuse the official CLI via the manager's local Unix socket (not guest-mounted).
set -eu
project_root=/home/hanwen/Project/project/siNRA-pi
exec sh "$project_root/scripts/project-docker.sh" compose \
  --project-name sirna-pi --env-file /dev/null --file "$project_root/compose.yml" \
  exec -T agent-compose /app/agent-compose \
  --file /project/agent-compose.yml --json "$@"
