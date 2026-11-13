import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AccountUsage, LocalUsage, SessionTotals } from '@horizon/protocol';

type ClaudeUsage = Awaited<ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>;
type ClaudeWindow = { utilization: number | null; resets_at: string | null } | null | undefined;
type ClaudeLocal = NonNullable<ClaudeUsage['behaviors']>['day'];

/**
 * The only call to Claude Code's experimental usage API, which may change in any SDK release.
 * `skipBehaviors` skips the scan of local transcripts.
 */
export async function readClaudeUsage(q: Query, skipBehaviors: boolean): Promise<{ account: Omit<AccountUsage, 'at'>; totals: SessionTotals }> {
  const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors });
  const r = u.rate_limits;
  const window = (name: string, w: ClaudeWindow) =>
    w && w.utilization != null ? [{ name, percent: w.utilization, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) }] : [];
  const limits = r
    ? [
        ...window('5-hour', r.five_hour),
        ...window('7-day', r.seven_day),
        ...window('7-day Opus', r.seven_day_opus),
        ...window('7-day Sonnet', r.seven_day_sonnet),
        ...window('7-day OAuth apps', r.seven_day_oauth_apps),
        ...(r.model_scoped ?? []).flatMap((m) => window(`7-day ${m.display_name}`, m)),
      ]
    : [];
  const extra = r?.extra_usage;
  const local = (d: ClaudeLocal): LocalUsage => ({
    requests: d.request_count,
    sessions: d.session_count,
    behaviors: d.behaviors.map((b) => ({ key: b.key, percent: b.pct })),
    recommendations: (d.recommendations ?? []).map((x) => ({ title: x.title, ...(x.detail ? { detail: x.detail } : {}), percent: x.pct })),
    sources: [...d.agents, ...d.skills, ...d.plugins, ...d.mcp_servers]
      .map((x) => ({ name: x.name, percent: x.pct }))
      .sort((a, b) => b.percent - a.percent),
  });
  return {
    account: {
      ...(u.subscription_type ? { plan: u.subscription_type } : {}),
      limitsApply: u.rate_limits_available,
      limits,
      ...(extra
        ? {
            extra: {
              enabled: extra.is_enabled,
              ...(extra.used_credits != null ? { used: extra.used_credits } : {}),
              ...(extra.monthly_limit != null ? { limit: extra.monthly_limit } : {}),
              ...(extra.utilization != null ? { percent: extra.utilization } : {}),
              ...(extra.currency ? { currency: extra.currency } : {}),
            },
          }
        : {}),
      ...(u.behaviors ? { local: { day: local(u.behaviors.day), week: local(u.behaviors.week) } } : {}),
    },
    totals: {
      costUsd: u.session.total_cost_usd,
      durationMs: u.session.total_duration_ms,
      apiDurationMs: u.session.total_api_duration_ms,
      linesAdded: u.session.total_lines_added,
      linesRemoved: u.session.total_lines_removed,
    },
  };
}

/** Adds the totals of an Engine process to what earlier processes of the Session used. */
export function addTotals(base: SessionTotals | undefined, more: SessionTotals): SessionTotals {
  const sum: SessionTotals = { ...base };
  for (const key of Object.keys(more) as (keyof SessionTotals)[]) {
    const value = more[key];
    if (value !== undefined) sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}
