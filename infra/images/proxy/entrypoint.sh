#!/bin/sh
# Render and start the Seyra proxy. Fails closed on incomplete access configuration
# (validation and rendering: seyra-proxy-render).
set -eu
[ -f /srv/seyra/release/maps/tiles.json ] || { echo "active release map metadata missing" >&2; exit 2; }
mkdir -p /tmp/nginx /var/cache/seyra/tiles
/usr/local/bin/seyra-proxy-render
nginx -t -c /tmp/nginx/nginx.conf
exec nginx -c /tmp/nginx/nginx.conf -g 'daemon off;'
