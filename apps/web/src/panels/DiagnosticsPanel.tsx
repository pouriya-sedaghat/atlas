import type { Readiness } from '@seyra/contracts';
import { useApp } from '../common';

/** Implementation details are kept here, out of the ordinary user flows. */
export function DiagnosticsPanel({ ready }: { ready: Readiness | null }) {
  const { t, caps } = useApp();
  return (
    <div>
      <h3>{t.providers}</h3>
      {ready ? (
        <table>
          <thead>
            <tr>
              <th>provider</th>
              <th>status</th>
              <th>identity</th>
              <th>ms</th>
            </tr>
          </thead>
          <tbody>
            {ready.providers.map((p) => (
              <tr key={p.provider}>
                <td className="ltr">
                  {p.provider} ({p.implementation})
                </td>
                <td className="ltr">{p.status}</td>
                <td className="ltr">
                  {p.observed_identity ?? '—'}
                  {p.expected_identity !== p.observed_identity && <div className="muted">expected {p.expected_identity}</div>}
                  {p.error && <div className="muted">{p.error}</div>}
                </td>
                <td className="ltr">{p.latency_ms ?? '—'}</td>
              </tr>
            ))}
            {ready.dependencies.map((d) => (
              <tr key={d.name}>
                <td className="ltr">{d.name}</td>
                <td className="ltr">{d.status}</td>
                <td className="ltr">{d.error ?? ''}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">—</p>
      )}
      <h3>{t.limits}</h3>
      <pre>{JSON.stringify(caps.limits, null, 1)}</pre>
      <h3>{t.support}</h3>
      <pre>{JSON.stringify(caps.routing.support, null, 1)}</pre>
      <pre>{JSON.stringify(caps.routing.unsupported, null, 1)}</pre>
      <h3>capabilities</h3>
      <pre>{JSON.stringify(caps, null, 1)}</pre>
    </div>
  );
}
