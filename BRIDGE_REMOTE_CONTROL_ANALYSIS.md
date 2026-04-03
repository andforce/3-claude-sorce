# Claude Code Bridge / Remote Control 架构深度解析

## 1. 定位

Bridge / Remote Control 不是“把终端转发到网页”的简单功能。

从源码看，它包含两套相关但不同的运行路径：

1. **standalone remote-control server**
2. **REPL bridge**

同时还存在：
- env-based orchestration
- env-less REPL fast path
- v1 / v2 transport 分流

核心目录：
- `src/bridge/`

---

## 2. CLI 入口：专门的 fast path

入口文件：
- `src/entrypoints/cli.tsx`

### 2.1 fast path 特征

命令：
- `claude remote-control`
- `claude rc`
- `claude remote`
- `claude sync`
- `claude bridge`

这些在 CLI 启动时被提前拦截，不走完整主应用加载流程。

### 2.2 启动前 gating

会先检查：
- OAuth token 存在
- feature/gate
- minimum version
- org policy limit

通过后才进入：
- `bridgeMain(args.slice(1))`

### 2.3 架构意义

这说明 bridge 在系统里是一个**一级运行模式**，而不是 REPL 内的小功能。

---

## 3. standalone remote-control server

关键文件：
- `src/bridge/bridgeMain.ts`

### 3.1 `bridgeMain` 的职责

它负责：
- 解析 flags
- 校验 trust / auth / policy
- 解析 spawn mode
- 注册 bridge environment
- 可选预创建 initial session
- 进入 `runBridgeLoop`

### 3.2 spawn mode

可支持：
- `single-session`
- `same-dir`
- `worktree`

说明远控不是单一 session 模式，而是支持不同本地宿主策略。

---

## 4. `runBridgeLoop`：真正的环境服务器

### 4.1 主要职责

`runBridgeLoop` 做的是：
- poll work item
- ACK work
- spawn / reconnect 本地 Claude child session
- heartbeat active work
- capacity/backoff 管理
- shutdown 时 archive / deregister

### 4.2 设计含义

这已经不是普通“长连接桥接”，而是一个：
- work-dispatch loop
- session broker
- local child session orchestrator

本质上非常像一个环境代理进程。

---

## 5. 控制平面与数据平面分离

这是这套架构最关键的点之一。

### 5.1 控制平面

环境/work-dispatch 负责：
- work item 分发
- session assignment
- work secret 下发
- heartbeat / ack / archive

### 5.2 数据平面

单个 session 实际可用两种通路：
- v1 session-ingress / HybridTransport
- v2 CCR transport

server 会根据：
- `secret.use_code_sessions`
- 本地 env override

决定使用哪条路径。

### 5.3 架构意义

这不是单协议 bridge，而是：
- environment orchestration layer
- per-session transport layer

分离架构。

---

## 6. REPL bridge：单 session、本地宿主化桥接

相关文件：
- `src/hooks/useReplBridge.tsx`
- `src/bridge/initReplBridge.ts`
- `src/bridge/replBridge.ts`

### 6.1 REPL path 不走 `bridgeMain`

REPL/auto-start 不用 standalone remote-control server 路径。

而是：
- `useReplBridge` 动态 import `initReplBridge`
- print/SDK 模式下也可触发

### 6.2 `initReplBridge` 是 wrapper

它负责：
- 读取 bootstrap/session state
- 检查 gates/auth/policy
- 推导 session title
- 选择 env-less 或 env-based 实现
- 调到真正 core

### 6.3 设计含义

REPL bridge 是 bridge 子系统里的另一条分支，不是 `bridgeMain` 的简单 UI 包装。

---

## 7. env-based REPL bridge

核心文件：
- `src/bridge/replBridge.ts`

### 7.1 它做什么

- 注册一个 environment
- 注册一个 session
- 写 crash-recovery pointer
- 启动持续 work poll loop

### 7.2 当 work 到达

