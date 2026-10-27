#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activate, apiHealth, applyAccess, prune, readPointers, readTransition, recover, restartProxy, rollback, startStack, verifyRelease } from './activate.js';
import { lifecycleLockState, readOwner, withLifecycleLock, type LockOwner } from './lifecycle-lock.js';
import { backup, restore } from './backup.js';
import { bundleExport, bundleLoad, bundleVerify } from './bundle.js';
import { composeRuntime } from './compose.js';
import { importDataset } from './importer.js';
import { layout, managedChild } from './layout.js';
import { lockedImages, verifyImages } from './lock.js';
import { readManifest } from './manifest.js';
import { init } from './setup.js';

const USAGE = `seyra-maps — HTTP demonstration Map Services release tool (runs inside the seyra-demo/ops image)

  init [--bind IP] [--port N] [--access loopback|lan] [--lan-cidrs a/b,c/d] [--server-names "h1 h2"]
       [--relay-peer IP --relay-bind IP --relay-port N --relay-client-cidrs a/b --relay-server-names "h1"] [--no-relay]
  access apply                      write runtime.env from the persisted access/relay settings (active release kept)
  proxy restart                     recreate only the HTTP proxy with applied access settings
  verify-images                     check every locked image is loaded with its locked identity
  import --pbf /abs/path/iran.osm.pbf [--snapshot-timestamp ISO8601]
  activate DATASET_ID               maintenance cutover to a validated release
  rollback                          cut back to the previous release
  recover                           finish an interrupted/failed activation or rollback (journalled)
  start | stop                      start/stop the complete runtime stack (all four providers)
  status                            pointers, releases and live provider readiness
  verify-release DATASET_ID         re-check staged artifacts and render DB marker
  prune                             keep active + previous releases only
  backup [--out DIR] [--include-sources]   one verified backup generation under DIR (default $SEYRA_HOME/backups):
                                    control DB dump + state/manifests (+ managed OSM inputs)
  restore --from DIR [--generation NAME]   fresh host (after secrets + init): restore the newest complete
                                    generation under DIR (or DIR itself / NAME) after verifying it
  bundle export --out DIR [--include PATH ...] | bundle verify DIR | bundle load DIR
`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const log = (m: string) => console.log(m);

