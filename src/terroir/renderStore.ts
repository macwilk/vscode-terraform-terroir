/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { currentEnvironment } from './config';
import { hasJinja } from './detect';
import { buildLineMap, LineMap } from './lineMap';
import { findTerroirRoot } from './roots';
import { WorkerPool } from './worker';

export interface RenderedDoc {
  rendered: string;
  map: LineMap;
  /** Environment the render was produced for. */
  env: string;
}

/**
 * Rendered text and position maps, keyed by file URI. terroir renders a whole
 * directory at a time, so one worker round trip fills every sibling too.
 */
export class RenderStore implements vscode.Disposable {
  private readonly docs = new Map<string, RenderedDoc>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: WorkerPool,
    private readonly out: vscode.OutputChannel,
  ) {}

  get(uri: vscode.Uri): RenderedDoc | undefined {
    return this.docs.get(uri.toString());
  }

  /** Files in `dir` that rendered successfully, as absolute paths. */
  renderedSiblings(dir: string): string[] {
    const prefix = `${dir}${path.sep}`;
    const out: string[] = [];
    for (const key of this.docs.keys()) {
      const fsPath = vscode.Uri.parse(key).fsPath;
      if (fsPath.startsWith(prefix) && !path.relative(dir, fsPath).includes(path.sep)) {
        out.push(fsPath);
      }
    }
    return out;
  }

  /**
   * Render the directory holding `file`. Concurrent calls for the same
   * directory share one worker round trip.
   */
  async renderDirectoryOf(file: vscode.Uri): Promise<void> {
    const dir = path.dirname(file.fsPath);
    const existing = this.inflight.get(dir);
    if (existing) {
      return existing;
    }
    const work = this.renderDirectory(dir).finally(() => this.inflight.delete(dir));
    this.inflight.set(dir, work);
    return work;
  }

  private async renderDirectory(dir: string): Promise<void> {
    const root = findTerroirRoot(dir);
    if (!root) {
      return;
    }
    const env = currentEnvironment(dir).name;

    let result;
    try {
      result = await this.pool.renderDir(root, dir, env);
    } catch (error) {
      // Keep whatever we rendered last; a stale render beats unparseable Jinja.
      const reason = error instanceof Error ? error.message : String(error);
      this.out.appendLine(`[terroir] render failed for ${dir}: ${reason}`);
      return;
    }

    for (const [name, file] of Object.entries(result.files)) {
      const uri = vscode.Uri.file(path.join(dir, name));
      if (!hasJinja(file.rewritten)) {
        this.docs.delete(uri.toString());
        continue;
      }
      this.docs.set(uri.toString(), {
        rendered: file.rendered,
        map: buildLineMap(file.rewritten, file.rendered),
        env,
      });
    }

    for (const [name, error] of Object.entries(result.errors)) {
      this.out.appendLine(`[terroir] ${path.join(dir, name)}: ${error.type}: ${error.message}`);
    }
  }

  /** Drop every render whose environment no longer matches its own path. */
  invalidateForEnvChange(): void {
    for (const [key, doc] of this.docs) {
      if (doc.env !== currentEnvironment(vscode.Uri.parse(key).fsPath).name) {
        this.docs.delete(key);
      }
    }
  }

  dispose(): void {
    this.docs.clear();
    this.inflight.clear();
  }
}
