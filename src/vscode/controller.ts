import * as vscode from 'vscode';
import { buildBrief } from '../core/briefBuilder';
import type { GitService } from '../core/gitService';
import type { CommitNode } from '../core/treeModel';
import type { ChangedFile, LinkedCommit, SessionGroup } from '../core/types';
import type { CommitTabs } from './commitTabs';

export interface CommitContext {
  linked: LinkedCommit;
  group: SessionGroup | null;
  brief: string | null;
  files: ChangedFile[];
  repoRoot: string;
}

export interface ControllerHooks {
  onOpen?: (ctx: CommitContext) => void | Promise<void>;
  afterOpen?: (ctx: CommitContext) => void | Promise<void>;
  /** True while the explanation tab for the current commit is still open. */
  isShowing?: () => boolean;
  onClose?: (sha: string) => void | Promise<void>;
}

export class Controller {
  currentSha?: string;
  current?: CommitContext;

  constructor(
    private readonly git: GitService,
    private readonly tabs: CommitTabs,
    private readonly repoRoot: string,
    private readonly settings: () => { briefTokenBudget: number },
    readonly hooks: ControllerHooks = {},
  ) {}

  private queue: Promise<void> = Promise.resolve();

  /** Clicks are handled one at a time, so quick repeated clicks cannot open two tab sets. */
  openCommit(node: CommitNode): Promise<void> {
    const run = this.queue.then(() => this.open(node));
    this.queue = run.catch(() => {});
    return run;
  }

  private async open(node: CommitNode): Promise<void> {
    const { linked, group } = node;
    const sha = linked.commit.sha;
    if (this.currentSha === sha && this.current) {
      // Same commit again: bring its explanation forward instead of opening a second one.
      if (!this.hooks.isShowing?.()) await this.hooks.onOpen?.(this.current);
      await this.hooks.afterOpen?.(this.current);
      return;
    }
    if (this.currentSha) await this.close(this.currentSha);

    const files = await this.git.changedFiles(sha);
    const brief = group
      ? buildBrief({
          session: group.session,
          eventIndex: linked.eventIndex,
          commitTime: linked.commit.authorDate,
          laterCommits: group.commits
            .filter((c) => Date.parse(c.commit.authorDate) > Date.parse(linked.commit.authorDate))
            .map((c) => ({ shortSha: c.commit.shortSha, subject: c.commit.subject })),
          budgetTokens: this.settings().briefTokenBudget,
        })
      : null;
    const ctx: CommitContext = { linked, group, brief, files, repoRoot: this.repoRoot };
    this.currentSha = sha;
    this.current = ctx;
    await this.hooks.onOpen?.(ctx);
    await this.hooks.afterOpen?.(ctx);
  }

  async close(sha: string): Promise<void> {
    await this.hooks.onClose?.(sha);
    await this.tabs.closeFor(sha);
    if (this.currentSha === sha) {
      this.currentSha = undefined;
      this.current = undefined;
    }
  }

  async openRef(path: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(`${this.repoRoot}/${path}`);
    try {
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preview: true });
    } catch {
      vscode.window.showWarningMessage(`${path} no longer exists in the working tree.`);
    }
  }
}
