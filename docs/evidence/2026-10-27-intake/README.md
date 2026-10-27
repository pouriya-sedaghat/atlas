# Intake evidence, 2026-10-27

These are selected non-secret artifacts from the authorized isolated Ubuntu VM.

- `iran-intake-audit.json`: complete report from the resource-limited parser; its exact bytes
  hash to `9ff866f094123cdf807782d56e215fb5ea856a3da6dd3df79827eab623b68bc7`.
- `iran-intake-decision.json`: original validation/attempt identity and `review_required` state
  before human review. `iran-accepted-state.json` records subsequent explicit human approval
  for the experimental source and initial baseline, including report/decision binding.
- `iran-source-acceptance.json`, `iran-source-bundle.sigstore.json`: exact signed Iran source
  receipt and bundle. Its required scope is `experimental_source_only`; production publication
  was not approved. The source deficiencies and unverified publisher signature remain recorded.
- `e2e-report.json`: eleven passing real Docker/PostgreSQL/Cosign fault scenarios on fictional
  inputs in a separate disposable database, including a previous collector build.
- `fixture-audit.json`, `fixture-receipt.json`, `fixture-bundle.sigstore.json`,
  `fixture-public-key.pub`: original report, exact signed payload, bundle and public test PEM.
  Verify the exact payload bytes; reformatting JSON changes what was signed. The public key
  hashes to `184d5e57ddbd6e607eaa3299e74f08fc9143e94408b28a90e2bfe0ef5f19256d`.
- `previous-collector-receipt.json`: human-readable copy demonstrating separate collector/signer
  lineage; reformatted for inspection, not the exact signed payload artifact for offline verification.
- `pg-tests.txt`: final actual PostgreSQL run, 11 package tests passed (5 policy + 6 integration).
- `tile-probe.json`: 120 successful internal Martin requests while the Iran audit was active.
  This does not test publication, public traffic or browser session consistency.
- `operation-check.json`: enabled user units/linger and recovery from killing an idle coordinator.
  Tile containers were not restarted. Whole-host recovery is not demonstrated.

With the pinned Cosign binary from `infra/atlas/intake/tools.lock.json`, this verifies the fixture:

```sh
cosign verify-blob --offline --insecure-ignore-tlog=true \
  --key fixture-public-key.pub --bundle fixture-bundle.sigstore.json fixture-receipt.json
cosign verify-blob --offline --insecure-ignore-tlog=true \
  --key fixture-public-key.pub --bundle iran-source-bundle.sigstore.json iran-source-acceptance.json
```

The pinned public key is the trust root of this offline local-key lab profile; transparency-log,
publisher-signature and production-key assurances are not claimed. No private key, password,
DSN, SSH credential, PBF or production approval is included.
