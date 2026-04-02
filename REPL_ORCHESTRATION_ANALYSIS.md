# Claude Code REPL 编排架构深度解析

## 1. 定位

REPL 的核心文件是：
- `src/screens/REPL.tsx`

它不是一个“显示聊天记录 + 输入框”的普通 view 组件。

从源码看，REPL 更像是：
- UI orchestration hub
- prompt submit coordinator
- query runtime host
- permission / notification / fullscreen / transcript mode 的总调度层

换句话说，REPL 在这个系统里承担的是**交互编排器**角色，而不只是渲染器。

---

## 2. REPL 的核心职责

`REPL.tsx` 同时管理：

1. prompt 提交
2. message state 与 stream state
3. fullscreen / non-fullscreen 布局切换
4. permission dialog 队列
5. notification 协调
6. 本地与远程 query 分流
7. selection / transcript mode / message actions
8. 组件级临时状态与 AppState 的桥接

它本质上是：

```text
Input shell
  + message timeline owner
  + runtime host
  + modal/dialog coordinator
  + layout switchboard
```

---

## 3. Prompt submission：两阶段提交链路

### 3.1 顶层入口

REPL 内部的 `onSubmit` 是总入口。

它负责：
- idle-return gating
- 输入历史写入
- 清空/保留输入框
- 处理附件与 pasted content
- 决定 local / remote 分支
- 初始化 spinner / 占位消息
- 更新 attribution / app state
- 确保 hooks 相关消息及时 flush

### 3.2 真正执行层

本地执行继续下沉到：
- `src/utils/handlePromptSubmit.js`

由 REPL 传入一个非常大的 helper bundle，包括：
- `onQuery`
- `setMessages`
- `setAppState`
- notification APIs
- prompt helper
- tool context

这说明 `handlePromptSubmit` 不是一个独立 runtime，它本质上依赖 REPL 提供的 host environment。

### 3.3 Query host

REPL 里的：
- `onQuery`
- `onQueryImpl`

是真正把 prompt 提交接到 `query()` 主循环的地方。

它们负责：
- append new messages
- 利用 `QueryGuard` 防止重入
- 构建 fresh tool / MCP context
- 生成 system/user context
- 消费 `query(...)` stream
- 做 turn 结束清理与 telemetry

所以：
- `query.ts` 是 runtime kernel
- `REPL.tsx` 是 runtime host

---

## 4. Message rendering：状态拥有者与渲染者分离

### 4.1 REPL 拥有 canonical transcript state

REPL 维护：
- `messages`
- `streamingText`
- `streamingToolUses`
- `streamingThinking`
- 以及权限队列、dialog state 等周边状态

### 4.2 渲染下沉到 Messages.tsx

真正的 transcript render 主要在：
- `src/components/Messages.tsx`

它负责：
- normalize / group messages
- collapse
- truncate
- virtualize
- 为 in-flight tool delta 构造临时 assistant row
- 插入 unseen divider

### 4.3 架构意义

这是一个很明确的分层：

| 层 | 责任 |
|---|---|
| REPL | 拥有 turn state、stream state、runtime 入口 |
| Messages | transcript shaping + 高性能渲染 |

这样可以避免把复杂的 runtime orchestration 和 transcript rendering 糅在一个组件里。

---

## 5. Fullscreen / layout 协调

### 5.1 全屏布局壳

相关文件：
- `src/components/FullscreenLayout.tsx`

它提供：
- sticky scroll shell
- scrollable transcript region
- pinned bottom area
- overlay area
- floating bottom-right content
- modal / pane 支持

### 5.2 REPL 负责 layout mode orchestration

REPL 会维护：
- scroll refs
- repin behavior
- recent user scroll timing
- unseen divider state

并把这些交给 `FullscreenLayout`。

### 5.3 unseen divider 的设计值得注意

源码里 divider 逻辑被故意拆开：
- REPL 负责 divider index / 生命周期
- `FullscreenLayout` 直接订阅 scrollbox state 来决定 pill 可见性

这样做是为了：
- 避免滚动时频繁 re-render 整个 REPL
- 把滚动密集型状态局部化

这是典型的高频 UI 状态隔离优化。

---

## 6. Permission dialog：统一排队，不是到处弹窗

