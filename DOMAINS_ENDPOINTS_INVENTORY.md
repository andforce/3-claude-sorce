# Claude Code 项目域名、接口与功能清单

> 说明：本清单基于源码静态分析整理。  
> 目标不是枚举所有字符串，而是把**项目里真正有业务意义的域名/Host、接口路径、用途和调用位置**归纳出来。  
> 其中一部分 URL 是固定常量，一部分是按环境/配置拼接得到。

---

## 一、总览

项目中的网络域名大致分为 8 类：

1. **Anthropic 第一方 API / OAuth / Web**
2. **Claude.ai / Claude.com Web 与远程会话页面**
3. **MCP 官方注册表与 MCP Proxy**
4. **Bridge / Remote Control / Code Session 相关接口**
5. **遥测与事件上报**
6. **第三方模型/提供商接口**
   - GitHub Copilot
   - Custom OpenAI-compatible
   - Bedrock / Vertex / Foundry（更多由 SDK/环境注入）
7. **本地开发 / staging / FedStart 特殊域名**
8. **用户自定义 base URL / provider URL**

---

## 二、Anthropic 第一方 API / OAuth / Web

### 2.1 `https://api.anthropic.com`

**角色**
- Anthropic 第一方 API 根域名
- 生产环境默认 API 基址

**源码位置**
- `src/constants/oauth.ts`
- `src/services/api/client.ts`
- `src/services/policyLimits/index.ts`
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

**相关接口**

#### 1. `/v1/oauth/token`
- **完整 URL**: `https://platform.claude.com/v1/oauth/token`（OAuth token 交换不在 api.anthropic.com，而在 platform）
- 这里列出是为了区分：api 与 platform 各自承担不同职能

#### 2. `/api/oauth/claude_cli/create_api_key`
- **完整 URL**: `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`
- **功能**: OAuth 登录后的 Claude CLI 创建 API key
- **调用位置**: `src/constants/oauth.ts`

#### 3. `/api/oauth/claude_cli/roles`
- **完整 URL**: `https://api.anthropic.com/api/oauth/claude_cli/roles`
- **功能**: 获取 OAuth 用户角色/组织角色信息
- **调用位置**: `src/constants/oauth.ts`

#### 4. `/api/claude_code/policy_limits`
- **完整 URL**: `https://api.anthropic.com/api/claude_code/policy_limits`
- **功能**: 拉取组织级 policy restrictions（如 remote control / remote sessions 是否允许）
- **调用位置**: `src/services/policyLimits/index.ts`

#### 5. `/api/event_logging/batch`
- **完整 URL**: `https://api.anthropic.com/api/event_logging/batch`
- **功能**: 1P 内部事件批量上报
- **调用位置**: `src/services/analytics/firstPartyEventLoggingExporter.ts`

#### 6. Anthropic Messages API
- **功能**: 模型主调用接口
- **说明**: 实际调用由 `@anthropic-ai/sdk` 承担，源码中通过 Anthropic client 发送 `beta.messages.create(...)`
- **调用位置**: `src/services/api/claude.ts`, `src/services/api/client.ts`
- **备注**: 路径不总是以硬编码常量出现，但这是主业务 API 面

---

### 2.2 `https://platform.claude.com`

**角色**
- OAuth / Console / 成功跳转平台域名

**源码位置**
- `src/constants/oauth.ts`

**相关接口 / 页面**

#### 1. `/oauth/authorize`
- **完整 URL**: `https://platform.claude.com/oauth/authorize`
- **功能**: Console OAuth 授权页面
- **调用位置**: `getOauthConfig().CONSOLE_AUTHORIZE_URL`

#### 2. `/v1/oauth/token`
- **完整 URL**: `https://platform.claude.com/v1/oauth/token`
- **功能**: OAuth code 换 token、refresh token
- **调用位置**: `src/services/oauth/client.ts`

#### 3. `/oauth/code/callback`
- **完整 URL**: `https://platform.claude.com/oauth/code/callback`
- **功能**: manual redirect callback 地址
- **调用位置**: `src/constants/oauth.ts`, `src/services/oauth/client.ts`

