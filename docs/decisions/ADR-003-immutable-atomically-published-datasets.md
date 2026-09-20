# ADR-003: Immutable, atomically published datasets

- Status: accepted
- Date: 2026-09-20

## Context

An import takes time. During that time the server is already accepting
requests. A reader must never see a half-built dataset: features without their
neighbours, bounds covering only the first few roads, or statistics that are
still counting.

Re-importing is also a normal operation, and a re-import can fail. A server
that had good data five minutes ago should not lose it because the operator
pointed `--source` at a broken file.

## Decision

Split the mutable and immutable representations.

`DatasetBuilder` is the only mutable form. It implements `FeatureSink`, so the
importer streams into it, and it is consumed by `finish()`, which sorts
features by id and produces an immutable `Dataset`. Nothing mutates a `Dataset`
after that point.

`DatasetRegistry` holds the active dataset behind an `RwLock<Option<Arc<Dataset>>>`.
Publication swaps the `Arc` in one step. `snapshot()` clones the `Arc`, so a
query that started against dataset A keeps working against dataset A even if B
is published mid-scan.

A failed import calls `mark_failed`, which records a sanitised failure and
leaves the active dataset untouched. The registry reports `Ready` whenever a
dataset is queryable, regardless of what the most recent import did.

## Consequences

- Readiness is a real answer, not a guess: `/health/ready` succeeds exactly
  when a query would succeed.
- Two datasets can briefly be alive at once, held by in-flight snapshots. For
  the data sizes in this milestone that is cheap; for large extracts it doubles
  peak memory during a swap, which is a known and accepted trade.
- Deterministic ordering comes for free: features are sorted once at
  `finish()`, so every query over the same dataset returns the same order.
