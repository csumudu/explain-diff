import { defineConfig } from '@vscode/test-cli';
import { resolve } from 'node:path';

export default defineConfig({
  files: 'test/smoke/**/*.test.cjs',
  workspaceFolder: resolve('.vscode-test/fixture-repo'),
  env: { EXPLAIN_DIFF_PROJECTS_DIR: resolve('.vscode-test/projects') },
  mocha: { ui: 'tdd', timeout: 60000 },
});