#### 4. `/oauth/code/success?app=claude-code`
- **功能**: OAuth 成功页
- **调用位置**: `src/constants/oauth.ts`

#### 5. `/buy_credits?returnUrl=...`
- **功能**: Console credits/成功跳转相关页面
- **调用位置**: `src/constants/oauth.ts`

---

### 2.3 `https://claude.com`

**角色**
- Claude 品牌站点 / CLI 产品页 / OAuth attribution 跳板

**源码位置**
- `src/constants/product.ts`
- `src/constants/oauth.ts`

**相关页面**

#### 1. `/claude-code`
- **完整 URL**: `https://claude.com/claude-code`
- **功能**: 产品介绍页面
- **调用位置**: `src/constants/product.ts`

#### 2. `/cai/oauth/authorize`
- **完整 URL**: `https://claude.com/cai/oauth/authorize`
- **功能**: Claude.ai 登录授权的 attribution 跳板
- **说明**: 最终会跳转到 claude.ai 的 OAuth authorize 流程
- **调用位置**: `src/constants/oauth.ts`

---

### 2.4 `https://claude.ai`

**角色**
- Claude.ai Web 主站
- 远程 code session 页面
- MCP client metadata URL 承载域名

**源码位置**
- `src/constants/product.ts`
- `src/constants/oauth.ts`

**相关页面 / 接口**

#### 1. `/code/{sessionId}`
- **完整形式**: `https://claude.ai/code/{sessionId}`
- **功能**: 远程 code session 页面
- **调用位置**: `src/constants/product.ts#getRemoteSessionUrl`

#### 2. `/oauth/claude-code-client-metadata`
- **完整 URL**: `https://claude.ai/oauth/claude-code-client-metadata`
- **功能**: MCP OAuth 的 Client ID Metadata Document (CIMD / SEP-991)
- **调用位置**: `src/constants/oauth.ts`

---

## 三、Staging / Local / FedStart OAuth 与 Web 域名

### 3.1 `https://api-staging.anthropic.com`

**功能**
- staging API
- staging policy limits
- staging OAuth API key / roles
- staging 1P event logging base URL 候选

**调用位置**
- `src/constants/oauth.ts`
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

---

### 3.2 `https://platform.staging.ant.dev`

**功能**
- staging OAuth authorize/token/success/callback

**调用位置**
- `src/constants/oauth.ts`

**接口**
- `/oauth/authorize`
- `/v1/oauth/token`
- `/oauth/code/success`
- `/oauth/code/callback`
- `/buy_credits?...`

---

### 3.3 `https://claude-ai.staging.ant.dev`

**功能**
- staging Claude AI web origin
- staging Claude AI authorize URL
- staging remote session web base

**调用位置**
- `src/constants/oauth.ts`
- `src/constants/product.ts`

---

### 3.4 本地开发域名

#### `http://localhost:8000`
- **功能**: local OAuth/API base
- **调用位置**: `src/constants/oauth.ts`

#### `http://localhost:4000`
- **功能**: local Claude AI web / local remote session 页面
- **调用位置**: `src/constants/oauth.ts`, `src/constants/product.ts`

#### `http://localhost:3000`
- **功能**: local Console authorize/success/callback 页面
- **调用位置**: `src/constants/oauth.ts`

#### `http://localhost:8205`
- **功能**: local MCP proxy
- **调用位置**: `src/constants/oauth.ts`

---

### 3.5 FedStart / Custom OAuth Allowlist

**允许的自定义 OAuth base URL**
- `https://beacon.claude-ai.staging.ant.dev`
- `https://claude.fedstart.com`
- `https://claude-staging.fedstart.com`

**功能**
- 允许通过 `CLAUDE_CODE_CUSTOM_OAUTH_URL` 指向批准的部署
- 防止 OAuth token 被发送到任意域名

**调用位置**
- `src/constants/oauth.ts`

---

## 四、MCP 相关域名与接口

### 4.1 `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial`

**功能**
- 官方 MCP registry 拉取
- 获取商业可见 MCP server 列表与 remote URL

**调用位置**
- `src/services/mcp/officialRegistry.ts`

