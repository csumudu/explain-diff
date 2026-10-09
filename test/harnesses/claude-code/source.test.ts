import { join } from 'node:path';
import { createClaudeCodeSource } from '../../../src/harnesses/claude-code/source';
import { describeSessionSource } from '../contract/sessionSource.contract';

const FIXTURES = join(__dirname, '../../fixtures/harnesses/claude-code');

describeSessionSource(
  'claude-code',
  (dir) => createClaudeCodeSource({ homeDir: '/unused', env: { EXPLAIN_DIFF_PROJECTS_DIR: join(dir, 'projects') } }),
  FIXTURES,
);
