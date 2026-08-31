/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

/** Where a .tf file sits in a terroir-managed tree. */
export interface TerroirRoot {
  /** Absolute path of the git root (worktree-safe: .git may be a file). */
  gitRoot: string;
  /** Absolute path of the `.terroir` directory under that root. */
  terroirDir: string;
  /** Absolute path of `.terroir/settings.json`, if it exists. */
  settingsPath?: string;
}

/** Environment to render for, and the variables terroir renders with. */
export interface TerroirEnv {
  /** CAPITALRX_ENVIRONMENT */
  name: string;
  /** CAPITALRX_ENVIRONMENT_PREFIX — empty for prod, else `${name}-`. */
  prefix: string;
}

/** One file's render result. */
export interface RenderedFile {
  /** Source after terroir's `source = "//x"` rewrite, before Jinja. Line-identical to the file on disk. */
  rewritten: string;
  /** Fully rendered HCL. */
  rendered: string;
}

export interface RenderError {
  type: string;
  message: string;
  /** 1-based template line, when the failure carries one. */
  lineno?: number;
}

export interface RenderDirResult {
  files: Record<string, RenderedFile>;
  errors: Record<string, RenderError>;
}

/** Feature-flag definition from `.terroir/settings.json`. */
export type FlagValue = string[] | boolean;