它会：
- 校验 session
- ACK work
- 记录 ingress token / work ID
- 建 transport
  - v1: `HybridTransport`
  - v2: `createV2ReplTransport`

然后暴露 bridge handle：
- `writeMessages`
- `writeSdkMessages`
- control request/response
- teardown

### 7.3 架构判断

它和 standalone bridge 的区别在于：
- 它更贴近现有 REPL session
- 是单-session in-process host
- 但仍复用了 env/work-dispatch 模型

---

## 8. env-less REPL bridge：新 fast path

核心文件：
- `src/bridge/remoteBridgeCore.ts`

### 8.1 它跳过了什么

它会跳过：
- environment registration
- work poll
- ack / heartbeat

### 8.2 它怎么做

- 直接创建 code session
- 调 `/bridge` 获取 `worker_jwt` + epoch
- 只使用 v2 transport
- JWT refresh 时原位重建 transport
- teardown 时直接 archive session

### 8.3 架构意义

这是 REPL bridge 的“轻量直接连接模式”。

可理解为：
- standalone bridge = full environment server mode
- repl env-based bridge = REPL host + env orchestration mode
- repl env-less bridge = REPL direct session mode

---

## 9. transport 抽象层

核心文件：
- `src/bridge/replBridgeTransport.ts`

### 9.1 统一接口

定义：
- `ReplBridgeTransport`

### 9.2 两种 adapter

#### v1
- 包装 `HybridTransport`

#### v2
- 组合 `SSETransport` + `CCRClient`
- 处理 worker registration / epoch
- sequence carryover
- heartbeat
- delivery / state report

### 9.3 设计价值

桥接上层不用关心 transport 细节，只依赖统一 `ReplBridgeTransport`。

这是一层明确的 transport abstraction。

---

## 10. REPL message flow：真正的双向桥

### 10.1 outbound

本地 REPL message 会：
- filter / dedupe
- initial flush
- 通过 active transport 发出

### 10.2 inbound

远端消息会：
- 通过 `handleIngressMessage` 解析
- 再由 `useReplBridge` 注入本地 prompt/message queue

### 10.3 control / permission traffic

控制请求、取消、权限相关流量也会经过同一 bridge transport。

### 10.4 架构意义

这说明 bridge 传的不是单一“聊天消息”，而是：
- user messages
- sdk messages
- control messages
- permission responses
- session lifecycle signals

所以它是一个 **multiplexed session protocol host**。

---

## 11. global bridge handle

相关文件：
- `src/bridge/replBridgeHandle.ts`

作用：
- 存储当前活动 bridge handle
- 让 hook tree 外的工具/命令也能访问当前 remote session

说明 bridge 并不完全局限在 React 生命周期内，还需要全局可达句柄。

---

## 12. 架构判断

Claude Code 的 bridge / remote control 架构，可以理解成：

```text
CLI fast-path / REPL hook
  → gating
  → env-based or env-less bridge core
  → session registration / worker auth
  → transport abstraction (v1/v2)
  → bidirectional multiplexed message/control flow
```

它不是“终端镜像”，而是一套：
- remote session broker
- transport-adapted bridge runtime
- REPL/standalone 双宿主远控系统

---

## 13. 关键文件索引

- `src/entrypoints/cli.tsx`
- `src/bridge/bridgeMain.ts`
- `src/bridge/replBridge.ts`
- `src/bridge/initReplBridge.ts`
- `src/bridge/remoteBridgeCore.ts`
- `src/bridge/replBridgeTransport.ts`
- `src/bridge/replBridgeHandle.ts`
- `src/bridge/bridgeMessaging.ts`
- `src/hooks/useReplBridge.tsx`

---

## 14. 一句话结论

Claude Code 的 bridge/remote-control 不是远程终端镜像，而是一套支持 standalone 与 REPL 双入口、env/v2 多路径和双向控制消息复用的 **远程会话桥接运行时**。