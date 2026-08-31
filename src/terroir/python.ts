/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { configuredPythonPath } from './config';

const PROBE_TIMEOUT_MS = 15_000;

let resolved: string | undefined;
let probe: Promise<string | undefined> | undefined;
let warned = false;

/**
 * A GUI-launched editor does not inherit a login shell's PATH, so `python3`
 * there is usually the system interpreter rather than a pyenv or virtualenv
 * one. terroir is bundled for exactly that case, so the only real requirement
 * is an interpreter new enough to run it.
 */
function candidates(): string[] {
  const configured = configuredPythonPath();
  if (configured) {
    return [configured];
  }
  return ['python3', 'python', path.join(os.homedir(), '.pyenv', 'shims', 'python3')];
}

/** Ping the real worker rather than testing an import, so this covers the bundle too. */
function workerAnswers(interpreter: string, scriptPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(interpreter, [scriptPath], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }

    let done = false;
    let out = '';
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(ok);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, PROBE_TIMEOUT_MS);

    child.on('error', () => {
      finish(false);
    });
    child.on('exit', () => {
      finish(false);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline < 0) {
        return;
      }
      try {
        finish((JSON.parse(out.slice(0, newline)) as { ok?: boolean }).ok === true);
      } catch {
        finish(false);
      }
    });
    child.stdin.write('{"id": 0, "op": "ping"}\n');
  });
}

export function resolveInterpreter(scriptPath: string, out: vscode.OutputChannel): Promise<string | undefined> {
  probe ??= (async () => {
    const tried = candidates();
    for (const interpreter of tried) {
      if (await workerAnswers(interpreter, scriptPath)) {
        out.appendLine(`[terroir] rendering with ${interpreter}`);
        resolved = interpreter;
        return resolved;
      }
    }
    out.appendLine(`[terroir] no usable Python; tried ${tried.join(', ')}`);
    reportMissing(tried, out);
    return undefined;
  })();
  return probe;
}

function reportMissing(tried: string[], out: vscode.OutputChannel): void {
  if (warned) {
    return;
  }
  warned = true;

  void vscode.window
    .showWarningMessage(
      `Terroir: no working Python found (tried ${tried.join(', ')}), so templates are not being rendered. ` +
        `Python 3.9 or newer is required; terroir itself is bundled.`,
      'Set Interpreter',
      'Show Log',
    )
    .then((choice) => {
      if (choice === 'Set Interpreter') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'terraform.terroir.pythonPath');
      } else if (choice === 'Show Log') {
        out.show();
      }
    });
}

export function resetInterpreter(): void {
  resolved = undefined;
  probe = undefined;
  warned = false;
}
