#!/bin/sh
# Run in the foreground as hanwen. Background/log management belongs to the caller.
set -eu

project_root=/home/hanwen/Project/project/siNRA-pi
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Usage: sh scripts/start-project-docker.sh' >&2
  exit 2
fi
sh "$project_root/scripts/check-docker-rootless.sh"
umask 077

private_directory() {
  directory=$1
  permitted_mode=${2:-700}
  if [ -L "$directory" ]; then
    printf 'Refusing redirected directory: %s\n' "$directory" >&2
    exit 1
  fi
  if [ ! -e "$directory" ]; then
    mkdir "$directory"
  fi
  if [ ! -d "$directory" ] || [ "$(stat -c %u "$directory")" != "$(id -u)" ] ||
     { [ "$(stat -c %a "$directory")" != 700 ] && [ "$(stat -c %a "$directory")" != "$permitted_mode" ]; }; then
    printf 'Expected a directory owned by hanwen, mode 0700 or 0%s: %s\n' "$permitted_mode" "$directory" >&2
    exit 1
  fi
}

private_directory "$project_root/runtime"
private_directory "$project_root/runtime/docker"
for name in run config client tmp xdg-data cache; do
  private_directory "$project_root/runtime/docker/$name"
done
# Docker sets its data-root to 0710; its parent remains private (0700).
private_directory "$project_root/runtime/docker/data" 710

export XDG_RUNTIME_DIR="$project_root/runtime/docker/run"
export XDG_CONFIG_HOME="$project_root/runtime/docker/config"
export XDG_DATA_HOME="$project_root/runtime/docker/xdg-data"
export XDG_CACHE_HOME="$project_root/runtime/docker/cache"
export DOCKER_CONFIG="$project_root/runtime/docker/client"
export TMPDIR="$project_root/runtime/docker/tmp"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export DOCKER_TMPDIR="$project_root/runtime/docker/tmp"

# Leave existing process state in place for inspection; never remove it blindly.
for name in docker.sock dockerd.pid rootlesskit; do
  if [ -e "$XDG_RUNTIME_DIR/$name" ] || [ -L "$XDG_RUNTIME_DIR/$name" ]; then
    printf 'Existing runtime state requires inspection before starting: %s\n' "$XDG_RUNTIME_DIR/$name" >&2
    exit 1
  fi
done

unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
unset _DOCKERD_ROOTLESS_CHILD _DOCKERD_ROOTLESS_SELINUX DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS
export DOCKERD=/usr/bin/dockerd
export DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR="$XDG_RUNTIME_DIR/rootlesskit"
export DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns
export DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=builtin
export DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true

/usr/bin/dockerd --validate --config-file "$project_root/config/docker/daemon.json"
exec /usr/bin/dockerd-rootless.sh --config-file "$project_root/config/docker/daemon.json"
