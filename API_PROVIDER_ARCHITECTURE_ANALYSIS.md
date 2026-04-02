# Claude Code API / Provider 架构深度解析

## 1. 定位

Claude Code 的 API 调用层不是简单调用 Anthropic SDK。

从源码看，它是一个：
- provider abstraction layer
- model/provider routing layer
- streaming protocol handler
- retry / fallback / auth refresh 层
- error mapping 层

核心目录：
- `src/services/api/`
- `src/utils/model/`

---

## 2. 主调用入口

核心文件：
- `src/services/api/claude.ts`

### 2.1 主函数

主流程集中在：
- `queryModel()`

外部通常通过：
- `queryModelWithStreaming()`
- `queryModelWithoutStreaming()`

调用。

两者共用同一条总体 pipeline。

### 2.2 调用链抽象

```text
resolve provider/model
  → normalize transcript
  → build tools/system/betas/body
  → get provider-specific client
  → anthropic-compatible request
  → stream parse / non-stream fallback
  → retry / error map / completion
```

---

## 3. provider 抽象：永远返回 Anthropic-compatible client

核心文件：
- `src/services/api/client.ts`

### 3.1 关键设计

`getAnthropicClient()` 的核心思路是：
- 不管底层后端是谁
- 最终都提供一个 **Anthropic SDK 形状兼容的 client**

### 3.2 支持的后端

- Anthropic first-party
- Bedrock
- Vertex
- Foundry
- 自定义 Anthropic-compatible provider
- Kimi
- GitHub Copilot
- 自定义 OpenAI-compatible backend

### 3.3 特别点

对于 Copilot / OpenAI-compatible 后端：
- 不是直接复用 Anthropic SDK
- 而是通过 `fetch override` 把 Anthropic Messages API 请求翻译成 OpenAI chat completions
- 再把返回/stream 转回 Anthropic 语义

这说明 provider abstraction 做得非常深，不只是 base URL 切换。

---

## 4. model / provider 选择

相关文件：
- `src/utils/model/providers.ts`
- `src/utils/model/model.ts`

### 4.1 provider 选择

provider 判断集中在 `providers.ts`。

### 4.2 model 选择

model 选择逻辑集中在 `model.ts`，优先级大致是：
- 用户 override
- session/env/settings
- 默认 provider 策略

### 4.3 重要差异

对于 3P provider：
- 默认模型会更保守
- 不一定和 first-party 默认模型一致

说明 model selection 不是独立于 provider 的，而是 provider-sensitive routing。

---

## 5. request shaping：请求构建远比表面复杂

在 `queryModel()` 里，请求体构建包含很多层。

### 5.1 transcript 输入

先走：
- `normalizeMessagesForAPI()`

保证消息合法。

### 5.2 tool schema

根据注册工具生成 tool schemas。

### 5.3 betas 与 provider 差异

系统会：
- 合并 model/provider-specific betas
- 某些 provider（如 Bedrock）会把 betas 放到不同字段，如 `extraBodyParams`

### 5.4 request body 其他内容

还可能包含：
- metadata
- prompt-caching markers
- context management
- thinking config
- effort / task budget
- temperature
- fast mode / speed 相关字段
- output formatting

### 5.5 架构意义

API 层不是“发消息”而已，而是：
- request compilation layer

---

## 6. stream handling：手工解析，不完全依赖 SDK 高层包装

### 6.1 为什么重要

源码里 streaming 处理是手工消费 raw stream event，并自己重建内容块。

### 6.2 处理内容

会显式处理：
- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`

### 6.3 能累计的内容

包括：
- text
- thinking
- tool JSON
- connector text
- server tool blocks
- usage / stop reason / cost

### 6.4 为什么不全交给 SDK

原因很明显：
- 减少重复 partial JSON parse
- 更细粒度控制 tool-input accumulation
- 更灵活地服务 UI streaming 和 runtime control

说明这里本质上是一层 **custom stream protocol adapter**。

---

## 7. stream resilience

stream path 还额外做了：
- stream controller cleanup
- `Response.body` cleanup
- idle watchdog timeout
- stall detection / telemetry
- 空 stream / incomplete stream 校验

### 7.1 fallback

若 streaming 失败，还能回退到：
- non-streaming `messages.create(...)`

并且仍复用同一套 retry machinery。

### 7.2 架构意义

这是一个 streaming-first、但允许 graceful degradation 的设计。

---

## 8. retry / fallback / auth refresh

关键文件：
- `src/services/api/withRetry.ts`

### 8.1 retry 处理的范围

它不只是网络失败重试，还包括：
- OAuth refresh / re-clienting
- revoked token
- Bedrock/Vertex auth 异常
- stale keepalive socket
- 429/529 backoff
- `retry-after`
- 持久 unattended retries
- context-overflow 时降低 `max_tokens`
- fast mode downgrade / cooldown
- repeated 529 后触发 fallback model

### 8.2 关键结论

`withRetry()` 本质上不是 retry helper，而是：
- runtime recovery controller

---

## 9. error mapping

关键文件：
- `src/services/api/errors.ts`
- `src/services/api/errorUtils.ts`

### 9.1 它处理什么

原始 `APIError` / 连接错误会被映射成更可理解的用户可见语义：
- quota / rate limit
- prompt too long
- media / PDF 限制
- auth failure / revoked OAuth / disabled org
- Bedrock model-not-found
- generic 404 model availability
- SSL/TLS / connection diagnostics

### 9.2 analytics 侧

还有单独的：
- `classifyAPIError()`

用于 telemetry 分类。

### 9.3 架构意义

错误系统也有双通路：
- 用户解释
- analytics 分类

---

## 10. 架构判断

Claude Code 的 API/provider 层可以理解为：

```text
model/provider resolver
  → Anthropic-compatible abstraction
  → request compiler
  → custom stream adapter
  → retry/recovery controller
  → user-facing error mapper
```

它不是 SDK wrapper，而是一整层 provider-aware runtime transport abstraction。

---

## 11. 关键文件索引

- `src/services/api/claude.ts`
- `src/services/api/client.ts`
- `src/services/api/withRetry.ts`
- `src/services/api/errors.ts`
- `src/services/api/errorUtils.ts`
- `src/utils/model/providers.ts`
- `src/utils/model/model.ts`
- `src/services/api/copilotClient.ts`
- `src/services/api/customOpenAIClient.ts`

---

## 12. 一句话结论

Claude Code 的 API/provider 架构本质上是一套把多家后端统一折叠成 Anthropic-compatible runtime 的 **模型调用与恢复抽象层**。