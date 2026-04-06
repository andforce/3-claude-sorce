# Claude Code 数据收集与追踪系统深度解析

> 涵盖遥测架构、数据流向、事件体系、隐私控制、外部端点等全部追踪机制

---

## 一、系统总览

Claude Code 的数据收集不是一个单独的 analytics SDK，而是一套**分层、多通路、多信号**的遥测平台。

```
┌──────────────────────────────────────────────────────────────────────┐
│                        logEvent() 公共 API                           │
│  (startup-safe: sink 未就绪时事件排队)                                  │
├──────────────────────────────────────────────────────────────────────┤
│                      统一 enrichment 层                               │
│  metadata.ts: 环境/会话/模型/代理/进程指标                              │
├──────────────────────────────────────────────────────────────────────┤
│                      统一 sampling 层                                 │
│  GrowthBook tengu_event_sampling_config                              │
├──────────┬───────────────────────┬───────────────────────────────────┤
│  Datadog │    1P Event Logging   │     OpenTelemetry (3P/内部)        │
│  (运维)   │    (高保真分析)         │    metrics / logs / traces        │
│  US5     │    BigQuery 列         │    OTLP / Prometheus / Perfetto   │
├──────────┴───────────────────────┴───────────────────────────────────┤
│                       控制平面                                        │
│  隐私级别 / 组织 opt-out / sink 熔断 / 编译期 feature gate              │
└──────────────────────────────────────────────────────────────────────┘
```

核心目录：
- `src/services/analytics/` — 事件收集与分发
- `src/utils/telemetry/` — OTel 信号与 BigQuery 导出
- `src/utils/privacyLevel.ts` — 隐私级别控制
- `src/services/api/metricsOptOut.ts` — 组织级 metrics 开关

---

## 二、事件收集架构

### 2.1 公共入口

**文件**: `src/services/analytics/index.ts`

对外暴露极薄的 API：
- `logEvent(name, metadata)` — 同步打点
- `logEventAsync(name, metadata)` — 异步打点（当前实现等价同步）
- `attachAnalyticsSink(sink)` — 附着后端

设计特点：
- 无依赖、无 import cycle
- 启动早期即可打点，事件排队等 sink 初始化后统一 drain
- TypeScript 类型系统强制 PII 标记（见下文）

### 2.2 Sink fanout

**文件**: `src/services/analytics/sink.ts`

```typescript
function logEventImpl(eventName, metadata) {
  const sampleResult = shouldSampleEvent(eventName)
  if (sampleResult === 0) return

  // Datadog: 剥离 _PROTO_* 后发送
  if (shouldTrackDatadog()) {
    trackDatadogEvent(eventName, stripProtoFields(metadata))
  }

  // 1P: 完整 payload（含 _PROTO_*）
  logEventTo1P(eventName, metadata)
}
```

关键设计：
- **采样在 fanout 前统一执行**，保证不同 backend 看到同一批事件
- GrowthBook `tengu_event_sampling_config` 驱动采样率

### 2.3 Enrichment 层

**文件**: `src/services/analytics/metadata.ts`

`getEventMetadata()` 是所有事件的**单一事实源**。它收集：
- session/process identity
- model / betas
- environment context
- process metrics (RSS, heap, CPU)
- agent hierarchy (teammate/subagent/standalone)
- repo-join key (`rh`)
- subscription type
- SWE-bench identifiers

1P 输出进一步分层为 `env` / `process` / `core` / `auth` / `additional` 五个 namespace。

---

## 三、收集的数据类型

### 3.1 环境元数据

**文件**: `src/services/analytics/metadata.ts:417-451`

```typescript
type EnvContext = {
  platform: string           // mac/linux/windows
  platformRaw: string        // 含 freebsd/openbsd
  arch: string               // arm64/x64
  nodeVersion: string
  terminal: string | null    // iTerm/VS Code/Hyper 等
  packageManagers: string    // npm,pnpm,yarn,brew...
  runtimes: string           // node,bun,python...
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  coworkerType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string               // git/hg/svn
}
```

### 3.2 进程运行指标

```typescript
type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}
```

### 3.3 用户身份标识

**文件**: `src/utils/config.ts`, `src/utils/auth.ts`, `src/utils/user.ts`

