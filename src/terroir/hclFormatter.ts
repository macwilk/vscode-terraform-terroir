/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { config } from '../utils/vscode';
import { Formatter } from './templateFormat';

let resolved: string | undefined;
let probed = false;

/**
 * Same trap as the Python interpreter: an editor started from a launcher rather than a shell does
 * not inherit a login PATH, so a Homebrew or asdf `terraform` is invisible to a bare name.
 */
function candidates(): string[] {
  const configured = config('terraform').get<string>('terroir.terraformPath', '').trim();
  if (configured) {
    return [configured];
  }
  return [
    'terraform',
    '/opt/homebrew/bin/terraform',
    '/usr/local/bin/terraform',
    '/usr/bin/terraform',
    `${process.env.HOME ?? ''}/.asdf/shims/terraform`,
  ];
}

/** `null` means the binary could not be launched; `undefined` means it ran and rejected the input. */
function run(binary: string, hcl: string): Promise<string | undefined | null> {
  return new Promise((resolve) => {
    const child = execFile(binary, ['fmt', '-'], { timeout: 10_000 }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve(null);
        return;
      }
      resolve(error ? undefined : stdout);
    });
    child.stdin?.end(hcl);
  });
}

/**
 * `terraform fmt -` over stdin, off the extension host thread. Formatting a template runs this
 * once per conditional branch, and on the largest templates here that totals tens of seconds --
 * long enough that doing it synchronously would freeze the editor on save.
 */
export const runTerraformFmt: Formatter = async (hcl) => {
  if (resolved) {
    const result = await run(resolved, hcl);
    return result ?? undefined;
  }
  if (probed) {
    return undefined;
  }

  for (const binary of candidates()) {
    if (binary.includes('/') && !fs.existsSync(binary)) {
      continue;
    }
    const result = await run(binary, hcl);
    if (result !== null) {
      resolved = binary;
      probed = true;
      return result;
    }
  }
  probed = true;
  return undefined;
};

/** False only once every candidate has failed to launch. */
export function terraformAvailable(): boolean {
  return !probed || resolved !== undefined;
}

export function resolvedTerraform(): string | undefined {
  return resolved;
}

export function resetFormatterProbe(): void {
  resolved = undefined;
  probed = false;
}
