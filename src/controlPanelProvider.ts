import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Broadcaster } from "./broadcaster";
import {
  EditableSettingKey,
  readNexusConfig,
  updateNexusSetting
} from "./config";
import { QuickCommands } from "./quickCommands";
import { AutomationStatus, TaskAutomationManager } from "./taskAutomationManager";
import { TerminalDescriptor, TerminalManager } from "./terminalManager";
import { TerminalState, TerminalStateManager } from "./terminalStateManager";

interface ManagedTerminal {
  key: string;
  terminal: vscode.Terminal;
  name: string;
  processId?: number;
}

type SortMode =
  | "custom"
  | "name-asc"
  | "name-desc"
  | "pid-asc"
  | "pid-desc"
  | "selected-first";

type GroupMode = "none" | "tool-type";
type PanelLanguage = "en" | "zh-CN";

interface ViewPreferences {
  sortMode: SortMode;
  groupMode: GroupMode;
  customOrder: string[];
  collapsedGroups: string[];
}

interface ViewPreferencesPatch {
  sortMode?: SortMode;
  groupMode?: GroupMode;
  customOrder?: string[];
  collapsedGroups?: string[];
}

type ViewMessage =
  | { type: "requestState" }
  | { type: "refreshTerminals" }
  | { type: "selectAll" }
  | { type: "clearSelection" }
  | { type: "setSelection"; selectedKeys: string[] }
  | { type: "sendCommand"; command: string }
  | { type: "setPanelLanguage"; language: PanelLanguage }
  | { type: "startPolling"; command: string; intervalMs: number }
  | { type: "stopPolling" }
  | { type: "startTaskChain"; script: string; waitTimeoutMs: number }
  | { type: "stopTaskChain" }
  | { type: "updateSetting"; key: string; value: string | number | boolean }
  | { type: "updateViewPreferences"; payload: ViewPreferencesPatch };

