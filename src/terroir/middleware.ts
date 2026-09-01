/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  LanguageClient,
  Middleware,
} from 'vscode-languageclient/node';
import {
  formatBudgetMs,
  indentJinjaBlocks,
  isEnabled,
  isFormatGuardEnabled,
  isRenderEnabled,
  renderDebounceMs,
} from './config';
import { hasJinja } from './detect';
import { safeLineEdits } from './formatEdits';
import { resolvedTerraform, runTerraformFmt, terraformAvailable } from './hclFormatter';
import { formatTemplate } from './templateFormat';
import { RenderStore } from './renderStore';
import { translateSemanticTokens } from './semanticTokens';
import { findTerroirRoot } from './roots';

const NUDGE_DELAY_MS = 250;

/**
 * terraform-ls reads a module's other .tf files off disk, so a template sibling
 * poisons the module index even when only one file is open. It also keeps the
 * disk parse until a change event supersedes it, hence the nudge.
 */
export class TerroirMiddleware {
  private client: LanguageClient | undefined;
  private readonly pushed = new Set<string>();
  private readonly pushedVersions = new Map<string, number>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: RenderStore,
    private readonly out: vscode.OutputChannel,
  ) {}

  attach(client: LanguageClient): void {
    this.client = client;
  }

  private managed(document: vscode.TextDocument): boolean {
    return (
      isEnabled() &&
      isRenderEnabled() &&
      document.uri.scheme === 'file' &&
      document.languageId === 'terraform' &&
      findTerroirRoot(path.dirname(document.uri.fsPath)) !== undefined
    );
  }

  private renderedText(document: vscode.TextDocument): string | undefined {
    if (!this.managed(document) || !document.version) {
      return undefined;
    }
    if (!hasJinja(document.getText())) {
      return undefined;
    }
    return this.store.get(document.uri)?.rendered;
  }

  private asDocument(document: vscode.TextDocument, text: string): vscode.TextDocument {
    return new Proxy(document, {
      get(target, prop, receiver): unknown {
        if (prop === 'getText') {
          return () => text;
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /**
   * `asChangeTextDocumentParams` tests for a TextDocument first, so an object
   * carrying `uri` and `version` takes the whole-document-replace branch even
   * under incremental sync; `document` is still required by `notificationSent`.
   */
  private asChangeEvent(document: vscode.TextDocument, text: string): vscode.TextDocumentChangeEvent {
    return {
      uri: document.uri,
      version: document.version,
      getText: () => text,
      document: this.asDocument(document, text),
      contentChanges: [],
      reason: undefined,
    } as unknown as vscode.TextDocumentChangeEvent;
  }

  private async pushSiblings(document: vscode.TextDocument): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const dir = path.dirname(document.uri.fsPath);
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));

    for (const fsPath of this.store.renderedSiblings(dir)) {
      const uri = vscode.Uri.file(fsPath);
      const key = uri.toString();
      if (key === document.uri.toString() || open.has(key) || this.pushed.has(key)) {
        continue;
      }
      const rendered = this.store.get(uri);
      if (!rendered) {
        continue;
      }
      this.pushed.add(key);
      this.pushedVersions.set(key, 1);
      await client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: key, languageId: 'terraform', version: 1, text: rendered.rendered },
      });
      setTimeout(() => void this.nudge(uri), NUDGE_DELAY_MS);
    }
  }

  /** terraform-ls keeps its disk parse until a change supersedes it. */
  private async nudge(uri: vscode.Uri): Promise<void> {
    const client = this.client;
    const key = uri.toString();
    if (!client || !this.pushed.has(key)) {
      return;
    }
    const rendered = this.store.get(uri);
    if (!rendered) {
      return;
    }
    const version = (this.pushedVersions.get(key) ?? 1) + 1;
    this.pushedVersions.set(key, version);
    await client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: key, version },
      contentChanges: [{ text: rendered.rendered }],
    });
  }

  /**
   * Siblings are pushed so terraform-ls stops reading templates off disk, but nothing else ever
   * takes them back. Left alone, every directory visited in a session accumulates permanently.
   */
  private async releaseDirectory(dir: string, closing?: vscode.Uri): Promise<void> {
    const stillOpen = vscode.workspace.textDocuments.some(
      (d) =>
        d.uri.scheme === 'file' &&
        d.uri.toString() !== closing?.toString() &&
        path.dirname(d.uri.fsPath) === dir &&
        d.languageId === 'terraform',
    );
    if (stillOpen) {
      return;
    }
    for (const key of [...this.pushed]) {
      if (path.dirname(vscode.Uri.parse(key).fsPath) === dir) {
        await this.releaseSibling(vscode.Uri.parse(key));
      }
    }
  }

  /**
   * A different environment renders to different text, so everything already handed to the server
   * -- open buffers and pushed siblings alike -- is now wrong. Clearing the cache alone would
   * leave the server showing the previous environment until each file happened to be edited.
   */
  async refreshAll(): Promise<void> {
    for (const key of [...this.pushed]) {
      await this.releaseSibling(vscode.Uri.parse(key));
    }
    for (const document of vscode.workspace.textDocuments) {
      if (!this.managed(document) || !hasJinja(document.getText())) {
        continue;
      }
      await this.store.renderDirectoryOf(document.uri);
      const rendered = this.renderedText(document);
      if (this.client && rendered) {
        await this.client.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri: document.uri.toString(), version: document.version },
          contentChanges: [{ text: rendered }],
        });
      }
      await this.pushSiblings(document);
    }
  }

  private async releaseSibling(uri: vscode.Uri): Promise<void> {
    const client = this.client;
    const key = uri.toString();
    if (!client || !this.pushed.has(key)) {
      return;
    }
    this.pushed.delete(key);
    this.pushedVersions.delete(key);
    await client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: key } });
  }

  private scheduleRerender(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.debounce.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounce.set(
      key,
      setTimeout(() => {
        this.debounce.delete(key);
        void this.rerender(document);
      }, renderDebounceMs()),
    );
  }

  private async rerender(document: vscode.TextDocument): Promise<void> {
    await this.store.renderDirectoryOf(document.uri);
    const client = this.client;
    const rendered = this.renderedText(document);
    if (!client || !rendered) {
      return;
    }
    await client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: document.uri.toString(), version: document.version },
      contentChanges: [{ text: rendered }],
    });
  }

  build(): Middleware {
    return {
      didOpen: async (document, next) => {
        if (!this.managed(document) || !hasJinja(document.getText())) {
          return next(document);
        }
        await this.releaseSibling(document.uri);
        await this.store.renderDirectoryOf(document.uri);
        const rendered = this.renderedText(document);
        await next(rendered ? this.asDocument(document, rendered) : document);
        await this.pushSiblings(document);
      },

      didChange: async (event, next) => {
        const rendered = this.renderedText(event.document);
        if (!rendered) {
          return next(event);
        }
        this.scheduleRerender(event.document);
        return next(this.asChangeEvent(event.document, rendered));
      },

      didClose: async (document, next) => {
        const key = document.uri.toString();
        const timer = this.debounce.get(key);
        if (timer) {
          clearTimeout(timer);
          this.debounce.delete(key);
        }
        await next(document);
        await this.releaseDirectory(path.dirname(document.uri.fsPath), document.uri);
      },

      handleDiagnostics: (uri, diagnostics, next) => {
        const doc = this.store.get(uri);
        if (!doc) {
          next(uri, diagnostics);
          return;
        }
        // Once a template's buffer is released the server re-reads it from disk and reports the
        // raw Jinja as syntax errors. Nobody is looking at that file; the errors are an artefact
        // of how it is stored, not a problem with it.
        const key = uri.toString();
        const watched = this.pushed.has(key) || vscode.workspace.textDocuments.some((d) => d.uri.toString() === key);
        if (!watched) {
          next(uri, []);
          return;
        }
        const mapped: vscode.Diagnostic[] = [];
        for (const diagnostic of diagnostics) {
          const start = doc.map.toSource(diagnostic.range.start);
          const end = doc.map.toSource(diagnostic.range.end);
          if (!start) {
            continue;
          }
          const endPos = end && end.line >= start.line ? end : start;
          const range = new vscode.Range(start.line, start.character, endPos.line, endPos.character);
          const moved = new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity);
          moved.code = diagnostic.code;
          moved.source = diagnostic.source;
          moved.tags = diagnostic.tags;
          moved.relatedInformation = diagnostic.relatedInformation;
          mapped.push(moved);
        }
        next(uri, mapped);
      },

      provideDocumentFormattingEdits: async (document, options, token, next) => {
        if (!this.isTemplate(document)) {
          return next(document, options, token);
        }
        const whole = await this.formatWholeTemplate(document);
        if (whole) {
          return whole;
        }
        return this.safeFormattingEdits(document, await next(document, options, token));
      },

      provideDocumentRangeFormattingEdits: async (document, range, options, token, next) => {
        if (!this.isTemplate(document)) {
          return next(document, range, options, token);
        }
        return this.safeFormattingEdits(document, await next(document, range, options, token));
      },

      provideDocumentSemanticTokens: async (document, token, next) => {
        const result = await next(document, token);
        const doc = this.store.get(document.uri);
        if (!result || !doc) {
          return result;
        }
        return new vscode.SemanticTokens(
          translateSemanticTokens(result.data, (pos) => doc.map.toSource(pos)),
          result.resultId,
        );
      },

      provideHover: (document, position, token, next) => {
        const mapped = this.toRendered(document, position);
        return mapped === undefined ? undefined : next(document, mapped, token);
      },

      provideDefinition: (document, position, token, next) => {
        const mapped = this.toRendered(document, position);
        return mapped === undefined ? undefined : next(document, mapped, token);
      },

      provideCompletionItem: (document, position, context, token, next) => {
        const mapped = this.toRendered(document, position);
        return mapped === undefined ? undefined : next(document, mapped, context, token);
      },

      provideReferences: (document, position, options, token, next) => {
        const mapped = this.toRendered(document, position);
        return mapped === undefined ? undefined : next(document, mapped, options, token);
      },
    };
  }

  private isTemplate(document: vscode.TextDocument): boolean {
    return isEnabled() && document.languageId === 'terraform' && hasJinja(document.getText());
  }

  /**
   * Format the template itself, with no render and no environment, so branches the current
   * environment does not take are formatted too. Falls back to the render-based path when the
   * terraform binary is missing or the template cannot be masked into parseable HCL.
   */
  private async formatWholeTemplate(document: vscode.TextDocument): Promise<vscode.TextEdit[] | undefined> {
    if (!terraformAvailable()) {
      return undefined;
    }
    const source = document.getText();
    let reason = 'terraform fmt rejected the masked template';
    const formatted = await formatTemplate(source, runTerraformFmt, {
      indentBlocks: indentJinjaBlocks(),
      budgetMs: formatBudgetMs(),
      onDecline: (why) => {
        reason = why;
      },
    });
    if (formatted === undefined) {
      this.out.appendLine(
        terraformAvailable()
          ? `[terroir] ${document.uri.fsPath}: not formatted -- ${reason}; falling back to the rendered file`
          : `[terroir] no terraform binary found; set terraform.terroir.terraformPath to format templates`,
      );
      return undefined;
    }
    this.out.appendLine(`[terroir] formatted ${document.uri.fsPath} with ${resolvedTerraform() ?? 'terraform'}`);
    if (formatted === source) {
      return [];
    }
    const end = document.lineAt(document.lineCount - 1).range.end;
    return [new vscode.TextEdit(new vscode.Range(0, 0, end.line, end.character), formatted)];
  }

  /** Replay only the formatting edits that provably do not touch a template expression. */
  private safeFormattingEdits(
    document: vscode.TextDocument,
    edits: vscode.TextEdit[] | null | undefined,
  ): vscode.TextEdit[] {
    const doc = this.store.get(document.uri);
    if (!edits || !doc) {
      return [];
    }
    if (!isFormatGuardEnabled()) {
      return edits;
    }

    const lineEdits = edits
      .filter((edit) => edit.range.start.character === 0 && edit.range.end.character === 0)
      .map((edit) => ({ startLine: edit.range.start.line, endLine: edit.range.end.line, newText: edit.newText }));

    const safe = safeLineEdits(document.getText(), doc.rendered, doc.map, lineEdits);
    this.out.appendLine(
      `[terroir] formatting ${document.uri.fsPath}: applied ${safe.length} of ${edits.length} edits ` +
        `(the rest overlap template expressions)`,
    );
    return safe.map((edit) => new vscode.TextEdit(new vscode.Range(edit.startLine, 0, edit.endLine, 0), edit.newText));
  }

  /** Undefined means the cursor is inside a Jinja span; the server cannot answer. */
  private toRendered(document: vscode.TextDocument, position: vscode.Position): vscode.Position | undefined {
    const doc = this.store.get(document.uri);
    if (!doc) {
      return position;
    }
    const mapped = doc.map.toRendered(position);
    return mapped ? new vscode.Position(mapped.line, mapped.character) : undefined;
  }

  dispose(): void {
    for (const timer of this.debounce.values()) {
      clearTimeout(timer);
    }
    this.debounce.clear();
    this.pushed.clear();
    this.pushedVersions.clear();
  }
}
