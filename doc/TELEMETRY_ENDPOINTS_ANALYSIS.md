# Telemetry / Analytics 接口分析

## 1. Datadog

### `POST https://http-intake.logs.us5.datadoghq.com/api/v2/logs`
- **方法**: POST
- **鉴权**: `DD-API-KEY`（内置 client token）
- **功能**: Datadog log intake
- **用途**: 上报 allowlist 内的运维/错误/行为事件
- **主要调用**:
  - `src/services/analytics/datadog.ts#flushLogs`
  - 上游由 `src/services/analytics/sink.ts` fanout

**特点**
- 仅生产环境
- 仅 first-party provider
- 有 allowlist
- 高基数字段被压缩/归一化

---

## 2. 1P Event Logging

### `POST {baseUrl}/api/event_logging/batch`
- **生产**: `https://api.anthropic.com/api/event_logging/batch`
- **staging**: `https://api-staging.anthropic.com/api/event_logging/batch`
- **方法**: POST
- **鉴权**:
  - 优先使用 Anthropic auth headers
  - 某些情况下会回退为 unauthenticated send
- **功能**: 内部高保真事件批量上报
- **主要调用**:
  - `src/services/analytics/firstPartyEventLoggingExporter.ts`
  - `src/services/analytics/firstPartyEventLogger.ts`

**特点**
- 支持失败落盘 JSONL
- 支持 backoff / 重试
- 支持 401 后 unauthenticated retry
- 与 customer OTel provider 隔离

---

## 3. GrowthBook Remote Eval

### `{apiHost}/...`（SDK 管理具体路径）
- **默认 base**: `https://api.anthropic.com/`
- **方法**: SDK 内部 HTTP 请求
- **鉴权**: 如果可用则带 Anthropic auth headers
- **功能**:
  - 远程 feature flag
  - dynamic config
  - sampling config
  - sink killswitch / Datadog gate
- **主要调用**:
  - `src/services/analytics/growthbook.ts`

**说明**
- 具体 path 由 GrowthBook SDK 管理
- 代码中主要体现为 base URL 与初始化逻辑

---

## 4. 结论

Telemetry 相关外部接口主要有三类：
- Datadog logs intake
- 1P event logging batch
- GrowthBook remote eval / feature fetch

其中：
- Datadog 偏运维监控
- 1P event logging 偏内部高保真分析
- GrowthBook 偏远程配置/采样/开关控制