async function status(): Promise<void> {
  const l = layout();
  const p = readPointers(l);
  console.log(`active:   ${p.active ?? '(none)'}\nprevious: ${p.previous ?? '(none)'}`);
  console.log(`maintenance flag: ${existsSync(join(l.flags, 'maintenance')) ? 'PRESENT' : 'absent'}`);
  const t = readTransition(l);
  if (t) console.log(`UNFINISHED ${t.op}: ${t.from ?? '(none)'} -> ${t.to} (phase ${t.phase}, started ${t.started_at}); run: seyra-maps recover`);
  const lock = lifecycleLockState(l.lifecycleLock);
  const describe = (o: LockOwner) => `${o.op}${o.target ? ` ${o.target}` : ''} since ${o.started_at} (host ${o.host}, pid ${o.pid})`;
  if (lock.held) console.log(`lifecycle lock: held${lock.owner ? ` by ${describe(lock.owner)}` : ''}`);
  else if (lock.owner) console.log(`lifecycle lock: free (record of ${describe(lock.owner)}, which ended without releasing it)`);
  const lease = existsSync(l.importLock) ? readOwner(l.importLock) : null;
  if (lease) console.log(`import lease: ${describe(lease)}`);
  console.log('releases:');
  for (const name of existsSync(l.releases) ? readdirSync(l.releases).sort() : []) {
    if (!existsSync(join(l.releases, name, 'manifest.json'))) continue;
    try {
      const m = readManifest(managedChild(l.releases, name));
      console.log(`  ${name}  ${m.status}${m.failure ? ` (failed at ${m.failure.step}: ${m.failure.message})` : ''}  source=${m.source.filename} sha256=${m.source.sha256.slice(0, 12)}…`);
    } catch (err) {
      console.log(`  ${name}  unreadable manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const h = await apiHealth(l);
  console.log(h ? `live readiness: ${JSON.stringify(h, null, 1)}` : 'live readiness: API not reachable');
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      await withLifecycleLock(layout(), 'init', null, () => init(
        {
          ...(arg(rest, '--bind') ? { bindAddr: arg(rest, '--bind')! } : {}),
          ...(arg(rest, '--port') ? { httpsPort: Number(arg(rest, '--port')) } : {}),
          ...(arg(rest, '--access') ? { accessMode: arg(rest, '--access') as 'loopback' | 'lan' } : {}),
          ...(arg(rest, '--lan-cidrs') !== undefined ? { lanCidrs: arg(rest, '--lan-cidrs')! } : {}),
          ...(arg(rest, '--server-names') ? { serverNames: arg(rest, '--server-names')! } : {}),
          ...(rest.includes('--no-relay') ? { relayPeer: '', relayBindAddr: '', relayPort: 0, relayClientCidrs: '', relayServerNames: '' } : {}),
          ...(arg(rest, '--relay-peer') !== undefined ? { relayPeer: arg(rest, '--relay-peer')! } : {}),
          ...(arg(rest, '--relay-bind') !== undefined ? { relayBindAddr: arg(rest, '--relay-bind')! } : {}),
          ...(arg(rest, '--relay-port') !== undefined ? { relayPort: Number(arg(rest, '--relay-port')) } : {}),
          ...(arg(rest, '--relay-client-cidrs') !== undefined ? { relayClientCidrs: arg(rest, '--relay-client-cidrs')! } : {}),
          ...(arg(rest, '--relay-server-names') !== undefined ? { relayServerNames: arg(rest, '--relay-server-names')! } : {}),
        },
        log,
      ));
      return 0;
    case 'access':
      if (rest[0] !== 'apply') throw new Error('access apply');
      await withLifecycleLock(layout(), 'access-apply', null, async () => {
        applyAccess(layout(), log);
      });
      return 0;
    case 'proxy':
      if (rest[0] !== 'restart') throw new Error('proxy restart');
      await withLifecycleLock(layout(), 'proxy-restart', null, () => restartProxy(layout(), log));
      return 0;
    case 'verify-images': {
      const res = await verifyImages(lockedImages(layout().install));
      for (const r of res) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.role.padEnd(15)} ${r.ref}  observed=${r.observed ?? 'missing'} expected=${r.expected ?? 'unknown'}`);
      return res.every((r) => r.ok) ? 0 : 1;
    }
    case 'import': {
      const pbf = arg(rest, '--pbf');
      if (!pbf) throw new Error('--pbf is required');
      const ts = arg(rest, '--snapshot-timestamp');
      const id = await importDataset({ pbf, ...(ts ? { snapshotTimestamp: ts } : {}), log });
      log(`[import] release ${id} built and validated in staging; activate with: seyra-maps activate ${id}`);
      return 0;
    }
    case 'activate':
      if (!rest[0]) throw new Error('dataset id required');
      await activate(rest[0], { log });
      return 0;
    case 'rollback':
      await rollback(log);
      return 0;
    case 'recover':
      await recover({ log });
      return 0;
    case 'start': {
      const l = layout();
      await withLifecycleLock(l, 'start', null, async () => {
        if (readTransition(l)) throw new Error('an activation/rollback did not finish; run: seyra-maps recover');
        // Image references are tags; refuse to start anything that no longer resolves to the lock.
        const bad = (await verifyImages(lockedImages(l.install))).filter((r) => !r.ok);
        if (bad.length) throw new Error(`refusing to start: ${bad.map((b) => `${b.role} is ${b.observed ?? 'missing'}, locked ${b.expected ?? 'unknown'}`).join('; ')}`);
        await startStack(l, log);
      });
      return 0;
    }
    case 'stop': {
      const l = layout();
      await withLifecycleLock(l, 'stop', null, () => composeRuntime(l, ['stop', '-t', '40']));
      return 0;
    }
    case 'status':
      await status();
      return 0;
    case 'verify-release': {
      const { problems } = await verifyRelease(layout(), rest[0] ?? '');
      console.log(problems.length ? problems.join('\n') : 'release artifacts verified');
      return problems.length ? 1 : 0;
    }
    case 'prune':
      log(`[prune] removed: ${(await prune(log)).join(', ') || 'nothing'}`);
      return 0;
    case 'backup':
      // Under the lifecycle lock so the state/manifests are not captured mid-transition.
      await withLifecycleLock(layout(), 'backup', null, () => backup(arg(rest, '--out') ?? layout().backups, { includeSources: rest.includes('--include-sources'), log }));
      return 0;
    case 'restore': {
      const from = arg(rest, '--from');
      if (!from) throw new Error('--from DIR is required');
      const generation = arg(rest, '--generation');
      await withLifecycleLock(layout(), 'restore', null, () => restore(from, log, generation ? { generation } : {}));
      return 0;
    }
    case 'bundle': {
      const sub = rest[0];
      if (sub === 'export') {
        const out = arg(rest, '--out');
        if (!out) throw new Error('--out required');
        const includes: string[] = [];
        rest.forEach((v, i) => rest[i - 1] === '--include' && includes.push(v));
        await bundleExport(layout().install, out, includes, log);
      } else if (sub === 'verify') {
        const { problems } = await bundleVerify(rest[1] ?? '.');
        console.log(problems.length ? `BUNDLE INVALID:\n${problems.join('\n')}` : 'bundle verified: all checksums match');
        return problems.length ? 1 : 0;
      } else if (sub === 'load') {
        await bundleLoad(rest[1] ?? '.', log);
      } else throw new Error('bundle export|verify|load');
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`seyra-maps: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