| 标识符 | 来源 | 持久性 | 说明 |
|-------|------|--------|------|
| `userID` (device_id) | `~/.claude/config.json` | 永久 | `randomBytes(32).toString('hex')` |
| `sessionId` | 启动时生成 | 单次会话 | 每次进程启动新建 |
| `accountUuid` | Claude.ai OAuth | 账户级 | `_PROTO_*` PII 标记 |
| `organizationUuid` | 企业 OAuth | 组织级 | `_PROTO_*` PII 标记 |
| `email` | OAuth profile | 账户级 | `_PROTO_*` PII 标记 |
| `subscriptionType` | OAuth | 账户级 | max/pro/enterprise/team |
| `userType` | 环境变量 | 构建级 | 'ant' 或空 |

设备 ID 生成：
```typescript
export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) return config.userID
  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}
```

**不是浏览器指纹**，是纯随机持久化 ID。

### 3.4 仓库标识

**文件**: `src/services/analytics/metadata.ts`

```typescript
// 远程 URL 的 SHA256 前 16 字符
const getRepoRemoteHash = memoize(async () => {
  const remote = await getDefaultRemoteUrl()
  if (!remote) return undefined
  return createHash('sha256').update(remote).digest('hex').slice(0, 16)
})
```

用于服务端仓库数据关联，不暴露实际 URL。

### 3.5 代理层级标识

```typescript
type AgentIdentification = {
  agentId?: string           // agentName@teamName 或 subagent UUID
  parentSessionId?: string   // team lead 的 session
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
}
```

---

## 四、数据传输通路

### 4.1 Datadog 路径

**文件**: `src/services/analytics/datadog.ts`

```
目标: https://http-intake.logs.us5.datadoghq.com/api/v2/logs
鉴权: DD-API-KEY (内置 client token: pubbbf48e6d78dae54bceaa4acf463299bf)
```

特征：
- 固定 allowlist 事件名才上报
- 仅生产环境 + 仅 first-party API provider
- 高基数字段降维（MCP 工具名归一化、外部模型名桶化）
- 用户标识用 `userBucket` 而非直接 ID
- GrowthBook gate `tengu_log_datadog_events` 控制开关

定位：**运维监控** — dashboard / alert / aggregates，不追求完整事件保真。

### 4.2 1P Event Logging 路径

**文件**: `src/services/analytics/firstPartyEventLogger.ts`, `firstPartyEventLoggingExporter.ts`

```
目标: https://api.anthropic.com/api/event_logging/batch
鉴权: Anthropic auth headers（失败时尝试 unauthenticated）
```

特征：
- 独立 OTel LoggerProvider（与客户 OTLP endpoint 隔离）
- 失败 batch 落盘 `~/.claude/telemetry/` 为 JSONL
- 下次启动重试残留文件
- backoff + 401 后 unauthenticated retry
- sink killswitch 远程动态关闭

定位：**高保真内部事件分析** — durable delivery layer。

### 4.3 BigQuery 内部指标

**文件**: `src/utils/telemetry/bigqueryExporter.ts`

```
目标: https://api.anthropic.com/api/claude_code/metrics
鉴权: Anthropic auth headers
```

特征：
- 仅 API 客户 / C4E / Teams 用户启用
- DELTA 时序聚合
- 5 分钟导出间隔
- 受组织级 metrics opt-out 控制
- 不同于 1P 事件路径，这是 OTel metrics 信号

### 4.4 GrowthBook 远程配置

**文件**: `src/services/analytics/growthbook.ts`, `src/constants/keys.ts`

```
目标: https://api.anthropic.com/ (GrowthBook SDK 管理路径)
Client Keys:
  - 外部用户: sdk-zAZezfDKGoZuXXKe
  - 内部用户: sdk-xRVcrliHIlrg4og4 / sdk-yZQvlplybuXjYh6L (dev)
```

功能：
- 远程 feature flag 评估
- 动态配置（采样率、sink killswitch）
- 实验曝光写入 1P（`logGrowthBookExperimentTo1P`）
- 本地缓存 + 磁盘持久化
- Statsig 命名兼容 API（`checkStatsigFeatureGate_*`），但**无 Statsig SDK**

### 4.5 组织级 Metrics 开关

**文件**: `src/services/api/metricsOptOut.ts`

```
目标: https://api.anthropic.com/api/claude_code/organizations/metrics_enabled
```

双级缓存：
- 磁盘缓存 24h TTL — 进程重启存活，N 次 `claude -p` 合并为 ~1 次/天 API 调用
- 内存缓存 1h TTL — 进程内去重

essential-traffic 模式下不请求。

### 4.6 3P 客户 OTel 导出

