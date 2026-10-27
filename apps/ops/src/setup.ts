import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeRuntime, ensureNetworks, runtimeEnv, writeRuntimeEnv, NO_RELEASE } from './compose.js';
import { initDatabase, waitForDb } from './db.js';
import { DEFAULT_SETTINGS, ensureDirs, layout, readSettings, validateSettings, writeAtomic, type Settings } from './layout.js';
import { lockedImages } from './lock.js';
import { UID } from './importer.js';
import { readPointers } from './activate.js';

/** Secret files and the container user that must read each one (mode 0400). */
const SECRETS: { name: string; owner: number }[] = [
  { name: 'db_admin_password', owner: 0 },
  { name: 'db_render_import_password', owner: 0 },
  { name: 'db_api_password', owner: 1000 }, // node user in the API image
  { name: 'tile_db_password', owner: UID.tegola },
];

export async function init(opts: Partial<Settings>, log: (m: string) => void): Promise<void> {
  const l = layout();
  // Validate the merged settings before creating, persisting or starting anything.
  const settings: Settings = { ...DEFAULT_SETTINGS, ...readSettings(l), ...opts };
  validateSettings(settings);
  ensureDirs(l);
  writeAtomic(l.settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  for (const s of SECRETS) {
    const p = join(l.secrets, s.name);
    if (!existsSync(p)) {
      writeFileSync(p, randomBytes(24).toString('hex'), { mode: 0o400 });
      log(`[init] generated secret ${s.name}`);
    }
    chownSync(p, s.owner, s.owner);
    chmodSync(p, 0o400);
  }
  await ensureNetworks();
  const pointers = readPointers(l);
  if (!existsSync(l.runtimeEnv)) {
    mkdirSync(join(l.releases, NO_RELEASE), { recursive: true });
    writeRuntimeEnv(l, runtimeEnv(l, settings, lockedImages(l.install), pointers.active ?? NO_RELEASE));
  }
  await composeRuntime(l, ['up', '-d', 'db']);
  await waitForDb(l);
  const applied = await initDatabase(l);
  log(`[init] database roles ensured; migrations applied: ${applied.length ? applied.join(', ') : 'none (up to date)'}`);
}