export class ControlPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "cursorTerminalNexus.controlPanel";

  private static readonly viewPreferencesStateKey =
    "cursorTerminalNexus.controlPanel.viewPreferences";
  private static readonly panelLanguageStateKey =
    "cursorTerminalNexus.controlPanel.panelLanguage";

  private readonly disposables: vscode.Disposable[] = [];
  private readonly panelBundles: Record<PanelLanguage, Record<string, string>>;
  private view?: vscode.WebviewView;
  private terminals: ManagedTerminal[] = [];
  private selectedKeys = new Set<string>();
  private refreshNonce = 0;
  private viewPreferences: ViewPreferences;
  private panelLanguage: PanelLanguage;
  private postStateTimer?: NodeJS.Timeout;
  private readonly taskAutomationManager: TaskAutomationManager;
  private lastAutomationErrors = {
    polling: "",
    chain: ""
  };

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly terminalStateManager: TerminalStateManager,
    private readonly quickCommands: QuickCommands,
    private readonly broadcaster: Broadcaster
  ) {
    this.panelBundles = {
      en: this.loadPanelBundle("bundle.l10n.json"),
      "zh-CN": this.loadPanelBundle("bundle.l10n.zh-cn.json")
    };
    this.taskAutomationManager = new TaskAutomationManager(
      this.terminalStateManager,
      this.broadcaster
    );
    this.viewPreferences = sanitizeViewPreferences(
      this.extensionContext.workspaceState.get(
        ControlPanelProvider.viewPreferencesStateKey
      )
    );
    this.panelLanguage = this.resolveInitialPanelLanguage();

    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => {
        void this.refreshTerminals();
      }),
      vscode.window.onDidCloseTerminal(() => {
        void this.refreshTerminals();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("cursorTerminalNexus")) {
          void this.postState();
        }
      }),
      this.terminalStateManager.onDidChangeState(() => {
        this.schedulePostState();
      }),
      this.taskAutomationManager.onDidChangeStatus((status) => {
        this.handleAutomationStatus(status);
        this.schedulePostState();
      })
    );
  }

  public dispose(): void {
    if (this.postStateTimer) {
      clearTimeout(this.postStateTimer);
      this.postStateTimer = undefined;
    }
    this.taskAutomationManager.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private schedulePostState(): void {
    if (this.postStateTimer) {
      return;
    }
    this.postStateTimer = setTimeout(() => {
      this.postStateTimer = undefined;
      void this.postState();
    }, 80);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: ViewMessage) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
      })
    );

    void this.refreshTerminals();
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case "requestState":
      case "refreshTerminals":
        await this.refreshTerminals();
        return;
      case "selectAll":
        this.selectedKeys = new Set(this.terminals.map((item) => item.key));
        await this.postState();
        return;
      case "clearSelection":
        this.selectedKeys.clear();
        await this.postState();
        return;
      case "setSelection":
        this.selectedKeys = new Set(
          message.selectedKeys.filter((key) =>
            this.terminals.some((terminal) => terminal.key === key)
          )
        );
        await this.postState();
        return;
      case "sendCommand":
        await this.sendSelected(message.command);
        return;
      case "setPanelLanguage":
        await this.setPanelLanguage(message.language);
        return;
      case "startPolling":
        this.startPolling(message.command, message.intervalMs);
        await this.postState();
        return;
      case "stopPolling":
        this.taskAutomationManager.stopPolling();
        await this.postState();
        return;
      case "startTaskChain":
        this.startTaskChain(message.script, message.waitTimeoutMs);
        await this.postState();
        return;
      case "stopTaskChain":
        this.taskAutomationManager.stopChain();
        await this.postState();
        return;
      case "updateSetting":
        await this.handleSettingUpdate(message.key, message.value);
        return;
      case "updateViewPreferences":
        await this.handleViewPreferencesUpdate(message.payload);
        return;
      default:
        return;
    }
  }

  private async refreshTerminals(): Promise<void> {
    const currentNonce = ++this.refreshNonce;
    const descriptors = await this.terminalManager.listTerminals();
    if (currentNonce !== this.refreshNonce) {
      return;
    }

    this.terminals = toManagedTerminals(descriptors);
    const terminalKeys = this.terminals.map((item) => item.key);
    const availableKeys = new Set(terminalKeys);

    this.selectedKeys = new Set(
      [...this.selectedKeys].filter((key) => availableKeys.has(key))
    );

    const normalizedPreferences = mergeViewPreferences(
      this.viewPreferences,
      undefined,
      terminalKeys
    );
    if (!areViewPreferencesEqual(this.viewPreferences, normalizedPreferences)) {
      this.viewPreferences = normalizedPreferences;
      await this.persistViewPreferences();
    }

    if (this.selectedKeys.size === 0) {
      this.selectedKeys = applyRegexSelection(
        this.terminals,
        readNexusConfig().autoSelectRegex
      );
    }

    await this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    const config = readNexusConfig();
    await this.view.webview.postMessage({
      type: "state",
      terminals: this.terminals.map((item) => ({
        key: item.key,
        name: item.name,
        processId: item.processId,
        state: this.terminalStateManager.getState(item.terminal)
      })),
      selectedKeys: [...this.selectedKeys],
      viewPreferences: this.viewPreferences,
      settings: {
        autoSelectRegex: config.autoSelectRegex,
        requireConfirmBeforeBroadcast: config.options.requireConfirmBeforeBroadcast,
        enableSensitiveCommandGuard: config.options.enableSensitiveCommandGuard,
        waveThreshold: config.options.waveThreshold,
        waveDelayMs: config.options.waveDelayMs
      },
      panelLanguage: this.panelLanguage,
      automation: this.taskAutomationManager.getStatus()
    });
  }

  private async sendSelected(command: string): Promise<void> {
    const text = command.trim();
    if (!text) {
      return;
    }

    const targets = this.terminals
      .filter((item) => this.selectedKeys.has(item.key))
      .map((item) => item.terminal);
    if (targets.length === 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Select at least one target terminal first.")
      );
      return;
    }

    const sentCount = await this.broadcaster.broadcast(
      targets,
      text,
      readNexusConfig().options,
      { skipBusyFilter: true, waitUntilReadyMs: 8000, allowForceAfterReadyTimeout: true }
    );
    if (sentCount === 0) {
      return;
    }

    this.quickCommands.record(text);
    vscode.window.setStatusBarMessage(
      vscode.l10n.t("$(zap) Broadcast sent to {0} terminal(s)", String(sentCount)),
      3000
    );
  }

  private async handleSettingUpdate(
    rawKey: string,
    rawValue: string | number | boolean
  ): Promise<void> {
    if (!isEditableSettingKey(rawKey)) {
      return;
    }

    const normalized = normalizeSettingValue(rawKey, rawValue);
    if (normalized === undefined) {
      return;
    }

    if (rawKey === "autoSelectRegex") {
      try {
        const nextRegex = String(normalized).trim();
        if (nextRegex) {
          void new RegExp(nextRegex);
        }
      } catch {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Invalid autoSelectRegex ignored for this update: {0}",
            String(normalized)
          )
        );
        return;
      }
    }

    await updateNexusSetting(rawKey, normalized);
    if (rawKey === "autoSelectRegex") {
      this.selectedKeys = applyRegexSelection(this.terminals, String(normalized));
    }
    await this.postState();
  }

  private async handleViewPreferencesUpdate(
    payload: ViewPreferencesPatch
  ): Promise<void> {
    const merged = mergeViewPreferences(
      this.viewPreferences,
      payload,
      this.terminals.map((item) => item.key)
    );

    if (areViewPreferencesEqual(this.viewPreferences, merged)) {
      return;
    }

    this.viewPreferences = merged;
    await this.persistViewPreferences();
    await this.postState();
  }

  private async persistViewPreferences(): Promise<void> {
    await this.extensionContext.workspaceState.update(
      ControlPanelProvider.viewPreferencesStateKey,
      this.viewPreferences
    );
  }

  private startPolling(command: string, intervalMs: number): void {
    const targets = this.resolveSelectedTerminals();
    try {
      this.taskAutomationManager.startPolling(
        targets,
        command,
        intervalMs,
        readNexusConfig().options
      );
    } catch (error) {
      void vscode.window.showWarningMessage(toErrorMessage(error));
    }
  }

  private startTaskChain(script: string, waitTimeoutMs: number): void {
    const targets = this.resolveSelectedTerminals();
    try {
      this.taskAutomationManager.startChain(
        targets,
        script,
        waitTimeoutMs,
        readNexusConfig().options
      );
    } catch (error) {
      void vscode.window.showWarningMessage(toErrorMessage(error));
    }
  }

  private resolveSelectedTerminals(): vscode.Terminal[] {
    return this.terminals
      .filter((item) => this.selectedKeys.has(item.key))
      .map((item) => item.terminal);
  }

  private handleAutomationStatus(status: AutomationStatus): void {
    if (status.polling.error && status.polling.error !== this.lastAutomationErrors.polling) {
      this.lastAutomationErrors.polling = status.polling.error;
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Polling stopped: {0}", status.polling.error)
      );
    } else if (!status.polling.error) {
      this.lastAutomationErrors.polling = "";
    }

    if (status.chain.error && status.chain.error !== this.lastAutomationErrors.chain) {
      this.lastAutomationErrors.chain = status.chain.error;
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Task chain stopped: {0}", status.chain.error)
      );
    } else if (!status.chain.error) {
      this.lastAutomationErrors.chain = "";
    }
  }

  private async setPanelLanguage(language: PanelLanguage): Promise<void> {
    if (!isPanelLanguage(language) || language === this.panelLanguage) {
      return;
    }
    this.panelLanguage = language;
    await this.extensionContext.workspaceState.update(
      ControlPanelProvider.panelLanguageStateKey,
      language
    );
    if (this.view) {
      this.view.webview.html = this.getWebviewHtml(this.view.webview);
    }
  }

  private resolveInitialPanelLanguage(): PanelLanguage {
    const stored = this.extensionContext.workspaceState.get(
      ControlPanelProvider.panelLanguageStateKey
    );
    if (isPanelLanguage(stored)) {
      return stored;
    }
    return /^zh(-|$)/i.test(vscode.env.language) ? "zh-CN" : "en";
  }

  private loadPanelBundle(fileName: string): Record<string, string> {
    try {
      const fullPath = path.join(this.extensionContext.extensionPath, "l10n", fileName);
      const content = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(content) as Record<string, string>;
      return parsed;
    } catch {
      return {};
    }
  }

  private localizePanel(
    language: PanelLanguage,
    key: string,
    ...args: string[]
  ): string {
    const template = this.panelBundles[language][key] ?? key;
    return formatL10nMessage(template, args);
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const locale = this.panelLanguage;
    const l = (key: string, ...args: string[]) =>
      this.localizePanel(locale, key, ...args);
    const i18n = {
      title: l("TQ Terminal Nexus"),
      refresh: l("Refresh"),
      selectAll: l("Select All"),
      clear: l("Clear"),
      selectedCount: l("Selected {0} / {1}"),
      groupBy: l("Group By"),
      groupNone: l("No Grouping"),
      groupToolType: l("Tool Type"),
      sortBy: l("Sort By"),
      sortCustom: l("Custom Order"),
      sortNameAsc: l("Name A-Z"),
      sortNameDesc: l("Name Z-A"),
      sortPidAsc: l("PID Asc"),
      sortPidDesc: l("PID Desc"),
      sortSelectedFirst: l("Selected First"),
      customDragEnabled: l("Drag items to customize order."),
      customDragDisabled: l(
        "Drag reorder is available only in No Grouping + Custom Order mode."
      ),
      collapseGroup: l("Collapse group"),
      expandGroup: l("Expand group"),
      dragHandle: l("Drag to reorder"),
      groupBasic: l("Basic Terminal"),
      groupSecurity: l("Security"),
      groupNetwork: l("Network"),
      groupDevOps: l("DevOps"),
      groupData: l("Data"),
      groupOther: l("Other"),
      tabSendNow: l("Send Now"),
      tabPolling: l("Polling"),
      tabTaskChain: l("Task Chain"),
      command: l("Command"),
      sendShortcut: l("Ctrl/Cmd + Enter to send"),
      commandInputPlaceholder: l("Enter text or command to broadcast"),
      commandPlaceholderHelp: l(
        "Placeholders: {name}, {index}, quoted name: {name:quoted}"
      ),
      sendToSelectedTerminals: l("Send to Selected Terminals"),
      pollingCommand: l("Polling Command"),
      pollingCommandPlaceholder: l("Enter command for interval sending"),
      pollingIntervalSeconds: l("Interval (seconds)"),
      startPolling: l("Start Polling"),
      stopPolling: l("Stop Polling"),
      pollingStatusIdle: l("Polling idle"),
      pollingStatusRunning: l(
        "Polling every {0}s, last sent {1} terminal(s)"
      ),
      pollingStatusError: l("Polling error: {0}"),
      chainScript: l("Task Chain Script"),
      chainScriptPlaceholder: l(
        "One command per line. Use directives like {delay: 2000} and {wait_ready: 5000, timeout: 120000}."
      ),
      chainSyntaxHelp: l(
        "Directives: {delay:ms}, {wait_ready:ms}, {wait_idle:ms}, optional timeout: {wait_ready:ms, timeout:ms}; comments start with #."
      ),
      chainPreview: l("Syntax Preview"),
      chainPreviewOk: l("No syntax issues"),
      chainLineError: l("Line {0}: {1}"),
      chainErrorUnknownDirective: l("Unknown directive"),
      chainErrorEmptyDirective: l("Empty directive"),
      chainErrorInvalidToken: l("Invalid directive token"),
      chainErrorWaitConflict: l(
        "wait_ready and wait_idle cannot be used together"
      ),
      chainErrorDelayExtra: l("delay cannot be combined with other keys"),
      chainErrorWaitExtra: l(
        "wait_ready/wait_idle only allow optional timeout"
      ),
      chainErrorTimeoutMin: l("timeout must be >= 1000"),
      chainErrorDirectiveValue: l(
        "Directive value must be number milliseconds"
      ),
      chainErrorDirectiveSyntax: l(
        "Invalid directive syntax. Use {wait_ready: 5000}"
      ),
      chainWaitTimeoutSeconds: l("Wait timeout per step (seconds)"),
      startChain: l("Start Chain"),
      stopChain: l("Stop Chain"),
      chainStatusIdle: l("Task chain idle"),
      chainStatusRunning: l("Running step {0}/{1}: {2}"),
      chainStatusDone: l("Task chain completed"),
      chainStatusStopped: l("Task chain stopped"),
      chainStatusError: l("Task chain error: {0}"),
      autoSelectRegex: l("Auto-select Regex"),
      autoSelectRegexPlaceholder: l("e.g. Agent.*"),
      confirmBeforeBroadcast: l("Confirm Before Send"),
      sensitiveCommandGuard: l("Sensitive Command Guard"),
      enabled: l("Enabled"),
      waveThreshold: l("Wave Threshold"),
      waveDelay: l("Wave Delay"),
      noTerminalsAvailable: l("No terminals available."),
      pidWithValue: l("PID: {0}"),
      pidUnknown: l("PID: Unknown"),
      stateIdle: l("Idle"),
      stateRunningProgram: l("Running Program"),
      stateCliWaiting: l("CLI Waiting"),
      stateCliThinking: l("CLI Thinking"),
      statusReady: l("Ready"),
      statusBusy: l("Busy"),
      settingsTitle: l("Settings"),
      settingsOpen: l("Open settings"),
      settingsClose: l("Close"),
      language: l("Language"),
      languageEnglish: l("English"),
      languageChinese: l("Chinese")
    };
    const i18nJson = JSON.stringify(i18n);

    return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${i18n.title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --bg-soft: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
      --row-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent);
      --group-bg: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
      --drop-border: var(--vscode-focusBorder);
    }
    body {
      margin: 0;
      padding: 10px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-size: 12px;
      line-height: 1.45;
    }
    .block {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      margin-bottom: 10px;
      background: var(--bg-soft);
    }
    .row {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .row:last-child {
      margin-bottom: 0;
    }
    .label {
      color: var(--muted);
      min-width: 68px;
    }
    button {
      border: 1px solid var(--border);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 6px;
      cursor: pointer;
      padding: 3px 8px;
      font-size: 12px;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .sub {
      color: var(--muted);
      font-size: 11px;
    }
    input[type="text"], input[type="number"], textarea, select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 5px 7px;
      font-size: 12px;
    }
    select {
      cursor: pointer;
      min-width: 90px;
      width: auto;
    }
    textarea {
      min-height: 72px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .terminal-list {
      max-height: 230px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px;
      background: var(--vscode-editor-background);
    }
    .terminal-item {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 3px 4px;
      border-radius: 4px;
      border-top: 1px solid transparent;
      border-bottom: 1px solid transparent;
    }
    .terminal-item:hover {
      background: var(--row-hover);
    }
    .terminal-item.drag-enabled {
      cursor: default;
    }
    .terminal-item.dragging {
      opacity: 0.6;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      background: var(--row-hover);
    }
    .terminal-item.drop-before {
      border-top-color: var(--drop-border);
    }
    .terminal-item.drop-after {
      border-bottom-color: var(--drop-border);
    }
    .drag-handle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      color: var(--muted);
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
    }
    .drag-handle.disabled {
      opacity: 0.2;
      cursor: default;
    }
    .terminal-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .terminal-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex-shrink: 0;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
    }
    .terminal-status-dot.ready {
      background: var(--vscode-terminal-ansiGreen, #3fb950);
    }
    .terminal-status-dot.busy {
      background: var(--vscode-terminal-ansiYellow, #d29922);
    }
    .terminal-meta {
      color: var(--muted);
      font-size: 11px;
      flex-shrink: 0;
    }
    .terminal-state-label {
      color: var(--muted);
      font-size: 11px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .group {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 6px;
      overflow: hidden;
    }
    .group:last-child {
      margin-bottom: 0;
    }
    .group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      background: var(--group-bg);
      border-bottom: 1px solid var(--border);
    }
    .group.collapsed .group-header {
      border-bottom: none;
    }
    .group-title {
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-toggle {
      border: none;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      width: 16px;
      padding: 0;
      line-height: 1;
    }
    .group-items {
      padding: 4px 2px;
    }
    .group.collapsed .group-items {
      display: none;
    }
    .sort-row {
      align-items: flex-start;
    }
    .sort-field {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }
    .settings-slot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex: 0 0 auto;
      min-width: 28px;
    }
    .tab-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .tab-button {
      flex: 1;
      text-align: center;
    }
    .tab-button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .tab-panel {
      display: none;
    }
    .tab-panel.active {
      display: block;
    }
    .status-line {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      min-height: 16px;
      white-space: pre-wrap;
    }
    .chain-preview {
      margin-top: 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 6px;
      max-height: 150px;
      overflow: auto;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.35;
    }
    .chain-preview-line {
      display: flex;
      gap: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chain-preview-line.empty {
      opacity: 0.5;
    }
    .chain-preview-line.comment {
      color: var(--vscode-terminal-ansiGreen, #3fb950);
    }
    .chain-preview-line.directive {
      color: var(--vscode-terminal-ansiCyan, #39c5cf);
    }
    .chain-preview-line.error {
      color: var(--vscode-errorForeground, #f85149);
    }
    .chain-preview-line .line-no {
      width: 24px;
      color: var(--muted);
      text-align: right;
      flex-shrink: 0;
    }
    .icon-btn {
      width: 28px;
      height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
    }
    .settings-panel {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 220px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
      z-index: 20;
      display: none;
    }
    .settings-panel.visible {
      display: block;
    }
    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div id="settingsPanel" class="settings-panel">
    <div class="settings-header">
      <span>${i18n.settingsTitle}</span>
      <button id="settingsCloseBtn">${i18n.settingsClose}</button>
    </div>
    <div class="row">
      <span class="label">${i18n.language}</span>
      <select id="panelLanguageSelect">
        <option value="zh-CN">${i18n.languageChinese}</option>
        <option value="en">${i18n.languageEnglish}</option>
      </select>
    </div>
  </div>

  <div class="block">
    <div class="row">
      <button id="refreshBtn">${i18n.refresh}</button>
      <button id="selectAllBtn">${i18n.selectAll}</button>
      <button id="clearBtn">${i18n.clear}</button>
      <span id="selectedCount" class="sub"></span>
    </div>
    <div class="row sort-row">
      <div class="sort-field">
        <span class="label">${i18n.groupBy}</span>
        <select id="groupModeSelect">
          <option value="none">${i18n.groupNone}</option>
          <option value="tool-type">${i18n.groupToolType}</option>
        </select>
      </div>
      <div class="sort-field">
        <span class="label">${i18n.sortBy}</span>
        <select id="sortModeSelect">
          <option value="custom">${i18n.sortCustom}</option>
          <option value="name-asc">${i18n.sortNameAsc}</option>
          <option value="name-desc">${i18n.sortNameDesc}</option>
          <option value="pid-asc">${i18n.sortPidAsc}</option>
          <option value="pid-desc">${i18n.sortPidDesc}</option>
          <option value="selected-first">${i18n.sortSelectedFirst}</option>
        </select>
      </div>
      <div class="settings-slot">
        <button id="settingsBtn" class="icon-btn" title="${i18n.settingsOpen}">⚙</button>
      </div>
    </div>
    <div id="dragHint" class="sub"></div>
    <div id="terminalList" class="terminal-list"></div>
  </div>

  <div class="block">
    <div class="tab-row">
      <button id="tabSendBtn" class="tab-button active">${i18n.tabSendNow}</button>
      <button id="tabPollingBtn" class="tab-button">${i18n.tabPolling}</button>
      <button id="tabChainBtn" class="tab-button">${i18n.tabTaskChain}</button>
    </div>

    <div id="tabSendPanel" class="tab-panel active">
      <div class="row">
        <span class="label">${i18n.command}</span>
        <span class="sub">${i18n.sendShortcut}</span>
      </div>
      <textarea id="commandInput" placeholder="${i18n.commandInputPlaceholder}"></textarea>
      <div class="row">
        <span class="sub">${i18n.commandPlaceholderHelp}</span>
      </div>
      <div class="row" style="margin-top:8px;">
        <button id="sendBtn" class="primary">${i18n.sendToSelectedTerminals}</button>
      </div>
    </div>

    <div id="tabPollingPanel" class="tab-panel">
      <div class="row">
        <span class="label">${i18n.pollingCommand}</span>
      </div>
      <textarea id="pollingCommandInput" placeholder="${i18n.pollingCommandPlaceholder}"></textarea>
      <div class="row" style="margin-top:8px;">
        <span class="label">${i18n.pollingIntervalSeconds}</span>
        <input id="pollingIntervalSec" type="number" min="1" step="1" value="5" />
      </div>
      <div class="row">
        <button id="startPollingBtn" class="primary">${i18n.startPolling}</button>
        <button id="stopPollingBtn">${i18n.stopPolling}</button>
      </div>
      <div id="pollingStatus" class="status-line"></div>
    </div>

    <div id="tabChainPanel" class="tab-panel">
      <div class="row">
        <span class="label">${i18n.chainScript}</span>
      </div>
      <textarea id="chainScriptInput" placeholder="${i18n.chainScriptPlaceholder}"></textarea>
      <div class="row">
        <span class="sub">${i18n.chainSyntaxHelp}</span>
      </div>
      <div class="row">
        <span class="label">${i18n.chainPreview}</span>
      </div>
      <div id="chainPreview" class="chain-preview"></div>
      <div id="chainLintStatus" class="status-line"></div>
      <div class="row">
        <span class="label">${i18n.chainWaitTimeoutSeconds}</span>
        <input id="chainWaitTimeoutSec" type="number" min="1" step="1" value="300" />
      </div>
      <div class="row">
        <button id="startChainBtn" class="primary">${i18n.startChain}</button>
        <button id="stopChainBtn">${i18n.stopChain}</button>
      </div>
      <div id="chainStatus" class="status-line"></div>
    </div>
  </div>

  <div class="block">
    <div class="row">
      <span class="label">${i18n.autoSelectRegex}</span>
      <input id="autoSelectRegex" type="text" placeholder="${i18n.autoSelectRegexPlaceholder}" />
    </div>
    <div class="row">
      <span class="label">${i18n.confirmBeforeBroadcast}</span>
      <label><input type="checkbox" id="requireConfirmBeforeBroadcast" /> ${i18n.enabled}</label>
    </div>
    <div class="row">
      <span class="label">${i18n.sensitiveCommandGuard}</span>
      <label><input type="checkbox" id="enableSensitiveCommandGuard" /> ${i18n.enabled}</label>
    </div>
    <div class="row">
      <span class="label">${i18n.waveThreshold}</span>
      <input id="waveThreshold" type="number" min="1" step="1" />
    </div>
    <div class="row">
      <span class="label">${i18n.waveDelay}</span>
      <input id="waveDelayMs" type="number" min="0" step="5" />
      <span class="sub">ms</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const i18n = ${i18nJson};
    const vscode = acquireVsCodeApi();

    const GROUP_ORDER = ["basic", "security", "network", "devops", "data", "other"];

    let state = {
      terminals: [],
      selectedKeys: [],
      viewPreferences: {
        sortMode: "custom",
        groupMode: "none",
        customOrder: [],
        collapsedGroups: []
      },
      settings: {
        autoSelectRegex: "",
        requireConfirmBeforeBroadcast: false,
        enableSensitiveCommandGuard: true,
        waveThreshold: 20,
        waveDelayMs: 20
      },
      panelLanguage: "${locale}",
      automation: {
        polling: {
          active: false,
          command: "",
          intervalMs: 5000,
          targetCount: 0,
          lastRunAt: undefined,
          lastSentCount: 0,
          error: ""
        },
        chain: {
          active: false,
          currentStep: 0,
          totalSteps: 0,
          targetCount: 0,
          detail: "",
          error: ""
        }
      }
    };

    let activeTab = "send";
    let settingsPanelVisible = false;
    let draggingKey = "";
    let dragHandleKey = "";

    const collator = new Intl.Collator(document.documentElement.lang || undefined, {
      numeric: true,
      sensitivity: "base"
    });

    const terminalList = document.getElementById("terminalList");
    const selectedCount = document.getElementById("selectedCount");
    const commandInput = document.getElementById("commandInput");
    const settingsBtn = document.getElementById("settingsBtn");
    const settingsPanel = document.getElementById("settingsPanel");
    const settingsCloseBtn = document.getElementById("settingsCloseBtn");
    const panelLanguageSelect = document.getElementById("panelLanguageSelect");
    const refreshBtn = document.getElementById("refreshBtn");
    const selectAllBtn = document.getElementById("selectAllBtn");
    const clearBtn = document.getElementById("clearBtn");
    const sendBtn = document.getElementById("sendBtn");
    const groupModeSelect = document.getElementById("groupModeSelect");
    const sortModeSelect = document.getElementById("sortModeSelect");
    const dragHint = document.getElementById("dragHint");

    const tabSendBtn = document.getElementById("tabSendBtn");
    const tabPollingBtn = document.getElementById("tabPollingBtn");
    const tabChainBtn = document.getElementById("tabChainBtn");
    const tabSendPanel = document.getElementById("tabSendPanel");
    const tabPollingPanel = document.getElementById("tabPollingPanel");
    const tabChainPanel = document.getElementById("tabChainPanel");

    const pollingCommandInput = document.getElementById("pollingCommandInput");
    const pollingIntervalSec = document.getElementById("pollingIntervalSec");
    const startPollingBtn = document.getElementById("startPollingBtn");
    const stopPollingBtn = document.getElementById("stopPollingBtn");
    const pollingStatus = document.getElementById("pollingStatus");

    const chainScriptInput = document.getElementById("chainScriptInput");
    const chainPreview = document.getElementById("chainPreview");
    const chainLintStatus = document.getElementById("chainLintStatus");
    const chainWaitTimeoutSec = document.getElementById("chainWaitTimeoutSec");
    const startChainBtn = document.getElementById("startChainBtn");
    const stopChainBtn = document.getElementById("stopChainBtn");
    const chainStatus = document.getElementById("chainStatus");

    const autoSelectRegex = document.getElementById("autoSelectRegex");
    const requireConfirmBeforeBroadcast = document.getElementById("requireConfirmBeforeBroadcast");
    const enableSensitiveCommandGuard = document.getElementById("enableSensitiveCommandGuard");
    const waveThreshold = document.getElementById("waveThreshold");
    const waveDelayMs = document.getElementById("waveDelayMs");
    let chainLintError = "";

    function format(message, ...args) {
      return message.replace(/\\{(\\d+)\\}/g, (_, index) => {
        const value = args[Number(index)];
        return value === undefined ? "" : String(value);
      });
    }

    function post(message) {
      vscode.postMessage(message);
    }

    function saveViewPreferences(patch) {
      post({ type: "updateViewPreferences", payload: patch });
    }

    function isCustomDragEnabled() {
      return (
        state.viewPreferences.sortMode === "custom" &&
        state.viewPreferences.groupMode === "none"
      );
    }

    function getSelectedKeysFromDom() {
      const selected = [];
      const checkboxes = terminalList.querySelectorAll("input[data-terminal-key]");
      checkboxes.forEach((checkbox) => {
        if (checkbox.checked) {
          selected.push(checkbox.getAttribute("data-terminal-key"));
        }
      });
      return selected.filter((item) => Boolean(item));
    }

    function syncSelectionFromDom() {
      post({ type: "setSelection", selectedKeys: getSelectedKeysFromDom() });
    }

    function compareName(a, b) {
      return collator.compare(a.name, b.name);
    }

    function comparePid(a, b) {
      const aPid = Number.isFinite(a.processId) ? a.processId : Number.MAX_SAFE_INTEGER;
      const bPid = Number.isFinite(b.processId) ? b.processId : Number.MAX_SAFE_INTEGER;
      if (aPid !== bPid) {
        return aPid - bPid;
      }
      return compareName(a, b);
    }

    function getNormalizedCustomOrder() {
      const keys = state.terminals.map((item) => item.key);
      const orderSet = new Set();
      const normalized = [];
      state.viewPreferences.customOrder.forEach((key) => {
        if (keys.includes(key) && !orderSet.has(key)) {
          orderSet.add(key);
          normalized.push(key);
        }
      });
      keys.forEach((key) => {
        if (!orderSet.has(key)) {
          orderSet.add(key);
          normalized.push(key);
        }
      });
      return normalized;
    }

    function getSortedTerminals() {
      const selected = new Set(state.selectedKeys);
      const terminals = [...state.terminals];
      const sortMode = state.viewPreferences.sortMode;

      if (sortMode === "custom") {
        const order = getNormalizedCustomOrder();
        const index = new Map(order.map((key, position) => [key, position]));
        terminals.sort((a, b) => {
          const aIndex = index.get(a.key) ?? Number.MAX_SAFE_INTEGER;
          const bIndex = index.get(b.key) ?? Number.MAX_SAFE_INTEGER;
          if (aIndex !== bIndex) {
            return aIndex - bIndex;
          }
          return compareName(a, b);
        });
        return terminals;
      }

      if (sortMode === "name-asc") {
        terminals.sort(compareName);
        return terminals;
      }

      if (sortMode === "name-desc") {
        terminals.sort((a, b) => compareName(b, a));
        return terminals;
      }

      if (sortMode === "pid-asc") {
        terminals.sort(comparePid);
        return terminals;
      }

      if (sortMode === "pid-desc") {
        terminals.sort((a, b) => comparePid(b, a));
        return terminals;
      }

      terminals.sort((a, b) => {
        const aSelected = selected.has(a.key) ? 1 : 0;
        const bSelected = selected.has(b.key) ? 1 : 0;
        if (aSelected !== bSelected) {
          return bSelected - aSelected;
        }
        return compareName(a, b);
      });
      return terminals;
    }

    function inferGroupId(name) {
      const raw = String(name || "").toLowerCase();

      if (/(security|sec|crypto|crypt|hash|jwt|scan|audit|pentest|vuln|ssh|gpg|openssl|nmap|sqlmap|burp|metasploit)/.test(raw)) {
        return "security";
      }

      if (/(network|net|http|https|dns|proxy|socket|tcp|udp|ping|curl|wget|wireshark)/.test(raw)) {
        return "network";
      }

      if (/(devops|docker|k8s|kubernetes|helm|terraform|ansible|jenkins|ci|cd|deploy|aws|gcp|azure)/.test(raw)) {
        return "devops";
      }

      if (/(data|db|mysql|postgres|redis|mongodb|sqlite|elasticsearch|kafka)/.test(raw)) {
        return "data";
      }

      if (/(bash|zsh|sh|pwsh|powershell|cmd|terminal|shell)/.test(raw)) {
        return "basic";
      }

      return "other";
    }

    function groupLabelById(groupId) {
      if (groupId === "basic") {
        return i18n.groupBasic;
      }
      if (groupId === "security") {
        return i18n.groupSecurity;
      }
      if (groupId === "network") {
        return i18n.groupNetwork;
      }
      if (groupId === "devops") {
        return i18n.groupDevOps;
      }
      if (groupId === "data") {
        return i18n.groupData;
      }
      return i18n.groupOther;
    }

    function getGroupedTerminals(sortedTerminals) {
      const groups = new Map();
      sortedTerminals.forEach((terminal) => {
        const groupId = inferGroupId(terminal.name);
        const current = groups.get(groupId);
        if (current) {
          current.terminals.push(terminal);
        } else {
          groups.set(groupId, {
            id: groupId,
            label: groupLabelById(groupId),
            terminals: [terminal]
          });
        }
      });

      const result = [...groups.values()];
      result.sort((a, b) => {
        const aIndex = GROUP_ORDER.indexOf(a.id);
        const bIndex = GROUP_ORDER.indexOf(b.id);
        if (aIndex !== bIndex) {
          return aIndex - bIndex;
        }
        return collator.compare(a.label, b.label);
      });
      return result;
    }

    function reorderCustomOrder(sourceKey, targetKey, placeAfter) {
      if (!sourceKey || !targetKey || sourceKey === targetKey) {
        return null;
      }

      const order = getNormalizedCustomOrder();
      const sourceIndex = order.indexOf(sourceKey);
      const targetIndex = order.indexOf(targetKey);
      if (sourceIndex < 0 || targetIndex < 0) {
        return null;
      }

      order.splice(sourceIndex, 1);
      const nextTargetIndex = order.indexOf(targetKey);
      const insertAt = placeAfter ? nextTargetIndex + 1 : nextTargetIndex;
      order.splice(insertAt, 0, sourceKey);
      return order;
    }

    function clearDropMarkers() {
      terminalList
        .querySelectorAll(".drop-before, .drop-after")
        .forEach((item) => {
          item.classList.remove("drop-before", "drop-after");
        });
    }

    function getTerminalStateInfo(rawState) {
      if (rawState === "${TerminalState.CLI_WAITING}") {
        return {
          ready: true,
          stateLabel: i18n.stateCliWaiting,
          badge: i18n.statusReady
        };
      }
      if (rawState === "${TerminalState.RUNNING_PROGRAM}") {
        return {
          ready: false,
          stateLabel: i18n.stateRunningProgram,
          badge: i18n.statusBusy
        };
      }
      if (rawState === "${TerminalState.CLI_THINKING}") {
        return {
          ready: false,
          stateLabel: i18n.stateCliThinking,
          badge: i18n.statusBusy
        };
      }
      return {
        ready: true,
        stateLabel: i18n.stateIdle,
        badge: i18n.statusReady
      };
    }

    function createTerminalItem(terminal, selected, options) {
      const item = document.createElement("div");
      item.className = "terminal-item";
      const terminalState = getTerminalStateInfo(terminal.state);

      const handle = document.createElement("span");
      handle.className = options.dragEnabled ? "drag-handle" : "drag-handle disabled";
      handle.textContent = "≡";
      handle.title = i18n.dragHandle;
      if (options.dragEnabled) {
        handle.addEventListener("pointerdown", () => {
          dragHandleKey = terminal.key;
        });
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-terminal-key", terminal.key);
      checkbox.checked = selected.has(terminal.key);
      checkbox.addEventListener("change", syncSelectionFromDom);

      const name = document.createElement("span");
      name.className = "terminal-name";
      name.textContent = terminal.name;

      const statusDot = document.createElement("span");
      statusDot.className = terminalState.ready
        ? "terminal-status-dot ready"
        : "terminal-status-dot busy";
      statusDot.title = terminalState.badge;

      const meta = document.createElement("span");
      meta.className = "terminal-meta";
      meta.textContent = terminal.processId !== undefined
        ? "(" + format(i18n.pidWithValue, terminal.processId) + ")"
        : "(" + i18n.pidUnknown + ")";

      const stateLabel = document.createElement("span");
      stateLabel.className = "terminal-state-label";
      stateLabel.textContent = terminalState.stateLabel;

      item.appendChild(handle);
      item.appendChild(checkbox);
      item.appendChild(statusDot);
      item.appendChild(name);
      item.appendChild(meta);
      item.appendChild(stateLabel);

      if (!options.dragEnabled) {
        return item;
      }

      item.classList.add("drag-enabled");
      item.draggable = true;

      item.addEventListener("dragstart", (event) => {
        if (dragHandleKey !== terminal.key) {
          event.preventDefault();
          return;
        }
        draggingKey = terminal.key;
        item.classList.add("dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", terminal.key);
        }
      });

      item.addEventListener("dragover", (event) => {
        if (!draggingKey || draggingKey === terminal.key) {
          return;
        }
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        const placeAfter = event.clientY - rect.top > rect.height / 2;
        clearDropMarkers();
        item.classList.add(placeAfter ? "drop-after" : "drop-before");
      });

      item.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!draggingKey || draggingKey === terminal.key) {
          return;
        }
        const rect = item.getBoundingClientRect();
        const placeAfter = event.clientY - rect.top > rect.height / 2;
        const nextOrder = reorderCustomOrder(draggingKey, terminal.key, placeAfter);
        if (!nextOrder) {
          return;
        }

        state.viewPreferences.customOrder = nextOrder;
        draggingKey = "";
        dragHandleKey = "";
        clearDropMarkers();
        renderTerminals();
        saveViewPreferences({ customOrder: nextOrder });
      });

      item.addEventListener("dragend", () => {
        draggingKey = "";
        dragHandleKey = "";
        item.classList.remove("dragging");
        clearDropMarkers();
      });

      return item;
    }

    function toggleGroupSelection(groupTerminals, checked) {
      const selected = new Set(state.selectedKeys);
      groupTerminals.forEach((terminal) => {
        if (checked) {
          selected.add(terminal.key);
        } else {
          selected.delete(terminal.key);
        }
      });
      post({ type: "setSelection", selectedKeys: [...selected] });
    }

    function toggleGroupCollapsed(groupId) {
      const collapsed = new Set(state.viewPreferences.collapsedGroups);
      if (collapsed.has(groupId)) {
        collapsed.delete(groupId);
      } else {
        collapsed.add(groupId);
      }
      saveViewPreferences({ collapsedGroups: [...collapsed] });
    }

    function renderGroupedTerminals(sortedTerminals, selected) {
      const collapsed = new Set(state.viewPreferences.collapsedGroups);
      const groups = getGroupedTerminals(sortedTerminals);

      groups.forEach((group) => {
        const wrapper = document.createElement("div");
        wrapper.className = "group";

        if (collapsed.has(group.id)) {
          wrapper.classList.add("collapsed");
        }

        const header = document.createElement("div");
        header.className = "group-header";

        const toggle = document.createElement("button");
        toggle.className = "group-toggle";
        toggle.type = "button";
        const isCollapsed = collapsed.has(group.id);
        toggle.textContent = isCollapsed ? "▸" : "▾";
        toggle.title = isCollapsed ? i18n.expandGroup : i18n.collapseGroup;
        toggle.addEventListener("click", () => {
          toggleGroupCollapsed(group.id);
        });

        const groupCheckbox = document.createElement("input");
        groupCheckbox.type = "checkbox";
        const selectedInGroup = group.terminals.filter((item) => selected.has(item.key)).length;
        groupCheckbox.checked = selectedInGroup === group.terminals.length && group.terminals.length > 0;
        groupCheckbox.indeterminate =
          selectedInGroup > 0 && selectedInGroup < group.terminals.length;
        groupCheckbox.addEventListener("change", () => {
          toggleGroupSelection(group.terminals, groupCheckbox.checked);
        });

        const title = document.createElement("span");
        title.className = "group-title";
        title.textContent =
          group.label +
          " (" +
          selectedInGroup +
          "/" +
          group.terminals.length +
          ")";

        header.appendChild(toggle);
        header.appendChild(groupCheckbox);
        header.appendChild(title);

        const items = document.createElement("div");
        items.className = "group-items";

        group.terminals.forEach((terminal) => {
          items.appendChild(
            createTerminalItem(terminal, selected, {
              dragEnabled: false
            })
          );
        });

        wrapper.appendChild(header);
        wrapper.appendChild(items);
        terminalList.appendChild(wrapper);
      });
    }

    function renderFlatTerminals(sortedTerminals, selected) {
      const dragEnabled = isCustomDragEnabled();
      sortedTerminals.forEach((terminal) => {
        terminalList.appendChild(
          createTerminalItem(terminal, selected, {
            dragEnabled
          })
        );
      });
    }

    function renderTerminals() {
      const selected = new Set(state.selectedKeys);
      const sortedTerminals = getSortedTerminals();
      terminalList.innerHTML = "";

      if (state.terminals.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sub";
        empty.textContent = i18n.noTerminalsAvailable;
        terminalList.appendChild(empty);
        selectedCount.textContent = format(i18n.selectedCount, 0, 0);
        dragHint.textContent = "";
        return;
      }

      if (state.viewPreferences.groupMode === "tool-type") {
        renderGroupedTerminals(sortedTerminals, selected);
      } else {
        renderFlatTerminals(sortedTerminals, selected);
      }

      selectedCount.textContent = format(
        i18n.selectedCount,
        state.selectedKeys.length,
        state.terminals.length
      );

      dragHint.textContent = isCustomDragEnabled()
        ? i18n.customDragEnabled
        : i18n.customDragDisabled;
    }

    function setActiveTab(tab) {
      activeTab = tab;
      const isSend = tab === "send";
      const isPolling = tab === "polling";
      const isChain = tab === "chain";

      tabSendBtn.classList.toggle("active", isSend);
      tabPollingBtn.classList.toggle("active", isPolling);
      tabChainBtn.classList.toggle("active", isChain);
      tabSendPanel.classList.toggle("active", isSend);
      tabPollingPanel.classList.toggle("active", isPolling);
      tabChainPanel.classList.toggle("active", isChain);
    }

    function setSettingsPanelVisible(visible) {
      settingsPanelVisible = Boolean(visible);
      settingsPanel.classList.toggle("visible", settingsPanelVisible);
    }

    function renderPanelSettings() {
      panelLanguageSelect.value = state.panelLanguage || "${locale}";
    }

    function renderSettings() {
      autoSelectRegex.value = state.settings.autoSelectRegex || "";
      requireConfirmBeforeBroadcast.checked = Boolean(state.settings.requireConfirmBeforeBroadcast);
      enableSensitiveCommandGuard.checked = Boolean(state.settings.enableSensitiveCommandGuard);
      waveThreshold.value = String(state.settings.waveThreshold);
      waveDelayMs.value = String(state.settings.waveDelayMs);
    }

    function renderViewPreferences() {
      groupModeSelect.value = state.viewPreferences.groupMode;
      sortModeSelect.value = state.viewPreferences.sortMode;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function parseDirectiveFields(content) {
      const fields = new Map();
      const tokens = String(content)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      if (tokens.length === 0) {
        return { errorKey: "chainErrorEmptyDirective" };
      }
      for (const token of tokens) {
        const match = token.match(/^([a-z_]+)\\s*:\\s*(\\d+)$/i);
        if (!match) {
          return { errorKey: "chainErrorInvalidToken" };
        }
        fields.set(match[1].toLowerCase(), Number(match[2]));
      }
      return { fields };
    }

    function lintChainScript(scriptText) {
      const lines = String(scriptText || "").split(/\\r?\\n/);
      const items = [];
      let firstError = null;

      lines.forEach((raw, index) => {
        const lineNo = index + 1;
        const line = raw.trim();

        if (!line) {
          items.push({ lineNo, className: "empty", text: raw || " " });
          return;
        }

        if (line.startsWith("#")) {
          items.push({ lineNo, className: "comment", text: raw });
          return;
        }

        const plainDirective = line.match(/^(wait_ready|wait_idle|delay)\\s*:\\s*(.+)$/i);
        if (plainDirective) {
          const rawValue = plainDirective[2].trim();
          if (!/^\\d+$/.test(rawValue)) {
            const message = i18n.chainErrorDirectiveValue;
            items.push({ lineNo, className: "error", text: raw + "  // " + message });
            if (!firstError) {
              firstError = format(i18n.chainLineError, lineNo, message);
            }
            return;
          }
          items.push({ lineNo, className: "directive", text: raw });
          return;
        }

        if (/^(wait_ready|wait_idle|delay)\\s*:/i.test(line)) {
          const message = i18n.chainErrorDirectiveSyntax;
          items.push({ lineNo, className: "error", text: raw + "  // " + message });
          if (!firstError) {
            firstError = format(i18n.chainLineError, lineNo, message);
          }
          return;
        }

        if (line.startsWith("{") && line.endsWith("}")) {
          const parsed = parseDirectiveFields(line.slice(1, -1));
          if (parsed.errorKey) {
            const message = i18n[parsed.errorKey] || i18n.chainErrorInvalidToken;
            items.push({ lineNo, className: "error", text: raw + "  // " + message });
            if (!firstError) {
              firstError = format(i18n.chainLineError, lineNo, message);
            }
            return;
          }

          const fields = parsed.fields;
          const hasDelay = fields.has("delay");
          const hasWaitReady = fields.has("wait_ready");
          const hasWaitIdle = fields.has("wait_idle");

          if (hasDelay) {
            if (fields.size !== 1) {
              const message = i18n.chainErrorDelayExtra;
              items.push({ lineNo, className: "error", text: raw + "  // " + message });
              if (!firstError) {
                firstError = format(i18n.chainLineError, lineNo, message);
              }
              return;
            }
            items.push({ lineNo, className: "directive", text: raw });
            return;
          }

          if (hasWaitReady || hasWaitIdle) {
            if (hasWaitReady && hasWaitIdle) {
              const message = i18n.chainErrorWaitConflict;
              items.push({ lineNo, className: "error", text: raw + "  // " + message });
              if (!firstError) {
                firstError = format(i18n.chainLineError, lineNo, message);
              }
              return;
            }
            const allowed = new Set(["wait_ready", "wait_idle", "timeout"]);
            const hasExtra = [...fields.keys()].some((key) => !allowed.has(key));
            if (hasExtra) {
              const message = i18n.chainErrorWaitExtra;
              items.push({ lineNo, className: "error", text: raw + "  // " + message });
              if (!firstError) {
                firstError = format(i18n.chainLineError, lineNo, message);
              }
              return;
            }
            if (fields.has("timeout") && Number(fields.get("timeout")) < 1000) {
              const message = i18n.chainErrorTimeoutMin;
              items.push({ lineNo, className: "error", text: raw + "  // " + message });
              if (!firstError) {
                firstError = format(i18n.chainLineError, lineNo, message);
              }
              return;
            }
            items.push({ lineNo, className: "directive", text: raw });
            return;
          }

          const message = i18n.chainErrorUnknownDirective;
          items.push({ lineNo, className: "error", text: raw + "  // " + message });
          if (!firstError) {
            firstError = format(i18n.chainLineError, lineNo, message);
          }
          return;
        }

        items.push({ lineNo, className: "command", text: raw });
      });

      return {
        items,
        error: firstError
      };
    }

    function renderChainPreview() {
      const lint = lintChainScript(chainScriptInput.value);
      chainLintError = lint.error || "";
      chainPreview.innerHTML = lint.items
        .map((item) => {
          return (
            '<div class="chain-preview-line ' +
            item.className +
            '">' +
            '<span class="line-no">' +
            item.lineNo +
            "</span>" +
            '<span class="line-text">' +
            escapeHtml(item.text) +
            "</span>" +
            "</div>"
          );
        })
        .join("");
      chainLintStatus.textContent = chainLintError || i18n.chainPreviewOk;
    }

    function renderAutomationStatus() {
      const polling = state.automation?.polling;
      const chain = state.automation?.chain;

      if (polling) {
        if (polling.error) {
          pollingStatus.textContent = format(i18n.pollingStatusError, polling.error);
        } else if (polling.active) {
          const seconds = Math.max(1, Math.round((polling.intervalMs || 1000) / 1000));
          pollingStatus.textContent = format(
            i18n.pollingStatusRunning,
            seconds,
            polling.lastSentCount || 0
          );
        } else {
          pollingStatus.textContent = i18n.pollingStatusIdle;
        }
        startPollingBtn.disabled = Boolean(polling.active);
        stopPollingBtn.disabled = !polling.active;
      } else {
        pollingStatus.textContent = i18n.pollingStatusIdle;
        startPollingBtn.disabled = false;
        stopPollingBtn.disabled = true;
      }

      if (chain) {
        if (chain.error) {
          chainStatus.textContent = format(i18n.chainStatusError, chain.error);
        } else if (chain.active) {
          chainStatus.textContent = format(
            i18n.chainStatusRunning,
            chain.currentStep || 0,
            chain.totalSteps || 0,
            chain.detail || ""
          );
        } else if (chain.detail === "Completed") {
          chainStatus.textContent = i18n.chainStatusDone;
        } else if (chain.detail === "Stopped") {
          chainStatus.textContent = i18n.chainStatusStopped;
        } else {
          chainStatus.textContent = chainLintError || i18n.chainStatusIdle;
        }
        startChainBtn.disabled = Boolean(chain.active);
        stopChainBtn.disabled = !chain.active;
      } else {
        chainStatus.textContent = chainLintError || i18n.chainStatusIdle;
        startChainBtn.disabled = false;
        stopChainBtn.disabled = true;
      }
    }

    function render() {
      renderViewPreferences();
      renderTerminals();
      renderPanelSettings();
      renderSettings();
      renderChainPreview();
      renderAutomationStatus();
    }

    function sendCurrentText() {
      const text = commandInput.value.trim();
      if (!text) {
        return;
      }
      post({ type: "sendCommand", command: text });
    }

    function startPollingTask() {
      const intervalSeconds = Math.max(1, Number(pollingIntervalSec.value) || 5);
      post({
        type: "startPolling",
        command: pollingCommandInput.value,
        intervalMs: intervalSeconds * 1000
      });
    }

    function startTaskChain() {
      renderChainPreview();
      if (chainLintError) {
        return;
      }
      const timeoutSeconds = Math.max(1, Number(chainWaitTimeoutSec.value) || 300);
      post({
        type: "startTaskChain",
        script: chainScriptInput.value,
        waitTimeoutMs: timeoutSeconds * 1000
      });
    }

    refreshBtn.addEventListener("click", () => post({ type: "refreshTerminals" }));
    selectAllBtn.addEventListener("click", () => post({ type: "selectAll" }));
    clearBtn.addEventListener("click", () => post({ type: "clearSelection" }));
    sendBtn.addEventListener("click", sendCurrentText);
    startPollingBtn.addEventListener("click", startPollingTask);
    stopPollingBtn.addEventListener("click", () => post({ type: "stopPolling" }));
    startChainBtn.addEventListener("click", startTaskChain);
    stopChainBtn.addEventListener("click", () => post({ type: "stopTaskChain" }));
    settingsBtn.addEventListener("click", () => {
      setSettingsPanelVisible(!settingsPanelVisible);
    });
    settingsCloseBtn.addEventListener("click", () => {
      setSettingsPanelVisible(false);
    });
    panelLanguageSelect.addEventListener("change", () => {
      const next = panelLanguageSelect.value === "zh-CN" ? "zh-CN" : "en";
      post({ type: "setPanelLanguage", language: next });
    });
    window.addEventListener("click", (event) => {
      if (!settingsPanelVisible) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (settingsPanel.contains(target) || settingsBtn.contains(target)) {
        return;
      }
      setSettingsPanelVisible(false);
    });

    tabSendBtn.addEventListener("click", () => setActiveTab("send"));
    tabPollingBtn.addEventListener("click", () => setActiveTab("polling"));
    tabChainBtn.addEventListener("click", () => setActiveTab("chain"));

    groupModeSelect.addEventListener("change", () => {
      saveViewPreferences({ groupMode: groupModeSelect.value });
    });

    sortModeSelect.addEventListener("change", () => {
      saveViewPreferences({ sortMode: sortModeSelect.value });
    });

    commandInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        sendCurrentText();
      }
    });
    chainScriptInput.addEventListener("input", () => {
      renderChainPreview();
      renderAutomationStatus();
    });

    autoSelectRegex.addEventListener("change", () => {
      post({ type: "updateSetting", key: "autoSelectRegex", value: autoSelectRegex.value });
    });
    requireConfirmBeforeBroadcast.addEventListener("change", () => {
      post({
        type: "updateSetting",
        key: "requireConfirmBeforeBroadcast",
        value: requireConfirmBeforeBroadcast.checked
      });
    });
    enableSensitiveCommandGuard.addEventListener("change", () => {
      post({
        type: "updateSetting",
        key: "enableSensitiveCommandGuard",
        value: enableSensitiveCommandGuard.checked
      });
    });
    waveThreshold.addEventListener("change", () => {
      post({
        type: "updateSetting",
        key: "waveThreshold",
        value: Math.max(1, Number(waveThreshold.value) || 1)
      });
    });
    waveDelayMs.addEventListener("change", () => {
      post({
        type: "updateSetting",
        key: "waveDelayMs",
        value: Math.max(0, Number(waveDelayMs.value) || 0)
      });
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "state") {
        return;
      }
      state = message;
      render();
    });

    setActiveTab(activeTab);
    post({ type: "requestState" });
  </script>
