/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import { Formatter, formatTemplate } from './templateFormat';

/**
 * A stand-in for `terraform fmt`: reindents by delimiter depth, and rejects the two shapes real
 * fmt rejects that this module has to survive -- unbalanced delimiters, and an attribute defined
 * twice in one body, which is what both branches of an `{% if %}/{% else %}` being present at
 * once usually produces. Tests stay hermetic this way; behaviour against the real binary is
 * verified against the corpus, not here.
 */
const miniFmt: Formatter = (hcl) => {
  const out: string[] = [];
  const seen: Set<string>[] = [new Set()];
  let depth = 0;
  for (const line of hcl.split('\n')) {
    const text = line.trim();
    if (text === '') {
      out.push('');
      continue;
    }
    const code = text.replace(/"[^"\n]*"/g, '""').replace(/\/\*.*?\*\//g, '');
    const opens = (code.match(/[{[(]/g) ?? []).length;
    const closes = (code.match(/[}\])]/g) ?? []).length;
    const lead = /^[}\])]/.test(code) ? 1 : 0;
    const attribute = /^([A-Za-z_][\w-]*)\s*=/.exec(code);
    if (attribute) {
      if (seen[seen.length - 1].has(attribute[1])) {
        return undefined;
      }
      seen[seen.length - 1].add(attribute[1]);
    }
    out.push('  '.repeat(Math.max(0, depth - lead)) + text);
    depth += opens - closes;
    if (depth < 0) {
      return undefined;
    }
    for (let n = 0; n < opens; n++) {
      seen.push(new Set());
    }
    for (let n = 0; n < closes && seen.length > 1; n++) {
      seen.pop();
    }
  }
  return depth === 0 ? out.join('\n') : undefined;
};

