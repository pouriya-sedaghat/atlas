# Mobile contract fixtures

Real request/response pairs recorded from the running Seyra stack with the **synthetic** fixture release
(`fixtures/osm/synthetic-v1.osm`, fictional objects near 0°E 0°N). Regenerate with
`tests/integration/capture-mobile-fixtures.mjs`. `request_id` values are replaced by a placeholder.
Dataset ids and provider identities are those of the recording run.

| File | Request | Status |
| --- | --- | --- |
| `capabilities.json` | GET `/api/v1/map/capabilities` | 200 |
| `health.json` | GET `/api/v1/map/health` | 200 |
| `search-fa.json` | GET `/api/v1/map/search` | 200 |
| `search-en.json` | GET `/api/v1/map/search` | 200 |
| `autocomplete-fa.json` | GET `/api/v1/map/autocomplete` | 200 |
| `reverse-fa.json` | GET `/api/v1/map/reverse` | 200 |
| `route-ordered-alternatives.json` | POST `/api/v1/map/route` | 200 |
| `route-optimized.json` | POST `/api/v1/map/route` | 200 |
| `proximity-road.json` | POST `/api/v1/map/proximity` | 200 |
| `pois-preset.json` | GET `/api/v1/map/pois` | 200 |
| `error-unsupported-combination.json` | POST `/api/v1/map/route` | 422 |
| `error-no-route.json` | POST `/api/v1/map/route` | 422 |
| `error-bbox-too-large.json` | GET `/api/v1/map/pois` | 400 |
| `error-dataset-mismatch.json` | GET `/api/v1/map/search` | 409 |
