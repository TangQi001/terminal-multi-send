import * as vscode from "vscode";

export interface TerminalDescriptor {
  terminal: vscode.Terminal;
  name: string;
  processId?: number;
}

interface TerminalQuickPickItem extends vscode.QuickPickItem {
  terminal: vscode.Terminal;
}

const PID_TIMEOUT_MS = 150;
const SELECT_ALL_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("check-all"),
  tooltip: "全选"
};
const CLEAR_ALL_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("clear-all"),
  tooltip: "清空"
};

export class TerminalManager implements vscode.Disposable {
  private readonly pidCache = new WeakMap<vscode.Terminal, number | undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        void this.primePid(terminal);
      })
    );
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.pidCache.delete(terminal);
      })
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public async listTerminals(): Promise<TerminalDescriptor[]> {
    const terminals = vscode.window.terminals;
    const descriptors = await Promise.all(
      terminals.map(async (terminal) => ({
        terminal,
        name: terminal.name,
        processId: await this.getPid(terminal)
      }))
    );
    return descriptors;
  }

  public async pickTerminals(
    terminals: TerminalDescriptor[],
    autoSelectRegex: string
  ): Promise<vscode.Terminal[]> {
    if (terminals.length === 0) {
      vscode.window.showErrorMessage("未检测到可用终端，请先打开至少一个集成终端。");
      return [];
    }

    if (terminals.length === 1) {
      return [terminals[0].terminal];
    }

    const preselected = this.findPreselected(terminals, autoSelectRegex);
    const items: TerminalQuickPickItem[] = terminals.map((descriptor, index) => ({
      label: `$(terminal) ${descriptor.name}`,
      description: descriptor.processId ? `PID: ${descriptor.processId}` : "PID: Unknown",
      detail: `Terminal ${index + 1}`,
      picked: preselected.has(descriptor.terminal),
      terminal: descriptor.terminal
    }));

    return this.pickWithControls(items);
  }

  private findPreselected(
    terminals: TerminalDescriptor[],
    autoSelectRegex: string
  ): Set<vscode.Terminal> {
    const result = new Set<vscode.Terminal>();
    if (!autoSelectRegex.trim()) {
      return result;
    }

    try {
      const regex = new RegExp(autoSelectRegex);
      for (const descriptor of terminals) {
        if (regex.test(descriptor.name)) {
          result.add(descriptor.terminal);
        }
      }
    } catch {
      void vscode.window.showWarningMessage(
        `autoSelectRegex 无效，已忽略: ${autoSelectRegex}`
      );
    }

    return result;
  }

  private async primePid(terminal: vscode.Terminal): Promise<void> {
    await this.getPid(terminal);
  }

  private async getPid(terminal: vscode.Terminal): Promise<number | undefined> {
    if (this.pidCache.has(terminal)) {
      return this.pidCache.get(terminal);
    }

    let pid: number | undefined;
    try {
      pid = await promiseWithTimeout(terminal.processId, PID_TIMEOUT_MS);
    } catch {
      pid = undefined;
    }

    this.pidCache.set(terminal, pid);
    return pid;
  }

  private async pickWithControls(items: TerminalQuickPickItem[]): Promise<vscode.Terminal[]> {
    return new Promise<vscode.Terminal[]>((resolve) => {
      const quickPick = vscode.window.createQuickPick<TerminalQuickPickItem>();
      quickPick.canSelectMany = true;
      quickPick.ignoreFocusOut = true;
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.title = "Cursor Terminal Nexus";
      quickPick.placeholder = "选择目标终端（可多选）";
      quickPick.items = items;
      quickPick.selectedItems = items.filter((item) => item.picked);
      quickPick.buttons = [SELECT_ALL_BUTTON, CLEAR_ALL_BUTTON];

      let completed = false;
      const finish = (selected: vscode.Terminal[]) => {
        if (completed) {
          return;
        }
        completed = true;
        quickPick.dispose();
        resolve(selected);
      };

      quickPick.onDidTriggerButton((button) => {
        if (button === SELECT_ALL_BUTTON) {
          quickPick.selectedItems = items;
          return;
        }
        if (button === CLEAR_ALL_BUTTON) {
          quickPick.selectedItems = [];
        }
      });

      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems.map((item) => item.terminal);
        finish(selected);
      });

      quickPick.onDidHide(() => {
        finish([]);
      });

      quickPick.show();
    });
  }
}

async function promiseWithTimeout<T>(
  promise: Thenable<T>,
  timeoutMs: number
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
