/**
 * Copyright IBM Corp. 2016, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { defineConfig } from '@vscode/test-cli';
import fs from 'fs';
import os from 'os';
import path from 'path';

// macOS caps unix socket paths at 104 bytes. The default lives under
// .vscode-test/ in the checkout, and a GitHub Actions checkout repeats the
// repository name, so the default overflows and VS Code fails with EINVAL.
const userDataDir = path.join(os.tmpdir(), 'vsct');

// Discover test suite folders in src/test/integration
const BASE_SRC_PATH = './src/test/integration';
const BASE_OUT_PATH = './out/test/integration';

const testSuiteFolderNames = fs
  .readdirSync(BASE_SRC_PATH, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()) // only directories ...
  .filter((entry) => fs.existsSync(path.join(BASE_SRC_PATH, entry.name, 'workspace'))) // ... that contain a workspace folder are valid
  .map((entry) => entry.name);

const configs = testSuiteFolderNames.map((folderName) => ({
  label: `Integration Tests - ${folderName}`,
  version: process.env['VSCODE_VERSION'] ?? 'stable',
  workspaceFolder: process.env['VSCODE_WORKSPACE_FOLDER'] ?? path.join(BASE_SRC_PATH, folderName, 'workspace'),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userDataDir}`],
  files: `${BASE_OUT_PATH}/${folderName}/*.test.js`,
  mocha: {
    ui: 'tdd',
    color: true,
    timeout: 100000,
    require: ['./out/test/mockSetup.js'], // mocks are shared for all test suites
  },
}));

const config = defineConfig({
  tests: configs,
  coverage: {
    exclude: ['src/test/**', '**/node_modules/**', '**/dist/**'],
  },
});

export default config;
