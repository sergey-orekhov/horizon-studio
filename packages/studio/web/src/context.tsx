import { useEffect, useState } from 'react';
import type { ContextUsage } from '@horizon/protocol';

const tokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();

interface Props {
  context?: ContextUsage;
  /** Compact and reset are offered only for the working Session of a Task that is not completed. */
  canCompact: boolean;
  canReset: boolean;
  onCompact(): void;
  onReset(): void;
}

/** How full the Session's context window is, with compact and reset. */
export function Context({ context, canCompact, canReset, onCompact, onReset }: Props) {
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => setConfirmReset(false), [canReset]);
  const size = context?.windowTokens;
  const used = context ? (size ? `${tokens(context.usedTokens)} of ${tokens(size)} tokens (${Math.round((context.usedTokens / size) * 100)}%)` : `${tokens(context.usedTokens)} tokens`) : 'not measured yet';
  const breakdown = context?.categories?.filter((c) => c.tokens > 0);

  return (
    <div className="context">
      <span>Context: {used}</span>
      {context && size && <meter min={0} max={size} value={context.usedTokens} aria-label="Context window used" />}
      {context && <span className="muted">measured {new Date(context.at).toLocaleTimeString()}</span>}
      {breakdown && breakdown.length > 0 && (
        <details>
          <summary>What fills it</summary>
          <table>
            <tbody>
              {breakdown.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{c.tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <span className="context-actions">
        {canCompact && (
          <button title="Replace the conversation with a summary and keep working" onClick={onCompact}>
            Compact
          </button>
        )}
        {canReset &&
          (confirmReset ? (
            <button className="danger" onClick={() => (setConfirmReset(false), onReset())}>
              Start a new Session?
            </button>
          ) : (
            <button title="Continue the Task in a new Session with an empty context" onClick={() => setConfirmReset(true)}>
              Reset context
            </button>
          ))}
      </span>
    </div>
  );
}
