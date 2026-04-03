# OAuth 接口与调用链分析

## 1. 授权入口

### `GET {CONSOLE_AUTHORIZE_URL}`
- **生产**: `https://platform.claude.com/oauth/authorize`
- **方法**: GET
- **鉴权**: 无，浏览器重定向
- **功能**: 启动 Console OAuth authorization code 流程
- **关键参数**:
  - `client_id`
  - `response_type=code`
  - `redirect_uri`
  - `scope`
  - `code_challenge`
  - `code_challenge_method=S256`
  - `state`
  - 可选 `orgUUID`, `login_hint`, `login_method`
- **主要调用**:
  - `src/services/oauth/client.ts#buildAuthUrl`
  - `src/services/oauth/index.ts#startOAuthFlow`
  - `src/components/ConsoleOAuthFlow.tsx`
  - `src/cli/handlers/auth.ts`

### `GET {CLAUDE_AI_AUTHORIZE_URL}`
- **生产**: `https://claude.com/cai/oauth/authorize`
- **方法**: GET
- **鉴权**: 无，浏览器重定向
- **功能**: 启动 Claude.ai 登录授权流程（带 attribution bounce）
- **主要调用**: 同上

---

## 2. Token 交换与刷新

### `POST {TOKEN_URL}`
- **生产**: `https://platform.claude.com/v1/oauth/token`
- **方法**: POST
- **鉴权**: OAuth client-style body（不是 bearer token）
- **功能 A**: authorization code 换 access/refresh token
- **功能 B**: refresh token 刷新 access token

#### Code Exchange Body
- `grant_type=authorization_code`
- `code`
- `redirect_uri`
- `client_id`
- `code_verifier`
- `state`

#### Refresh Body
- `grant_type=refresh_token`
- `refresh_token`
- `client_id`
- `scope`

**主要调用**:
- `src/services/oauth/client.ts#exchangeCodeForTokens`
- `src/services/oauth/client.ts#refreshOAuthToken`
- `src/services/oauth/index.ts`
- `src/utils/auth.ts`
- `src/cli/handlers/auth.ts`

---

## 3. Profile / Roles / API Key

### `GET {BASE_API_URL}/api/oauth/profile`
- **生产**: `https://api.anthropic.com/api/oauth/profile`
- **方法**: GET
- **鉴权**: `Authorization: Bearer <accessToken>`
- **功能**: 获取 OAuth 账户/组织/profile/subscription 信息
- **主要调用**:
  - `src/services/oauth/getOauthProfile.ts#getOauthProfileFromOauthToken`
  - `src/services/oauth/client.ts#fetchProfileInfo`
  - `src/cli/handlers/auth.ts#installOAuthTokens`
  - `src/utils/auth.ts#validateForceLoginOrg`

### `GET {ROLES_URL}`
- **生产**: `https://api.anthropic.com/api/oauth/claude_cli/roles`
- **方法**: GET
- **鉴权**: `Authorization: Bearer <accessToken>`
- **功能**: 获取组织/工作区角色信息
- **主要调用**:
  - `src/services/oauth/client.ts#fetchAndStoreUserRoles`
  - `src/cli/handlers/auth.ts`

### `POST {API_KEY_URL}`
- **生产**: `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`
- **方法**: POST
- **鉴权**: `Authorization: Bearer <accessToken>`
- **功能**: Console OAuth 用户创建 CLI 使用的 API key
- **主要调用**:
  - `src/services/oauth/client.ts#createAndStoreApiKey`
  - `src/cli/handlers/auth.ts#installOAuthTokens`

---

## 4. 其他相关接口

### `GET {BASE_API_URL}/api/claude_cli_profile`
- **方法**: GET
- **鉴权**:
  - `x-api-key`
  - `anthropic-beta: oauth-2025-04-20`
- **功能**: 用 managed API key 查询 OAuth 风格 profile/account 信息
- **主要调用**:
  - `src/services/oauth/getOauthProfile.ts#getOauthProfileFromApiKey`

### Local Callback
- **形式**: `http://localhost:{port}/callback`
- **方法**: 浏览器回调到本地 HTTP server
- **功能**: 自动 OAuth callback 捕获
- **主要调用**:
  - `src/services/oauth/auth-code-listener.ts`

---

## 5. 环境差异

### Staging
- `https://platform.staging.ant.dev/oauth/authorize`
- `https://platform.staging.ant.dev/v1/oauth/token`
- `https://api-staging.anthropic.com/api/oauth/claude_cli/create_api_key`
- `https://api-staging.anthropic.com/api/oauth/claude_cli/roles`

### Local
- `http://localhost:3000/oauth/authorize`
- `http://localhost:8000/v1/oauth/token`
- `http://localhost:8000/api/oauth/claude_cli/create_api_key`
- `http://localhost:8000/api/oauth/claude_cli/roles`

### Custom Approved OAuth Base
- 来自 `CLAUDE_CODE_CUSTOM_OAUTH_URL`
- 只允许 approved allowlist base
- 统一派生 authorize/token/api-key/roles/success/callback

---

## 6. 调用链总结

```text
UI/CLI login
  → buildAuthUrl()
  → browser authorize
  → localhost/manual callback
  → exchangeCodeForTokens()
  → get profile / roles / create_api_key
  → install tokens/config
```

---

## 7. 一句话结论

OAuth 相关接口主要围绕 authorize、token、profile、roles、create_api_key 五个面展开，形成完整的浏览器授权到本地 CLI 安装令牌闭环。