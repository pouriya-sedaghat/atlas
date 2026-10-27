import { useEffect, useRef, useState } from 'react';
import type { IdentifiedPoint, ProximityResponse } from '@seyra/contracts';
import { api } from '../api';
import { ErrorBox, FIXTURE_POINTS, toShownError, useApp, type ShownError } from '../common';
import { fmtDistance, fmtDuration } from '../i18n';
import { PointsEditor } from './RoutePanel';

type Metric = 'straight_line' | 'road_distance' | 'travel_time';
type Direction = 'origin_to_candidate' | 'candidate_to_origin';
type Profile = 'car' | 'pedestrian' | 'motorcycle';

export function ProximityPanel() {
  const { t, lang, caps, tool, setTool, lastClick, setOverlay } = useApp();
  const [metric, setMetric] = useState<Metric>('travel_time');
  const [direction, setDirection] = useState<Direction>('origin_to_candidate');
  const [profile, setProfile] = useState<Profile>('car');
  const [origin, setOrigin] = useState<{ lon: number; lat: number } | null>(null);
  const [candidates, setCandidates] = useState<IdentifiedPoint[]>([]);
  const [res, setRes] = useState<ProximityResponse | null>(null);
  const [error, setError] = useState<ShownError | null>(null);

  useEffect(() => () => setTool('none'), [setTool]);
  const handled = useRef(lastClick?.seq ?? 0);
  useEffect(() => {
    if (!lastClick || lastClick.seq === handled.current) return;
    handled.current = lastClick.seq;
    if (tool === 'prox-origin') setOrigin({ lon: lastClick.lon, lat: lastClick.lat });
    if (tool === 'prox-candidate') setCandidates((c) => [...c, { id: `c${c.length + 1}`, lon: lastClick.lon, lat: lastClick.lat }]);
  }, [lastClick, tool]);
  useEffect(() => {
    const rankOf = (id: string) => res?.results.find((r) => r.id === id);
    setOverlay([
      ...(origin ? [{ id: 'origin', lon: origin.lon, lat: origin.lat, label: 'O', kind: 'origin' as const }] : []),
      ...candidates.map((c) => {
        const r = rankOf(c.id);
        return { id: c.id, lon: c.lon, lat: c.lat, label: r ? (r.rank ? `#${r.rank}` : '∅') : c.id, kind: r && r.status === 'unreachable' ? ('unreachable' as const) : ('candidate' as const) };
      }),
    ]);
  }, [origin, candidates, res, setOverlay]);

  const compute = async () => {
    if (!origin) return;
    setError(null);
    try {
      setRes(await api.proximity({ metric, direction, ...(metric === 'straight_line' ? {} : { profile }), origin, candidates, dataset_id: caps.dataset_id }));
    } catch (err) {
      setRes(null);
      setError(toShownError(err));
    }
  };

  return (
    <div>
      <div className="row">
        <div>
          <label>{t.metric}</label>
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {(['straight_line', 'road_distance', 'travel_time'] as const).map((m) => (
              <option key={m} value={m}>
                {t.metrics[m]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t.profile}</label>
          <select value={profile} disabled={metric === 'straight_line'} onChange={(e) => setProfile(e.target.value as Profile)}>
            {(['car', 'pedestrian', 'motorcycle'] as const).map((p) => (
              <option key={p} value={p}>
                {t.profiles[p]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label>{t.direction}</label>
      <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
        {(['origin_to_candidate', 'candidate_to_origin'] as const).map((d) => (
          <option key={d} value={d}>
            {t.directions[d]}
          </option>
        ))}
      </select>
      <label>{t.origin}</label>
      <div className="muted ltr">{origin ? `${origin.lon}, ${origin.lat}` : '—'}</div>
      <label>
        {t.candidates} ({candidates.length}/{caps.proximity.max_candidates})
      </label>
      <PointsEditor points={candidates} setPoints={setCandidates} />
      <div className="btn-row">
        <button className="btn secondary" type="button" onClick={() => setTool(tool === 'prox-origin' ? 'none' : 'prox-origin')}>
          {tool === 'prox-origin' ? t.stopClickingMap : t.setOrigin}
        </button>
        <button className="btn secondary" type="button" onClick={() => setTool(tool === 'prox-candidate' ? 'none' : 'prox-candidate')}>
          {tool === 'prox-candidate' ? t.stopClickingMap : t.addCandidate}
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={() => {
            setOrigin({ lon: 0.03, lat: 0.04 });
            setCandidates(FIXTURE_POINTS.filter((p) => p.id !== 'syn-oneway-n'));
          }}
        >
          {t.fixturePoints}
        </button>
      </div>
      <div className="btn-row">
        <button className="btn" type="button" disabled={!origin || candidates.length === 0} onClick={() => void compute()}>
          {t.compute}
        </button>
      </div>
      <ErrorBox error={error} />
      {res && (
        <div>
          <div className="note">{t.rankingScope}</div>
          <table>
            <thead>
              <tr>
                <th>{t.rank}</th>
                <th>{t.id}</th>
                <th>{t.distance}</th>
                <th>{t.duration}</th>
              </tr>
            </thead>
            <tbody>
              {res.results.map((r) => (
                <tr key={r.id}>
                  <td>{r.rank ?? t.unreachable}</td>
                  <td className="ltr">{r.id}</td>
                  <td>{fmtDistance(r.distance_m, lang)}</td>
                  <td>{fmtDuration(r.duration_s, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted ltr">
            {res.provider} · {res.metric} · {res.direction} · {res.profile ?? '-'} · ranked_by={res.ranked_by}
          </div>
        </div>
      )}
    </div>
  );
}
