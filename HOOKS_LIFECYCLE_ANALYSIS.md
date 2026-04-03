# Claude Code Hooks 生命周期架构深度解析

## 1. 定位

Claude Code 的 hooks 不是零散脚本回调，而是一套统一的事件驱动扩展机制。

从源码看，这套系统支持：
- prompt submit hooks
- pre/post tool hooks
- stop / stop failure hooks
- session-start 类延迟消息注入
- hook progress / blocking / continuation control

核心文件：
- `src/utils/hooks.ts`
- `src/schemas/hooks.ts`
- `src/types/hooks.ts`
- `src/query/stopHooks.ts`
- `src/hooks/useDeferredHookMessages.ts`

---

## 2. hook schema：配置层先抽象成统一 hook 类型

相关文件：
- `src/schemas/hooks.ts`

支持的持久化 hook 类型包括：
- `command`
- `prompt`
- `agent`
- `http`

并支持字段：
- `if`
- `timeout`
- `statusMessage`
- `async`
- `once`

### 2.1 架构意义

hook 不是仅 shell command，而是多种执行媒介的统一配置对象。

---

## 3. 中心执行器：`executeHooks()`

核心文件：
- `src/utils/hooks.ts`

所有事件型 hook 最终都会汇总到：
- `executeHooks()`

### 3.1 它做什么

- 检查全局 hook gate
- 检查 workspace trust
- 解析当前 session/agent 匹配到的 hooks
- 打 telemetry
- yield progress / result

### 3.2 设计含义

系统没有为每种 hook 写一套独立 runtime，而是用一个 shared fan-out engine 驱动所有 hook 类型。

这属于标准的 event bus / dispatcher 设计。

---

## 4. hook result：输出远不只是 stdout

相关文件：
- `src/types/hooks.ts`

### 4.1 可返回的关键信息

- `blockingError`
- `preventContinuation`
- `stopReason`
- `permissionBehavior`
- `updatedInput`
- `updatedMCPToolOutput`
- `additionalContexts`
- `initialUserMessage`
- `watchPaths`
- `HookProgress`

### 4.2 架构意义

hook 在 Claude Code 中不是“副作用脚本”，而是可实质影响 runtime 控制流的扩展点。

---

## 5. Prompt submit hooks

主入口：
- `executeUserPromptSubmitHooks(...)`

### 5.1 执行时机

在用户 prompt 提交后、正式进入 query 前执行。

### 5.2 能做什么

- 阻止 prompt 继续
- 注入 additional context
- 返回 stop reason
- 生成可见/不可见系统信息

### 5.3 deferred session-start message

相关文件：
- `src/hooks/useDeferredHookMessages.ts`

这套机制会把 session-start hook 的消息延后到首个 API request 前再注入，避免首屏阻塞。

### 5.4 架构意义

prompt submit hooks 不只是 pre-submit validator，还兼具：
- context augmenter
- conversation preprocessor
- startup message injector

---

## 6. Tool hooks

主要函数：
- `executePreToolHooks()`
- `executePostToolHooks()`
- `executePostToolUseFailureHooks()`

### 6.1 pre-tool

可以基于：
- tool name
- tool input
- tool use id

做：
- permission decision
- updated input

### 6.2 post-tool

可以：
- append context
- 返回 `updatedMCPToolOutput`

### 6.3 failure hook

在工具执行失败后进入另一条 hook path。

### 6.4 架构意义

tool hooks 是工具调用生命周期上的“旁路控制层”，而不是纯日志观察点。

---

## 7. Stop hooks

相关文件：
- `src/query/stopHooks.ts`
- `src/utils/hooks.ts`

### 7.1 事件类型

系统会区分：
- `Stop`
- `SubagentStop`
- `StopFailure`

### 7.2 query loop 中的作用

query loop 在本轮无继续工具调用后，会进入 `handleStopHooks()`。

它会：
- 消费 hook progress / message
- 汇总 timing/error
- 生成 transcript attachment message
- 生成 stop-hook summary
- 在必要时终止 continuation

### 7.3 一个关键细节

如果 stop hook 返回 `preventContinuation`：
- query loop 会以 `stop_hook_prevented` 结束

如果是 blocking error：
- 会把相关消息注入对话，再继续带 `stopHookActive: true` 的路径，避免递归问题

### 7.4 架构意义

stop hook 不是 turn 结束后的“尾巴”，而是 query runtime 终止判定的一部分。

---

## 8. Stop failure hooks

当 API 错误结束时，不走普通 stop hook，而走：
- `executeStopFailureHooks()`

这说明 hook 生命周期不是单线性的，而是：
- 正常成功结束路径
- 失败结束路径

分别有不同事件语义。

---

## 9. UI surface

### 9.1 hook progress

`HookProgress` 是一等 progress message 类型。

### 9.2 REPL 中的表现

- deferred hook message 会在首个 request 前插入
- stop hook 会生成 transcript message / summary / notification
- hook progress 会被 UI 单独识别

### 9.3 架构意义

hook 系统不是后台不可见脚本系统，而是可投影到 REPL/turn transcript 的显式扩展层。

---

## 10. 架构判断

Claude Code 的 hooks 生命周期可以抽象成：

```text
event occurs
  → schema-matched hooks
  → executeHooks() fanout
  → structured result aggregation
  → runtime control / transcript injection / UI progress
```

所以 hooks 在这里扮演的是：
- event-driven extensibility layer
- runtime interception layer
- transcript augmentation layer

而不是简单脚本回调。

---

## 11. 关键文件索引

- `src/utils/hooks.ts`
- `src/schemas/hooks.ts`
- `src/types/hooks.ts`
- `src/query/stopHooks.ts`
- `src/hooks/useDeferredHookMessages.ts`
- `src/screens/REPL.tsx`

---

## 12. 一句话结论

Claude Code 的 hooks 架构是一套能影响 prompt、tool、turn 终止与 transcript/UI 呈现的 **事件驱动运行时拦截系统**。