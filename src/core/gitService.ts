import { execFile } from 'node:child_process';
import type { ChangedFile, ChangeStatus, CommitInfo } from './types';

const FMT = '%H%x1f%h%x1f%s%x1f%aI%x1f%b%x1e';

export class GitService {
  constructor(private readonly cwd: string, private readonly gitPath = 'git') {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }

  async repoRoot(): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--show-toplevel'])).trim() || null;
    } catch {
      return null;
    }
  }

  async resolveCommit(ref: string): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  async getCommit(sha: string, trailers: RegExp[] = []): Promise<CommitInfo | null> {
    try {
      return parseLog(await this.run(['log', '-1', `--format=${FMT}`, sha]), trailers)[0] ?? null;
    } catch {
      return null;
    }
  }

  async listAgentCommits(trailers: RegExp[]): Promise<CommitInfo[]> {
    if (!trailers.length) return [];
    try {
      return parseLog(await this.run(['log', '--all', `--format=${FMT}`]), trailers).filter((c) => c.agentCoAuthored);
    } catch {
      return [];
    }
  }

  async branchesContaining(sha: string): Promise<string[]> {
    try {
      const out = await this.run(['branch', '--format=%(refname:short)', '--contains', sha]);
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  showStat(sha: string): Promise<string> {
    return this.run(['show', '--stat', '--format=fuller', '--no-color', sha]);
  }

  diff(sha: string): Promise<string> {
    return this.run(['show', '--format=', '--patch', '--no-color', '-M', sha]);
  }

  async changedFiles(sha: string): Promise<ChangedFile[]> {
    const [nameStatus, numstat] = await Promise.all([
      this.run(['show', '--format=', '--name-status', '-z', '-M', sha]),
      this.run(['show', '--format=', '--numstat', '-z', '-M', sha]),
    ]);
    const counts = parseNumstatZ(numstat);
    return parseNameStatusZ(nameStatus).map((f) => {
      const c = counts.get(f.path);
      const binary = c ? c.added === null : false;
      return { ...f, added: c?.added ?? (binary ? null : 0), removed: c?.removed ?? (binary ? null : 0), binary };
    });
  }

  async fileAt(ref: string, path: string): Promise<string> {
    try {
      return await this.run(['show', `${ref}:${path}`]);
    } catch {
      return '';
    }
  }
}

export function parseLog(out: string, trailers: RegExp[] = []): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, shortSha, subject, authorDate, body = ''] = r.split('\x1f');
      return { sha, shortSha, subject, authorDate, body: body.trim(), agentCoAuthored: trailers.some((t) => t.test(body)) };
    });
}

function parseNameStatusZ(out: string): Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] {
  const parts = out.split('\0').filter((p) => p !== '');
  const files: Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: parts[i++] });
    }
  }
  return files;
}

function parseNumstatZ(out: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].replace(/^\n/, '');
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let path = m[3];
    if (path === '') {
      i += 2; // rename: old path, new path follow
      path = parts[i];
    }
    map.set(path, { added, removed });
  }
  return map;
}
