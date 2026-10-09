import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner, buildArgs, buildSpawn, ALLOWED_TOOLS, createClaudeCodeExplainer } from '../../../src/harnesses/claude-code/explainer';
import { ExplainerNotFoundError, ExplainerRunError, ExplainerTimeoutError, ExplainerAbortedError } from '../../../src/harnesses/errors';
import type { RunProgress } from '../../../src/harnesses/types';

const FAKE = join(__dirname, '../../fake-claude/fake-claude.mjs');

describe('buildArgs / buildSpawn', () => {
  it('builds read-only stream-json args with optional resume and model', () => {
    const a = buildArgs({ resumeSessionId: 'abc', model: 'opus' });
    expect(a.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(a).toContain(ALLOWED_TOOLS);
    expect(a.join(' ')).toContain('--disallowedTools Edit,Write,NotebookEdit');
    expect(a.join(' ')).toContain('--max-turns 40');
    expect(a).toContain('--strict-mcp-config');
    expect(a.slice(-4)).toEqual(['--model', 'opus', '--resume', 'abc']);
  });
  it('uses the shell with quoted args on Windows only', () => {
    expect(buildSpawn('claude', ['-p', 'Bash(git show:*)'], 'linux')).toEqual({ file: 'claude', args: ['-p', 'Bash(git show:*)'], shell: false });
    expect(buildSpawn('C:\\Program Files\\claude.cmd', ['-p', 'Bash(git show:*)'], 'win32')).toEqual({
      file: '"C:\\Program Files\\claude.cmd" "-p" "Bash(git show:*)"', args: [], shell: true,
    });
  });
});

describe('ClaudeRunner with fake CLI', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const runner = () => new ClaudeRunner(process.execPath, [FAKE], process.platform, env);
  const base = () => ({ cwd: dir, prompt: 'hello', timeoutMs: 15000 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ed-run-'));
    writeFileSync(join(dir, 'results.json'), JSON.stringify(['{"answer":42}']));
    env = { ...process.env, FAKE_CLAUDE_RESULTS: join(dir, 'results.json'), FAKE_CLAUDE_COUNTER: join(dir, 'n'), FAKE_CLAUDE_LOG: join(dir, 'log') };
  });

  it('returns the result text and session id and reports tool progress', async () => {
    const progress: RunProgress[] = [];
    const r = await runner().run({ ...base(), onProgress: (p) => progress.push(p) });
    expect(r.text).toBe('{"answer":42}');
    expect(r.sessionId).toMatch(/^sess-/);
    expect(progress.filter((p) => p.type === 'tool')).toEqual([
      { type: 'tool', name: 'Grep', detail: 'handleWebhook' },
      { type: 'tool', name: 'Read', detail: 'src/routes/webhooks.ts' },
    ]);
  });

  it('sends a 200k-character prompt over stdin, not argv', async () => {
    await runner().run({ ...base(), prompt: 'x'.repeat(200_000) });
    const log = JSON.parse(readFileSync(join(dir, 'log'), 'utf8').trim());
    expect(log.stdinLength).toBe(200_000);
    expect(log.args.join(' ').length).toBeLessThan(1000);
  });

  it('passes --resume', async () => {
    await runner().run({ ...base(), resumeSessionId: 'sess-old' });
    const log = JSON.parse(readFileSync(join(dir, 'log'), 'utf8').trim());
    expect(log.args).toContain('--resume');
    expect(log.args).toContain('sess-old');
  });

  it('raises ExplainerRunError with stderr on failure', async () => {
    env.FAKE_CLAUDE_MODE = 'fail';
    const err = await runner().run(base()).catch((e) => e);
    expect(err).toBeInstanceOf(ExplainerRunError);
    expect(err.stderrTail).toContain('boom');
  });

  it('raises ExplainerRunError when the CLI reports an error result', async () => {
    env.FAKE_CLAUDE_MODE = 'resume-missing';
    const err = await runner().run({ ...base(), resumeSessionId: 'gone' }).catch((e) => e);
    expect(err).toBeInstanceOf(ExplainerRunError);
    expect(err.message).toContain('No conversation found');
  });

  it('times out', async () => {
    env.FAKE_CLAUDE_MODE = 'slow';
    await expect(runner().run({ ...base(), timeoutMs: 800 })).rejects.toBeInstanceOf(ExplainerTimeoutError);
  });

  it('can be cancelled', async () => {
    env.FAKE_CLAUDE_MODE = 'slow';
    const ac = new AbortController();
    const p = runner().run({ ...base(), signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toBeInstanceOf(ExplainerAbortedError);
  });

  it('reports a missing CLI', async () => {
    const r = new ClaudeRunner(join(dir, 'definitely-not-here-claude'), [], process.platform, env);
    await expect(r.run(base())).rejects.toBeInstanceOf(ExplainerNotFoundError);
    expect(await r.version()).toBeNull();
  });

  it('reads the version', async () => {
    expect(await runner().version()).toBe('9.9.9 (Claude Code)');
  });
});

describe('argument safety (review fix)', () => {
  it('rejects a model value that could smuggle extra flags', () => {
    expect(() => buildArgs({ model: 'x\\" --dangerously-skip-permissions \\"' })).toThrow(/model/);
    expect(() => buildArgs({ model: 'claude-opus-5-5[1m]' })).not.toThrow();
  });
  it('rejects a resume id that is not a plain session id', () => {
    expect(() => buildArgs({ resumeSessionId: 'abc" --x' })).toThrow(/session/);
  });
  it('refuses Windows shell arguments that cmd.exe or the CRT would reinterpret', () => {
    for (const bad of ['a"b', 'ends-with\\', '%PATH%']) expect(() => buildSpawn('claude', [bad], 'win32')).toThrow();
  });
});

describe('createClaudeCodeExplainer', () => {
  it('describes itself and points setup at the claudePath setting', () => {
    const e = createClaudeCodeExplainer({ settings: () => undefined });
    expect(e.id).toBe('claude-code');
    expect(e.displayName).toBe('Claude Code');
    expect(e.setup.settingId).toBe('explainDiff.claudePath');
    expect(e.setup.docsUrl).toMatch(/^https:\/\//);
  });
  it('reads claudePath from settings', async () => {
    const e = createClaudeCodeExplainer({ settings: (k) => (k === 'claudePath' ? join(tmpdir(), 'no-such-claude-binary') : undefined) });
    expect(await e.version()).toBeNull();
  });
});
