/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { Position } from './lineMap';

interface Token {
  line: number;
  char: number;
  length: number;
  type: number;
  modifiers: number;
}

/** LSP delta encoding: groups of five, each line and column relative to the token before it. */
function decode(data: Uint32Array | number[]): Token[] {
  const tokens: Token[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];
    line += deltaLine;
    char = deltaLine === 0 ? char + deltaChar : deltaChar;
    tokens.push({ line, char, length: data[i + 2], type: data[i + 3], modifiers: data[i + 4] });
  }
  return tokens;
}

function encode(tokens: Token[]): Uint32Array {
  const data = new Uint32Array(tokens.length * 5);
  let line = 0;
  let char = 0;
  for (const [n, token] of tokens.entries()) {
    const deltaLine = token.line - line;
    data[n * 5] = deltaLine;
    data[n * 5 + 1] = deltaLine === 0 ? token.char - char : token.char;
    data[n * 5 + 2] = token.length;
    data[n * 5 + 3] = token.type;
    data[n * 5 + 4] = token.modifiers;
    line = token.line;
    char = token.char;
  }
  return data;
}

/**
 * The server tokenised the rendered text, so its tokens are in rendered coordinates. Left
 * untranslated they paint the template at the wrong offset -- by exactly the number of Jinja
 * lines above them. A token whose position does not map is dropped rather than guessed at.
 */
export function translateSemanticTokens(
  data: Uint32Array | number[],
  toSource: (pos: Position) => Position | undefined,
): Uint32Array {
  const moved: Token[] = [];
  for (const token of decode(data)) {
    const mapped = toSource({ line: token.line, character: token.char });
    if (mapped) {
      moved.push({ ...token, line: mapped.line, char: mapped.character });
    }
  }
  moved.sort((a, b) => a.line - b.line || a.char - b.char);
  return encode(moved);
}
