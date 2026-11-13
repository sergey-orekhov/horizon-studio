import { useEffect, useState } from 'react';
import type { AccountUsage, EngineId, LocalUsage, Response } from '@horizon/protocol';

type Request = (method: string, params?: unknown) => Promise<Response>;

const until = (at: string) => {
  const mins = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60_000));
  return mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.round(mins / 1440)} days`;
};
const label = (key: string) => key.replaceAll('_', ' ');

/** Plan limits and usage of each Engine's account on one Agent (admin only). */
export function Usage({ engines, request }: { engines: { id: EngineId; name: string }[]; request: Request }) {
  return (
    <div className="usage">
      <h2>Usage</h2>
      {engines.map((e) => (
        <EngineUsage key={e.id} engine={e.id} name={e.name} request={request} />
      ))}
    </div>
  );
}

function EngineUsage({ engine, name, request }: { engine: EngineId; name: string; request: Request }) {
  const [usage, setUsage] = useState<AccountUsage | null>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load(refresh: boolean) {
    setLoading(true);
    const res = await request('agent.usage', { engine, refresh });
    setLoading(false);
    if ('error' in res) return setError(res.error.message);
    const result = res.result as { usage: AccountUsage | null; error?: string };
    setUsage(result.usage);
    setError(result.error ? `Could not refresh: ${result.error}. Showing the last known values.` : '');
  }
  // Show what the Agent has at once, then fetch fresh values, including the local scan.
  useEffect(() => void load(false).then(() => load(true)), [engine]);

  return (
    <section className="engine-usage">
      <h3>
        {name}
        {usage?.plan && <span className="muted"> · {usage.plan} plan</span>}
      </h3>
      <div className="usage-meta">
        {usage && <span className="muted">updated {new Date(usage.at).toLocaleString()}</span>}
        <button onClick={() => load(true)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {usage === null && !loading && <p className="muted">No usage data yet.</p>}
      {usage && !usage.limitsApply && <p className="muted">Plan limits do not apply to this account, for example because it uses an API key.</p>}
      {usage && usage.limits.length > 0 && (
        <table className="limits">
          <tbody>
            {usage.limits.map((l) => (
              <tr key={l.name}>
                <td>{l.name}</td>
                <td>
                  <meter min={0} max={100} low={70} high={90} optimum={0} value={l.percent} aria-label={`${l.name} used`} />
                </td>
                <td className="num">{l.percent}%</td>
                <td>
                  {l.percent >= 100 ? <strong className="warn">Limit reached</strong> : l.percent >= 80 ? <strong className="warn">Almost used up</strong> : null}
                  {l.resetsAt && <span className="muted"> resets in {until(l.resetsAt)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {usage?.extra?.enabled && (
        <p>
          Extra usage:{' '}
          {usage.extra.balance
            ? `balance ${usage.extra.balance}`
            : `${usage.extra.used ?? 0}${usage.extra.limit ? ` of ${usage.extra.limit}` : ''} ${usage.extra.currency ?? 'credits'}${usage.extra.percent != null ? ` (${usage.extra.percent}%)` : ''}`}
        </p>
      )}
      {usage?.local && (
        <div className="local-usage">
          <Local title="Last 24 hours" local={usage.local.day} />
          <Local title="Last 7 days" local={usage.local.week} />
        </div>
      )}
    </section>
  );
}

function Local({ title, local }: { title: string; local: LocalUsage }) {
  return (
    <div>
      <h4>{title}</h4>
      <p>
        {local.requests.toLocaleString()} requests in {local.sessions} sessions
      </p>
      {local.behaviors.length > 0 && (
        <>
          <p className="muted">What made usage heavy (shares overlap):</p>
          <ul>
            {local.behaviors.map((b) => (
              <li key={b.key}>
                {label(b.key)}: {b.percent}%
              </li>
            ))}
          </ul>
        </>
      )}
      {local.sources.length > 0 && (
        <>
          <p className="muted">Agents, skills, plugins and MCP servers:</p>
          <ul>
            {local.sources.slice(0, 5).map((s) => (
              <li key={s.name}>
                {s.name}: {s.percent}%
              </li>
            ))}
          </ul>
        </>
      )}
      {local.recommendations.length > 0 && (
        <>
          <p className="muted">Suggestions from the Engine:</p>
          <ul>
            {local.recommendations.map((r) => (
              <li key={r.title}>
                {r.title}
                {r.detail && <span className="muted"> ({r.detail})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
