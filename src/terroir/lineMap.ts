/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

export interface Position {
  /** 0-based, LSP convention. */
  line: number;
  /** 0-based, LSP convention. */
  character: number;
}

export interface LineMap {
  toRendered(pos: Position): Position | undefined;
  toSource(pos: Position): Position | undefined;
  sourceLineOf(renderedLine: number): number | undefined;
  renderedLineOf(sourceLine: number): number | undefined;
}

/**
 * A line's pairing with a line in the other document, plus enough of a diff
 * to answer column queries: the paired line shares `prefixLen` leading chars
 * and `suffixLen` trailing chars with this line's text (non-overlapping). An
 * identical pair has prefixLen === text.length, suffixLen === 0.
 */
interface LineEntry {
  otherLine: number;
  prefixLen: number;
  suffixLen: number;
}

// Above this many (source lines * rendered lines) cells, an unanchored gap is left unmapped
// rather than run through the O(n*m) local LCS fallback below. Anchoring keeps real gaps small
// in practice; this only guards the pathological case of a stretch with no unique-line anchors.
const LCS_BUDGET = 250_000;

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Whether the line is nothing but `{% ... %}` tags and whitespace — terroir renders it away
 * entirely, so it has no counterpart on the rendered side. Scanned rather than matched with a
 * regex: a tag body can itself contain `%}`, which a lazy-quantifier pattern either mistakes for
 * the end of the line's only tag (misreading `{% if x %}a = 1{% endif %}` as tag-only) or, on a
 * line of many tags, backtracks exponentially over.
 */
function isTagOnlyLine(text: string): boolean {
  let i = 0;
  let sawTag = false;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 9) {
      i++;
      continue;
    }
    if (!text.startsWith('{%', i)) {
      return false;
    }
    const end = text.indexOf('%}', i + 2);
    if (end < 0) {
      return false;
    }
    i = end + 2;
    sawTag = true;
  }
  return sawTag;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}

/** Suffix scan is capped to `budget` chars so it never overlaps a prefix already claimed. */
function commonSuffixLen(a: string, b: string, budget: number): number {
  let i = 0;
  while (i < budget && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) {
    i++;
  }
  return i;
}

/** Whether the matched prefix/suffix carries real shared content, not just shared indentation. */
function isSubstantialOverlap(a: string, prefixLen: number, suffixLen: number): boolean {
  if (prefixLen > 0 && a.slice(0, prefixLen).trim() !== '') {
    return true;
  }
  if (suffixLen > 0 && a.slice(a.length - suffixLen).trim() !== '') {
    return true;
  }
  return false;
}

/**
 * The literal runs of a source line — what is left once every `{{ }}` / `{% %}` span is cut out.
 * Rendering replaces those spans with anything at all but cannot disturb the literals around them.
 * A `{{-`/`{%-` or `-}}`/`-%}` marker eats the whitespace on that side, so it is dropped here too.
 */
function literalSegments(text: string): string[] {
  const segments: string[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const isExpr = text.startsWith('{{', i);
    if (!isExpr && !text.startsWith('{%', i)) {
      i++;
      continue;
    }
    const end = text.indexOf(isExpr ? '}}' : '%}', i + 2);
    if (end < 0) {
      break;
    }
    const before = text.slice(start, i);
    segments.push(text.charAt(i + 2) === '-' ? before.trimEnd() : before);
    start = end + 2;
    if (text.charAt(end - 1) === '-') {
      while (start < text.length && text.charAt(start).trim() === '') {
        start++;
      }
    }
    i = start;
  }
  segments.push(text.slice(start));
  return segments;
}

/** Whether `rendered` could have come from `source` by substituting each of its Jinja spans. */
function couldRenderTo(source: string, rendered: string): boolean {
  const segments = literalSegments(source);
  if (segments.length === 1) {
    return source === rendered;
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first.length + last.length > rendered.length) {
    return false;
  }
  if (!rendered.startsWith(first) || !rendered.endsWith(last)) {
    return false;
  }
  const limit = rendered.length - last.length;
  let at = first.length;
  for (let k = 1; k < segments.length - 1; k++) {
    const segment = segments[k];
    if (segment === '') {
      continue;
    }
    const found = rendered.indexOf(segment, at);
    if (found < 0 || found + segment.length > limit) {
      return false;
    }
    at = found + segment.length;
  }
  return true;
}

/**
 * Diffs two candidate lines. Returns undefined when they share no
 * substantial prefix or suffix — pairing them would be a guess, not a match.
 */
