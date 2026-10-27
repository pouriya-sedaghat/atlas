#!/usr/bin/env bash
# Real HTTP/tiles checks, intended to run on the prepared VM or an allowed LAN client.
set -euo pipefail
base="${1:-http://127.0.0.1:8080}"
base="${base%/}"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
for path in / /health/live /health/ready /api/v1/map/capabilities /api/docs/ /api/docs/json; do
  curl --fail --silent --show-error --max-time 30 "$base$path" -o "$tmp/body"
  echo "PASS $path"
done
curl --fail --silent --show-error --max-time 30 "$base/api/docs/json" -o "$tmp/openapi.json"
python3 - "$tmp/openapi.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
for route in ['search', 'reverse', 'route', 'proximity', 'pois']:
    assert '/api/v1/map/' + route in doc['paths'], route
print('PASS Swagger includes map operations')
PY
curl --fail --silent --show-error --max-time 30 "$base/api/v1/map/capabilities" -o "$tmp/caps.json"
python3 - "$tmp/caps.json" "$base" "$tmp" <<'PY'
import json, sys, urllib.request, urllib.parse, math
caps = json.load(open(sys.argv[1])); base = sys.argv[2]
style_url = urllib.parse.urljoin(base, caps['map']['styles']['light_fa'])
with urllib.request.urlopen(style_url, timeout=30) as r: style = json.load(r)
assert style['version'] == 8
assert not any('https://' in str(v) and 'openstreetmap.org/copyright' not in str(v) for k, v in style.items() if k in ['glyphs','sprite'])
sources = [v for v in style['sources'].values() if v.get('type') == 'vector']
assert sources, 'No vector source'
source = sources[0]
if 'url' in source:
    with urllib.request.urlopen(urllib.parse.urljoin(base, source['url']), timeout=30) as r: tilejson = json.load(r)
else: tilejson = source
lon, lat = tilejson.get('center', [53.5, 32.5])[:2]
z = min(14, tilejson.get('maxzoom', 16)); n = 2 ** z
x = int((lon + 180) / 360 * n)
y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
url = urllib.parse.urljoin(base, tilejson['tiles'][0].replace('{z}',str(z)).replace('{x}',str(x)).replace('{y}',str(y)))
with urllib.request.urlopen(url, timeout=30) as r:
    data = r.read()
    assert r.status == 200 and data, 'Center tile empty; inspect coverage before presenting'
print('PASS Persian style, TileJSON and nonempty center vector tile')
PY
echo 'HTTP smoke passed. Visually check the map and exercise search/routing in the browser before presentation.'
