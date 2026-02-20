import * as vscode from "vscode";
import { Broadcaster, BroadcastOptions } from "./broadcaster";
import { isReadyState, TerminalStateManager } from "./terminalStateManager";

const READY_PROBE_INTERVAL_MS = 200;

export interface PollingStatus {
  active: boolean;
  command: string;
  intervalMs: number;
  targetCount: number;
  lastRunAt?: number;
  lastSentCount: number;
  error: string;
}

export interface ChainStatus {
  active: boolean;
  currentStep: number;
  totalSteps: number;
  targetCount: number;
  detail: string;
  error: string;
}

export interface AutomationStatus {
  polling: PollingStatus;
  chain: ChainStatus;
}

export type ChainStep =
  | { kind: "command"; command: string; sourceLine: number }
  | { kind: "delay"; delayMs: number; sourceLine: number }
  | {
      kind: "waitReady";
      stableMs: number;
      timeoutMs?: number;
      sourceLine: number;
    };

export class TaskAutomationManager implements vscode.Disposable {
  private pollingTimer?: NodeJS.Timeout;
  private pollingRunId = 0;
  private pollingBusy = false;

  private chainRunId = 0;

  private status: AutomationStatus = {
    polling: {
      active: false,
      command: "",
      intervalMs: 5000,
      targetCount: 0,
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
  };

  private readonly statusEmitter = new vscode.EventEmitter<AutomationStatus>();
  public readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    private readonly terminalStateManager: TerminalStateManager,
    private readonly broadcaster: Broadcaster
  ) {}

  public dispose(): void {
    this.stopPolling();
    this.stopChain();
    this.statusEmitter.dispose();
  }

  public getStatus(): AutomationStatus {
    return this.status;
  }

  public startPolling(
    terminals: vscode.Terminal[],
    command: string,
    intervalMs: number,
    options: BroadcastOptions
  ): void {
    const text = command.trim();
    if (!text) {
      throw new Error("Polling command cannot be empty.");
    }

    const targets = dedupeTerminals(terminals);
    if (targets.length === 0) {
      throw new Error("Select at least one target terminal first.");
    }

    const normalizedInterval = Math.max(500, Math.round(intervalMs));
    this.stopPolling();

    const runId = ++this.pollingRunId;
    this.status = {
      ...this.status,
      polling: {
        active: true,
        command: text,
        intervalMs: normalizedInterval,
        targetCount: targets.length,
        lastSentCount: 0,
        error: ""
      }
    };
    this.emitStatus();

    const tick = async () => {
      if (!this.isPollingRunActive(runId) || this.pollingBusy) {
        return;
      }

      this.pollingBusy = true;
      try {
        const activeTargets = getOpenTerminals(targets);
        if (activeTargets.length === 0) {
          throw new Error("All polling targets are closed.");
        }

        const sentCount = await this.broadcaster.broadcastNonInteractive(
          activeTargets,
          text,
          options
        );

        if (!this.isPollingRunActive(runId)) {
          return;
        }

        this.status = {
          ...this.status,
          polling: {
            ...this.status.polling,
            targetCount: activeTargets.length,
            lastRunAt: Date.now(),
            lastSentCount: sentCount,
            error: ""
          }
        };
        this.emitStatus();
      } catch (error) {
        if (!this.isPollingRunActive(runId)) {
          return;
        }

        this.status = {
          ...this.status,
          polling: {
            ...this.status.polling,
            active: false,
            error: toErrorMessage(error)
          }
        };
        this.emitStatus();
        this.stopPollingTimerOnly();
      } finally {
        this.pollingBusy = false;
      }
    };

    this.pollingTimer = setInterval(() => {
      void tick();
    }, normalizedInterval);

    void tick();
  }

  public stopPolling(): void {
    this.stopPollingTimerOnly();
    this.pollingRunId += 1;
    this.pollingBusy = false;
    this.status = {
      ...this.status,
      polling: {
        ...this.status.polling,
        active: false
      }
    };
    this.emitStatus();
  }

  public startChain(
    terminals: vscode.Terminal[],
    script: string,
    defaultWaitTimeoutMs: number,
    options: BroadcastOptions
  ): void {
    const steps = parseChainScript(script);
    if (steps.length === 0) {
      throw new Error("Task chain is empty.");
    }

    const targets = dedupeTerminals(terminals);
    if (targets.length === 0) {
      throw new Error("Select at least one target terminal first.");
    }

    const normalizedDefaultTimeout = Math.max(1000, Math.round(defaultWaitTimeoutMs));

    this.stopChain();
    const runId = ++this.chainRunId;

    this.status = {
      ...this.status,
      chain: {
        active: true,
        currentStep: 0,
        totalSteps: steps.length,
        targetCount: targets.length,
        detail: "Running",
        error: ""
      }
    };
    this.emitStatus();

    void this.executeChain(runId, targets, steps, normalizedDefaultTimeout, options);
  }

