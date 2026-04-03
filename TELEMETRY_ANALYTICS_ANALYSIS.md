# Claude Code Telemetry / Analytics 架构深度解析

## 1. 定位

Claude Code 的 telemetry 架构不是一个单独 analytics SDK，而是分层的双通路系统：

1. 面向广泛运维监控的 Datadog 路径
2. 面向内部高保真事件存储的 1P logging 路径

再加上：
- 统一公共 API
- enrichment 层
- sampling 层
- sink fanout 层
- durable exporter 层

核心目录：
- `src/services/analytics/`

---

## 2. 公共入口：刻意做得很薄

相关文件：
- `src/services/analytics/index.ts`

对外暴露的 API 很少：
- `logEvent`
- `logEventAsync`
- `attachAnalyticsSink`

### 2.1 为什么这么设计

源码里明确强调：
- 该模块尽量无依赖
- 避免 import cycle
- 启动早期就能先打点，再等 sink 初始化

### 2.2 事件队列

如果 sink 还没 attach：
- event 先进入 queue
- 等 `attachAnalyticsSink()` 后统一 drain

这说明 analytics API 被设计成 startup-safe。

---

## 3. sink fanout：一个逻辑事件，多后端分发

相关文件：
- `src/services/analytics/sink.ts`

### 3.1 fanout 目标

一个逻辑事件会被分发到：
- Datadog
- 1P internal logging

### 3.2 sampling 只做一次

sampling 在 fanout 前统一执行，而不是每个 backend 各自采样。

这点很重要，因为它保证：
- 不同 backend 看到的是同一批 sampled event
- 方便跨 backend 对齐分析

GrowthBook config：
- `tengu_event_sampling_config`

---

## 4. enrichment：共享元数据单一事实源

相关文件：
- `src/services/analytics/metadata.ts`

### 4.1 `getEventMetadata()` 提供统一 envelope

它收集：
- session/process identity
- model / betas
- environment context
- process metrics
- agent hierarchy
- repo-join key (`rh`)

### 4.2 它的地位

`metadata.ts` 不是附属模块，而是整个 telemetry 的 **single source of truth for enrichment**。

如果没有它，不同 sink 会各自收集不同字段，最终数据口径会分裂。

---

## 5. process/session/tool metadata 的分层

这是这套架构设计得比较成熟的地方。

### 5.1 稳定 envelope

在 `EventMetadata` 中维护稳定字段：
- sessionId
- entrypoint
- clientType
- interactivity
- envContext
- processMetrics
- agentId / parentSessionId / teamName

### 5.2 event-specific payload

额外事件字段放在：
- `additionalMetadata`
- `event_metadata`

### 5.3 1P 输出进一步分层

`to1PEventFormat()` 会拆成：
- `env`
- `process`
- `core`
- `auth`
- `additional`

### 5.4 架构意义

这表示 telemetry 系统并不把所有字段混成平面对象，而是显式区分：
- 稳定维度
- 事件局部字段
- 高敏认证字段
- process 统计

这对长期演进非常关键。

---

## 6. PII 分级与 `_PROTO_*` 字段

相关文件：
- `src/services/analytics/index.ts`
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

### 6.1 核心机制

高敏字段通过 `_PROTO_*` 前缀标记。

一般流程：
- 普通 analytics backend 会先 `stripProtoFields()`
- Datadog 只看到脱敏后 payload
- 1P exporter 会识别特定 `_PROTO_*` 字段，把它们提升到 privileged proto columns
- 之后再从 `additional_metadata` 中剥离

### 6.2 设计意义

这是一种非常明确的：
- 广泛访问后端
- 特权内部后端

双轨数据治理设计。

不是“约定别传敏感字段”，而是结构化隔离。

---

## 7. Datadog 路径：偏运维与低保真

相关文件：
- `src/services/analytics/datadog.ts`

### 7.1 特征

- 固定 allowlist event 才会上报
- 仅 production
- 仅 first-party API provider
- 做 metadata flatten
- 高基数字段会被降维
- `mcp__*` 会规范化
- 外部 model name 会 canonicalize / bucket
- user identity 不是直接用户 id，而是 `userBucket`

### 7.2 设计定位

Datadog 这条路明显是：
- operational monitoring
- dashboard / alert / aggregates
- 不追求完整事件保真

---

## 8. 1P logging 路径：偏高保真与内部分析

相关文件：
- `src/services/analytics/firstPartyEventLogger.ts`
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

### 8.1 独立 LoggerProvider

源码明确说明：
- 不使用 global OTel provider

原因：
- 避免内部 analytics event 泄露到客户配置的 OTLP endpoint
- 反过来也避免客户 telemetry 污染内部 1P 路径

### 8.2 exporter 不是简单发送器

它还支持：
- failed batch 落盘为 JSONL
- 重试上一轮 session 残留文件
- backoff
- 401 后 unauthenticated retry
- sink killswitch 动态关闭

### 8.3 架构判断

它更像一个 **durable delivery layer**，而不是普通 exporter。

---

## 9. Tool metadata：analytics 与 OTel 不是同一策略

### 9.1 analytics 侧

默认情况下：
- MCP tool name 会被脱敏为 `mcp_tool`

只有特定受信场景才允许细节透出：
- local-agent
- claude.ai proxy connector
- official MCP URL
- 内建 MCP server

### 9.2 OTel / telemetry 侧

`extractToolInputForTelemetry()` 又是另一条逻辑：
- 只有 `OTEL_LOG_TOOL_DETAILS=1` 才记录更多工具参数
- 会做 truncation / max depth / max items
- 会剔除 `_` 开头内部字段

### 9.3 设计含义

这说明：
- analytics 隐私策略
- telemetry 诊断策略

不是完全同一套，而是各自独立收敛。

---

## 10. killswitch 与 enable/disable 控制

### 10.1 全局配置层

- `src/services/analytics/config.ts`

负责总开关、provider/privacy 级别的启停。

### 10.2 per-sink killswitch

- `src/services/analytics/sinkKillswitch.ts`

负责远程动态抑制某个 sink。

### 10.3 设计意义

这是两层控制：
- hard stop
- dynamic suppression

在生产里非常实用。

---

## 11. 架构判断

Claude Code 的 telemetry/analytics 系统可以抽象为：

```text
logEvent API
  → queue-before-init
  → unified enrichment
  → shared sampling
  → sink fanout
  → Datadog low-fidelity path
  → 1P durable high-fidelity path
```

它不是一个埋点模块，而是一套：
- data governance
- enrichment normalization
- privacy separation
- backend specialization
- delivery resilience

综合体。

---

## 12. 关键文件索引

- `src/services/analytics/index.ts`
- `src/services/analytics/sink.ts`
- `src/services/analytics/metadata.ts`
- `src/services/analytics/datadog.ts`
- `src/services/analytics/firstPartyEventLogger.ts`
- `src/services/analytics/firstPartyEventLoggingExporter.ts`
- `src/services/analytics/config.ts`
- `src/services/analytics/sinkKillswitch.ts`

---

## 13. 一句话结论

Claude Code 的 telemetry 架构是一套同时面向运维监控、内部事件分析与敏感数据治理的 **双通路分层遥测平台**。