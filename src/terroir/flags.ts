/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { findTerroirRoot } from './roots';
import { FlagValue } from './types';

/**
 * `vscode` above is type-only: this module's pure functions (and the mocha unit
 * tests that exercise them) load under plain node, which has no `vscode` module to
 * resolve. The real module is only ever fetched here, lazily, once something from
 * inside a running extension host actually needs it.
 */
function loadVscode(): typeof import('vscode') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode') as typeof import('vscode');
}

/** How `is_enabled` in `.terroir/terroir_plugin.py` will actually treat a flag. */
export type FlagResolution =
  | { kind: 'missing' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'empty-list' }
  | { kind: 'list'; declared: string[]; effective: string[] };

export interface FlagNameMatch {
  name: string;
  /** Offset of the opening quote of the string literal, within the line. */
  start: number;
  /** Offset just past the closing quote of the string literal, within the line. */
  end: number;
}

export interface CompletionContext {
  /** Text already typed after the opening `"` of an `is_enabled(` argument. */
  prefix: string;
  /** Offset where that text begins, within the line. */
  start: number;
}

export function parseFlagSettings(text: string): Record<string, FlagValue> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, FlagValue>) : {};
  } catch {
    return {};
  }
}

/**
 * Mirrors `Plugin.is_enabled`: `self.config.get(setting)` is `None` for a
 * missing key; `if not setting_value` treats `None`, `False` and `[]` alike
 * and short-circuits to `False` without touching the list. Anything else
 * (a non-empty list, or the boolean `True`) falls into the `else` branch and
 * gets `.append("test")` called on it — which is where a boolean blows up.
 */
export function resolveFlag(flags: Record<string, FlagValue>, name: string): FlagResolution {
  if (!Object.prototype.hasOwnProperty.call(flags, name)) {
    return { kind: 'missing' };
  }
  const value = flags[name];
  if (typeof value === 'boolean') {
    return { kind: 'boolean', value };
  }
  if (value.length === 0) {
    return { kind: 'empty-list' };
  }
  const effective = value.includes('test') ? [...value] : [...value, 'test'];
  return { kind: 'list', declared: value, effective };
}

/**
 * Byte offset and length of a top-level key's name, excluding its quotes. Scanned rather than
 * parsed: the extension bundles to a single file, and a JSON parser package that resolves its own
 * submodules at runtime does not survive bundling.
 */
export function findFlagKeyOffset(settingsText: string, name: string): { offset: number; length: number } | undefined {
  const needle = `"${name}"`;
  let from = 0;
  for (;;) {
    const at = settingsText.indexOf(needle, from);
    if (at < 0) {
      return undefined;
    }
    // A key is followed by a colon; the same text inside a value array is not.
    const after = /^\s*:/.exec(settingsText.slice(at + needle.length));
    if (after) {
      return { offset: at + 1, length: name.length };
    }
    from = at + needle.length;
  }
}

export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/** Finds an `is_enabled("...")` string literal on the line and whether `character` falls inside it (quotes included). */
export function flagNameAtCharacter(lineText: string, character: number): FlagNameMatch | undefined {
  const re = /is_enabled\(\s*"([^"]*)"/g;
  for (let match = re.exec(lineText); match; match = re.exec(lineText)) {
    const name = match[1];
    const start = match.index + match[0].indexOf('"');
    const end = start + name.length + 2;
    if (character >= start && character <= end) {
      return { name, start, end };
    }
  }
  return undefined;
}

/** Whether `character` sits inside an open `is_enabled("` argument that hasn't been closed yet. */
export function completionContextAtCharacter(lineText: string, character: number): CompletionContext | undefined {
  const match = /is_enabled\(\s*"([^"]*)$/.exec(lineText.slice(0, character));
  if (!match) {
    return undefined;
  }
  const prefix = match[1];
  return { prefix, start: character - prefix.length };
}

export function describeFlag(name: string, resolution: FlagResolution): string {
  switch (resolution.kind) {
    case 'missing':
      return [
        `**${name}**`,
        '',
        'Not defined in `.terroir/settings.json`.',
        '',
        '`is_enabled` treats a missing key as `False` (`self.config.get(setting)` returns `None`, which is falsy).',
      ].join('\n');
    case 'boolean':
      return resolution.value
        ? [
            `**${name}**`,
            '',
            'Always **on** (boolean `true`).',
            '',
            '**Divergence from real terroir:** a truthy value takes the `else` branch of `is_enabled`, which runs ' +
              '`setting_value.append("test")`. `bool` has no `.append`, so real terroir raises `AttributeError` at ' +
              'render time instead of actually enabling this flag.',
          ].join('\n')
        : [`**${name}**`, '', 'Always **off** (boolean `false`).'].join('\n');
    case 'empty-list':
      return [
        `**${name}**`,
        '',
        'Declared with an empty environment list, so it is always **off** — `is_enabled` treats `[]` as falsy and ' +
          'returns `False` before `"test"` would be appended.',
      ].join('\n');
    case 'list':
      return [
        `**${name}**`,
        '',
        'Enabled for:',
        '',
        ...resolution.effective.map((env) => `- \`${env}\``),
        '',
        resolution.declared.includes('test')
          ? '`test` is declared explicitly.'
          : '`test` is implicitly enabled: `is_enabled` appends it to the list before checking membership.',
      ].join('\n');
  }
}

