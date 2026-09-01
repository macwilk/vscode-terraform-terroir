/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

/** Runs `terraform fmt` over HCL text; resolves undefined if fmt rejects it. */
export type Formatter = (hcl: string) => string | undefined | Promise<string | undefined>;

interface Span {
  start: number;
  end: number;
  /** `{{ }}` stands for a value; `{% %}` and `{# #}` are control-flow trivia that must vanish. */
  isExpr: boolean;
}

const CLOSE_OF: Record<string, string | undefined> = { '{{': '}}', '{%': '%}', '{#': '#}' };
const RAW_OPEN = /^\{%-?\s*raw\s*-?%\}/;
const RAW_CLOSE = /\{%-?\s*endraw\s*-?%\}/;

/**
 * Every Jinja construct in `source`, in order. Scanned with indexOf rather than a lazy-quantifier
 * regex, matching the sibling scanner in lineMap.ts: a tag dense line makes the regex form
 * backtrack, and `[\s\S]*?` cannot be told which `%}` is really this tag's. Returns undefined for
 * an unterminated construct, the one way scanning itself can fail.
 */
function scan(source: string): Span[] | undefined {
  const spans: Span[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) {
      break;
    }
    const close = CLOSE_OF[source.slice(open, open + 2)];
    if (close === undefined) {
      i = open + 1;
      continue;
    }

    // Jinja does not interpret a raw body, so neither may we: only the two delimiters are spans,
    // and the literal between them stays in the masked HCL where fmt can still indent it.
    const rawOpen = close === '%}' ? RAW_OPEN.exec(source.slice(open)) : null;
    const rawBody = rawOpen ? open + rawOpen[0].length : -1;
    const rawClose = rawOpen ? RAW_CLOSE.exec(source.slice(rawBody)) : null;
    if (rawOpen && rawClose) {
      spans.push({ start: open, end: rawBody, isExpr: false });
      spans.push({
        start: rawBody + rawClose.index,
        end: rawBody + rawClose.index + rawClose[0].length,
        isExpr: false,
      });
      i = rawBody + rawClose.index + rawClose[0].length;
      continue;
    }

    const end = source.indexOf(close, open + 2);
    if (end < 0) {
      return undefined;
    }
    spans.push({ start: open, end: end + close.length, isExpr: close === '}}' });
    i = end + close.length;
  }
  return spans;
}

/**
 * A prefix absent from `source`, so every placeholder built from it is a string that can only have
 * come from us -- including when the file already holds one left behind by an aborted run. Grown
 * deterministically rather than randomly so that two runs over the same file mask it identically.
 */
function pickPrefix(source: string): string {
  let prefix = '__jinjamask';
  while (source.includes(prefix)) {
    prefix += 'x';
  }
  return prefix;
}

const squeeze = (text: string): string => text.replace(/\s+/g, '');

/**
 * The real guarantee, checked against output rather than assumed from the code that produced it:
 * the result must hold the same Jinja spans, byte for byte and in order, with the literal between
 * each pair differing only in whitespace. Together those say the formatter reindented the template
 * and did nothing else -- no token crossed a Jinja boundary, nothing was dropped or invented.
 */
function conserves(source: string, result: string, spans: Span[]): boolean {
  const after = scan(result);
  if (after?.length !== spans.length) {
    return false;
  }
  let sourceGap = 0;
  let resultGap = 0;
  for (let n = 0; n <= spans.length; n++) {
    const sourceEnd = n < spans.length ? spans[n].start : source.length;
    const resultEnd = n < spans.length ? after[n].start : result.length;
    if (squeeze(source.slice(sourceGap, sourceEnd)) !== squeeze(result.slice(resultGap, resultEnd))) {
      return false;
    }
    if (n < spans.length) {
      if (source.slice(spans[n].start, spans[n].end) !== result.slice(after[n].start, after[n].end)) {
        return false;
      }
      sourceGap = spans[n].end;
      resultGap = after[n].end;
    }
  }
  return true;
}

