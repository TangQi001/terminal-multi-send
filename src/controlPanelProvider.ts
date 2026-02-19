import * as vscode from "vscode";
import { Broadcaster } from "./broadcaster";
import {
  EditableSettingKey,
  readNexusConfig,
  updateNexusSetting
} from "./config";
import { QuickCommands } from "./quickCommands";
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
  | { type: "updateSetting"; key: string; value: string | number | boolean }
  | { type: "updateViewPreferences"; payload: ViewPreferencesPatch };

export class ControlPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "cursorTerminalNexus.controlPanel";

  private static readonly viewPreferencesStateKey =
    "cursorTerminalNexus.controlPanel.viewPreferences";

  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private terminals: ManagedTerminal[] = [];
  private selectedKeys = new Set<string>();
  private refreshNonce = 0;
  private viewPreferences: ViewPreferences;
  private postStateTimer?: NodeJS.Timeout;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly terminalStateManager: TerminalStateManager,
    private readonly quickCommands: QuickCommands,
    private readonly broadcaster: Broadcaster
  ) {
    this.viewPreferences = sanitizeViewPreferences(
      this.extensionContext.workspaceState.get(
        ControlPanelProvider.viewPreferencesStateKey
      )
    );

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
      })
    );
  }

  public dispose(): void {
    if (this.postStateTimer) {
      clearTimeout(this.postStateTimer);
      this.postStateTimer = undefined;
    }
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
        autoSendEnabled: config.autoSendEnabled,
        autoSendDelayMs: config.autoSendDelayMs,
        requireConfirmBeforeBroadcast: config.options.requireConfirmBeforeBroadcast,
        enableSensitiveCommandGuard: config.options.enableSensitiveCommandGuard,
        waveThreshold: config.options.waveThreshold,
        waveDelayMs: config.options.waveDelayMs
      }
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
      readNexusConfig().options
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

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const locale = /^zh(-|$)/i.test(vscode.env.language) ? "zh-CN" : "en";
    const i18n = {
      title: vscode.l10n.t("TQ Terminal Nexus"),
      refresh: vscode.l10n.t("Refresh"),
      selectAll: vscode.l10n.t("Select All"),
      clear: vscode.l10n.t("Clear"),
      selectedCount: vscode.l10n.t("Selected {0} / {1}"),
      groupBy: vscode.l10n.t("Group By"),
      groupNone: vscode.l10n.t("No Grouping"),
      groupToolType: vscode.l10n.t("Tool Type"),
      sortBy: vscode.l10n.t("Sort By"),
      sortCustom: vscode.l10n.t("Custom Order"),
      sortNameAsc: vscode.l10n.t("Name A-Z"),
      sortNameDesc: vscode.l10n.t("Name Z-A"),
      sortPidAsc: vscode.l10n.t("PID Asc"),
      sortPidDesc: vscode.l10n.t("PID Desc"),
      sortSelectedFirst: vscode.l10n.t("Selected First"),
      customDragEnabled: vscode.l10n.t("Drag items to customize order."),
      customDragDisabled: vscode.l10n.t(
        "Drag reorder is available only in No Grouping + Custom Order mode."
      ),
      collapseGroup: vscode.l10n.t("Collapse group"),
      expandGroup: vscode.l10n.t("Expand group"),
      dragHandle: vscode.l10n.t("Drag to reorder"),
      groupBasic: vscode.l10n.t("Basic Terminal"),
      groupSecurity: vscode.l10n.t("Security"),
      groupNetwork: vscode.l10n.t("Network"),
      groupDevOps: vscode.l10n.t("DevOps"),
      groupData: vscode.l10n.t("Data"),
      groupOther: vscode.l10n.t("Other"),
      command: vscode.l10n.t("Command"),
      sendShortcut: vscode.l10n.t("Ctrl/Cmd + Enter to send"),
      commandInputPlaceholder: vscode.l10n.t("Enter text or command to broadcast"),
      commandPlaceholderHelp: vscode.l10n.t(
        "Placeholders: {name}, {index}, quoted name: {name:quoted}"
      ),
      sendToSelectedTerminals: vscode.l10n.t("Send to Selected Terminals"),
      autoSend: vscode.l10n.t("Auto Send"),
      autoSendDescription: vscode.l10n.t("Send automatically after input"),
      autoSendDelay: vscode.l10n.t("Auto-send Delay"),
      autoSelectRegex: vscode.l10n.t("Auto-select Regex"),
      autoSelectRegexPlaceholder: vscode.l10n.t("e.g. Agent.*"),
      confirmBeforeBroadcast: vscode.l10n.t("Confirm Before Send"),
      sensitiveCommandGuard: vscode.l10n.t("Sensitive Command Guard"),
      enabled: vscode.l10n.t("Enabled"),
      waveThreshold: vscode.l10n.t("Wave Threshold"),
      waveDelay: vscode.l10n.t("Wave Delay"),
      noTerminalsAvailable: vscode.l10n.t("No terminals available."),
      pidWithValue: vscode.l10n.t("PID: {0}"),
      pidUnknown: vscode.l10n.t("PID: Unknown"),
      stateIdle: vscode.l10n.t("Idle"),
      stateRunningProgram: vscode.l10n.t("Running Program"),
      stateCliWaiting: vscode.l10n.t("CLI Waiting"),
      stateCliThinking: vscode.l10n.t("CLI Thinking"),
      statusReady: vscode.l10n.t("Ready"),
      statusBusy: vscode.l10n.t("Busy")
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
  </style>
</head>
<body>
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
    </div>
    <div id="dragHint" class="sub"></div>
    <div id="terminalList" class="terminal-list"></div>
  </div>

  <div class="block">
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

  <div class="block">
    <div class="row">
      <span class="label">${i18n.autoSend}</span>
      <label><input type="checkbox" id="autoSendEnabled" /> ${i18n.autoSendDescription}</label>
    </div>
    <div class="row">
      <span class="label">${i18n.autoSendDelay}</span>
      <input id="autoSendDelayMs" type="number" min="200" step="100" />
      <span class="sub">ms</span>
    </div>
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
        autoSendEnabled: false,
        autoSendDelayMs: 800,
        requireConfirmBeforeBroadcast: false,
        enableSensitiveCommandGuard: true,
        waveThreshold: 20,
        waveDelayMs: 20
      }
    };

    let autoSendTimer;
    let lastAutoSent = "";
    let draggingKey = "";
    let dragHandleKey = "";

    const collator = new Intl.Collator(document.documentElement.lang || undefined, {
      numeric: true,
      sensitivity: "base"
    });

    const terminalList = document.getElementById("terminalList");
    const selectedCount = document.getElementById("selectedCount");
    const commandInput = document.getElementById("commandInput");
    const refreshBtn = document.getElementById("refreshBtn");
    const selectAllBtn = document.getElementById("selectAllBtn");
    const clearBtn = document.getElementById("clearBtn");
    const sendBtn = document.getElementById("sendBtn");
    const groupModeSelect = document.getElementById("groupModeSelect");
    const sortModeSelect = document.getElementById("sortModeSelect");
    const dragHint = document.getElementById("dragHint");

    const autoSendEnabled = document.getElementById("autoSendEnabled");
    const autoSendDelayMs = document.getElementById("autoSendDelayMs");
    const autoSelectRegex = document.getElementById("autoSelectRegex");
    const requireConfirmBeforeBroadcast = document.getElementById("requireConfirmBeforeBroadcast");
    const enableSensitiveCommandGuard = document.getElementById("enableSensitiveCommandGuard");
    const waveThreshold = document.getElementById("waveThreshold");
    const waveDelayMs = document.getElementById("waveDelayMs");

    function format(message, ...args) {
      return message.replace(/\{(\d+)\}/g, (_, index) => {
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

    function renderSettings() {
      autoSendEnabled.checked = Boolean(state.settings.autoSendEnabled);
      autoSendDelayMs.value = String(state.settings.autoSendDelayMs);
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

    function render() {
      renderViewPreferences();
      renderTerminals();
      renderSettings();
    }

    function sendCurrentText() {
      const text = commandInput.value.trim();
      if (!text) {
        return;
      }
      lastAutoSent = text;
      post({ type: "sendCommand", command: text });
    }

    function scheduleAutoSend() {
      if (!autoSendEnabled.checked) {
        return;
      }
      const raw = commandInput.value.trim();
      if (!raw) {
        return;
      }

      const delay = Math.max(200, Number(autoSendDelayMs.value) || 800);
      clearTimeout(autoSendTimer);
      autoSendTimer = setTimeout(() => {
        const latest = commandInput.value.trim();
        if (!latest || latest === lastAutoSent) {
          return;
        }
        lastAutoSent = latest;
        post({ type: "sendCommand", command: latest });
      }, delay);
    }

    refreshBtn.addEventListener("click", () => post({ type: "refreshTerminals" }));
    selectAllBtn.addEventListener("click", () => post({ type: "selectAll" }));
    clearBtn.addEventListener("click", () => post({ type: "clearSelection" }));
    sendBtn.addEventListener("click", sendCurrentText);

    groupModeSelect.addEventListener("change", () => {
      saveViewPreferences({ groupMode: groupModeSelect.value });
    });

    sortModeSelect.addEventListener("change", () => {
      saveViewPreferences({ sortMode: sortModeSelect.value });
    });

    commandInput.addEventListener("input", scheduleAutoSend);
    commandInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        sendCurrentText();
      }
    });

    autoSendEnabled.addEventListener("change", () => {
      post({ type: "updateSetting", key: "autoSendEnabled", value: autoSendEnabled.checked });
    });
    autoSendDelayMs.addEventListener("change", () => {
      post({
        type: "updateSetting",
        key: "autoSendDelayMs",
        value: Math.max(200, Number(autoSendDelayMs.value) || 800)
      });
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
    value === "autoSendEnabled" ||
    value === "autoSendDelayMs" ||
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
    case "autoSendEnabled":
    case "requireConfirmBeforeBroadcast":
    case "enableSensitiveCommandGuard":
      return Boolean(value);
    case "autoSendDelayMs": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      return Math.max(200, Math.round(parsed));
    }
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
