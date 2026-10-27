import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Readiness } from '@seyra/contracts';
import { api, ConnectionError, type Capabilities } from './api';
import { Ctx, toShownError, type AppCtx, type ShownError, type Tool } from './common';
import { STRINGS, type UiLang } from './i18n';
import { MapView, type Overlay, type OverlayPoint, type OverlayRoute } from './MapView';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel';
import { PoiPanel } from './panels/PoiPanel';
import { ProximityPanel } from './panels/ProximityPanel';
import { RoutePanel } from './panels/RoutePanel';
import { ReversePanel, SearchPanel } from './panels/SearchPanels';

type Tab = 'search' | 'reverse' | 'route' | 'proximity' | 'pois' | 'diagnostics';

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferences are optional */
  }
}

export function App() {
  const [lang, setLang] = useState<UiLang>(() => readPref('seyra.lang', ['fa', 'en'] as const, 'fa'));
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readPref('seyra.theme', ['light', 'dark'] as const, 'light'));
  const [tab, setTab] = useState<Tab>('search');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState<ShownError | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [connected, setConnected] = useState(true);
  const [tool, setTool] = useState<Tool>('none');
  const [lastClick, setLastClick] = useState<AppCtx['lastClick']>(null);
  const [view, setView] = useState<AppCtx['view']>(null);
  const [overlay, setOverlayState] = useState<Overlay>({ points: [], routes: [] });
  const [flyTarget, setFlyTarget] = useState<{ lon: number; lat: number; zoom?: number; seq: number } | null>(null);
  const t = STRINGS[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.documentElement.dataset.theme = theme;
    document.title = t.title;
    writePref('seyra.lang', lang);
    writePref('seyra.theme', theme);
  }, [lang, theme, t.title]);

  const loadCaps = useCallback(async () => {
    try {
      setCaps(await api.capabilities());
      setCapsError(null);
      setConnected(true);
    } catch (err) {
      setCapsError(toShownError(err));
      if (err instanceof ConnectionError) setConnected(false);
    }
  }, []);
  useEffect(() => void loadCaps(), [loadCaps]);

  // Server connection + readiness polling; a 503 is "connected but not ready".
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const r = await api.ready();
        if (stopped) return;
        setReady(r);
        setConnected(true);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ConnectionError) setConnected(false);
      }
    };
    void poll();
    const h = setInterval(() => void poll(), 10_000);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, []);

  const setOverlay = useCallback((points: OverlayPoint[], routes: OverlayRoute[] = []) => setOverlayState({ points, routes }), []);
  const flyTo = useCallback((lon: number, lat: number, zoom?: number) => setFlyTarget((f) => ({ lon, lat, ...(zoom !== undefined ? { zoom } : {}), seq: (f?.seq ?? 0) + 1 })), []);
  const onClick = useCallback((p: { lon: number; lat: number }) => setLastClick((c) => ({ ...p, seq: (c?.seq ?? 0) + 1 })), []);
  const onMove = useCallback((bounds: [number, number, number, number], center: { lon: number; lat: number }) => setView({ bounds, center }), []);
  const switchTab = (next: Tab) => {
    setTool('none');
    setOverlay([]);
    setTab(next);
  };

  const styleUrl = useMemo(() => {
    if (!caps) return null;
    const rel = caps.map.styles[`${theme}_${lang}`];
    return rel ? new URL(rel, window.location.origin).toString() : null;
  }, [caps, theme, lang]);

  const ctx: AppCtx | null = caps
    ? { t, lang, caps, tool, setTool, lastClick, view, setOverlay, flyTo, reportError: () => undefined }
    : null;
  const status = ready?.status ?? 'unknown';

  return (
    <div className="app">
      <header className="top">
        <h1>{t.title}</h1>
        <span>
          <span className={`status-dot status-${status}`} />
          {status === 'ready' ? t.ready : status === 'maintenance' ? t.maintenance : t.notReady}
        </span>
        <span className="muted">
          {t.dataset}: <span className="ltr">{caps?.dataset_id ?? '—'}</span>
        </span>
        <span>
          {t.theme}:{' '}
          <select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark')} aria-label={t.theme}>
            <option value="light">{t.light}</option>
            <option value="dark">{t.dark}</option>
          </select>
        </span>
        <span>
          {t.language}:{' '}
          <select value={lang} onChange={(e) => setLang(e.target.value as UiLang)} aria-label={t.language}>
            <option value="fa">فارسی</option>
            <option value="en">English</option>
          </select>
        </span>
      </header>
      {!connected ? (
        <div className="banner" role="alert">
          {t.connectionLost}{' '}
          <button type="button" onClick={() => void loadCaps()}>
            {t.retry}
          </button>
        </div>
      ) : (
        <div />
      )}
      <div className="main">
        <aside className="side">
          {!ctx ? (
            <div>
              {capsError && (
                <div className="error">
                  {capsError.code}: {capsError.message}
                </div>
              )}
              <button className="btn" type="button" onClick={() => void loadCaps()}>
                {t.retry}
              </button>
            </div>
          ) : (
            <Ctx.Provider value={ctx}>
              <nav className="tabs">
                {(Object.keys(t.tabs) as Tab[]).map((k) => (
                  <button key={k} type="button" className={tab === k ? 'active' : ''} onClick={() => switchTab(k)}>
                    {t.tabs[k]}
                  </button>
                ))}
              </nav>
              {tab === 'search' && <SearchPanel />}
              {tab === 'reverse' && <ReversePanel />}
              {tab === 'route' && <RoutePanel />}
              {tab === 'proximity' && <ProximityPanel />}
              {tab === 'pois' && <PoiPanel />}
              {tab === 'diagnostics' && <DiagnosticsPanel ready={ready} />}
            </Ctx.Provider>
          )}
        </aside>
        <div className="map-wrap">
          {tool !== 'none' && <div className="tool-hint">{tool}</div>}
          <MapView styleUrl={styleUrl} overlay={overlay} onClick={onClick} onMove={onMove} flyTo={flyTarget} maxZoom={caps?.map.client_max_zoom ?? 22} />
        </div>
      </div>
    </div>
  );
}
