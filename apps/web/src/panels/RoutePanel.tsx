import { useEffect, useRef, useState } from 'react';
import type { IdentifiedPoint, RouteResponse } from '@seyra/contracts';
import { api } from '../api';
import { ErrorBox, FIXTURE_POINTS, toShownError, useApp, type ShownError } from '../common';
import { fmtDistance, fmtDuration } from '../i18n';

type Profile = 'car' | 'pedestrian' | 'motorcycle';
type Objective = 'time' | 'distance';
type Order = 'ordered' | 'optimized';

export function PointsEditor({ points, setPoints }: { points: IdentifiedPoint[]; setPoints: (p: IdentifiedPoint[]) => void }) {
  const { t } = useApp();
  const update = (i: number, patch: Partial<IdentifiedPoint>) => setPoints(points.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= points.length) return;
    const next = [...points];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setPoints(next);
  };
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>{t.id}</th>
          <th>{t.lon}</th>
          <th>{t.lat}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={i}>
            <td>{i + 1}</td>
            <td>
              <input type="text" value={p.id} onChange={(e) => update(i, { id: e.target.value })} className="ltr" />
            </td>
            <td>
              <input type="number" step="0.000001" value={p.lon} onChange={(e) => update(i, { lon: Number(e.target.value) })} className="ltr" />
            </td>
            <td>
              <input type="number" step="0.000001" value={p.lat} onChange={(e) => update(i, { lat: Number(e.target.value) })} className="ltr" />
            </td>
            <td>
              <button type="button" title={t.up} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" title={t.down} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" title={t.remove} onClick={() => setPoints(points.filter((_, j) => j !== i))}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RoutePanel() {
  const { t, lang, caps, tool, setTool, lastClick, setOverlay } = useApp();
  const [profile, setProfile] = useState<Profile>('car');
  const [objective, setObjective] = useState<Objective>('time');
  const [order, setOrder] = useState<Order>('ordered');
  const [alternatives, setAlternatives] = useState(0);
  const [points, setPoints] = useState<IdentifiedPoint[]>([]);
  const [res, setRes] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => setTool('none'), [setTool]);
  const handled = useRef(lastClick?.seq ?? 0);
  useEffect(() => {
    if (!lastClick || lastClick.seq === handled.current) return;
    handled.current = lastClick.seq;
    if (tool === 'route-stop') setPoints((p) => [...p, { id: `s${p.length + 1}`, lon: lastClick.lon, lat: lastClick.lat }]);
  }, [lastClick, tool]);
  useEffect(() => {
    const ordered = res ? res.visit_order.map((v) => points.find((p) => p.id === v.id)).filter((p): p is IdentifiedPoint => !!p) : points;
    setOverlay(
      ordered.map((p, i) => ({ id: p.id, lon: p.lon, lat: p.lat, label: `${i + 1}`, kind: 'stop' })),
      res ? res.routes.map((r) => ({ rank: r.rank, coordinates: r.geometry.coordinates as [number, number][] })) : [],
    );
  }, [points, res, setOverlay]);

  const altAllowed = order === 'ordered' && points.length === 2;
  const compute = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.route({ profile, objective, order, points, alternatives: altAllowed ? alternatives : 0, language: lang, dataset_id: caps.dataset_id });
      setRes(r);
    } catch (err) {
      setRes(null);
      setError(toShownError(err));
    } finally {
      setBusy(false);
    }
  };
  /** Sends an explicitly unsupported combination to demonstrate the typed rejection. */
  const tryUnsupported = async () => {
    setError(null);
    try {
      await api.route({ profile, objective, order, points, alternatives: 1, dataset_id: caps.dataset_id });
    } catch (err) {
      setError(toShownError(err));
    }
  };

  return (
    <div>
      <div className="row">
        <div>
          <label>{t.profile}</label>
          <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            {(['car', 'pedestrian', 'motorcycle'] as const).map((p) => (
              <option key={p} value={p}>
                {t.profiles[p]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t.objective}</label>
          <select value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
            {(['time', 'distance'] as const).map((o) => (
              <option key={o} value={o}>
                {t.objectives[o]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div>
          <label>{t.order}</label>
          <select value={order} onChange={(e) => setOrder(e.target.value as Order)}>
            {(['ordered', 'optimized'] as const).map((o) => (
              <option key={o} value={o}>
                {t.orders[o]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t.alternatives}</label>
          <select value={alternatives} disabled={!altAllowed} onChange={(e) => setAlternatives(Number(e.target.value))}>
            {[0, 1, 2].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label>
        {t.stops} ({points.length}; max {order === 'ordered' ? caps.limits.orderedMaxPoints : caps.limits.optimizedMaxPoints})
      </label>
      <PointsEditor points={points} setPoints={setPoints} />
      <div className="btn-row">
        <button className="btn secondary" type="button" onClick={() => setTool(tool === 'route-stop' ? 'none' : 'route-stop')}>
          {tool === 'route-stop' ? t.stopClickingMap : t.addStopByClick}
        </button>
        <button className="btn secondary" type="button" onClick={() => setPoints(FIXTURE_POINTS.slice(0, 2))}>
          {t.fixturePoints}
        </button>
        <button className="btn secondary" type="button" onClick={() => { setPoints([]); setRes(null); }}>
          {t.clear}
        </button>
      </div>
      <div className="btn-row">
        <button className="btn" type="button" disabled={busy || points.length < 2} onClick={() => void compute()}>
          {t.compute}
        </button>
        {points.length > 2 && (
          <button className="btn secondary" type="button" onClick={() => void tryUnsupported()}>
            UNSUPPORTED_COMBINATION?
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {res && (
        <div>
          <div className="note">{t.optimalityNote}</div>
          <div className="muted ltr">
            {res.provider} · {res.profile} · {res.objective} · {res.order} · route_optimality={res.route_optimality} · alternatives {res.alternatives_returned}/
            {res.alternatives_requested}
          </div>
          <ul className="list">
            {res.routes.map((r) => (
              <li key={r.rank}>
                <strong>{r.rank === 0 ? t.primaryRoute : `${t.alternative} ${r.rank}`}</strong>: {t.distance} {fmtDistance(r.distance_m, lang)} · {t.duration}{' '}
                {fmtDuration(r.duration_s, lang)}
              </li>
            ))}
          </ul>
          <div>
            {t.visitOrder}: <span className="ltr">{res.visit_order.map((v) => v.id).join(' → ')}</span>
          </div>
          {res.optimization && (
            <div className="muted">
              {t.modeledCost}: {res.optimization.modeled_cost} {res.optimization.modeled_cost_unit} · {t.finalCost}: {res.optimization.final_route_cost}{' '}
              {res.optimization.modeled_cost_unit} · pairs {res.optimization.pair_routes_computed} · optimal_for_pair_costs=
              {String(res.optimization.visit_order_optimal_for_pair_costs)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
