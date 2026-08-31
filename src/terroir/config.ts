/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { config } from '../utils/vscode';
import { TerroirEnv } from './types';

export function isEnabled(): boolean {
  return config('terraform').get<boolean>('terroir.enable', true);
}

export function isFormatGuardEnabled(): boolean {
  return config('terraform').get<boolean>('terroir.formatGuard.enable', true);
}

export function isRenderEnabled(): boolean {
  return config('terraform').get<boolean>('terroir.render.enable', true);
}

/** Empty means "discover one"; see resolveInterpreter. */
export function configuredPythonPath(): string {
  return config('terraform').get<string>('terroir.pythonPath', '').trim();
}

export function renderDebounceMs(): number {
  return config('terraform').get<number>('terroir.renderDebounceMs', 350);
}

/**
 * Stacks in one repository do not share an environment vocabulary, so a single
 * setting is wrong somewhere. The longest configured path fragment contained in
 * `fsPath` wins; without a match the workspace-wide setting applies.
 */
export function environmentName(fsPath?: string): string {
  const fallback = config('terraform').get<string>('terroir.environment', 'staging') || 'staging';
  if (!fsPath) {
    return fallback;
  }

  const byPath = config('terraform').get<Record<string, string>>('terroir.environmentByPath', {});
  let matched: string | undefined;
  let matchedLength = 0;
  for (const [fragment, env] of Object.entries(byPath)) {
    if (fragment.length > matchedLength && fsPath.includes(fragment)) {
      matched = env;
      matchedLength = fragment.length;
    }
  }
  return matched ?? fallback;
}

/** `source-env`: the prefix is empty for prod and `<env>-` everywhere else. */
export function currentEnvironment(fsPath?: string): TerroirEnv {
  const name = environmentName(fsPath);
  return { name, prefix: name === 'prod' ? '' : `${name}-` };
}

export function indentJinjaBlocks(): boolean {
  return config('terraform').get<boolean>('terroir.format.indentBlocks', true);
}
