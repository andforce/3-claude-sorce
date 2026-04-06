# Claude Code MCP 架构深度解析

## 1. 定位

Claude Code 的 MCP 架构核心不只是“连一下外部 server”。

从源码看，它包含至少四层：

1. 配置解析与来源合并
2. server approval / policy gating
3. client lifecycle / reconnect
4. tool / prompt / resource surface 注入 runtime

核心目录：
- `src/services/mcp/`

关键文件：
- `client.ts`
- `config.ts`
- `types.ts`
- `useManageMCPConnections.ts`
- `officialRegistry.ts`
- `elicitationHandler.ts`

---

## 2. MCP 总体结构

```text
config sources
  → merge / validate / approve / policy filter
  → connectToServer()
  → fetch tools / prompts / resources
  → wrap as Claude Code Tool / Command / Resource bridge
  → inject into runtime
```

它不是单次 connect，而是一套持续管理连接、缓存、认证、通知和动态刷新机制的子系统。

---

## 3. 配置来源与合并

核心文件：
- `src/services/mcp/config.ts`

### 3.1 配置来源

源码里 MCP server config 至少可能来自：
- enterprise config
- user config
- project `.mcp.json`
- local config
- plugin config
- dynamic config
- 可选的 claude.ai connector source

### 3.2 合并逻辑

这些来源会按 precedence 合并，而不是简单拼接。

这意味着 MCP 不是“用户自己加个 server 就完了”，而是被放进一套**多来源配置覆盖体系**里。

### 3.3 配置职责

`config.ts` 负责：
- schema 校验
- env var 展开
- 多 scope 支持
- `.mcp.json` 原子写回
- enabled/disabled 状态管理

---

## 4. approval 与 policy gating

这一块是 MCP 架构里非常关键，但最容易被低估的部分。

### 4.1 project MCP 不是默认激活

对于 project `.mcp.json` server，源码要求显式 approval：
- `getProjectMcpServerStatus()`
- 返回 `approved | rejected | pending`

只有 approved 的 project server 才会进入 active set。

### 4.2 enterprise policy

`config.ts` 中还支持按以下维度做 allow/deny：
- server name
- command
- URL

并且 enterprise-managed MCP 可以覆盖其他来源。

### 4.3 设计含义

MCP 不是一个“无门槛插件入口”，而是：
- 可审批
- 可禁用
- 可被企业策略覆盖
- 可被 source precedence 裁剪

也就是说，它已经接近组织级集成通道，而不是个人玩具扩展。

---

## 5. client lifecycle

核心文件：
- `src/services/mcp/client.ts`

### 5.1 统一连接入口

主入口是：
- `connectToServer()`

它会：
- 根据配置序列化结果做 memoization
- 选择合适 transport
- 初始化 MCP SDK `Client`
- 声明 `roots` / `elicitation` capability
- timeout 保护连接
- 捕获 server capability / version / instructions
- 返回 `connected | failed | needs-auth`

### 5.2 支持的 transport

从源码看支持：
- `stdio`
- `sse`
- `http`
- `ws`
- IDE 变体 transport
- `claudeai-proxy`
- 特殊 in-process server

这说明 MCP 子系统本质上不是单协议，而是一个 **transport abstraction layer**。

### 5.3 连接失效与缓存失效

client lifecycle 的一个重要设计点：
- `client.onclose` 时会清理 connection cache 和 fetch cache
- 下次使用时再由 `ensureConnectedClient()` 惰性重连
- `clearServerCache()` 也会触发 cleanup 与缓存失效

这意味着系统偏向：
- lazy reconnect
- cache invalidation first
- reconnect on demand

而不是强依赖一个长期稳定 socket。

---

## 6. 运行时连接管理

核心文件：
- `src/services/mcp/useManageMCPConnections.ts`

### 6.1 它的职责

这个 hook 是 MCP 与 UI/runtime 的桥。

它负责：
- 初始化 pending clients
- 分两阶段建立连接
  - Claude Code 本地配置优先
  - claude.ai connectors 其次
- 批量更新连接状态
- 注册 notification handler
- 对 remote transport 做 exponential-backoff reconnect

### 6.2 架构含义

