import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ExplainerAbortedError, ExplainerNotFoundError, ExplainerRunError, ExplainerTimeoutError } from '../harnesses/errors';
import { DIAGRAM_KEYS, getDiagram, type DiagramKey } from '../core/explanationSchema';
import type { ExplanationStore } from '../core/explanationStore';
import { ExplanationInvalidError, type ExplainService } from '../core/explainService';
import { toMarkdown } from '../core/markdownExport';
import type { StoredExplanation } from '../core/types';
import type { Explainer } from '../harnesses/types';
import type { ExplainToHost, HostToWebview } from '../shared/messages';
import { renderExplainView, type ExplainView, type HeaderInfo } from '../webview/render';
import type { CommitTabs } from './commitTabs';
import type { CommitContext } from './controller';

export interface ExplainPanelDeps {
  explainer: Pick<Explainer, 'displayName' | 'setup'>;
  extensionUri: vscode.Uri;
  explain: ExplainService;
  store: ExplanationStore;
  tabs: CommitTabs;
  openRef: (path: string, line?: number) => void;
  onCached: (sha: string) => void;
  openChat: (prefill?: string) => void;
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: 'explain.js' | 'chat.js', body: string): string {
  const nonce = randomBytes(16).toString('hex');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', script));
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${css}"></head><body${script === 'chat.js' ? ' class="chat"' : ''}>${body}<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

export class ExplainPanel {
  static readonly viewType = 'explainDiff.explanation';
  readonly sha: string;
  private readonly panel: vscode.WebviewPanel;
  private view: ExplainView;
  private abort?: AbortController;
  private disposed = false;
  private attempted = new Set<string>();
  private failed: Record<string, string> = {};
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(private readonly ctx: CommitContext, private readonly deps: ExplainPanelDeps) {
    this.sha = ctx.linked.commit.sha;
    this.panel = vscode.window.createWebviewPanel(
      ExplainPanel.viewType,
      `Explain · ${ctx.linked.commit.shortSha}`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist'), vscode.Uri.joinPath(deps.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, deps.extensionUri, 'explain.js', '<div id="root"></div>');
    this.view = { kind: 'loading', header: this.header(), steps: [], log: [] };
    this.panel.webview.onDidReceiveMessage((m: ExplainToHost) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      // Spec §10: a run keeps going after the tab closes; the result is still cached and the tree dot fills in.
      this.disposed = true;
      this.disposeEmitter.fire();
    });
  }

  private header(stored?: StoredExplanation): HeaderInfo {
    const c = this.ctx.linked.commit;
    const files = this.ctx.files;
    return {
      shortSha: c.shortSha,
      subject: c.subject,
      branch: this.ctx.group?.session.branch,
      date: c.authorDate,
      added: files.reduce((n, f) => n + (f.added ?? 0), 0),
      removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
      fileCount: files.length,
      sessionTitle: this.ctx.group?.session.title,
      generatedAt: stored?.generatedAt,
      hasTranscript: !!this.ctx.group,
      explainerName: this.deps.explainer.displayName,
    };
  }

  private render() {
    if (this.disposed) return;
    const msg: HostToWebview = { type: 'render', html: renderExplainView(this.view) };
    void this.panel.webview.postMessage(msg);
  }

  private showReady(stored: StoredExplanation) {
    this.view = { kind: 'ready', header: this.header(stored), stored, files: this.ctx.files, failedDiagrams: this.failed };
    this.render();
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.One, false);
  }

  dispose() {
    this.panel.dispose();
  }

  async load(force = false): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.attempted.clear();
    this.failed = {};
    const cached = force ? undefined : await this.deps.store.get(this.sha);
    if (cached) return this.showReady(cached);

    const steps: { label: string; state: 'done' | 'active' | 'todo' }[] = [
      { label: this.ctx.group ? 'Read the session' : 'No session found, using the commit only', state: 'done' },
      { label: `${this.deps.explainer.displayName} is exploring the code`, state: 'active' },
      { label: 'Writing the explanation', state: 'todo' },
    ];
    const log: string[] = [];
    this.view = { kind: 'loading', header: this.header(), steps, log };
    this.render();
    try {
      const stored = await this.deps.explain.explain(
        { sha: this.sha, brief: this.ctx.brief },
        {
          force,
          signal: abort.signal,
          onProgress: (p) => {
            if (p.type === 'tool') log.push(`${p.name.padEnd(5)} ${p.detail}`);
            else {
              steps[1].state = 'done';
              steps[2].state = 'active';
            }
            this.render();
          },
        },
      );
      this.deps.onCached(this.sha);
      this.showReady(stored);
    } catch (e) {
      if (e instanceof ExplainerAbortedError) return;
      const header = this.header();
      if (e instanceof ExplainerNotFoundError) this.view = { kind: 'error', header, variant: 'cliMissing', message: e.message, setup: this.deps.explainer.setup };
      else if (e instanceof ExplainerTimeoutError) this.view = { kind: 'error', header, variant: 'failed', message: `${e.message}.` };
      else if (e instanceof ExplainerRunError) this.view = { kind: 'error', header, variant: 'failed', message: e.message, details: `exit code ${e.exitCode}\n${e.stderrTail}` };
      else if (e instanceof ExplanationInvalidError) this.view = { kind: 'error', header, variant: 'failed', message: e.message, details: e.raw.slice(0, 4000) };
      else this.view = { kind: 'error', header, variant: 'failed', message: e instanceof Error ? e.message : String(e) };
      this.render();
    }
  }

  private async onMessage(m: ExplainToHost) {
    const c = this.ctx.linked.commit;
    switch (m.type) {
      case 'ready':
        return this.render();
      case 'openRef':
        return this.deps.openRef(m.path, m.line);
      case 'focusFile': {
        const file = this.ctx.files.find((f) => f.path === m.path);
        if (file && !file.binary) await this.deps.tabs.openFile(this.sha, c.shortSha, file);
        return;
      }
      case 'openAllChanges':
        return this.deps.tabs.openAll(this.sha, c.shortSha, this.ctx.files);
      case 'openChat':
        return this.deps.openChat();
      case 'askSection':
        return this.deps.openChat(`About "${m.section}": `);
      case 'regenerate':
        return this.load(true);
      case 'retry':
        return this.load(false);
      case 'cancel':
        this.abort?.abort();
        this.view = { kind: 'error', header: this.header(), variant: 'failed', message: 'Cancelled.' };
        return this.render();
      case 'openSettings':
        return void vscode.commands.executeCommand('workbench.action.openSettings', this.deps.explainer.setup.settingId);
      case 'openTranscript':
        if (this.ctx.group) await vscode.window.showTextDocument(vscode.Uri.file(this.ctx.group.session.filePath), { viewColumn: vscode.ViewColumn.One, preview: true });
        return;
      case 'export':
        return this.exportMarkdown();
      case 'diagramError':
        return this.onDiagramError(m.key, m.code, m.error);
      case 'retryDiagram':
        delete this.failed[m.key];
        this.attempted.delete(m.key);
        return this.repair(m.key as DiagramKey, (await this.currentDiagram(m.key as DiagramKey)) ?? '', 'Retry requested');
    }
  }

  private async currentDiagram(key: DiagramKey) {
    const s = await this.deps.store.get(this.sha);
    return s ? getDiagram(s.explanation, key) : undefined;
  }

  private async onDiagramError(key: string, code: string, error: string) {
    if (!DIAGRAM_KEYS.includes(key as DiagramKey)) return; // chat-style diagrams are not repairable here
    if (this.attempted.has(key)) {
      this.failed[key] = error;
      const s = await this.deps.store.get(this.sha);
      if (s) this.showReady(s);
      return;
    }
    await this.repair(key as DiagramKey, code, error);
  }

  private async repair(key: DiagramKey, code: string, error: string) {
    this.attempted.add(key);
    try {
      await this.deps.explain.repairDiagram(this.sha, key, code, error);
      delete this.failed[key];
    } catch (e) {
      this.failed[key] = e instanceof Error ? e.message : String(e);
    }
    const s = await this.deps.store.get(this.sha);
    if (s) this.showReady(s);
  }

  private async exportMarkdown() {
    const s = await this.deps.store.get(this.sha);
    if (!s) return;
    const c = this.ctx.linked.commit;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${this.ctx.repoRoot}/${c.shortSha}-explanation.md`),
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    await writeFile(target.fsPath, toMarkdown(s, { shortSha: c.shortSha, subject: c.subject, branch: this.ctx.group?.session.branch, date: c.authorDate, sessionTitle: this.ctx.group?.session.title }), 'utf8');
    vscode.window.showInformationMessage(`Saved ${target.fsPath}`);
  }
}
