import * as vscode from "vscode";
import { isReadyState, TerminalState, TerminalStateManager } from "./terminalStateManager";

export interface BroadcastOptions {
  requireConfirmBeforeBroadcast: boolean;
  enableSensitiveCommandGuard: boolean;
  sensitiveKeywords: string[];
  waveThreshold: number;
  waveDelayMs: number;
}

export interface AutomatedBroadcastBehavior {
  readyOnly?: boolean;
}

export interface InteractiveBroadcastBehavior {
  skipBusyFilter?: boolean;
  waitUntilReadyMs?: number;
  allowForceAfterReadyTimeout?: boolean;
}

export class Broadcaster {
  constructor(private readonly terminalStateManager: TerminalStateManager) {}

  public async broadcast(
    terminals: vscode.Terminal[],
    command: string,
    options: BroadcastOptions,
    behavior: InteractiveBroadcastBehavior = {}
  ): Promise<number> {
    const text = command.trim();
    if (!text || terminals.length === 0) {
      return 0;
    }

    const deduped = [...new Set(terminals)];
    const candidates = behavior.skipBusyFilter
      ? deduped
      : await this.filterBusyTerminals(deduped);
    if (candidates.length === 0) {
      return 0;
    }

    const shouldContinue = await this.confirmBroadcast(candidates.length, text, options);
    if (!shouldContinue) {
      return 0;
    }

    const waitMs = Math.max(0, Math.round(behavior.waitUntilReadyMs ?? 0));
    let readyCandidates =
      waitMs > 0 ? await this.waitForReadyCandidates(candidates, waitMs) : candidates;
    if (
      behavior.allowForceAfterReadyTimeout &&
      readyCandidates.length < candidates.length
    ) {
      readyCandidates = candidates;
    }
    if (readyCandidates.length === 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("No ready terminal available for broadcast.")
      );
      return 0;
    }

    if (readyCandidates.length < candidates.length) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Some terminals are still busy after waiting. Sent to {0}/{1} ready terminal(s).",
          String(readyCandidates.length),
          String(candidates.length)
        )
      );
    }

    return this.dispatchResolvedCommands(readyCandidates, text, options);
  }

  public async broadcastNonInteractive(
    terminals: vscode.Terminal[],
    command: string,
    options: BroadcastOptions,
    behavior: AutomatedBroadcastBehavior = {}
  ): Promise<number> {
    const text = command.trim();
    if (!text || terminals.length === 0) {
      return 0;
    }

    const deduped = [...new Set(terminals)];
    const candidates = behavior.readyOnly
      ? deduped.filter((terminal) =>
          this.terminalStateManager.isReadyForBroadcast(terminal)
        )
      : deduped;

    if (candidates.length === 0) {
      return 0;
    }

    return this.dispatchResolvedCommands(candidates, text, options);
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

  private async dispatchResolvedCommands(
    terminals: vscode.Terminal[],
    command: string,
    options: BroadcastOptions
  ): Promise<number> {
    const waveThreshold = Math.max(1, options.waveThreshold);
    const waveDelayMs = Math.max(0, options.waveDelayMs);

    const useWave = terminals.length > waveThreshold;
    for (let i = 0; i < terminals.length; i += 1) {
      await this.sendResolvedCommand(
        terminals[i],
        this.injectPlaceholders(command, terminals[i], i + 1)
      );
      if (i < terminals.length - 1 && useWave && waveDelayMs > 0) {
        await delay(waveDelayMs);
      }
    }
    return terminals.length;
  }

  private async waitForReadyCandidates(
    terminals: vscode.Terminal[],
    waitMs: number
  ): Promise<vscode.Terminal[]> {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const ready = terminals.filter(
        (terminal) =>
          vscode.window.terminals.includes(terminal) &&
          this.terminalStateManager.isReadyForBroadcast(terminal)
      );
      if (ready.length === terminals.length) {
        return ready;
      }
      await delay(120);
    }

    return terminals.filter(
      (terminal) =>
        vscode.window.terminals.includes(terminal) &&
        this.terminalStateManager.isReadyForBroadcast(terminal)
    );
  }

  private async sendResolvedCommand(
    terminal: vscode.Terminal,
    command: string
  ): Promise<void> {
    const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.terminalStateManager.notifyInputSent(terminal);
    const interactiveCli = this.terminalStateManager.isInteractiveCliSession(terminal);
    const lines = normalized.split("\n");
    for (const line of lines) {
      const state = this.terminalStateManager.getState(terminal);
      terminal.sendText(line, false);
      if (interactiveCli && state === TerminalState.CLI_THINKING) {
        // Codex-like CLI requires Tab to queue while still working.
        terminal.sendText("\t", false);
        await delay(10);
      }
      await this.sendEnterKey(terminal);
      await delay(16);
    }
  }

  private async sendEnterKey(terminal: vscode.Terminal): Promise<void> {
    if (!vscode.window.terminals.includes(terminal)) {
      return;
    }

    const previousActive = vscode.window.activeTerminal;
    const shouldRestorePrevious =
      !!previousActive &&
      previousActive !== terminal &&
      vscode.window.terminals.includes(previousActive);

    terminal.show(false);
    await delay(10);
    try {
      await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", {
        text: "\u000d"
      });
    } catch {
      terminal.sendText("", true);
    }

    if (shouldRestorePrevious && previousActive) {
      previousActive.show(false);
    }
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
