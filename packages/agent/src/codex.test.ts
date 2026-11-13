import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexEnvironment, createCodexEngine } from './codex.ts';
import type { Engine, EngineOptions } from './engine.ts';
import type { SessionItem } from '@horizon/protocol';

const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
const engineFor = (scenario: string, platform?: NodeJS.Platform) =>
  createCodexEngine(() => spawn(process.execPath, [fixture, scenario]), platform);

test('app-server does not inherit desktop launch context or mutate caller environment', () => {
  const source = {
    PATH: 'path', CODEX_HOME: 'custom-home', CODEX_ACCESS_TOKEN: 'test-token',
    CODEX_WINDOWS_REGISTERED_CORE: 'parent-core', CODEX_APP_RUNTIME_CLI_PATH: 'parent-cli',
    CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe', CODEX_PERMISSION_PROFILE: 'parent-profile',
    CODEX_THREAD_ID: 'parent-thread', CODEX_SHELL: 'parent-shell',
  };
  assert.deepEqual(codexEnvironment(source), {
    PATH: 'path', CODEX_HOME: 'custom-home', CODEX_ACCESS_TOKEN: 'test-token',
  });
  assert.equal(source.CODEX_THREAD_ID, 'parent-thread');
});

test('Codex status reports login method, missing credentials, and missing executable', async () => {
  const models = [{ id: 'gpt-a', name: 'GPT A', isDefault: false }, { id: 'gpt-b', name: 'GPT B', isDefault: true }];
  assert.deepEqual(await engineFor('chatgpt').status!(), { status: 'ready', loginMethod: 'chatgpt', models });
  assert.deepEqual(await engineFor('apiKey').status!(), { status: 'ready', loginMethod: 'apiKey', models });
  assert.deepEqual(await engineFor('noCredentials').status!(), { status: 'no credentials' });
  // A provider that cannot list models is still ready, just without a model choice.
  assert.deepEqual(await engineFor('external').status!(), { status: 'ready' });
  const missing = createCodexEngine(() => spawn('horizon-missing-codex-executable-12345', []));
  assert.equal(await missing.status!(), 'not installed');
});

function turn(engine: Engine, overrides: Partial<EngineOptions> = {}) {
  const items: SessionItem[] = [];
  let exited = false;
  let threadId: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const run = engine({
    cwd: process.cwd(), permissionMode: 'ask',
    onExit: () => { exited = true; },
    onEngineSessionId: (id) => { threadId = id; },
    askPermission: async () => { throw new Error('Unexpected permission request'); },
    ...overrides,
    onItem: (item) => {
      items.push(item);
      if (item.kind === 'turn_end') finish();
    },
  });
  run.send('test');
  return { run, done, items, get exited() { return exited; }, get threadId() { return threadId; } };
}

for (const [scenario, error] of [
  ['error', 'Test failure'], ['interrupted', 'interrupted'],
  ['crash', 'exited'], ['malformed', 'Invalid message'],
  ['unsupported', undefined], ['completed', undefined],
] as const) {
  test(`Codex handles ${scenario}`, { timeout: 5_000 }, async (t) => {
    const result = turn(engineFor(scenario));
    t.after(() => result.run.close());
    await result.done;
    const end = result.items.at(-1);
    assert.equal(end?.kind, 'turn_end');
    if (end?.kind !== 'turn_end') return;
    if (error) {
      assert.ok(end.error?.includes(error), end.error);
      assert.equal(result.exited, true);
    } else {
      assert.equal(end.error, undefined);
      assert.equal(result.exited, false);
    }
    if (scenario === 'completed')
      assert.deepEqual(result.items, [{ kind: 'text', text: 'completed answer' }, { kind: 'turn_end' }]);
  });
}

for (const platform of ['win32', 'linux'] as const) {
  for (const mode of ['ask', 'auto'] as const) {
    test(`Codex ${mode} policy on ${platform}, including resume`, { timeout: 5_000 }, async (t) => {
      for (const resume of [undefined, 'thread-1']) {
        const result = turn(engineFor('policy', platform), { permissionMode: mode, resume });
        t.after(() => result.run.close());
        await result.done;
        const text = result.items[0];
        assert.equal(text.kind, 'text');
        if (text.kind !== 'text') return;
        const policy = JSON.parse(text.text);
        assert.equal(policy.approvalPolicy, mode === 'ask' ? 'untrusted' : 'never');
        assert.equal(policy.sandbox, mode === 'ask' ? 'workspace-write' : 'danger-full-access');
        assert.deepEqual(policy.config, platform === 'win32' && mode === 'ask'
          ? { 'windows.sandbox': 'unelevated' } : undefined);
        assert.equal(result.threadId, 'thread-1');
      }
    });
  }
}

for (const kind of ['command', 'file'] as const) {
  for (const [allow, always, decision] of [[true, false, 'accept'], [true, true, 'acceptForSession'], [false, false, 'decline']] as const) {
    test(`Codex ${kind} approval maps to ${decision}`, { timeout: 5_000 }, async (t) => {
      let requests = 0;
      const result = turn(engineFor('approval-' + kind), {
        askPermission: async (request) => {
          requests++;
          assert.equal(request.reason, 'test approval');
          if (kind === 'file') {
            const input = request.input as { paths: string[]; changes: unknown[]; command?: string };
            assert.deepEqual(input.paths, ['/task/index.html', '/task/old.css', '/task/site.css']);
            assert.deepEqual(input.changes, [
              { path: '/task/index.html', kind: { type: 'add' }, diff: '<h1>Hello</h1>\n' },
              { path: '/task/old.css', kind: { type: 'update', move_path: '/task/site.css' }, diff: '-old\n+new\n' },
            ]);
            assert.equal(input.command, undefined, 'file approvals do not carry a command');
          }
          return { allow, always };
        },
      });
      t.after(() => result.run.close());
      await result.done;
      assert.equal(requests, 1);
      assert.deepEqual(result.items.map((item) => item.kind), ['tool', 'tool_result', 'text', 'turn_end']);
      assert.deepEqual(result.items[2], { kind: 'text', text: decision });
      const output = result.items[1];
      assert.equal(output.kind === 'tool_result' && output.isError, !allow);
    });
  }
}

