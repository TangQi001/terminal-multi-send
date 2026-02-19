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
      title: vscode.l10n.t("Cursor Terminal Nexus"),
      prompt: vscode.l10n.t(
        "Broadcast command to {0} terminal(s)",
        String(targetCount)
      ),
      placeHolder: vscode.l10n.t("e.g. npm run dev"),
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
      title: vscode.l10n.t("Cursor Terminal Nexus"),
      placeHolder: vscode.l10n.t(
        "Select history/preset command (will be broadcast to {0} terminal(s))",
        String(targetCount)
      ),
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
        label: vscode.l10n.t("$(edit) Enter New Command"),
        description: vscode.l10n.t("Type a command manually and broadcast it"),
        kindType: "input"
      }
    ];

    for (const command of history) {
      items.push({
        label: `$(history) ${command}`,
        description: vscode.l10n.t("History"),
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
        description: vscode.l10n.t("Preset"),
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
