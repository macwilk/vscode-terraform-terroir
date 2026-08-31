/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import { buildLineMap } from './lineMap';

suite('lineMap', () => {
  test('deleted tag-only line vanishes and is unmapped', () => {
    const source = ['a = 1', '{% if false %}', 'b = 2', '{% endif %}', 'c = 3'].join('\n');
    const rendered = ['a = 1', 'c = 3'].join('\n');
    const map = buildLineMap(source, rendered);
    assert.strictEqual(map.sourceLineOf(0), 0);
    assert.strictEqual(map.sourceLineOf(1), 4);
    assert.strictEqual(map.renderedLineOf(0), 0);
    assert.strictEqual(map.renderedLineOf(4), 1);
    assert.strictEqual(map.renderedLineOf(1), undefined);
    assert.strictEqual(map.renderedLineOf(2), undefined);
  });

  test('substituted inline interpolation maps prefix/suffix columns, not the middle', () => {
    const source = ['resource "x" "y" {', '  default = "{{ os.environ[\'CAPITALRX_ENVIRONMENT\'] -}}"', '}'].join('\n');
    const rendered = ['resource "x" "y" {', '  default = "staging"', '}'].join('\n');
    const map = buildLineMap(source, rendered);
    assert.strictEqual(map.sourceLineOf(1), 1);
    assert.deepStrictEqual(map.toRendered({ line: 1, character: 5 }), { line: 1, character: 5 });
    assert.strictEqual(map.toRendered({ line: 1, character: 20 }), undefined);

    const srcLine = source.split('\n')[1];
    const rendLine = rendered.split('\n')[1];
    const suffixChar = srcLine.length - 1;
    const mapped = map.toRendered({ line: 1, character: suffixChar });
    assert.ok(mapped);
    assert.strictEqual(mapped.character, suffixChar + (rendLine.length - srcLine.length));
  });

  test('duplicated for-loop body: every copy maps to source, renderedLineOf is the first', () => {
    const source = ['{% for x in items %}', '  name = "{{ x }}"', '{% endfor %}', 'done = true'].join('\n');
    const rendered = ['  name = "a"', '  name = "b"', '  name = "c"', 'done = true'].join('\n');
    const map = buildLineMap(source, rendered);
    assert.strictEqual(map.renderedLineOf(1), 0);
    assert.strictEqual(map.sourceLineOf(0), 1);
    assert.strictEqual(map.sourceLineOf(1), 1);
    assert.strictEqual(map.sourceLineOf(2), 1);
    assert.strictEqual(map.renderedLineOf(0), undefined);
    assert.strictEqual(map.renderedLineOf(2), undefined);
  });

  test('fully unchanged file maps every line and column to itself', () => {
    const text = ['a = 1', 'b = 2', 'c = 3'].join('\n');
    const map = buildLineMap(text, text);
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(map.sourceLineOf(i), i);
      assert.strictEqual(map.renderedLineOf(i), i);
      assert.deepStrictEqual(map.toRendered({ line: i, character: 2 }), { line: i, character: 2 });
    }
  });

  test('a bad region does not cascade past the anchor after it', () => {
    const source = [
      'unique_anchor_1 = true',
      'totally_different_content_a = 111',
      'totally_different_content_b = 222',
      'unique_anchor_2 = true',
    ].join('\n');
    const rendered = ['unique_anchor_1 = true', 'something_else_entirely_x = 999', 'unique_anchor_2 = true'].join('\n');
    const map = buildLineMap(source, rendered);
    assert.strictEqual(map.sourceLineOf(0), 0);
    assert.strictEqual(map.renderedLineOf(0), 0);
    assert.strictEqual(map.sourceLineOf(2), 3);
    assert.strictEqual(map.renderedLineOf(3), 2);
  });

  test('never guesses a pairing from shared indentation alone', () => {
    const source = ['unique_anchor_a = 1', '  qualifier     = aws_lambda_alias.foo.name', 'unique_anchor_b = 1'].join(
      '\n',
    );
    const rendered = [
      'unique_anchor_a = 1',
      '  function_name = aws_lambda_function.bar.arn',
      'unique_anchor_b = 1',
    ].join('\n');
    const map = buildLineMap(source, rendered);
    assert.strictEqual(map.sourceLineOf(1), undefined);
    assert.strictEqual(map.renderedLineOf(1), undefined);
  });

  test('a tag wrapping real content on one line still counts as a rendered line', () => {
    // The line survives rendering as `name = "a"`, so dropping it as tag-only would slide the
    // line below it up onto it and report a confident, wrong pairing for both.
    const source = [
      'unique_anchor_a = 1',
      '{% if x %}name = "a"{% endif %}',
      'name = "{{ v }}"',
      'unique_anchor_b = 1',
    ].join('\n');
    const rendered = ['unique_anchor_a = 1', 'name = "a"', 'name = "b"', 'unique_anchor_b = 1'].join('\n');
    const map = buildLineMap(source, rendered);
    assert.notStrictEqual(map.sourceLineOf(1), 2);
    assert.strictEqual(map.renderedLineOf(2), 2);
  });

  test('a line of many tags is scanned, not backtracked over', () => {
    // Must sit in a gap so alignGap actually classifies it; an identical file is all anchors.
    const line = '{% a %}'.repeat(40) + 'X';
    const source = ['anchor_a = 1', line, 'anchor_b = 1'].join('\n');
    const rendered = ['anchor_a = 1', 'y = 2', 'anchor_b = 1'].join('\n');
    const started = Date.now();
    buildLineMap(source, rendered);
    assert.ok(Date.now() - started < 1000, 'tag-only detection must stay linear');
  });

  test('a run of blank lines is not evidence of a duplicated loop body', () => {
    const source = ['unique_anchor_a = 1', '', '{% endif %}', '{% if y %}', '', 'unique_anchor_b = 1'].join('\n');
    const rendered = ['unique_anchor_a = 1', '', '', '', '', 'unique_anchor_b = 1'].join('\n');
    const map = buildLineMap(source, rendered);
    let previous = -1;
    for (let r = 0; r < 6; r++) {
      const s = map.sourceLineOf(r);
      if (s === undefined) {
        continue;
      }
      assert.ok(s >= previous, `rendered line ${r} maps backwards to source line ${s}`);
      previous = s;
    }
  });

  test('out-of-range positions never guess', () => {
    const map = buildLineMap('a = 1', 'a = 1');
    assert.strictEqual(map.toRendered({ line: 5, character: 0 }), undefined);
    assert.strictEqual(map.toRendered({ line: 0, character: 999 }), undefined);
    assert.strictEqual(map.sourceLineOf(99), undefined);
  });
});
