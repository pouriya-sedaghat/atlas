import { chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PHOTON_UID = 10005;

/**
 * Photon's embedded OpenSearch applies disk watermarks as PERCENTAGES of the filesystem by default
 * (flood stage 95% used). On a large disk that leaves the index read-only although many GB are
 * free, and Photon then fails at startup (its synonym update must close the index). The node
 * configuration is written before the import (the embedded runner only creates it when absent),
 * so every start of this index uses absolute free-space thresholds instead.
 */
export const PHOTON_OPENSEARCH_SETTINGS = [
  'cluster.routing.allocation.disk.watermark.low: 2gb',
  'cluster.routing.allocation.disk.watermark.high: 1gb',
  'cluster.routing.allocation.disk.watermark.flood_stage: 512mb',
];

export function writePhotonNodeConfig(photonDir: string): void {
  const dirs = [join(photonDir, 'photon_data'), join(photonDir, 'photon_data', 'node_1'), join(photonDir, 'photon_data', 'node_1', 'config')];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    chownSync(d, PHOTON_UID, PHOTON_UID);
  }
  const file = join(photonDir, 'photon_data', 'node_1', 'config', 'opensearch.yml');
  writeFileSync(file, `# Written by seyra-maps (see PHOTON_OPENSEARCH_SETTINGS).\n${PHOTON_OPENSEARCH_SETTINGS.join('\n')}\n`, { mode: 0o644 });
  chownSync(file, PHOTON_UID, PHOTON_UID);
}
