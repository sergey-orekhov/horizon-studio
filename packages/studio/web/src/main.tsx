import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentStatus, EngineId, EngineModel, EngineStatus, PermissionMode, Task, TaskState } from '@horizon/protocol';
import { useStudio } from './studio.ts';
import { Chat } from './chat.tsx';
import { Members } from './members.tsx';
import { Shell } from './shell.tsx';
import { Context } from './context.tsx';
import { Usage } from './usage.tsx';
// Fonts ship with Studio: it must work without internet access.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './style.css';

const modeLabel: Record<PermissionMode, string> = {
  ask: 'ask for permission',
  auto: 'everything allowed',
};

const statusToState = { paused: 'paused', reopened: 'paused', completed: 'completed', resumed: 'active', interrupted: 'active' } as const;

const stateLabel: Record<AgentStatus['state'], string> = {
  connecting: 'connecting…',
  online: 'online',
  offline: 'offline',
  unauthorized: 'invalid token',
};

const engineName: Record<EngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const engineLabel: Record<EngineStatus, string> = {
  ready: 'Ready',
  'not installed': 'Not installed',
  'no credentials': 'No credentials',
  unavailable: 'Unavailable',
};
const loginLabel: Record<string, string> = { chatgpt: 'ChatGPT', apiKey: 'API key' };

/** The "no model chosen" option, naming the Engine's default when it says which. */
const defaultModelLabel = (models: EngineModel[]) => {
  const fallback = models.find((m) => m.isDefault);
  return fallback ? `Engine default (${fallback.name})` : 'Engine default';
};