### 6.1 队列化设计

REPL 自己维护：
- `toolUseConfirmQueue`
- focused dialog state
- cancel / resolve 行为

这意味着权限确认不是工具自己随便弹的，而是统一汇入 REPL 的 dialog queue。

### 6.2 渲染组件

权限 UI 在：
- `src/components/permissions/PermissionRequest.tsx`

它会：
- 根据 tool 类型选择不同 permission component
- 触发延迟通知（`useNotifyAfterTimeout`）
- 在 fullscreen 下通过 sticky footer 固定回复操作

### 6.3 架构意义

这套设计说明权限系统在 UI 层是**中心化的**：
- local tool permission
- remote permission
- swarm/worker permission

最终都汇聚到统一 queue/render path。

所以权限确认不是工具子系统的一部分，而是 REPL orchestration 的核心一部分。

---

## 7. Notification 体系：共享通道，而非局部弹层

相关文件：
- `src/context/notifications.tsx`

### 7.1 Notification 的状态归属

REPL 通过：
- `useNotifications()`

拿到：
- `addNotification`
- `removeNotification`

而通知实际写入 AppState。

### 7.2 它支持的机制

- priority
- invalidation
- folding / merge
- queue processing
- timeout

### 7.3 设计含义

通知系统被做成了**共享 notification bus**，而不是组件内部 alert。

这让：
- prompt submit 流程
- permission timeout
- MCP connectivity
- IDE hint
- auto mode unavailable

都能复用一条统一通道。

---

## 8. AppState 在 REPL 中的角色

相关文件：
- `src/state/AppState.tsx`

REPL 同时使用：
- `useAppState(selector)`
- `useSetAppState()`
- `useAppStateStore()`

### 8.1 设计要点

AppState 不是简单全局对象，而是：
- 外部 store
- 按 selector 订阅切片
- `useSyncExternalStore`
- 避免整树无差别 re-render

### 8.2 REPL 为什么还保留大量本地 state

因为源码刻意把状态分成两类：

| 类型 | 位置 | 例子 |
|---|---|---|
| 跨组件/跨功能共享状态 | AppState | permission context、notifications、settings 派生状态 |
| 高度局部、turn 内瞬时状态 | REPL 本地 state | streamingText、modal open state、message actions state |

这是一个很合理的分工：
- 公共事实放 store
- 高频瞬时状态留组件本地

### 8.3 一个关键细节

`onQueryImpl` 中会在 turn 开始前把某些 permission context 更新直接写进 store，确保：
- `getAppState()` 在 query runtime 期间保持一致
- 不会因为 transient UI 状态造成 mid-turn permission context 漂移

说明 REPL 很重视 **turn consistency**。

---

## 9. 为什么说 REPL 是 orchestration hub

因为从源码看，它同时控制：
- input lifecycle
- message lifecycle
- stream lifecycle
- modal/dialog lifecycle
- permission lifecycle
- notification lifecycle
- fullscreen / scroll lifecycle
- local/remote runtime bridging

这类组件通常会变得很大，但它的“大”不是 accidental complexity，而是因为它承担了系统的 **interactive shell kernel** 职责。

---

## 10. 架构判断

如果把整个 Claude Code 看成一套终端 agent application，那么：

- `query.ts` = agent runtime kernel
- `REPL.tsx` = interactive shell host
- `Messages.tsx` = transcript rendering engine
- `FullscreenLayout.tsx` = layout shell
- `PermissionRequest.tsx` = approval UI surface
- `notifications.tsx` = user-facing event bus

也就是说，REPL 是把“模型 runtime”与“终端交互系统”真正缝起来的那层。

---

## 11. 关键文件索引

- `src/screens/REPL.tsx`
- `src/components/Messages.tsx`
- `src/components/FullscreenLayout.tsx`
- `src/components/permissions/PermissionRequest.tsx`
- `src/context/notifications.tsx`
- `src/state/AppState.tsx`
- `src/utils/handlePromptSubmit.js`

---

## 12. 一句话结论

REPL 不是聊天界面组件，而是 Claude Code 的 **终端交互编排内核**：负责把 prompt、query runtime、权限、通知、布局与 transcript 渲染组织成一个统一的用户交互系统。