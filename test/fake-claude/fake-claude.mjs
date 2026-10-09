// Fake `claude` for tests. Behaviour is controlled by environment variables:
// FAKE_CLAUDE_MODE: ok | fail | slow | resume-missing   (default ok)
// FAKE_CLAUDE_RESULTS: path to a JSON array of result strings; call N returns item N (last repeats)
// FAKE_CLAUDE_COUNTER: path to a counter file (needed for FAKE_CLAUDE_RESULTS sequencing)
// FAKE_CLAUDE_LOG: path; each call appends {"args":[...],"stdinLength":n,"stdin":"..."} as one line
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const env = process.env;
if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdinLength: stdin.length, stdin: stdin.slice(0, 2000) }) + '\n');
const mode = env.FAKE_CLAUDE_MODE ?? 'ok';
const resumeIdx = args.indexOf('--resume');
const resume = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const sid = 'sess-' + Math.random().toString(36).slice(2, 8);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let n = 0;
if (env.FAKE_CLAUDE_COUNTER) {
  n = existsSync(env.FAKE_CLAUDE_COUNTER) ? Number(readFileSync(env.FAKE_CLAUDE_COUNTER, 'utf8')) : 0;
  writeFileSync(env.FAKE_CLAUDE_COUNTER, String(n + 1));
}
if (mode === 'fail') {
  process.stderr.write('boom: something broke\n');
  process.exit(2);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 60000));
if (mode === 'resume-missing' && resume) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume });
  process.exit(1);
}
const results = env.FAKE_CLAUDE_RESULTS ? JSON.parse(readFileSync(env.FAKE_CLAUDE_RESULTS, 'utf8')) : ['ok'];
const text = results[Math.min(n, results.length - 1)];
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'handleWebhook' } }] } });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/routes/webhooks.ts' } }] } });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
