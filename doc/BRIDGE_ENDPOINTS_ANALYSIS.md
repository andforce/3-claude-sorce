# Bridge / Remote Control 接口分析

## 1. Environment 注册与 work 调度

### `POST /v1/environments/bridge`
- **方法**: POST
- **鉴权**:
  - OAuth bearer
  - `anthropic-beta: environments-2025-11-01`
- **功能**: 注册 bridge environment，返回 `environment_id` 与 `environment_secret`
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`
  - `src/bridge/bridgeApi.ts`

### `GET /v1/environments/{environmentId}/work/poll`
- **方法**: GET
- **鉴权**: `environment_secret` bearer
- **功能**: 拉取待处理 work item
- **主要调用**:
  - `src/bridge/replBridge.ts#startWorkPollLoop`
  - `src/bridge/bridgeMain.ts#runBridgeLoop`

### `POST /v1/environments/{environmentId}/work/{workId}/ack`
- **方法**: POST
- **鉴权**: ingress/session token bearer
- **功能**: ACK 已派发 work，防止重发
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `POST /v1/environments/{environmentId}/work/{workId}/heartbeat`
- **方法**: POST
- **鉴权**: ingress/session token bearer
- **功能**: 维持 work lease
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `POST /v1/environments/{environmentId}/work/{workId}/stop`
- **方法**: POST
- **鉴权**: 视上下文而定
- **功能**: 停止/释放 work item
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `DELETE /v1/environments/bridge/{environmentId}`
- **方法**: DELETE
- **鉴权**: OAuth bearer
- **功能**: 注销 environment
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `POST /v1/environments/{environmentId}/bridge/reconnect`
- **方法**: POST
- **鉴权**: OAuth bearer
- **功能**: 让既有 session 重新入队，等待 environment 重连
- **主要调用**:
  - `src/bridge/replBridge.ts`
  - `src/bridge/bridgeMain.ts`

---

## 2. Session 管理

### `POST /v1/sessions`
- **方法**: POST
- **鉴权**:
  - OAuth bearer
  - org UUID
  - `anthropic-beta: ccr-byoc-2025-07-29`
- **功能**: 创建 Remote Control session
- **主要调用**:
  - `src/bridge/createSession.ts#createBridgeSession`
  - `src/bridge/initReplBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `GET /v1/sessions/{sessionId}`
- **方法**: GET
- **鉴权**: OAuth bearer
- **功能**: 获取 session metadata
- **主要调用**:
  - `src/bridge/createSession.ts#getBridgeSession`

### `PATCH /v1/sessions/{sessionId}`
- **方法**: PATCH
- **鉴权**: OAuth bearer
- **功能**: 更新 session title
- **主要调用**:
  - `src/bridge/createSession.ts#updateBridgeSessionTitle`

### `POST /v1/sessions/{sessionId}/archive`
- **方法**: POST
- **鉴权**: OAuth bearer / bridge API auth
- **功能**: 归档 session
- **主要调用**:
  - `src/bridge/initReplBridge.ts`
  - `src/bridge/bridgeMain.ts`

### `POST /v1/sessions/{sessionId}/events`
- **方法**: POST
- **鉴权**: session token bearer
- **功能**: 发送 permission/control response event
- **主要调用**:
  - `src/bridge/bridgeApi.ts#sendPermissionResponseEvent`

---

## 3. Code Session / CCR v2

### `POST /v1/code/sessions`
- **方法**: POST
- **鉴权**: OAuth bearer
- **功能**: 创建 env-less / CCR v2 code session
- **主要调用**:
  - `src/bridge/codeSessionApi.ts#createCodeSession`
  - `src/bridge/remoteBridgeCore.ts`

### `POST /v1/code/sessions/{sessionId}/bridge`
- **方法**: POST
- **鉴权**: OAuth bearer，可附 trusted-device token
- **功能**: 获取 `worker_jwt`, `api_base_url`, `expires_in`, `worker_epoch`
- **主要调用**:
  - `src/bridge/codeSessionApi.ts#fetchRemoteCredentials`
  - `src/bridge/remoteBridgeCore.ts`

### `POST {sessionUrl}/worker/register`
- **方法**: POST
- **鉴权**: worker credential
- **功能**: 注册 CCR v2 worker
- **主要调用**:
  - `src/bridge/workSecret.ts#registerWorker`
  - `src/bridge/replBridgeTransport.ts`

### `GET {sessionUrl}/worker/events/stream`
- **传输**: SSE
- **功能**: CCR v2 inbound event stream
- **主要调用**:
  - `src/cli/transports/SSETransport.ts`
  - `src/bridge/replBridgeTransport.ts`

### `{sessionUrl}/worker/*`
- **方法/传输**: HTTP + SSE 混合
- **功能**: CCR v2 worker 写入/状态/投递/heartbeat
- **主要调用**:
  - `src/bridge/replBridgeTransport.ts`
  - `src/bridge/remoteBridgeCore.ts`

---

## 4. Web URL

### `https://claude.ai/code/{sessionId}`
- **功能**: 远程 code session 网页
- **来源**: `src/constants/product.ts#getRemoteSessionUrl`

### `https://claude.ai/code?bridge={environmentId}`
- **功能**: bridge connect URL
- **来源**: `src/bridge/bridgeStatusUtil.ts#buildBridgeConnectUrl`

### v1 ingress WebSocket URL
- **形式**: `ws(s)://{host}/.../session_ingress/ws/{sessionId}`
- **功能**: Session-Ingress WebSocket 通道
- **来源**: `src/bridge/workSecret.ts#buildSdkUrl`

### v2 session base URL
- **形式**: `{api_base_url}/v1/code/sessions/{cse_*}`
- **功能**: CCR v2 worker 接口根路径
- **来源**: `src/bridge/workSecret.ts#buildCCRv2SdkUrl`

---

## 5. 一句话结论

Bridge/Remote Control 的接口面主要由 environment 注册、work 调度、session 管理和 CCR v2 worker 通道组成。