test('idle app-server exit signals onExit without an extra turn_end', { timeout: 5_000 }, async (t) => {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const result = turn(engineFor('idle-exit'), { onExit: exit });
  t.after(() => result.run.close());
  await result.done;
  await exited;
  assert.deepEqual(result.items, [{ kind: 'text', text: 'completed answer' }, { kind: 'turn_end' }]);
});

test('file approvals without matching item details fail without asking for blind approval', { timeout: 5_000 }, async (t) => {
  let requests = 0;
  const result = turn(engineFor('approval-file-missing'), {
    askPermission: async () => { requests++; return { allow: true, always: false }; },
  });
  t.after(() => result.run.close());
  await result.done;
  assert.equal(requests, 0);
  assert.deepEqual(result.items, [{ kind: 'turn_end', error: 'Codex file change details are unavailable. Send a new message to retry.' }]);
  assert.equal(result.exited, true);
});

test('resume errors other than a missing rollout do not start a new thread', { timeout: 5_000 }, async (t) => {
  const result = turn(engineFor('resume-error'), { resume: 'thread-1' });
  t.after(() => result.run.close());
  await result.done;
  assert.deepEqual(result.items, [{ kind: 'turn_end', error: 'Unable to read rollout: permission denied' }]);
  assert.equal(result.exited, true);
});

test('synchronous launch errors finish the turn and signal Engine exit', async () => {
  const engine = createCodexEngine(() => { throw new Error('Invalid launch configuration'); });
  assert.equal(await engine.status!(), 'unavailable');
  const result = turn(engine);
  await result.done;
  assert.deepEqual(result.items, [{ kind: 'turn_end', error: 'Invalid launch configuration' }]);
  assert.equal(result.exited, true);
  result.run.close();
});

test('Codex passes the model to the thread and each turn; a change applies from the next turn', { timeout: 10_000 }, async (t) => {
  const texts: string[] = [];
  let next!: () => void;
  let ended = new Promise<void>((resolve) => { next = resolve; });
  const run = engineFor('model')({
    cwd: process.cwd(), permissionMode: 'ask', model: 'gpt-a',
    onExit: () => {}, onEngineSessionId: () => {}, askPermission: async () => ({ allow: false, always: false }),
    onItem: (item) => {
      if (item.kind === 'text') texts.push(item.text);
      if (item.kind === 'turn_end') next();
    },
  });
  t.after(() => run.close());
  const turnWith = async (model?: string | null) => {
    if (model !== null) await run.setModel!(model);
    ended = new Promise<void>((resolve) => { next = resolve; });
    run.send('test');
    await ended;
    return JSON.parse(texts.at(-1)!);
  };
  assert.deepEqual(await turnWith(null), { thread: 'gpt-a', turn: 'gpt-a' });
  assert.deepEqual(await turnWith('gpt-c'), { thread: 'gpt-a', turn: 'gpt-c' });
  // Back to the default: Codex keeps a thread's last model, so the default is named explicitly.
  assert.deepEqual(await turnWith(undefined), { thread: 'gpt-a', turn: 'gpt-b' });
});

test('Codex modelNotFound ends the turn and reports the unavailable model', { timeout: 5_000 }, async (t) => {
  let unavailable = 0;
  const result = turn(engineFor('model-missing'), { onModelUnavailable: () => unavailable++ });
  t.after(() => result.run.close());
  await result.done;
  assert.deepEqual(result.items.at(-1), { kind: 'turn_end', error: 'The model is not available' });
  assert.equal(unavailable, 1);
});

test('Codex reports context usage after a turn and compacts the thread as a turn', { timeout: 10_000 }, async (t) => {
  const usages: unknown[] = [];
  const items: SessionItem[] = [];
  let next!: () => void;
  let ended = new Promise<void>((resolve) => { next = resolve; });
  const run = engineFor('usage')({
    cwd: process.cwd(), permissionMode: 'ask',
    onExit: () => {}, onEngineSessionId: () => {}, askPermission: async () => ({ allow: false, always: false }),
    onContext: (u) => usages.push(u),
    onItem: (item) => {
      items.push(item);
      if (item.kind === 'turn_end') next();
    },
  });
  t.after(() => run.close());
  run.send('test');
  await ended;
  assert.deepEqual(usages, [{ usedTokens: 1200, windowTokens: 200000 }]);
  ended = new Promise<void>((resolve) => { next = resolve; });
  run.compact!();
  await ended;
  assert.deepEqual(items.slice(-2), [{ kind: 'compact' }, { kind: 'turn_end' }]);
  assert.deepEqual(usages.at(-1), { usedTokens: 300, windowTokens: 200000 });
});

test('Codex usage maps plan limit windows and credits; an API key account has no plan limits', { timeout: 10_000 }, async () => {
  assert.deepEqual(await engineFor('chatgpt').usage!(), {
    plan: 'plus', limitsApply: true,
    limits: [{ name: '5-hour', percent: 42, resetsAt: new Date(1800000000 * 1000).toISOString() }, { name: '7-day', percent: 7 }],
    extra: { enabled: true, balance: '12.50' },
  });
  assert.deepEqual(await engineFor('apiKey').usage!(), { limitsApply: false, limits: [] });
});
