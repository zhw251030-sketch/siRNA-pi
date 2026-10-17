#!/bin/sh
# Read-only prerequisite check. Does not install packages or start Docker.
set -eu

project_root=/home/hanwen/Project/project/siNRA-pi
failed=0
fail() { printf 'MISSING: %s\n' "$1"; failed=1; }

if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'Run this check on the Linux project server.' >&2
  exit 2
fi
if [ "$(id -un)" != hanwen ] || [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' 'Run as hanwen, without sudo.' >&2
  exit 2
fi
if [ ! -d "$project_root" ] || [ "$(realpath "$project_root")" != "$project_root" ]; then
  printf '%s\n' 'The expected project directory is missing or redirected.' >&2
  exit 2
fi

printf 'Project: %s\n' "$project_root"
for program in docker dockerd dockerd-rootless.sh rootlesskit slirp4netns newuidmap newgidmap unshare; do
  if command -v "$program" >/dev/null 2>&1; then
    printf 'FOUND: %s\n' "$program"
  else
    fail "$program"
  fi
done

account_uid=$(id -u)
for mapping_file in /etc/subuid /etc/subgid; do
  if awk -F: -v account_uid="$account_uid" '
    ($1 == "hanwen" || $1 == account_uid) && $3 >= 65536 { found = 1 }
    END { exit !found }
  ' "$mapping_file"; then
    printf 'FOUND: subordinate IDs in %s\n' "$mapping_file"
  else
    fail "65536 subordinate IDs in $mapping_file"
  fi
done

if unshare -Ur true; then
  printf '%s\n' 'PASS: unprivileged user namespace'
else
  fail 'unprivileged user namespace'
fi
if filesystem_type=$(stat -f -c %T "$project_root"); then
  printf 'Filesystem: %s\n' "$filesystem_type"
  case "$filesystem_type" in nfs*) fail 'Docker data-root must not use NFS' ;; esac
else
  fail 'filesystem inspection'
fi

if [ "$failed" -ne 0 ]; then
  printf '%s\n' 'BLOCKED: prerequisites are missing; no installation or startup attempted.'
  exit 1
fi
printf '%s\n' 'Prerequisite checks passed. Actual Docker startup and container execution still need verification.'
