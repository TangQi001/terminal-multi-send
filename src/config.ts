import * as vscode from "vscode";
import { BroadcastOptions } from "./broadcaster";

const CONFIG_NAMESPACE = "cursorTerminalNexus";

export interface NexusConfig {
  autoSelectRegex: string;
  autoSendEnabled: boolean;
  autoSendDelayMs: number;
  options: BroadcastOptions;
}

export function readNexusConfig(): NexusConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  return {
    autoSelectRegex: config.get<string>("autoSelectRegex", ""),
    autoSendEnabled: config.get<boolean>("autoSendEnabled", false),
    autoSendDelayMs: Math.max(200, config.get<number>("autoSendDelayMs", 800)),
    options: {
      requireConfirmBeforeBroadcast: config.get<boolean>(
        "requireConfirmBeforeBroadcast",
        false
      ),
      enableSensitiveCommandGuard: config.get<boolean>(
        "enableSensitiveCommandGuard",
        true
      ),
      sensitiveKeywords: config.get<string[]>("sensitiveKeywords", []),
      waveThreshold: Math.max(1, config.get<number>("waveThreshold", 20)),
      waveDelayMs: Math.max(0, config.get<number>("waveDelayMs", 20))
    }
  };
}

export type EditableSettingKey =
  | "autoSelectRegex"
  | "autoSendEnabled"
  | "autoSendDelayMs"
  | "requireConfirmBeforeBroadcast"
  | "enableSensitiveCommandGuard"
  | "waveThreshold"
  | "waveDelayMs";

type EditableSettingValue = string | boolean | number;

export async function updateNexusSetting(
  key: EditableSettingKey,
  value: EditableSettingValue
): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  await config.update(key, value, vscode.ConfigurationTarget.Global);
}
