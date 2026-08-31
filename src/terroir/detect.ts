/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Jinja2 opens every construct with `{{`, `{%` or `{#`. terroir renders .tf
 * files with the stock delimiters, so this is the whole surface.
 */
const JINJA = /\{[{%#]/;

export function hasJinja(text: string): boolean {
  return JINJA.test(text);
}