  public stopChain(): void {
    this.chainRunId += 1;
    this.status = {
      ...this.status,
      chain: {
        ...this.status.chain,
        active: false,
        detail: this.status.chain.error ? this.status.chain.detail : "Stopped"
      }
    };
    this.emitStatus();
  }

  private async executeChain(
    runId: number,
    terminals: vscode.Terminal[],
    steps: ChainStep[],
    defaultWaitTimeoutMs: number,
    options: BroadcastOptions
  ): Promise<void> {
    try {
      for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex];
        if (!this.isChainRunActive(runId)) {
          return;
        }

        this.status = {
          ...this.status,
          chain: {
            ...this.status.chain,
            currentStep: stepIndex + 1,
            detail: describeStep(step)
          }
        };
        this.emitStatus();

        const activeTargets = getOpenTerminals(terminals);
        if (activeTargets.length === 0) {
          throw new Error("All chain targets are closed.");
        }

        if (step.kind === "command") {
          const sentCount = await this.broadcaster.broadcastNonInteractive(
            activeTargets,
            step.command,
            options
          );
          if (sentCount === 0) {
            throw new Error(`Step ${stepIndex + 1} sent nothing.`);
          }
          continue;
        }

        if (step.kind === "delay") {
          await this.waitWithCancel(runId, step.delayMs);
          continue;
        }

        await this.waitForReadyState(
          runId,
          activeTargets,
          step.stableMs,
          step.timeoutMs ?? defaultWaitTimeoutMs,
          stepIndex + 1
        );
      }

      if (!this.isChainRunActive(runId)) {
        return;
      }

      this.status = {
        ...this.status,
        chain: {
          ...this.status.chain,
          active: false,
          detail: "Completed"
        }
      };
      this.emitStatus();
    } catch (error) {
      if (!this.isChainRunActive(runId)) {
        return;
      }

      this.status = {
        ...this.status,
        chain: {
          ...this.status.chain,
          active: false,
          error: toErrorMessage(error),
          detail: "Failed"
        }
      };
      this.emitStatus();
    }
  }

  private async waitWithCancel(runId: number, durationMs: number): Promise<void> {
    let remaining = Math.max(0, durationMs);
    while (remaining > 0) {
      if (!this.isChainRunActive(runId)) {
        throw new Error("Chain stopped.");
      }
      const chunk = Math.min(remaining, READY_PROBE_INTERVAL_MS);
      await delay(chunk);
      remaining -= chunk;
    }
  }

  private async waitForReadyState(
    runId: number,
    terminals: vscode.Terminal[],
    stableMs: number,
    timeoutMs: number,
    stepIndex: number
  ): Promise<void> {
    const startAt = Date.now();
    const readySince = new Map<vscode.Terminal, number>();

    while (true) {
      if (!this.isChainRunActive(runId)) {
        throw new Error("Chain stopped.");
      }

      const activeTargets = getOpenTerminals(terminals);
      if (activeTargets.length === 0) {
        throw new Error("All chain targets are closed.");
      }

      const now = Date.now();
      for (const terminal of activeTargets) {
        if (isReadyState(this.terminalStateManager.getState(terminal))) {
          if (!readySince.has(terminal)) {
            readySince.set(terminal, now);
          }
        } else {
          readySince.delete(terminal);
        }
      }

      const allStable = activeTargets.every((terminal) => {
        const since = readySince.get(terminal);
        return typeof since === "number" && now - since >= stableMs;
      });
      if (allStable) {
        return;
      }

      if (now - startAt > timeoutMs) {
        throw new Error(
          `Step ${stepIndex} wait_ready timed out after ${Math.round(timeoutMs / 1000)}s.`
        );
      }

      await delay(READY_PROBE_INTERVAL_MS);
    }
  }

  private isPollingRunActive(runId: number): boolean {
    return this.status.polling.active && runId === this.pollingRunId;
  }

  private isChainRunActive(runId: number): boolean {
    return this.status.chain.active && runId === this.chainRunId;
  }

  private stopPollingTimerOnly(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private emitStatus(): void {
    this.statusEmitter.fire(this.status);
  }
}

