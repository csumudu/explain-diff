import type { ChangedFile } from './types';

export interface DiffTabSpec {
  path: string;
  leftRef: string | null;
  leftPath: string;
  rightRef: string | null;
  rightPath: string;
  title: string;
}

export function diffTabFor(sha: string, shortSha: string, file: ChangedFile): DiffTabSpec {
  const name = file.path.split('/').pop() ?? file.path;
  return {
    path: file.path,
    leftRef: file.status === 'A' ? null : `${sha}^`,
    leftPath: file.oldPath ?? file.path,
    rightRef: file.status === 'D' ? null : sha,
    rightPath: file.path,
    title: `${name} · ${file.status} · ${shortSha}`,
  };
}

export function planDiffTabs(sha: string, shortSha: string, files: ChangedFile[], max: number) {
  const text = files.filter((f) => !f.binary);
  return {
    tabs: text.slice(0, Math.max(0, max)).map((f) => diffTabFor(sha, shortSha, f)),
    overflow: Math.max(0, text.length - Math.max(0, max)),
    binary: files.filter((f) => f.binary).map((f) => f.path),
  };
}
