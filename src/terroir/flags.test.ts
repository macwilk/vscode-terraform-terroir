/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import {
  completionContextAtCharacter,
  describeFlag,
  findFlagKeyOffset,
  findFlagReferences,
  flagNameAtCharacter,
  flagProblem,
  offsetToPosition,
  parseFlagSettings,
  resolveFlag,
} from './flags';

suite('flags', () => {
  suite('parseFlagSettings', () => {
    test('parses flat flag values', () => {
      const flags = parseFlagSettings('{\n  "a.b": ["staging", "prod"],\n  "c.d": true\n}');
      assert.deepStrictEqual(flags, { 'a.b': ['staging', 'prod'], 'c.d': true });
    });

    test('empty object on unparsable input rather than throwing', () => {
      assert.deepStrictEqual(parseFlagSettings('not json'), {});
    });
  });

  suite('resolveFlag', () => {
    const flags = {
      'on.list': ['staging', 'uat'],
      'with.test.already': ['staging', 'test'],
      'always.on': true,
      'always.off': false,
      'off.empty': [],
    };

    test('missing key', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'nope'), { kind: 'missing' });
    });

    test('non-empty list gets "test" appended, mirroring is_enabled', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'on.list'), {
        kind: 'list',
        declared: ['staging', 'uat'],
        effective: ['staging', 'uat', 'test'],
      });
    });

    test('non-empty list already containing "test" is not duplicated', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'with.test.already'), {
        kind: 'list',
        declared: ['staging', 'test'],
        effective: ['staging', 'test'],
      });
    });

    test('boolean true', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'always.on'), { kind: 'boolean', value: true });
    });

    test('boolean false', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'always.off'), { kind: 'boolean', value: false });
    });

    test('empty list is its own case, distinct from a non-empty list', () => {
      assert.deepStrictEqual(resolveFlag(flags, 'off.empty'), { kind: 'empty-list' });
    });
  });

  suite('describeFlag', () => {
    test('flags real terroir crashing on a truthy boolean', () => {
      const text = describeFlag('x', { kind: 'boolean', value: true });
      assert.match(text, /AttributeError/);
    });

    test('does not warn of a crash for boolean false', () => {
      const text = describeFlag('x', { kind: 'boolean', value: false });
      assert.doesNotMatch(text, /AttributeError/);
    });

    test('says plainly when a flag is missing', () => {
      const text = describeFlag('x', { kind: 'missing' });
      assert.match(text, /Not defined/);
    });
  });

  suite('findFlagKeyOffset', () => {
    test('finds a top-level key, excluding its quotes', () => {
      const text = '{\n  "a.b": ["staging"],\n  "c.d": true\n}';
      const found = findFlagKeyOffset(text, 'c.d');
      assert.ok(found);
      assert.strictEqual(text.slice(found.offset, found.offset + found.length), 'c.d');
    });

    test('returns undefined for a key that is not present', () => {
      assert.strictEqual(findFlagKeyOffset('{"a": true}', 'b'), undefined);
    });
  });

  suite('offsetToPosition', () => {
    test('converts an offset on the first line', () => {
      assert.deepStrictEqual(offsetToPosition('abc\ndef', 2), { line: 0, character: 2 });
    });

    test('converts an offset on a later line', () => {
      assert.deepStrictEqual(offsetToPosition('abc\ndef\nghi', 9), { line: 2, character: 1 });
    });
  });

  suite('flagNameAtCharacter', () => {
    const line = '{% if is_enabled("adjudication.ecs.api") %}';

    test('matches when the cursor is inside the quoted flag name', () => {
      const match = flagNameAtCharacter(line, 25);
      assert.strictEqual(match?.name, 'adjudication.ecs.api');
    });

    test('matches when the cursor sits on a bounding quote', () => {
      const openQuote = line.indexOf('"');
      assert.strictEqual(flagNameAtCharacter(line, openQuote)?.name, 'adjudication.ecs.api');
    });

    test('does not match outside the call', () => {
      assert.strictEqual(flagNameAtCharacter(line, 2), undefined);
    });

    test('does not match a call with no string literal yet', () => {
      assert.strictEqual(flagNameAtCharacter('is_enabled(', 11), undefined);
    });
  });

  suite('completionContextAtCharacter', () => {
    test('detects an open quote right after is_enabled(', () => {
      const line = '{% if is_enabled("';
      const ctx = completionContextAtCharacter(line, line.length);
      assert.deepStrictEqual(ctx, { prefix: '', start: line.length });
    });

    test('detects partially typed flag name', () => {
      const line = '{% if is_enabled("adjud';
      const ctx = completionContextAtCharacter(line, line.length);
      assert.deepStrictEqual(ctx, { prefix: 'adjud', start: line.length - 5 });
    });

    test('does not trigger once the literal is closed', () => {
      const line = '{% if is_enabled("adjudication.ecs.api") %}';
      assert.strictEqual(completionContextAtCharacter(line, line.length), undefined);
    });

    test('does not trigger outside an is_enabled( call', () => {
      assert.strictEqual(completionContextAtCharacter('a = "b', 6), undefined);
    });
  });
});

suite('flag linting', () => {
  test('finds every is_enabled call site with its range', () => {
    const text = ['{% if is_enabled("a.b") %}', 'x = 1', '{% elif is_enabled("c.d") %}'].join('\n');
    const refs = findFlagReferences(text);
    assert.deepStrictEqual(
      refs.map((r) => [r.name, r.line]),
      [
        ['a.b', 0],
        ['c.d', 2],
      ],
    );
    assert.strictEqual(text.split('\n')[0].slice(refs[0].start, refs[0].end), '"a.b"');
  });

  test('reports a flag that is absent from settings.json', () => {
    const problem = flagProblem(resolveFlag({}, 'nope'), 'nope');
    assert.ok(problem);
    assert.strictEqual(problem.severe, false);
    assert.ok(/not defined/.test(problem.message));
  });

  test('reports a boolean flag as an error, because terroir would crash', () => {
    const problem = flagProblem(resolveFlag({ x: true }, 'x'), 'x');
    assert.ok(problem);
    assert.strictEqual(problem.severe, true);
    assert.ok(/AttributeError/.test(problem.message));
  });

  test('an empty list is deliberate and not reported', () => {
    assert.strictEqual(flagProblem(resolveFlag({ x: [] }, 'x'), 'x'), undefined);
  });

  test('a normal flag is not reported', () => {
    assert.strictEqual(flagProblem(resolveFlag({ x: ['staging'] }, 'x'), 'x'), undefined);
  });
});
