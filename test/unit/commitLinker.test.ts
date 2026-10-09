import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile, parseTranscriptLines } from '../../src/harnesses/claude-code/transcript';
import { findCommitRefs, linkCommits, COMMIT_LINE, type GitLike } from '../../src/core/commitLinker';
import type { CommitInfo } from '../../src/core/types';

const commit = (sha: string, subject: string, authorDate: string, claude = true): CommitInfo => ({
  sha, shortSha: sha.slice(0, 7), subject, body: '', authorDate, agentCoAuthored: claude,
});

function fakeGit(commits: CommitInfo[], branches: Record<string, string[]> = {}): GitLike {
  return {
    resolveCommit: async (ref) => commits.find((c) => c.sha.startsWith(ref))?.sha ?? null,
    getCommit: async (sha) => commits.find((c) => c.sha === sha) ?? null,
    listAgentCommits: async () => commits.filter((c) => c.agentCoAuthored),
    branchesContaining: async (sha) => branches[sha] ?? [],
  };
}

describe('COMMIT_LINE', () => {
  it.each([
    ['[main a1c9e42] msg', 'a1c9e42'],
    ['[feat/x-y a1c9e42] msg', 'a1c9e42'],
    ['[detached HEAD a1c9e42] msg', 'a1c9e42'],
    ['[main (root-commit) a1c9e42] msg', 'a1c9e42'],
  ])('parses %s', (line, sha) => {
    expect([...line.matchAll(COMMIT_LINE)].map((m) => m[2])).toEqual([sha]);
  });
});

describe('findCommitRefs', () => {
  it('finds commits in git commit tool results, including several in one result', async () => {
    const s = await parseTranscriptLines(
      [
        JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'git add . && git commit -m a && git commit --allow-empty -m b' } }] } }),
        JSON.stringify({ type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '[main 1111111] a\n[main 2222222] b' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: { command: 'git log' } }] } }),
        JSON.stringify({ type: 'user', timestamp: 't4', message: { content: [{ type: 'tool_result', tool_use_id: 'y', content: '[main 3333333] not a commit call' }] } }),
      ],
      '/s.jsonl',
    );
    expect(findCommitRefs(s)).toEqual([
      { shortSha: '1111111', eventIndex: 1 },
      { shortSha: '2222222', eventIndex: 1 },
    ]);
  });
});

describe('linkCommits', () => {
  it('links via transcript, then via trailer + branch + time window, rest goes to other', async () => {
    const s1 = await parseTranscriptFile(join(__dirname, '../fixtures/sessions/basic.jsonl'));
    const direct = commit('a1c9e42ffffffffffffffffffffffffffffffff0', 'Make webhook handler idempotent', '2026-10-08T14:35:00Z');
    const viaTrailer = commit('bbbbbbbffffffffffffffffffffffffffffffff0', 'Late fix', '2026-10-08T14:40:00Z');
    const orphan = commit('cccccccffffffffffffffffffffffffffffffff0', 'Unrelated', '2026-10-01T09:00:00Z');
    const human = commit('dddddddffffffffffffffffffffffffffffffff0', 'Human commit', '2026-10-08T14:37:00Z', false);
    const git = fakeGit([direct, viaTrailer, orphan, human], { [viaTrailer.sha]: ['feat/webhook-retry'] });

    const r = await linkCommits([s1], git, [/x/]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].commits.map((c) => [c.commit.subject, c.via, c.eventIndex])).toEqual([
      ['Make webhook handler idempotent', 'transcript', 5],
      ['Late fix', 'trailer', 6],
    ]);
    expect(r.other.map((c) => c.commit.subject)).toEqual(['Unrelated']);
  });

  it('drops commits that no longer exist and sessions without commits', async () => {
    const s1 = await parseTranscriptFile(join(__dirname, '../fixtures/sessions/basic.jsonl'));
    const r = await linkCommits([s1], fakeGit([]), [/x/]);
    expect(r).toEqual({ groups: [], other: [] });
  });
});

describe('linkCommits with imperfect transcripts', () => {
  const sha = 'eeeeeeeffffffffffffffffffffffffffffffff0';
  const lines = (branch: string, resultText: string) => [
    JSON.stringify({ type: 'user', timestamp: '2026-10-09T03:00:00.000Z', gitBranch: branch, message: { content: 'Do the thing' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T03:10:00.000Z', gitBranch: branch, message: { content: [{ type: 'tool_use', id: 'q', name: 'Bash', input: { command: 'git add -A && git commit -q -m "Thing"' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-09T03:10:03.000Z', gitBranch: branch, message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: resultText }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T03:30:00.000Z', gitBranch: branch, message: { content: [{ type: 'text', text: 'Done.' }] } }),
  ];

  it('links a quiet `git commit -q` (no [branch sha] output) by its timing', async () => {
    const s = await parseTranscriptLines(lines('main', ''), '/q.jsonl');
    const c = commit(sha, 'Thing', '2026-10-09T08:40:02+05:30'); // 03:10:02Z
    const r = await linkCommits([s], fakeGit([c], { [sha]: ['other-branch'] }), [/x/]);
    expect(r.groups[0].commits.map((x) => [x.commit.subject, x.via, x.eventIndex])).toEqual([['Thing', 'transcript', 2]]);
  });

  it('treats a session branch of HEAD as unknown when matching by time window', async () => {
    const s = await parseTranscriptLines(lines('HEAD', 'some unrelated output'), '/h.jsonl');
    const c = commit(sha, 'Later thing', '2026-10-09T03:20:00Z');
    const r = await linkCommits([s], fakeGit([c], { [sha]: ['feat/x'] }), [/x/]);
    expect(r.groups[0].commits.map((x) => [x.commit.subject, x.via])).toEqual([['Later thing', 'trailer']]);
    expect(r.other).toEqual([]);
  });
});

describe('harness-neutral linking', () => {
  it('links commits from any tool that reports a shellCommand, whatever its name', async () => {
    const session = {
      id: 'x', sourceId: 'other-agent', title: 'T', start: '2026-10-09T03:00:00.000Z', end: '2026-10-09T03:05:00.000Z',
      editedFiles: [], filePath: '/x', events: [
        { kind: 'toolCall' as const, time: '2026-10-09T03:01:00.000Z', id: 'c', name: 'shell', input: {}, shellCommand: 'git commit -m x' },
        { kind: 'toolResult' as const, time: '2026-10-09T03:01:01.000Z', toolUseId: 'c', text: '[main 1234567] x' },
      ],
    };
    expect(findCommitRefs(session)).toEqual([{ shortSha: '1234567', eventIndex: 1 }]);
  });
});
