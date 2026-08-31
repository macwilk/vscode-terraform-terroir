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

export function pythonPath(): string {
  return config('terraform').get<string>('terroir.pythonPath', '') || 'python3';
}

export function renderDebounceMs(): number {
  return config('terraform').get<number>('terroir.renderDebounceMs', 350);
}

export function environmentName(): string {
  return config('terraform').get<string>('terroir.environment', 'staging') || 'staging';
}

/** `source-env`: the prefix is empty for prod and `<env>-` everywhere else. */
export function currentEnvironment(): TerroirEnv {
  const name = environmentName();
  return { name, prefix: name === 'prod' ? '' : `${name}-` };
}
