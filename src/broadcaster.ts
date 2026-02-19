import * as vscode from "vscode";

export interface BroadcastOptions {
  requireConfirmBeforeBroadcast: boolean;
  enableSensitiveCommandGuard: boolean;
  sensitiveKeywords: string[];
  waveThreshold: number;
  waveDelayMs: number;
}

export class Broadcaster {
  public async broadcast(
    terminals: vscode.Terminal[],
    command: string,
    options: BroadcastOptions
  ): Promise<number> {
    const text = command.trim();
    if (!text || terminals.length === 0) {
      return 0;
    }

    const shouldContinue = await this.confirmBroadcast(terminals.length, text, options);
    if (!shouldContinue) {
      return 0;
    }

    const waveThreshold = Math.max(1, options.waveThreshold);
    const waveDelayMs = Math.max(0, options.waveDelayMs);

    if (terminals.length > waveThreshold) {
      for (let i = 0; i < terminals.length; i += 1) {
        this.sendResolvedCommand(
          terminals[i],
          this.injectPlaceholders(text, terminals[i], i + 1)
        );
        if (i < terminals.length - 1 && waveDelayMs > 0) {
          await delay(waveDelayMs);
        }
      }
      return terminals.length;
    }

    terminals.forEach((terminal, index) => {
      this.sendResolvedCommand(
        terminal,
        this.injectPlaceholders(text, terminal, index + 1)
      );
    });
    return terminals.length;
  }

  private async confirmBroadcast(
    count: number,
    command: string,
    options: BroadcastOptions
  ): Promise<boolean> {
    if (options.enableSensitiveCommandGuard && this.containsSensitiveCommand(command, options)) {
      const guarded = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Potentially destructive keyword detected. Continue only if you are sure."
        ),
        { modal: true },
        vscode.l10n.t("Send Anyway")
      );
      if (guarded !== vscode.l10n.t("Send Anyway")) {
        return false;
      }
    }

    if (options.requireConfirmBeforeBroadcast) {
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Broadcast this command to {0} terminal(s)?", String(count)),
        { modal: true },
        vscode.l10n.t("Send")
      );
      return confirmed === vscode.l10n.t("Send");
    }

    return true;
  }

  private containsSensitiveCommand(command: string, options: BroadcastOptions): boolean {
    const normalized = command.toLowerCase();
    return options.sensitiveKeywords.some((keyword) => {
      const target = keyword.trim().toLowerCase();
      return !!target && normalized.includes(target);
    });
  }

  private injectPlaceholders(
    command: string,
    terminal: vscode.Terminal,
    index: number
  ): string {
    const terminalName = terminal.name ?? "";
    return command
      .replace(/\{index\}/g, String(index))
      .replace(/\{name:quoted\}/g, this.quoteForShell(terminalName))
      .replace(/\{name\}/g, terminalName);
  }

  private quoteForShell(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }

  private sendResolvedCommand(terminal: vscode.Terminal, command: string): void {
    const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    terminal.sendText(normalized, false);
    terminal.sendText("", true);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
