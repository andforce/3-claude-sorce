# Claude Code Query / Runtime Loop 深度解析

## 1. 定位

主循环核心在 `src/query.ts`。

从架构角度看：
- `query()` 更像生命周期包装器
- `queryLoop()` 才是真正的状态机

它不是一次性“发请求 → 收结果”的简单函数，而是一个**可多轮迭代的 async generator**：
- 持续产出 stream event
- 产出 finalized messages
- 产出 tombstone / retry / compact 后消息
- 在需要时进入 tool loop，再回到模型

这使它本质上是 Claude Code 的 **agent runtime heart**。

---

## 2. 主循环职责拆解

`src/query.ts` 负责：

1. 构建查询配置
2. 管理 turn 内部可变状态
3. 对消息做 API 前整形
4. 注入 system/user context
5. 驱动模型流式输出
6. 识别并执行 tool_use
7. 处理 compact / context collapse / retry
8. 决定继续下一轮还是终止

可以抽象成：

```text
prepare transcript
  → normalize
  → inject context
  → stream model
  → if tool_use: run tools
  → append tool results
  → maybe compact/retry
  → continue / stop
```

---

## 3. 状态机形态

### 3.1 初始化

`query()` 会先通过：
- `buildQueryConfig()` (`src/query/config.ts`)

构造一批“相对稳定”的配置项：
- 模型参数
- compact 策略
- 工具集
- context 相关依赖
- hooks / token budget / telemetry 依赖

然后进入 `queryLoop()`，再维护一份 turn 内部的 mutable state，例如：
- `messages`
- `toolUseContext`
- compact boundary
- max-output / retry 状态
- pending tool summary
- transition reason

### 3.2 为什么不用递归

源码实际上把“模型 → 工具 → 模型”的多轮交替收敛为一个单一循环，而不是嵌套递归。

这样做有几个好处：
- 更容易做 compact boundary 管理
- 更容易做 token budget continuation
- 更容易在中途 retry / tombstone / stream fallback
- 更容易统一产出 stream event 给 REPL / SDK

---

## 4. transcript 归一化层

真正决定“哪些消息可以发给模型”的核心，不在 `query.ts` 本身，而在：

- `src/utils/messages.ts`

其中最关键的是：
- `normalizeMessagesForAPI()`

### 4.1 它做的事

这一步非常关键，它不是简单 map 一下消息，而是在维护 transcript 的 **API correctness invariants**：

1. 调整 attachment 顺序
   - `reorderAttachmentsForAPI()`

2. 去掉仅 UI 可见/展示型消息

3. 合并相邻 user / assistant 消息片段

4. 规范化 tool input / tool name

5. 移除不支持的 tool-search 字段 / tool references

6. 把 `tool_result` block 提前到 user content 最前

7. 清理空 assistant message / orphaned thinking / signature block

8. 校验图片数量和尺寸限制

### 4.2 它的重要性

`query.ts` 依赖这个模块保证：
- transcript 不会因为 UI 中间态污染 API 输入
- tool_use / tool_result 成对关系尽量成立
- thinking / attachment / compact 后的历史仍然合法

相关函数还包括：
- `ensureToolResultPairing()`
- `stripSignatureBlocks()`
- `filterOrphanedThinkingOnlyMessages()`
- `getMessagesAfterCompactBoundary()`

这说明 `messages.ts` 实际上是整个 runtime 的 **transcript correctness layer**。

---

## 5. pre-send reduction：发请求前的多级缩减

在每轮真正调用模型前，`queryLoop()` 会对上下文做多级缩减。

顺序大致是：

1. tool-result budgeting
2. optional snip
3. microcompact
4. context collapse
5. autocompact

这不是单一 compact，而是一个**分层退让机制**。

### 5.1 proactive compact

通过：
- `deps.autocompact(...)`
- `buildPostCompactMessages(...)` (`src/services/compact/compact.ts`)

主动压缩对话历史。

当 compact 触发时，系统不会悄悄替换历史，而是构造 compact 后的新消息集，并立即把相关消息 yield 出去，让上层 UI / transcript 可见。

### 5.2 reactive compact

这是另一条路径。

当 API 返回：
- prompt-too-long
- media-size-too-large
- max_output_tokens 相关失败

系统不会立刻把错误抛给上层，而是优先尝试：
- context collapse drain
- `reactiveCompact.tryReactiveCompact(...)`

也就是说，很多“模型失败”在用户看来其实会被内部修复掉。

---

## 6. context 注入

相关文件：
- `src/utils/api.ts`

