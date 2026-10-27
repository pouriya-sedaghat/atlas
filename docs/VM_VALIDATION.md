# Owner VM execution evidence

This summarizes the successful terminal transcript supplied by the owner in this conversation on 2026-10-24. It is evidence of that execution, not a claim that a new deployment was executed while packaging the source on 2026-10-26.

| Item | Observed result |
| --- | --- |
| VM address / configured client range | `172.16.20.46` / `172.16.20.0/24` |
| Preparation correction | Applied; its file checksums passed |
| Source checkout verification | Eight pinned upstream checkout heads verified |
| Dependency lock | Written with ten inspected images |
| Image identity checks | All ten observed image IDs matched the generated lock |
| Database initialization | Roles initialized; migration `001_control` applied |
| Owner input | `iran-261017.osm.pbf`, 229845082 bytes as reported by the import admission check |
| Import admission | Passed the configured disk-space check |
| Dataset | `ds-20261017-2fe22e532682` |
| Rendering, routing, geocoder, Overpass and map-style builds | Completed; staging validation reached |
| Real staging providers | PASS: tiles, routing, geocoder, Overpass |
| Activation | Dataset active; all four providers reported its identities |
| HTTP endpoints | PASS: `/`, `/health/live`, `/health/ready`, `/api/v1/map/capabilities`, `/api/docs/`, `/api/docs/json` |
| Swagger document | PASS: includes map operations |
| Map resource smoke | PASS: Persian style, TileJSON and a nonempty center vector tile |

The transcript ends with `HTTP smoke passed`. The reported addresses are `http://172.16.20.46:8080/`, `http://172.16.20.46:8080/api/docs/` and `http://172.16.20.46:8080/api/docs/json`.

These HTTP checks ran from the VM. A separate LAN client request and visual browser verification were not supplied. The result also does not establish data completeness, search quality, routing suitability for every road/profile, load capacity or a production SLA. No owner data, generated secrets, database/index stores or Docker image archives are embedded in this source package.

`validation/owner-vm-evidence.json` records a digest of the supplied transcript and the observed image IDs for provenance. Those observed IDs are evidence only; a fresh installation generates its own operational lock.