/** One whole-file mask/format/restore pass. `masking` may suppress lines before fmt sees them. */
async function formatPass(
  source: string,
  fmt: Formatter,
  masking?: (lines: string[]) => string[],
  unmasking?: (lines: string[]) => string[],
): Promise<string | undefined> {
  const spans = scan(source);
  if (!spans) {
    return undefined;
  }
  const prefix = pickPrefix(source);

  // Two placeholder shapes, chosen by what the construct stands for rather than by where it sits.
  // A control tag becomes a block comment, the only token legal at an arbitrary boundary -- glued
  // to a following `}`, sharing a line with real HCL, or nested in a `#` comment -- and the only
  // one that disappears from the parse the way the tag must. An interpolation becomes a bare
  // identifier, valid wherever a value belongs and, because the span's own quotes go with it, also
  // valid as a fragment of an already-open string or of a `"{{prefix}}_name"` label.
  const marks: string[] = [];
  let masked = '';
  let cursor = 0;
  for (const [n, span] of spans.entries()) {
    // The trailing `__` keeps mark 1 from matching inside mark 11.
    const mark = `${prefix}_${n}__`;
    marks.push(span.isExpr ? mark : `/*${mark}*/`);
    masked += source.slice(cursor, span.start) + marks[n];
    cursor = span.end;
  }
  masked += source.slice(cursor);
  if (masking) {
    masked = masking(masked.split('\n')).join('\n');
  }

  const raw = await fmt(masked);
  if (raw === undefined) {
    return undefined;
  }
  // Scaffolding has to come off before the conservation check below, which would otherwise
  // (correctly) reject our own suppression comments as content that is not in the source.
  const formatted = unmasking ? unmasking(raw.split('\n')).join('\n') : raw;

  // Each placeholder must survive exactly once. Zero means something swallowed it, more than one
  // means it collided with real text, and substituting blind under either would corrupt the file.
  let restored = formatted;
  for (const [n, mark] of marks.entries()) {
    const at = restored.indexOf(mark);
    if (at < 0 || restored.includes(mark, at + mark.length)) {
      return undefined;
    }
    restored = restored.slice(0, at) + source.slice(spans[n].start, spans[n].end) + restored.slice(at + mark.length);
  }

  return conserves(source, restored, spans) ? restored : undefined;
}

interface Branch {
  /** Jinja nesting depth of the lines inside this branch. */
  depth: number;
  lines: number[];
}

/**
 * Group the template's lines by which conditional branch they sit in. A line outside every
 * conditional belongs to no branch and is formatted once, with the branches suppressed.
 */
function branches(
  source: string,
): { branchOf: (number | undefined)[]; depthOf: number[]; shiftable: boolean[]; groups: Branch[] } | undefined {
  const lines = source.split('\n');
  const branchOf: (number | undefined)[] = new Array(lines.length).fill(undefined);
  const depthOf: number[] = new Array(lines.length).fill(0);
  // `terraform fmt` never reindents a heredoc body, so neither may we: a shift applied there is
  // not undone by the next fmt and would accumulate on every save.
  const shiftable: boolean[] = new Array(lines.length).fill(true);
  // A tag may span lines ({% set x = [ ... ] %}); its interior is Jinja, not HCL, and shifting it
  // would rewrite bytes inside the construct.
  for (const span of scan(source) ?? []) {
    const first = source.slice(0, span.start).split('\n').length - 1;
    const last = source.slice(0, span.end).split('\n').length - 1;
    for (let i = first + 1; i <= last; i++) {
      shiftable[i] = false;
    }
  }
  let heredoc: string | undefined;
  const groups: Branch[] = [];
  const stack: number[] = [];
  let current: number | undefined;
  const currentStack: (number | undefined)[] = [];

  for (const [i, line] of lines.entries()) {
    if (heredoc !== undefined) {
      shiftable[i] = false;
      if (line.trim() === heredoc) {
        heredoc = undefined;
      }
      depthOf[i] = stack.length;
      branchOf[i] = current;
      if (current !== undefined) {
        groups[current].lines.push(i);
      }
      continue;
    }
    const opener = /<<-?\s*([A-Za-z_]\w*)\s*$/.exec(line);
    if (opener) {
      heredoc = opener[1];
    }

    const tag = /^\s*\{%-?\s*(\w+)/.exec(line);
    const keyword = tag?.[1];
    const isTagOnly = tag !== null && /%\}\s*$/.test(line);

    if (isTagOnly && keyword !== undefined && ['if', 'for', 'with'].includes(keyword)) {
      depthOf[i] = stack.length;
      currentStack.push(current);
      stack.push(i);
      current = groups.push({ depth: stack.length, lines: [] }) - 1;
      continue;
    }
    if (isTagOnly && keyword !== undefined && ['else', 'elif'].includes(keyword) && stack.length > 0) {
      depthOf[i] = stack.length - 1;
      current = groups.push({ depth: stack.length, lines: [] }) - 1;
      continue;
    }
    if (isTagOnly && keyword !== undefined && ['endif', 'endfor', 'endwith'].includes(keyword)) {
      if (stack.length === 0) {
        return undefined;
      }
      stack.pop();
      depthOf[i] = stack.length;
      current = currentStack.pop();
      continue;
    }

    depthOf[i] = stack.length;
    branchOf[i] = current;
    if (current !== undefined) {
      groups[current].lines.push(i);
    }
  }

  return stack.length === 0 ? { branchOf, depthOf, shiftable, groups } : undefined;
}

