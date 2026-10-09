import type { GitService } from './gitService';
import type { LinkResult, LinkedCommit, Session, SessionGroup } from './types';

export type GitLike = Pick<GitService, 'resolveCommit' | 'getCommit' | 'listAgentCommits' | 'branchesContaining'>;

export const COMMIT_LINE = /^\[(.+?) (?:\(root-commit\) )?([0-9a-f]{7,40})\]/gm;
const GIT_COMMIT_CMD = /\bgit\b[^\n]*\bcommit\b/;
const WINDOW_SLACK_MS = 10 * 60 * 1000;
const QUIET_COMMIT_SLACK_MS = 2 * 60 * 1000;

/** Results of `git commit` calls that printed no `[branch sha]` line (e.g. `git commit -q`). */
export function findQuietCommits(session: Session): { eventIndex: number; time: string }[] {
  const commitCalls = new Set<string>();
  const quiet: { eventIndex: number; time: string }[] = [];
  session.events.forEach((e, i) => {
    if (e.kind === 'toolCall' && !!e.shellCommand && GIT_COMMIT_CMD.test(e.shellCommand)) {
      commitCalls.add(e.id);
    }
    if (e.kind === 'toolResult' && commitCalls.has(e.toolUseId) && e.time && ![...e.text.matchAll(COMMIT_LINE)].length) {
      quiet.push({ eventIndex: i, time: e.time });
    }
  });
  return quiet;
}

/** Harnesses record "HEAD" (or nothing) when the branch is unknown, e.g. in a repo with no commits yet. */
const knownBranch = (b?: string) => (b && b !== 'HEAD' ? b : undefined);

export function findCommitRefs(session: Session): { shortSha: string; eventIndex: number }[] {
  const commitCalls = new Set<string>();
  const refs: { shortSha: string; eventIndex: number }[] = [];
  session.events.forEach((e, i) => {
    if (e.kind === 'toolCall' && !!e.shellCommand && GIT_COMMIT_CMD.test(e.shellCommand)) {
      commitCalls.add(e.id);
    }
    if (e.kind === 'toolResult' && commitCalls.has(e.toolUseId)) {
      for (const m of e.text.matchAll(COMMIT_LINE)) refs.push({ shortSha: m[2], eventIndex: i });
    }
  });
  return refs;
}

export function eventIndexAt(session: Session, isoTime: string): number | null {
  const t = Date.parse(isoTime);
  let idx: number | null = null;
  session.events.forEach((e, i) => {
    if (e.time && Date.parse(e.time) <= t) idx = i;
  });
  return idx;
}

export async function linkCommits(sessions: Session[], git: GitLike, trailers: RegExp[]): Promise<LinkResult> {
  const assigned = new Map<string, { session: Session; linked: LinkedCommit }>();

  for (const session of sessions) {
    for (const ref of findCommitRefs(session)) {
      const sha = await git.resolveCommit(ref.shortSha);
      if (!sha || assigned.has(sha)) continue;
      const commit = await git.getCommit(sha);
      if (!commit) continue;
      assigned.set(sha, { session, linked: { commit, eventIndex: ref.eventIndex, via: 'transcript' } });
    }
  }

  const quiet = sessions.flatMap((session) => findQuietCommits(session).map((q) => ({ session, ...q })));
  const other: LinkedCommit[] = [];
  for (const commit of await git.listAgentCommits(trailers)) {
    if (assigned.has(commit.sha)) continue;
    const t = Date.parse(commit.authorDate);
    const byTiming = quiet
      .filter((q) => Math.abs(Date.parse(q.time) - t) <= QUIET_COMMIT_SLACK_MS)
      .sort((a, b) => Math.abs(Date.parse(a.time) - t) - Math.abs(Date.parse(b.time) - t))[0];
    if (byTiming) {
      assigned.set(commit.sha, { session: byTiming.session, linked: { commit, eventIndex: byTiming.eventIndex, via: 'transcript' } });
      continue;
    }
    const inWindow = sessions.filter(
      (s) => s.start && s.end && t >= Date.parse(s.start) && t <= Date.parse(s.end) + WINDOW_SLACK_MS,
    );
    let chosen: Session | undefined;
    if (inWindow.length) {
      const branches = await git.branchesContaining(commit.sha);
      chosen = inWindow
        .filter((s) => !knownBranch(s.branch) || branches.includes(s.branch!))
        .sort((a, b) => Math.abs(Date.parse(a.end) - t) - Math.abs(Date.parse(b.end) - t))[0];
    }
    if (chosen) {
      assigned.set(commit.sha, { session: chosen, linked: { commit, eventIndex: eventIndexAt(chosen, commit.authorDate), via: 'trailer' } });
    } else {
      other.push({ commit, eventIndex: null, via: 'none' });
    }
  }

  const bySession = new Map<Session, SessionGroup>();
  for (const { session, linked } of assigned.values()) {
    if (!bySession.has(session)) bySession.set(session, { session, commits: [] });
    bySession.get(session)!.commits.push(linked);
  }
  const groups = [...bySession.values()].sort((a, b) => b.session.start.localeCompare(a.session.start));
  for (const g of groups) g.commits.sort((a, b) => Date.parse(a.commit.authorDate) - Date.parse(b.commit.authorDate));
  other.sort((a, b) => Date.parse(b.commit.authorDate) - Date.parse(a.commit.authorDate));
  return { groups, other };
}
