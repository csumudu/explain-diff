import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { ExplainerAbortedError, ExplainerNotFoundError, ExplainerRunError, ExplainerTimeoutError } from '../errors';
import type { Explainer, ExplainerOptions, RunOptions, RunResult } from '../types';

export const ALLOWED_TOOLS = 'Read,Grep,Glob,Bash(git show:*),Bash(git log:*),Bash(git grep:*)';
export const DISALLOWED_TOOLS = 'Edit,Write,NotebookEdit';

const SAFE_MODEL = /^[\w.:[\]-]+$/;
const SAFE_SESSION_ID = /^[\w-]+$/;

export function buildArgs(o: Pick<RunOptions, 'resumeSessionId' | 'model' | 'maxTurns'>): string[] {
  if (o.model && !SAFE_MODEL.test(o.model)) throw new Error(`Invalid explainDiff.model setting: ${JSON.stringify(o.model)}`);
  if (o.resumeSessionId && !SAFE_SESSION_ID.test(o.resumeSessionId)) throw new Error(`Invalid Claude session id: ${JSON.stringify(o.resumeSessionId)}`);
  const a = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', ALLOWED_TOOLS,
    '--disallowedTools', DISALLOWED_TOOLS,
    '--strict-mcp-config',
    '--max-turns', String(o.maxTurns ?? 40),
  ];
  if (o.model) a.push('--model', o.model);
  if (o.resumeSessionId) a.push('--resume', o.resumeSessionId);
  return a;
}

/**
 * Arguments are wrapped in plain double quotes for cmd.exe. Characters that cmd.exe or the C runtime
 * would still reinterpret inside quotes are refused rather than escaped.
 */
const quoteWin = (a: string) => {
  if (/["%\r\n]/.test(a) || a.endsWith('\\')) throw new Error(`Unsafe argument for the Windows shell: ${JSON.stringify(a)}`);
  return `"${a}"`;
};

export function buildSpawn(command: string, args: string[], platform: NodeJS.Platform) {
  if (platform === 'win32') return { file: [command, ...args].map(quoteWin).join(' '), args: [] as string[], shell: true };
  return { file: command, args, shell: false };
}

export class ClaudeRunner {
  constructor(
    private readonly command: string,
    private readonly prefixArgs: string[] = [],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  run(o: RunOptions): Promise<RunResult> {
    if (o.signal?.aborted) return Promise.reject(new ExplainerAbortedError('Cancelled'));
    let sp: ReturnType<typeof buildSpawn>;
    try {
      sp = buildSpawn(this.command, [...this.prefixArgs, ...buildArgs(o)], this.platform);
    } catch (e) {
      return Promise.reject(e);
    }

    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(sp.file, sp.args, { cwd: o.cwd, shell: sp.shell, windowsHide: true, env: this.env });
      } catch (e) {
        reject(new ExplainerNotFoundError(String(e)));
        return;
      }
      let buf = '';
      let stderr = '';
      let sessionId = '';
      let result: { text: string; isError: boolean } | null = null;
      let settled = false;

      const finish = (err?: Error, res?: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(res!);
      };
      const timer = setTimeout(() => {
        killTree(child, this.platform);
        finish(new ExplainerTimeoutError(`Claude did not finish within ${Math.round(o.timeoutMs / 1000)} seconds`));
      }, o.timeoutMs);
      const onAbort = () => {
        killTree(child, this.platform);
        finish(new ExplainerAbortedError('Cancelled'));
      };
      o.signal?.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b?.type === 'tool_use') o.onProgress?.({ type: 'tool', name: String(b.name), detail: toolDetail(b.input) });
            else if (b?.type === 'text' && b.text) o.onProgress?.({ type: 'text', text: String(b.text) });
          }
        }
        if (ev.type === 'result') {
          result = {
            text: typeof ev.result === 'string' ? ev.result : '',
            isError: ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success'),
          };
        }
      };

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => {
        stderr = (stderr + c).slice(-4000);
      });
      child.on('error', (e: NodeJS.ErrnoException) =>
        finish(e.code === 'ENOENT' ? new ExplainerNotFoundError(`Could not run "${this.command}"`) : e),
      );
      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        const r = result as { text: string; isError: boolean } | null;
        if (r && !r.isError) return finish(undefined, { text: r.text, sessionId });
        if (code === 127 || code === 9009 || /not recognized|not found|ENOENT/i.test(stderr)) {
          if (!r) return finish(new ExplainerNotFoundError(`Could not run "${this.command}"`));
        }
        finish(new ExplainerRunError(r?.isError ? `Claude reported an error: ${r.text}` : `Claude exited with code ${code}`, code, stderr.slice(-1000)));
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.prompt);
    });
  }

  version(): Promise<string | null> {
    let sp: ReturnType<typeof buildSpawn>;
    try {
      sp = buildSpawn(this.command, [...this.prefixArgs, '--version'], this.platform);
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let out = '';
      let child: ChildProcess;
      try {
        child = spawn(sp.file, sp.args, { shell: sp.shell, windowsHide: true, env: this.env });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        killTree(child, this.platform);
        resolve(null);
      }, 10000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => (out += c));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && out.trim() ? out.trim() : null);
      });
    });
  }
}

function toolDetail(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.pattern ?? input.file_path ?? input.path ?? input.command ?? '');
}

function killTree(child: ChildProcess, platform: NodeJS.Platform) {
  if (platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}

export function createClaudeCodeExplainer(o: ExplainerOptions): Explainer {
  const runner = () => new ClaudeRunner(String(o.settings('claudePath') || 'claude'));
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    run: (opts) => runner().run(opts),
    version: () => runner().version(),
    setup: {
      message: 'Explanations need the Claude Code CLI installed and signed in.',
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
      settingId: 'explainDiff.claudePath',
    },
  };
}
