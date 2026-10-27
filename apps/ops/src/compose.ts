import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Layout, Settings } from './layout.js';
import { validateRuntimeAccess, validateSettings, writeAtomic } from './layout.js';
import { imageEnv, type LockedImage } from './lock.js';
import { run, type RunOptions, type RunResult } from './proc.js';

export const RUNTIME_PROJECT = 'seyra-demo';
export const JOBS_PROJECT = 'seyra-demo-jobs';

export function composeFile(l: Layout, name: 'runtime.yml' | 'jobs.yml' | 'runtime.relay.yml'): string {
  return join(l.install, 'infra', 'compose', name);
}

/** Placeholder release used before the first activation so compose can interpolate. */
export const NO_RELEASE = 'none';

export function runtimeEnv(l: Layout, s: Settings, images: LockedImage[], datasetId: string): Record<string, string> {
  validateSettings(s); // never generate a runtime configuration from unsafe settings
  return {
    SEYRA_HOME: l.home,
    SEYRA_DATASET_ID: datasetId,
    SEYRA_RELEASE_DIR: join(l.releases, datasetId),
    SEYRA_BIND_ADDR: s.bindAddr,
    SEYRA_HTTPS_PORT: String(s.httpsPort),
    SEYRA_ACCESS_MODE: s.accessMode,
    SEYRA_LAN_ALLOW_CIDRS: s.lanCidrs,
    SEYRA_SERVER_NAMES: s.serverNames,
    SEYRA_RELAY_PEER: s.relayPeer,
    SEYRA_RELAY_BIND_ADDR: s.relayBindAddr,
    SEYRA_RELAY_PORT: s.relayPort ? String(s.relayPort) : '',
    SEYRA_RELAY_CLIENT_CIDRS: s.relayClientCidrs,
    SEYRA_RELAY_SERVER_NAMES: s.relayServerNames,
    SEYRA_VALHALLA_THREADS: String(s.valhallaThreads),
    SEYRA_PHOTON_JAVA_OPTS: s.photonJavaOpts,
    SEYRA_TILE_CACHE_MAX: s.tileCacheMax,
    ...imageEnv(images),
  };
}

export function serializeEnv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([k, v]) => {
      if (/[\n\r]/.test(v)) throw new Error(`invalid newline in ${k}`);
      return `${k}=${/[\s#"'$]/.test(v) ? JSON.stringify(v) : v}`;
    })
    .join('\n')}\n`;
}

export function writeRuntimeEnv(l: Layout, env: Record<string, string>): void {
  writeAtomic(l.runtimeEnv, serializeEnv(env), 0o640);
}

/** Parse a runtime.env written by serializeEnv (plain or JSON-quoted values). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]!] = m[2]!.startsWith('"') ? (JSON.parse(m[2]!) as string) : m[2]!;
  }
  return env;
}

/**
 * Runtime boundary: the access configuration that compose is about to publish must satisfy the
 * same rules as the settings (also catches a hand-edited runtime.env). Throws before `up`.
 */
export function assertRuntimeEnvSafe(l: Layout): void {
  if (!existsSync(l.runtimeEnv)) throw new Error(`missing ${l.runtimeEnv}; run seyra-maps init`);
  validateRuntimeAccess(parseEnv(readFileSync(l.runtimeEnv, 'utf8')));
}

/** True when the generated runtime.env enables the relay listener. */
export function relayEnabled(l: Layout): boolean {
  return existsSync(l.runtimeEnv) && Boolean(parseEnv(readFileSync(l.runtimeEnv, 'utf8')).SEYRA_RELAY_PEER);
}

/**
 * Compose files for the operational stack. The relay port mapping lives in its own file, added
 * only when runtime.env enables a relay, so every invocation (up, port, exec, stop) agrees.
 */
export function runtimeComposeFiles(l: Layout): string[] {
  const files = ['-f', composeFile(l, 'runtime.yml')];
  if (relayEnabled(l)) files.push('-f', composeFile(l, 'runtime.relay.yml'));
  return files;
}

/** docker compose for the operational stack, always using the generated runtime.env. */
export function composeRuntime(l: Layout, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run('docker', ['compose', '-p', RUNTIME_PROJECT, ...runtimeComposeFiles(l), '--env-file', l.runtimeEnv, ...args], opts);
}

/** Per-run job variables. Compose interpolates every service in jobs.yml, not only the one being run. */
export const JOB_VARS = [
  'SEYRA_JOB_INPUT',
  'SEYRA_JOB_OUT',
  'SEYRA_JOB_WORK',
  'SEYRA_JOB_IMPORT',
  'SEYRA_JOB_RELEASE',
  'SEYRA_JOB_RENDER_DB',
  'SEYRA_JOB_PGPASS',
  'SEYRA_JOB_OVERPASS_LABEL',
  'SEYRA_PHOTON_EXTRA_TAGS',
] as const;

/**
 * docker compose for offline build jobs; per-run mounts are passed as environment variables.
 * Variables of the services that are NOT being run get an inert managed placeholder so compose
 * can interpolate the whole file; the caller supplies every variable its own service needs.
 */
export function jobsInvocation(l: Layout, env: Record<string, string>, args: string[]): { cmd: string; args: string[]; env: Record<string, string> } {
  const placeholder = join(l.work, '.job-var-unset');
  const filler = Object.fromEntries(JOB_VARS.filter((k) => env[k] === undefined).map((k) => [k, placeholder]));
  return { cmd: 'docker', args: ['compose', '-p', JOBS_PROJECT, '-f', composeFile(l, 'jobs.yml'), ...args], env: { SEYRA_HOME: l.home, ...filler, ...env } };
}

export function composeJobs(l: Layout, env: Record<string, string>, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const inv = jobsInvocation(l, env, args);
  return run(inv.cmd, inv.args, { ...opts, env: { ...inv.env, ...opts.env } });
}

export async function ensureNetworks(): Promise<void> {
  for (const name of ['seyra_demo_backend', 'seyra_demo_build']) {
    const exists = await run('docker', ['network', 'inspect', name], { allowFailure: true });
    // Internal networks: no route to the outside world for anything attached to them.
    if (exists.code !== 0) await run('docker', ['network', 'create', '--internal', '--label', 'seyra.managed=true', name]);
  }
}
