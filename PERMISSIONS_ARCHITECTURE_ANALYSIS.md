# Claude Code Permissions 架构深度解析

## 1. 定位

Claude Code 的权限系统不是简单“工具执行前弹个确认框”。

从源码看，它是一套完整的：
- 规则系统
- 模式系统
- classifier-backed 决策系统
- denial tracking 系统
- UI confirmation 系统

核心文件涉及：
- `src/types/permissions.ts`
- `src/utils/permissions/permissions.ts`
- `src/utils/permissions/permissionSetup.ts`
- `src/utils/permissions/denialTracking.ts`
- `src/components/permissions/`

---

## 2. 核心状态：`ToolPermissionContext`

权限系统的事实中心是：
- `ToolPermissionContext`

它包含：
- 当前 mode
- allow/deny/ask 规则
- additional working directories
- bypass/auto mode availability
- stripped dangerous rules
- 是否避免 permission prompt
- prePlanMode 记录

也就是说，工具权限不是每次独立现算，而是挂在 session/app state 里的共享上下文。

---

## 3. 主决策流：不是单一 if，而是 fail-closed pipeline

主决策入口在：
- `src/utils/permissions/permissions.ts`

### 3.1 决策顺序

源码里基本是这套 pipeline：

1. **hard blockers first**
   - whole-tool deny rules
   - whole-tool ask rules
   - tool-specific `checkPermissions()`
   - safety check 类型返回

2. **mode / rule fast path**
   - bypass 直接 allow
   - 某些 plan-mode 场景继承 bypass 可用性
   - whole-tool allow rule 直接 allow

3. **passthrough 转 ask**
   - 如果 tool 返回 passthrough，会转换成 ask

4. **post-processing**
   - `dontAsk`：把 ask 变 deny
   - `auto`：尽量转 classifier 判定
   - `shouldAvoidPermissionPrompts`：无 UI 场景直接 deny

### 3.2 设计含义

它不是“允许/拒绝规则表”，而是：
- ordered policy pipeline
- fail-closed by default
- 最终才能决定 allow / ask / deny / passthrough

---

## 4. mode 系统

### 4.1 三个基础模式

- `default`
- `auto`
- `bypass`

### 4.2 语义差异

| 模式 | 语义 |
|---|---|
| `default` | 普通确认流 |
| `auto` | 优先 classifier 决策，尽量减少交互 |
| `bypass` | 跳过大部分权限确认 |

但要注意：
- bypass 也不是万能，有些 safety check 仍可能不可绕过
- auto 也不是直接 allow，而是 classifier-backed allow/deny

---

## 5. dangerous rule stripping

这是整个权限系统里最关键的安全设计之一。

关键文件：
- `src/utils/permissions/permissionSetup.ts`

### 5.1 为什么需要 strip

在 auto/classifier mode 里，如果用户已有非常宽泛的 allow 规则，例如：
- `Bash(*)`
- `Bash(python:*)`
- `PowerShell(iex:*)`
- `Agent(*)`

那么 classifier 根本没有机会介入。

这会让 auto mode 失去安全意义。

### 5.2 系统怎么做

`stripDangerousPermissionsForAutoMode()` 会：
- 从 in-memory permission context 中剥离这些危险 allow rule
- 存入 `strippedDangerousRules`

离开相关模式时，再通过：
- `restoreDangerousPermissions()`

恢复。

### 5.3 设计意义

这说明 mode 切换并不只是改一个枚举值，而是会**重写当前 permission context 的有效规则集**。

---

## 6. denial tracking

关键文件：
- `src/utils/permissions/denialTracking.ts`

### 6.1 跟踪什么

系统记录：
- `consecutiveDenials`
- `totalDenials`

阈值大致是：
- 连续 3 次 denial
- 总计 20 次 denial

### 6.2 用途

在 auto mode 中：
- classifier deny → `recordDenial()`
- allow → `recordSuccess()`

超过阈值后：
- interactive context：回退到 prompt
- headless context：直接 abort

### 6.3 为什么重要

这说明 auto mode 不是死板的自动决策，而是会依据用户持续拒绝行为自适应退回人工确认。

它本质上是一个 **human resistance feedback loop**。

---

## 7. 规则来源与合并

权限规则不是单一来源，而是按 source 归类维护。

来源包括：
- `userSettings`
- `projectSettings`
- `localSettings`
- `flagSettings`
- `policySettings`
- `cliArg`
- `command`
- `session`

并且在 `ToolPermissionContext` 中按：
- allow
- deny
- ask

分别存储。

### 7.1 架构含义

这不是普通 ACL list，而是带 provenance 的规则图。

这样做的价值：
- UI 能解释规则从哪来
- mode transition 能只改某些来源的规则
- policy 管理能有更高优先级

---

## 8. 权限如何传播到 tools

### 8.1 传播路径

- `AppState.toolPermissionContext`
- `ToolUseContext.getAppState()`
- tool 的 `checkPermissions()`

工具不会自己维护独立权限状态，而是统一读共享 permission context。

### 8.2 `Tool.ts` 的角色

`src/Tool.ts` 负责把权限上下文暴露进工具执行环境：
- `getAppState`
- `setAppState`
- `localDenialTracking`

这让：
- 主线程
- async subagent
- 无 UI 子进程

都能复用同一套权限判定框架。

---

## 9. UI 确认层

### 9.1 入口

相关文件：
- `src/components/permissions/PermissionRequest.tsx`
- `src/components/permissions/PermissionDialog.tsx`
- `src/components/permissions/PermissionPrompt.tsx`

### 9.2 特征

权限 UI 不是单一对话框，而是：
- 通用 dialog shell
- tool-specific request component
- fullscreen sticky footer 支持
- delayed notification 提醒
- allow/reject + permissionUpdates 回写

### 9.3 工具专用组件

例如：
- `BashPermissionRequest`
- 文件权限相关 handler

它们会读取当前 `toolPermissionContext` 来解释：
- 当前规则
- classifier 状态
- 当前动作会如何影响规则更新

说明 UI 不是只展示确认按钮，而是权限模型的解释层。

---

## 10. 架构判断

Claude Code 权限系统可抽象成：

```text
settings/policy rules
  → permission context
  → ordered decision pipeline
  → mode-specific rewriting
  → classifier / denial tracking
  → UI confirmation
  → rule updates back into context
```

这是一套完整的：
- policy engine
- safety gate
- adaptive feedback loop
- UI mediation system

而不是“执行前问一下用户”。

---

## 11. 关键文件索引

- `src/types/permissions.ts`
- `src/utils/permissions/permissions.ts`
- `src/utils/permissions/permissionSetup.ts`
- `src/utils/permissions/denialTracking.ts`
- `src/Tool.ts`
- `src/components/permissions/PermissionRequest.tsx`
- `src/components/permissions/PermissionDialog.tsx`
- `src/components/permissions/PermissionPrompt.tsx`

---

## 12. 一句话结论

Claude Code 的权限架构是一套带规则来源、模式切换、危险规则剥离、classifier 与 denial feedback 的 **分层安全决策系统**。