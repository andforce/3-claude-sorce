# MCP 接口与 URL 模式分析

## 1. 官方注册表

### `GET https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial`
- **方法**: GET
- **鉴权**: 无
- **功能**: 拉取 Anthropic 官方商业 MCP registry
- **主要调用**:
  - `src/services/mcp/officialRegistry.ts#prefetchOfficialMcpUrls`
  - 启动时由 `src/main.tsx` 触发

---

## 2. Claude.ai Connector Registry

### `GET {BASE_API_URL}/v1/mcp_servers?limit=1000`
- **生产**: `https://api.anthropic.com/v1/mcp_servers?limit=1000`
- **方法**: GET
- **鉴权**:
  - `Authorization: Bearer <OAuth access token>`
  - `anthropic-beta: mcp-servers-2025-12-04`
- **功能**: 获取 Claude.ai 管理的 MCP connectors
- **主要调用**:
  - `src/services/mcp/claudeai.ts#fetchClaudeAIMcpConfigsIfEligible`
  - `src/services/mcp/config.ts`
  - `src/services/mcp/useManageMCPConnections.ts`

---

## 3. MCP Proxy

### `{MCP_PROXY_URL}/v1/mcp/{server_id}`
- **生产**: `https://mcp-proxy.anthropic.com/v1/mcp/{server_id}`
- **staging**: `https://mcp-proxy-staging.anthropic.com/v1/mcp/{server_id}`
- **local**: `http://localhost:8205/v1/toolbox/shttp/mcp/{server_id}`
- **传输**: Streamable HTTP
- **功能**: 通过 Anthropic proxy 连接 Claude.ai 托管的 MCP server
- **主要调用**:
  - `src/services/mcp/client.ts#connectToServer` (`type === 'claudeai-proxy'`)

---

## 4. Remote MCP Server URL 模式

### SSE MCP
- **URL 来源**: `serverRef.url`
- **传输**: SSEClientTransport
- **功能**: 通过 SSE 连接远程 MCP server
- **主要调用**:
  - `src/services/mcp/client.ts#connectToServer`

### Streamable HTTP MCP
- **URL 来源**: `serverRef.url`
- **传输**: StreamableHTTPClientTransport
- **功能**: 通过 HTTP 流式方式连接远程 MCP server
- **主要调用**:
  - `src/services/mcp/client.ts#connectToServer`

### WebSocket MCP
- **URL 来源**: `serverRef.url`
- **传输**: WebSocket / WSS
- **功能**: 通过 WebSocket 连接 MCP server
- **主要调用**:
  - `src/services/mcp/client.ts#connectToServer`

---

## 5. MCP OAuth / Auth Discovery

### `GET authServerMetadataUrl`
- **方法**: GET
- **鉴权**: 通常无
- **功能**: 如果 MCP 配置显式提供 AS metadata URL，则直接拉取
- **主要调用**:
  - `src/services/mcp/auth.ts`

### `GET {issuer}/.well-known/openid-configuration`
- **方法**: GET
- **鉴权**: 无
- **功能**: XAA / OIDC discovery
- **主要调用**:
  - `src/services/mcp/xaaIdpLogin.ts`

### RFC 9728 / RFC 8414 discovery
- **URL 来源**: MCP resource URL / advertised AS URL
- **方法**: GET
- **功能**:
  - 发现 protected resource metadata
  - 发现 authorization server metadata
- **主要调用**:
  - `src/services/mcp/auth.ts`
  - `src/services/mcp/xaa.ts`

---

## 6. MCP OAuth Callback

### `http://127.0.0.1:{port}/callback`
- **方法**: 浏览器回调本地 HTTP listener
- **功能**: MCP OAuth authorization code callback
- **主要调用**:
  - `src/services/mcp/auth.ts`
  - `src/tools/McpAuthTool/McpAuthTool.ts`

---

## 7. XAA Token Exchange

### `POST idpTokenEndpoint`
- **方法**: POST
- **Content-Type**: `application/x-www-form-urlencoded`
- **功能**: `id_token -> ID-JAG`
- **主要调用**:
  - `src/services/mcp/xaa.ts`

### `POST asMeta.token_endpoint`
- **方法**: POST
- **Content-Type**: `application/x-www-form-urlencoded`
- **功能**: `ID-JAG -> access_token`
- **主要调用**:
  - `src/services/mcp/xaa.ts`

---

## 8. 一句话结论

MCP 接口面包括官方 registry、Claude.ai connector registry、MCP proxy、远程 MCP transport URL，以及配套的 OAuth/XAA discovery 与 token exchange 链路。