# Model Provider 接口分析

## 1. Anthropic 第一方 / 兼容 Anthropic

### Anthropic First-Party Base
- **生产**: `https://api.anthropic.com`
- **staging**: `https://api-staging.anthropic.com`
- **传输**: Anthropic SDK，主路径为 streaming messages API
- **主要调用**:
  - `src/services/api/client.ts`
  - `src/services/api/claude.ts`

### Model List
- **形式**: `{base}/v1/models`
- **功能**: 模型发现
- **主要调用**:
  - Anthropic-compatible provider 场景

---

## 2. GitHub Copilot

### `GET https://api.githubcopilot.com/models`
- **方法**: GET
- **鉴权**: `Authorization: Bearer <copilot token>`
- **功能**: 获取 Copilot 模型列表
- **主要调用**:
  - `src/services/api/copilotClient.ts#fetchCopilotModelsFromApi`

### `POST https://api.githubcopilot.com/chat/completions`
- **方法**: POST
- **鉴权**: `Authorization: Bearer <copilot token>`
- **功能**: OpenAI 风格 chat completions
- **主要调用**:
  - `src/services/api/copilotClient.ts`
  - 经 `src/services/api/client.ts` fetch override 选择

### `GET https://models.dev/api.json`
- **方法**: GET
- **鉴权**: 无
- **功能**: Copilot fallback 模型元数据源
- **主要调用**:
  - `src/services/api/copilotClient.ts#fetchCopilotModelsFromModelsDev`

---

## 3. Custom OpenAI-Compatible

### `{base}/v1/chat/completions`
- **方法**: POST
- **鉴权**: `Authorization: Bearer <apiKey>`（如果配置了）
- **功能**: OpenAI-compatible chat completions
- **主要调用**:
  - `src/services/api/customOpenAIClient.ts#createCustomOpenAIFetchOverride`

### `{base}/v1/models`
- **方法**: GET
- **鉴权**: 取决于 provider 配置
- **功能**: 获取模型列表
- **主要调用**:
  - `src/services/api/customOpenAIClient.ts`

**构造规则**
- 若 base 已以 `/v1` 结尾，则直接拼 `/chat/completions` 或 `/models`
- 否则自动补 `/v1/...`

---

## 4. Azure Foundry

### `https://{resource}.services.ai.azure.com/anthropic/v1/messages`
- **方法/传输**: Foundry SDK 负责
- **鉴权**:
  - API key
  - 或 Azure AD token provider
- **功能**: 通过 Azure Foundry 调用 Claude
- **主要调用**:
  - `src/services/api/client.ts`

---

## 5. Vertex AI

### Vertex Endpoint Pattern
- **说明**: 具体 endpoint 由 Vertex SDK 构造
- **鉴权**: `google-auth-library`
- **功能**: 通过 Google Vertex 调用 Claude
- **主要调用**:
  - `src/services/api/client.ts`

---

## 6. AWS Bedrock

### Bedrock Endpoint Pattern
- **说明**: 具体 endpoint 由 Bedrock SDK 构造
- **鉴权**:
  - AWS credentials
  - 或可选 bearer token
- **功能**: 通过 AWS Bedrock 调用 Claude
- **主要调用**:
  - `src/services/api/client.ts`

---

## 7. 一句话结论

Provider 接口面以 Anthropic 第一方为基准，再通过 fetch override 或云厂商 SDK 适配 Copilot、OpenAI-compatible、Bedrock、Vertex、Foundry 等不同后端。