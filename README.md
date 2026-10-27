# Seyra VM demo

[راهنمای فارسی اجرا روی VM](docs/README-FA.md)

MapLibre web client, Swagger/OpenAPI, Fastify API and real Tegola/PostGIS, Valhalla, Photon and Overpass providers, extracted for a temporary Ubuntu/Debian linux/amd64 VM demonstration.

Complete corrected source edition, packaged 2026-10-26. The preparation fix is already integrated; no separate patch ZIP is needed. [Release notes](docs/RELEASE-2026-10-26-FA.md).

```bash
bash scripts/prepare.sh
bash demo.sh --pbf /absolute/path/to/map.osm.pbf
# Or explicitly choose fictional fixture data:
# bash demo.sh --synthetic
```

Map: `http://127.0.0.1:8080/` — Swagger: `http://127.0.0.1:8080/api/docs/`

No application CA or TLS setup. Internet is needed for initial image preparation. Docker image archives and real map data are not included. The source GitHub repository was read only. The owner's supplied VM transcript confirms successful preparation, real-data import, activation and HTTP smoke checks; see `docs/VM_VALIDATION.md` and `docs/VALIDATION.md`. Visual browser and separate-client LAN verification have not been supplied.
