import * as vscode from 'vscode';
import { buildTree, type CommitNode, type RootNode } from '../core/treeModel';
import type { LinkResult } from '../core/types';

type Node = RootNode | CommitNode;

export class CommitsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private link: LinkResult = { groups: [], other: [] };
  private cached = new Set<string>();
  private filter = '';
  private sourceNames: Record<string, string> = {};
  private roots: RootNode[] = [];

  update(link: LinkResult, cached: Set<string>, sourceNames: Record<string, string> = this.sourceNames) {
    this.sourceNames = sourceNames;
    this.link = link;
    this.cached = cached;
    this.rebuild();
  }

  setFilter(q: string) {
    this.filter = q;
    this.rebuild();
  }

  get filterText() {
    return this.filter;
  }

  markCached(sha: string) {
    this.cached.add(sha);
    this.rebuild();
  }

  private rebuild() {
    this.roots = buildTree(this.link, this.cached, this.filter, this.sourceNames);
    this.emitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) return this.roots;
    return element.kind === 'commit' ? [] : element.children;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'commit') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
      item.id = n.id;
      item.description = n.description;
      item.tooltip = n.tooltip;
      item.iconPath = new vscode.ThemeIcon(n.cached ? 'circle-filled' : 'circle-outline', n.cached ? new vscode.ThemeColor('charts.green') : undefined);
      item.command = { command: 'explainDiff.openCommit', title: 'Explain Commit', arguments: [n] };
      item.contextValue = 'commit';
      return item;
    }
    const item = new vscode.TreeItem(n.label, n === this.roots[0] ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = n.id;
    item.description = n.description;
    if (n.kind === 'session') item.tooltip = n.tooltip;
    item.iconPath = new vscode.ThemeIcon(n.kind === 'session' ? 'comment-discussion' : 'question');
    return item;
  }
}
