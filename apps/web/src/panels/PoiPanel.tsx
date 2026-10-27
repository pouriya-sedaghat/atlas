import { useEffect, useState } from 'react';
import { bboxAreaKm2, type PoiResponse } from '@seyra/contracts';
import { api } from '../api';
import { ErrorBox, toShownError, useApp, type ShownError } from '../common';

export function PoiPanel() {
  const { t, lang, caps, view, setOverlay, flyTo } = useApp();
  const [preset, setPreset] = useState<string>(caps.pois.presets[0]?.id ?? '');
  const [useSelector, setUseSelector] = useState(false);
  const keys = Object.keys(caps.pois.selector_allowlist);
  const [key, setKey] = useState(keys[0] ?? 'amenity');
  const [value, setValue] = useState(caps.pois.selector_allowlist[keys[0] ?? 'amenity']?.[0] ?? '');
  const [limit, setLimit] = useState(100);
  const [res, setRes] = useState<PoiResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);

  const area = view ? bboxAreaKm2(view.bounds) : null;
  const tooLarge = area !== null && area > caps.pois.max_bbox_km2;

  useEffect(() => {
    setOverlay((res?.features ?? []).map((f) => ({ id: f.id, lon: f.coordinate.lon, lat: f.coordinate.lat, label: f.name ?? f.value, kind: 'poi' })));
  }, [res, setOverlay]);

  const find = async () => {
    if (!view) return;
    setError(null);
    const bbox = view.bounds.map((n) => n.toFixed(6)).join(',');
    try {
      setRes(await api.pois({ bbox, limit, lang, dataset_id: caps.dataset_id, ...(useSelector ? { key, value } : { preset }) }));
    } catch (err) {
      setRes(null);
      setError(toShownError(err));
    }
  };

  return (
    <div>
      <label>
        <input type="radio" checked={!useSelector} onChange={() => setUseSelector(false)} /> {t.preset}
      </label>
      <select value={preset} disabled={useSelector} onChange={(e) => setPreset(e.target.value)}>
        {caps.pois.presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label[lang]}
          </option>
        ))}
      </select>
      <label>
        <input type="radio" checked={useSelector} onChange={() => setUseSelector(true)} /> {t.orSelector}
      </label>
      <div className="row">
        <select value={key} disabled={!useSelector} onChange={(e) => { setKey(e.target.value); setValue(caps.pois.selector_allowlist[e.target.value]?.[0] ?? ''); }} className="ltr">
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select value={value} disabled={!useSelector} onChange={(e) => setValue(e.target.value)} className="ltr">
          {(caps.pois.selector_allowlist[key] ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <label>limit (≤ {caps.pois.max_results})</label>
      <input type="number" min={1} max={caps.pois.max_results} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
      <div className="muted">
        {t.currentView}: {area === null ? '—' : `${area.toFixed(2)} km²`} (≤ {caps.pois.max_bbox_km2} km²)
      </div>
      {tooLarge && <div className="note">{t.areaTooLarge}</div>}
      <div className="btn-row">
        <button className="btn" type="button" disabled={!view} onClick={() => void find()}>
          {t.find}
        </button>
      </div>
      <ErrorBox error={error} />
      {res && (
        <div>
          {res.truncated && <div className="note">{t.truncated}</div>}
          <div className="muted ltr">
            {res.provider} · {res.features.length}/{res.limit} · {res.bbox_area_km2} km²
          </div>
          {res.features.length === 0 ? (
            <p>{t.noResults}</p>
          ) : (
            <ul className="list">
              {res.features.map((f) => (
                <li key={f.id} onClick={() => flyTo(f.coordinate.lon, f.coordinate.lat, 17)}>
                  <strong>{f.name ?? '—'}</strong>{' '}
                  <span className="muted ltr">
                    {f.key}={f.value} · {f.id}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