function summarizeFlag(resolution: FlagResolution): string {
  switch (resolution.kind) {
    case 'missing':
      return 'missing from settings.json';
    case 'boolean':
      return resolution.value ? 'always on (boolean true — crashes real terroir)' : 'always off (boolean false)';
    case 'empty-list':
      return 'always off (empty list)';
    case 'list':
      return resolution.effective.join(', ');
  }
}

class FlagSettingsCache implements vscode.Disposable {
  private text: string | undefined;
  private flags: Record<string, FlagValue> | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly settingsPath: string) {}

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    const watcher = loadVscode().workspace.createFileSystemWatcher(this.settingsPath);
    const invalidate = (): void => {
      this.text = undefined;
      this.flags = undefined;
    };
    watcher.onDidChange(invalidate);
    watcher.onDidCreate(invalidate);
    watcher.onDidDelete(invalidate);
    this.watcher = watcher;
  }

  private load(): void {
    this.ensureWatcher();
    if (this.text !== undefined && this.flags !== undefined) {
      return;
    }
    try {
      this.text = fs.readFileSync(this.settingsPath, 'utf8');
      this.flags = parseFlagSettings(this.text);
    } catch {
      this.text = '';
      this.flags = {};
    }
  }

  getFlags(): Record<string, FlagValue> {
    this.load();
    return this.flags ?? {};
  }

  getText(): string {
    this.load();
    return this.text ?? '';
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerFlagIntelligence(context: vscode.ExtensionContext): vscode.Disposable {
  const vscodeApi = loadVscode();
  const caches = new Map<string, FlagSettingsCache>();

  const cacheFor = (settingsPath: string): FlagSettingsCache => {
    let cache = caches.get(settingsPath);
    if (!cache) {
      cache = new FlagSettingsCache(settingsPath);
      caches.set(settingsPath, cache);
    }
    return cache;
  };

  const settingsPathFor = (document: vscode.TextDocument): string | undefined => {
    if (document.uri.scheme !== 'file') {
      return undefined;
    }
    return findTerroirRoot(path.dirname(document.uri.fsPath))?.settingsPath;
  };

  const selector: vscode.DocumentSelector = { language: 'terraform', scheme: 'file' };

  const definitionProvider = vscodeApi.languages.registerDefinitionProvider(selector, {
    provideDefinition: (document, position) => {
      const settingsPath = settingsPathFor(document);
      if (!settingsPath) {
        return undefined;
      }
      const match = flagNameAtCharacter(document.lineAt(position.line).text, position.character);
      if (!match) {
        return undefined;
      }
      const settingsText = cacheFor(settingsPath).getText();
      const key = findFlagKeyOffset(settingsText, match.name);
      if (!key) {
        return undefined;
      }
      const start = offsetToPosition(settingsText, key.offset);
      const end = offsetToPosition(settingsText, key.offset + key.length);
      return new vscodeApi.Location(
        vscodeApi.Uri.file(settingsPath),
        new vscodeApi.Range(start.line, start.character, end.line, end.character),
      );
    },
  });

  const hoverProvider = vscodeApi.languages.registerHoverProvider(selector, {
    provideHover: (document, position) => {
      const settingsPath = settingsPathFor(document);
      if (!settingsPath) {
        return undefined;
      }
      const match = flagNameAtCharacter(document.lineAt(position.line).text, position.character);
      if (!match) {
        return undefined;
      }
      const resolution = resolveFlag(cacheFor(settingsPath).getFlags(), match.name);
      return new vscodeApi.Hover(new vscodeApi.MarkdownString(describeFlag(match.name, resolution)));
    },
  });

  const completionProvider = vscodeApi.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems: (document, position) => {
        const settingsPath = settingsPathFor(document);
        if (!settingsPath) {
          return undefined;
        }
        const lineText = document.lineAt(position.line).text;
        const completion = completionContextAtCharacter(lineText, position.character);
        if (!completion) {
          return undefined;
        }
        const replaceRange = new vscodeApi.Range(position.line, completion.start, position.line, position.character);
        const flags = cacheFor(settingsPath).getFlags();
        return Object.keys(flags).map((name) => {
          const resolution = resolveFlag(flags, name);
          const item = new vscodeApi.CompletionItem(name, vscodeApi.CompletionItemKind.EnumMember);
          item.range = replaceRange;
          item.detail = summarizeFlag(resolution);
          item.documentation = new vscodeApi.MarkdownString(describeFlag(name, resolution));
          return item;
        });
      },
    },
    '"',
  );

  return vscodeApi.Disposable.from(definitionProvider, hoverProvider, completionProvider, {
    dispose: () => {
      for (const cache of caches.values()) {
        cache.dispose();
      }
      caches.clear();
    },
  });
}
