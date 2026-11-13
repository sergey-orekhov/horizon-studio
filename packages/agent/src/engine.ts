import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AccountUsage, ContextUsage, EngineAvailability, EngineStatus, PermissionMode, SessionItem, SessionTotals } from '@horizon/protocol';
import { readClaudeUsage } from './usage.ts';

/** A running Engine for one Session. */
export interface EngineRun {
  send(text: string): void;
  close(): void;
  /** Switches the model of the running Engine; `undefined` returns to the Engine's default. Rejects an unknown model. */
  setModel?(model: string | undefined): Promise<void>;
  /** Compacts the conversation as a turn: it ends with `turn_end`. */
  compact?(): void;
}

export interface EngineOptions {
  cwd: string;
  permissionMode: PermissionMode;
  /** Engine conversation id to continue. */
  resume?: string;
  /** The model to use; `undefined` means the Engine's default. */
  model?: string;
  /** Recorded user input to restore only if the saved Engine conversation has no rollout. */
  initialInput?: string;
  onItem(item: SessionItem): void;
  onEngineSessionId(id: string): void;
  /** The process has ended. Future messages must start a new Engine. */
  onExit(): void;
  /** The model is not available for this account; called after the failed turn has ended. */
  onModelUnavailable?(): void;
  /** The context window as measured after a turn. */
  onContext?(usage: Omit<ContextUsage, 'at'>): void;
  /** After a turn: what this Engine process has used, and the account's plan limits. */
  onUsage?(usage: { totals?: SessionTotals; account?: Omit<AccountUsage, 'at'> }): void;
  /** Decision on a permission request; `always` means do not ask about this again in this Session. */
  askPermission(req: { tool: string; input: unknown; reason?: string }): Promise<{ allow: boolean; always: boolean }>;
}

export interface Engine {
  (opts: EngineOptions): EngineRun;
  /** Whether the Engine is ready on this machine; without a check it counts as ready. */
  status?(): Promise<EngineStatus | EngineAvailability>;
  /** The account's plan limits and usage, from a short-lived Engine process. */
  usage?(): Promise<Omit<AccountUsage, 'at'>>;
}

/** Claude Code through the Claude Agent SDK, in streaming input mode: one process per Session. */
export function createClaudeEngine(runQuery: typeof query = query): Engine {
  const engine: Engine = (opts) => {
    let closed = false;
    let awaitingTurn = false;
    const inbox = new Inbox<SDKUserMessage>();
    const q = runQuery({
      prompt: inbox,
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        model: opts.model,
        // The Engine asks questions as plain text at the end of a turn, and the user answers in the chat.
        disallowedTools: ['AskUserQuestion'],
        canUseTool: async (tool, input, { suggestions, decisionReason }) => {
          const { allow, always } = await opts.askPermission({ tool, input, reason: decisionReason });
          return allow
            ? { behavior: 'allow', updatedInput: input, updatedPermissions: always ? suggestions : undefined }
            : { behavior: 'deny', message: 'The user denied this action' };
        },
      },
    });

    (async () => {
      try {
        let modelUnavailable = false;
        for await (const msg of q) {
          if (msg.type === 'assistant' && msg.error === 'model_not_found') modelUnavailable = true;
          toItems(msg, opts);
          if (msg.type === 'result') {
            awaitingTurn = false;
            if (modelUnavailable) {
              modelUnavailable = false;
              opts.onModelUnavailable?.();
            }
            // The summary is cheap (milliseconds) and still breaks the window down by category.
            if (opts.onContext && !closed)
              q.getContextUsage({ detail: 'summary' }).then(
                (u) => opts.onContext?.({
                  usedTokens: u.totalTokens,
                  windowTokens: u.rawMaxTokens,
                  categories: u.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
                }),
                () => {},
              );
            if (opts.onUsage && !closed)
              readClaudeUsage(q, true).then(({ account, totals }) => opts.onUsage?.({ account, totals }), () => {});
            if (msg.subtype !== 'success') break;
          }
        }
        if (!closed && awaitingTurn) opts.onItem({ kind: 'turn_end', error: 'Claude Code process exited' });
      } catch (e) {
        if (!closed) opts.onItem({ kind: 'turn_end', error: e instanceof Error ? e.message : String(e) });
      } finally {
        inbox.end();
        try { q.close(); } finally { if (!closed) opts.onExit(); }
      }
    })();

    return {
      send(text) {
        awaitingTurn = true;
        inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      },
      close() {
        closed = true;
        inbox.end();
        q.close();
      },
      setModel: (model) => q.setModel(model),
      // Claude Code runs slash commands sent as input; /compact replaces the history with a summary.
      compact() {
        awaitingTurn = true;
        inbox.push({ type: 'user', message: { role: 'user', content: '/compact' }, parent_tool_use_id: null });
      },
    };
  };

  /** Claude Code starts without a prompt and reports which account it runs under. */
  engine.status = async () => {
    let q: Query | undefined;
    try {
      q = runQuery({ prompt: new Inbox<SDKUserMessage>() }); // throws at once without the Claude Code binary
      const a = await q.accountInfo();
      // Third-party providers (Bedrock, Vertex…) authenticate outside Claude Code, so they count as ready.
      const firstParty = (a.apiProvider ?? 'firstParty') === 'firstParty';
      if (firstParty && a.tokenSource === 'none' && !a.apiKeySource) return 'no credentials';
      // `default` is Claude Code's own name for "no model chosen", which Studio offers separately.
      const models = (await q.supportedModels()).filter((m) => m.value !== 'default').map((m) => ({ id: m.value, name: m.displayName }));
      return { status: 'ready', models };
    } catch {
      return 'not installed';
    } finally {
      q?.close();
    }
  };

  engine.usage = async () => {
    const q = runQuery({ prompt: new Inbox<SDKUserMessage>() });
    try {
      return (await readClaudeUsage(q, false)).account;
    } finally {
      q.close();
    }
  };

  return engine;
}

export const claudeCode = createClaudeEngine();

function toItems(msg: SDKMessage, opts: EngineOptions) {
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') opts.onEngineSessionId(msg.session_id);
      if (msg.subtype === 'compact_boundary')
        opts.onItem({ kind: 'compact', preTokens: msg.compact_metadata.pre_tokens, postTokens: msg.compact_metadata.post_tokens });
      return;
    case 'assistant':
      if (msg.parent_tool_use_id) return; // subagent events are not shown yet
      if (msg.error) return; // a synthetic message; the turn ends with the error
      for (const b of msg.message.content) {
        if (b.type === 'text') opts.onItem({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') opts.onItem({ kind: 'tool', id: b.id, name: b.name, input: b.input });
      }
      return;
    case 'user': {
      if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return;
      for (const b of msg.message.content) {
        if (b.type !== 'tool_result') continue;
        const output =
          typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        opts.onItem({ kind: 'tool_result', id: b.tool_use_id, output, isError: !!b.is_error });
      }
      return;
    }
    case 'result':
      if (msg.subtype !== 'success') opts.onItem({ kind: 'turn_end', error: msg.subtype });
      else opts.onItem(msg.is_error ? { kind: 'turn_end', error: msg.result } : { kind: 'turn_end' });
      return;
  }
}

/** Async queue: the SDK reads user messages from it. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private done = false;

  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }

  end() {
    this.done = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
    }
  }
}
