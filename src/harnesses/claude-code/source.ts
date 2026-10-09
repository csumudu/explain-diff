import { join } from 'node:path';
import type { SessionSource, SourceOptions } from '../types';
import { findTranscriptFiles } from './locate';
import { parseTranscriptFile } from './transcript';

export const CLAUDE_TRAILER = /^Co-Authored-By:\s*Claude\b/im;

export function createClaudeCodeSource(o: SourceOptions): SessionSource {
  const projectsDir = o.env.EXPLAIN_DIFF_PROJECTS_DIR ?? join(o.homeDir, '.claude', 'projects');
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    findSessionFiles: (paths, platform) => findTranscriptFiles(projectsDir, paths, platform),
    parseSession: (file) => parseTranscriptFile(file),
    commitTrailer: CLAUDE_TRAILER,
  };
}
