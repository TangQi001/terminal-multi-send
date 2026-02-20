import * as vscode from "vscode";

const CONFIG_NAMESPACE = "cursorTerminalNexus";
const CLI_PROMPTS_KEY = "cliPrompts";
const BUFFER_SIZE = 220;
const EVALUATE_DELAY_MS = 80;
const CLI_QUIET_TO_WAIT_MS = 650;
const CLI_STARTUP_WAIT_MS = 1500;

const DEFAULT_CLI_PROMPT_PATTERNS = [
  String.raw`(?:^|\n)\s*(?:codex|claude(?:\s+code)?|qwen|gemini)?\s*(?:>|❯|›|»|\$)\s*$`,
  String.raw`(?:^|\n)\s*(?:You|Input)\s*:\s*$`,
  String.raw`(?:^|\n)[^\n]{0,80}(?:❯|›|»)\s*$`
];

export enum TerminalState {
  IDLE = "IDLE",
  RUNNING_PROGRAM = "RUNNING_PROGRAM",
  CLI_WAITING = "CLI_WAITING",
  CLI_THINKING = "CLI_THINKING"
}

export interface TerminalStateChangeEvent {
  terminal: vscode.Terminal;
  state: TerminalState;
}

interface TerminalTracker {
  state: TerminalState;
  buffer: string;
  pendingThinkingSignal: boolean;
  executionVersion: number;
  isInteractiveCli: boolean;
  lastOutputAt: number;
  evaluateTimer?: NodeJS.Timeout;
  quietTimer?: NodeJS.Timeout;
}

