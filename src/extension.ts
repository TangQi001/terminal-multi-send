import * as vscode from "vscode";
import { Broadcaster } from "./broadcaster";
import { readNexusConfig } from "./config";
import { ControlPanelProvider } from "./controlPanelProvider";
import { QuickCommands } from "./quickCommands";
import { TerminalManager } from "./terminalManager";

export function activate(context: vscode.ExtensionContext): void {
  const terminalManager = new TerminalManager();
  const quickCommands = new QuickCommands(context);
  const broadcaster = new Broadcaster();
  const controlPanelProvider = new ControlPanelProvider(
    terminalManager,
    quickCommands,
    broadcaster
  );

  const command = vscode.commands.registerCommand(
    "cursorTerminalNexus.broadcast",
    async () => {
      const allTerminals = await terminalManager.listTerminals();
      const config = readNexusConfig();
      const targets = await terminalManager.pickTerminals(
        allTerminals,
        config.autoSelectRegex
      );

      if (targets.length === 0) {
        if (allTerminals.length > 0) {
          vscode.window.showInformationMessage(
            vscode.l10n.t("No terminal selected. Broadcast canceled.")
          );
        }
        return;
      }

      const commandText = await quickCommands.promptForCommand(targets.length);
      if (!commandText) {
        return;
      }

      const sentCount = await broadcaster.broadcast(targets, commandText, config.options);
      if (sentCount === 0) {
        return;
      }

      quickCommands.record(commandText);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t("$(zap) Broadcast sent to {0} terminal(s)", String(sentCount)),
        3000
      );
    }
  );

  const openControlPanelCommand = vscode.commands.registerCommand(
    "cursorTerminalNexus.openControlPanel",
    async () => {
      await vscode.commands.executeCommand("workbench.view.explorer");
      try {
        await vscode.commands.executeCommand(
          `${ControlPanelProvider.viewType}.focus`
        );
      } catch {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Switched to Explorer. Expand Terminal Nexus in the sidebar.")
        );
      }
    }
  );

  const viewRegistration = vscode.window.registerWebviewViewProvider(
    ControlPanelProvider.viewType,
    controlPanelProvider,
    {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }
  );

  context.subscriptions.push(
    command,
    openControlPanelCommand,
    viewRegistration,
    terminalManager,
    controlPanelProvider
  );
}

export function deactivate(): void {}
