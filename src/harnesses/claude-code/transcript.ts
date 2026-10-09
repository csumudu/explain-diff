import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import type { Session, SessionEvent } from '../../core/types';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export async function parseTranscriptFile(filePath: string): Promise<Session> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  return parseTranscriptLines(rl, filePath);
}

export async function parseTranscriptLines(
  lines: AsyncIterable<string> | Iterable<string>,
  filePath: string,
): Promise<Session> {
  const events: SessionEvent[] = [];
  const edited = new Set<string>();
  let id = '';
  let title: string | undefined;
  let branch: string | undefined;
  let cwd: string | undefined;
  let start = '';
  let end = '';

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    if (!id && typeof obj.sessionId === 'string') id = obj.sessionId;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      title = obj.aiTitle;
      continue;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (obj.isSidechain || obj.isMeta) continue;

    const time: string = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (time) {
      if (!start || time < start) start = time;
      if (!end || time > end) end = time;
    }
    if (typeof obj.gitBranch === 'string' && obj.gitBranch) branch = obj.gitBranch;
    if (typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;

    const content = obj.message?.content;
    if (obj.type === 'user') {
      if (typeof content === 'string') {
        const text = cleanUserText(content);
        if (text) events.push({ kind: 'user', time, text });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') {
            const text = cleanUserText(String(b.text ?? ''));
            if (text) events.push({ kind: 'user', time, text });
          } else if (b?.type === 'tool_result') {
            events.push({ kind: 'toolResult', time, toolUseId: String(b.tool_use_id ?? ''), text: toolResultText(b.content) });
          }
        }
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          events.push({ kind: 'assistant', time, text: b.text.trim() });
        } else if (b?.type === 'tool_use') {
          const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
          const name = String(b.name ?? '');
          const shellCommand = name === 'Bash' && typeof input.command === 'string' ? input.command : undefined;
          const editedFile = EDIT_TOOLS.has(name) && typeof input.file_path === 'string' ? input.file_path : undefined;
          events.push({ kind: 'toolCall', time, id: String(b.id ?? ''), name, input, ...(shellCommand ? { shellCommand } : {}), ...(editedFile ? { editedFile } : {}) });
          if (editedFile) edited.add(editedFile);
        }
      }
    }
  }

  if (!title) {
    const first = events.find((e) => e.kind === 'user') as { text: string } | undefined;
    title = first ? first.text.slice(0, 60) : 'Untitled session';
  }
  return {
    id: id || basename(filePath).replace(/\.jsonl$/, ''),
    sourceId: 'claude-code',
    title,
    branch,
    cwd,
    start,
    end,
    events,
    editedFiles: [...edited],
    filePath,
  };
}

export function cleanUserText(text: string): string {
  if (text.startsWith('<local-command-')) return '';
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cmd = t.match(/<command-name>(.*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
  if (cmd) t = `${cmd[1]} ${cmd[2]}`;
  return t.trim();
}

function toolResultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (x?.type === 'text' ? String(x.text ?? '') : '')).join('\n');
  return '';
}
