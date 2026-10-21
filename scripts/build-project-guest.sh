#!/bin/sh
set -eu
test "$#" -eq 0 || { echo 'This entrypoint takes no arguments.' >&2; exit 1; }
project_root=/home/hanwen/Project/project/siNRA-pi
cd "$project_root"
sh scripts/project-docker.sh build --pull=false \
  --file containers/agent-compose-guest/Dockerfile --tag sirna-pi-guest:pi1.2.0-mcp4 .