**接口说明**
- **方法**: GET
- **用途**: 下载 Anthropic 官方 MCP registry，用于后续 `isOfficialMcpUrl()` 判断

---

### 4.2 `https://mcp-proxy.anthropic.com`

**功能**
- 生产环境 MCP proxy 根域名

**调用位置**
- `src/constants/oauth.ts`

**接口路径模板**
- `/v1/mcp/{server_id}`

**说明**
- 用于 Claude.ai / OAuth 受控的 MCP proxy 通道

---

### 4.3 `https://mcp-proxy-staging.anthropic.com`

**功能**
- staging MCP proxy

**调用位置**
- `src/constants/oauth.ts`

**接口路径模板**
- `/v1/mcp/{server_id}`

---

## 五、Bridge / Remote Control / Code Session 域名与接口

> 这一部分大量 URL 是运行时拼接出来的，不一定全以硬编码常量出现。

### 5.1 Claude.ai / staging / local 的 code session 页面

由 `src/constants/product.ts#getRemoteSessionUrl()` 生成：

- 生产: `https://claude.ai/code/{compatSessionId}`
- staging: `https://claude-ai.staging.ant.dev/code/{compatSessionId}`
- local: `http://localhost:4000/code/{compatSessionId}`

**功能**
- 远程 session 的 web 页面入口

---

### 5.2 Bridge API（基于 `BASE_API_URL`）

从 `src/bridge/bridgeMain.ts`、`src/bridge/bridgeApi.ts`、`src/bridge/remoteBridgeCore.ts` 的调用关系看，Bridge 会使用 Anthropic/对应环境 API base 构建一组 bridge/code session 接口。

虽然本次未逐一展开所有构造函数实现，但从源码明确可确认这些功能面：

#### 1. `/bridge`
- **功能**: REPL env-less bridge 获取 worker JWT / epoch / 建立 code session 入口
- **调用位置**: `src/bridge/remoteBridgeCore.ts`

#### 2. `/bridge/reconnect`
- **功能**: session ingress token 过期时重新排队/重连 session
- **调用位置**: `src/bridge/bridgeMain.ts`

#### 3. `/v1/code/sessions/{id}/worker/*`
- **功能**: CCR v2 / code session worker 相关接口
- **说明**: 源码注释明确提到 worker endpoints 需要 `cse_*` 风格 ID
- **调用位置**: `src/constants/product.ts`, `src/bridge/sessionIdCompat.ts`, `src/bridge/replBridgeTransport.ts` 等链路

#### 4. Environment / Work dispatch / heartbeat / ACK 系列接口
- **功能**:
  - environment 注册
  - work poll
  - ACK work
  - heartbeat active work
  - archive / deregister
- **调用位置**: `src/bridge/bridgeMain.ts`
- **说明**: 这些接口经 `createBridgeApiClient()` 封装，不全部以固定字符串出现在常量中

---

## 六、Telemetry / Analytics 域名与接口

### 6.1 `https://http-intake.logs.us5.datadoghq.com/api/v2/logs`

**功能**
- Datadog logs intake
- 允许的 event 批量上报

**调用位置**
- `src/services/analytics/datadog.ts`

**接口说明**
- **方法**: POST
- **用途**: 把允许的 Datadog 事件批量上传

---

### 6.2 `https://api.anthropic.com/api/event_logging/batch`

**功能**
- 1P event logging batch 上报

**调用位置**
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

**接口说明**
- **方法**: POST
- **用途**: 内部事件导出，高保真事件存储

### 6.3 `https://api-staging.anthropic.com/api/event_logging/batch`

**功能**
- staging 1P event logging

**调用位置**
- `src/services/analytics/firstPartyEventLoggingExporter.ts`

---

## 七、第三方模型/提供商相关域名与接口

### 7.1 GitHub Copilot

#### 域名: `https://api.githubcopilot.com`

**调用位置**
- `src/services/api/copilotClient.ts`

**相关接口**

##### 1. `/models`
- **完整 URL**: `https://api.githubcopilot.com/models`
- **方法**: GET
- **功能**: 获取 Copilot 可用模型列表
- **说明**: 带 OAuth token 调用

