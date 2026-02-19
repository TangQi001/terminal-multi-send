# 终端运行状态智能感知：需求分析与解决方案

## 1. 需求背景与核心痛点

当前 `TQ Terminal Nexus` 能够高效地向多个终端广播命令，但在实际使用中，目标终端可能处于不同的运行状态。如果向正在运行程序（特别是交互式 AI CLI，如 `codex`、`claude code`）且未处于输入等待状态的终端强行发送命令，会导致输入流混乱、命令被吞没或程序异常中断。

**核心痛点：**
传统的操作系统进程树检测（如 `pgrep`）或 VS Code 原生的 Shell 执行状态检测，会将开启了 `codex` 或 `claude` 的终端统一识别为“长期运行状态（Busy）”，从而陷入**“盲区”**：无法区分 AI CLI 是在**“等待用户输入”**（可安全发送广播），还是在**“疯狂输出生成的代码”**（不可发送广播）。

**优化目标：**
实现一种“穿透式”的终端状态感知机制，精准区分原生 Shell 空闲、普通程序运行、交互式 CLI 等待输入、交互式 CLI 运算输出四种状态，从而在广播前进行安全拦截，并在控制面板 UI 上给予用户直观的反馈。

## 2. 核心场景分析

* **场景一：常规脚本执行保护。** 终端正在运行 `npm run dev` 或 `python script.py`。此时系统应精准识别其为“运行中”，拦截任何广播命令的写入，并允许用户选择是否强行中断发送。
* **场景二：交互式 AI 工具协同（输入期）。** 用户在多个终端启动了 `codex`。此时 `codex` 停留在提示符（如 `codex> `）等待提问。系统应识别其为“CLI 挂起/等待输入”状态，允许 `TQ Terminal Nexus` 将 Prompt 批量广播至这些终端。
* **场景三：交互式 AI 工具协同（生成期）。** 广播发送后，`codex` 开始滚动输出思考过程或代码。此时系统应迅速将状态切换为“运算输出中”，保护终端不被下一次误触的广播打断。

---

## 3. 功能需求定义

### 3.1 状态定义模型

系统需要为每个追踪的终端维护以下四种核心状态：

1. **IDLE（原生空闲）**：处于基础 Shell（zsh/bash/powershell）等待输入状态。
2. **RUNNING_PROGRAM（程序运行中）**：正在执行不可交互的普通进程。
3. **CLI_WAITING（交互等待中）**：进程仍在运行，但特征流匹配显示正处于等待用户输入的提示符阶段。
4. **CLI_THINKING（交互运算中）**：进程仍在运行，且正在持续输出非提示符内容。

### 3.2 广播拦截与安全防线

* **白名单机制：** 只有状态为 `IDLE` 或 `CLI_WAITING` 的终端才被允许接收广播命令。
* **拦截提示：** 当用户尝试向状态为 `RUNNING_PROGRAM` 或 `CLI_THINKING` 的终端发送命令时，触发 VS Code 警告弹窗（`showWarningMessage`），提示“部分终端正忙，是否强制发送或跳过？”。

### 3.3 UI 反馈集成

* 在 Webview 控制面板（`controlPanelProvider.ts`）的终端列表中，新增状态指示灯或图标：
* 🟢 绿点：空闲/就绪 (`IDLE`, `CLI_WAITING`)
* 🟡 黄点或 ⚙️ 旋转齿轮：忙碌/运行中 (`RUNNING_PROGRAM`, `CLI_THINKING`)

---

## 4. 技术解决方案架构

为了攻克“识别交互式 CLI 内部状态”这一难点，方案采用 **“VS Code 官方 Shell API + 实时终端数据流正则匹配”** 的双重混合检测架构。

### 4.1 核心模块设计：终端状态机 (`terminalStateManager.ts`)

这是整个方案的大脑，负责聚合底层事件并计算最终状态。

**步骤 1：捕获原生 Shell 执行边界**
利用 `vscode.window.onDidStartTerminalShellExecution` 和 `onDidEndTerminalShellExecution` API。

* 当命令触发时，终端状态从 `IDLE` 跃迁至 `RUNNING_PROGRAM`。
* 当命令结束时，状态强制重置回 `IDLE`，并清空该终端的流缓存。

**步骤 2：流式特征捕获（穿透检测）**
利用 `vscode.window.onDidWriteTerminalData` API 监听终端的实时文本输出（Stdout/Stderr）。

* 为每个活跃终端在内存中维护一个极小的环形缓冲区（例如保留最后 100-200 个字符），防止内存泄漏。
* **清洗流：** 实时剥离流中的 ANSI 转义序列（颜色代码、控制字符），提取纯文本。
* **正则匹配：** 将纯文本与配置的 `CLI_PROMPT_REGEX`（如 `/(>|❯|\?|codex\$)\s*$/`）进行匹配。

**步骤 3：状态流转计算**

* 如果当前状态是 `RUNNING_PROGRAM` 或 `CLI_THINKING`，且流缓冲区末尾精准命中了提示符正则，则状态**降级**为 `CLI_WAITING`。
* 如果当前状态是 `CLI_WAITING`，且流缓冲区开始涌入新的、非提示符的文本，则状态**升级**为 `CLI_THINKING`。

### 4.2 模块集成点

* **与 `broadcaster.ts` 的集成：**
  在执行核心 `terminal.sendText(cmd)` 之前，增加一次状态查询：

```typescript
const state = terminalStateManager.getState(terminal);
if (state === TerminalState.RUNNING_PROGRAM || state === TerminalState.CLI_THINKING) {
    // 触发拦截逻辑 (跳过或弹窗确认)
}
```

* **与 `controlPanelProvider.ts` 的集成：**
  `terminalStateManager` 内部在状态发生实质性变化时，通过 EventEmitter 派发事件。控制面板订阅该事件，并通过 `webview.postMessage` 将最新的终端状态字典推送到前端 React/Vue 视图，实时更新状态指示灯。

---

## 5. 边界情况与风险控制

1. **正则匹配的泛化与误判：** 不同的 AI CLI 提示符千奇百怪。

* *对策：* 将 `CLI_PROMPT_REGEX` 提取到 `package.json` 的设置项（`cursorTerminalNexus.cliPrompts`）中，允许用户自定义正则表达式列表，保证极高的扩展性。

2. **ANSI 字符清洗性能：** 终端在输出大段高亮代码时，会产生密集的 `onDidWriteTerminalData` 事件。

* *对策：* 引入节流阀（Throttling），无需每次字符写入都触发正则运算。每 50ms-100ms 聚合一次流片段进行正则判定即可；正则表达式必须经过高度优化，防止灾难性回溯。

3. **Shell API 的平台差异：** 某些非标准的 Shell 环境（如旧版 Git Bash）可能无法完美触发 `onDidStartTerminalShellExecution`。

* *对策：* 在插件启动阶段进行能力嗅探。如果原生 API 不可用，则自动优雅降级，仅依赖终端输出流监听来推测状态，或者默认允许发送但在面板 UI 上给予环境警告。
