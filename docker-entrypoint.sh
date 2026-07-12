#!/bin/sh
# Runs as root so it can fix ownership of the mounted /data volume, then drops
# to the unprivileged 'node' user before starting the server.
#
# A named Docker volume keeps whatever ownership it already had on disk; it is
# NOT reset by the image's own `chown` layer. Volumes created by older images
# (which ran as root) are owned by root, so the app — now running as 'node' —
# would fail with "attempt to write a readonly database" without this fixup.
set -eu

chown -R node:node "${SYNC_DB_DIR:-/data}"

exec su-exec node "$@"