##### 2. `/chat/completions`
- **完整 URL**: `https://api.githubcopilot.com/chat/completions`
- **方法**: POST
- **功能**: OpenAI 风格 chat completions
- **说明**: Claude Code 会把 Anthropic Messages API 请求转换成它

#### 辅助域名: `https://models.dev/api.json`
- **功能**: Copilot 模型列表的回退元数据源
- **调用位置**: `src/services/api/copilotClient.ts`

---

### 7.2 Custom OpenAI-compatible Provider

**域名来源**
- 来自用户配置的 `connectedProviders['custom-openai'].baseUrl`

**调用位置**
- `src/services/api/customOpenAIClient.ts`

**相关接口**

##### 1. `/v1/chat/completions`
- **功能**: OpenAI-compatible chat completions 主接口
- **构造规则**:
  - 若 base URL 已以 `/v1` 结尾 → `.../chat/completions`
  - 否则 → `.../v1/chat/completions`

##### 2. `/v1/models`
- **功能**: 模型列表读取
- **构造规则**:
  - 若 base URL 已以 `/v1` 结尾 → `.../models`
  - 否则 → `.../v1/models`

**说明**
- Claude Code 会把 Anthropic request 转译成 OpenAI-compatible request
- 非固定域名，完全取决于用户配置

---

### 7.3 Azure Foundry

**域名模式**
- `https://{resource}.services.ai.azure.com`

**调用位置**
- `src/services/api/client.ts`

**相关接口**
- `/anthropic/v1/messages`

**说明**
- 通过 `ANTHROPIC_FOUNDRY_RESOURCE` 或 `ANTHROPIC_FOUNDRY_BASE_URL` 构造
- 使用 Foundry SDK 或 Azure AD / API key 鉴权

---

### 7.4 Vertex AI

**域名**
- 没有在本次读取片段中看到固定 host 常量
- 由 Vertex SDK / region / project 组合构造

**调用位置**
- `src/services/api/client.ts`

**功能**
- Claude 模型经 Google Vertex 调用

---

### 7.5 AWS Bedrock

**域名**
- 未在当前读取中看到固定 host 常量
- 通常由 Bedrock SDK 按 region 构造

**调用位置**
- `src/services/api/client.ts`

**功能**
- Claude 模型经 AWS Bedrock 调用

---

## 八、Remote Managed Settings / Policy / 组织控制相关接口

### 8.1 `BASE_API_URL + /api/claude_code/policy_limits`

**生产完整 URL**
- `https://api.anthropic.com/api/claude_code/policy_limits`

**staging 完整 URL**
- `https://api-staging.anthropic.com/api/claude_code/policy_limits`

**功能**
- 拉取组织级功能限制，如：
  - 是否允许 remote control
  - 是否允许 remote sessions
  - 某些产品功能是否受限

**调用位置**
- `src/services/policyLimits/index.ts`

---

### 8.2 Remote Managed Settings 接口

> 本次读取的片段没有直接展开最终 endpoint 常量，但可以明确确认其存在于 `src/services/remoteManagedSettings/` 链路中，并依赖 first-party base URL / OAuth or API key 条件。

**功能**
- 拉取远程受管设置
- 缓存到 `~/.claude/remote-settings.json`

**相关调用位置**
- `src/services/remoteManagedSettings/syncCache.ts`
- `src/services/remoteManagedSettings/syncCacheState.ts`

**说明**
- 它走第一方 API 域名
- 但 endpoint 字符串本次未单独展开到常量级别

---

## 九、用户可配置 / 动态域名

这类域名不是代码硬编码，但项目明确支持：

### 9.1 `CLAUDE_CODE_CUSTOM_OAUTH_URL`

**功能**
- 把 OAuth / API key / roles / success/callback 全部重定向到批准的 OAuth base URL

**允许值**
- `https://beacon.claude-ai.staging.ant.dev`
- `https://claude.fedstart.com`
- `https://claude-staging.fedstart.com`

**调用位置**
- `src/constants/oauth.ts`

---

### 9.2 `connectedProviders['custom-openai'].baseUrl`

**功能**
- 自定义 OpenAI-compatible provider 根域名

**接口派生**
- `/v1/chat/completions`
- `/v1/models`

