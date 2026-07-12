#!/bin/sh

set -eu

export VITE_ALLOWED_HOSTS="${VITE_ALLOWED_HOSTS:-*}"

sync_pid=''
web_pid=''

terminate() {
  [ -n "$sync_pid" ] && kill -TERM "$sync_pid" 2>/dev/null || true
  [ -n "$web_pid" ] && kill -TERM "$web_pid" 2>/dev/null || true
}
trap terminate TERM INT

npm run sync-server &
sync_pid=$!

npm run preview &
web_pid=$!

if wait -n 2>/dev/null; then
  status=0
else
  status=$?
fi

terminate
wait || true
exit "$status"