</body>
</html>`;
  }
}

function toManagedTerminals(descriptors: TerminalDescriptor[]): ManagedTerminal[] {
  const sameNameCounts = new Map<string, number>();
  return descriptors.map((descriptor) => {
    const pid = descriptor.processId ?? -1;
    const base = `${descriptor.name}::${pid}`;
    const order = (sameNameCounts.get(base) ?? 0) + 1;
    sameNameCounts.set(base, order);

    return {
      key: `${base}::${order}`,
      terminal: descriptor.terminal,
      name: descriptor.name,
      processId: descriptor.processId
    };
  });
}

function applyRegexSelection(
  terminals: ManagedTerminal[],
  autoSelectRegex: string
): Set<string> {
  const selected = new Set<string>();
  if (!autoSelectRegex.trim()) {
    return selected;
  }

  try {
    const regex = new RegExp(autoSelectRegex);
    for (const terminal of terminals) {
      if (regex.test(terminal.name)) {
        selected.add(terminal.key);
      }
    }
  } catch {
    return selected;
  }

  return selected;
}

function isEditableSettingKey(value: string): value is EditableSettingKey {
  return (
    value === "autoSelectRegex" ||
    value === "requireConfirmBeforeBroadcast" ||
    value === "enableSensitiveCommandGuard" ||
    value === "waveThreshold" ||
    value === "waveDelayMs"
  );
}

function normalizeSettingValue(
  key: EditableSettingKey,
  value: string | number | boolean
): string | number | boolean | undefined {
  switch (key) {
    case "autoSelectRegex":
      return String(value);
    case "requireConfirmBeforeBroadcast":
    case "enableSensitiveCommandGuard":
      return Boolean(value);
    case "waveThreshold": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      return Math.max(1, Math.round(parsed));
    }
    case "waveDelayMs": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      return Math.max(0, Math.round(parsed));
    }
    default:
      return undefined;
  }
}

function createDefaultViewPreferences(): ViewPreferences {
  return {
    sortMode: "custom",
    groupMode: "none",
    customOrder: [],
    collapsedGroups: []
  };
}

function sanitizeViewPreferences(rawValue: unknown): ViewPreferences {
  const defaults = createDefaultViewPreferences();

  if (!rawValue || typeof rawValue !== "object") {
    return defaults;
  }

  const source = rawValue as Partial<ViewPreferences>;
  const sortMode = isSortMode(source.sortMode) ? source.sortMode : defaults.sortMode;
  const groupMode = isGroupMode(source.groupMode)
    ? source.groupMode
    : defaults.groupMode;

  return {
    sortMode,
    groupMode,
    customOrder: toStringArray(source.customOrder),
    collapsedGroups: toStringArray(source.collapsedGroups)
  };
}

function mergeViewPreferences(
  current: ViewPreferences,
  patch: ViewPreferencesPatch | undefined,
  terminalKeys: string[]
): ViewPreferences {
  const base = sanitizeViewPreferences(current);

  const sortMode = isSortMode(patch?.sortMode) ? patch.sortMode : base.sortMode;
  const groupMode = isGroupMode(patch?.groupMode) ? patch.groupMode : base.groupMode;

  const nextCustomOrder = normalizeCustomOrder(
    patch?.customOrder ?? base.customOrder,
    terminalKeys
  );
  const nextCollapsedGroups = normalizeCollapsedGroups(
    patch?.collapsedGroups ?? base.collapsedGroups
  );

  return {
    sortMode,
    groupMode,
    customOrder: nextCustomOrder,
    collapsedGroups: nextCollapsedGroups
  };
}

function normalizeCustomOrder(order: string[], terminalKeys: string[]): string[] {
  const keySet = new Set(terminalKeys);
  const added = new Set<string>();
  const normalized: string[] = [];

  for (const key of order) {
    if (!keySet.has(key) || added.has(key)) {
      continue;
    }
    added.add(key);
    normalized.push(key);
  }

  for (const key of terminalKeys) {
    if (!added.has(key)) {
      added.add(key);
      normalized.push(key);
    }
  }

  return normalized;
}

function normalizeCollapsedGroups(groups: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of groups) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function areViewPreferencesEqual(a: ViewPreferences, b: ViewPreferences): boolean {
  return (
    a.sortMode === b.sortMode &&
    a.groupMode === b.groupMode &&
    areStringArraysEqual(a.customOrder, b.customOrder) &&
    areStringArraysEqual(a.collapsedGroups, b.collapsedGroups)
  );
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function isSortMode(value: unknown): value is SortMode {
  return (
    value === "custom" ||
    value === "name-asc" ||
    value === "name-desc" ||
    value === "pid-asc" ||
    value === "pid-desc" ||
    value === "selected-first"
  );
}

function isGroupMode(value: unknown): value is GroupMode {
  return value === "none" || value === "tool-type";
}

function getNonce(): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 24; i += 1) {
    nonce += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return nonce;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}

function isPanelLanguage(value: unknown): value is PanelLanguage {
  return value === "en" || value === "zh-CN";
}

function formatL10nMessage(template: string, args: string[]): string {
  return template.replace(/\{(\d+)\}/g, (_, index) => {
    const value = args[Number(index)];
    return value === undefined ? "" : String(value);
  });
}
