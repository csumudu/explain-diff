import { describe, it, expect } from 'vitest';
import { buildTree } from '../../src/core/treeModel';
import type { CommitInfo, LinkResult, Session } from '../../src/core/types';

const commit = (sha: string, subject: string, date: string): CommitInfo => ({ sha, shortSha: sha.slice(0, 7), subject, body: '', authorDate: date, agentCoAuthored: true });
const session = (id: string, title: string, start: string, edited: string[] = []): Session => ({ id, sourceId: 'claude-code', title, branch: 'feat/x', start, end: start, events: [], editedFiles: edited, filePath: `/${id}.jsonl` });

const link: LinkResult = {
  groups: [
    { session: session('s2', 'Dashboard filter', '2026-10-07T09:40:00Z', ['src/dash.ts']), commits: [{ commit: commit('2222222aaa', 'Add date filter', '2026-10-07T10:00:00Z'), eventIndex: 3, via: 'transcript' }] },
    { session: session('s1', 'Fix webhook', '2026-10-08T14:02:00Z'), commits: [
      { commit: commit('a1c9e42aaa', 'Make handler idempotent', '2026-10-08T14:35:00Z'), eventIndex: 5, via: 'transcript' },
      { commit: commit('7f03b11aaa', 'Retry with backoff', '2026-10-08T14:50:00Z'), eventIndex: 9, via: 'trailer' },
    ] },
  ],
  other: [{ commit: commit('cccccccaaa', 'Orphan', '2026-10-01T00:00:00Z'), eventIndex: null, via: 'none' }],
};

describe('buildTree', () => {
  it('lists sessions newest first, then other commits, with cached flags', () => {
    const t = buildTree(link, new Set(['a1c9e42aaa']));
    expect(t.map((n) => n.label)).toEqual(['Fix webhook', 'Dashboard filter', 'Other agent commits']);
    const s1 = t[0] as Extract<typeof t[number], { kind: 'session' }>;
    expect(s1.description).toContain('feat/x');
    expect(s1.description).toContain('2 commits');
    expect(s1.children.map((c) => [c.label, c.cached])).toEqual([['a1c9e42 Make handler idempotent', true], ['7f03b11 Retry with backoff', false]]);
    expect(s1.children[0].group?.session.id).toBe('s1');
    expect(t[2].children[0].group).toBeNull();
  });

  it('filters by message, sha, session title and session files', () => {
    expect(buildTree(link, new Set(), 'backoff').flatMap((n) => n.children.map((c) => c.sha))).toEqual(['7f03b11aaa']);
    expect(buildTree(link, new Set(), 'a1c9').flatMap((n) => n.children.map((c) => c.sha))).toEqual(['a1c9e42aaa']);
    expect(buildTree(link, new Set(), 'webhook').flatMap((n) => n.children)).toHaveLength(2);
    expect(buildTree(link, new Set(), 'dash.ts').map((n) => n.label)).toEqual(['Dashboard filter']);
  });

  it('omits the other group when empty', () => {
    expect(buildTree({ groups: [], other: [] }, new Set())).toEqual([]);
  });
});
describe('source names', () => {
  it('prefixes session descriptions with the source display name, falling back to the id', () => {
    const named = buildTree(link, new Set(), '', { 'claude-code': 'Claude Code' });
    expect(named[0].description.startsWith('Claude Code · feat/x · ')).toBe(true);
    expect(buildTree(link, new Set())[0].description.startsWith('claude-code · ')).toBe(true);
  });
  it('gives sessions with the same id from different files distinct tree ids', () => {
    const a = { ...session('dup', 'A', '2026-10-08T10:00:00Z'), filePath: '/a.jsonl' };
    const b = { ...session('dup', 'B', '2026-10-08T11:00:00Z'), filePath: '/b.jsonl' };
    const c = commit('ddddddd111', 'X', '2026-10-08T12:00:00Z');
    const t = buildTree({ groups: [{ session: a, commits: [{ commit: c, eventIndex: 0, via: 'transcript' }] }, { session: b, commits: [{ commit: { ...c, sha: 'eeeeeee111', shortSha: 'eeeeeee' }, eventIndex: 0, via: 'transcript' }] }], other: [] }, new Set());
    expect(new Set(t.map((n) => n.id)).size).toBe(2);
  });
});
