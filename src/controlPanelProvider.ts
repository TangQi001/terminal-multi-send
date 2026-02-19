import * as vscode from "vscode";
import { Broadcaster } from "./broadcaster";
import {
  EditableSettingKey,
  readNexusConfig,
  updateNexusSetting
} from "./config";
import { QuickCommands } from "./quickCommands";
import { TerminalDescriptor, TerminalManager } from "./terminalManager";

interface ManagedTerminal {
  key: string;
  terminal: vscode.Terminal;
  name: string;
  processId?: number;
}

type ViewMessage =
  | { type: "requestState" }
  | { type: "refreshTerminals" }
  | { type: "selectAll" }
  | { type: "clearSelection" }
  | { type: "setSelection"; selectedKeys: string[] }
  | { type: "sendCommand"; command: string }
  | { type: "updateSetting"; key: string; value: string | number | boolean };

export class ControlPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "cursorTerminalNexus.controlPanel";

  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private terminals: ManagedTerminal[] = [];
  private selectedKeys = new Set<string>();
  private refreshNonce = 0;

  constructor(
    private readonly terminalManager: TerminalManager,
    private readonly quickCommands: QuickCommands,
    private readonly broadcaster: Broadcaster
  ) {
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
      })
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
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
    const availableKeys = new Set(this.terminals.map((item) => item.key));
    this.selectedKeys = new Set(
      [...this.selectedKeys].filter((key) => availableKeys.has(key))
    );

    if (this.selectedKeys.size === 0) {
      this.selectedKeys = applyRegexSelection(this.terminals, readNexusConfig().autoSelectRegex);
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
        processId: item.processId
      })),
      selectedKeys: [...this.selectedKeys],
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

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const locale = /^zh(-|$)/i.test(vscode.env.language) ? "zh-CN" : "en";
    const i18n = {
      title: vscode.l10n.t("Terminal Nexus"),
      refresh: vscode.l10n.t("Refresh"),
      selectAll: vscode.l10n.t("Select All"),
      clear: vscode.l10n.t("Clear"),
      selectedCount: vscode.l10n.t("Selected {0} / {1}"),
      command: vscode.l10n.t("Command"),
      sendShortcut: vscode.l10n.t("Ctrl/Cmd + Enter to send"),
      commandInputPlaceholder: vscode.l10n.t("Enter text or command to broadcast"),
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
      unknown: vscode.l10n.t("Unknown")
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
      min-width: 90px;
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
    input[type="text"], input[type="number"], textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 5px 7px;
      font-size: 12px;
    }
    textarea {
      min-height: 72px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .terminal-list {
      max-height: 220px;
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
      padding: 2px 0;
    }
    .terminal-meta {
      color: var(--muted);
      font-size: 11px;
    }
    .sub {
      color: var(--muted);
      font-size: 11px;
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
    <div id="terminalList" class="terminal-list"></div>
  </div>

  <div class="block">
    <div class="row">
      <span class="label">${i18n.command}</span>
      <span class="sub">${i18n.sendShortcut}</span>
    </div>
    <textarea id="commandInput" placeholder="${i18n.commandInputPlaceholder}"></textarea>
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
    let state = {
      terminals: [],
      selectedKeys: [],
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

    const terminalList = document.getElementById("terminalList");
    const selectedCount = document.getElementById("selectedCount");
    const commandInput = document.getElementById("commandInput");
    const refreshBtn = document.getElementById("refreshBtn");
    const selectAllBtn = document.getElementById("selectAllBtn");
    const clearBtn = document.getElementById("clearBtn");
    const sendBtn = document.getElementById("sendBtn");

    const autoSendEnabled = document.getElementById("autoSendEnabled");
    const autoSendDelayMs = document.getElementById("autoSendDelayMs");
    const autoSelectRegex = document.getElementById("autoSelectRegex");
    const requireConfirmBeforeBroadcast = document.getElementById("requireConfirmBeforeBroadcast");
    const enableSensitiveCommandGuard = document.getElementById("enableSensitiveCommandGuard");
    const waveThreshold = document.getElementById("waveThreshold");
    const waveDelayMs = document.getElementById("waveDelayMs");

    function format(message, ...args) {
      return message.replace(/\\{(\\d+)\\}/g, (_, index) => {
        const value = args[Number(index)];
        return value === undefined ? "" : String(value);
      });
    }

    function post(message) {
      vscode.postMessage(message);
    }

    function getSelectedKeysFromDom() {
      const selected = [];
      const checkboxes = terminalList.querySelectorAll("input[data-terminal-key]");
      checkboxes.forEach((checkbox) => {
        if (checkbox.checked) {
          selected.push(checkbox.getAttribute("data-terminal-key"));
        }
      });
      return selected;
    }

    function syncSelectionFromDom() {
      post({ type: "setSelection", selectedKeys: getSelectedKeysFromDom() });
    }

    function renderTerminals() {
      const selected = new Set(state.selectedKeys);
      terminalList.innerHTML = "";

      if (state.terminals.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sub";
        empty.textContent = i18n.noTerminalsAvailable;
        terminalList.appendChild(empty);
        selectedCount.textContent = format(i18n.selectedCount, 0, 0);
        return;
      }

      state.terminals.forEach((terminal) => {
        const wrapper = document.createElement("label");
        wrapper.className = "terminal-item";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("data-terminal-key", terminal.key);
        checkbox.checked = selected.has(terminal.key);
        checkbox.addEventListener("change", syncSelectionFromDom);

        const text = document.createElement("span");
        text.textContent = terminal.name;

        const meta = document.createElement("span");
        meta.className = "terminal-meta";
        meta.textContent = terminal.processId
          ? "(PID: " + terminal.processId + ")"
          : "(PID: " + i18n.unknown + ")";

        wrapper.appendChild(checkbox);
        wrapper.appendChild(text);
        wrapper.appendChild(meta);
        terminalList.appendChild(wrapper);
      });

      selectedCount.textContent = format(
        i18n.selectedCount,
        state.selectedKeys.length,
        state.terminals.length
      );
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

    function render() {
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

function getNonce(): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 24; i += 1) {
    nonce += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return nonce;
}