这说明 MCP client lifecycle 并不是纯 service 层自运转，而是和 AppState / UI 生命周期耦合在一起。

这是典型的“终端应用式 integration”架构：
- service 负责连接
- hook 负责把连接态投影到 UI/runtime

---

## 7. official registry

核心文件：
- `src/services/mcp/officialRegistry.ts`

### 7.1 它做什么

这个模块会：
- 拉取 Anthropic 的商业 MCP registry
- 规范化 URL
- 在内存里缓存 `officialUrls`
- 提供 `isOfficialMcpUrl()` 判断

### 7.2 它不做什么

它**不**负责：
- 配置合并
- server 启停
- runtime 注册

它只做“官方 URL 分类”这件事。

### 7.3 为什么重要

因为 analytics / trust / PII 策略中，会对 official MCP 与 user-configured MCP 区别对待。

所以 officialRegistry 的作用不是功能，而是 **信任与分类基础设施**。

---

## 8. tools / prompts / resources 如何进入运行时

### 8.1 拉取能力面

连接成功后，`client.ts` 会拉：
- `fetchToolsForClient()`
- `fetchResourcesForClient()`
- `fetchCommandsForClient()`

分别对应 MCP 的：
- `tools/list`
- `resources/list`
- `prompts/list`

### 8.2 tools 注入

MCP tools 会被包装成 Claude Code 内部 `Tool` 接口。

命名规范：
- `mcp__<server>__<tool>`

tool call 会回到：
- `callMCPTool()`
- `callMCPToolWithUrlElicitationRetry()`

### 8.3 prompts 注入

MCP prompts 会变成 slash command：
- `mcp__<server>__<prompt>`

换句话说，MCP prompt 最终被并入统一 command surface。

### 8.4 resources 注入

resource 会作为 `ServerResource[]` 按 server 存储。

如果任一 server 支持 resources，还会额外注入桥接工具：
- `ListMcpResourcesTool`
- `ReadMcpResourceTool`

这说明资源不是直接裸暴露，而是通过 Claude Code 自己的工具表面桥接出来。

---

## 9. 动态更新与通知

`useManageMCPConnections.ts` 会注册 notification handler。

这些 handler 可以在 server 运行期间动态响应：
- tools 变化
- prompts 变化
- resources 变化

一旦变化发生：
- 相关 cache 会失效
- app state 会更新
- runtime 视图会刷新

这意味着 MCP 集成不是“启动时快照”，而是**可热更新的动态集成**。

---

## 10. 认证与 elicitation

### 10.1 auth-gated server

如果 server 需要认证，系统会暴露一个伪工具：
- `McpAuthTool`

用户/模型可以先走认证，再自动把真实 MCP tools 注入回来。

这是一种很巧的设计：
- 把认证动作也做成统一 tool surface
- 避免在 runtime 里额外发明一套旁路流程

### 10.2 elicitation

相关文件：
- `src/services/mcp/elicitationHandler.ts`

它负责把：
- URL / 表单 / 用户补充输入

接到 app state 队列中，等待交互完成后再回传给 MCP 流程。

说明 MCP 并不是“纯机器间协议”，而是已经被接进了 REPL 的 human-in-the-loop 交互框架里。

---

## 11. 架构判断

Claude Code 的 MCP 子系统，本质上包含三重身份：

1. **连接管理器**
2. **受控扩展平台**
3. **运行时表面适配层**

也就是说，它不是简单的 SDK wrapper，而是一套：
- source-aware
- policy-aware
- approval-aware
- runtime-integrated
- hot-reloadable

的扩展子平台。

---

## 12. 关键文件索引

- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/types.ts`
- `src/services/mcp/useManageMCPConnections.ts`
- `src/services/mcp/officialRegistry.ts`
- `src/services/mcp/elicitationHandler.ts`
- `src/tools/MCPTool/`
- `src/tools/McpAuthTool/`
- `src/tools/ListMcpResourcesTool/`
- `src/tools/ReadMcpResourceTool/`

---

## 13. 一句话结论

Claude Code 的 MCP 架构不是“外接 server 插件能力”，而是一套带审批、策略、认证、动态刷新和统一 runtime 注入能力的 **受控扩展平台**。