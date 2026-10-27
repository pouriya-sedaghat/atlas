import { useEffect, useRef, useState } from 'react';
import type { GeocodeResponse, GeocodeResult } from '@seyra/contracts';
import { api } from '../api';
import { ErrorBox, toShownError, useApp, type ShownError } from '../common';

function ResultList({ results, onPick }: { results: GeocodeResult[]; onPick: (r: GeocodeResult) => void }) {
  return (
    <ul className="list">
      {results.map((r) => (
        <li key={r.id} onClick={() => onPick(r)}>
          {/* OSM text is rendered as text (React escapes it); never as HTML. */}
          <div>
            <strong>{r.name ?? r.address.street ?? r.id}</strong>
          </div>
          <div className="muted">
            <span className="ltr">
              {r.category.key}={r.category.value} · {r.id}
            </span>
          </div>
          {Object.keys(r.address).length > 0 && (
            <div className="muted">{['housenumber', 'street', 'district', 'city', 'state'].map((k) => r.address[k]).filter(Boolean).join('، ')}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SearchPanel() {
  const { t, lang, caps, view, setOverlay, flyTo } = useApp();
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const [bias, setBias] = useState(true);
  const [res, setRes] = useState<GeocodeResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const seq = useRef(0);

  const run = async (text: string, autocomplete: boolean) => {
    if (!text.trim()) return;
    const mine = ++seq.current;
    try {
      const r = await api.search(
        { q: text, lang, limit: autocomplete ? 5 : 10, dataset_id: caps.dataset_id, ...(bias && view ? { bias_lon: view.center.lon, bias_lat: view.center.lat } : {}) },
        autocomplete,
      );
      if (mine !== seq.current) return;
      setRes(r);
      setError(null);
      setOverlay(r.results.map((x, i) => ({ id: x.id, lon: x.coordinate.lon, lat: x.coordinate.lat, label: String(i + 1), kind: 'search' })));
    } catch (err) {
      if (mine === seq.current) setError(toShownError(err));
    }
  };

  useEffect(() => {
    if (!auto || q.trim().length < 2) return;
    const h = setTimeout(() => void run(q, true), 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, auto, lang]);

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(q, false);
        }}
      >
        <input type="text" value={q} maxLength={256} placeholder={t.searchPlaceholder} onChange={(e) => setQ(e.target.value)} aria-label={t.searchPlaceholder} />
        <div className="row">
          <label>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t.autocomplete}
          </label>
          <label>
            <input type="checkbox" checked={bias} onChange={(e) => setBias(e.target.checked)} /> {t.biasToView}
          </label>
        </div>
        <div className="btn-row">
          <button className="btn" type="submit">
            {t.tabs.search}
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      {res && (
        <>
          <div className="muted">
            <span className="ltr">
              {res.operation} · {res.provider} · normalized: {res.normalized_query}
            </span>
          </div>
          {res.result_status === 'no_results' ? <p>{t.noResults}</p> : <ResultList results={res.results} onPick={(r) => flyTo(r.coordinate.lon, r.coordinate.lat)} />}
        </>
      )}
    </div>
  );
}

export function ReversePanel() {
  const { t, lang, caps, lastClick, setTool, setOverlay } = useApp();
  const [res, setRes] = useState<GeocodeResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);

  useEffect(() => {
    setTool('reverse');
    return () => setTool('none');
  }, [setTool]);

  const mountedSeq = useRef(lastClick?.seq ?? 0);
  useEffect(() => {
    // Only clicks made while this panel is open (not clicks left over from another tool).
    if (!lastClick || lastClick.seq <= mountedSeq.current) return;
    const at = lastClick;
    void (async () => {
      try {
        const r = await api.reverse({ lon: at.lon, lat: at.lat, lang, limit: 5, dataset_id: caps.dataset_id });
        setRes(r);
        setError(null);
        setOverlay([
          { id: 'click', lon: at.lon, lat: at.lat, label: '×', kind: 'reverse' },
          ...r.results.map((x, i) => ({ id: x.id, lon: x.coordinate.lon, lat: x.coordinate.lat, label: String(i + 1), kind: 'search' as const })),
        ]);
      } catch (err) {
        setError(toShownError(err));
      }
    })();
  }, [lastClick, lang, caps.dataset_id, setOverlay]);

  return (
    <div>
      <p className="muted">{t.clickMapReverse}</p>
      {lastClick && (
        <div className="muted ltr">
          {lastClick.lon}, {lastClick.lat}
        </div>
      )}
      <ErrorBox error={error} />
      {res && (res.result_status === 'no_results' ? <p>{t.noResults}</p> : <ResultList results={res.results} onPick={() => undefined} />)}
    </div>
  );
}
