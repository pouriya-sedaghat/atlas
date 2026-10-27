# Stage-one evidence

These are selected non-secret reports from the isolated Iran experiment on 2026-10-27.
They contain no PBF, credentials, private configuration, SSH key or database backup.
OSM-derived statistics refer to data from © OpenStreetMap contributors, supplied by the user
as a Geofabrik Iran extract. See [the stage report](../../ATLAS-STAGE-1-FA.md) for conclusions
and limits; none of these files authorizes production publication.

| Report | Meaning |
|---|---|
| input-audit-summary.json | Complete two-pass source inventory/reference audit, with tag-key inventory and example IDs omitted from this summary |
| import-report.json | Initial real import/count checks; its semantic flag remains false because the separate full roundtrip follows this step |
| raw-roundtrip.json | Every raw primitive reconstructed from the restored database; all counts and semantic digests match the source |
| fixture-roundtrip.json / selftest.json | Final raw definition tested with unknown tags, Unicode, metadata, empty structures and ordered/repeated members |
| logical-restore.json | Logical backup/restore completed into a fresh volume; original volume retained |
| tile-parity.json | 72 comparisons over three rounds; decoded content matches direct SQL, Martin and pg_tileserv |
| catalog-inspection.json | Existing rendered geometry validity and incomplete-relation groups; database size captured before index optimization |
| index-optimization.json | Duplicate indexes removed without row changes; before/after database sizes |
| benchmark.json | 48 warm-up and 192 measured requests, alternating engine order, concurrency four; sample only |
| lab-context.json | Observed VM resources, runtime limits and absence of published service ports |

The initial import used the older database image. Its GEOS simplifier produced unstable
Multi geometry in a tile comparison. The corrected comparison uses PostgreSQL 17.11,
PostGIS 3.6.4 and GEOS 3.14.1 after logical restore and full raw reverification.
Import timing is not a fresh measurement of the final optimized definition.

Semantic equality is relative to the received PBF. It does not prove geographic truth,
publisher authenticity, complete rendering support, production capacity or all-engine
publication without interruption. Signatures and automatic intake are subsequent work.
