# Atlas

[Stage six](docs/ATLAS-STAGE-6-FA.md) installs paused admission with a mandatory live observer,
tests observer death and keeps recovery independent of the collector. The longer shared-disk
experiment failed; full Iran import and publication remain blocked. The corrected observer
rejects late HTTP 200 responses as well as transport/content errors.

This repository preserves the supplied Seyra demo and develops its versioned map-data replacement.
The first implementation stage adds a complete primitive archive, an isolated Martin/PostGIS
comparison lab, and a transactional release/session/retention registry. See
[stage one evidence](docs/ATLAS-STAGE-1-FA.md),
[lab instructions](infra/atlas/lab/README.md), and the
[architecture](docs/seyra-release-architecture-fa.md).

The legacy runtime below still uses Tegola. The new release registry is not yet connected to
the public gateway or web client. All-engine builds and production cutover remain subsequent
stages; this branch must not be described as the completed migration.

Stage two adds [durable private PBF intake and source acceptance](docs/ATLAS-STAGE-2-FA.md),
with [operator instructions](infra/atlas/intake/README.md). It validates/signs ordinary inputs,
holds anomalies for exact-report review, and runs independently of the tile services. The Iran
source was accepted only as an experimental source/baseline after explicit human anomaly review;
receipts enforce `experimental_source_only`. All-engine builds and public release cutover are still outstanding.

Stage three adds [verified experimental PostGIS/Martin candidates](docs/ATLAS-STAGE-3-FA.md)
and [builder operation](infra/atlas/builder/README.md): a separate data cluster and database per
attempt, canonical raw verification, explicit catalog outcomes and decoded tile checks. Candidate
manifests remain non-publishable while required engines and release/session integration are missing.
The rejected shared-cluster experiment and the isolated profile's results are retained in the evidence.

Stage four adds [independent feature families and filtered serving snapshots](docs/ATLAS-STAGE-4-FA.md)
under [catalog 2.0.0](infra/atlas/catalog-v2.md). The retained raw/render data and physically
filtered, spatially indexed tile snapshots have separate roles. Real-source diagnostics,
unsupported semantics and incomplete relation geometry remain reviewable. These changes do
not publish a release or connect the legacy web client. The latest Iran attempt was rejected
after one old-serving timeout; a later single-scan QA improvement passed separate PostgreSQL
and fictional-data tests, but has not repeated the full-country acceptance test.

[Stage five](docs/ATLAS-STAGE-5-FA.md) adds durable serving-guard incidents and verified recovery.
It passed separate PostgreSQL, fictional systemd/Docker and bounded read-only I/O checks;
the existing Iran runtime was not upgraded and full-country acceptance remains open.

## Original Seyra VM demo

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
