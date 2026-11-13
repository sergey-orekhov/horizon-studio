import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire as createPtyRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { ShellEvent } from '@horizon/protocol';

type NodePty = typeof import('node-pty');
let pty: Promise<NodePty | undefined> | undefined;

/**
 * node-pty is an optional dependency: on Linux it is compiled at install time, and a failed build
 * must not break the Agent. Without it the shell console is unavailable.
 */
export function loadPty(): Promise<NodePty | undefined> {
  return (pty ??= import('node-pty').then(
    (m) => {
      // node-pty 1.1.0 ships its macOS spawn-helper without the executable bit, so every spawn fails.
      try {
        const helper = join(dirname(createPtyRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
        if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
      } catch {
        // The spawn itself reports the problem.
      }
      return (m as { default?: NodePty }).default ?? m;
    },
    () => undefined,
  ));
}

const shellCommand = () => (process.platform === 'win32' ? 'powershell.exe' : userInfo().shell || '/bin/sh');

interface Shell {
  pty: IPty;
  taskId: string;
  owner: object;
}

/** Shell consoles in Task Directories. Each belongs to the connection that opened it. */
export class Shells {
  private shells = new Map<string, Shell>();

  async open(owner: object, taskId: string, cwd: string, cols: number, rows: number, send: (e: ShellEvent) => void): Promise<string> {
    const nodePty = await loadPty();
    if (!nodePty) throw new Error('The shell console is unavailable on this Agent: node-pty could not be loaded. See the README for its build requirements.');
    const shellId = randomUUID();
    const p = nodePty.spawn(shellCommand(), [], { name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string> });
    this.shells.set(shellId, { pty: p, taskId, owner });
    p.onData((data) => send({ type: 'shell', shellId, data }));
    p.onExit(({ exitCode }) => {
      this.shells.delete(shellId);
      send({ type: 'shell', shellId, exit: { code: exitCode } });
    });
    return shellId;
  }

  /** The shell, if it belongs to this connection. */
  get(owner: object, shellId: string): IPty | undefined {
    const s = this.shells.get(shellId);
    return s?.owner === owner ? s.pty : undefined;
  }

  close(match: (s: Shell) => boolean) {
    for (const [id, s] of this.shells)
      if (match(s)) {
        this.shells.delete(id);
        s.pty.kill();
      }
  }
}
