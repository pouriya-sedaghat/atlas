# Read-only guest history and an external low-load witness

These recordings do not repeat a full import or approve publication. The actual VM host is
a different Windows/VMware computer, per the user. No actual-host inventory was obtained.

Three JSON reports are gzip-compressed without changing their JSON content. `runs.json`
binds both compressed and original byte hashes, request/sample counts, and exact collector
sources. Initial/intermediate source text is retained as data; the final source is also
bound to the current checkout. The earlier numeric nanosecond timestamps are historical;
the later guest emits decimal strings to preserve JSON integer precision. No timestamps
were rewritten. `classifier-source.txt` is the shared five-second observation rule.

`history.json` contains bounded outputs from guest sysstat/journal/clock/device/service
inspection. Its ten-minute statistics cannot resolve a seconds-long stall or measure host
physical storage. `preflight`/`postflight` prove unchanged job states, policy and containers.
`windows-fixture-test` tests fictional VMX/log filtering on the Codex computer; it is
explicitly not data from the real VM host. Permission errors in that fixture were preserved.

SHA256SUMS checks corruption. The verifier checks semantic relations too, including final
guest records, source hashes, observed time gaps, every HTTP hash and retained admission.
None of these unsigned artifacts is an independent attestation against the Unix/Git owner.

```sh
node tools/verify-passive-evidence.mjs
node tools/verify-passive-evidence.mjs --source
```
