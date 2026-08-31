/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import { applyLineEdits, safeLineEdits } from './formatEdits';
import { buildLineMap } from './lineMap';

suite('formatEdits', () => {
  test('replays an edit whose span is untouched by the template', () => {
    const source = ['resource "x" "y" {', '{% if true %}', '  a   = 1', '{% endif %}', '}'].join('\n');
    const rendered = ['resource "x" "y" {', '  a   = 1', '}'].join('\n');
    const map = buildLineMap(source, rendered);
    const safe = safeLineEdits(source, rendered, map, [{ startLine: 1, endLine: 2, newText: '  a = 1\n' }]);
    assert.deepStrictEqual(safe, [{ startLine: 2, endLine: 3, newText: '  a = 1\n' }]);
    assert.strictEqual(
      applyLineEdits(source, safe),
      ['resource "x" "y" {', '{% if true %}', '  a = 1', '{% endif %}', '}'].join('\n'),
    );
  });

  test('refuses an edit over an interpolated line, which would bake in the value', () => {
    const source = ['a = "{{ os.environ[\'CAPITALRX_ENVIRONMENT\'] }}"'].join('\n');
    const rendered = ['a = "staging"'].join('\n');
    const map = buildLineMap(source, rendered);
    const safe = safeLineEdits(source, rendered, map, [{ startLine: 0, endLine: 1, newText: 'a = "staging"\n' }]);
    assert.deepStrictEqual(safe, []);
  });

  test('refuses an edit whose span changes length between source and render', () => {
    const source = ['a = 1', '{% if x %}', 'b = 2', '{% endif %}', 'c = 3'].join('\n');
    const rendered = ['a = 1', 'b = 2', 'c = 3'].join('\n');
    const map = buildLineMap(source, rendered);
    const safe = safeLineEdits(source, rendered, map, [{ startLine: 0, endLine: 3, newText: 'a=1\nb=2\nc=3\n' }]);
    assert.deepStrictEqual(safe, []);
  });

  test('refuses an unmappable edit rather than guessing', () => {
    const source = ['a = 1'].join('\n');
    const rendered = ['a = 1'].join('\n');
    const map = buildLineMap(source, rendered);
    const safe = safeLineEdits(source, rendered, map, [{ startLine: 90, endLine: 91, newText: 'x\n' }]);
    assert.deepStrictEqual(safe, []);
  });

  test('applies several edits without shifting each other', () => {
    const source = ['a   = 1', 'b = 2', 'c   = 3'].join('\n');
    const edits = [
      { startLine: 0, endLine: 1, newText: 'a = 1\n' },
      { startLine: 2, endLine: 3, newText: 'c = 3\n' },
    ];
    assert.strictEqual(applyLineEdits(source, edits), ['a = 1', 'b = 2', 'c = 3'].join('\n'));
  });

  test('no edits is the identity', () => {
    const source = ['a = 1', '{% if x %}', 'b = 2', '{% endif %}'].join('\n');
    assert.strictEqual(applyLineEdits(source, []), source);
  });
});
