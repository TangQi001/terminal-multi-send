import * as vscode from "vscode";

const HISTORY_KEY = "cursorTerminalNexus.commandHistory";

interface CommandPickItem extends vscode.QuickPickItem {
  kindType: "input" | "history" | "preset";
  command?: string;
}

export class QuickCommands {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public async promptForCommand(targetCount: number): Promise<string | undefined> {
    const config = readQuickCommandConfig();
    const history = config.enableHistory ? this.getHistory() : [];
    const presetCommands = normalizeCommands(config.quickCommands);

    const initial = await this.pickInitialValue(history, presetCommands, targetCount);
    if (initial === undefined) {
      return undefined;
    }

    const command = await vscode.window.showInputBox({
      title: "Cursor Terminal Nexus",
      prompt: `向 ${targetCount} 个终端广播命令`,
      placeHolder: "例如: npm run dev",
      value: initial,
      ignoreFocusOut: true
    });

    if (!command || !command.trim()) {
      return undefined;
    }

    return command.trim();
  }

  public record(command: string): void {
    const text = command.trim();
    if (!text) {
      return;
    }

    const config = readQuickCommandConfig();
    if (!config.enableHistory) {
      return;
    }

    const history = this.getHistory().filter((item) => item !== text);
    history.unshift(text);
    const nextHistory = history.slice(0, config.maxHistory);
    void this.context.globalState.update(HISTORY_KEY, nextHistory);
  }

  private getHistory(): string[] {
    const raw = this.context.globalState.get<string[]>(HISTORY_KEY, []);
    return normalizeCommands(raw);
  }

  private async pickInitialValue(
    history: string[],
    presets: string[],
    targetCount: number
  ): Promise<string | undefined> {
    const items = this.buildPickItems(history, presets);
    if (items.length === 0) {
      return "";
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: "Cursor Terminal Nexus",
      placeHolder: `选择历史/预设命令（将广播到 ${targetCount} 个终端）`,
      ignoreFocusOut: true
    });

    if (!picked) {
      return undefined;
    }

    if (picked.kindType === "input") {
      return "";
    }

    return picked.command ?? "";
  }

  private buildPickItems(history: string[], presets: string[]): CommandPickItem[] {
    const items: CommandPickItem[] = [
      {
        label: "$(edit) 输入新命令",
        description: "手动输入并广播",
        kindType: "input"
      }
    ];

    for (const command of history) {
      items.push({
        label: `$(history) ${command}`,
        description: "历史命令",
        kindType: "history",
        command
      });
    }

    const historySet = new Set(history);
    for (const command of presets) {
      if (historySet.has(command)) {
        continue;
      }
      items.push({
        label: `$(symbol-key) ${command}`,
        description: "预设命令",
        kindType: "preset",
        command
      });
    }

    return items;
  }
}

interface QuickCommandConfig {
  quickCommands: string[];
  enableHistory: boolean;
  maxHistory: number;
}

function readQuickCommandConfig(): QuickCommandConfig {
  const config = vscode.workspace.getConfiguration("cursorTerminalNexus");
  return {
    quickCommands: normalizeCommands(config.get<string[]>("quickCommands", [])),
    enableHistory: config.get<boolean>("enableHistory", true),
    maxHistory: Math.max(1, config.get<number>("maxHistory", 30))
  };
}

function normalizeCommands(commands: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const text = command.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}
