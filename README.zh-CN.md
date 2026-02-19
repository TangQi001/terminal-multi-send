# TQ Terminal Nexus

[English](README.md) | [简体中文](README.zh-CN.md)

用于 VS Code 的多终端广播扩展：一次输入，批量发送到多个集成终端。

## 功能概览

- 多终端选择与广播：
  - 命令模式 `QuickPick` 多选
  - 仅有 1 个终端时自动直通
- 命令输入流：
  - 手动输入
  - 历史命令
  - 预设命令（`quickCommands`）
- 占位符注入：
  - `{index}`：发送序号（从 1 开始）
  - `{name}`：终端名称
  - `{name:quoted}`：带转义双引号的终端名称
- 安全与稳定：
  - 敏感关键词拦截（支持二次确认）
  - 可选“发送前确认”
  - 终端数量超过阈值时分波发送（带延迟）
- 侧边栏控制面板（Webview）：
  - 终端勾选、全选、清空、刷新
  - 分组（按工具类型）与排序（名称/PID/选中优先/自定义）
  - 自定义排序下支持拖拽重排
  - 输入后自动发送（防抖延迟）
  - 面板内直接修改核心配置
- 国际化：
  - 英文默认
  - `zh-CN` 本地化

## 安装与运行

### 1) 本地开发运行

1. 安装依赖：`npm install`
2. 构建扩展：`npm run compile`
3. 在 VS Code 中按 `F5` 启动 Extension Development Host

### 2) 安装 VSIX（可选）

仓库中已包含示例构建产物：

- `cursor-terminal-nexus-0.0.1.vsix`
- `cursor-terminal-nexus-0.0.2.vsix`

可在 VS Code 中通过 “Extensions: Install from VSIX...” 安装。

## 使用方式

### 命令模式（推荐快速发送）

1. 执行命令：`TQ Terminal Nexus: Broadcast Command`
2. 选择目标终端（支持多选）
3. 选择“输入新命令 / 历史命令 / 预设命令”
4. 确认后批量发送

默认快捷键：`Alt+Shift+B`

### 侧边栏面板模式（适合持续操作）

1. 执行命令：`TQ Terminal Nexus: Open Control Panel`
2. 在 Explorer 侧边栏打开 `TQ Terminal Nexus` 视图
3. 在面板中：
   - 管理终端选择
   - 输入发送内容（`Ctrl/Cmd + Enter` 快速发送）
   - 配置自动发送、分波参数、安全选项等

## 配置项

在 VS Code `Settings` 中搜索 `cursorTerminalNexus`：

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `cursorTerminalNexus.autoSelectRegex` | `""` | 按终端名称正则自动勾选目标 |
| `cursorTerminalNexus.requireConfirmBeforeBroadcast` | `false` | 每次发送前弹出确认框 |
| `cursorTerminalNexus.enableSensitiveCommandGuard` | `true` | 检测敏感关键词并警告 |
| `cursorTerminalNexus.sensitiveKeywords` | `["rm -rf","shutdown","reboot","mkfs","format","del /s","poweroff"]` | 敏感关键词列表（忽略大小写） |
| `cursorTerminalNexus.waveThreshold` | `20` | 选中终端数超过该值时启用分波发送 |
| `cursorTerminalNexus.waveDelayMs` | `20` | 分波发送间隔（毫秒） |
| `cursorTerminalNexus.quickCommands` | `[]` | 预设命令列表 |
| `cursorTerminalNexus.enableHistory` | `true` | 启用历史命令记录 |
| `cursorTerminalNexus.maxHistory` | `30` | 历史命令最大条数 |
| `cursorTerminalNexus.autoSendEnabled` | `false` | 控制面板输入后自动发送 |
| `cursorTerminalNexus.autoSendDelayMs` | `800` | 自动发送防抖延迟（毫秒，最小 200） |

## 占位符示例

输入以下命令：

```bash
echo terminal={name} idx={index} safe={name:quoted}
```

会在每个终端发送时自动替换对应值。

## 项目结构

```text
src/
  extension.ts            # 扩展入口与命令注册
  terminalManager.ts      # 终端发现、PID 获取、QuickPick 多选
  quickCommands.ts        # 历史命令与预设命令
  broadcaster.ts          # 安全检查、占位符注入、分波发送
  controlPanelProvider.ts # 侧边栏控制面板（Webview）
  config.ts               # 配置读取与更新
scripts/
  esbuild.js              # 构建脚本
```

## 开发命令

- `npm run check-types`：TypeScript 类型检查
- `npm run compile`：开发构建
- `npm run watch`：监听构建
- `npm run package`：生产构建（压缩）

## 许可证

MIT
