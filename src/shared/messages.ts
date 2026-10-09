export type ExplainToHost =
  | { type: 'ready' }
  | { type: 'openRef'; path: string; line?: number }
  | { type: 'focusFile'; path: string }
  | { type: 'openAllChanges' }
  | { type: 'openChat' }
  | { type: 'askSection'; section: string }
  | { type: 'regenerate' }
  | { type: 'export' }
  | { type: 'openTranscript' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'openSettings' }
  | { type: 'diagramError'; key: string; code: string; error: string }
  | { type: 'retryDiagram'; key: string };

export type ChatToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'suggest'; text: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openRef'; path: string; line?: number };

export type HostToWebview =
  | { type: 'render'; html: string }
  | { type: 'header'; html: string }
  | { type: 'thread'; html: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'prefill'; text: string };
