import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.js';

/** Image roles used by runtime and job compose files (env var names SEYRA_IMAGE_<ROLE>). */
export const IMAGE_ROLES = ['DB', 'TEGOLA', 'VALHALLA', 'PHOTON', 'OVERPASS', 'API', 'PROXY', 'OSMTOOLS', 'GEOCODER_BUILD', 'OPS'] as const;
export type ImageRole = (typeof IMAGE_ROLES)[number];

export interface LockedImage {
  role: ImageRole;
  ref: string;
  image_id: string | null;
  platform: string;
  origin: string;
}

interface LockFile {
  images: Record<string, { role: ImageRole; ref: string; image_id: string | null; platform: string; origin: string }>;
}

export function readLock(installDir: string): LockFile {
  return JSON.parse(readFileSync(join(installDir, 'infra', 'dependencies.lock.json'), 'utf8')) as LockFile;
}

export function lockedImages(installDir: string): LockedImage[] {
  const lock = readLock(installDir);
  const out: LockedImage[] = [];
  for (const role of IMAGE_ROLES) {
    const entry = Object.values(lock.images).find((e) => e.role === role);
    if (!entry) throw new Error(`dependencies.lock.json has no image for role ${role}`);
    out.push({ role, ref: entry.ref, image_id: entry.image_id, platform: entry.platform, origin: entry.origin });
  }
  return out;
}

export function imageEnv(images: LockedImage[]): Record<string, string> {
  return Object.fromEntries(images.map((i) => [`SEYRA_IMAGE_${i.role}`, i.ref]));
}

export async function inspectImageId(ref: string): Promise<string | null> {
  const r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { allowFailure: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Every locked image must be present locally with the locked identity; nothing is pulled. */
export async function verifyImages(images: LockedImage[]): Promise<{ role: string; ref: string; ok: boolean; observed: string | null; expected: string | null }[]> {
  const results = [];
  for (const img of images) {
    const observed = await inspectImageId(img.ref);
    // An unknown (null) locked identity is never accepted: incomplete locks fail closed.
    results.push({ role: img.role, ref: img.ref, ok: observed !== null && img.image_id !== null && observed === img.image_id, observed, expected: img.image_id });
  }
  return results;
}