export function parseChainScript(script: string): ChainStep[] {
  const steps: ChainStep[] = [];
  const lines = script.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = index + 1;
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const plainDirective = line.match(/^(wait_ready|wait_idle|delay)\s*:\s*(.+)$/i);
    if (plainDirective) {
      const name = plainDirective[1].toLowerCase();
      const rawValue = plainDirective[2].trim();
      const parsed = Number(rawValue);
      if (!/^\d+$/.test(rawValue) || !Number.isFinite(parsed)) {
        throw new Error(
          `Line ${sourceLine}: invalid ${name} value "${rawValue}". Use number milliseconds.`
        );
      }

      if (name === "delay") {
        steps.push({ kind: "delay", delayMs: Math.max(0, Math.round(parsed)), sourceLine });
      } else {
        steps.push({
          kind: "waitReady",
          stableMs: Math.max(0, Math.round(parsed)),
          sourceLine
        });
      }
      continue;
    }

    if (/^(wait_ready|wait_idle|delay)\s*:/i.test(line)) {
      throw new Error(
        `Line ${sourceLine}: invalid directive syntax. Use e.g. {wait_ready: 5000}.`
      );
    }

    if (line.startsWith("{") && line.endsWith("}")) {
      const fields = parseDirectiveFields(line.slice(1, -1), sourceLine);
      if (fields.has("delay")) {
        ensureOnlyKeys(fields, ["delay"], sourceLine);
        steps.push({ kind: "delay", delayMs: fields.get("delay") ?? 0, sourceLine });
        continue;
      }

      const hasWaitReady = fields.has("wait_ready");
      const hasWaitIdle = fields.has("wait_idle");
      if (hasWaitReady || hasWaitIdle) {
        if (hasWaitReady && hasWaitIdle) {
          throw new Error(
            `Line ${sourceLine}: wait_ready and wait_idle cannot be used together.`
          );
        }
        ensureOnlyKeys(fields, ["wait_ready", "wait_idle", "timeout"], sourceLine);
        const stableMs = hasWaitReady
          ? fields.get("wait_ready") ?? 0
          : fields.get("wait_idle") ?? 0;
        const timeoutMs = fields.get("timeout");
        if (typeof timeoutMs === "number" && timeoutMs < 1000) {
          throw new Error(`Line ${sourceLine}: timeout must be >= 1000ms.`);
        }
        steps.push({ kind: "waitReady", stableMs, timeoutMs, sourceLine });
        continue;
      }

      throw new Error(`Line ${sourceLine}: unknown directive.`);
    }

    steps.push({ kind: "command", command: rawLine, sourceLine });
  }

  return steps;
}

function describeStep(step: ChainStep): string {
  if (step.kind === "command") {
    return `Command (line ${step.sourceLine})`;
  }
  if (step.kind === "delay") {
    return `Delay ${step.delayMs}ms (line ${step.sourceLine})`;
  }
  if (typeof step.timeoutMs === "number") {
    return `Wait ready ${step.stableMs}ms (timeout ${step.timeoutMs}ms, line ${step.sourceLine})`;
  }
  return `Wait ready ${step.stableMs}ms (line ${step.sourceLine})`;
}

function parseDirectiveFields(content: string, sourceLine: number): Map<string, number> {
  const fields = new Map<string, number>();
  const segments = content
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (segments.length === 0) {
    throw new Error(`Line ${sourceLine}: empty directive.`);
  }

  for (const segment of segments) {
    const pair = segment.match(/^([a-z_]+)\s*:\s*(\d+)$/i);
    if (!pair) {
      throw new Error(
        `Line ${sourceLine}: invalid directive token "${segment}". Use key: number.`
      );
    }
    const key = pair[1].toLowerCase();
    const value = Number(pair[2]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Line ${sourceLine}: invalid value for "${key}".`);
    }
    fields.set(key, Math.round(value));
  }

  return fields;
}

function ensureOnlyKeys(
  fields: Map<string, number>,
  allowList: string[],
  sourceLine: number
): void {
  const allowed = new Set(allowList);
  for (const key of fields.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`Line ${sourceLine}: "${key}" is not allowed here.`);
    }
  }
}

function dedupeTerminals(terminals: vscode.Terminal[]): vscode.Terminal[] {
  return [...new Set(terminals)];
}

function getOpenTerminals(terminals: vscode.Terminal[]): vscode.Terminal[] {
  const current = new Set(vscode.window.terminals);
  return terminals.filter((terminal) => current.has(terminal));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}
