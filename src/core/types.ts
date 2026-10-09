import type { Explanation } from './explanationSchema';

export type SessionEvent =
  | { kind: 'user'; time: string; text: string }
  | { kind: 'assistant'; time: string; text: string }
  | { kind: 'toolCall'; time: string; id: string; name: string; input: Record<string, unknown>; shellCommand?: string; editedFile?: string }
  | { kind: 'toolResult'; time: string; toolUseId: string; text: string };

export interface Session {
  id: string;
  sourceId: string;
  title: string;
  branch?: string;
  cwd?: string;
  start: string; // ISO
  end: string; // ISO
  events: SessionEvent[];
  editedFiles: string[];
  filePath: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string; // ISO 8601 with offset
  agentCoAuthored: boolean;
}

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
  added: number | null; // null for binary
  removed: number | null;
  binary: boolean;
}

export interface LinkedCommit {
  commit: CommitInfo;
  eventIndex: number | null;
  via: 'transcript' | 'trailer' | 'none';
}

export interface SessionGroup {
  session: Session;
  commits: LinkedCommit[];
}

export interface LinkResult {
  groups: SessionGroup[];
  other: LinkedCommit[];
}

export interface QaTurn {
  question: string;
  section?: string;
  answer: string;
  askedAt: string;
  filesChecked: string[];
}

export interface StoredExplanation {
  sha: string;
  promptVersion: number;
  generatedAt: string;
  explainerSessionId: string;
  inferred: boolean;
  explanation: Explanation;
  thread: QaTurn[];
}
