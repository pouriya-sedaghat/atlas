import { createContext, useContext } from 'react';
import type { Capabilities } from './api';
import { ApiError, ConnectionError } from './api';
import type { Strings, UiLang } from './i18n';
import type { OverlayPoint, OverlayRoute } from './MapView';

export type Tool = 'none' | 'reverse' | 'route-stop' | 'prox-origin' | 'prox-candidate';

export interface AppCtx {
  t: Strings;
  lang: UiLang;
  caps: Capabilities;
  tool: Tool;
  setTool: (t: Tool) => void;
  /** Last map click delivered to the panel owning the active tool. */
  lastClick: { lon: number; lat: number; seq: number } | null;
  view: { bounds: [number, number, number, number]; center: { lon: number; lat: number } } | null;
  setOverlay: (points: OverlayPoint[], routes?: OverlayRoute[]) => void;
  flyTo: (lon: number, lat: number, zoom?: number) => void;
  reportError: (err: unknown) => void;
}

export const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('missing app context');
  return v;
}

export interface ShownError {
  code: string;
  message: string;
  requestId: string | null;
  details?: Record<string, unknown> | undefined;
}

export function toShownError(err: unknown): ShownError {
  if (err instanceof ApiError) return { code: err.code, message: err.message, requestId: err.requestId, details: err.details };
  if (err instanceof ConnectionError) return { code: 'CONNECTION_LOST', message: err.message, requestId: null };
  return { code: 'CLIENT_ERROR', message: err instanceof Error ? err.message : String(err), requestId: null };
}

export function ErrorBox({ error }: { error: ShownError | null }) {
  const { t } = useApp();
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <strong>
        {t.error}: <span className="ltr">{error.code}</span>
      </strong>
      <div>{error.message}</div>
      {error.requestId && (
        <div className="muted">
          {t.requestId}: <span className="ltr">{error.requestId}</span>
        </div>
      )}
      {error.details && <pre>{JSON.stringify(error.details, null, 1)}</pre>}
    </div>
  );
}

/**
 * Synthetic fixture points (fixtures/osm/synthetic-v1.osm, near 0°, 0°). Clearly labeled test data,
 * not real places; useful only when the synthetic fixture dataset is active.
 */
export const FIXTURE_POINTS = [
  { id: 'syn-west', lon: 0.01, lat: 0.01 },
  { id: 'syn-east', lon: 0.05, lat: 0.01 },
  { id: 'syn-oneway-s', lon: 0.03, lat: 0.02 },
  { id: 'syn-oneway-n', lon: 0.03, lat: 0.04 },
  { id: 'syn-foot-a', lon: 0.02, lat: 0.025 },
  { id: 'syn-foot-b', lon: 0.04, lat: 0.04 },
  { id: 'syn-island', lon: 0.085, lat: 0.08 },
];
