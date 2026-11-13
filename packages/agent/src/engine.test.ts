import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { query, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeEngine } from './engine.ts';
import type { SessionItem } from '@horizon/protocol';

for (const failure of ['exception', 'result'] as const) {
  test(`Claude ${failure} signals exit; a new instance receives the saved conversation ID`, { timeout: 5_000 }, async () => {
    let launches = 0;
    const resumes: (string | undefined)[] = [];
    const runQuery = (({ prompt, options }) => {
      const launch = ++launches;
      resumes.push(options?.resume);
      assert.notEqual(typeof prompt, 'string');
      const messages = (async function* () {
        if (typeof prompt === 'string') return;
        for await (const _ of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'claude-thread' } as SDKMessage;
          if (launch === 1) {
            if (failure === 'exception') throw new Error('SDK process died');
            yield { type: 'result', subtype: 'error_during_execution' } as SDKMessage;
          } else {
            yield { type: 'result', subtype: 'success' } as SDKMessage;
          }
        }
      })();
      return Object.assign(messages, { close() { void messages.return(); } }) as unknown as Query;
    }) as typeof query;
    const engine = createClaudeEngine(runQuery);
    const items: SessionItem[] = [];
    let resume: string | undefined;
    let exit!: () => void;
    let ended = new Promise<void>((resolve) => { exit = resolve; });
    const opts = () => ({
      cwd: process.cwd(), permissionMode: 'ask' as const, resume,
      onItem: (item: SessionItem) => items.push(item),
      onExit: () => exit(), onEngineSessionId: (id: string) => { resume = id; },
      askPermission: async () => ({ allow: false, always: false }),
    });
    const first = engine(opts());
    first.send('first');
    await ended;
    assert.equal(items.at(-1)?.kind, 'turn_end');
    assert.ok(items.at(-1)?.kind === 'turn_end' && 'error' in items.at(-1)!);
    first.close();
    ended = new Promise<void>((resolve) => { exit = resolve; });
    const second = engine(opts());
    second.send('retry');
    // The successful streaming process remains open for the next message.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumes, [undefined, 'claude-thread']);
    assert.deepEqual(items.at(-1), { kind: 'turn_end' });
    second.close();
  });
}

test('Claude: the model goes to the SDK, setModel delegates, and model_not_found ends the turn and reports it', { timeout: 5_000 }, async () => {
  let model: string | undefined;
  const switched: (string | undefined)[] = [];
  const runQuery = (({ prompt, options }) => {
    model = options?.model;
    const messages = (async function* () {
      if (typeof prompt === 'string') return;
      for await (const _ of prompt) {
        yield { type: 'system', subtype: 'init', session_id: 'claude-thread' } as SDKMessage;
        yield { type: 'assistant', error: 'model_not_found', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'synthetic' }] } } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: true, result: 'There is an issue with the selected model' } as SDKMessage;
      }
    })();
    return Object.assign(messages, { close() { void messages.return(); }, async setModel(m?: string) { switched.push(m); } }) as unknown as Query;
  }) as typeof query;
  const items: SessionItem[] = [];
  let reported!: () => void;
  const unavailable = new Promise<void>((resolve) => { reported = resolve; });
  const run = createClaudeEngine(runQuery)({
    cwd: process.cwd(), permissionMode: 'ask', model: 'sonnet',
    onItem: (item) => items.push(item), onExit: () => {}, onEngineSessionId: () => {},
    onModelUnavailable: () => reported(),
    askPermission: async () => ({ allow: false, always: false }),
  });
  assert.equal(model, 'sonnet');
  await run.setModel!('opus');
  assert.deepEqual(switched, ['opus']);
  run.send('hi');
  await unavailable;
  assert.deepEqual(items, [{ kind: 'turn_end', error: 'There is an issue with the selected model' }], 'the synthetic message is not shown');
  run.close();
});

test('Claude: /compact compacts as a turn, and context usage is measured after each turn', { timeout: 5_000 }, async () => {
  const inputs: string[] = [];
  const runQuery = (({ prompt }) => {
    const messages = (async function* () {
      if (typeof prompt === 'string') return;
      for await (const m of prompt) {
        const text = (m as { message: { content: string } }).message.content;
        inputs.push(text);
        yield { type: 'system', subtype: 'init', session_id: 'claude-thread' } as SDKMessage;
        if (text === '/compact')
          yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 21541, post_tokens: 9066 } } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: false, result: '' } as SDKMessage;
      }
    })();
    return Object.assign(messages, {
      close() { void messages.return(); },
      async getContextUsage() {
        return { totalTokens: inputs.length === 1 ? 21528 : 9066, rawMaxTokens: 1000000, maxTokens: 1000000, percentage: 2,
          categories: [{ id: 'messages', name: 'Messages', tokens: 8634, kind: 'used', color: 'x' }] };
      },
    }) as unknown as Query;
  }) as typeof query;
  const items: SessionItem[] = [];
  const usages: unknown[] = [];
  let measured!: () => void;
  let next = new Promise<void>((resolve) => { measured = resolve; });
  const run = createClaudeEngine(runQuery)({
    cwd: process.cwd(), permissionMode: 'ask',
    onItem: (item) => items.push(item), onExit: () => {}, onEngineSessionId: () => {},
    onContext: (u) => (usages.push(u), measured()),
    askPermission: async () => ({ allow: false, always: false }),
  });
  run.send('hi');
  await next;
  next = new Promise<void>((resolve) => { measured = resolve; });
  run.compact!();
  await next;
  assert.deepEqual(inputs, ['hi', '/compact']);
  assert.deepEqual(items, [{ kind: 'turn_end' }, { kind: 'compact', preTokens: 21541, postTokens: 9066 }, { kind: 'turn_end' }]);
  assert.deepEqual(usages, [
    { usedTokens: 21528, windowTokens: 1000000, categories: [{ name: 'Messages', tokens: 8634, kind: 'used' }] },
    { usedTokens: 9066, windowTokens: 1000000, categories: [{ name: 'Messages', tokens: 8634, kind: 'used' }] },
  ]);
  run.close();
});