/** The Session's model, changeable while the Task runs. Hidden if the Engine cannot list models. */
function ModelPicker(props: { model?: string; models?: EngineModel[]; nextTurn: boolean; disabled: boolean; onChange(model?: string): void }) {
  const { model, models, nextTurn, disabled, onChange } = props;
  if (!models?.length) return model ? <span className="muted">Model: {model}</span> : null;
  // A saved model the Engine no longer lists stays visible, so the picker never shows a wrong value.
  const listed = !model || models.some((m) => m.id === model);
  return (
    <label className="model" title={nextTurn ? 'Codex switches models from the next turn' : 'Applies at once'}>
      Model{' '}
      <select value={model ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{defaultModelLabel(models)}</option>
        {!listed && <option value={model}>{model}</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {nextTurn && <span className="muted"> from the next turn</span>}
    </label>
  );
}

const completedLast = (a: Task, b: Task) => Number(a.state === 'completed') - Number(b.state === 'completed');

function App() {
  const { agents, connected, tasks, setTasks, events, request, onShell } = useStudio();
  /** The Task whose shell panel is open, as `agentId taskId`. */
  const [shellFor, setShellFor] = useState<string>();
  const [selected, setSelected] = useState<{ agentId: string; taskId: string }>();
  const task = selected && tasks[selected.agentId]?.find((t) => t.id === selected.taskId);
  /** The Agent whose Members are open in the main panel instead of a Task. */
  const [membersOf, setMembersOf] = useState<string>();
  const membersAgent = agents.find((a) => a.id === membersOf && a.hello?.member.accessLevel === 'admin');
  /** Agent whose plan limits and usage are open in the main panel. */
  const [usageOf, setUsageOf] = useState<string>();
  const usageAgent = agents.find((a) => a.id === usageOf && a.hello?.member.accessLevel === 'admin');
  const [error, setError] = useState('');
  /** Agent Update progress per Agent; `pending` is the build whose result is awaited from the Agent. */
  const [updating, setUpdating] = useState<Record<string, { text: string; pending?: string }>>({});

  async function updateAgent(agentId: string) {
    setUpdating((u) => ({ ...u, [agentId]: { text: 'Uploading the build and installing dependencies…' } }));
    const res = await request('connection.update', { id: agentId });
    const r = 'result' in res ? (res.result as { status: 'current' | 'restarting'; build: string }) : undefined;
    const next = !r
      ? { text: `Error: ${'error' in res ? res.error.message : ''}` }
      : r.status === 'current'
        ? { text: `Already running ${r.build}` }
        : { text: `Restarting on ${r.build}…`, pending: r.build };
    setUpdating((u) => ({ ...u, [agentId]: next }));
  }

  const online = agents.filter((a) => a.state === 'online').map((a) => a.id).join();
  const loadTasks = async (agentId: string) => {
    const res = await request('task.list', undefined, agentId);
    if ('result' in res) setTasks((t) => ({ ...t, [agentId]: res.result as Task[] }));
  };
  // After this the Agent sends the list itself when it changes.
  useEffect(() => {
    online.split(',').filter(Boolean).forEach(loadTasks);
  }, [online]);
  const onlineAgents = agents.filter((a) => a.state === 'online');
  const engineChoices = onlineAgents.flatMap((agent) =>
    [...(agent.hello?.engines ?? [])].sort((a, b) => Number(a.id === 'codex') - Number(b.id === 'codex')).map((e) => ({
      key: JSON.stringify([agent.id, e.id]), agentId: agent.id, agentName: agent.name, engine: e.id,
      status: e.status, loginMethod: e.loginMethod, models: e.models,
    })),
  );
  const defaultChoice = engineChoices.find((choice) => choice.status === 'ready')?.key;
  const [newTaskChoice, setNewTaskChoice] = useState<string>();
  useEffect(() => setNewTaskChoice(undefined), [defaultChoice]);
  // An Agent without `permissionModes` predates the auto restriction (#41) and accepts auto from anyone.
  const newTaskSelection = engineChoices.find((choice) => choice.key === (newTaskChoice ?? defaultChoice));
  const newTaskAgentId = newTaskSelection?.agentId;
  const newTaskAuto = onlineAgents.find((a) => a.id === newTaskAgentId)?.hello?.permissionModes?.includes('auto') ?? true;

  // Subscribe to the selected Task's Session; after an Agent reconnect, subscribe again from the last seq.
  // The last Session works; earlier ones were reset and can be viewed read-only.
  const activeSession = task?.sessions.findLast((s) => !s.archived) ?? task?.sessions[0];
  const [viewSession, setViewSession] = useState<string>();
  useEffect(() => setViewSession(undefined), [selected?.taskId, activeSession?.id]);
  const viewed = task?.sessions.find((s) => s.id === viewSession) ?? activeSession;
  const sessionId = viewed?.id;
  const readOnly = !!viewed?.archived;
  const selectedHello = agents.find((a) => a.id === selected?.agentId)?.hello;
  const shellKey = selected && `${selected.agentId} ${selected.taskId}`;
  const agentOnline = !!selected && online.split(',').includes(selected.agentId);
  useEffect(() => {
    if (!selected || !sessionId || !agentOnline) return;
    const fromSeq = events[sessionId]?.at(-1)?.seq ?? 0;
    request('session.subscribe', { sessionId, fromSeq }, selected.agentId);
    return () => void request('session.unsubscribe', { sessionId }, selected.agentId);
  }, [sessionId, agentOnline]);

  async function createTask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const selection = engineChoices.find((choice) => choice.key === data.get('engineChoice'));
    if (!selection || selection.status !== 'ready') return;
    const { agentId, engine } = selection;
    const res = await request(
      'task.create',
      { name: data.get('name'), engine, permissionMode: data.get('permissionMode') || undefined, model: data.get('model') || undefined },
      agentId,
    );
    if ('error' in res) return setError(res.error.message);
    form.reset();
    await loadTasks(agentId); // so the Task is listed at once, without waiting for the event
    setSelected({ agentId, taskId: (res.result as Task).id });
    (setMembersOf(undefined), setUsageOf(undefined));
  }

  // Task state comes from Session events, so all Studios see it at once.
  const status = sessionId && !readOnly
    ? events[sessionId]?.findLast((e) => e.item.kind === 'status' && e.item.status in statusToState)?.item
    : undefined;
  const state: TaskState | undefined =
    status?.kind === 'status' ? statusToState[status.status as keyof typeof statusToState] : task?.state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [selected?.taskId, state]);

  async function act(method: 'pause' | 'resume' | 'complete' | 'reopen' | 'delete') {
    if (!selected || !task) return;
    const res = await request(`task.${method}`, { taskId: task.id }, selected.agentId);
    if ('error' in res) setError(res.error.message);
    else if (method === 'delete') setSelected(undefined);
  }

  async function addConnection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name)).trim() || undefined;
    const host = field('sshHost');
    const res = await request('connection.add', {
      name: String(data.get('name')),
      port: Number(data.get('port')),
      token: String(data.get('token')).trim(),
      ssh: host && { host, user: field('sshUser'), port: Number(field('sshPort')) || undefined, key: field('sshKey') },
    });
    if ('error' in res) setError(res.error.message);
    else {
      setError('');
      form.reset();
    }
  }

  return (
    <div className="layout">
      <aside>
        <h1>
          <img src="/favicon.png" alt="" width={24} height={24} />
          HorizonStudio
        </h1>
        {!connected && <p className="warn">No connection to the Studio server. Reconnecting…</p>}
        {agents.length === 0 && <p className="muted">Add a Connection to an Agent below.</p>}

        {engineChoices.length > 0 && (
          <form className="new-task" onSubmit={createTask}>
            <div>
              <input name="name" placeholder="New Task" required />
              <button className="primary" disabled={!defaultChoice} aria-label="Create Task">+</button>
            </div>
            <select
              name="engineChoice"
              aria-label="Engine and Agent"
              defaultValue={defaultChoice}
              key={defaultChoice}
              onChange={(e) => setNewTaskChoice(e.target.value)}
            >
              {engineChoices.map(({ key, agentName, engine, status, loginMethod }) => (
                <option key={key} value={key} disabled={status !== 'ready'}>
                  {engineName[engine]} · {agentName} — {engineLabel[status]}{loginMethod ? ` · ${loginLabel[loginMethod] ?? loginMethod}` : ''}
                </option>
              ))}
            </select>
            {!!newTaskSelection?.models?.length && (
              <select name="model" aria-label="Model" defaultValue="" key={newTaskSelection.key}>
                <option value="">Model: {defaultModelLabel(newTaskSelection.models)}</option>
                {newTaskSelection.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    Model: {m.name}
                  </option>
                ))}
              </select>
            )}
            <select name="permissionMode" aria-label="Permission Mode" defaultValue="">
              <option value="">Permissions: Agent default</option>
              <option value="ask">Ask for permission</option>
              {newTaskAuto && <option value="auto">Allow everything without asking</option>}
            </select>
          </form>
        )}


        {/* Tasks are grouped under their machine; an unreachable Agent's Tasks are not shown. */}
        {agents.map((a) => (
          <section key={a.id} className="machine">
            <div className="machine-head">
              <span className={`dot ${a.state}`} aria-hidden="true" />
              <strong>{a.name}</strong>
              <span className="muted">{stateLabel[a.state]}</span>
              <span className="machine-actions">
                {a.hello?.member.accessLevel === 'admin' && (
                  <button className="link" title="Plan limits and usage" onClick={() => (setUsageOf(a.id), setMembersOf(undefined))}>
                    Usage
                  </button>
                )}
                {a.hello?.member.accessLevel === 'admin' && (
                  <button className="link" title="Members and Access Tokens" onClick={() => (setMembersOf(a.id), setUsageOf(undefined))}>
                    Members
                  </button>
                )}
                <button className="link" title="Remove Connection" aria-label={`Remove Connection ${a.name}`} onClick={() => request('connection.remove', { id: a.id })}>
                  ×
                </button>
              </span>
            </div>
            {a.state === 'online' && (
              <ul className="tasks">
                {[...(tasks[a.id] ?? [])].sort((x, y) => completedLast(x, y) || x.createdAt.localeCompare(y.createdAt)).map((t) => (
                  <li key={t.id}>
                    <button
                      className={selected?.agentId === a.id && selected.taskId === t.id ? 'selected' : undefined}
                      aria-current={selected?.agentId === a.id && selected.taskId === t.id ? 'true' : undefined}
                      onClick={() => (setSelected({ agentId: a.id, taskId: t.id }), (setMembersOf(undefined), setUsageOf(undefined)))}
                    >
                      <span className="name">{t.name}</span>
                      {t.state !== 'active' && <span className="state">{t.state === 'paused' ? 'Paused' : 'Completed'}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="machine-details">
              {a.hello && (
                <p className="muted" title={a.hello.build ?? a.hello.version}>
                  v{a.hello.version} · signed in as {a.hello.member.name}
                </p>
              )}
              {a.ssh && (
                <p className="muted">
                  ssh {a.ssh.user ? `${a.ssh.user}@` : ''}
                  {a.ssh.host}
                </p>
              )}
              {a.error && <p className="warn">{a.error}</p>}
              {a.hello?.member.accessLevel === 'admin' && a.hello.build && (
                <p className="muted">
                  Build {a.hello.build}{' '}
                  <button className="link" title="Upload the local Agent build" onClick={() => updateAgent(a.id)}>
                    Update
                  </button>
                </p>
              )}
              {updating[a.id] && !(updating[a.id].pending && a.hello?.lastUpdate?.version === updating[a.id].pending) && (
                <p className="muted">{updating[a.id].text}</p>
              )}
              {a.hello?.lastUpdate && (
                <p className={a.hello.lastUpdate.ok ? 'muted' : 'warn'}>
                  {a.hello.lastUpdate.ok
                    ? `Updated to ${a.hello.lastUpdate.version}`
                    : `Update to ${a.hello.lastUpdate.version} failed: ${a.hello.lastUpdate.error}; rolled back to the previous version`}{' '}
                  ({new Date(a.hello.lastUpdate.at).toLocaleString()})
                </p>
              )}
              {a.state === 'online' &&
                a.hello?.engines.map((e) => (
                  <p key={e.id} className={e.status === 'ready' ? 'muted' : 'warn'}>
                    {engineName[e.id]}: {engineLabel[e.status]}{e.loginMethod && ` · ${loginLabel[e.loginMethod] ?? e.loginMethod}`}
                    {e.status === 'no credentials' && (e.id === 'codex'
                      ? <> · run <code>npx @openai/codex login</code> on the Agent machine</>
                      : ' · sign in to Claude Code on the Agent machine')}
                  </p>
                ))}
            </div>
          </section>
        ))}

        <details className="new-connection" open={agents.length === 0}>
          <summary>New Connection</summary>
          <form onSubmit={addConnection}>
            <input name="name" placeholder="Name" required />
            <input name="port" type="number" defaultValue={7400} min={1} max={65535} required aria-label="Agent port" />
            <input name="token" placeholder="Access Token" required autoComplete="off" />
            <fieldset>
              <legend>Remote Agent, through SSH</legend>
              <input name="sshHost" placeholder="Host (empty if the Agent is on this machine)" />
              <input name="sshUser" placeholder="User" />
              <input name="sshPort" type="number" min={1} max={65535} placeholder="SSH port (22)" />
              <input name="sshKey" placeholder="Key path (~/.ssh/id_ed25519)" />
            </fieldset>
            <button className="primary">Add</button>
          </form>
        </details>
        {error && <p className="warn">{error}</p>}
      </aside>

      <main>
        {usageAgent?.hello ? (
          <Usage
            key={usageAgent.id}
            engines={usageAgent.hello.engines.filter((e) => e.status === 'ready').map((e) => ({ id: e.id, name: engineName[e.id] }))}
            request={(method, params) => request(method, params, usageAgent.id)}
          />
        ) : membersAgent?.hello ? (
          <Members
            key={membersAgent.id}
            self={membersAgent.hello.member}
            request={(method, params) => request(method, params, membersAgent.id)}
          />
        ) : selected && task && sessionId ? (
          <>
            <header className="task-head">
              <h2>
                {task.name} · {engineName[task.engine]} <span className={`mode ${task.permissionMode}`}>{modeLabel[task.permissionMode]}</span>
              </h2>
              <ModelPicker
                model={activeSession?.model}
                models={selectedHello?.engines.find((e) => e.id === task.engine)?.models}
                nextTurn={task.engine === 'codex'}
                disabled={!agentOnline || state === 'completed'}
                onChange={async (model) => {
                  const res = await request('session.setModel', { sessionId: activeSession?.id, model: model ?? null }, selected.agentId);
                  if ('error' in res) setError(res.error.message);
                }}
              />
              {agentOnline && (
                <div className="task-actions">
                  {state === 'active' && <button onClick={() => act('pause')}>Pause</button>}
                  {state === 'paused' && <button onClick={() => act('resume')}>Resume</button>}
                  {state !== 'completed' && <button onClick={() => act('complete')}>Complete</button>}
                  {state === 'completed' && <button onClick={() => act('reopen')}>Reopen</button>}
                  {selectedHello?.member.accessLevel === 'admin' && state !== 'completed' && (
                    <button
                      disabled={!selectedHello.shell}
                      title={selectedHello.shell ? 'Open a shell in the Task Directory' : 'The shell console is unavailable on this Agent: node-pty could not be loaded'}
                      onClick={() => setShellFor(shellKey)}
                    >
                      Shell
                    </button>
                  )}
                  {state === 'completed' &&
                    (confirmDelete ? (
                      <button className="danger" onClick={() => act('delete')}>
                        Delete permanently?
                      </button>
                    ) : (
                      <button onClick={() => setConfirmDelete(true)}>Delete</button>
                    ))}
                </div>
              )}
            </header>
            {state === 'completed' && task.deleteAt && (
              <p className="muted">Task is completed and will be deleted on {new Date(task.deleteAt).toLocaleDateString()}.</p>
            )}
            {!agentOnline && <p className="warn">Agent is unreachable. The Session keeps running on it, and the history will load after reconnecting.</p>}
            {task.sessions.length > 1 && (
              <label className="session-pick">
                Session{' '}
                <select value={sessionId} onChange={(e) => setViewSession(e.target.value)}>
                  {task.sessions.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {s.archived ? `${i + 1}: before a reset, read-only` : `${i + 1}: current`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Context
              context={viewed?.context}
              totals={viewed?.totals}
              canCompact={!readOnly && agentOnline && state === 'active' && !!viewed?.context}
              canReset={!readOnly && agentOnline && state !== 'completed'}
              onCompact={async () => {
                const res = await request('session.compact', { sessionId }, selected.agentId);
                if ('error' in res) setError(res.error.message);
              }}
              onReset={async () => {
                const res = await request('task.reset', { taskId: task.id }, selected.agentId);
                if ('error' in res) setError(res.error.message);
                else await loadTasks(selected.agentId);
              }}
            />
            <Chat
              key={sessionId}
              readOnly={readOnly}
              events={events[sessionId] ?? []}
              state={state ?? 'active'}
              engine={task.engine}
              engineName={engineName[task.engine]}
              onSend={async (text) => {
                const res = await request('session.send', { sessionId, text }, selected.agentId);
                if ('error' in res) {
                  setError(res.error.message);
                  return false;
                }
                return true;
              }}
              onAnswer={(requestId, allow, always) =>
                request('session.answer', { sessionId, requestId, allow, always }, selected.agentId)
              }
            />
            {shellFor === shellKey && agentOnline && (
              <Shell agentId={selected.agentId} taskId={task.id} request={request} onShell={onShell} onClose={() => setShellFor(undefined)} />
            )}
          </>
        ) : (
          <p className="muted">Select or create a Task.</p>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
