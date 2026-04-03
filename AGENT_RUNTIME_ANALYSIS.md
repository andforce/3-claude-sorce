# Claude Code Agent / Subagent Runtime 深度解析

## 1. 定位

Claude Code 里的 Agent 并不是一个单独功能点，而是一套完整运行时。

核心涉及：
- `src/tools/AgentTool/`
- `src/tasks/LocalAgentTask/`
- `src/tasks/RemoteAgentTask/`
- `src/tasks/InProcessTeammateTask/`
- `src/utils/worktree.ts`
- `src/utils/swarm/`

这个系统真正做的是：
- 子代理生命周期管理
- 前台/后台执行切换
- worktree 隔离
- in-process teammate 与 remote agent 分流
- transcript / metadata sidechain 持久化

---

## 2. 统一任务模型

关键文件：
- `src/Task.ts`

Agent 相关 runtime 不是散落到各处，而是被统一放进 task model 中。

核心 task kind 包括：
- `local_agent`
- `remote_agent`
- `in_process_teammate`

这意味着系统从架构上认为：
- agent 不是普通函数调用
- agent 是一类可跟踪、可恢复、可 background、可观察的任务实体

---

## 3. AgentTool：统一分发器

关键文件：
- `src/tools/AgentTool/AgentTool.tsx`

`AgentTool` 是子代理系统的主入口。

它负责：
- agent definition 解析
- permissions / model / MCP requirements 决策
- isolation mode 决策
- sync vs async 路由
- teammate spawning 决策
- remote execution 决策
- worktree isolation 创建

从架构上，它相当于：

```text
Agent invocation router
  + runtime mode selector
  + task registrar
  + execution launcher
```

---

## 4. subagent 执行模型

关键文件：
- `src/tools/AgentTool/runAgent.ts`

### 4.1 runAgent 的职责

`runAgent()` 会为子代理构建独立执行上下文：
- 自己的 tools
- 自己的 permission mode
- 自己的 system prompt
- 可选 MCP servers
- transcript sidechain
- metadata
- hooks
- abort controller

这说明子代理不是简单共享主线程上下文，而是会派生一个**专属执行上下文**。

### 4.2 sidechain persistence

相关机制：
- `recordSidechainTranscript`
- `writeAgentMetadata`

用途：
- 持久化 agent transcript
- 持久化 metadata
- 支持 resume / inspection / background completion 后恢复状态

这说明 agent runtime 从一开始就不是“fire-and-forget”，而是支持可恢复/可审计轨迹。

---

## 5. foreground / background agent

### 5.1 统一 task type

无论前台还是后台，本地子代理最终都属于：
- `local_agent`

差别主要由：
- `isBackgrounded: true/false`

控制。

### 5.2 前台路径

前台 agent 通过：
- `registerAgentForeground()`

注册。

它初始仍然是 task，只是暂时以前台方式驱动执行。

### 5.3 后台路径

后台 agent 通过：
- `registerAsyncAgent()`

注册，带 `isBackgrounded: true`。

### 5.4 中途 background 的设计

一个很关键的架构点：
- sync subagent 可以在运行中被 background 化
- 实现方式是 race 当前 foreground iterator 与 `backgroundSignal`
- 一旦 background，停止 foreground iterator
- 用同一个逻辑 agent 重新以 async 方式启动
- 返回 `async_launched`

这说明“前台/后台”不是两套完全不同 runtime，而是同一 task runtime 的两种宿主模式。

---

## 6. worktree isolation

关键文件：
- `src/utils/worktree.ts`

### 6.1 设计目标

为 agent 提供代码隔离环境，避免：
- 干扰主工作区
- 多 agent 修改冲突
- 临时实验污染用户当前目录

### 6.2 创建位置

`createAgentWorktree()` 会在 canonical repo root 下创建：
- `.claude/worktrees/`

注意不是挂在当前 session worktree 里面，而是挂在稳定 repo root 下。

### 6.3 创建时传播的内容

源码里 worktree setup 还会传播：
- local settings
- hook path config
- 可选 symlinked directories
- `.worktreeinclude` 内容

这意味着它不是“裸 git worktree”，而是一个带本地环境复制语义的隔离工作区。

### 6.4 清理策略

清理非常保守：
- 会检查 `hasWorktreeChanges()`
- 只有**没有未提交修改且没有新 commit**时才自动移除
- 否则保留 worktree，并把 `worktreePath/worktreeBranch` 带回完成通知

