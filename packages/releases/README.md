# Release control foundation

`ReleaseRegistry` owns a small PostgreSQL control schema, separate from imported map databases.
Apply `src/schema.sql` as the control-schema owner. The library is not an HTTP service or an
authentication boundary. The current demo gateway/web client do not consume it yet.

Publication, session admission/renewal and retirement share a short transaction-scoped advisory
lock. Publication requires the observed generation, so two publishers cannot silently overwrite
one another. Release IDs, source/manifest hashes and endpoint origins are immutable after
registration. Only a trusted controller may call `registerReady` after verifying signatures,
artifact identities, quality gates and every engine's health. Supplying a hash is not verification.

New sessions select the current release. Existing opaque sessions select the release recorded
at creation. Only token hashes are stored. Do not log tokens; use a secure transport and an
appropriate same-origin session mechanism in the eventual gateway. Renewal cannot exceed the
absolute lifetime. Map assets, tiles and all API operations must use the same session release.

For each gateway operation, call `acquireRequest(releaseId,token)` before dispatch and
`releaseRequest(id)` in a finally block after the upstream operation has ended. Use only the
returned endpoint set. Enforce a hard end-to-end deadline shorter than the lease, including
queueing, retries and provider/database execution; refuse to dispatch after that deadline.
Cancellation and physical service draining must actually work before this scheme is used for
storage reclamation. An expired lease alone does not stop a process or an engine query.

Retirement protects current/previous defaults, the latest successful releases, valid sessions,
unexpired requests, manual pins and build references. `retire` closes admission, then
`beginDeletion` requires the grace period and produces a one-use state-transition token.
`finishDeletion` leaves a tombstone. The physical deletion/recovery worker, bounded lease-table
cleanup, administrative authorization and operational audit retention are subsequent work.
Do not substitute an arbitrary filesystem delete for that worker.

The integration suite requires a disposable database named `atlas_test*`; it refuses to truncate
any other database. It tests concurrent publication, independent old/new provider origins,
absolute expiry, rollback, retention references and stale deletion tokens against real PostgreSQL.
These are control-transaction tests, not end-to-end HTTP availability or load tests.
