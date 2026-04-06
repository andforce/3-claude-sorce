# Claude Code Settings / Remote Policy 架构深度解析

## 1. 定位

Claude Code 的 settings 架构不是简单“读几个 json 配置”。

从源码看，它是一套：
- 多来源 merge 系统
- policy winner-selection 系统
- remote managed settings cache 系统
- AppState 同步系统
- mode/policy 驱动行为改写系统

核心文件：
- `src/utils/settings/settings.ts`
- `src/utils/settings/applySettingsChange.ts`
- `src/utils/settings/changeDetector.ts`
- `src/utils/settings/mdm/settings.ts`
- `src/services/remoteManagedSettings/`

---

## 2. settings source 模型

源码定义了标准 source：
- `userSettings`
- `projectSettings`
- `localSettings`
- `flagSettings`
- `policySettings`

但这里最关键的点是：
- **policySettings 不是普通 merge source**

---

## 3. 合并规则：普通 source merge + policy first-wins

### 3.1 普通 source

整体 merge 顺序是：
- user → project → local → flag → policy

后者覆盖前者。

### 3.2 policy 特殊规则

`policySettings` 内部并不是把多个 policy source deep merge，而是：
- **第一个非空 policy source 直接获胜**

优先级大致是：
1. remote managed settings cache
2. admin MDM (`plist` / `HKLM`)
3. file-based managed settings
4. `HKCU` policy settings

### 3.3 设计意义

这说明 policy 层被设计成“单一生效来源”，避免多重企业管控来源互相覆盖造成难以解释的状态。

---

## 4. managed file 路径

源码中 managed settings 的平台默认路径：

- macOS: `/Library/Application Support/ClaudeCode`
- Windows: `C:\Program Files\ClaudeCode`
- Linux: `/etc/claude-code`

并且支持：
- `managed-settings.json`
- `managed-settings.d/*.json`

其中 drop-ins 会按字母顺序叠加到主文件上。

### 4.1 架构含义

这不是普通用户配置，而是典型的：
- system-level managed config
- ops/admin controlled config
- 可 drop-in overlay 的部署式配置结构

---

## 5. remote managed settings

相关目录：
- `src/services/remoteManagedSettings/`

### 5.1 本地缓存

remote settings 会缓存到：
- `~/.claude/remote-settings.json`

### 5.2 eligibility 不是默认 true

系统会单独计算 eligibility，以避免 settings/auth cycle。

要求包括：
- first-party provider
- first-party base URL
- 不是 `local-agent`
- 某些 OAuth enterprise/team 场景
- 或 API-key 用户场景

### 5.3 一个很关键的设计点

当 remote settings 首次从 cache 变为可见时：
- merged settings cache 会被 reset

目的是让后续读取重新把 remote policy 层计算进去。

这说明 remote settings 不是简单附加数据，而是会改变整个 settings merge 结果。

---

## 6. settings change 如何影响 AppState

核心文件：
- `src/utils/settings/applySettingsChange.ts`

### 6.1 变更流程

settings 变化后，系统会：

1. 重新读取 merged settings (`getInitialSettings()`)
2. 重新加载 permission rules
3. 刷新 hook config snapshot
4. 更新 `AppState.settings`
5. 重算 `toolPermissionContext`
6. 只在 setting 本身改变时同步 `effortLevel → effortValue`

### 6.2 设计意义

settings change 不是局部 patch，而是**重建一部分运行时配置视图**。

这说明：
- settings 是 runtime input
- app state 是 runtime projection

---

## 7. bypass / auto mode 如何被 policy 改写

### 7.1 post-processing

在 settings change 后，系统还会对 permission context 做二次后处理：
- strip dangerous broad bash rules
- 如果 policy 禁用了 bypass，则把 context 改成 disabled-bypass context
- 调用 `transitionPlanAutoMode()` 协调 plan/auto mode 生命周期

### 7.2 这意味着什么

settings 不只是设置值，还会触发：
- mode 可用性变化
- 安全规则有效集变化
- UI 行为变化

所以它更像一个“运行时策略输入层”。

---

## 8. trusted-source gating

源码里一些高敏感设置不能被低信任来源控制，例如：
- `skipDangerousModePermissionPrompt`
- `skipAutoPermissionPrompt`
- `useAutoModeDuringPlan`
- `autoMode`

它们会忽略 `projectSettings`。

### 8.1 为什么重要

这是为了防止恶意仓库通过项目设置静默改变用户安全姿态。

### 8.2 架构意义

settings 系统并不把所有 source 一视同仁，而是带有 **信任等级模型**。

---

## 9. change detection

核心文件：
- `src/utils/settings/changeDetector.ts`

### 9.1 检测内容

系统会 watch：
- 普通 settings 文件
- `managed-settings.d/*.json`

此外还会定期 poll：
- plist
- HKLM
- HKCU

大约每 30 分钟一次。

### 9.2 为什么这样设计

因为：
- 文件可以 fs watch
- MDM / registry 变更不一定适合统一 watch
- policy 设置可能来自外部系统注入

所以 change detection 是混合式：
- 文件监听
- 定时轮询
- 程序内显式 `notifyChange('policySettings')`

---

## 10. settings 架构的真实角色

从源码看，settings 层不是“配置解析器”，而是：

- layered config merger
- trust-aware policy resolver
- remote managed cache bridge
- AppState rehydration trigger
- permission/mode behavior input

这已经非常接近一套终端应用的 **policy control plane**。

---

## 11. 关键文件索引

- `src/utils/settings/settings.ts`
- `src/utils/settings/applySettingsChange.ts`
- `src/utils/settings/constants.ts`
- `src/utils/settings/managedPath.ts`
- `src/utils/settings/mdm/settings.ts`
- `src/utils/settings/changeDetector.ts`
- `src/services/remoteManagedSettings/syncCache.ts`
- `src/services/remoteManagedSettings/syncCacheState.ts`
- `src/state/AppState.tsx`

---

## 12. 一句话结论

Claude Code 的 settings 架构本质上是一套带信任等级、远程受管缓存、策略优先级与 AppState 重建能力的 **运行时策略控制平面**。