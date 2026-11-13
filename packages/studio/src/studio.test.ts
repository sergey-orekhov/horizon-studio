import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { AgentStatus, AgentsEvent, Response } from '@horizon/protocol';
import { startAgent } from '@horizon/agent';
import { startStudio } from './studio.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'horizon-studio-'));
const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;

test('Studio connects to the Agent through a Connection, shows status and relays requests', async () => {
  const agent = await startAgent(tmp(), 0, { engine: () => ({ send() {}, close() {} }) });
  const configFile = join(tmp(), 'config.json');
  const studio = await startStudio(configFile, 0);

  const browser = new WebSocket(`ws://127.0.0.1:${portOf(studio)}/ws`);
  const messages: (AgentsEvent | Response)[] = [];
  const waitFor = <T>(pred: (m: any) => boolean) =>
    new Promise<T>((resolve) => {
      const check = () => {
        const m = messages.find(pred);
        if (m) resolve(m as T);
        else setTimeout(check, 10);
      };
      check();
    });
  browser.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((r) => browser.once('open', r));

  const send = (id: number, method: string, params?: unknown, agentId?: string) =>
    browser.send(JSON.stringify({ type: 'request', id, method, params, agentId }));
  const agentWith = (state: AgentStatus['state']) => (m: any) => m.type === 'agents' && m.agents.some((a: AgentStatus) => a.state === state);

  send(1, 'connection.add', { name: 'local', port: portOf(agent.server), token: agent.adminToken });
  const { result } = await waitFor<{ result: { id: string } }>((m) => m.id === 1);
  const online = await waitFor<AgentsEvent>(agentWith('online'));
  assert.equal(online.agents[0].hello?.member.accessLevel, 'admin');
  assert.equal(online.agents[0].hello?.version, '0.1.0');
  assert.equal(online.agents[0].hello?.engines[0].status, 'ready');
  assert.ok(readFileSync(configFile, 'utf8').includes(agent.adminToken!), 'the Connection is saved to the config');

  send(2, 'agent.info', undefined, result.id);
  const relayed = await waitFor<Response>((m) => m.id === 2);
  assert.ok('result' in relayed);

  send(3, 'connection.add', { name: 'bad', port: portOf(agent.server), token: 'wrong' });
  await waitFor(agentWith('unauthorized'));

  browser.close();
  agent.server.close();
  studio.close();
});

test('Shell output goes only to the window that opened it, and closing that window ends the shell', { timeout: 20_000, skip: process.platform === 'win32' && 'uses a POSIX shell' }, async (t) => {
  const agent = await startAgent(tmp(), 0, { engine: () => ({ send() {}, close() {} }) });
  const studio = await startStudio(join(tmp(), 'config.json'), 0);
  t.after(() => (agent.stop(), studio.close()));

  const browser = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${portOf(studio)}/ws`);
    const messages: any[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    let id = 0;
    const call = async (method: string, params?: unknown, agentId?: string) => {
      const n = ++id;
      ws.send(JSON.stringify({ type: 'request', id: n, method, params, agentId }));
      while (!messages.some((m) => m.id === n)) await new Promise((r) => setTimeout(r, 10));
      return messages.find((m) => m.id === n) as Response;
    };
    return { ws, messages, call };
  };
  const a = await browser();
  const b = await browser();
  const { result } = (await a.call('connection.add', { name: 'local', port: portOf(agent.server), token: agent.adminToken })) as { result: { id: string } };
  const agentId = result.id;
  while (!a.messages.some((m) => m.type === 'agents' && m.agents[0]?.state === 'online')) await new Promise((r) => setTimeout(r, 10));

  const task = (await a.call('task.create', { name: 'shell' }, agentId)) as { result: { id: string } };
  const opened = (await a.call('shell.open', { taskId: task.result.id, cols: 80, rows: 24 }, agentId)) as { result: { shellId: string } };
  const { shellId } = opened.result;
  await a.call('shell.input', { shellId, data: "printf 'pid=%s\\n' $$\r" }, agentId);
  const shellText = () => a.messages.filter((m) => m.type === 'shell').map((m) => m.data ?? '').join('');
  while (!/pid=(\d+)/.test(shellText())) await new Promise((r) => setTimeout(r, 10));
  const pid = Number(shellText().match(/pid=(\d+)/)![1]);

  assert.ok(!b.messages.some((m) => m.type === 'shell'), 'another window gets no shell output');
  assert.ok('error' in (await b.call('shell.input', { shellId, data: 'x' }, agentId)), 'and cannot type into it');

  a.ws.close();
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (alive()) await new Promise((r) => setTimeout(r, 10));
  b.ws.close();
});