const jinja = (text: string): string[] => text.match(/\{#[\s\S]*?#\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g) ?? [];

suite('templateFormat', () => {
  test('indents a tag that sits alone on its line, and the branch it guards', () => {
    const source = [
      'locals {',
      '  quicksight_cli_admin_role_names = toset(1)',
      '{% if os.environ["CAPITALRX_ENVIRONMENT"] in ["stagingcloudhesive"] %}',
      'staging_operator_full_power_enabled = var.enable_staging_operator_full_power',
      '{% endif %}',
      '}',
      '',
    ].join('\n');
    assert.strictEqual(
      formatTemplate(source, miniFmt),
      [
        'locals {',
        '  quicksight_cli_admin_role_names = toset(1)',
        '  {% if os.environ["CAPITALRX_ENVIRONMENT"] in ["stagingcloudhesive"] %}',
        '  staging_operator_full_power_enabled = var.enable_staging_operator_full_power',
        '  {% endif %}',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('keeps an interpolation that holds double quotes inside a double-quoted string', () => {
    const source = [
      'variable "artifacts" {',
      'default = "{{ os.environ.get("CAPITALRX_CONVEYOR_ARTIFACTS_BUCKET", "x") -}}"',
      '}',
      '',
    ].join('\n');
    assert.strictEqual(
      formatTemplate(source, miniFmt),
      [
        'variable "artifacts" {',
        '  default = "{{ os.environ.get("CAPITALRX_CONVEYOR_ARTIFACTS_BUCKET", "x") -}}"',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('keeps an interpolation used as part of a bare identifier or label', () => {
    const source = ['variable "{{prefix}}_node_group_name" {', 'default = 1', '}', ''].join('\n');
    assert.strictEqual(
      formatTemplate(source, miniFmt),
      ['variable "{{prefix}}_node_group_name" {', '  default = 1', '}', ''].join('\n'),
    );
  });

  test('leaves a raw body literal, braces and all', () => {
    const source = [
      'resource "r" "n" {',
      '{% raw %}',
      'message = "Use verification code {####} for member portal authentication."',
      '{% endraw %}',
      '}',
      '',
    ].join('\n');
    // `{####}` reads as a Jinja comment to anything that scans the body, which is exactly what
    // `{% raw %}` is there to prevent; it must come back on its own line, unread and unmoved.
    assert.strictEqual(
      formatTemplate(source, miniFmt),
      [
        'resource "r" "n" {',
        '  {% raw %}',
        '  message = "Use verification code {####} for member portal authentication."',
        '  {% endraw %}',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('reproduces whitespace-control markers byte for byte', () => {
    const source = ['locals {', '{%- if a -%}', 'x = "{{- v -}}"', '{%- endif -%}', '}', ''].join('\n');
    const result = formatTemplate(source, miniFmt);
    assert.ok(result);
    assert.deepStrictEqual(jinja(result), ['{%- if a -%}', '{{- v -}}', '{%- endif -%}']);
    assert.strictEqual(
      result,
      ['locals {', '  {%- if a -%}', '  x = "{{- v -}}"', '  {%- endif -%}', '}', ''].join('\n'),
    );
  });

  test('formats both branches of an if/else at once', () => {
    const source = [
      'resource "r" "n" {',
      '{% if a %}',
      'cpu = 1',
      '{% else %}',
      'memory = 2',
      '{% endif %}',
      '}',
      '',
    ].join('\n');
    assert.strictEqual(
      formatTemplate(source, miniFmt),
      [
        'resource "r" "n" {',
        '  {% if a %}',
        '  cpu = 1',
        '  {% else %}',
        '  memory = 2',
        '  {% endif %}',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('formats each branch alone when they define one attribute twice', () => {
    // Both branches live at once is "Attribute redefined" to fmt, so each is formatted with the
    // others suppressed and the results are stitched back together.
    const source = [
      'variable "v" {',
      '{% if a %}',
      'default   = 1',
      '{% else %}',
      'default = 2',
      '{% endif %}',
      '}',
      '',
    ].join('\n');
    const out = formatTemplate(source, miniFmt);
    assert.ok(out, 'the whole-file pass declines this; the per-branch pass must not');
    const bodies = out.split('\n').filter((l) => l.includes('default'));
    assert.strictEqual(bodies.length, 2, 'both branches survive');
    assert.ok(
      bodies.every((l) => /^ {2}\S/.test(l)),
      `both branches indented into the block, got ${JSON.stringify(bodies)}`,
    );
    assert.strictEqual((out.match(/\{%/g) ?? []).length, 3, 'all three tags intact');
  });

  test('indents block bodies one level deeper when asked', () => {
    const source = ['variable "v" {', '{% if a %}', 'default = 1', '{% endif %}', '}', ''].join('\n');
    const flat = formatTemplate(source, miniFmt);
    const nested = formatTemplate(source, miniFmt, { indentBlocks: true });
    assert.ok(flat && nested);
    const body = (text: string): string => text.split('\n').find((l) => l.includes('default')) ?? '';
    assert.strictEqual(body(nested).length - body(flat).length, 2, 'body should gain exactly one level');
    const tag = (text: string): string => text.split('\n').find((l) => l.includes('{% if')) ?? '';
    assert.strictEqual(tag(nested), tag(flat), 'the tag line itself should not move');
  });

  test('is idempotent', () => {
    const source = ['locals {', '{% if a %}', 'x = 1', '{% endif %}', '{# note #}', 'y = "{{ v }}"', '}', ''].join(
      '\n',
    );
    const once = formatTemplate(source, miniFmt);
    assert.ok(once);
    assert.strictEqual(formatTemplate(once, miniFmt), once);
  });

  test('declines when the formatter rejects the masked text', () => {
    assert.strictEqual(formatTemplate('locals {\n{% if a %}\nx = 1\n', miniFmt), undefined);
  });

  test('declines an unterminated construct without calling the formatter', () => {
    let called = false;
    const spy: Formatter = (hcl) => {
      called = true;
      return hcl;
    };
    assert.strictEqual(formatTemplate('x = "{{ oops"\n', spy), undefined);
    assert.strictEqual(called, false);
  });

  test('declines when the formatter changes anything but whitespace', () => {
    // Real `terraform fmt` quotes a bare block label, which would wrap the Jinja in quotes it
    // never had. Nothing outside a Jinja span may come back different.
    const quoteLabels: Formatter = (hcl) => hcl.replace(/^variable (\S+) \{/m, 'variable "$1" {');
    assert.strictEqual(formatTemplate('variable {{ name }} {\n  default = 1\n}\n', quoteLabels), undefined);
  });

  test('declines when a placeholder does not come back exactly once', () => {
    assert.strictEqual(
      formatTemplate('{% if a %}\nx = 1\n{% endif %}\n', (hcl) => hcl.split('\n')[0]),
      undefined,
    );
    assert.strictEqual(
      formatTemplate('{% if a %}\nx = 1\n{% endif %}\n', (hcl) => hcl + hcl),
      undefined,
    );
  });

  test('hands a template with no Jinja straight to the formatter', () => {
    assert.strictEqual(formatTemplate('locals {\nx = 1\n}\n', miniFmt), 'locals {\n  x = 1\n}\n');
  });
});