核心函数：
- `appendSystemContext()`
- `prependUserContext()`

### 6.1 两种注入方式

1. **system prompt 侧追加**
   - `appendSystemContext()`
   - 用于把结构化系统上下文追加到 system prompt

2. **user message 侧前置**
   - `prependUserContext()`
   - 以 synthetic `<system-reminder>` user message 的形式注入

### 6.2 设计含义

这说明系统上下文并不是只靠单个 system prompt 统一承载。

它把“系统级背景”和“本轮用户上下文”拆开处理，方便：
- 控制 cache 命中
- 控制 compact 后哪些东西仍然保留
- 避免把所有上下文都硬塞进 system prompt

---

## 7. 流式响应处理

### 7.1 queryLoop 的流式消费

`queryLoop()` 会直接消费 `deps.callModel(...)` 的流。

它会：
- 先发 `stream_request_start`
- 再持续转发 assistant/stream event
- 期间缓冲特定错误
- 在合适时机把结果落到 transcript

### 7.2 错误并不是立即暴露

几个 recoverable error 会先被“压住”：
- prompt-too-long
- media-size
- `max_output_tokens`

原因是：
- 这些错误很多可以通过 compact / retry / collapse 修复
- 如果立刻抛到 UI，就会打断自然交互流

### 7.3 流式组装不在 query.ts 单独完成

UI 相关的流式组装逻辑在：
- `handleMessageFromStream()` (`src/utils/messages.ts`)

它负责把底层 stream event 翻译成：
- spinner 状态
- streaming text
- streaming thinking
- tool input delta
- final assistant message

所以：
- `query.ts` 负责 runtime control flow
- `messages.ts` 负责 stream-to-transcript / stream-to-UI 组装

---

## 8. tool loop orchestration

### 8.1 continuation signal

在这个 runtime 里，`tool_use` block 是关键 continuation signal。

流程是：
1. 模型流式输出中出现 `tool_use`
2. `query.ts` 收集 assistant output + tool_use blocks
3. 如果需要工具执行，则进入 tool execution
4. 工具结果回写 transcript
5. 再继续下一轮模型调用

### 8.2 两种工具执行模式

#### 模式 A：经典批处理
文件：
- `src/services/tools/toolOrchestration.ts`

核心：
- `runTools()`

特点：
- 把工具分成 concurrency-safe 与 exclusive 两类
- 能并行的并行
- 有副作用或不安全的工具串行

#### 模式 B：流式工具执行
文件：
- `src/services/tools/StreamingToolExecutor.ts`

特点：
- tool block 一旦流出来，就尽早启动执行
- progress 先行产出
- final results 按到达顺序缓冲
- 某些失败（特别是 Bash）会触发 sibling abort

### 8.3 为什么要两套

因为系统同时想满足：
- 低延迟（streaming execution）
- 正确性与并发约束（batched orchestration）

这是一种很典型的 agent runtime compromise：
- 尽量早执行
- 但不能破坏 transcript 顺序与工具安全边界

---

## 9. 终止与 continuation

当本轮没有继续工具调用时，系统不会立即结束，还会走：

1. `handleStopHooks()` (`src/query/stopHooks.ts`)
2. `checkTokenBudget()` (`src/query/tokenBudget.ts`)

### 9.1 stop hook

这一步负责 turn 结束时的 hook 注入与善后逻辑。

### 9.2 token budget continuation

如果开启 token budget 相关特性，系统还能决定：
- 当前模型输出到达某个阈值后是否继续
- 是否自动衔接下一轮生成

这意味着 turn 结束与否，并不只由“模型 stop 了”决定。

---

## 10. 架构判断

从源码看，`query.ts` 不是“请求层”，而是：

- **transcript runtime**
- **tool orchestration runtime**
- **retry/compact recovery runtime**
- **stream transport adapter**

也就是说，它基本相当于 Claude Code 的一个小型 agent kernel。

如果只看表面，会觉得它是聊天调用；但真实职责已经接近：
- 状态机
- 调度器
- transcript validator
- recovery controller

---

## 11. 关键文件索引

- `src/query.ts`
- `src/query/config.ts`
- `src/query/stopHooks.ts`
- `src/query/tokenBudget.ts`
- `src/utils/messages.ts`
- `src/utils/api.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/services/compact/compact.ts`

---

## 12. 一句话结论

Claude Code 的主循环不是“聊天请求封装”，而是一套完整的 **多轮 agent runtime 状态机**，负责 transcript 正确性、context 压缩恢复、tool orchestration 与流式响应编排。