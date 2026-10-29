# Paused admission and a rejected longer I/O experiment

This is private laboratory evidence exported through a whitelist. It contains no DSNs,
credentials, source PBF or private configs. It is not a signed independent availability audit.
See [the Persian report](../../ATLAS-STAGE-6-FA.md) for scope and next steps.

`before-control` / `after-control` preserve old job identities and add one unstarted Iran job.
`main-pipeline`, `main-state`, `postfix-main-state`, `deployment`, `data-profile`, `readiness`
and `final-health` describe the installed, paused builder. The last is a separate post-load
health check, not the missing recovery samples of the aborted experiment.

`queue-tests` + `pg-tests` record 38 PostgreSQL-environment builder tests. Four `fixture-*-manifest`
files and their hash-linked QA reports record the earlier ten fictional core scenarios;
their explicit admission bypass is not mandatory-watch evidence. `guard-fault-tests` and
`watch-death-test` precede the deadline fix. `postfix-guard-tests` / probe and
`postfix-watch-death` repeat guard/observer-death checks with the corrected observer.
SIGKILL collectors have no final report; totals remain null.

`long-io.json` is the unchanged rejected experiment from the earlier diagnostic. Its single
transport timeout is not its only elapsed deadline violation: one HTTP 200 took 16.997s.
`long-io-assessment` derives two invalid observations without rewriting the raw report.
`observer-deadline` tests actual event-loop suspension with local HTTP. The boundary and
content-change regression checks share the classification used by both operator tools.
`observer-bundle` fingerprints the corrected two-file observer installed separately, with
explicit links to the frozen builder's apps/dependencies. `postfix-readiness` and its probe
verify this bundle against the actual paused job. The earlier copy of the observer in the
builder runtime was not edited. `postfix-harness-cleanup` records exact fictional cleanup
after a test-tool join error; it never modified production state.

SHA256SUMS covers every file here except itself. It detects corruption, not malicious
rewriting by a repository maintainer. The verifier also checks semantic relations and
cross-file hashes. Default mode verifies historical evidence; `--source` additionally binds
the compiled builder and current corrected observer/test helpers to this checkout.

```sh
npm run build
node tools/verify-admission-evidence.mjs --source
```
