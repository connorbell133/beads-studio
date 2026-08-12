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
}

export const createdPanels: FakeWebviewPanel[] = [];

export const window = {
  showErrorMessage: () => undefined,
  showWarningMessage: () => undefined,
  showInformationMessage: () => undefined,
  setStatusBarMessage: () => undefined,
  createWebviewPanel: (viewType: string, title: string): FakeWebviewPanel => {
    const disposeHandlers: Array<() => void> = [];
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
      onDidChangeViewState: () => ({ dispose: () => undefined }),
      fireDispose: () => {
        if (panel.disposed) return;
        panel.disposed = true;
        panel.visible = false;
        for (const handler of disposeHandlers) handler();
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