const SUPPRESSED = /^(\s*)\/\/ ?/;

/** Suppress a line so fmt still sees a well-formed document but ignores its content. */
function suppress(line: string): string {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  return line.trim() === '' ? line : `${indent}// ${line.trim()}`;
}

function unsuppress(line: string): string {
  return line.replace(SUPPRESSED, '$1');
}

export interface FormatOptions {
  /** Indent the body of each Jinja block one level deeper than its tags. */
  indentBlocks?: boolean;
  indentUnit?: string;
  /**
   * Give up after this long. Formatting each branch separately costs one `terraform fmt` per
   * branch, and a file with large branch bodies can run to tens of seconds -- long enough that
   * finishing is worse than declining.
   */
  budgetMs?: number;
  /** Told why a template was left alone, so a decline is explicable rather than mysterious. */
  onDecline?: (reason: string) => void;
}

/**
 * Re-indent block bodies. `terraform fmt` sees the tags as comments and pulls their bodies to the
 * enclosing HCL level, so the nesting has to be reapplied afterwards -- which is also what makes
 * it idempotent, since the same canonical output is produced before the shift each time.
 */
function indentBlocks(text: string, depthOf: number[], shiftable: boolean[], unit: string): string {
  return text
    .split('\n')
    .map((line, i) => {
      const depth = depthOf[i] ?? 0;
      return depth > 0 && shiftable[i] && line.trim() !== '' ? unit.repeat(depth) + line : line;
    })
    .join('\n');
}

/**
 * Format a Jinja terraform template. Returns undefined when the template cannot be formatted
 * safely, in which case the caller leaves the file alone.
 */
export async function formatTemplate(
  source: string,
  fmt: Formatter,
  options: FormatOptions = {},
): Promise<string | undefined> {
  const unit = options.indentUnit ?? '  ';
  const deadline = Date.now() + (options.budgetMs ?? 3000);
  const decline = (reason: string): void => {
    options.onDecline?.(reason);
  };
  const structure = branches(source);

  const spansOf = scan(source);

  /** Apply the nesting shift, then re-establish the guarantee over the shifted text. */
  const finish = (text: string): string | undefined => {
    if (!options.indentBlocks || !structure) {
      return text;
    }
    const shifted = indentBlocks(text, structure.depthOf, structure.shiftable, unit);
    return spansOf && conserves(source, shifted, spansOf) ? shifted : undefined;
  };

  // Fast path: every branch live at once. Only valid when no two branches define the same
  // attribute, which `terraform fmt` rejects outright as "Attribute redefined".
  const whole = await formatPass(source, fmt);
  if (whole !== undefined) {
    return finish(whole);
  }
  if (!structure) {
    decline("the template's Jinja blocks are not balanced");
    return undefined;
  }
  if (structure.groups.length === 0) {
    decline('terraform fmt rejected the masked template and it has no branches to isolate');
    return undefined;
  }

  // Otherwise format each branch as though it were the only one present, and take each line from
  // the pass in which it was live. Line counts must be preserved for that mapping to hold.
  const total = source.split('\n').length;
  const passes = new Map<number | undefined, string[]>();
  for (const live of [undefined, ...structure.groups.keys()]) {
    const hidden = (i: number): boolean => structure.branchOf[i] !== undefined && structure.branchOf[i] !== live;
    if (Date.now() > deadline) {
      decline(`gave up after ${options.budgetMs ?? 3000}ms over ${structure.groups.length} branches`);
      return undefined;
    }
    const out = await formatPass(
      source,
      fmt,
      (lines) => lines.map((line, i) => (hidden(i) ? suppress(line) : line)),
      (lines) => lines.map((line, i) => (hidden(i) ? unsuppress(line) : line)),
    );
    if (out === undefined) {
      decline('terraform fmt rejected a branch in isolation');
      return undefined;
    }
    const outLines = out.split('\n');
    if (outLines.length !== total) {
      decline('terraform fmt changed the line count, so lines could not be matched up');
      return undefined;
    }
    passes.set(live, outLines);
  }

  const merged = Array.from({ length: total }, (_, i) => {
    const from = passes.get(structure.branchOf[i]);
    return from?.[i] ?? source.split('\n')[i];
  }).join('\n');

  // Assembled from several passes, so the guarantee has to be re-established against the
  // original source rather than against the merged text itself.
  if (!spansOf || !conserves(source, merged, spansOf)) {
    decline('the merged result altered something outside a Jinja span');
    return undefined;
  }
  const done = finish(merged);
  if (done === undefined) {
    decline('indenting the blocks altered something outside a Jinja span');
  }
  return done;
}
