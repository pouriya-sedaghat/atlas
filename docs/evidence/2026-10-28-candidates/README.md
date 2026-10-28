# Experimental candidate evidence, 2026-10-28

These are reviewed exports from the Ubuntu/Docker laboratory. They contain fictional fault
fixtures and the operator-supplied Iran PBF's results. They do not authorize production
publication. See [the Persian stage report](../../ATLAS-STAGE-3-FA.md) and
[the builder runbook](../../../infra/atlas/builder/README.md).

The source is `iran-261025.osm.pbf`, 229,921,859 bytes, SHA-256
`a3c61d35b010d4a474c1eabdef9500339472743423d7bb895b16241c08eb4065`.
Its Geofabrik provenance is operator-declared; an independent publisher signature was not
verified. Human approval covered **experimental source acceptance and the initial baseline**.
Source receipts and component manifests enforce that limited scope.

## Files and scope

- `iran-source-acceptance.json`, `iran-source-bundle.sigstore.json`, `lab-source-public-key.pub`
  and `iran-intake-audit.json`: byte-identical source acceptance/audit evidence from stage two.
  The key is the laboratory's local test key, shared by the fixtures; it is not Geofabrik's key.
- `iran-job.json`, `iran-manifest.json`: terminal control record, attempts, actual target
  cluster/volume identity and content-addressed component manifest. The manifest always records
  `publishable:false`, `map_release_ready:false` and missing search/routing/POI/assets.
- `iran-raw-roundtrip.json`: all nodes, ways and relations checked against the independent audit,
  including tags, available metadata and ordered references/members.
- `iran-feature-coverage.json`: every tagged object's outcome, row/insertion accounting,
  layer geometry integrity, top uncatalogued key groups, missing relation members and ancestor
  impact. The top-key/examples lists are bounded; the outcome accounting covers all tagged objects.
  `geographic_truth_verified:false` is intentional.
- `iran-tile-parity.json`: decoded SQL/Martin comparison, two rounds at 24 site/zoom combinations,
  with cold SQL warmup recorded separately. `same-input-tile-parity.json` additionally compares
  the previous laboratory Martin built from the same PBF. Parity is not independent ground truth.
- `isolated-serving-baseline.json`: 24 checks on the previous Martin at rest before starting.
  `isolated-serving-probe.json.gz`: the complete unmodified observer output during import and QA.
  Resource samples are approximately every 15 seconds, not exact peaks; block-device counters
  can account for the same I/O at physical and logical levels and must not be summed blindly.
  This is a private lab tile probe, not browser/gateway/session, switch, failure-tolerance or capacity proof.
- `rejected-shared-cluster-job.json`, `rejected-shared-cluster-serving-probe.json.gz`: the rejected
  earlier architecture, with two expired import attempts and 19 errors in 329 serving requests.
  It produced no manifest or map publication. Failed partial databases were retained, not silently deleted.
- `fixture-builder-*`: actual Docker/osm2pgsql/PostGIS/Martin E2E evidence, including raw,
  geometry-outcome and tile reports for both healthy and deliberately problematic fictional data.
- `fixture-intake-*`: fresh intake/Cosign fault checks with the current collector and explicitly
  trusted previous collector. `pg-tests.txt`: 16 intake and 10 builder tests on real PostgreSQL.
- `cancellation-baseline.json`, `cancellation-check.json`: on a disposable fixture, the default
  PostgreSQL connection setting left a query active after client closure; the candidate cluster's
  persistent `1s` connection check removed a disconnected 60-second query backend in about two seconds.
- `import-duration-summary.json`, `stage-timeline.json`, `operation-context.json`,
  `verification-summary.json`: sanitized execution/configuration context and the distinction
  between completed component checks and unfinished whole-platform work.
- `SHA256SUMS`: hashes of the delivered evidence bytes. Gzip files preserve the original
  full JSON reports without editing their samples; the summary also records uncompressed hashes.

Credentials, private signing material, DSNs, pgpass, Martin configuration, private failure logs,
node_modules and the PBF itself are excluded. A local key on the shared trusted Unix owner is
not a production KMS or independent reviewer/signer identity boundary. Full PostgreSQL GUC
drift enforcement, database-backend reaping, reboot/restore, partition/load tests, all-engine
readiness, release/session integration and actual data GC remain subsequent work.

## Rechecking

From the repository root, using Node 24.21.0 (no npm dependencies are needed for this checker):

```sh
node tools/verify-candidate-evidence.mjs
cd docs/evidence/2026-10-28-candidates
sha256sum -c SHA256SUMS
```

The Node checker validates recorded hash bindings/accounting and expected experimental scope;
it does not perform a database rebuild or independently establish geographic/publisher truth.
Source signature verification can be repeated with the pinned Cosign 3.1.4 laboratory profile:

```sh
cosign verify-blob --key lab-source-public-key.pub \
  --bundle iran-source-bundle.sigstore.json --offline --insecure-ignore-tlog=true \
  iran-source-acceptance.json
```

The trusted laboratory public-key SHA-256 is
`184d5e57ddbd6e607eaa3299e74f08fc9143e94408b28a90e2bfe0ef5f19256d`.
Bundling a key does not establish external trust in it. This offline profile has no transparency-log
assurance. The running builder separately verified the signed source before allocation and again
before sealing its component; a complete map release has not been signed or published.