**文件**: `src/utils/telemetry/instrumentation.ts`

客户可配置的 OpenTelemetry 导出，支持三个信号：

| 信号 | 环境变量 | 协议 |
|------|---------|------|
| Metrics | `OTEL_METRICS_EXPORTER` | gRPC / HTTP JSON / HTTP Protobuf / Prometheus |
| Logs | `OTEL_LOGS_EXPORTER` | gRPC / HTTP JSON / HTTP Protobuf |
| Traces | `OTEL_TRACES_EXPORTER` | gRPC / HTTP JSON / HTTP Protobuf |

需通过 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 启用。

支持 proxy、mTLS、CA 证书、动态 headers（`otelHeadersHelper`）。

### 4.7 Beta 会话追踪

**文件**: `src/utils/telemetry/sessionTracing.ts`, `betaSessionTracing.ts`

- `ENABLE_BETA_TRACING_DETAILED=1` + `BETA_TRACING_ENDPOINT` 启用
- LLM 调用 / 工具执行级 span
- 内容截断策略
- 独立于主 OTLP 通道

### 4.8 Perfetto 本地追踪

**文件**: `src/utils/telemetry/perfettoTracing.ts`

- `CLAUDE_CODE_PERFETTO_TRACE=1` 或 `=<path>` 启用
- 本地 CPU profiling，不发送到远端

---

## 五、PII 处理与隐私策略

### 5.1 类型标记系统

**文件**: `src/services/analytics/index.ts`

```typescript
// 强制开发者显式确认数据安全
type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

// PII 标记字段 — 仅发送到 BigQuery 特权列
type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

使用 `_PROTO_*` 前缀标记高敏字段：

```typescript
const payload = {
  '_PROTO_userEmail': email as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  '_PROTO_accountId': accountId as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
}
```

处理流程：
1. **普通字段** → Datadog（`stripProtoFields()` 剥离后） + BigQuery JSON blob
2. **`_PROTO_*` 字段** → 仅 1P exporter 提升到 BigQuery 特权列

### 5.2 工具名脱敏

```typescript
function sanitizeToolNameForAnalytics(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp_tool'
  return toolName
}
```

例外（保留完整 MCP 信息）：
- Cowork 模式 (`entrypoint=local-agent`)
- Claude.ai 代理连接器
- 官方 MCP 注册表 URL
- 内建 MCP server

### 5.3 文件操作脱敏

**文件**: `src/utils/fileOperationAnalytics.ts`

```typescript
// 路径 → SHA256 前 16 字符
hashFilePath(filePath) → createHash('sha256').update(filePath).digest('hex').slice(0, 16)

// 内容 → SHA256 完整 64 字符（≤100KB 限制）
hashFileContent(content) → createHash('sha256').update(content).digest('hex')
```

不传原始路径和内容，只传 hash。

### 5.4 插件名脱敏

**文件**: `src/utils/telemetry/pluginTelemetry.ts`

双列隐私模式：
- `plugin_name_redacted`: 官方插件保留名称，第三方显示 `'third-party'`
- `_PROTO_plugin_name`: 原始名称，PII 标记
- `plugin_id_hash`: `sha256(name@marketplace + FIXED_SALT)` 前 16 字符，提供不泄露隐私的聚合 key

### 5.5 插件网络获取追踪

**文件**: `src/utils/plugins/fetchTelemetry.ts`

主机名桶化：只对已知公共主机（github.com、gitlab.com 等 10 个）保留名称，其余一律归为 `'other'`。

### 5.6 OTel 事件内容控制

**文件**: `src/utils/telemetry/events.ts`

```typescript
function isUserPromptLoggingEnabled() {
  return isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
}

