import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { diffTabFor, type DiffTabSpec } from '../core/tabPlan';
import type { ChangedFile } from '../core/types';

export const DIFF_SCHEME = 'explain-diff';

function gitUri(repoRoot: string, commit: string, ref: string | null, path: string): vscode.Uri {
  const query = new URLSearchParams({ repo: repoRoot, commit, ref: ref ?? '' }).toString();
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${path}`, query });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const ref = q.get('ref');
    const repo = q.get('repo');
    if (!ref || !repo) return '';
    return new GitService(repo).fileAt(ref, uri.path.replace(/^\//, ''));
  }
}

export class CommitTabs {
  constructor(private readonly repoRoot: string) {}

  private async openSpec(sha: string, spec: DiffTabSpec) {
    const left = gitUri(this.repoRoot, sha, spec.leftRef, spec.leftPath);
    const right = gitUri(this.repoRoot, sha, spec.rightRef, spec.rightPath);
    await vscode.commands.executeCommand('vscode.diff', left, right, spec.title, {
      preview: true,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  /** Opens one file's diff as a preview tab: the next file opened replaces it unless the user pinned it. */
  async openFile(sha: string, shortSha: string, file: ChangedFile): Promise<void> {
    await this.openSpec(sha, diffTabFor(sha, shortSha, file));
  }

  async closeFor(sha: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => {
        const input = t.input;
        if (!(input instanceof vscode.TabInputTextDiff)) return false;
        return input.modified.scheme === DIFF_SCHEME && new URLSearchParams(input.modified.query).get('commit') === sha;
      });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  async openAll(sha: string, shortSha: string, files: ChangedFile[]): Promise<void> {
    const resources = files
      .filter((f) => !f.binary)
      .map((f) => {
        const spec = diffTabFor(sha, shortSha, f);
        return [
          vscode.Uri.file(`${this.repoRoot}/${f.path}`),
          gitUri(this.repoRoot, sha, spec.leftRef, spec.leftPath),
          gitUri(this.repoRoot, sha, spec.rightRef, spec.rightPath),
        ];
      });
    await vscode.commands.executeCommand('vscode.changes', `Changes in ${shortSha}`, resources);
  }
}
