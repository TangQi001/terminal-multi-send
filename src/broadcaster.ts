import * as vscode from "vscode";
import { isReadyState, TerminalState, TerminalStateManager } from "./terminalStateManager";

export interface BroadcastOptions {
  requireConfirmBeforeBroadcast: boolean;
  enableSensitiveCommandGuard: boolean;
  sensitiveKeywords: string[];
  waveThreshold: number;
  waveDelayMs: number;
}

export class Broadcaster {
  constructor(private readonly terminalStateManager: TerminalStateManager) {}

  public async broadcast(
    terminals: vscode.Terminal[],
    command: string,
    options: BroadcastOptions
  ): Promise<number> {
    const text = command.trim();
    if (!text || terminals.length === 0) {
      return 0;
    }

    const candidates = await this.filterBusyTerminals(terminals);
    if (candidates.length === 0) {
      return 0;
    }

    const shouldContinue = await this.confirmBroadcast(candidates.length, text, options);
    if (!shouldContinue) {
      return 0;
    }

    const waveThreshold = Math.max(1, options.waveThreshold);
    const waveDelayMs = Math.max(0, options.waveDelayMs);

    if (candidates.length > waveThreshold) {
      for (let i = 0; i < candidates.length; i += 1) {
        this.sendResolvedCommand(
          candidates[i],
          this.injectPlaceholders(text, candidates[i], i + 1)
        );
        if (i < candidates.length - 1 && waveDelayMs > 0) {
          await delay(waveDelayMs);
        }
      }
      return candidates.length;
    }

    candidates.forEach((terminal, index) => {
      this.sendResolvedCommand(
        terminal,
        this.injectPlaceholders(text, terminal, index + 1)
      );
    });
    return candidates.length;
  }

  private async filterBusyTerminals(
    terminals: vscode.Terminal[]
  ): Promise<vscode.Terminal[]> {
    const ready: vscode.Terminal[] = [];
    const busy: Array<{ terminal: vscode.Terminal; state: TerminalState }> = [];

    for (const terminal of terminals) {
      const state = this.terminalStateManager.getState(terminal);
      if (isReadyState(state)) {
        ready.push(terminal);
      } else {
        busy.push({ terminal, state });
      }
    }

    if (busy.length === 0) {
      return terminals;
    }

    const sendReadyLabel = vscode.l10n.t("Send Ready");
    const forceSendLabel = vscode.l10n.t("Force Send");
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Some terminals are busy ({0}/{1}). Continue with ready terminals or force send to all?",
        String(busy.length),
        String(terminals.length)
      ),
      { modal: true, detail: formatBusyTerminalsDetail(busy) },
      sendReadyLabel,
      forceSendLabel
    );

    if (picked === forceSendLabel) {
      return terminals;
    }
    if (picked === sendReadyLabel) {
      if (ready.length === 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("No ready terminal available for broadcast.")
        );
      }
      return ready;
    }
    return [];
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
    this.terminalStateManager.notifyInputSent(terminal);
    terminal.sendText(normalized, false);
    terminal.sendText("", true);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatBusyTerminalsDetail(
  busy: Array<{ terminal: vscode.Terminal; state: TerminalState }>
): string {
  const preview = busy.slice(0, 5).map((item) => {
    return `${item.terminal.name} [${toStateText(item.state)}]`;
  });

  const suffix =
    busy.length > preview.length
      ? `, +${busy.length - preview.length}`
      : "";
  return preview.join(", ") + suffix;
}

function toStateText(state: TerminalState): string {
  switch (state) {
    case TerminalState.RUNNING_PROGRAM:
      return "RUNNING_PROGRAM";
    case TerminalState.CLI_THINKING:
      return "CLI_THINKING";
    case TerminalState.CLI_WAITING:
      return "CLI_WAITING";
    case TerminalState.IDLE:
    default:
      return "IDLE";
  }
}
