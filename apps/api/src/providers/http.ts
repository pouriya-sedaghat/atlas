import { MapServiceError } from '@seyra/contracts';
import { abortError } from '../concurrency.js';

export interface ProviderResponse {
  status: number;
  body: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Fetch from a private provider with cancellation and a response-size bound. Network failures
 * map to PROVIDER_UNAVAILABLE; aborts map to DEADLINE_EXCEEDED/CANCELLED. URLs (which can carry
 * coordinates or query text) are never placed into error messages.
 */
export async function providerFetch(
  provider: string,
  url: URL,
  init: { method?: 'GET' | 'POST'; body?: string; contentType?: string; signal: AbortSignal; maxBytes?: number },
): Promise<ProviderResponse> {
  let res: Response;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.contentType) headers['content-type'] = init.contentType;
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: init.signal,
      redirect: 'error',
    });
  } catch (err) {
    if (init.signal.aborted) throw abortError(init.signal);
    throw new MapServiceError('PROVIDER_UNAVAILABLE', `${provider} is unreachable`, { provider, cause: err });
  }
  try {
    const body = await readLimited(res, init.maxBytes ?? DEFAULT_MAX_BYTES, provider);
    return { status: res.status, body };
  } catch (err) {
    if (init.signal.aborted) throw abortError(init.signal);
    throw err;
  }
}

async function readLimited(res: Response, maxBytes: number, provider: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MapServiceError('PAYLOAD_TOO_LARGE', `${provider} response exceeded ${maxBytes} bytes`, { provider });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson<T>(provider: string, body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new MapServiceError('PROVIDER_ERROR', `${provider} returned malformed JSON`, { provider, cause: err });
  }
}
