# Claude Code Policy Limits 架构深度解析

## 1. 定位

`src/services/policyLimits/` 这套系统不是泛化 settings，也不是 permissions 子集。

它是一个更轻量、更聚焦的：
- org capability restriction map
- centralized fetch/cache service
- feature entry-point gating layer

也就是说，它更像“功能能力限制平面”，而不是工具权限平面。

---

## 2. 核心接口

核心文件：
- `src/services/policyLimits/index.ts`

主要暴露：
- `loadPolicyLimits()`
- `waitForPolicyLimitsToLoad()`
- `isPolicyAllowed(policy)`

这表明 policy limits 的使用方式非常直接：
- 启动时预加载
- 功能入口处同步判断

---

## 3. eligibility：不是所有环境都会拉 policy

### 3.1 前置资格

`isPolicyLimitsEligible()` 会先限制拉取资格：
- 必须 first-party Anthropic traffic
- 禁止 custom base URL
- 禁止 3P provider
- 还要求 real API key 或 Claude.ai OAuth
- OAuth 用户还要具备合适 scope 和 Team/Enterprise 订阅条件

### 3.2 架构意义

policy limits 明显是面向 Anthropic 自己控制面的，不是 provider-agnostic 通用配置机制。

---

## 4. 启动模型：提前初始化 promise

相关文件：
- `src/entrypoints/init.ts`

系统会在启动早期调用：
- `initializePolicyLimitsLoadingPromise()`

### 4.1 为什么这样做

目的是：
- 让其他子系统可以 await policy available
- 避免启动期循环依赖
- 保持调用点简单

### 4.2 架构意义

这是一种 startup-time shared async dependency 模型。

---

## 5. fetch / cache / persistence

### 5.1 拉取方式

`loadPolicyLimits()` 会：
- 使用 API key 或 OAuth header
- 必要时 refresh OAuth
- 调 `/api/claude_code/policy_limits`
- 用 Zod 校验 response
- 带 retry/backoff

### 5.2 响应语义

- `200` → fresh restrictions
- `304` → 用 cache
- `404` → 视为无 restrictions / 功能关闭，归一化为空限制

### 5.3 本地缓存

缓存会：
- 保存在内存
- 持久化到 `~/.claude/policy-limits.json`
- 权限 0600
- 使用 checksum / `If-None-Match` 做一致性
- 每 1 小时后台 poll 更新

### 5.4 架构意义

这套 service 明显被做成：
- centralized policy cache service

而不是各功能自行请求后端。

---

## 6. fail-open 设计

### 6.1 缺省语义

schema 是稀疏的：
- 只有被阻止的 policy 才需要出现
- key 缺失 = allowed

`isPolicyAllowed(policy)` 也默认：
- unknown / unavailable → true

### 6.2 设计判断

这意味着 policy limits 默认是 fail-open，而不是 fail-closed。

### 6.3 例外

在 essential-traffic-only 模式下：
- `allow_product_feedback`

会在 cache miss 时 fail-closed。

原因是隐私/合规场景下不能因缓存失效而重新放开反馈能力。

---

## 7. remote control / remote sessions 的 enforcement

### 7.1 `allow_remote_control`

会在：
- `src/entrypoints/cli.tsx`
- `src/bridge/initReplBridge.ts`

等入口显式检查。

若被禁用：
- CLI fast path 直接退出并提示 org policy 错误
- REPL bridge 初始化也会拒绝

### 7.2 `allow_remote_sessions`

会在：
- `src/main.tsx` 的 `--remote` / `--teleport`
- `src/utils/background/remote/remoteSession.ts`
- `/remote-setup`
- `/remote-env`
- `RemoteTriggerTool`

等位置生效。

### 7.3 架构意义

policy limits 不是中间层透明拦截，而是：
- 在 feature entry point 显式 gate

这种做法简单、清晰、好解释。

---

## 8. auto / bypass 不完全属于这套 service

这是很容易误判的一点。

### 8.1 bypass / auto 的真实路径

虽然它们也是“能力限制”，但并不主要依赖 `src/services/policyLimits`。

它们更多走：
- `src/utils/permissions/permissionSetup.ts`
- GrowthBook / security restriction gate
- `bypassPermissionsKillswitch.ts`
- `verifyAutoModeGateAccess()`

### 8.2 架构意义

系统里其实存在两种不同的 capability gating：

1. **policyLimits 路径**
   - 面向 org capability restriction map
   - 典型用于 remote control / remote session / product feedback

2. **permissions/security gate 路径**
   - 面向 bypass / auto 这类更敏感能力
   - 与 permission context / mode lifecycle 更紧密耦合

这两者是相邻体系，但不是同一套机制。

---

## 9. login 后的刷新行为

在登录后，系统会：
- refresh remote managed settings
- refresh policy limits
- 重新执行 bypass/auto kill-switch 检查

### 9.1 为什么重要

因为 org 变化后：
- policy capability
- remote settings
- dangerous mode availability

都可能立刻改变。

说明 policy limits 不是静态 session 常量，而是与身份/org 状态相关的动态能力图。

---

## 10. 架构判断

Claude Code 的 policy limits 架构可以抽象成：

```text
eligibility check
  → centralized fetch/cache
  → sparse restriction map
  → entry-point gating in features
```

它不是完整的安全/权限系统，而是一个：
- 组织级功能可用性限制层
- 轻量、集中、显式检查的 capability gate

---

## 11. 关键文件索引

- `src/services/policyLimits/index.ts`
- `src/services/policyLimits/types.ts`
- `src/entrypoints/init.ts`
- `src/entrypoints/cli.tsx`
- `src/bridge/initReplBridge.ts`
- `src/main.tsx`
- `src/utils/background/remote/remoteSession.ts`
- `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts`
- `src/utils/permissions/permissionSetup.ts`

---

## 12. 一句话结论

Claude Code 的 policy limits 不是通用权限系统，而是一套面向组织能力开关、以集中缓存和功能入口显式检查为核心的 **功能限制控制层**。