export class TerminalStateManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly trackers = new Map<vscode.Terminal, TerminalTracker>();
  private readonly stateChangeEmitter = new vscode.EventEmitter<TerminalStateChangeEvent>();

  private promptRegexes: RegExp[] = compilePromptRegexes(DEFAULT_CLI_PROMPT_PATTERNS);

  public readonly onDidChangeState = this.stateChangeEmitter.event;

  constructor() {
    this.reloadPromptRegexes();

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        this.handleExecutionStart(event.terminal, event.execution);
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.handleExecutionEnd(event.terminal);
      }),
      vscode.window.onDidOpenTerminal((terminal) => {
        this.getOrCreateTracker(terminal);
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.deleteTracker(terminal);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${CONFIG_NAMESPACE}.${CLI_PROMPTS_KEY}`)) {
          this.reloadPromptRegexes();
        }
      })
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    for (const tracker of this.trackers.values()) {
      this.clearTimer(tracker.evaluateTimer);
      this.clearTimer(tracker.quietTimer);
    }
    this.trackers.clear();
    this.stateChangeEmitter.dispose();
  }

  public getState(terminal: vscode.Terminal): TerminalState {
    const tracker = this.trackers.get(terminal);
    return tracker?.state ?? TerminalState.IDLE;
  }

  public isReadyForBroadcast(terminal: vscode.Terminal): boolean {
    return isReadyState(this.getState(terminal));
  }

  public isInteractiveCliSession(terminal: vscode.Terminal): boolean {
    const tracker = this.trackers.get(terminal);
    return tracker?.isInteractiveCli ?? false;
  }

  public notifyInputSent(terminal: vscode.Terminal): void {
    const tracker = this.getOrCreateTracker(terminal);
    if (
      tracker.state === TerminalState.CLI_WAITING ||
      tracker.state === TerminalState.RUNNING_PROGRAM
    ) {
      this.setState(terminal, tracker, TerminalState.CLI_THINKING);
      this.scheduleQuietProbe(
        terminal,
        tracker,
        tracker.executionVersion,
        CLI_QUIET_TO_WAIT_MS
      );
    }
  }

  private handleExecutionStart(
    terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution
  ): void {
    const tracker = this.getOrCreateTracker(terminal);
    tracker.executionVersion += 1;
    tracker.buffer = "";
    tracker.pendingThinkingSignal = false;
    tracker.isInteractiveCli = looksLikeInteractiveCliCommand(
      execution.commandLine.value,
      terminal.name
    );
    tracker.lastOutputAt = Date.now();
    this.clearTimer(tracker.quietTimer);
    tracker.quietTimer = undefined;
    this.setState(terminal, tracker, TerminalState.RUNNING_PROGRAM);
    if (tracker.isInteractiveCli) {
      this.scheduleQuietProbe(
        terminal,
        tracker,
        tracker.executionVersion,
        CLI_STARTUP_WAIT_MS
      );
    }

    void this.consumeExecutionStream(terminal, execution, tracker.executionVersion);
  }

  private handleExecutionEnd(terminal: vscode.Terminal): void {
    const tracker = this.getOrCreateTracker(terminal);
    tracker.executionVersion += 1;
    tracker.buffer = "";
    tracker.pendingThinkingSignal = false;
    tracker.isInteractiveCli = false;
    tracker.lastOutputAt = 0;
    this.clearTimer(tracker.evaluateTimer);
    tracker.evaluateTimer = undefined;
    this.clearTimer(tracker.quietTimer);
    tracker.quietTimer = undefined;
    this.setState(terminal, tracker, TerminalState.IDLE);
  }

  private async consumeExecutionStream(
    terminal: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
    executionVersion: number
  ): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        const tracker = this.trackers.get(terminal);
        if (!tracker || tracker.executionVersion !== executionVersion) {
          return;
        }
        this.handleDataChunk(terminal, chunk);
      }
    } catch {
      // Ignore stream errors. Shell end event will reset the tracker.
    }
  }

  private handleDataChunk(terminal: vscode.Terminal, chunk: string): void {
    const tracker = this.getOrCreateTracker(terminal);
    const cleaned = sanitizeTerminalData(chunk);
    if (!cleaned) {
      return;
    }

    tracker.lastOutputAt = Date.now();
    tracker.buffer = (tracker.buffer + cleaned).slice(-BUFFER_SIZE);
    const hasMeaningful = hasMeaningfulOutput(cleaned);
    if (tracker.state === TerminalState.CLI_WAITING) {
      tracker.pendingThinkingSignal ||= indicatesThinkingSignal(cleaned, hasMeaningful);
    } else {
      tracker.pendingThinkingSignal ||= hasMeaningful;
    }
    if (tracker.isInteractiveCli) {
      this.scheduleQuietProbe(
        terminal,
        tracker,
        tracker.executionVersion,
        CLI_QUIET_TO_WAIT_MS
      );
    }

    if (tracker.evaluateTimer) {
      return;
    }

    tracker.evaluateTimer = setTimeout(() => {
      tracker.evaluateTimer = undefined;
      this.evaluateTracker(terminal, tracker);
    }, EVALUATE_DELAY_MS);
  }

  private evaluateTracker(terminal: vscode.Terminal, tracker: TerminalTracker): void {
    const isPrompt = this.promptRegexes.some((regex) => regex.test(tracker.buffer));

    if (isPrompt) {
      tracker.pendingThinkingSignal = false;
      if (
        tracker.state === TerminalState.RUNNING_PROGRAM ||
        tracker.state === TerminalState.CLI_THINKING
      ) {
        this.setState(terminal, tracker, TerminalState.CLI_WAITING);
      }
      return;
    }

    if (tracker.state === TerminalState.CLI_WAITING && tracker.pendingThinkingSignal) {
      tracker.pendingThinkingSignal = false;
      this.setState(terminal, tracker, TerminalState.CLI_THINKING);
      return;
    }

    if (
      tracker.state === TerminalState.RUNNING_PROGRAM &&
      tracker.isInteractiveCli &&
      tracker.pendingThinkingSignal
    ) {
      tracker.pendingThinkingSignal = false;
      this.setState(terminal, tracker, TerminalState.CLI_THINKING);
      return;
    }

    tracker.pendingThinkingSignal = false;
  }

  private setState(
    terminal: vscode.Terminal,
    tracker: TerminalTracker,
    nextState: TerminalState
  ): void {
    if (tracker.state === nextState) {
      return;
    }
    tracker.state = nextState;
    this.stateChangeEmitter.fire({ terminal, state: nextState });
  }

  private scheduleQuietProbe(
    terminal: vscode.Terminal,
    tracker: TerminalTracker,
    executionVersion: number,
    delayMs: number
  ): void {
    this.clearTimer(tracker.quietTimer);
    tracker.quietTimer = setTimeout(() => {
      const latest = this.trackers.get(terminal);
      if (!latest || latest.executionVersion !== executionVersion || !latest.isInteractiveCli) {
        return;
      }
      const elapsed = Date.now() - latest.lastOutputAt;
      if (
        elapsed >= delayMs &&
        (latest.state === TerminalState.RUNNING_PROGRAM ||
          latest.state === TerminalState.CLI_THINKING)
      ) {
        this.setState(terminal, latest, TerminalState.CLI_WAITING);
      }
    }, delayMs);
  }

  private getOrCreateTracker(terminal: vscode.Terminal): TerminalTracker {
    const existing = this.trackers.get(terminal);
    if (existing) {
      return existing;
    }

    const tracker: TerminalTracker = {
      state: TerminalState.IDLE,
      buffer: "",
      pendingThinkingSignal: false,
      executionVersion: 0,
      isInteractiveCli: false,
      lastOutputAt: 0
    };

    this.trackers.set(terminal, tracker);
    return tracker;
  }

  private deleteTracker(terminal: vscode.Terminal): void {
    const tracker = this.trackers.get(terminal);
    if (!tracker) {
      return;
    }

    this.clearTimer(tracker.evaluateTimer);
    this.clearTimer(tracker.quietTimer);
    this.trackers.delete(terminal);
  }

  private clearTimer(timer: NodeJS.Timeout | undefined): void {
    if (timer) {
      clearTimeout(timer);
    }
  }

  private reloadPromptRegexes(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const configured = config.get<string[]>(
      CLI_PROMPTS_KEY,
      DEFAULT_CLI_PROMPT_PATTERNS
    );
    const candidatePatterns = Array.isArray(configured)
      ? configured.filter((item): item is string => typeof item === "string")
      : [];

    const compiled = compilePromptRegexes(candidatePatterns);
    this.promptRegexes =
      compiled.length > 0
        ? compiled
        : compilePromptRegexes(DEFAULT_CLI_PROMPT_PATTERNS);
  }
}

export function isReadyState(state: TerminalState): boolean {
  return state === TerminalState.IDLE || state === TerminalState.CLI_WAITING;
}

function sanitizeTerminalData(input: string): string {
  if (!input) {
    return "";
  }

  return input
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function hasMeaningfulOutput(text: string): boolean {
  const normalized = text.replace(/\s+/g, "");
  if (!normalized) {
    return false;
  }
  return !/^[>❯›$:?]+$/.test(normalized);
}

function indicatesThinkingSignal(text: string, hasMeaningful: boolean): boolean {
  if (!hasMeaningful) {
    return false;
  }

  if (text.includes("\n")) {
    return true;
  }

  const normalized = text.replace(/\s+/g, "");
  if (normalized.length >= 18) {
    return true;
  }

  return /(?:thinking|generating|analyzing|processing|writing|response|error|warning)/i.test(
    text
  );
}

function looksLikeInteractiveCliCommand(commandLine: string, terminalName: string): boolean {
  const raw = `${commandLine || ""} ${terminalName || ""}`.toLowerCase();
  return /\b(codex|claude(?:\s+code)?|qwen|gemini|aider)\b/.test(raw);
}

function compilePromptRegexes(patterns: string[]): RegExp[] {
  const result: RegExp[] = [];
  for (const pattern of patterns) {
    const compiled = compilePromptRegex(pattern);
    if (compiled) {
      result.push(compiled);
    }
  }
  return result;
}

function compilePromptRegex(pattern: string): RegExp | undefined {
  const raw = String(pattern ?? "").trim();
  if (!raw) {
    return undefined;
  }

  const slashMatch = raw.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashMatch) {
    const source = slashMatch[1];
    const flags = normalizeRegexFlags(slashMatch[2]);
    try {
      return new RegExp(source, flags);
    } catch {
      return undefined;
    }
  }

  try {
    return new RegExp(raw, "m");
  } catch {
    return undefined;
  }
}

function normalizeRegexFlags(rawFlags: string): string {
  const source = `${rawFlags || ""}m`;
  const deduped: string[] = [];
  for (const char of source) {
    if ((char === "g" || char === "y") || deduped.includes(char)) {
      continue;
    }
    deduped.push(char);
  }
  return deduped.join("");
}
