/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { TerroirRoot } from './types';

const cache = new Map<string, TerroirRoot | null>();

/**
 * terroir resolves its config and module-source root by walking up for `.git`.
 * It tests existence, not directory-ness, so this works inside a worktree where
 * `.git` is a file.
 */
export function findTerroirRoot(fromDir: string): TerroirRoot | undefined {
  const cached = cache.get(fromDir);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  let current = fromDir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      cache.set(fromDir, null);
      return undefined;
    }
    current = parent;
  }

  const terroirDir = path.join(current, '.terroir');
  if (!fs.existsSync(path.join(terroirDir, 'config.toml'))) {
    cache.set(fromDir, null);
    return undefined;
  }

  const settingsPath = path.join(terroirDir, 'settings.json');
  const root: TerroirRoot = {
    gitRoot: current,
    terroirDir,
    settingsPath: fs.existsSync(settingsPath) ? settingsPath : undefined,
  };
  cache.set(fromDir, root);
  return root;
}

export function clearRootCache(): void {
  cache.clear();
}