**调用位置**
- `src/services/api/customOpenAIClient.ts`

---

### 9.3 MCP Server Remote URL

**功能**
- 来自用户/MCP registry/plugin/project config 的 remote MCP server URL
- 用于 MCP transport 连接

**调用位置**
- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/officialRegistry.ts`

---

## 十、按功能分类速查表

| 域名 / Host | 接口/路径 | 功能 |
|---|---|---|
| `api.anthropic.com` | `/api/claude_code/policy_limits` | 组织级策略限制 |
| `api.anthropic.com` | `/api/event_logging/batch` | 1P 事件日志上报 |
| `api.anthropic.com` | `/api/oauth/claude_cli/create_api_key` | OAuth 后创建 API key |
| `api.anthropic.com` | `/api/oauth/claude_cli/roles` | 获取角色/组织信息 |
| `platform.claude.com` | `/oauth/authorize` | Console OAuth 授权 |
| `platform.claude.com` | `/v1/oauth/token` | OAuth code/token 交换与刷新 |
| `platform.claude.com` | `/oauth/code/callback` | OAuth 回调 |
| `claude.com` | `/claude-code` | 产品页 |
| `claude.com` | `/cai/oauth/authorize` | Claude.ai OAuth attribution 跳板 |
| `claude.ai` | `/code/{sessionId}` | 远程 code session 页面 |
| `claude.ai` | `/oauth/claude-code-client-metadata` | MCP OAuth client metadata |
| `api.anthropic.com` | `/mcp-registry/v0/servers?...` | 官方 MCP registry |
| `mcp-proxy.anthropic.com` | `/v1/mcp/{server_id}` | MCP Proxy |
| `http-intake.logs.us5.datadoghq.com` | `/api/v2/logs` | Datadog 日志上报 |
| `api.githubcopilot.com` | `/models` | Copilot 模型列表 |
| `api.githubcopilot.com` | `/chat/completions` | Copilot Chat Completions |
| `models.dev` | `/api.json` | Copilot fallback 模型元数据 |
| `*.services.ai.azure.com` | `/anthropic/v1/messages` | Azure Foundry Anthropic 接口 |
| `custom-openai baseUrl` | `/v1/chat/completions` | 自定义 OpenAI-compatible 聊天接口 |
| `custom-openai baseUrl` | `/v1/models` | 自定义 OpenAI-compatible 模型列表 |

---

## 十一、补充说明

### 11.1 为什么有些接口没法 100% 静态枚举

原因是项目里有一部分 URL 不是硬编码常量，而是：
- 基于 `BASE_API_URL` 拼接
- 基于 provider `baseUrl` 拼接
- 基于 Bridge API client / SDK transport 封装构造
- 由第三方 SDK 内部构造（如 Bedrock / Vertex）

所以本清单更适合被理解为：
- **项目真实使用的域名与接口面总览**

而不是单纯字符串 grep 结果。

### 11.2 已补充的专项接口文档

我已经把这份总清单继续拆成 5 份更细的专项接口文档：

1. `OAUTH_ENDPOINTS_ANALYSIS.md`
2. `MCP_ENDPOINTS_ANALYSIS.md`
3. `BRIDGE_ENDPOINTS_ANALYSIS.md`
4. `TELEMETRY_ENDPOINTS_ANALYSIS.md`
5. `PROVIDER_ENDPOINTS_ANALYSIS.md`

这些专项文档额外强调：
- 请求方法
- 鉴权方式
- URL 构造方式
- 主要调用链

### 11.3 如果你还要更细

下一步还可以继续做：

1. **按源码调用链列出每个接口的请求头、入参、返回值路径**
2. **针对 Bridge / MCP / OAuth 画接口时序图**
3. **补一份“动态 URL 构造总表”**（baseUrl 来源、环境切换、拼接规则）

---

## 十二、一句话结论

这个项目的外部网络面主要围绕 Anthropic 第一方 API/OAuth、Claude.ai Web/远程会话、MCP registry/proxy、Datadog 遥测，以及 Copilot/OpenAI-compatible/云厂商 provider 适配展开；其中大量关键接口并不是简单字符串，而是运行时按环境和 provider 策略动态拼接。