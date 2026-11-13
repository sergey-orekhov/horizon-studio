import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { SessionEvent, SessionItem, Task } from '@horizon/protocol';
import { startAgent } from './agent.ts';
import type { Engine } from './engine.ts';
import { createCodexEngine } from './codex.ts';

function connect(port: number, token: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${token}` } });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
  });
}

for (const engineId of ['claude-code', 'codex'] as const) {
  test(`${engineId}: a dead Engine is replaced on the next user message`, async (t) => {
    let launches = 0;
    const dying: Engine = (opts) => {
      const launch = ++launches;
      let dead = false;
      return {
        send() {
          if (dead) return;
          setImmediate(() => {
            opts.onEngineSessionId('saved-thread');
            if (launch === 1) {
              dead = true;
              opts.onItem({ kind: 'turn_end', error: 'process exited' });
              opts.onExit();
            } else {
              assert.equal(opts.resume, 'saved-thread');
              opts.onItem({ kind: 'text', text: 'restarted' });
              opts.onItem({ kind: 'turn_end' });
            }
          });
        },
        close() { dead = true; },
      };
    };
    const home = mkdtempSync(join(tmpdir(), 'horizon-exit-test-'));
    const agent = await startAgent(home, 0, { engine: dying, codexEngine: dying });
    t.after(() => agent.stop());
    const c = client(await connect((agent.server.address() as AddressInfo).port, agent.adminToken!));
    t.after(() => c.close());
    const task: Task = await c.call('task.create', { name: 'Crash recovery', engine: engineId });
    const sessionId = task.sessions[0].id;
    await c.call('session.subscribe', { sessionId });
    await c.call('session.send', { sessionId, text: 'first' });
    await c.until(2);
    await c.call('session.send', { sessionId, text: 'retry' });
    assert.equal(launches, 2, 'must not send the retry into a dead Engine');
    const events = await c.until(5);
    assert.deepEqual(events[3].item, { kind: 'text', text: 'restarted' });
    assert.equal((await c.call('task.list'))[0].state, 'active');
  });
}

test('first start issues an admin token, agent.info works with it, an unknown token is rejected', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const noCredentials: Engine = Object.assign(() => ({ send() {}, close() {} }), { status: async () => 'no credentials' as const });
  const { server, adminToken } = await startAgent(home, 0, { engine: noCredentials });
  const { port } = server.address() as AddressInfo;
  assert.ok(adminToken);
  assert.ok(!readFileSync(join(home, 'members.json'), 'utf8').includes(adminToken), 'the token is not stored in plain text');

  const ws = await connect(port, adminToken);
  ws.send(JSON.stringify({ type: 'request', id: 1, method: 'agent.info' }));
  const data = await new Promise<WebSocket.RawData>((r) => ws.once('message', r));
  const res = JSON.parse(String(data));
  assert.equal(res.id, 1);
  assert.equal(res.result.member.accessLevel, 'admin');
  assert.deepEqual(res.result.engines, [{ id: 'claude-code', status: 'no credentials' }]);
  ws.close();

  await assert.rejects(connect(port, 'wrong'), /401/);

  // Starting again on the same Agent Home does not create a new admin.
  server.close();
  const again = await startAgent(home, 0, { engine: noCredentials });
  assert.equal(again.adminToken, undefined);
  again.server.close();
});

/** Fake Engine: echoes back and remembers which resume value it was started with. */
const resumes: (string | undefined)[] = [];
const echo: Engine = ({ resume, onItem, onEngineSessionId }) => {
  resumes.push(resume);
  onEngineSessionId('engine-session-1');
  return {
    send: (text) => setImmediate(() => (onItem({ kind: 'text', text: `echo: ${text}` }), onItem({ kind: 'turn_end' }))),
    close: () => {},
  };
};

function client(ws: WebSocket) {
  let id = 0;
  const events: SessionEvent[] = [];
  const pending = new Map<number, (r: any) => void>();
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'event') events.push(m);
    else pending.get(m.id)?.(m);
  });
  const call = (method: string, params?: unknown) =>
    new Promise<any>((r) => {
      pending.set(++id, r);
      ws.send(JSON.stringify({ type: 'request', id, method, params }));
    }).then((m) => m.result);
  const until = async (n: number) => {
    const deadline = Date.now() + 5_000;
    while (events.length < n) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${n} Session events, received ${events.length}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    return events;
  };


  return { call, until, close: () => ws.close() };
}

test('Task: creation, Session with history by seq, continuing after an Agent restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));

  const task: Task = await c1.call('task.create', { name: 'OAuth' });
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'hello' });
  const events = await c1.until(3);
  assert.deepEqual(events.map((e) => [e.seq, e.item.kind]), [[1, 'user'], [2, 'text'], [3, 'turn_end']]);
  assert.deepEqual(events[1].item, { kind: 'text', text: 'echo: hello' });
  c1.close();
  a1.server.close();

  // New Agent process on the same Agent Home: the Task is there, history keeps its seq, the Engine continues the conversation.
  const a2 = await startAgent(home, 0, { engine: echo });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list')).length, 1);
  await c2.call('session.subscribe', { sessionId, fromSeq: 1 });
  assert.deepEqual((await c2.until(2)).map((e) => e.seq), [2, 3]);
  await c2.call('session.send', { sessionId, text: 'more' });
  assert.equal((await c2.until(4))[3].seq, 5);
  assert.deepEqual(resumes, [undefined, 'engine-session-1']);
  c2.close();
  a2.server.close();
});

/** Fake Engine: asks for permission to run Bash on every message and reports the decision. */
const asker: Engine = ({ onItem, askPermission }) => ({
  send: async () => {
    const { allow, always } = await askPermission({ tool: 'Bash', input: { command: 'ls' } });
    onItem({ kind: 'text', text: allow ? `allowed${always ? ' always' : ''}` : 'denied' });
    onItem({ kind: 'turn_end' });
  },
  close: () => {},
});

test('Permission Mode: ask waits for the user, auto allows on its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a = await startAgent(home, 0, { engine: asker, defaultPermissionMode: 'auto' });
  const c = client(await connect((a.server.address() as AddressInfo).port, a.adminToken!));

  const ask: Task = await c.call('task.create', { name: 'ask', permissionMode: 'ask' });
  assert.equal(ask.permissionMode, 'ask');
  const askSession = ask.sessions[0].id;
  await c.call('session.subscribe', { sessionId: askSession, fromSeq: 0 });
  await c.call('session.send', { sessionId: askSession, text: 'go' });
  const [, request] = await c.until(2);
  assert.equal(request.item.kind, 'permission');
  const requestId = (request.item as { requestId: string }).requestId;
  await c.call('session.answer', { sessionId: askSession, requestId, allow: true, always: true });
  const events = await c.until(5);
  assert.deepEqual(events.slice(2).map((e) => e.item), [
    { kind: 'permission_answer', requestId, allow: true, always: true },
    { kind: 'text', text: 'allowed always' },
    { kind: 'turn_end' },
  ]);
  assert.equal(await c.call('session.answer', { sessionId: askSession, requestId, allow: true }), undefined, 'a repeated answer is rejected');

  const auto: Task = await c.call('task.create', { name: 'auto' });
  assert.equal(auto.permissionMode, 'auto', 'the default comes from the Agent config');
  await c.call('session.subscribe', { sessionId: auto.sessions[0].id, fromSeq: 0 });
  await c.call('session.send', { sessionId: auto.sessions[0].id, text: 'go' });
  const autoEvents = (await c.until(8)).slice(5);
  assert.deepEqual(autoEvents.map((e) => e.item.kind), ['user', 'text', 'turn_end']);
  assert.deepEqual(autoEvents[1].item, { kind: 'text', text: 'allowed' });

  c.close();
  a.server.close();
});

test('Pause stops the Engine mid-turn and survives a restart; resuming asks the Engine to finish', async () => {
  const log: string[] = [];
  const slow: Engine = ({ resume, onItem, onEngineSessionId }) => {
    log.push(`start resume=${resume}`);
    onEngineSessionId('conv-1');
    return {
      send: (text) => {
        log.push(`send ${text.slice(0, 15)}`);
        setImmediate(() => onItem({ kind: 'text', text: 'working…' })); // the turn never ends
      },
      close: () => log.push('close'),
    };
  };
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: slow });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const task: Task = await c1.call('task.create', { name: 'long' });
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'do it' });
  await c1.until(2);

  assert.equal((await c1.call('task.pause', { taskId: task.id })).state, 'paused');
  assert.deepEqual((await c1.until(3))[2].item, { kind: 'status', status: 'paused' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'more' }), undefined, 'messages are not accepted while paused');
  c1.close();
  a1.server.close();

  // After an Agent restart the Task stays paused and does not continue on its own.
  const a2 = await startAgent(home, 0, { engine: slow });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.equal((await c2.call('task.list'))[0].state, 'paused');
  assert.deepEqual(log, ['start resume=undefined', 'send do it', 'close']);

  await c2.call('session.subscribe', { sessionId, fromSeq: 3 });
  assert.equal((await c2.call('task.resume', { taskId: task.id })).state, 'active');
  const events = await c2.until(3);
  assert.deepEqual(events[0].item, { kind: 'status', status: 'resumed' });
  assert.equal(events[1].item.kind, 'user');
  assert.deepEqual(log.slice(3), ['start resume=conv-1', 'send [HorizonStudio]']);
  c2.close();
  a2.server.close();
});

test('Completing, reopening, deleting manually and by retention period', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const kept: Task = await c1.call('task.create', { name: 'kept' });
  const doomed: Task = await c1.call('task.create', { name: 'doomed' });
  const sessionId = kept.sessions[0].id;
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });

  assert.equal(await c1.call('task.delete', { taskId: kept.id }), undefined, 'an active Task cannot be deleted');
  const done: Task = await c1.call('task.complete', { taskId: kept.id });
  assert.equal(done.state, 'completed');
  assert.equal(Date.parse(done.deleteAt!) - Date.parse(done.completedAt!), 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual((await c1.until(1))[0].item, { kind: 'status', status: 'completed' });
  assert.equal(await c1.call('session.send', { sessionId, text: 'x' }), undefined, 'a completed Task does not accept messages');
  assert.equal(await c1.call('task.pause', { taskId: kept.id }), undefined, 'from completed, only reopen is allowed');

  const reopened: Task = await c1.call('task.reopen', { taskId: kept.id });
  assert.equal(reopened.state, 'paused');
  assert.equal(reopened.deleteAt, undefined);
  assert.equal((await c1.call('task.resume', { taskId: kept.id })).state, 'active');

  await c1.call('task.complete', { taskId: doomed.id });
  assert.equal(await c1.call('task.delete', { taskId: doomed.id }), null);
  assert.ok(!existsSync(join(home, 'tasks', doomed.id)), 'the Task directory is deleted');
  assert.deepEqual((await c1.call('task.list')).map((t: Task) => t.name), ['kept']);

  await c1.call('task.complete', { taskId: kept.id });
  c1.close();
  a1.server.close();

  // With a retention period of 0 days, the Agent deletes a completed Task at startup.
  const a2 = await startAgent(home, 0, { engine: echo, completedRetentionDays: 0 });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  assert.deepEqual(await c2.call('task.list'), []);
  assert.ok(!existsSync(join(home, 'tasks', kept.id)));
  c2.close();
  a2.server.close();
});

test('After an Agent restart interrupted Sessions continue on their own, paused Tasks do not', async () => {
  const starts: string[] = [];
  // "ask" hangs on a permission request; otherwise the turn never ends.
  const stuck: Engine = ({ resume, onItem, onEngineSessionId, askPermission }) => {
    onEngineSessionId(`conv-${starts.length}`);
    starts.push(`resume=${resume}`);
    return {
      send: (text) => {
        if (text === 'ask') void askPermission({ tool: 'Bash', input: {} });
        else setImmediate(() => onItem({ kind: 'text', text: `got: ${text.slice(0, 15)}` }));
      },
      close: () => {},
    };
  };
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: stuck });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const working: Task = await c1.call('task.create', { name: 'working', permissionMode: 'ask' });
  const asking: Task = await c1.call('task.create', { name: 'asking', permissionMode: 'ask' });
  const paused: Task = await c1.call('task.create', { name: 'paused' });
  await c1.call('session.send', { sessionId: working.sessions[0].id, text: 'do it' });
  await c1.call('session.send', { sessionId: asking.sessions[0].id, text: 'ask' });
  await c1.call('session.send', { sessionId: paused.sessions[0].id, text: 'do it' });
  await c1.call('task.pause', { taskId: paused.id });
  await new Promise((r) => setTimeout(r, 20));
  c1.close();
  a1.server.close(); // a "crash": the Agent process disappears mid-turn

  const a2 = await startAgent(home, 0, { engine: stuck });
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  await c2.call('session.subscribe', { sessionId: working.sessions[0].id, fromSeq: 2 });
  const w = await c2.until(3);
  assert.deepEqual(w[0].item, { kind: 'status', status: 'interrupted' });
  assert.match((w[1].item as { text: string }).text, /^\[HorizonStudio\] Agent was restarted/);
  assert.deepEqual(w[2].item, { kind: 'text', text: 'got: [HorizonStudio]' });

  await c2.call('session.subscribe', { sessionId: asking.sessions[0].id, fromSeq: 2 });
  const q = (await c2.until(6)).slice(3);
  assert.equal(q[0].item.kind, 'permission_answer', 'the pending permission request is cleared');
  assert.deepEqual(q[1].item, { kind: 'status', status: 'interrupted' });

  assert.equal((await c2.call('task.list')).find((t: Task) => t.id === paused.id).state, 'paused');
  // 3 starts before the restart plus one for each of the two interrupted Sessions, all with resume.
  assert.deepEqual(starts.slice(3).sort(), ['resume=conv-0', 'resume=conv-1']);
  c2.close();
  a2.server.close();
});

test('Member: admin creates users and tokens, a user sees only their own Tasks, revoking a token closes the connection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a = await startAgent(home, 0, { engine: echo });
  const port = (a.server.address() as AddressInfo).port;
  const adminWs = await connect(port, a.adminToken!);
  const admin = client(adminWs);
  const { id: bobId, token: bobToken } = await admin.call('member.create', { name: 'bob', accessLevel: 'user' });
  const bobWs = await connect(port, bobToken);
  const bob = client(bobWs);
  assert.equal(await bob.call('member.list'), undefined, 'a user cannot manage Members');

  // The Agent sends each connection its own Task list when something changes.
  const lastTasks = (ws: WebSocket) => {
    let last: Task[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'tasks') last = m.tasks;
    });
    return () => last.map((t) => t.name).sort();
  };
  const adminSees = lastTasks(adminWs);
  const bobSees = lastTasks(bobWs);
  await admin.call('task.create', { name: 'admin task' });
  await bob.call('task.create', { name: 'bob task' });
  while (adminSees().length < 2 || bobSees().length < 1) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(adminSees(), ['admin task', 'bob task']);
  assert.deepEqual(bobSees(), ['bob task']);
  assert.deepEqual((await bob.call('task.list')).map((t: Task) => t.name), ['bob task']);
  assert.deepEqual((await admin.call('task.list')).map((t: Task) => t.name).sort(), ['admin task', 'bob task']);

  const { token: bobToken2 } = await admin.call('member.issueToken', { memberId: bobId });
  const listed = await admin.call('member.list');
  const bobInfo = listed.find((m: any) => m.id === bobId);
  assert.equal(bobInfo.tokens.length, 2);
  assert.ok(!JSON.stringify(listed).includes('hash'), 'token hashes are not returned');

  const closed = new Promise((r) => bobWs.once('close', r));
  assert.equal(await admin.call('member.revokeToken', { memberId: bobId, tokenId: bobInfo.tokens[0].id }), null);
  await closed;
  await assert.rejects(connect(port, bobToken), /401/);
  client(await connect(port, bobToken2)).close();

  // The last admin token cannot be revoked.
  const adminInfo = listed.find((m: any) => m.accessLevel === 'admin');
  assert.equal(await admin.call('member.revokeToken', { memberId: adminInfo.id, tokenId: adminInfo.tokens[0].id }), undefined);
  admin.close();
  a.stop();
});

test('Agent Update: PUT /update installs the build and asks the Launcher to restart; admin only, and only under the Launcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  let restarts = 0;
  const a = await startAgent(home, 0, { engine: echo, restart: () => restarts++ });
  const url = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}/update`;
  const build = JSON.stringify({ package: { version: '9.9.9' }, agent: 'console.log("new")' });
  const put = (token: string) => fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: build });

  const admin = client(await connect((a.server.address() as AddressInfo).port, a.adminToken!));
  const { token: userToken } = await admin.call('member.create', { name: 'u', accessLevel: 'user' });
  admin.close();
  assert.equal((await put(userToken)).status, 403);

  const res = await put(a.adminToken!);
  const body = await res.json();
  assert.equal(body.status, 'restarting');
  assert.match(body.build, /^9\.9\.9-[0-9a-f]{8}$/);
  assert.equal(readFileSync(join(home, 'next'), 'utf8'), body.build);
  assert.equal(readFileSync(join(home, 'versions', body.build, 'agent.mjs'), 'utf8'), 'console.log("new")');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(restarts, 1);
  a.stop();

  const plain = await startAgent(mkdtempSync(join(tmpdir(), 'horizon-agent-')), 0, { engine: echo });
  const r = await fetch(`http://127.0.0.1:${(plain.server.address() as AddressInfo).port}/update`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${plain.adminToken}` },
    body: build,
  });
  assert.equal(r.status, 409, 'updating is not possible without the Launcher');
  plain.stop();
});

test('Codex: Engine selection, completed items, approvals and resume after restart', { timeout: 15_000 }, async (t) => {
  const script = `
    const { createInterface } = require('node:readline');
    const assert = require('node:assert/strict');
    const write = (message) => console.log(JSON.stringify(message));
    const notify = (method, params) => write({ method, params: { threadId: 'codex-thread', ...params } });
    let initialized = false;
    let resumed = false;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, method, params, result } = JSON.parse(line);
      const reply = (result) => write({ id, result });
      switch (method) {
        case 'initialize':
          assert.equal(params.clientInfo.name, 'horizon_studio');
          return reply({});
        case 'initialized':
          initialized = true;
          return;
        case 'account/read':
          assert.equal(initialized, true);
          return reply({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
        case 'thread/resume':
          assert.equal(params.threadId, 'codex-thread');
          resumed = true;
        case 'thread/start':
          assert.equal(initialized, true);
          assert.equal(params.approvalPolicy, 'untrusted');
          assert.equal(params.sandbox, 'workspace-write');
          return reply({ thread: { id: 'codex-thread' } });
        case 'turn/start':
          assert.equal(params.threadId, 'codex-thread');
          reply({ turn: { id: 'turn' } });
          if (resumed) {
            notify('item/agentMessage/delta', { itemId: 'answer2', delta: 'ignored' });
            notify('item/completed', { item: { type: 'agentMessage', id: 'answer2', text: 'resumed' } });
            return notify('turn/completed', { turn: { status: 'completed' } });
          }
          notify('item/started', { item: { type: 'commandExecution', id: 'tool', command: 'ls' } });
          return write({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
            threadId: 'codex-thread', itemId: 'tool', availableDecisions: ['accept', 'acceptForSession', 'decline'],
          } });
        default:
          assert.equal(id, 'approval');
          notify('item/completed', { item: { type: 'commandExecution', id: 'tool', status: 'completed', exitCode: 0 } });
          notify('item/agentMessage/delta', { itemId: 'answer', delta: result.decision });
          notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: result.decision } });
          return notify('turn/completed', { turn: { status: 'completed' } });
      }
    });
  `;
  const codexEngine = createCodexEngine((cwd) => spawn(process.execPath, ['-e', script], { cwd }));
  const home = mkdtempSync(join(tmpdir(), 'horizon-codex-test-'));
  const a1 = await startAgent(home, 0, { engine: echo, codexEngine });
  t.after(() => a1.stop());
  const token = a1.adminToken!;
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, token));
  t.after(() => c1.close());
  assert.deepEqual((await c1.call('agent.info')).engines, [
    { id: 'claude-code', status: 'ready' }, { id: 'codex', status: 'ready', loginMethod: 'chatgpt' },
  ]);
  assert.equal((await c1.call('task.create', { name: 'default' })).engine, 'claude-code');
  assert.equal(await c1.call('task.create', { name: 'invalid', engine: 'invalid' }), undefined);
  const task: Task = await c1.call('task.create', { name: 'Codex', engine: 'codex', permissionMode: 'ask' });
  assert.equal(task.engine, 'codex');
  const sessionId = task.sessions[0].id;
  await c1.call('session.subscribe', { sessionId });
  await c1.call('session.send', { sessionId, text: 'first' });
  const events = await c1.until(2);
  const permission = events[1].item;
  assert.equal(permission.kind, 'permission');
  assert.equal(await c1.call('session.send', { sessionId, text: 'while busy' }), undefined);
  await c1.call('session.answer', { sessionId, requestId: permission.requestId, allow: true, always: true });
  await c1.until(7);
  assert.deepEqual(events.map(({ item }) => item.kind),
    ['user', 'permission', 'permission_answer', 'tool', 'tool_result', 'text', 'turn_end']);
  assert.deepEqual(events[5].item, { kind: 'text', text: 'acceptForSession' });
  await c1.call('session.send', { sessionId, text: 'second' });
  await c1.until(9);
  const nextPermission = events[8].item;
  assert.equal(nextPermission.kind, 'permission');
  await c1.call('session.answer', { sessionId, requestId: nextPermission.requestId, allow: false });
  await c1.until(14);
  assert.deepEqual(events[12].item, { kind: 'text', text: 'decline' });
  c1.close();
  a1.stop();

  const a2 = await startAgent(home, 0, { engine: echo, codexEngine });
  t.after(() => a2.stop());
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, token));
  t.after(() => c2.close());
  assert.equal((await c2.call('task.list')).find((entry: Task) => entry.id === task.id).engine, 'codex');
  await c2.call('session.subscribe', { sessionId, fromSeq: 14 });
  await c2.call('session.send', { sessionId, text: 'second' });
  const resumed = await c2.until(3);
  assert.deepEqual(resumed[1].item, { kind: 'text', text: 'resumed' });
  assert.deepEqual(resumed[2].item, { kind: 'turn_end' });
});

test('Codex app-server crash is resumed by Session on the next message', { timeout: 10_000 }, async (t) => {
  let launches = 0;
  const fixture = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url));
  const codexEngine = Object.assign(createCodexEngine(() =>
    spawn(process.execPath, [fixture, launches++ === 0 ? 'crash' : 'missing-rollout'])), {
    status: async () => 'ready' as const,
  });
  const home = mkdtempSync(join(tmpdir(), 'horizon-process-exit-'));
  const agent = await startAgent(home, 0, { engine: echo, codexEngine });
  t.after(() => agent.stop());
  const c = client(await connect((agent.server.address() as AddressInfo).port, agent.adminToken!));
  t.after(() => c.close());
  const task: Task = await c.call('task.create', { name: 'Real subprocess crash', engine: 'codex' });
  const sessionId = task.sessions[0].id;
  await c.call('session.subscribe', { sessionId });
  await c.call('session.send', { sessionId, text: 'crash' });
  const events = await c.until(2);
  assert.equal(events[1].item.kind, 'turn_end');
  await c.call('session.send', { sessionId, text: 'retry' });
  await c.until(5);
  assert.equal(launches, 2);
  assert.deepEqual(events[3].item, { kind: 'text', text: 'crash\n\nretry' }, 'replay the original instructions and the retry');
  const stored = JSON.parse(readFileSync(join(home, 'tasks', task.id, 'task.json'), 'utf8'));
  assert.equal(stored.sessions[0].engineSessionId, 'thread-recovered');
  assert.deepEqual(events.flatMap(({ item }) => item.kind === 'user' ? [item.text] : []), ['crash', 'retry']);
  await c.call('session.send', { sessionId, text: 'next message' });
  await c.until(8);
  assert.deepEqual(events[6].item, { kind: 'text', text: 'next message' }, 'restore input only for the replacement thread');
  assert.equal(launches, 2);
});


for (const engineId of ['claude-code', 'codex'] as const) {
  test(`${engineId}: pause before thread creation replays input without duplicating history`, async (t) => {
    const prompts: string[] = [];
    const slow: Engine = () => ({ send(text) { prompts.push(text); }, close() {} });
    const home = mkdtempSync(join(tmpdir(), 'horizon-early-pause-'));
    const agent = await startAgent(home, 0, { engine: slow, codexEngine: slow });
    t.after(() => agent.stop());
    const c = client(await connect((agent.server.address() as AddressInfo).port, agent.adminToken!));
    t.after(() => c.close());
    const task: Task = await c.call('task.create', { name: 'Early pause', engine: engineId });
    await c.call('session.subscribe', { sessionId: task.sessions[0].id });
    await c.call('session.send', { sessionId: task.sessions[0].id, text: 'original task instructions' });
    await c.call('task.pause', { taskId: task.id });
    await c.call('task.resume', { taskId: task.id });
    assert.deepEqual(prompts, ['original task instructions', 'original task instructions']);
    const events = await c.until(3);
    assert.deepEqual(events.map((event) => event.item), [
      { kind: 'user', text: 'original task instructions' },
      { kind: 'status', status: 'paused' }, { kind: 'status', status: 'resumed' },
    ]);
  });

  test(`${engineId}: Agent restart before thread creation replays input once in history`, async (t) => {
    const prompts: string[] = [];
    const slow: Engine = () => ({ send(text) { prompts.push(text); }, close() {} });
    const home = mkdtempSync(join(tmpdir(), 'horizon-early-restart-'));
    const first = await startAgent(home, 0, { engine: slow, codexEngine: slow });
    const c1 = client(await connect((first.server.address() as AddressInfo).port, first.adminToken!));
    t.after(() => { c1.close(); first.stop(); });
    const task: Task = await c1.call('task.create', { name: 'Early restart', engine: engineId });
    const sessionId = task.sessions[0].id;
    await c1.call('session.send', { sessionId, text: 'original task instructions' });
    c1.close();
    first.stop();
    const second = await startAgent(home, 0, { engine: slow, codexEngine: slow });
    t.after(() => second.stop());
    const c2 = client(await connect((second.server.address() as AddressInfo).port, first.adminToken!));
    t.after(() => c2.close());
    await c2.call('session.subscribe', { sessionId });
    const events = await c2.until(2);
    assert.deepEqual(prompts, ['original task instructions', 'original task instructions']);
    assert.deepEqual(events.map(({ item }) => item), [
      { kind: 'user', text: 'original task instructions' }, { kind: 'status', status: 'interrupted' },
    ]);
  });
}


test('Task creation defaults to the first ready Engine and rejects unavailable Engines', async (t) => {
  let claudeReady = false;
  let codexReady = true;
  const claude = Object.assign((opts: Parameters<Engine>[0]) => echo(opts), {
    status: async () => claudeReady ? 'ready' as const : 'no credentials' as const,
  });
  const codexEngine = Object.assign((opts: Parameters<Engine>[0]) => echo(opts), {
    status: async () => codexReady ? 'ready' as const : 'not installed' as const,
  });
  const home = mkdtempSync(join(tmpdir(), 'horizon-engine-choice-'));
  const agent = await startAgent(home, 0, { engine: claude, codexEngine });
  t.after(() => agent.stop());
  const c = client(await connect((agent.server.address() as AddressInfo).port, agent.adminToken!));
  t.after(() => c.close());
  assert.equal(await c.call('task.create', { name: 'Explicit unavailable', engine: 'claude-code' }), undefined);
  assert.equal((await c.call('task.create', { name: 'Default Codex' })).engine, 'codex');
  claudeReady = true;
  assert.equal((await c.call('task.create', { name: 'Default Claude' })).engine, 'claude-code');
  claudeReady = false;
  codexReady = false;
  assert.equal(await c.call('task.create', { name: 'None ready' }), undefined);
  assert.equal((await c.call('task.list')).length, 2);
});

test('Permission Mode auto: admin only unless allowUserAuto; user auto Tasks switch to ask at startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine: echo, defaultPermissionMode: 'auto' });
  const port1 = (a1.server.address() as AddressInfo).port;
  const admin1 = client(await connect(port1, a1.adminToken!));
  const { token: bobToken } = await admin1.call('member.create', { name: 'bob', accessLevel: 'user' });
  const bob1 = client(await connect(port1, bobToken));

  assert.equal((await admin1.call('agent.info')).permissionModes.join(), 'ask,auto');
  assert.equal((await bob1.call('agent.info')).permissionModes.join(), 'ask');
  assert.equal((await admin1.call('task.create', { name: 'admin auto', permissionMode: 'auto' })).permissionMode, 'auto');
  assert.equal(await bob1.call('task.create', { name: 'bob auto', permissionMode: 'auto' }), undefined, 'a user cannot choose auto');
  assert.equal((await bob1.call('task.create', { name: 'bob default' })).permissionMode, 'ask', 'the auto default does not apply to a user');
  admin1.close();
  bob1.close();
  a1.stop();

  // With allowUserAuto, a user can create an auto Task.
  const a2 = await startAgent(home, 0, { engine: echo, allowUserAuto: true });
  const bob2 = client(await connect((a2.server.address() as AddressInfo).port, bobToken));
  assert.equal((await bob2.call('agent.info')).permissionModes.join(), 'ask,auto');
  const bobAuto: Task = await bob2.call('task.create', { name: 'bob auto', permissionMode: 'auto' });
  assert.equal(bobAuto.permissionMode, 'auto');
  bob2.close();
  a2.stop();

  // Without it again, the user's auto Task switches to ask at startup and its Session records why; the admin's stays auto.
  const a3 = await startAgent(home, 0, { engine: echo });
  const stored = (id: string) => JSON.parse(readFileSync(join(home, 'tasks', id, 'task.json'), 'utf8'));
  assert.equal(stored(bobAuto.id).permissionMode, 'ask');
  const log = readFileSync(join(home, 'tasks', bobAuto.id, 'sessions', `${bobAuto.sessions[0].id}.jsonl`), 'utf8');
  assert.match(log, /"status":"auto_disabled"/);
  const adminAuto = readdirSync(join(home, 'tasks')).map(stored).find((t) => t.name === 'admin auto');
  assert.equal(adminAuto.permissionMode, 'auto');
  a3.stop();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (done: () => boolean) => {
  while (!done()) await new Promise((r) => setTimeout(r, 10));
};

test('Shell: admin only, starts in the Task Directory, ends with its connection and when the Task completes', { timeout: 20_000, skip: process.platform === 'win32' && 'uses a POSIX shell' }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a = await startAgent(home, 0, { engine: echo });
  t.after(() => a.stop());
  const port = (a.server.address() as AddressInfo).port;
  const adminWs = await connect(port, a.adminToken!);
  const output = new Map<string, string>();
  const exited = new Set<string>();
  adminWs.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type !== 'shell') return;
    if (m.data) output.set(m.shellId, (output.get(m.shellId) ?? '') + m.data);
    if (m.exit) exited.add(m.shellId);
  });
  const admin = client(adminWs);
  assert.equal((await admin.call('agent.info')).shell, true);
  const task: Task = await admin.call('task.create', { name: 'shell' });

  // The shell prints its directory and pid; the pattern skips the echoed command line.
  const probe = async (shellId: string) => {
    await admin.call('shell.input', { shellId, data: "printf 'cwd=%s pid=%s\\n' \"$(pwd -P)\" $$\r" });
    const found = () => (output.get(shellId) ?? '').match(/cwd=(\/\S+) pid=(\d+)/);
    await waitUntil(() => !!found());
    return { cwd: found()![1], pid: Number(found()![2]) };
  };
  const { shellId } = await admin.call('shell.open', { taskId: task.id, cols: 80, rows: 24 });
  const first = await probe(shellId);
  assert.equal(first.cwd, realpathSync(join(home, 'tasks', task.id, 'workspace')));
  assert.equal(await admin.call('shell.resize', { shellId, cols: 120, rows: 40 }), null);

  const { token: bobToken } = await admin.call('member.create', { name: 'bob', accessLevel: 'user' });
  const bob = client(await connect(port, bobToken));
  const bobTask: Task = await bob.call('task.create', { name: 'bob task' });
  assert.equal(await bob.call('shell.open', { taskId: bobTask.id, cols: 80, rows: 24 }), undefined, 'a user cannot open a shell');
  assert.equal(await bob.call('shell.input', { shellId, data: 'x' }), undefined, 'nor use one opened by another connection');
  bob.close();

  // Completing the Task ends its shell, and a completed Task has none.
  await admin.call('task.complete', { taskId: task.id });
  await waitUntil(() => exited.has(shellId) && !alive(first.pid));
  assert.equal(await admin.call('shell.open', { taskId: task.id, cols: 80, rows: 24 }), undefined, 'a completed Task has no shell');

  // A paused Task has one, and it ends when its connection closes.
  await admin.call('task.reopen', { taskId: task.id });
  const second = await probe((await admin.call('shell.open', { taskId: task.id, cols: 80, rows: 24 })).shellId);
  admin.close();
  await waitUntil(() => !alive(second.pid));
});

test('Model: chosen at creation, switched mid-run, kept across a restart; an unavailable model pauses the Task', { timeout: 20_000 }, async (t) => {
  const starts: (string | undefined)[] = [];
  const switched: (string | undefined)[] = [];
  const sent: string[] = [];
  const models = [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2', isDefault: true }];
  const engine: Engine = Object.assign(
    (opts: Parameters<Engine>[0]) => {
      starts.push(opts.model);
      opts.onEngineSessionId('engine-model-session');
      return {
        send: (text: string) => {
          sent.push(text);
          setImmediate(() => {
            if (text === 'unavailable') {
              opts.onItem({ kind: 'turn_end', error: 'The model is not available' });
              opts.onModelUnavailable?.();
            } else (opts.onItem({ kind: 'text', text: 'ok' }), opts.onItem({ kind: 'turn_end' }));
          });
        },
        close: () => {},
        async setModel(model: string | undefined) {
          if (model === 'bogus') throw new Error("Model 'bogus' not found");
          switched.push(model);
        },
      };
    },
    { status: async () => ({ status: 'ready' as const, models }) },
  );
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  assert.deepEqual((await c1.call('agent.info')).engines[0].models, models);
  const task: Task = await c1.call('task.create', { name: 'model', model: 'm1' });
  const sessionId = task.sessions[0].id;
  assert.equal(task.sessions[0].model, 'm1');
  await c1.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c1.call('session.send', { sessionId, text: 'hi' });
  await c1.until(3);
  assert.deepEqual(starts, ['m1']);

  assert.equal(await c1.call('session.setModel', { sessionId, model: 'm2' }), null);
  assert.equal(await c1.call('session.setModel', { sessionId, model: 'bogus' }), undefined, 'an unknown model is rejected');
  const modelOf = async () => (await c1.call('task.list')).find((x: Task) => x.id === task.id).sessions[0].model;
  assert.equal(await modelOf(), 'm2');
  assert.equal(await c1.call('session.setModel', { sessionId, model: null }), null);
  assert.equal(await modelOf(), undefined, 'null returns to the Engine default');
  assert.equal(await c1.call('session.setModel', { sessionId, model: 'm1' }), null);
  assert.deepEqual(switched, ['m2', undefined, 'm1'], 'the running Engine switches at once');
  const changes = (await c1.until(6)).filter((e) => e.item.kind === 'model').map((e) => e.item);
  assert.deepEqual(changes, [{ kind: 'model', model: 'm2' }, { kind: 'model' }, { kind: 'model', model: 'm1' }]);
  c1.close();
  a1.stop();

  // After a restart the Session starts with its saved model.
  const a2 = await startAgent(home, 0, { engine });
  t.after(() => a2.stop());
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  t.after(() => c2.close());
  await c2.call('session.subscribe', { sessionId, fromSeq: 0 });
  await c2.call('session.send', { sessionId, text: 'unavailable' });
  const paused = async () => (await c2.call('task.list')).find((x: Task) => x.id === task.id).state === 'paused';
  while (!(await paused())) await new Promise((r) => setTimeout(r, 10));
  assert.equal(starts.at(-1), 'm1');
  const items = (await c2.until(9)).map((e) => e.item);
  assert.deepEqual(items.slice(-2), [{ kind: 'turn_end', error: 'The model is not available' }, { kind: 'status', status: 'paused' }]);

  // After choosing another model, resuming continues the failed turn.
  await c2.call('session.setModel', { sessionId, model: 'm2' });
  await c2.call('task.resume', { taskId: task.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(starts.at(-1), 'm2');
  assert.match(sent.at(-1)!, /^\[HorizonStudio\] The Task was resumed/);
});

test('Context: measured after each turn and kept across a restart; compact runs as a turn; reset starts a new Session', { timeout: 20_000 }, async (t) => {
  const starts: (string | undefined)[] = [];
  const engine: Engine = (opts) => {
    starts.push(opts.model);
    const turn = (items: SessionItem[], used: number) => setImmediate(() => {
      opts.onEngineSessionId('ctx-session');
      for (const item of items) opts.onItem(item);
      opts.onContext?.({ usedTokens: used, windowTokens: 1000 });
    });
    return {
      send: () => turn([{ kind: 'text', text: 'ok' }, { kind: 'turn_end' }], 600),
      compact: () => turn([{ kind: 'compact', preTokens: 600, postTokens: 100 }, { kind: 'turn_end' }], 100),
      close: () => {},
    };
  };
  const home = mkdtempSync(join(tmpdir(), 'horizon-agent-'));
  const a1 = await startAgent(home, 0, { engine });
  const c1 = client(await connect((a1.server.address() as AddressInfo).port, a1.adminToken!));
  const task: Task = await c1.call('task.create', { name: 'context', model: 'm1' });
  const first = task.sessions[0].id;
  const sessionsOf = async (c: typeof c1) => (await c.call('task.list')).find((x: Task) => x.id === task.id).sessions as Task['sessions'];
  const waitFor = async (c: typeof c1, done: (s: Task['sessions']) => boolean) => {
    while (!done(await sessionsOf(c))) await new Promise((r) => setTimeout(r, 10));
    return sessionsOf(c);
  };
  assert.equal(await c1.call('session.compact', { sessionId: first }), undefined, 'nothing to compact before the first turn');
  await c1.call('session.subscribe', { sessionId: first, fromSeq: 0 });
  await c1.call('session.send', { sessionId: first, text: 'hi' });
  let sessions = await waitFor(c1, (s) => s[0].context?.usedTokens === 600);
  assert.equal(sessions[0].context?.windowTokens, 1000);
  assert.ok(sessions[0].context?.at);

  assert.equal(await c1.call('session.compact', { sessionId: first }), null);
  await waitFor(c1, (s) => s[0].context?.usedTokens === 100);
  const history = (await c1.until(5)).map((e) => e.item);
  assert.deepEqual(history.slice(-2), [{ kind: 'compact', preTokens: 600, postTokens: 100 }, { kind: 'turn_end' }]);
  await c1.call('task.pause', { taskId: task.id });
  assert.equal(await c1.call('session.compact', { sessionId: first }), undefined, 'a paused Task cannot compact');
  c1.close();
  a1.stop();

  // The last measurement survives a restart, without starting an Engine.
  const a2 = await startAgent(home, 0, { engine });
  t.after(() => a2.stop());
  const c2 = client(await connect((a2.server.address() as AddressInfo).port, a1.adminToken!));
  t.after(() => c2.close());
  const startsBefore = starts.length;
  assert.equal((await sessionsOf(c2))[0].context?.usedTokens, 100);
  assert.equal(starts.length, startsBefore);

  // Reset: a new Session with the same model takes over; the old one is archived and read-only.
  const reset: Task = await c2.call('task.reset', { taskId: task.id });
  assert.equal(reset.sessions.length, 2);
  assert.deepEqual([reset.sessions[0].archived, reset.sessions[1].archived], [true, undefined]);
  assert.equal(reset.sessions[1].model, 'm1');
  assert.equal(reset.sessions[1].context, undefined, 'the new Session starts empty');
  await c2.call('task.resume', { taskId: task.id });
  assert.equal(await c2.call('session.send', { sessionId: first, text: 'x' }), undefined, 'the archived Session is read-only');
  const second = reset.sessions[1].id;
  await c2.call('session.send', { sessionId: second, text: 'hi' });
  await waitFor(c2, (s) => s[1].context?.usedTokens === 600);
  assert.equal(starts.at(-1), 'm1');
  const old = readFileSync(join(home, 'tasks', task.id, 'sessions', `${first}.jsonl`), 'utf8');
  assert.match(old, /"status":"reset"/, 'the old history is kept and marked');
});
