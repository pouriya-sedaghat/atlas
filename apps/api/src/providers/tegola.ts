import { MapServiceError } from '@seyra/contracts';
import { parseJson, providerFetch } from './http.js';

/**
 * Tegola is reached by clients only through fixed Nginx tile paths. The API probes it for
 * readiness: the served map name embeds the dataset id, so a stale configuration is visible.
 */
export class TegolaClient {
  constructor(private readonly baseUrl: string) {}

  async identity(expectedMap: string, signal: AbortSignal): Promise<{ identity: string | null; version: string | null }> {
    const res = await providerFetch('tegola', new URL(`${this.baseUrl}/capabilities`), { signal, maxBytes: 1024 * 1024 });
    if (res.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `tegola capabilities returned HTTP ${res.status}`, { provider: 'tegola' });
    const caps = parseJson<{ version?: string; maps?: { name?: string }[] }>('tegola', res.body);
    const names = (caps.maps ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
    let identity: string | null = null;
    if (names.includes(expectedMap)) {
      // Fetch one real tile to confirm the provider can query its database.
      const tile = await providerFetch('tegola', new URL(`${this.baseUrl}/maps/${encodeURIComponent(expectedMap)}/0/0/0.pbf`), { signal, maxBytes: 8 * 1024 * 1024 });
      if (tile.status !== 200) throw new MapServiceError('PROVIDER_UNAVAILABLE', `tegola tile probe returned HTTP ${tile.status}`, { provider: 'tegola' });
      identity = expectedMap;
    } else {
      identity = names.find((n) => n.startsWith('seyra_')) ?? null;
    }
    return { identity, version: caps.version ?? null };
  }
}