function diffLine(a: string, b: string): { prefixLen: number; suffixLen: number } | undefined {
  if (a === b) {
    return { prefixLen: a.length, suffixLen: 0 };
  }
  if (!couldRenderTo(a, b)) {
    return undefined;
  }
  const prefixLen = commonPrefixLen(a, b);
  const suffixLen = commonSuffixLen(a, b, Math.min(a.length, b.length) - prefixLen);
  if (!isSubstantialOverlap(a, prefixLen, suffixLen)) {
    return undefined;
  }
  return { prefixLen, suffixLen };
}

/**
 * Longest common subsequence of exactly-equal lines between the two ranges,
 * as ascending (sourceLine, renderedLine) pairs. O(n*m); callers bound the
 * cell count before calling.
 */
function exactLcs(
  sourceLines: string[],
  renderedLines: string[],
  sLo: number,
  sHi: number,
  rLo: number,
  rHi: number,
): [number, number][] {
  const n = sHi - sLo;
  const m = rHi - rLo;
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Int32Array(m + 1);
  }
  for (let i = 1; i <= n; i++) {
    const sLine = sourceLines[sLo + i - 1];
    for (let j = 1; j <= m; j++) {
      dp[i][j] = sLine === renderedLines[rLo + j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = n,
    j = m;
  while (i > 0 && j > 0) {
    if (sourceLines[sLo + i - 1] === renderedLines[rLo + j - 1]) {
      pairs.push([sLo + i - 1, rLo + j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return pairs;
}

/**
 * Lines that are textually identical AND appear exactly once within their
 * respective ranges — reliable anchors, patience-diff style. Returned sorted
 * by source index and increasing in rendered index (a longest increasing
 * subsequence over rendered index), which is what bounds a bad region to the
 * gap around it instead of letting it cascade past a good one.
 */
function findAnchors(
  sourceLines: string[],
  renderedLines: string[],
  sLo: number,
  sHi: number,
  rLo: number,
  rHi: number,
): [number, number][] {
  const sourcePositions = new Map<string, number>(); // text -> index, or -1 if not unique
  for (let i = sLo; i < sHi; i++) {
    const text = sourceLines[i];
    if (isBlank(text)) {
      continue;
    }
    sourcePositions.set(text, sourcePositions.has(text) ? -1 : i);
  }
  const renderedPositions = new Map<string, number>();
  for (let j = rLo; j < rHi; j++) {
    const text = renderedLines[j];
    if (isBlank(text)) {
      continue;
    }
    renderedPositions.set(text, renderedPositions.has(text) ? -1 : j);
  }

  const candidates: [number, number][] = [];
  for (const [text, sIdx] of sourcePositions) {
    if (sIdx === -1) {
      continue;
    }
    const rIdx = renderedPositions.get(text);
    if (rIdx === undefined || rIdx === -1) {
      continue;
    }
    candidates.push([sIdx, rIdx]);
  }
  candidates.sort((a, b) => a[0] - b[0]);

  // Patience sorting: longest increasing subsequence on rendered index.
  const tails: number[] = []; // candidates-index of the smallest-tail-rIdx chain of each length
  const prev: number[] = new Array(candidates.length).fill(-1);
  for (let i = 0; i < candidates.length; i++) {
    const rIdx = candidates[i][1];
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]][1] < rIdx) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tails[lo - 1];
    }
    if (lo === tails.length) {
      tails.push(i);
    } else {
      tails[lo] = i;
    }
  }
  const lis: [number, number][] = [];
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    lis.push(candidates[k]);
    k = prev[k];
  }
  lis.reverse();
  return lis;
}

export function buildLineMap(source: string, rendered: string): LineMap {
  const sourceLines = splitLines(source);
  const renderedLines = splitLines(rendered);
  const sourceToRendered: (LineEntry | undefined)[] = new Array(sourceLines.length).fill(undefined);
  const renderedToSource: (LineEntry | undefined)[] = new Array(renderedLines.length).fill(undefined);

  function pair(sIdx: number, rIdx: number, prefixLen: number, suffixLen: number): void {
    renderedToSource[rIdx] = { otherLine: sIdx, prefixLen, suffixLen };
    // First occurrence wins: for a source line duplicated by a {% for %} body, this is called
    // for chunk 0 before any later chunk, since chunks are processed in ascending rendered order.
    sourceToRendered[sIdx] ??= { otherLine: rIdx, prefixLen, suffixLen };
  }

  function pairIfConfident(sIdx: number, rIdx: number): void {
    const d = diffLine(sourceLines[sIdx], renderedLines[rIdx]);
    if (d) {
      pair(sIdx, rIdx, d.prefixLen, d.suffixLen);
    }
  }

  // Aligns a gap that findAnchors found nothing in. A {% for %} body repeats k>=1 times in the
  // rendered output, but its surrounding tag-only lines (the {% for %}/{% endfor %} themselves,
  // or an {% if %} whose body this is part of) never appear there at all — so the source side is
  // sized by its non-tag lines first; k=1 is then just the ordinary equal-length case.
  function alignGap(sLo: number, sHi: number, rLo: number, rHi: number): void {
    const renderedLen = rHi - rLo;
    if (sHi <= sLo || renderedLen <= 0) {
      return;
    }

    const kept: number[] = [];
    for (let i = sLo; i < sHi; i++) {
      if (!isTagOnlyLine(sourceLines[i])) {
        kept.push(i);
      }
    }
    if (kept.length > 0 && renderedLen % kept.length === 0) {
      const chunkLen = kept.length;
      const chunks = renderedLen / chunkLen;
      // Reading a gap as a loop body repeated k>=2 times needs evidence that a line was really
      // duplicated. A run of blank lines divides evenly by any count, so without this an all-blank
      // gap "proves" a loop that isn't there and shuffles those blanks into a bogus order.
      if (chunks > 1 && !kept.some((i) => !isBlank(sourceLines[i]))) {
        return;
      }
      for (let c = 0; c < chunks; c++) {
        const base = rLo + c * chunkLen;
        for (let i = 0; i < chunkLen; i++) {
          pairIfConfident(kept[i], base + i);
        }
      }
      return;
    }

    // Irregular shape even after dropping tag-only lines (e.g. a loop body that itself contains
    // an untaken branch). Fall back to local anchors — lines exactly equal within just this gap —
    // via a bounded LCS, and recurse on the smaller gaps around them. Never guess past the budget.
    if ((sHi - sLo) * renderedLen > LCS_BUDGET) {
      return;
    }
    const localAnchors = exactLcs(sourceLines, renderedLines, sLo, sHi, rLo, rHi);
    if (localAnchors.length === 0) {
      // No exact-equal line to anchor on anywhere in the gap: recursing on this same range
      // again would never terminate, so leave it unmapped rather than guess.
      return;
    }
    let prevS = sLo,
      prevR = rLo;
    for (const [s, r] of localAnchors) {
      alignGap(prevS, s, prevR, r);
      pair(s, r, sourceLines[s].length, 0);
      prevS = s + 1;
      prevR = r + 1;
    }
    alignGap(prevS, sHi, prevR, rHi);
  }

  const stack: [number, number, number, number][] = [[0, sourceLines.length, 0, renderedLines.length]];
  for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
    const [sLo, sHi, rLo, rHi] = range;
    if (sHi <= sLo || rHi <= rLo) {
      continue;
    }

    const anchors = findAnchors(sourceLines, renderedLines, sLo, sHi, rLo, rHi);
    if (anchors.length === 0) {
      alignGap(sLo, sHi, rLo, rHi);
      continue;
    }
    let prevS = sLo,
      prevR = rLo;
    for (const [sIdx, rIdx] of anchors) {
      stack.push([prevS, sIdx, prevR, rIdx]);
      pair(sIdx, rIdx, sourceLines[sIdx].length, 0);
      prevS = sIdx + 1;
      prevR = rIdx + 1;
    }
    stack.push([prevS, sHi, prevR, rHi]);
  }

  function mapPosition(
    pos: Position,
    ownLines: string[],
    otherLines: string[],
    ownToOther: (LineEntry | undefined)[],
  ): Position | undefined {
    if (!Number.isInteger(pos.line) || pos.line < 0 || pos.line >= ownToOther.length) {
      return undefined;
    }
    const entry = ownToOther[pos.line];
    if (!entry) {
      return undefined;
    }
    const ownText = ownLines[pos.line];
    const otherText = otherLines[entry.otherLine];
    const c = pos.character;
    if (!Number.isInteger(c) || c < 0 || c > ownText.length) {
      return undefined;
    }
    if (c <= entry.prefixLen) {
      return { line: entry.otherLine, character: c };
    }
    if (c >= ownText.length - entry.suffixLen) {
      return { line: entry.otherLine, character: c + (otherText.length - ownText.length) };
    }
    return undefined;
  }

  return {
    toRendered(pos) {
      return mapPosition(pos, sourceLines, renderedLines, sourceToRendered);
    },
    toSource(pos) {
      return mapPosition(pos, renderedLines, sourceLines, renderedToSource);
    },
    sourceLineOf(renderedLine) {
      if (!Number.isInteger(renderedLine) || renderedLine < 0 || renderedLine >= renderedToSource.length) {
        return undefined;
      }
      return renderedToSource[renderedLine]?.otherLine;
    },
    renderedLineOf(sourceLine) {
      if (!Number.isInteger(sourceLine) || sourceLine < 0 || sourceLine >= sourceToRendered.length) {
        return undefined;
      }
      return sourceToRendered[sourceLine]?.otherLine;
    },
  };
}
