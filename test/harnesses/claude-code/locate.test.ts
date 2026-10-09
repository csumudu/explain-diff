import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, findTranscriptFiles } from '../../../src/harnesses/claude-code/locate';

describe('projectSlug', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(projectSlug('C:\\Users\\me\\projects\\explain-diff')).toBe('C--Users-me-projects-explain-diff');
    expect(projectSlug('/home/me/my_app')).toBe('-home-me-my-app');
  });
});

describe('findTranscriptFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ed-proj-'));
    const mk = (d: string, files: string[]) => {
      mkdirSync(join(dir, d), { recursive: true });
      for (const f of files) writeFileSync(join(dir, d, f), '');
    };
    mk('C--work-app', ['a.jsonl', 'notes.txt']);
    mk('C--work-app--claude-worktrees-feature-x', ['b.jsonl']);
    mk('C--work-app-other', ['c.jsonl']);
  });

  it('finds the project dir and its worktree dirs only', async () => {
    const files = await findTranscriptFiles(dir, ['C:\\work\\app'], 'linux');
    expect(files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual([
      'C--work-app--claude-worktrees-feature-x/b.jsonl',
      'C--work-app/a.jsonl',
    ]);
  });

  it('matches drive-letter case-insensitively on Windows', async () => {
    expect(await findTranscriptFiles(dir, ['c:\\work\\app'], 'win32')).toHaveLength(2);
    expect(await findTranscriptFiles(dir, ['c:\\work\\app'], 'linux')).toHaveLength(0);
  });

  it('de-duplicates when several workspace paths map to the same dir', async () => {
    expect(await findTranscriptFiles(dir, ['C:\\work\\app', 'c:\\work\\app'], 'win32')).toHaveLength(2);
  });

  it('returns [] when the projects dir does not exist', async () => {
    expect(await findTranscriptFiles(join(dir, 'missing'), ['C:\\work\\app'])).toEqual([]);
  });
});
