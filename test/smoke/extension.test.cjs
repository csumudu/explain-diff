const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

// VS Code updates window.tabGroups asynchronously, so wait for the tab state rather than reading it once.
async function waitFor(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const allTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const diffTabs = () => allTabs().filter((t) => t.input instanceof vscode.TabInputTextDiff);

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

    await waitFor(() => allTabs().some((t) => t.label === `Explain · ${commit.linked.commit.shortSha}`), 'explanation tab');
    assert.strictEqual(diffTabs().length, 0, 'opening a commit opens no diff tabs');
    assert.ok(api.chat.isOpen, 'chat panel open');

    const files = await api.tree.getChildren(commit);
    assert.deepStrictEqual(files.map((f) => f.label).sort(), ['README.md', 'greet.js']);
    await vscode.commands.executeCommand('explainDiff.openFile', files.find((f) => f.label === 'greet.js'));
    await waitFor(() => diffTabs().length > 0, 'greet.js diff tab');
    assert.strictEqual(diffTabs().length, 1);
    assert.ok(diffTabs()[0].label.startsWith('greet.js · A'), 'diff tab for greet.js open');
    assert.ok(diffTabs()[0].isPreview, 'file diff opens as a preview tab');
    await vscode.commands.executeCommand('explainDiff.openFile', files.find((f) => f.label === 'README.md'));
    await waitFor(() => diffTabs().some((t) => t.label.startsWith('README.md')), 'README.md diff tab');
    assert.strictEqual(diffTabs().length, 1, 'next file replaces the preview tab');
  });

  test('clicking the selected commit again (twice, quickly) keeps a single explanation tab', async () => {
    const api = vscode.extensions.getExtension('local.explain-diff').exports;
    const commit = api.tree.getChildren().find((n) => n.kind === 'session').children[0];
    await Promise.all([
      vscode.commands.executeCommand('explainDiff.openCommit', commit),
      vscode.commands.executeCommand('explainDiff.openCommit', commit),
    ]);
    const explainTabs = () => allTabs().filter((t) => t.label === `Explain · ${commit.linked.commit.shortSha}`);
    await waitFor(() => explainTabs().length > 0, 'explanation tab');
    await new Promise((r) => setTimeout(r, 1000)); // give a duplicate time to appear, if one were opened
    assert.strictEqual(explainTabs().length, 1);
  });
});