说明系统优先保护 agent 结果，不做激进清理。

---

## 7. Local agent vs teammate

这是文档里很值得单独强调的一点。

### 7.1 local_agent

含义：
- 由 `AgentTool` 启动的普通子代理
- 偏一次性任务委派
- 有自己的 transcript
- 可前台/后台执行

### 7.2 in_process_teammate

含义：
- swarm/team participant
- 有稳定身份：`agentName@teamName`
- 支持 mailbox / user message injection
- 有 idle/active state
- 有 plan approval 语义

相关文件：
- `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx`
- `src/utils/teammate.ts`
- `src/utils/teammateContext.ts`

### 7.3 本质区别

| 类型 | 身份语义 | 生命周期 | 交互模型 |
|---|---|---|---|
| local_agent | 一次性 delegated worker | task 级 | 调用-完成 |
| teammate | 团队成员 | 更稳定、更持久 | 协作/收件箱/角色 |

所以 teammate 不是“另一个 agent mode”，而是另外一种 runtime entity。

---

## 8. in-process teammate runtime

### 8.1 生成方式

相关文件：
- `src/utils/swarm/spawnInProcess.ts`
- `src/tools/shared/spawnMultiAgent.ts`

in-process teammate 跑在同一个 Node/Bun 进程中，但通过：
- `AsyncLocalStorage`
- 独立 abort controller
- 独立 task state

来做上下文隔离。

### 8.2 架构意义

这是一个典型“单进程多代理”模型：
- 比开新进程快
- 能共享部分内存/基础设施
- 通过 ALS 隔离身份和上下文

这对高频协作型 agent 很有价值。

---

## 9. out-of-process teammate 与命名上的架构债

源码里还有 tmux / iTerm pane backend 的 teammate。

它们虽然物理上不一定和 in-process teammate 一样，但在 task surface 上依然可能被看作 teammate 语义的一部分。

这反映出一个重要事实：
- task kind 的命名不完全等于底层实现形态
- 它更强调“交互语义 / UX surface”而非纯进程拓扑

这是一个架构上很真实的折中，也是一种轻度命名债务。

---

## 10. remote_agent

关键文件：
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`

### 10.1 它不是本地子代理的远程 transport 版那么简单

`remote_agent` 是单独 runtime：
- 通过 CCR / teleport 进入远端
- 注册为 remote task
- 状态写 sidecar metadata
- 支持 `--resume`
- 通过 polling 恢复 progress/logs/completion

### 10.2 设计含义

这说明 remote agent 在系统里被视作：
- 分布式任务
- 非即时返回实体
- 依赖状态重建与轮询观察

而不是普通 RPC。

---

## 11. transcript / cache 复用策略

一个很高级但很重要的点：
- forked subagent 会尽量复用 parent prompt/tool prefix
- 通过 `buildForkedMessages`、`useExactTools` 等机制保持字节级接近

目的：
- prompt cache 命中
- 避免重复构建系统上下文
- 减少子代理启动成本

这说明 agent runtime 已经把 **cache economics** 纳入架构设计，而不只是 correctness。

---

## 12. notification 与结果回传

后台 agent 的通知不是直接函数 return，而是消息/任务通知式：
- `enqueueAgentNotification()`

它会发出带 XML tag 的 payload，例如：
- `<task_notification>`

其中包含：
- task id
- output file
- status
- usage
- worktree info

这说明后台 agent 的结果 surface 设计偏向：
- 统一通知协议
- transcript / UI 都可消费
- 不依赖单次同步调用栈

---

## 13. 架构判断

Claude Code 的 agent runtime 不是“模型里再开个模型调用”这么简单。

它已经具备：
- 独立上下文派生
- task 化生命周期
- foreground/background 切换
- transcript 持久化
- worktree 隔离
- in-process team runtime
- remote distributed runtime
- cache-aware fork 策略

从这个角度看，它更像一个 **多代理任务执行平台**。

---

## 14. 关键文件索引

- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/AgentTool/runAgent.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`
- `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx`
- `src/utils/worktree.ts`
- `src/utils/swarm/spawnInProcess.ts`
- `src/tools/shared/spawnMultiAgent.ts`
- `src/utils/teammate.ts`
- `src/utils/teammateContext.ts`

---

## 15. 一句话结论

Claude Code 的 Agent 系统本质上不是“子调用能力”，而是一套支持本地、后台、协作、远程与隔离执行的 **多代理任务运行时平台**。