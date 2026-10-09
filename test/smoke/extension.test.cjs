const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

suite('Explain Diff smoke', () => {
  test('lists the fixture session and opens the commit tab set with a cached explanation and chat', async () => {
    const ext = vscode.extensions.getExtension('local.explain-diff');
    assert.ok(ext, 'extension present');
    const api = await ext.activate();
    await api.refresh();

    const roots = api.tree.getChildren();
    const session = roots.find((n) => n.kind === 'session');
    assert.ok(session, 'session node present');
    assert.strictEqual(session.label, 'Fixture session');
    const commit = session.children[0];
    assert.match(commit.label, /Add greeting/);

    const explanation = JSON.parse(readFileSync(join(__dirname, '../fixtures/explanation.json'), 'utf8'));
    await api.store.put({ sha: commit.sha, promptVersion: 1, generatedAt: new Date().toISOString(), explainerSessionId: 'x', inferred: false, explanation, thread: [] });

    await vscode.commands.executeCommand('explainDiff.openCommit', commit);
    assert.strictEqual(api.controller.currentSha, commit.sha);

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => t.label === `Explain · ${commit.linked.commit.shortSha}`), 'explanation tab open');
    assert.ok(tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.label.startsWith('greet.js · A')), 'diff tab for greet.js open');
    assert.ok(api.chat.isOpen, 'chat panel open');
  });

  test('clicking the selected commit again (twice, quickly) keeps a single explanation tab', async () => {
    const api = vscode.extensions.getExtension('local.explain-diff').exports;
    const commit = api.tree.getChildren().find((n) => n.kind === 'session').children[0];
    await Promise.all([
      vscode.commands.executeCommand('explainDiff.openCommit', commit),
      vscode.commands.executeCommand('explainDiff.openCommit', commit),
    ]);
    const explainTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === `Explain · ${commit.linked.commit.shortSha}`);
    assert.strictEqual(explainTabs.length, 1);
  });
});
