import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Response, StudioShellEvent } from '@horizon/protocol';

interface Props {
  agentId: string;
  taskId: string;
  request(method: string, params: unknown, agentId: string): Promise<Response>;
  onShell(agentId: string, shellId: string, listener: (e: StudioShellEvent) => void): () => void;
  onClose(): void;
}

/** A shell console in the Task Directory. The shell lives as long as this panel. */
export function Shell({ agentId, taskId, request, onShell, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const term = new Terminal({ fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontSize: 13, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    fit.fit();
    let shellId: string | undefined;
    let disposed = false;
    let off = () => {};
    setEnded(undefined);

    request('shell.open', { taskId, cols: term.cols, rows: term.rows }, agentId).then((res) => {
      if ('error' in res) return setEnded(res.error.message);
      const id = (res.result as { shellId: string }).shellId;
      if (disposed) return void request('shell.close', { shellId: id }, agentId);
      shellId = id;
      off = onShell(agentId, id, (e) => {
        if (e.data) term.write(e.data);
        if (e.exit) {
          shellId = undefined;
          setEnded(e.exit.reason ?? `The shell exited with code ${e.exit.code}.`);
        }
      });
      term.focus();
    });
    term.onData((data) => shellId && request('shell.input', { shellId, data }, agentId));
    term.onResize(({ cols, rows }) => shellId && request('shell.resize', { shellId, cols, rows }, agentId));
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(box.current!);

    return () => {
      disposed = true;
      resize.disconnect();
      off();
      if (shellId) request('shell.close', { shellId }, agentId);
      term.dispose();
    };
  }, [agentId, taskId, attempt]);

  return (
    <section className="shell" aria-label="Shell">
      <div className="shell-head">
        <span>Shell in the Task Directory</span>
        {ended && (
          <>
            <span className="warn">{ended}</span>
            <button onClick={() => setAttempt((n) => n + 1)}>Open a new shell</button>
          </>
        )}
        <button onClick={onClose}>Close shell</button>
      </div>
      <div className="shell-term" ref={box} />
    </section>
  );
}
