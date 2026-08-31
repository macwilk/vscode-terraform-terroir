/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as assert from 'assert';
import { translateSemanticTokens } from './semanticTokens';

suite('semanticTokens', () => {
  const identity = (pos: { line: number; character: number }) => pos;

  test('round-trips delta encoding when nothing moves', () => {
    const data = [0, 4, 3, 1, 0, 0, 6, 2, 2, 0, 2, 1, 5, 3, 0];
    assert.deepStrictEqual([...translateSemanticTokens(data, identity)], data);
  });

  test('shifts tokens by the lines the render dropped', () => {
    // rendered line n came from template line n + 2
    const shift = (pos: { line: number; character: number }) => ({ line: pos.line + 2, character: pos.character });
    const out = [...translateSemanticTokens([0, 4, 3, 1, 0, 1, 2, 4, 1, 0], shift)];
    assert.strictEqual(out[0], 2, 'first token moves to line 2');
    assert.strictEqual(out[5], 1, 'the delta between the two tokens is preserved');
  });

  test('drops a token whose position does not map rather than guessing', () => {
    const only = (pos: { line: number; character: number }) => (pos.line === 0 ? pos : undefined);
    const out = translateSemanticTokens([0, 4, 3, 1, 0, 1, 2, 4, 1, 0], only);
    assert.strictEqual(out.length, 5, 'one token survives');
  });

  test('re-sorts when mapping reorders tokens', () => {
    const flip = (pos: { line: number; character: number }) => ({ line: 5 - pos.line, character: pos.character });
    const out = [...translateSemanticTokens([0, 1, 1, 0, 0, 1, 1, 1, 0, 0], flip)];
    assert.strictEqual(out[0], 4, 'lowest line first after the flip');
    assert.ok(out[5] >= 0, 'deltas stay non-negative');
  });

  test('empty input stays empty', () => {
    assert.strictEqual(translateSemanticTokens([], identity).length, 0);
  });
});
