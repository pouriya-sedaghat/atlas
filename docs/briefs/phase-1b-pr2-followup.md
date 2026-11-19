# Atlas Part 1B — PR #2 review and follow-up

**Status** — Follow-up accepted at `3616c0b95c37786f12989f190382e34cfb02cf07` and merged through [PR #2](https://github.com/pouriya-sedaghat/atlas/pull/2). The findings below are retained as review history. The [focused intake compatibility brief](intake-geofabrik-updates-compatibility.md) contains the current implementation assignment.

## Review findings and disposition

The PR records 163 PostgreSQL tests, both migration checks, two complete inspections of one sealed Iran/554-POLY run, matching decoded counts and semantic identities, and retained/source hashes across Compose restart. Independent review checked the pinned core file blobs and the actual control, spool, decoder, reference, geometry, publication and handoff code. The 22 standard-library Geofabrik tests, syntax compilation and reverse patch validation passed in the review environment. Direct checks of the JSONL/Zstd writer and reader covered full-width IDs, Unicode, exact stream identity and damaged-frame rejection. The production disk-backed reference index was exercised against fixtures distinguishing occurrences, distinct missing targets and affected sources. The PostgreSQL/native verifier suite is represented by the designated-VM evidence.

### P1 — support valid empty snapshots through mandatory reconciliation

In `atlas_verification/execute.py`, `osmium_check()` maps the known empty-bounds JSON failure to `unsupported_profile`. The pipeline test then expects that result. The approved profile accepts a semantically valid empty snapshot with `build_eligible=false`. The pinned Osmium v1.18.0 source exposes `data.count.nodes`, `data.count.ways` and `data.count.relations` through its simple output path without constructing a bounding box.

Implement a narrow full-file count adapter for this inspector presentation case. Use the same stable spool and pinned tool. Each `fileinfo --extended --get=data.count.<kind>` invocation must succeed with a strictly parsed nonnegative decimal result. Compare all three counts with the source decoder. Record adapter identity, invocation results and explicitly absent bounds. A processing error, timeout, malformed response or count mismatch retains its blocking outcome. Include a supported snapshot containing relations but no node bounds in the fixtures if the existing profile admits it.

Update regression expectations so valid-empty verification can complete successfully with `build_eligible=false`. Add failure tests proving that a general Osmium error cannot enter the fallback and that failed or inconsistent count commands cannot yield a verified result.

### P2 — demonstrate the complete successful handoff path

Both live corpus runs correctly ended `input_invalid`, so they exercised the retained failure path. The pipeline and worker suites also test useful components separately. Add one small integrated positive fixture that goes through the authenticated request or normal control entry, the actual verifier child, complete parser/inspector execution, fenced publication and `get_handoff()` with output digest verification. Then invalidate or alter a registered fixture output and prove that the handoff rejects it.

Use an isolated synthetic sealed run with an explicitly declared small fixture catalog and valid boundaries. Keep the live Iran/554-POLY run and its provenance available for comparison. A positive fixture is sufficient to establish publication and handoff behavior when the provider corpus itself contains a blocking boundary.

### Jiangsu — accepted blocking source finding

The Jiangsu ring finding is consistent with `atlas-input-v1`. Keep the input identity `635e10f062e8d3fd3e95d7542225a437b8dddbd6bb60b77acd591e11071fc0c7`, self-intersection location and regional report, and retain `build_eligible=false` for both original batches. A corrected upstream file must enter through a new acquisition and verification. Current Part 1B code acceptance can use the original corpus to prove blocking behavior and the isolated positive fixture to prove success. Provider correction is a later operational input event.

### Memory — accept cgroup enforcement with documented accounting

The reported 319,488-byte peak excursion is about 0.015 percent of 2 GiB. Linux documents temporary usage above `memory.max`. The approved memory requirement is an enforced cgroup limit covering the verifier and its children. Preserve the actual peak and distinguish it from process RSS and charged file cache.

Retain the 2,147,483,648-byte maximum setting, and record effective `memory.max`, `cpu.max`, memory/swap observations and before/after OOM/OOM-kill counters for the next candidate run. Record how the peak's time scope relates to the attempt and cgroup lifetime. Treat an actual allocation failure or OOM event as a resource failure. A transient peak counter alone does not require changing the source result or lowering the configured limit.

### Intake relocation and throughput — complete the diagnosis

The measured concurrent/idle successful-sample medians are 147,206 and 318,202 B/s, with failed probes and a relocated provider path. These observations leave the cause of the difference unresolved. Report the full-current-catalog rejection with the exact public URL, catalog field and validation rule, while retaining the last-known-good revision and existing frozen target identities.

Use matched, bounded transfers against the same validated dated pin for an interleaved idle/concurrent comparison. Include failed observations, byte counts, fingerprints, phase timings and whether time was spent in the provider network or in local I/O. A controlled local replay can measure local contention while the live provider is unstable. Keep normal source allowlisting, dated pinning and checksum checks in effect. A required provider compatibility change should be presented as a focused intake change with concrete evidence for review.

## Reporting and retention

The authenticated attempt summary already exposes regional findings for a failed batch. Preserve those reports and do not represent them as a successful build handoff. Avoid making a corrected provider boundary a prerequisite for finishing the software review.

Run the complete PostgreSQL suite and both migration checks after the corrections, plus the integrated positive and valid-empty cases. On the exact final candidate, re-verify the recorded live corpus, compare the retained semantic identities and all input hashes, and repeat the resource/intake observations that the change affects. Reuse the existing exact-candidate two-attempt evidence for unaffected fidelity claims, explicitly identifying old and new evidence. If extracted bytes or policy outcomes change, rerun two complete attempts and explain the difference. Retain the original negative findings and restart receipt.

## Codex prompt — implement the PR #2 follow-up

Completed assignment retained for audit. The [intake compatibility brief](intake-geofabrik-updates-compatibility.md#codex-prompt--implement-the-compatibility-fix) contains the current assignment.

> On the designated Atlas VM, fetch `origin/main` and `feat/phase-1b-verification` for https://github.com/pouriya-sedaghat/atlas. Read this follow-up brief and the updated Part 1B implementation brief at the supplied revision. Verify the PR #2 baseline `2f63eba7b280fe8947d88f0b1843a7a66ba7708c` and preserve unrelated work.
>
> Implement the valid-empty Osmium count reconciliation adapter and its blocking error tests. Add the integrated positive verification-to-handoff fixture and output-invalidation check. Retain Jiangsu's blocking source outcome. Use the approved cgroup accounting interpretation and capture effective limits and OOM event deltas. Diagnose the exact current-catalog rejection and repeat a matched idle/concurrent transfer comparison, preserving all failures and frozen source identities.
>
> Run the PostgreSQL suite, both migration checks and the acceptance evidence described here on the exact candidate commit. Update the existing draft PR #2 with the tested SHA, commands, manifest outcomes, new and reused evidence, measurements and remaining gaps. If a provider compatibility change is needed, return the exact reproducer and focused proposed change for review. Publish the VM-tested source through the existing authorized GitHub workflow and verify the published tree. Return a concise English handoff for the next review.

## Sources

- [Approved Part 1B brief](https://github.com/pouriya-sedaghat/atlas/blob/3f1c57c4fcf32cfb97397570db10bcf475b53f86/docs/briefs/phase-1b-input-verification.md)
- [Osmium v1.18.0 fileinfo implementation](https://github.com/osmcode/osmium-tool/blob/v1.18.0/src/command_fileinfo.cpp) and [fileinfo count variables](https://docs.osmcode.org/osmium/latest/osmium-fileinfo.html)
- [Linux cgroup v2 memory.max, memory.peak and memory.events](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
