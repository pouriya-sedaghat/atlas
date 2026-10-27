# Seyra HTTP VM demo runbook

Use [the Persian runbook](README-FA.md) for preparation, real OSM input, synthetic fixture, LAN access, smoke checks, start/stop, logs and optional offline export.

Source: `pouriya-sedaghat/seyra`, branch `feat/map-services-v1`, commit `80935b42a9b5616c21df7483412c5fb2ccbc6df8`.

This extracted variant uses HTTP on host port 8080 and requires no CA, TLS certificate or browser trust installation. The provider/API/web implementations are retained. The CA/PKI tools and original handoff plans are omitted. The HTTP boundary, operations startup checks and Docker resource names were adapted locally. See `SOURCE.json` for provenance and `VALIDATION.md` for what was actually tested.

The ZIP is source plus preparation scripts. It contains no Docker image archives or real OSM dataset. Run `bash scripts/prepare.sh` on an Internet-connected linux/amd64 Docker host before `bash demo.sh --pbf /path/to/map.osm.pbf`. Use a fresh state directory. The synthetic fixture is fictional and is explicitly selected with `--synthetic`.
