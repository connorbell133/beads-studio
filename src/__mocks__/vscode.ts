/**
 * Minimal `vscode` module stub for jest.
 *
 * The real module is only injected by the VS Code host, so tests that import
 * extension code need this shim. Add members here as tests require them.
 */

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  public readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
    fsPath: [base.fsPath, ...parts].join("/"),
  }),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export class Diagnostic {
  public source?: string;
  public code?: string | number;
  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity: number = DiagnosticSeverity.Error
  ) {}
}

/**
 * A stub diagnostic collection, recording entries by fsPath so tests can assert
 * on what was published and to which uri.
 */
export interface FakeDiagnosticCollection {
  name: string;
  /** Current entries, keyed by the anchor uri's fsPath. */
  entries: Map<string, Diagnostic[]>;
  /** Every mutation in order, so ordering assertions are possible. */
  calls: Array<{ op: "set" | "delete" | "clear"; fsPath?: string; count?: number }>;
  disposed: boolean;
  set: (uri: { fsPath: string }, diagnostics: Diagnostic[]) => void;
  delete: (uri: { fsPath: string }) => void;
  clear: () => void;
  dispose: () => void;
}

export class CodeActionKind {
  constructor(public readonly value: string) {}
  static readonly QuickFix = new CodeActionKind("quickfix");
}

export class CodeAction {
  public diagnostics?: Diagnostic[];
  public command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public readonly title: string,
    public readonly kind?: CodeActionKind
  ) {}
}

export const createdDiagnosticCollections: FakeDiagnosticCollection[] = [];

export const languages = {
  registerCodeActionsProvider: () => ({ dispose: () => undefined }),
  createDiagnosticCollection: (name: string): FakeDiagnosticCollection => {
    const collection: FakeDiagnosticCollection = {
      name,
      entries: new Map<string, Diagnostic[]>(),
      calls: [],
      disposed: false,
      set: (uri, diagnostics) => {
        collection.entries.set(uri.fsPath, diagnostics);
        collection.calls.push({ op: "set", fsPath: uri.fsPath, count: diagnostics.length });
      },
      delete: (uri) => {
        collection.entries.delete(uri.fsPath);
        collection.calls.push({ op: "delete", fsPath: uri.fsPath });
      },
      clear: () => {
        collection.entries.clear();
        collection.calls.push({ op: "clear" });
      },
      dispose: () => {
        collection.entries.clear();
        collection.disposed = true;
      },
    };
    createdDiagnosticCollections.push(collection);
    return collection;
  },
};

/** A disposable stub webview panel, recording what was posted to it. */
export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  visible: boolean;
  disposed: boolean;
  posted: unknown[];
  revealCount: number;
  webview: {
    html: string;
    cspSource: string;
    asWebviewUri: (uri: unknown) => unknown;
    postMessage: (message: unknown) => void;
    onDidReceiveMessage: (handler: (message: unknown) => void) => { dispose: () => void };
  };
  reveal: () => void;
  dispose: () => void;
  onDidDispose: (handler: () => void) => { dispose: () => void };
  onDidChangeViewState: (handler: () => void) => { dispose: () => void };
  fireDispose: () => void;
  /** Moves the tab to or from the foreground, as the real host would. */
  setVisible: (visible: boolean) => void;
}

export const createdPanels: FakeWebviewPanel[] = [];

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const window = {
  showErrorMessage: () => undefined,
  showWarningMessage: () => undefined,
  showInformationMessage: () => undefined,
  showQuickPick: async () => undefined,
  setStatusBarMessage: () => undefined,
  withProgress: async <T>(_options: unknown, task: () => Promise<T>): Promise<T> => task(),
  createWebviewPanel: (viewType: string, title: string): FakeWebviewPanel => {
    const disposeHandlers: Array<() => void> = [];
    const viewStateHandlers: Array<() => void> = [];
    const panel: FakeWebviewPanel = {
      viewType,
      title,
      visible: true,
      disposed: false,
      posted: [],
      revealCount: 0,
      webview: {
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: unknown) => uri,
        postMessage: (message: unknown) => {
          if (panel.disposed) {
            // Matches the real host: posting to a disposed panel is a no-op,
            // not a throw.
            return;
          }
          panel.posted.push(message);
        },
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      reveal: () => {
        panel.revealCount++;
      },
      dispose: () => {
        panel.fireDispose();
      },
      onDidDispose: (handler: () => void) => {
        disposeHandlers.push(handler);
        return { dispose: () => undefined };
      },
      onDidChangeViewState: (handler: () => void) => {
        viewStateHandlers.push(handler);
        return { dispose: () => undefined };
      },
      fireDispose: () => {
        if (panel.disposed) return;
        panel.disposed = true;
        panel.visible = false;
        for (const handler of disposeHandlers) handler();
      },
      setVisible: (visible: boolean) => {
        if (panel.visible === visible) return;
        panel.visible = visible;
        for (const handler of viewStateHandlers) handler();
      },
    };
    createdPanels.push(panel);
    return panel;
  },
  createOutputChannel: () => ({
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
};

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue,
  }),
};

export const commands = {
  executeCommand: () => undefined,
};

export const env = {
  clipboard: { writeText: async () => undefined },
};
