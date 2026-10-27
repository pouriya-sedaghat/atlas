import { readFileSync } from 'node:fs';
import { DATASET_ID_PATTERN } from '@seyra/contracts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Active release descriptor written by the ops CLI during a maintenance cutover. It names the
 * dataset and the identity each provider must report for that dataset (recorded from the real
 * provider during staging validation). The API never invents these values.
 */
export const ActiveReleaseSchema = Type.Object({
  schema: Type.Literal('seyra.active-release/1'),
  dataset_id: Type.String({ pattern: DATASET_ID_PATTERN }),
  activated_at: Type.String(),
  identities: Type.Object({
    tiles: Type.String({ minLength: 1 }),
    routing: Type.String({ minLength: 1 }),
    geocoder: Type.String({ minLength: 1 }),
    overpass: Type.String({ minLength: 1 }),
  }),
  style_urls: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type ActiveRelease = Static<typeof ActiveReleaseSchema>;

export function loadActiveRelease(file: string): ActiveRelease {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Value.Check(ActiveReleaseSchema, raw)) {
    const first = [...Value.Errors(ActiveReleaseSchema, raw)][0];
    throw new Error(`invalid active release descriptor ${file}: ${first ? `${first.instancePath} ${first.message}` : 'schema mismatch'}`);
  }
  return raw;
}

/** Tegola map name for a dataset (also used by the proxy path rewrite). */
export function tegolaMapName(datasetId: string): string {
  return `seyra_${datasetId.replace(/-/g, '_')}`;
}

/** Name of the release marker document provisioned into the Photon index. */
export function geocoderMarkerName(datasetId: string): string {
  return `seyra-release-${datasetId}`;
}
