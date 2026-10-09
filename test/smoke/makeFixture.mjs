import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve('.vscode-test');
const repo = join(root, 'fixture-repo');
const projects = join(root, 'projects');
rmSync(repo, { recursive: true, force: true });
rmSync(projects, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });

const g = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'greet.js'), 'module.exports = () => "hi";\n');
writeFileSync(join(repo, 'README.md'), '# Fixture\n');
g('add', '.');
g('commit', '-q', '-m', 'Add greeting\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
const short = g('rev-parse', '--short', 'HEAD');

const slug = repo.replace(/[^a-zA-Z0-9]/g, '-');
mkdirSync(join(projects, slug), { recursive: true });
const base = { sessionId: 'smoke', cwd: repo, gitBranch: 'main' };
const lines = [
  { type: 'ai-title', aiTitle: 'Fixture session', sessionId: 'smoke' },
  { ...base, type: 'user', timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: 'Add a greeting module' } },
  { ...base, type: 'assistant', timestamp: '2026-10-08T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git commit -m "Add greeting"' } }] } },
  { ...base, type: 'user', timestamp: '2026-10-08T10:01:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: `[main (root-commit) ${short}] Add greeting` }] } },
];
writeFileSync(join(projects, slug, 'smoke.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`fixture repo ${repo}, transcripts ${projects}`);