function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}
```

用户提示词内容默认不记录，需显式 `OTEL_LOG_USER_PROMPTS=1`。

---

## 六、隐私控制体系

### 6.1 三级隐私级别

**文件**: `src/utils/privacyLevel.ts`

| 级别 | 触发环境变量 | 效果 |
|-----|------------|------|
| `default` | 无 | 全部启用 |
| `no-telemetry` | `DISABLE_TELEMETRY` | 禁用 Datadog + 1P 事件 + 反馈调查 |
| `essential-traffic` | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用一切非必要网络流量（遥测 + 自动更新 + grove + release notes + 模型能力查询等） |

多个信号取最严格级别。

### 6.2 Analytics 总开关

**文件**: `src/services/analytics/config.ts`

以下场景禁用 analytics：
- 测试环境 (`NODE_ENV=test`)
- 第三方云提供商 (Bedrock/Vertex/Foundry)
- 隐私级别为 no-telemetry 或 essential-traffic

### 6.3 Sink 熔断

**文件**: `src/services/analytics/sinkKillswitch.ts`

GrowthBook 动态配置，可按 sink 级别远程关闭：
- `datadog` sink
- `firstParty` sink

### 6.4 组织级 Metrics Opt-Out

**文件**: `src/services/api/metricsOptOut.ts`

组织管理员可通过服务端设置 `metrics_logging_enabled=false`，BigQuery exporter 会跳过导出。

### 6.5 编译期 Feature Gate

`build.ts` 中定义的遥测相关编译期开关：
- `COWORKER_TYPE_TELEMETRY`
- `ENHANCED_TELEMETRY_BETA`
- `MEMORY_SHAPE_TELEMETRY`

通过 `bun:bundle` 的 `feature()` 实现死代码消除。

---

## 七、数据分类与保护矩阵

| 级别 | 数据类型 | 处理方式 | 示例 |
|-----|---------|---------|------|
| 公开 | 版本号、平台类型、架构 | 直接记录 | `version: "2.1.88"` |
| 低风险 | 包管理器列表、终端类型、CI 标志 | 直接记录 | `terminal: "vscode"` |
| 中风险 | MCP 服务器名、仓库哈希、插件名 | 条件记录/脱敏/hash | `rh: "a1b2c3..."`, `mcp_tool` |
| 高风险 | 邮箱、账户 ID | `_PROTO_*` PII 标记，仅 BigQuery 特权列 | `_PROTO_userEmail` |
| 最高风险 | 代码内容、文件路径 | SHA256 hash 或不记录 | `filePathHash`, `contentHash` |
| 用户提示词 | 输入内容 | 默认 `<REDACTED>`，需 `OTEL_LOG_USER_PROMPTS=1` | — |

保护措施叠加：
1. **编译时**: TypeScript 类型强制标记 PII
2. **运行时**: 脱敏函数 + hash + 桶化
3. **传输时**: `_PROTO_*` 字段分流，Datadog 侧剥离
4. **存储时**: BigQuery 列级权限控制

---

## 八、行为事件体系

### 8.1 事件命名规范

所有产品事件以 `tengu_` 前缀命名。OTel 事件额外包裹 `claude_code.` 前缀。

### 8.2 事件分类清单

#### API / 流式处理
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_api_query` | API 请求发出 |
| `tengu_api_success` | API 请求成功 |
| `tengu_api_error` | API 请求失败 |
| `tengu_api_retry` | 请求重试 |
| `tengu_api_529_background_dropped` | 529 后台任务丢弃 |
| `tengu_api_opus_fallback_triggered` | Opus 降级触发 |
| `tengu_streaming_error` | 流式传输错误 |
| `tengu_streaming_stall` | 流式传输卡顿 |
| `tengu_streaming_idle_timeout` | 流式空闲超时 |
| `tengu_max_tokens_reached` | 最大 token 数到达 |
| `tengu_context_window_exceeded` | 上下文窗口超限 |
| `tengu_nonstreaming_fallback_*` | 非流式降级 |
| `tengu_api_cache_breakpoints` | 缓存断点 |
| `tengu_prompt_cache_break` | prompt 缓存中断 |

#### 工具执行
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_tool_use_success` | 工具调用成功 |
| `tengu_tool_use_error` | 工具调用失败 |
| `tengu_tool_use_cancelled` | 工具调用取消 |
| `tengu_tool_use_progress` | 工具执行进度 |
| `tengu_tool_use_granted_by_permission_hook` | 权限 hook 授予 |
| `tengu_tool_use_rejected_in_prompt` | prompt 中拒绝 |
| `tengu_tool_use_show_permission_request` | 显示权限请求 |
| `tengu_tool_use_can_use_tool_*` | 工具可用性检查 |
| `tengu_file_operation` | 文件读/写/编辑（含 hash） |

#### Compact / Query
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_compact` | 上下文压缩完成 |
| `tengu_compact_failed` | 压缩失败 |
| `tengu_partial_compact` | 部分压缩 |
| `tengu_auto_compact_succeeded` | 自动压缩成功 |
| `tengu_query_error` | 查询错误 |
| `tengu_query_before_attachments` | 附件处理前统计 |
| `tengu_query_after_attachments` | 附件处理后统计 |
| `tengu_token_budget_completed` | token 预算完成 |
| `tengu_model_fallback_triggered` | 模型降级 |

