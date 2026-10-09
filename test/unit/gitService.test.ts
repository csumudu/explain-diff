import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../../src/core/gitService';
import { CLAUDE_TRAILER } from '../../src/harnesses/claude-code/source';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('GitService', () => {
  let repo: string;
  let first: string;
  let second: string;
  let git: GitService;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ed-git-'));
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'old.txt'), 'rename me\n'.repeat(20));
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'First commit');
    first = g(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    renameSync(join(repo, 'old.txt'), join(repo, 'new.txt'));
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'Second commit\n\nBody line.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    second = g(repo, 'rev-parse', 'HEAD');
    git = new GitService(repo);
  });

  it('finds the repo root and resolves short SHAs', async () => {
    const norm = (p: string) => realpathSync.native(p).toLowerCase().replace(/\\/g, '/');
    expect(norm((await git.repoRoot())!)).toBe(norm(repo)); // realpath expands Windows 8.3 temp names
    expect(await git.resolveCommit(second.slice(0, 7))).toBe(second);
    expect(await git.resolveCommit('deadbeef')).toBeNull();
  });

  it('reads commit info and the Claude trailer', async () => {
    const c = await git.getCommit(second, [CLAUDE_TRAILER]);
    expect(c).toMatchObject({ sha: second, subject: 'Second commit', agentCoAuthored: true });
    expect(c!.body).toContain('Body line.');
    expect(c!.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await git.getCommit(first, [CLAUDE_TRAILER]))!.agentCoAuthored).toBe(false);
    expect((await git.getCommit(second))!.agentCoAuthored).toBe(false);
  });

  it('lists only Claude co-authored commits', async () => {
    expect((await git.listAgentCommits([CLAUDE_TRAILER])).map((c) => c.sha)).toEqual([second]);
  });

  it('matches any of several agent trailers', async () => {
    expect(await git.listAgentCommits([/^Co-Authored-By:\s*Nobody\b/im])).toEqual([]);
    expect((await git.listAgentCommits([/^Co-Authored-By:\s*Nobody\b/im, CLAUDE_TRAILER])).map((c) => c.sha)).toEqual([second]);
    expect(await git.listAgentCommits([])).toEqual([]);
  });

  it('lists branches containing a commit', async () => {
    expect(await git.branchesContaining(second)).toEqual(['main']);
  });

  it('reports changed files with status, rename and binary info', async () => {
    const files = await git.changedFiles(second);
    const by = (p: string) => files.find((f) => f.path === p)!;
    expect(by('a.txt')).toMatchObject({ status: 'M', added: 1, removed: 0, binary: false });
    expect(by('img.bin')).toMatchObject({ status: 'A', binary: true, added: null });
    expect(by('new.txt')).toMatchObject({ status: 'R', oldPath: 'old.txt' });
  });

  it('handles the root commit', async () => {
    const files = await git.changedFiles(first);
    expect(files.map((f) => f.status).sort()).toEqual(['A', 'A']);
    expect(await git.fileAt(`${first}^`, 'a.txt')).toBe('');
  });

  it('reads stat, diff and file contents', async () => {
    expect(await git.showStat(second)).toContain('a.txt');
    expect(await git.diff(second)).toContain('+two');
    expect(await git.fileAt(second, 'a.txt')).toBe('one\ntwo\n');
    expect(await git.fileAt(second, 'nope.txt')).toBe('');
  });

  it('returns null root outside a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ed-plain-'));
    expect(await new GitService(plain).repoRoot()).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });
});
