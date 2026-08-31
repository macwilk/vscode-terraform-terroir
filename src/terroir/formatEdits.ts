/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { LineMap } from './lineMap';

export interface LineEdit {
  startLine: number;
  endLine: number;
  newText: string;
}

/**
 * terraform-ls formats the rendered text, so its edits are in rendered
 * coordinates. An edit may only be replayed onto the template where the span
 * it covers is byte-identical in both: that proves no Jinja tag and no
 * interpolated value lies inside it, so the replacement cannot overwrite a
 * template expression with whatever it rendered to.
 */
export function safeLineEdits(source: string, rendered: string, map: LineMap, edits: LineEdit[]): LineEdit[] {
  const sourceLines = source.split('\n');
  const renderedLines = rendered.split('\n');
  const safe: LineEdit[] = [];

  for (const edit of edits) {
    const start = map.sourceLineOf(edit.startLine);
    if (start === undefined) {
      continue;
    }

    // Each replaced line must map to the next source line in step, and hold
    // the same text. Checking the lines themselves rather than the span
    // endpoints matters: an endpoint lands on whatever follows the edit, which
    // is often a Jinja tag, and measuring across it rejects sound edits.
    let ok = true;
    for (let offset = 0; offset < edit.endLine - edit.startLine; offset++) {
      const line = map.sourceLineOf(edit.startLine + offset);
      if (line !== start + offset || sourceLines[line] !== renderedLines[edit.startLine + offset]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      safe.push({ startLine: start, endLine: start + (edit.endLine - edit.startLine), newText: edit.newText });
    }
  }

  return safe;
}

/** Apply line edits to `source`. Edits must not overlap; later ones win ties. */
export function applyLineEdits(source: string, edits: LineEdit[]): string {
  const lines = source.split('\n');
  const ordered = [...edits].sort((a, b) => b.startLine - a.startLine);
  for (const edit of ordered) {
    const replacement = edit.newText.split('\n');
    if (replacement.length > 1 && replacement[replacement.length - 1] === '') {
      replacement.pop();
    }
    lines.splice(edit.startLine, edit.endLine - edit.startLine, ...replacement);
  }
  return lines.join('\n');
}
