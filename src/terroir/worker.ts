/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { resetInterpreter, resolveInterpreter } from './python';
import { RenderDirResult, TerroirRoot } from './types';

interface Pending {
  resolve: (value: RenderDirResult) => void;
  reject: (error: Error) => void;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

class Worker implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restarts: number[] = [];
  private suspended = false;

  constructor(
    private readonly gitRoot: string,
    private readonly scriptPath: string,
    private readonly interpreter: string,
    private readonly out: vscode.OutputChannel,
  ) {}

  async renderDir(dir: string, env: string): Promise<RenderDirResult> {
    const child = this.ensureChild();
    if (!child) {
      throw new Error('terroir worker unavailable');
    }
    const id = this.nextId++;
    const request = JSON.stringify({ id, op: 'render_dir', dir, env });
    return new Promise<RenderDirResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${request}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams | undefined {
    if (this.child && !this.child.killed) {
      return this.child;
    }
    if (this.suspended) {
      return undefined;
    }

    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.suspended = true;
      this.out.appendLine(
        `[terroir] render worker failed ${MAX_RESTARTS} times in a minute; suspending for this window. ` +
          `Run "Terroir: Restart Render Worker" to try again.`,
      );
      return undefined;
    }
    this.restarts.push(now);

    const child = spawn(this.interpreter, [this.scriptPath], {
      cwd: this.gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.consume(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.out.append(`[terroir worker] ${chunk}`);
    });
    child.on('exit', (code, signal) => {
      this.out.appendLine(`[terroir] render worker exited (code=${code} signal=${signal})`);
      this.child = undefined;
      this.failPending(new Error('terroir worker exited'));
    });
    child.on('error', (error) => {
      this.out.appendLine(`[terroir] render worker could not start: ${error.message}`);
      this.child = undefined;
      this.failPending(error);
    });

    this.child = child;
    return child;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }

      let message: {
        id?: number;
        ok?: boolean;
        files?: RenderDirResult['files'];
        errors?: RenderDirResult['errors'];
        error?: { message?: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        this.out.appendLine(`[terroir] discarding non-protocol line from worker: ${line.slice(0, 200)}`);
        continue;
      }

      if (typeof message.id !== 'number') {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);

      if (message.ok) {
        pending.resolve({ files: message.files ?? {}, errors: message.errors ?? {} });
      } else {
        pending.reject(new Error(message.error?.message ?? 'terroir render failed'));
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  restart(): void {
    this.suspended = false;
    this.restarts = [];
    this.child?.kill();
    this.child = undefined;
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
    this.failPending(new Error('terroir worker disposed'));
  }
}

export class WorkerPool implements vscode.Disposable {
  private readonly workers = new Map<string, Worker>();
  private readonly scriptPath: string;

  constructor(
    extensionPath: string,
    private readonly out: vscode.OutputChannel,
  ) {
    this.scriptPath = path.join(extensionPath, 'python', 'terroir_worker.py');
  }

  async renderDir(root: TerroirRoot, dir: string, env: string): Promise<RenderDirResult> {
    const interpreter = await resolveInterpreter(this.scriptPath, this.out);
    if (!interpreter) {
      throw new Error('no usable Python interpreter');
    }
    let worker = this.workers.get(root.gitRoot);
    if (!worker) {
      worker = new Worker(root.gitRoot, this.scriptPath, interpreter, this.out);
      this.workers.set(root.gitRoot, worker);
    }
    return worker.renderDir(dir, env);
  }

  restartAll(): void {
    resetInterpreter();
    for (const worker of this.workers.values()) {
      worker.restart();
    }
    this.workers.clear();
  }

  dispose(): void {
    for (const worker of this.workers.values()) {
      worker.dispose();
    }
    this.workers.clear();
  }
}
