# Seyra Map Services — mobile integration contract (phase 1)

Status: contract and fixtures for the future mobile client. **No mobile SDK or application was built or executed in phase 1.** MapLibre Native rendering of these styles is untested, and native client behaviour is pending validation.

The full schema is in `docs/openapi/map-services-v1.json` (OpenAPI 3, generated from the running API's own validation schemas). The same document is served at `/api/docs/json`, with an offline Swagger UI at `/api/docs/`. Sample request/response pairs captured from the live fixture stack are in `docs/mobile-fixtures/`. The shared web/mobile guide, covering errors, retries, dataset changes, native HTTP versus WebView and the Windows checks, is `docs/CLIENT_INTEGRATION.md` in the client handoff pack.

## Base URL and TLS

- **Base URL:** `https://<host>:<port>`. The default is `https://127.0.0.1:8443`, which is loopback only. For shared or LAN testing the operator configures a LAN name/IP, a CIDR allowlist and a matching certificate (RUNBOOK §6).
- **TLS:** the server presents a certificate from an issuer managed outside the server: the company CA, or the operator's development issuer. The owner supplies the issuer's **public** certificate. The mobile app must trust that CA explicitly: bundle the CA certificate in the app's network-security configuration, or pin its public key. Do not disable certificate or hostname validation. TLS 1.2+ only. Server certificates are at most 825 days, with serverAuth and the exact LAN name or address in the SAN.
- **Native HTTP versus WebView:** native HTTP stacks are not subject to CORS. A WebView or hybrid shell is a browser context: load content from the Seyra origin or keep calls on the native side. `file://` and `null` origins will never be granted.
- **Host header:** requests for an unknown Host name are rejected with HTTP 421. Use one of the configured server names.
- **No authentication in phase 1:** access control is network level only. The future Authentication module will add identity; do not build a client-side substitute.
- **Not exposed:** providers, databases and provider update/admin endpoints are never reachable through the ingress. The client knows only the fixed paths below.

## Conventions

| Topic | Contract |
| --- | --- |
| Coordinates | WGS84 (EPSG:4326). JSON objects use `{ "lon": …, "lat": … }`; GeoJSON positions are `[lon, lat]`. |
| Units | metres (`distance_m`), seconds (`duration_s`), km² (`bbox_area_km2`). `units` is echoed in responses. |
| Languages | `fa` and `en`. Display-name fallback: fa → `name:fa`, `name`, `name:en`; en → `name:en`, `name`, `name:fa`. Names are original OSM text; render them as plain text, never as HTML. |
| Durations | Static estimates (`duration_semantics: "static_estimate"`); no live traffic, no departure time. |
| Route optimality | `route_optimality: "not_guaranteed"`. Optimized visit order is exact only for the modeled directed pair-cost table (`optimization.method = held_karp_directed_pair_costs`), not globally optimal. |
| Dataset version | Operation results, `/capabilities` and the health documents carry `dataset_id` (liveness and ingress-generated errors do not). A client may send `dataset_id` to require that exact release; a different active release returns `409 DATASET_MISMATCH`. |
| Request IDs | Every error has `error.request_id` for support correlation. No request content is logged server-side. |

## Endpoints (prefix `/api/v1/map`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/capabilities` | Active `dataset_id`; map resource paths; supported routing cells; limits; languages; providers. Call it at start and after any 409/503. |
| GET | `/health` | Per-provider readiness detail (always 200). `/health/ready` (no prefix) returns 503 unless ready. |
| GET | `/search?q=&lang=&limit=&bias_lon=&bias_lat=&bbox=` | Forward geocoding. `q` holds at most 256 code points; `limit` is 1–20. |
| GET | `/autocomplete?q=&lang=&limit=` | Type-ahead; same schema as search. |
| GET | `/reverse?lon=&lat=&lang=&limit=&radius_m=` | Reverse geocoding; `radius_m` ≤ 5000. `result_status: "no_results"` is a normal 200. |
| POST | `/route` | `profile` (car / pedestrian / motorcycle), `objective` (time / distance), `order` (ordered / optimized), `points[]` with unique ids, `alternatives` (0–2, ordered two-point only). |
| POST | `/proximity` | Rank only the supplied candidates (≤ 50). Requires an explicit `metric` (straight_line / road_distance / travel_time) and `direction` (origin_to_candidate / candidate_to_origin). Road metrics require `profile`. |
| GET | `/pois?bbox=&preset=` or `&key=&value=` | Bounded POI presets: bbox ≤ 100 km², `limit` ≤ 200, `truncated` flag. Presets: hospitals, pharmacies, police, fire_stations, fuel, parking, schools, food. |

Routing support table (also returned by `/capabilities`):

| order | points | alternatives |
| --- | --- | --- |
| ordered | 2 | 0–2 additional routes (the provider may return fewer) |
| ordered | 3–25 | 0 (multipoint alternatives → 422 `UNSUPPORTED_COMBINATION`) |
| optimized | 2 | 0 (input order is returned) |
| optimized | 3–10 | 0; first and last points fixed; `visit_order` maps back to `input_index` |

`date_time` and `live_traffic` are always rejected with 422 `UNSUPPORTED_COMBINATION`.

## Errors

Body: `{ "error": { "code", "message", "request_id", "provider"?, "dataset_id"?, "details"? } }`. The HTTP status follows the code:

| Status | Codes | Client action |
| --- | --- | --- |
| 400 | INVALID_REQUEST, QUERY_TOO_LONG, LIMIT_EXCEEDED, BBOX_TOO_LARGE, UNKNOWN_PRESET | Fix the request; do not retry unchanged. |
| 404 | NOT_FOUND | Unknown resource path. |
| 409 | DATASET_MISMATCH | Reload `/capabilities` and the style; drop cached results tied to the old `dataset_id`. |
| 413 | PAYLOAD_TOO_LARGE | Request body above 64 KB. |
| 422 | UNSUPPORTED_COMBINATION, NO_ROUTE, POINT_NOT_ROUTABLE | Show the reason. NO_ROUTE is a real "no path", not a server fault. |
| 499 | CANCELLED | Client went away. |
| 502 | PROVIDER_ERROR | Retry later. |
| 503 | OVERLOADED, MAINTENANCE, PROVIDER_UNAVAILABLE, PROVIDER_REVISION_MISMATCH | Back off and retry. MAINTENANCE occurs during a release cutover (tens of seconds). |
| 504 | PROVIDER_TIMEOUT, DEADLINE_EXCEEDED | Retry with backoff; consider a smaller request. |

During a cutover the ingress may refuse connections briefly while the proxy restarts. Treat connection errors as transient and show a "server unavailable" state, as the web client does. The server never substitutes fake or empty success for a missing provider.

## Map style and assets

All paths are dataset scoped and same-origin. `/capabilities` returns them, for example:

```
/maps/<dataset_id>/tiles.json                 TileJSON 3.0.0 (bounds, center, vector_layers)
/maps/<dataset_id>/tiles/{z}/{x}/{y}.pbf      MVT, native zoom 0–16; overzoom above 16; 204 = empty tile
/maps/<dataset_id>/styles/{light|dark}-{fa|en}.json
/maps/<dataset_id>/fonts/{fontstack}/{range}.pbf   SDF glyphs, all 256 ranges, "Vazirmatn Regular"/"Vazirmatn Bold"
/maps/<dataset_id>/fonts/files/Vazirmatn-{Regular|Bold}.woff2
/maps/<dataset_id>/sprites/{light|dark}[@2x].{json|png}
```

- Styles validate against the MapLibre style specification (unit tests and live checks). Their absolute URLs are produced by the server from the request host, so the URLs match the host name the client used.
- The styles include a GL JS `font-faces` block (MapLibre GL JS 6 native Arabic-script shaping with local woff2). Clients that do not support `font-faces`, such as MapLibre Native, fall back to the SDF glyph PBFs, which cover Persian/Arabic letters, digits and presentation forms. **MapLibre Native rendering and its Arabic shaping and bidi behaviour with these assets have not been tested**: pending mobile SDK validation.
- No RTL-text plugin, CDN, remote font or remote sprite is used. The client must not add any.
- Attribution "© OpenStreetMap contributors" must remain visible (ODbL).
- Old `dataset_id` paths return 404 `DATASET_MISMATCH` after a cutover; reload the style.

## Fixtures for client development

`docs/mobile-fixtures/` contains real request/response pairs recorded from the synthetic fixture release; see its README. They are synthetic data near 0°E 0°N, not Iranian geography, and are meant for contract tests and UI development only.

## Pending (not executed in phase 1)

- Android/iOS SDK integration and MapLibre Native rendering of fa/en labels.
- CA trust and pinning behaviour on target devices.
- Offline/flaky-network behaviour on devices.
- Accessibility review on mobile.
- Real-dataset latency and payload sizes.
