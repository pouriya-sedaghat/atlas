# Durable guard and bounded I/O evidence

All mutation/fault tests use disposable fictional-data control databases and a uniquely named
systemd test unit. `guard-fault-probe.json` intentionally contains one HTTP 503; it is not an
old-map outage. `guard-incidents.json` retains exact evidence text and actual committed incident
and acknowledgement rows. The guard does not retry or promote the failed candidate.

The separate bounded I/O experiment reads an already failed Iran database for at most twenty
seconds. It reached SQLSTATE 57014 at that deliberate cap; 48 old-serving requests succeeded.
This short experiment neither repairs the historical timeout nor establishes capacity/root cause.

The pre-fix PostgreSQL log preserves one fixture lease-expiry failure (29 passed/1 failed).
The fixture lease was changed from one to ten seconds; expiry tests still explicitly expire the
server-side deadline, while production HTTP and SQL limits remain unchanged. A later harness
assumption that a unit had already enqueued a second job was replaced by explicit enqueueing.
The final reports are from fresh fixtures after those harness corrections.

The old Iran runtime was not upgraded and no full import or operational publication occurred.
Full report: ../../ATLAS-STAGE-5-FA.md. SHA256SUMS covers stored bytes; the offline verifier checks
recorded bindings, not independent geographic truth or hardware isolation.
