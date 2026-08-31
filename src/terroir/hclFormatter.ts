/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { spawnSync } from 'child_process';
import { config } from '../utils/vscode';
import { Formatter } from './templateFormat';

let available: boolean | undefined;

function terraformPath(): string {
  return config('terraform').get<string>('terroir.terraformPath', '').trim() || 'terraform';
}

/**
 * `terraform fmt -` over stdin. Synchronous because formatting a template runs it once per
 * conditional branch and the results feed each other; each call is a few milliseconds.
 */
export const runTerraformFmt: Formatter = (hcl) => {
  const result = spawnSync(terraformPath(), ['fmt', '-'], { input: hcl, encoding: 'utf8', timeout: 10_000 });
  if (result.error) {
    available = false;
    return undefined;
  }
  available = true;
  return result.status === 0 ? result.stdout : undefined;
};

/** False only once a call has actually failed to launch the binary. */
export function terraformAvailable(): boolean {
  return available !== false;
}

export function resetFormatterProbe(): void {
  available = undefined;
}
