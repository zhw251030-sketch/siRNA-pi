#!/bin/sh
# Select only this project's Docker endpoint, without changing global CLI context.
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
# Docker's global flag parser stops at the first subcommand (e.g. run).
# This helper accepts the subcommand directly; its subsequent flags belong to it.
case "${1:-}" in
  -*)
    printf '%s\n' 'Pass a Docker subcommand first, e.g. info, pull, run or ps.' >&2
    exit 2
    ;;
esac
for directory in "$project_root/runtime" "$project_root/runtime/docker" "$project_root/runtime/docker/client"; do
  if [ ! -d "$directory" ] || [ "$(realpath "$directory")" != "$directory" ]; then
    printf 'Expected project directory, without redirection: %s\n' "$directory" >&2
    exit 2
  fi
done
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_CONFIG="$project_root/runtime/docker/client"
exec /usr/bin/docker --config "$DOCKER_CONFIG" \
  --host "unix://$project_root/runtime/docker/run/docker.sock" "$@"
