#!/bin/sh
set -eu
umask 077

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
data=${SAURY_DATA:-"${XDG_DATA_HOME:-"$HOME/.local/share"}/saury"}
mkdir -p "$data"
data=$(CDPATH= cd -- "$data" && pwd)
preload="$root/dist/saury.so:libgnutls.so.30"

exec flock --nonblock --no-fork "$data/instance.lock" \
  env SAURY_DATA="$data" LD_PRELOAD="$preload" \
  node "$root/dist/main.js" "$@"
