/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';
import { environmentName, isEnabled } from './config';
import { hasJinja } from './detect';
import { registerFlagIntelligence } from './flags';
import { TerroirMiddleware } from './middleware';
import { RenderStore } from './renderStore';
import { clearRootCache, findTerroirRoot } from './roots';
import { FlagValue } from './types';
import { WorkerPool } from './worker';

const RENDERED_SCHEME = 'terroir-rendered';

class Terroir {
  private middleware: TerroirMiddleware | undefined;
  private store: RenderStore | undefined;
  private pool: WorkerPool | undefined;
  private status: vscode.StatusBarItem | undefined;
  /** Without this the editor serves a rendered preview from cache forever, even after a re-render. */
  private readonly renderedChanged = new vscode.EventEmitter<vscode.Uri>();

  activate(context: vscode.ExtensionContext, out: vscode.OutputChannel): Middleware {
    const pool = new WorkerPool(context.extensionPath, out);
    const store = new RenderStore(pool, out);
    const middleware = new TerroirMiddleware(store, out);
    this.pool = pool;
    this.store = store;
    this.middleware = middleware;

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    status.command = 'terraform.terroir.selectEnvironment';
    status.tooltip = 'terroir environment used to render this template';
    this.status = status;

    context.subscriptions.push(
      pool,
      store,
      status,
      registerFlagIntelligence(context),
      this.renderedChanged,
      vscode.workspace.registerTextDocumentContentProvider(RENDERED_SCHEME, {
        onDidChange: this.renderedChanged.event,
        provideTextDocumentContent: (uri) => this.renderedContent(uri),
      }),
      vscode.commands.registerCommand('terraform.terroir.selectEnvironment', () => this.selectEnvironment()),
      vscode.commands.registerCommand('terraform.terroir.showRendered', () => this.showRendered()),
      vscode.commands.registerCommand('terraform.terroir.restartWorker', () => {
        pool.restartAll();
        out.appendLine('[terroir] render worker restarted');
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('terraform.terroir')) {
          clearRootCache();
          store.invalidateForEnvChange();
          void middleware.refreshAll().then(() => {
            for (const document of vscode.workspace.textDocuments) {
              if (document.uri.scheme === RENDERED_SCHEME) {
                this.renderedChanged.fire(document.uri);
              }
            }
          });
          this.updateStatus();
        }
      }),
    );

    this.updateStatus();
    return middleware.build();
  }

  attach(client: LanguageClient): void {
    this.middleware?.attach(client);
  }

  private updateStatus(): void {
    const editor = vscode.window.activeTextEditor;
    const relevant =
      isEnabled() &&
      editor?.document.languageId === 'terraform' &&
      editor.document.uri.scheme === 'file' &&
      hasJinja(editor.document.getText()) &&
      findTerroirRoot(path.dirname(editor.document.uri.fsPath)) !== undefined;

    if (!relevant) {
      this.status?.hide();
      return;
    }
    if (this.status) {
      this.status.text = `$(beaker) terroir: ${environmentName(editor.document.uri.fsPath)}`;
      this.status.show();
    }
  }

  /** Environment names terroir itself knows about, from `.terroir/settings.json`. */
  private knownEnvironments(): string[] {
    const editor = vscode.window.activeTextEditor;
    const from = editor ? path.dirname(editor.document.uri.fsPath) : vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    const root = from ? findTerroirRoot(from) : undefined;
    if (!root?.settingsPath) {
      return [];
    }
    try {
      const flags = JSON.parse(fs.readFileSync(root.settingsPath, 'utf8')) as Record<string, FlagValue>;
      const names = new Set<string>();
      for (const value of Object.values(flags)) {
        if (Array.isArray(value)) {
          value.forEach((env) => names.add(env));
        }
      }
      names.delete('test');
      return [...names].sort();
    } catch {
      return [];
    }
  }

  private async selectEnvironment(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const known = this.knownEnvironments();
    const picked = await vscode.window.showQuickPick(known.length ? known : ['staging', 'uat', 'prod'], {
      title: 'terroir environment',
      placeHolder: `CAPITALRX_ENVIRONMENT (currently ${environmentName(editor?.document.uri.fsPath)})`,
    });
    if (!picked) {
      return;
    }
    await vscode.workspace
      .getConfiguration('terraform')
      .update('terroir.environment', picked, vscode.ConfigurationTarget.Workspace);
  }

  private renderedContent(uri: vscode.Uri): string {
    const target = vscode.Uri.file(uri.path);
    return this.store?.get(target)?.rendered ?? '';
  }

  private async showRendered(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const source = editor.document.uri;
    if (!this.store?.get(source)) {
      await this.store?.renderDirectoryOf(source);
    }
    if (!this.store?.get(source)) {
      void vscode.window.showWarningMessage('terroir: this file has no render to show.');
      return;
    }
    const rendered = source.with({ scheme: RENDERED_SCHEME });
    await vscode.commands.executeCommand(
      'vscode.diff',
      source,
      rendered,
      `${path.basename(source.fsPath)} (template ↔ ${environmentName(source.fsPath)})`,
    );
  }
}

export const terroir = new Terroir();
