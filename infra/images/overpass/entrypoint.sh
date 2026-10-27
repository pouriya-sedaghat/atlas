#!/usr/bin/env bash
# Seyra Overpass entrypoint. Commands:
#   serve                       dispatcher (bounded) + fcgiwrap + nginx on :8080
#   import <db_dir> <version>   build a NEW base database from OSM XML on stdin
set -euo pipefail
cmd="${1:-serve}"
case "$cmd" in
  import)
    db_dir="${2:?db dir required}"; version="${3:?version label required}"
    if [ -e "$db_dir" ] && [ -n "$(ls -A "$db_dir" 2>/dev/null)" ]; then
      echo "refusing to import into non-empty directory: $db_dir" >&2; exit 2
    fi
    mkdir -p "$db_dir"
    # No --meta / --keep-attic: current geometry/tags only, no contributor or history data.
    update_database --db-dir="$db_dir/" --version="$version" --compression-method=lz4 \
      --map-compression-method=lz4 --flush-size="${OVERPASS_FLUSH_SIZE:-8}"
    ;;
  serve)
    # Fixed paths: the nginx fastcgi_param entries pass the same values to the CGI programs.
    db_dir=/data/overpass/db
    sock_dir=/run/overpass
    test -f "$db_dir/osm_base_version" || { echo "missing Overpass base database in $db_dir" >&2; exit 3; }
    mkdir -p "$sock_dir"
    # --space (bytes) / --time (seconds) bound the total resources the dispatcher grants to
    # concurrently running queries; every query also carries its own [timeout] and [maxsize].
    # The gateway is the only client, so every user shares one client address. Per-address
    # controls are therefore off: --rate-limit=0 (the dispatcher otherwise keeps a finished
    # query's slot occupied for a cool-down and blocks the next one up to 15 s) and duplicate
    # blocking off (it rejects any identical query for its whole timeout window, e.g. two users
    # asking for the same preset). The gateway bounds concurrency and queue length itself.
    dispatcher --osm-base --db-dir="$db_dir/" --socket-dir="$sock_dir/" \
      --space="${OVERPASS_SPACE_BYTES:-1073741824}" --time="${OVERPASS_TIME_UNITS:-262144}" \
      --rate-limit="${OVERPASS_RATE_LIMIT:-0}" --allow-duplicate-queries=yes &
    disp=$!
    for _ in $(seq 1 50); do [ -S "$sock_dir/osm3s_osm_base" ] && break; sleep 0.2; done
    [ -S "$sock_dir/osm3s_osm_base" ] || { echo "dispatcher did not start" >&2; exit 4; }
    fcgiwrap -c 2 -s unix:/tmp/fcgiwrap.sock &
    fcg=$!
    nginx -c /etc/seyra/overpass-nginx.conf -g 'daemon off;' &
    ngx=$!
    trap 'kill -TERM $ngx $fcg 2>/dev/null; dispatcher --osm-base --terminate --socket-dir="$sock_dir/" 2>/dev/null || kill -TERM $disp; wait' TERM INT
    wait -n $disp $fcg $ngx
    echo "an Overpass serving process exited; stopping container" >&2
    kill -TERM $ngx $fcg $disp 2>/dev/null || true
    exit 1
    ;;
  *) exec "$@" ;;
esac
