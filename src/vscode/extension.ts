import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../core/sessionCollector';
import { createExplainer, createSources } from '../harnesses/registry';
import { linkCommits } from '../core/commitLinker';
import { ExplainService } from '../core/explainService';
import { ExplanationStore, repoStoreDir } from '../core/explanationStore';
import { GitService } from '../core/gitService';
import { QAService } from '../core/qaService';
import type { Session } from '../core/types';
import { CommitsTreeProvider } from './commitsTree';
import { CommitTabs, DIFF_SCHEME, GitContentProvider } from './commitTabs';
import { Controller } from './controller';
import { ExplainPanel } from './explainPanel';
import { ChatPanel } from './chatPanel';
import { FileChildren, type CommitNode, type FileNode } from '../core/treeModel';

export interface ExplainDiffApi {
  tree: CommitsTreeProvider;
  store: ExplanationStore;
  refresh(): Promise<void>;
  controller: Controller;
  chat: ChatPanel;
}

export const config = () => {
  const c = vscode.workspace.getConfiguration('explainDiff');
  return {
    claudePath: c.get<string>('claudePath', 'claude'),
    timeoutMs: c.get<number>('timeoutSeconds', 180) * 1000,
    model: c.get<string>('model', '') || undefined,
    briefTokenBudget: c.get<number>('briefTokenBudget', 30000),
    sessionSources: c.get<unknown>('sessionSources'),
    explainer: c.get<unknown>('explainer'),
  };
};

export async function activate(context: vscode.ExtensionContext): Promise<ExplainDiffApi> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = folder?.uri.fsPath ?? homedir();
  const git = new GitService(cwd);
  const repoRoot = (await git.repoRoot()) ?? cwd;
  const tree = new CommitsTreeProvider({ files: new FileChildren((sha) => git.changedFiles(sha)), fileUri: (p) => vscode.Uri.file(join(repoRoot, p)) });
  const view = vscode.window.createTreeView('explainDiff.commits', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);
  const store = new ExplanationStore(repoStoreDir(context.globalStorageUri.fsPath, repoRoot));
  const settings = (k: string) => vscode.workspace.getConfiguration('explainDiff').get(k);
  let explainer = createExplainer(config().explainer, { settings });
  let sources = createSources(config().sessionSources, { homeDir: homedir(), env: process.env });
  const runner = { run: (o: Parameters<typeof explainer.run>[0]) => explainer.run(o) };
  const explain = new ExplainService({ git, runner, store, cwd: repoRoot, timeoutMs: () => config().timeoutMs, model: () => config().model });
  const qa = new QAService({ runner, store, cwd: repoRoot, timeoutMs: () => config().timeoutMs, model: () => config().model });
  const tabs = new CommitTabs(repoRoot);
  let explainPanel: ExplainPanel | undefined;
  const chat = new ChatPanel({ extensionUri: context.extensionUri, qa, store, openRef: (p, l) => void controller.openRef(p, l) });
  const openChat = (prefill?: string) => chat.show(controller.current, { prefill, focus: true });
  const controller = new Controller(git, tabs, repoRoot, () => config(), {
    onOpen: async (ctx) => {
      explainPanel = new ExplainPanel(ctx, {
        extensionUri: context.extensionUri, explain, store, tabs,
        explainer: { get displayName() { return explainer.displayName; }, get setup() { return explainer.setup; } },
        openRef: (p, l) => void controller.openRef(p, l),
        onCached: (sha) => {
          tree.markCached(sha);
          void chat.refresh();
        },
        openChat: (prefill) => openChat(prefill),
      });
      const panel = explainPanel;
      panel.onDidDispose(() => {
        if (explainPanel === panel) explainPanel = undefined;
      });
      void panel.load();
    },
    isShowing: () => !!explainPanel,
    afterOpen: (ctx) => {
      explainPanel?.reveal();
      chat.show(ctx, { focus: false });
    },
    onClose: () => {
      explainPanel?.dispose();
      explainPanel = undefined;
    },
  });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitContentProvider()));
  const sessionCache = new Map<string, { mtimeMs: number; session: Session }>();
  let cliVersion: string | null | undefined;

  const refresh = async () => {
    if (!folder || !(await git.repoRoot())) {
      tree.update({ groups: [], other: [] }, new Set());
      view.message = 'Open a git repository to see agent commits.';
      return;
    }
    const sessions = await collectSessions(sources, [repoRoot, folder.uri.fsPath], sessionCache);
    const trailers = sources.map((s) => s.commitTrailer).filter((t): t is RegExp => !!t);
    const link = await linkCommits(sessions, git, trailers);
    tree.update(link, await store.listCachedShas(), Object.fromEntries(sources.map((s) => [s.id, s.displayName])));
    if (cliVersion === undefined) cliVersion = await explainer.version();
    const tool = cliVersion ? `${explainer.displayName} ${cliVersion}` : `${explainer.displayName} not found, explanations unavailable`;
    view.message = link.groups.length || link.other.length
      ? `${tool} · ${sessions.length} sessions scanned`
      : `No agent sessions found for this folder (sources: ${sources.map((s) => s.displayName).join(', ') || 'none enabled'}). ${tool}`;
  };

  let timer: NodeJS.Timeout | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 2000);
  };
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/{HEAD,refs/**}'));
    watcher.onDidChange(debounced);
    watcher.onDidCreate(debounced);
    watcher.onDidDelete(debounced);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('explainDiff.refresh', () => refresh()),
    vscode.commands.registerCommand('explainDiff.filter', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Filter by commit message, SHA, session title or edited file', value: tree.filterText });
      if (q !== undefined) tree.setFilter(q);
    }),
    vscode.commands.registerCommand('explainDiff.openCommit', async (node: CommitNode) => {
      await controller.openCommit(node);
      // Expand the clicked commit so its changed files are visible; best effort if the tree has been rebuilt meanwhile.
      if (view.visible) await Promise.resolve(view.reveal(node, { expand: true, select: true, focus: false })).catch(() => {});
    }),
    vscode.commands.registerCommand('explainDiff.openFile', async (node: FileNode) => {
      if (node.file.binary) {
        vscode.window.showInformationMessage(`${node.file.path} is a binary file, so there is no text diff to show.`);
        return;
      }
      await tabs.openFile(node.sha, node.shortSha, node.file);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['explainDiff.claudePath', 'explainDiff.explainer', 'explainDiff.sessionSources'].some((k) => e.affectsConfiguration(k))) {
        explainer = createExplainer(config().explainer, { settings });
        sources = createSources(config().sessionSources, { homeDir: homedir(), env: process.env });
        sessionCache.clear();
        cliVersion = undefined;
        void refresh();
      }
    }),
  );

  await refresh();
  return { tree, store, refresh, controller, chat };
}

export function deactivate() {}