#### MCP
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_mcp_server_connection_*` | MCP 服务器连接成功/失败 |
| `tengu_mcp_tools_commands_loaded` | 工具/命令加载 |
| `tengu_mcp_large_result_handled` | 大结果处理 |
| `tengu_mcp_oauth_flow_*` | MCP OAuth 流程 |
| `tengu_mcp_servers` | 服务器列表统计 |
| `tengu_mcp_list_changed` | 列表变更 |
| `tengu_mcp_elicitation_*` | 用户交互请求 |

#### 插件 / 技能
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_plugin_enabled_for_session` | 会话启用插件 |
| `tengu_plugin_load_failed` | 插件加载失败 |
| `tengu_plugins_loaded` | 插件加载完成 |
| `tengu_plugin_installed_cli` | CLI 安装 |
| `tengu_plugin_uninstalled_cli` | CLI 卸载 |
| `tengu_plugin_remote_fetch` | 插件网络获取 |
| `tengu_marketplace_*` | 市场操作 |
| `tengu_dynamic_skills_changed` | 动态技能变更 |

#### OAuth / 认证
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_oauth_flow_start` | OAuth 开始 |
| `tengu_oauth_success` | OAuth 成功 |
| `tengu_oauth_error` | OAuth 失败 |
| `tengu_oauth_token_exchange_*` | token 交换 |
| `tengu_oauth_token_refresh_*` | token 刷新 |
| `tengu_oauth_profile_fetch_success` | profile 获取 |
| `tengu_oauth_*_selected` | provider 选择 |

#### 记忆系统
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_session_memory_*` | 会话记忆读取/提取/初始化 |
| `tengu_extract_memories_*` | 长期记忆提取 |
| `tengu_team_mem_sync_*` | 团队记忆同步 |
| `tengu_auto_dream_*` | 自动 dream 触发/完成 |

#### UI / 交互
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_trust_dialog_*` | 信任对话框 |
| `tengu_bypass_permissions_mode_*` | 绕过权限模式 |
| `tengu_auto_mode_opt_in_*` | 自动模式 opt-in |
| `tengu_mode_cycle` | 模式切换 |
| `tengu_model_command_*` | 模型选择 |
| `tengu_cancel` | 用户取消 |
| `tengu_paste_image` | 粘贴图片 |
| `tengu_copy` | 复制操作 |
| `tengu_flicker` | UI 闪烁 |
| `tengu_onboarding_step` | 引导步骤 |
| `tengu_history_picker_select` | 历史选择 |
| `tengu_voice_*` | 语音功能 |
| `tengu_brief_mode_toggled` | 简洁模式切换 |
| `tengu_fast_mode_toggled` | 快速模式切换 |

#### 设置 / 配置
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_settings_sync_*` | 设置同步 |
| `tengu_config_*` | 配置操作（锁竞争、解析错误、认证丢失保护等） |
| `tengu_grove_policy_toggled` | 隐私设置切换 |
| `tengu_managed_settings_security_*` | 托管设置安全对话框 |

#### 其它
| 事件名 | 触发时机 |
|-------|---------|
| `tengu_ultraplan_*` | UltraPlan 操作 |
| `tengu_review_remote_*` | 远程 review |
| `tengu_bridge_command` | Bridge 命令 |
| `tengu_notification_method_used` | 通知方法 |
| `tengu_tip_shown` | 提示显示 |
| `tengu_conversation_forked` | 对话分叉 |
| `tengu_prompt_suggestion` | prompt 建议 |
| `tengu_speculation` | 推测执行 |
| `tengu_auto_updater_*` | 自动更新 |
| `tengu_desktop_upsell_shown` | 桌面端推广 |
| `tengu_install_github_app_*` | GitHub App 安装 |

### 8.3 事件规模

`logEvent` 调用横跨 **200+ 个文件**，共 **400+** 个不同事件点。

---

## 九、用户追踪能力

### 9.1 设备/用户识别链路

```
deviceId (永久, ~/.claude/config.json)
  └→ sessionId (单次进程)
       └→ accountUuid (Claude.ai OAuth, 账户级)
            └→ organizationUuid (企业 OAuth, 组织级)
```

### 9.2 环境判断能力

