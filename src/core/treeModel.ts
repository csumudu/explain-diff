import type { LinkResult, LinkedCommit, SessionGroup } from './types';

export type CommitNode = {
  kind: 'commit'; id: string; label: string; description: string; tooltip: string;
  sha: string; linked: LinkedCommit; group: SessionGroup | null; cached: boolean;
};
export type SessionNode = { kind: 'session'; id: string; label: string; description: string; tooltip: string; group: SessionGroup; children: CommitNode[] };
export type OtherNode = { kind: 'other'; id: 'other'; label: string; description: string; children: CommitNode[] };
export type RootNode = SessionNode | OtherNode;

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const plural = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function commitNode(l: LinkedCommit, group: SessionGroup | null, cached: Set<string>): CommitNode {
  const c = l.commit;
  return {
    kind: 'commit',
    id: `commit:${c.sha}`,
    label: `${c.shortSha} ${c.subject}`,
    description: cached.has(c.sha) ? 'explained' : '',
    tooltip: `${c.subject}\n${c.shortSha} · ${fmt(c.authorDate)}${l.via === 'trailer' ? '\nLinked by co-author line and time' : ''}`,
    sha: c.sha,
    linked: l,
    group,
    cached: cached.has(c.sha),
  };
}

export function buildTree(link: LinkResult, cached: Set<string>, filter = '', sourceNames: Record<string, string> = {}): RootNode[] {
  const q = filter.trim().toLowerCase();
  const commitMatches = (l: LinkedCommit) =>
    !q || l.commit.subject.toLowerCase().includes(q) || l.commit.body.toLowerCase().includes(q) || l.commit.sha.startsWith(q);

  const roots: RootNode[] = [];
  const groups = [...link.groups].sort((a, b) => b.session.start.localeCompare(a.session.start));
  for (const g of groups) {
    const s = g.session;
    const sessionMatches = !!q && (s.title.toLowerCase().includes(q) || s.editedFiles.some((f) => f.toLowerCase().includes(q)));
    const commits = g.commits.filter((l) => sessionMatches || commitMatches(l));
    if (!commits.length) continue;
    roots.push({
      kind: 'session',
      id: `session:${s.sourceId}:${s.filePath}`,
      label: s.title,
      description: `${sourceNames[s.sourceId] ?? s.sourceId} · ${s.branch ?? 'no branch'} · ${fmt(s.start)} · ${plural(g.commits.length)}`,
      tooltip: `${s.title}\n${s.filePath}`,
      group: g,
      children: commits.map((l) => commitNode(l, g, cached)),
    });
  }
  const others = link.other.filter(commitMatches);
  if (others.length) {
    roots.push({ kind: 'other', id: 'other', label: 'Other agent commits', description: `no session transcript found · ${plural(others.length)}`, children: others.map((l) => commitNode(l, null, cached)) });
  }
  return roots;
}
