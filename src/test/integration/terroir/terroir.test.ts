/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activateExtension, getDocUri, open, sleep } from '../../helper';

/**
 * The one thing the unit suites cannot show: that the middleware really substitutes rendered text
 * inside a running editor. A harness driving terraform-ls directly misses everything specific to
 * the editor host -- which is exactly how a build shipped whose only fault was that a
 * GUI-launched editor resolves a different `python3`.
 */
suite('terroir', function suite() {
  this.timeout(120000);

  const mainUri = getDocUri('main.tf');
  const variablesUri = getDocUri('variables.tf');
  const workspace = path.dirname(mainUri.fsPath);
  const gitMarker = path.join(workspace, '.git');

  suiteSetup(async () => {
    // terroir resolves its root by walking up for `.git`, testing existence rather than
    // directory-ness. A file is enough, and a real one cannot be committed inside this repo.
    // Only the self-contained fixture needs a fake root; a workspace inside a real terroir
    // checkout already resolves one by walking up, and a marker there would break that.
    if (fs.existsSync(path.join(workspace, '.terroir', 'config.toml'))) {
      fs.writeFileSync(gitMarker, 'gitdir: /nonexistent\n');
    }
    await open(mainUri);
    await activateExtension();
    await sleep(15000);
  });

  suiteTeardown(async () => {
    if (fs.existsSync(path.join(workspace, '.terroir', 'config.toml'))) {
      fs.rmSync(gitMarker, { force: true });
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('the language is registered', async () => {
    const doc = await vscode.workspace.openTextDocument(mainUri);
    assert.strictEqual(doc.languageId, 'terraform');
  });

  test('no HCL syntax errors are reported on a template', async () => {
    for (const uri of [mainUri, variablesUri]) {
      await open(uri);
      await sleep(6000);
      const syntax = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .filter((d) => /Argument or block definition required|Invalid character|Missing newline/.test(d.message));
      assert.deepStrictEqual(
        syntax.map((d) => `${d.range.start.line + 1}: ${d.message}`),
        [],
        `raw Jinja reached the language server for ${path.basename(uri.fsPath)}`,
      );
    }
  });

  test('a variable declared under a Jinja conditional is still resolved', async () => {
    await open(mainUri);
    await sleep(4000);
    const undeclared = vscode.languages.getDiagnostics(mainUri).filter((d) => /No declaration found/.test(d.message));
    assert.deepStrictEqual(
      undeclared.map((d) => d.message),
      [],
    );
  });

  test('formatting normalises inside a Jinja branch and leaves the tags alone', async () => {
    const doc = await vscode.workspace.openTextDocument(variablesUri);
    const before = doc.getText();
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      'vscode.executeFormatDocumentProvider',
      variablesUri,
      { tabSize: 2, insertSpaces: true },
    );
    assert.ok(edits && edits.length > 0, 'expected formatting edits for a template');

    const edited = new vscode.WorkspaceEdit();
    edited.set(variablesUri, edits);
    await vscode.workspace.applyEdit(edited);
    const after = doc.getText();

    const tags = (text: string) => (text.match(/\{[{%#][\s\S]*?[}%#]\}/g) ?? []).join('|');
    assert.strictEqual(tags(after), tags(before), 'formatting must not touch Jinja');
    assert.ok(/^\s+default += "us-east-1"$/m.test(after), `branch body not normalised:\n${after}`);

    // leave the fixture as we found it
    const restore = new vscode.WorkspaceEdit();
    restore.replace(variablesUri, new vscode.Range(0, 0, doc.lineCount, 0), before);
    await vscode.workspace.applyEdit(restore);
    await doc.save();
  });

  test('F12 on is_enabled jumps to the flag in settings.json', async () => {
    await open(variablesUri);
    const doc = await vscode.workspace.openTextDocument(variablesUri);
    const line = doc
      .getText()
      .split('\n')
      .findIndex((l) => l.includes('is_enabled('));
    assert.ok(line >= 0, 'fixture should contain an is_enabled call');
    const character = doc.lineAt(line).text.indexOf('fixture.enabled') + 3;

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      variablesUri,
      new vscode.Position(line, character),
    );
    assert.ok(locations && locations.length > 0, 'expected a definition for the flag');
    assert.ok(
      locations.some((l) => l.uri.fsPath.endsWith(path.join('.terroir', 'settings.json'))),
      `expected settings.json, got ${locations.map((l) => l.uri.fsPath).join(', ')}`,
    );
  });

  test('hover on is_enabled names the environments the flag is on for', async () => {
    await open(variablesUri);
    const doc = await vscode.workspace.openTextDocument(variablesUri);
    const line = doc
      .getText()
      .split('\n')
      .findIndex((l) => l.includes('is_enabled('));
    const character = doc.lineAt(line).text.indexOf('fixture.enabled') + 3;

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      variablesUri,
      new vscode.Position(line, character),
    );
    const text = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
      .join('\n');
    assert.ok(/staging/.test(text), `expected the env list in the hover, got: ${text}`);
  });

  test('a flag missing from settings.json is reported on the call site', async () => {
    await open(mainUri);
    await sleep(3000);
    const flagged = vscode.languages
      .getDiagnostics(mainUri)
      .filter((d) => d.source === 'terroir' && /not defined/.test(d.message));
    assert.strictEqual(flagged.length, 1, `expected one undefined-flag warning, got ${flagged.length}`);
    assert.ok(/fixture\.typo/.test(flagged[0].message), flagged[0].message);
    assert.strictEqual(flagged[0].severity, vscode.DiagnosticSeverity.Warning);
  });

  test('changing the environment re-renders what the server was given', async () => {
    const rendered = variablesUri.with({ scheme: 'terroir-rendered' });
    const config = vscode.workspace.getConfiguration('terraform');
    await open(variablesUri);
    await sleep(2000);

    const staging = (await vscode.workspace.openTextDocument(rendered)).getText();
    assert.ok(staging.includes('us-east-1'), `expected the enabled branch under staging:\n${staging}`);

    try {
      await config.update('terroir.environment', 'qa', vscode.ConfigurationTarget.Workspace);
      await sleep(4000);
      const doc = await vscode.workspace.openTextDocument(rendered);
      const qa = doc.getText();
      assert.ok(qa.includes('us-west-2'), `flag is off for qa, so the else branch should render; got:\n${qa}`);
    } finally {
      await config.update('terroir.environment', undefined, vscode.ConfigurationTarget.Workspace);
      await sleep(2000);
    }
  });

  test('closing a template does not leave raw-Jinja errors behind for it', async () => {
    await open(mainUri);
    await open(variablesUri);
    await sleep(4000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(5000);
    for (const uri of [mainUri, variablesUri]) {
      const syntax = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .filter((d) => /Argument or block definition required|Invalid character/.test(d.message));
      assert.deepStrictEqual(
        syntax.map((d) => d.message),
        [],
        `${path.basename(uri.fsPath)} kept raw-Jinja errors after closing`,
      );
    }
  });

  test('a template in a directory never opened does not flood the problem list', async () => {
    // The server indexes the whole workspace, so it parses this file off disk even though
    // nothing has opened it. Its raw Jinja must not surface as terraform syntax errors.
    const untouched = vscode.Uri.file(path.join(workspace, 'untouched', 'never_opened.tf'));
    await open(mainUri);
    await sleep(8000);
    const syntax = vscode.languages
      .getDiagnostics(untouched)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepStrictEqual(
      syntax.map((d) => `${d.range.start.line + 1}: ${d.message}`),
      [],
      'an unopened template reported raw-Jinja errors',
    );
  });

  test('hover answers on a line the render kept', async () => {
    await open(mainUri);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      mainUri,
      new vscode.Position(0, 10),
    );
    assert.ok(Array.isArray(hovers), 'hover provider should respond rather than throw');
  });

  test('completion answers on a line the render kept', async () => {
    await open(mainUri);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      mainUri,
      new vscode.Position(1, 22),
    );
    assert.ok(list, 'completion provider should respond rather than throw');
  });
});
