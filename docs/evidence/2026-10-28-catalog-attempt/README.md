# Catalog 2: rejected Iran attempt and separate software checks

The latest full-country job FAILED. Its old-serving observer recorded 5881 HTTP samples,
including one timeout. No successful manifest exists. Raw roundtrip passed for all 30,500,932
primitives; feature coverage and tile QA did not finish. The two original collector reports
remain byte-exact (gzip only); the later 24 healthy idle requests do not negate the timeout.

`latest-*` describes that failed attempt. `optimization-*` describes a later, separate
single-scan QA change tested on disposable PostgreSQL/fictional PBFs. It was NOT used in
the failed Iran import. The earlier fixture reports, full-source diagnostic and rejected
attempts are retained with their original identities; none promotes failed data to success.

`latest-idle-health-initial-count-check.*` preserves an initial harness count mismatch:
deduplicating tile coordinates yielded 23 cases because two sites share a low-zoom tile.
All 23 HTTP requests succeeded. The corrected harness keeps all 24 site/zoom cases.

`SHA256SUMS` verifies stored bytes. The offline checker validates recorded bindings and
failure barriers; it is not an independent audit of geographic truth, a database rebuild,
a publisher-signature verification, or production approval. Full report: ../../ATLAS-STAGE-4-FA.md.
