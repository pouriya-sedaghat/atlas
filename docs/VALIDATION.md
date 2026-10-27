# Validation of the extracted demo

Local test date: 2026-10-24. Complete-source package date: 2026-10-26. Source commit: `80935b42a9b5616c21df7483412c5fb2ccbc6df8`.

Tests below apply to the **extracted HTTP source variant**. Historical upstream evidence was not copied into this package or represented as a fresh test result.

| Check | Result |
| --- | --- |
| Locked npm dependency installation | PASS, `npm ci --ignore-scripts --no-audit --no-fund` |
| Production TypeScript and Vite build | PASS: contracts, map assets, API, ops and web |
| TypeScript type checking | PASS: all workspaces |
| OpenAPI document generation | PASS: `docs/openapi/map-services-v1.json` generated from registered routes |
| Unit/contract tests | PASS: 118 passed, 3 skipped, 0 failed, across 14 test files |
| Contracts / map assets / API / selected ops tests | 12 / 6 / 57 / 43 passed |
| YAML and extraction consistency checks | PASS: runtime/jobs/relay parse; four real mandatory providers; no backend host ports; no TLS secret/listener; demo Docker names isolated |
| Shell syntax | PASS using Git Bash `bash -n`; see `validation/summary.json` for script count |
| Full Docker image build | PASS in supplied owner VM logs; not run on the local Windows preparation host |
| Nginx configuration validation inside container | Successful proxy startup and HTTP smoke observed; standalone nginx validation output was not supplied |
| Real data import, all-provider readiness and HTTP smoke | PASS in supplied owner VM transcript; see `VM_VALIDATION.md` |
| Browser rendering, search and routing with real data | NOT RUN |
| Destination LAN access and offline bundle export/load | NOT RUN |

Host: Windows, Node `v24.21.0`, npm `11.3.0`. Tests use mocked providers only where the upstream unit/contract suite calls for them; they do not establish real provider functionality. No mock provider is used by `demo.sh`, the runtime API or the runtime Compose stack.

Three upstream runtime-boundary tests use Linux absolute `SEYRA_HOME` paths. They are explicitly skipped on Windows and remain enabled on Linux. Other Linux filesystem/ownership, Docker lifecycle and TLS tests were not included in this focused source extract; their excluded paths are listed in `SOURCE.json`. Initial test failures from missing exported fixture files were resolved by including the required mobile fixtures and generating OpenAPI before the final successful test run.

`infra/dependencies.lock.json` initially contains null image identities. This prevents startup from treating the original repository's host-specific Docker IDs as images built from this modified source. `scripts/prepare.sh` builds and inspects actual local images and rewrites that file. It does not declare end-to-end runtime acceptance from a build alone.

Before presenting, run preparation and `demo.sh` on the Linux VM, then `scripts/smoke.sh` against the actual HTTP address. The importer validates staging outputs and activation checks all four provider identities and the control database. Inspect the map visually and exercise search/routing and Swagger Try it out with the supplied dataset. A ready response must be HTTP 200. The synthetic OSM fixture contains fictional objects and is not an Iran map.

## Preparation correction based on owner VM logs

The first owner log showed all nine custom Docker image builds completed, with the PostGIS image also present. Preparation then failed at `spawnSync git ENOENT` while the lock generator ran in the ops container. The subsequent ten `expected=unknown` failures were caused by the unpopulated lock.

The corrected preparation verifies pinned Git checkout heads using host Git, records their observed commits with the source configuration digest, and passes this verified record into the existing ops container. No application image changes, rebuild, dependency downloads or network access are required by the finalization step. Six regression tests passed using actual temporary Git repositories and a Node consumer with an empty PATH. Wrong commits, changed configuration, wrong source directories and incomplete records are rejected. Shell and Node syntax checks passed.

The owner's subsequent transcript confirms successful corrected finalization, ten matching image identities, import and activation of `ds-20261017-2fe22e532682`, all-provider readiness, and HTTP Swagger/map-resource smoke tests. See `VM_VALIDATION.md` for the observed results and remaining separate-client/browser checks.