- **CI 检测**: `isCi`, `isGithubAction`, `isClaudeCodeAction`
- **远程模式**: `isClaudeCodeRemote`, `coworkerType`, `remoteEnvironmentType`
- **WSL**: `wslVersion`
- **编辑器**: `terminal` (iTerm/VS Code/Hyper 等)
- **部署环境**: `deploymentEnvironment`
- **GitHub Actions**: actor/repository/owner/ref 元数据

### 9.3 可推断的使用模式

- 工具使用频率热力图
- 模型选择偏好分布
- 订阅类型与功能使用关联
- 会话时长/成本趋势
- 平台/终端类型分布
- 插件生态热度排名
- 上下文压缩频率与成功率
- 记忆系统使用深度

---

## 十、未涉及的追踪机制

以下是**不存在**的追踪能力，供完整性参考：

| 机制 | 状态 | 说明 |
|-----|------|------|
| Sentry SDK | **未集成** | 仅有 `SentryErrorBoundary` 命名的 React 错误边界组件，无 SDK |
| Statsig SDK | **未集成** | 仅保留命名兼容 API，实际由 GrowthBook 驱动 |
| 会话录制/录屏 | **不存在** | 无 session replay 类库 |
| 浏览器指纹 | **不适用** | CLI 场景，使用持久化随机 ID |
| Cookie | **不适用** | CLI 场景，状态存储在全局配置文件 |
| 心跳/存活检测 | **无独立机制** | WebSocket ping 仅用于连接保活，流式 heartbeat 仅用于重试调度 |

---

## 十一、外部端点汇总

| 端点 | 用途 | 条件 |
|-----|------|------|
| `https://http-intake.logs.us5.datadoghq.com/api/v2/logs` | Datadog 事件 | 生产 + 1P + gate 开启 |
| `https://api.anthropic.com/api/event_logging/batch` | 1P 高保真事件 | analytics 未禁用 |
| `https://api.anthropic.com/api/claude_code/metrics` | BigQuery 内部指标 | API 客户 / C4E / Teams |
| `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled` | 组织 metrics 开关 | 非 essential-traffic |
| `https://api.anthropic.com/` (GrowthBook) | 远程 feature flag | analytics 未禁用 |
| 用户配置的 `OTEL_EXPORTER_OTLP_ENDPOINT` | 3P OTel 导出 | `CLAUDE_CODE_ENABLE_TELEMETRY=1` |
| 用户配置的 `BETA_TRACING_ENDPOINT` | Beta 会话追踪 | `ENABLE_BETA_TRACING_DETAILED=1` |

---

## 十二、关键文件索引

| 功能 | 文件路径 |
|-----|---------|
| 事件公共 API | `src/services/analytics/index.ts` |
| Sink fanout | `src/services/analytics/sink.ts` |
| Enrichment | `src/services/analytics/metadata.ts` |
| Datadog | `src/services/analytics/datadog.ts` |
| 1P Logger | `src/services/analytics/firstPartyEventLogger.ts` |
| 1P Exporter | `src/services/analytics/firstPartyEventLoggingExporter.ts` |
| GrowthBook | `src/services/analytics/growthbook.ts` |
| Analytics 配置 | `src/services/analytics/config.ts` |
| Sink 熔断 | `src/services/analytics/sinkKillswitch.ts` |
| OTel 初始化 | `src/utils/telemetry/instrumentation.ts` |
| BigQuery 导出 | `src/utils/telemetry/bigqueryExporter.ts` |
| OTel 事件 | `src/utils/telemetry/events.ts` |
| 会话追踪 | `src/utils/telemetry/sessionTracing.ts` |
| Perfetto | `src/utils/telemetry/perfettoTracing.ts` |
| 插件遥测 | `src/utils/telemetry/pluginTelemetry.ts` |
| 插件获取遥测 | `src/utils/plugins/fetchTelemetry.ts` |
| 文件操作分析 | `src/utils/fileOperationAnalytics.ts` |
| 隐私级别 | `src/utils/privacyLevel.ts` |
| Metrics Opt-Out | `src/services/api/metricsOptOut.ts` |
| 用户 ID | `src/utils/config.ts` |
| 认证 | `src/utils/auth.ts` |
| API Keys | `src/constants/keys.ts` |
| API 日志 | `src/services/api/logging.ts` |
| 遥测属性 | `src/utils/telemetryAttributes.ts` |
| 权限日志 | `src/hooks/toolPermission/permissionLogging.ts` |

---

*分析日期: 2026-04-03*
*版本: Claude Code CLI v2.1.88*
