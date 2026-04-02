# Claude Code CLI (v2.1.88) 架构深度解析

> 基于源代码重建分析，涵盖系统架构、数据流、宠物系统、追踪机制等核心设计

---

## 一、整体架构概览

### 1.1 代码规模

| 指标 | 数值 |
|------|------|
| 总代码量 | ~51.6 万行 TypeScript/TSX |
| 源文件数 | ~1,914 个文件 |
| 构建输出 | 单个 22MB ES Module (dist/cli.js) |
| 构建工具 | Bun v1.3.11+ (bun:bundle API) |
| 包管理器 | pnpm |

### 1.2 核心架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    Entry Points (入口层)                     │
│  cli.tsx → main.tsx → REPL.tsx                              │
├─────────────────────────────────────────────────────────────┤
│                   UI Layer (终端 UI 层)                      │
│  React + Ink (自定义终端渲染引擎)                             │
│  components/ (~389 文件) + ink/ (~96 文件)                  │
├─────────────────────────────────────────────────────────────┤
│                  Command System (命令系统)                   │
│  commands/ (~103 文件) - Slash commands (/cmd)              │
├─────────────────────────────────────────────────────────────┤
│                    Tool System (工具层)                      │
│  tools/ (~184 文件) - Agent, Bash, File*, MCP, etc.         │
├─────────────────────────────────────────────────────────────┤
│                 Services Layer (服务层)                      │
│  services/ (~130 文件) - API, MCP, Analytics, etc.          │
├─────────────────────────────────────────────────────────────┤
│                   State Management (状态)                    │
│  AppState.ts + bootstrap/state.ts (集中式 React-like 状态)   │
├─────────────────────────────────────────────────────────────┤
│                   Utilities (工具函数)                       │
│  utils/ (~564 文件)                                         │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键目录结构

```
src/
├── entrypoints/          # 应用入口 (cli.tsx)
├── commands/             # Slash 命令 (~103 文件)
├── components/           # 终端 UI 组件 (~389 文件)
│   ├── design-system/    # UI 基础组件
│   ├── messages/         # 消息渲染
│   └── permissions/      # 权限对话框
├── tools/                # 工具实现 (~184 文件)
│   ├── AgentTool/        # 子代理
│   ├── BashTool/         # Shell 执行
│   ├── File*Tool/        # 文件操作
│   └── MCPTool/          # MCP 协议
├── services/             # 核心业务逻辑 (~130 文件)
│   ├── mcp/              # Model Context Protocol
│   ├── api/              # API 客户端
│   ├── analytics/        # 遥测/分析
│   └── policyLimits/     # 策略限制
├── utils/                # 工具函数 (~564 文件)
├── hooks/                # 生命周期钩子 (~104 文件)
├── ink/                  # 自定义终端渲染引擎 (~96 文件)
├── state/                # 状态管理
├── types/                # TypeScript 类型
├── buddy/                # 宠物系统
└── vendor/               # 内部 vendor 代码
```

---

## 二、用户输入处理流程（核心业务流程）

### 2.1 完整数据流

```
用户输入 → PromptInput组件 → processUserInput() → 命令解析 → 执行
                ↓                                              ↓
         状态更新(AppState)                              API调用
                ↓                                              ↓
         本地渲染(Optimistic UI)                      流式响应处理
                ↓                                              ↓
         附件提取(Attachments)                        工具调用循环
```

### 2.2 阶段详解

#### 阶段 1: 输入捕获
**文件**: `src/components/PromptInput/PromptInput.tsx`

- 支持 Vim 模式或普通模式编辑
- 多行输入、粘贴图片、拖放文件
- 实时显示 token 预算消耗
- 宠物系统状态同步 (每 500ms tick)

#### 阶段 2: 输入处理
**文件**: `src/utils/processUserInput/processUserInput.ts:85`

```typescript
export async function processUserInput({
  input,                    // 用户输入内容
  mode,                     // 'prompt' | 'bash' 等模式
  context,                  // ToolUseContext
  ideSelection,            // IDE 选中内容
  messages,                // 历史消息
  // ... 更多参数
}): Promise<ProcessUserInputBaseResult>
```

**处理分支逻辑**:

| 输入类型 | 处理方式 | 目标文件 |
|---------|---------|---------|
| `mode === 'bash'` | Bash 命令 | `processBashCommand.tsx` |
| `input.startsWith('/')` | Slash 命令 | `processSlashCommand.ts` |
| 普通文本 | 文本提示词 | `processTextPrompt.ts` |

#### 阶段 3: 附件提取
**文件**: `src/utils/attachments.ts`

自动检测并提取:
- `@file` - 文件引用
- `@url` - URL 内容
- `@agent-mention` - 代理提及
- 图片处理和压缩
- IDE 选中内容注入

#### 阶段 4: Hook 执行
**文件**: `src/utils/hooks.ts`

```typescript
for await (const hookResult of executeUserPromptSubmitHooks(...)) {
  // 检查是否阻止继续
  if (hookResult.blockingError) { /* 阻止 */ }
  if (hookResult.preventContinuation) { /* 停止 */ }
  // 收集额外上下文
  if (hookResult.additionalContexts) { /* 附加 */ }
}
```

Hook 类型:
- `pre_prompt_submit` - 提交前检查
- `pre_tool_use` - 工具调用前
- `post_tool_use` - 工具调用后

#### 阶段 5: API 调用
**文件**: `src/query.ts`

- 流式响应处理 (SSE)
- 工具调用循环 (Tool Loop)
- Token 预算管理
- 上下文压缩

---

## 三、命令系统架构

### 3.1 命令数据结构

**文件**: `src/commands.ts`

```typescript
export type Command = {
  name: string                    // 命令名
  aliases?: string[]              // 别名
  description: string             // 描述
  isEnabled?: () => boolean       // 动态启用检查
  availability?: Array<'claude-ai' | 'console'>  // 可用性限制
  // 执行方式二选一:
  userFacing?: (args) => ReactNode     // 交互式 JSX
  runInTerminal?: (args) => Promise<string>  // 终端输出
}
```

### 3.2 命令来源层级（优先级从高到低）

```
1. 内置命令 (COMMANDS)
   └── src/commands/ 下的 40+ 命令

2. 功能标志命令 (Feature-gated)
   └── /voice, /bridge, /ultraplan, /torch 等

3. 技能目录命令 (Skill Dir)
   └── ~/.claude/skills/ 用户自定义

4. 插件命令 (Plugins)
   └── 市场下载的插件

5. 工作流命令 (Workflows)
   └── 自定义自动化脚本

6. 动态技能 (Dynamic Skills)
   └── 基于文件操作自动发现
```

### 3.3 命令执行流程

```typescript
// 1. 命令查找
const cmd = findCommand(parsed.commandName, commands)

// 2. 可用性检查
if (!meetsAvailabilityRequirement(cmd)) return

// 3. 权限/启用检查
if (!isCommandEnabled(cmd)) return

// 4. 执行路由
if (cmd.userFacing) {
  // 交互式 JSX 命令 (本地 UI)
  setToolJSX({ jsx: cmd.userFacing(...), ... })
} else if (cmd.runInTerminal) {
  // 终端输出命令
  const output = await cmd.runInTerminal(...)
}
```

### 3.4 可用性控制

**文件**: `src/commands.ts`

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key 用户 (直接 1P API 客户)
        if (!isClaudeAISubscriber() && !isUsing3PServices())
          return true
        break
    }
  }
  return false
}
```

---

## 四、宠物系统（Companion/Buddy）详解

### 4.1 系统架构

**目录**: `src/buddy/`

```
┌────────────────────────────────────────┐
│      CompanionSprite.tsx (UI 层)       │
│  - 500ms tick 动画循环                  │
│  - 对话气泡渲染                         │
│  - 抚摸交互反馈                         │
├────────────────────────────────────────┤
│        companion.ts (逻辑层)            │
│  - 基于 userId 的确定性生成              │
│  - Mulberry32 PRNG                      │
│  - 稀有度/属性计算                      │
├────────────────────────────────────────┤
│         sprites.ts (渲染层)             │
│  - 18 种物种 ASCII 精灵                 │
│  - 3 帧 idle 动画                       │
│  - 帽子/眼睛定制                        │
├────────────────────────────────────────┤
│          types.ts (数据层)              │
│  - 5 级稀有度: common → legendary       │
│  - 5 项属性: DEBUGGING, PATIENCE, etc.  │
└────────────────────────────────────────┘
```

### 4.2 数据模型

**文件**: `src/buddy/types.ts`

```typescript
// 确定性部分 - 从 userId 哈希生成
export type CompanionBones = {
  rarity: Rarity           // common/uncommon/rare/epic/legendary
  species: Species         // 18 种物种
  eye: Eye                 // 6 种眼睛样式
  hat: Hat                 // 8 种帽子 (common 无帽子)
  shiny: boolean           // 1% 闪光
  stats: Record<StatName, number>  // 5 项属性 1-100
}

// 灵魂部分 - 模型生成，存储一次
export type CompanionSoul = {
  name: string             // 宠物名字
  personality: string      // 个性描述
}

// 完整宠物 = Bones + Soul
export type Companion = CompanionBones & CompanionSoul & {
  hatchedAt: number        // 孵化时间戳
}
```

**物种列表** (18种):
- duck, goose, blob, cat, dragon, octopus
- owl, penguin, turtle, snail, ghost
- axolotl, capybara, cactus, robot
- rabbit, mushroom, chonk

**稀有度权重**:
| 稀有度 | 权重 | 星星 | 属性下限 |
|-------|------|------|---------|
| common | 60 | ★ | 5 |
| uncommon | 25 | ★★ | 15 |
| rare | 10 | ★★★ | 25 |
| epic | 4 | ★★★★ | 35 |
| legendary | 1 | ★★★★★ | 50 |

### 4.3 生成算法

**文件**: `src/buddy/companion.ts`

**确定性生成** (同一用户始终相同):

```typescript
const SALT = 'friend-2026-401'

export function roll(userId: string): Roll {
  const key = userId + SALT
  const rng = mulberry32(hashString(key))
  
  return {
    bones: {
      rarity: rollRarity(rng),      // 加权随机
      species: pick(rng, SPECIES),  // 18 选 1
      eye: pick(rng, EYES),         // 6 选 1
      hat: rarity === 'common' ? 'none' : pick(rng, HATS),
      shiny: rng() < 0.01,          // 1% 概率
      stats: rollStats(rng, rarity), // 基于稀有度
    },
    inspirationSeed: Math.floor(rng() * 1e9)
  }
}
```

**属性生成算法**:
```typescript
function rollStats(rng, rarity): Record<StatName, number> {
  const floor = RARITY_FLOOR[rarity]  // 基于稀有度的下限
  const peak = pick(rng, STAT_NAMES)  // 一项峰值属性
  const dump = pick(rng, STAT_NAMES)  // 一项低谷属性 (≠ peak)
  
  return {
    [peak]: Math.min(100, floor + 50 + rng() * 30),  // 峰值
    [dump]: Math.max(1, floor - 10 + rng() * 15),    // 低谷
    [others]: floor + rng() * 40                      // 其他
  }
}
```

**灵魂生成**:
- 首次孵化时由模型生成 (name + personality)
- 存储在 `config.companion`
- **骨骼属性每次重新生成** - 防止用户编辑配置伪造稀有度

### 4.4 交互机制

**动画系统**:
```typescript
const TICK_MS = 500                    // 500ms tick
const IDLE_SEQUENCE = [0,0,0,0,1,0,0,0,-1,0,0,2,0,0,0]  // 15 帧循环
// 0=静止, 1=小动作1, 2=小动作2, -1=眨眼
```

**交互类型**:
| 交互 | 效果 | 持续时间 |
|-----|------|---------|
| `/buddy pet` | 飘浮爱心动画 | 2.5s |
| 选中 (Tab) | 高亮 + 名字反色 | 持续 |
| 模型触发 | 对话气泡显示 | 10s |
| 狭窄终端 | 简化为单行动物面部 | 自适应 |

**对话气泡**:
- 由模型通过特殊标记触发
- 10秒后自动淡出
- 最后 3 秒变暗提示即将消失
- 全屏模式: 浮动气泡
- 普通模式: 内联显示

---

## 五、数据收集与追踪系统

### 5.1 追踪架构

**目录**: `src/services/analytics/`

```
┌─────────────────────────────────────────────┐
│           Analytics Sink (聚合层)             │
│  - 事件队列 (启动时缓冲)                       │
│  - 分发到多个后端                             │
├─────────────────────────────────────────────┤
│  Datadog (指标) │  1P Event Logging (详细)  │
│  - 采样率控制    │  - BigQuery 存储           │
│  - 实时仪表板    │  - PII 分级处理            │
└─────────────────────────────────────────────┘
```

### 5.2 收集的数据类型

#### A. 环境元数据
**文件**: `src/services/analytics/metadata.ts:417-451`

```typescript
type EnvContext = {
  platform: string           // mac/linux/windows
  platformRaw: string        // 原始平台 (含 freebsd/openbsd)
  arch: string               // arm64/x64
  nodeVersion: string        // Node 版本
  terminal: string | null    // iTerm/VS Code/etc
  packageManagers: string    // npm,pnpm,yarn,brew...
  runtimes: string           // node,bun,python...
  isCi: boolean
  isClaudeCodeRemote: boolean
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase: string        // 基础版本 (如 2.0.36-dev)
  buildTime: string
  deploymentEnvironment: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string               // git/hg/svn
  coworkerType?: string      // 协作类型 (feature-gated)
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string[]            // 用户标签
  githubEventName?: string   // GitHub Actions
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
}
```

#### B. 用户身份标识
**文件**: `src/utils/user.ts`, `src/utils/auth.ts`

```typescript
type CoreUserData = {
  deviceId: string           // 持久化 UUID
  sessionId: string          // 每次启动生成
  email?: string             // OAuth 邮箱
  accountUuid?: string       // Claude.ai 账户 UUID
  organizationUuid?: string  // 企业组织 UUID
  userType?: string          // 'ant' 或 undefined
  subscriptionType?: string  // max/pro/enterprise/team
  rateLimitTier?: string     // 限流层级
  firstTokenTime?: number    // 首次使用 token 时间
  githubActionsMetadata?: {   // CI 环境元数据
    actor?: string
    actorId?: string
    repository?: string
    repositoryId?: string
    repositoryOwner?: string
    repositoryOwnerId?: string
  }
}
```

**设备 ID 生成**:
```typescript
// 持久化存储在 ~/.claude/config.json
function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (!config.userID) {
    config.userID = randomUUID()
    saveGlobalConfig(config)
  }
  return config.userID
}
```

#### C. 仓库标识
**文件**: `src/services/analytics/metadata.ts:702`

```typescript
// 用于关联服务端仓库数据
rh: getRepoRemoteHash()  // 远程 URL 的 SHA256 前16字符
```

实现:
```typescript
const getRepoRemoteHash = memoize(async (): Promise<string | undefined> => {
  const remote = await getDefaultRemoteUrl()
  if (!remote) return undefined
  const hash = createHash('sha256').update(remote).digest('hex')
  return hash.slice(0, 16)
})
```

#### D. 行为事件

| 事件名 | 触发时机 | 数据内容 |
|-------|---------|---------|
| `tengu_tool_use_*` | 工具调用 | 工具名、文件扩展名(脱敏) |
| `tengu_subagent_at_mention` | @agent 使用 | 是否仅子代理、是否前缀 |
| `tengu_pasted_image_resize_attempt` | 粘贴图片 | 原始大小、压缩后大小 |
| `tengu_ultraplan_keyword` | 关键词触发 | - |
| `analytics_sink_attached` | 启动完成 | 队列事件数 |
| `code_edit_*` | 代码编辑 | 编辑类型、行数 |
| `tengu_backseat_*` | 观察者分类器 | 建议类型 |
| `tengu_skill_discovery_*` | 技能发现 | 技能名 |

### 5.3 PII 处理策略

#### 类型标记系统
**文件**: `src/services/analytics/index.ts`

```typescript
// 强制开发者显式确认数据安全
type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

// 使用示例
logEvent('tengu_tool_use_bash', {
  file_extensions: getFileExtensionsFromBashCommand(cmd) 
    as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
})
```

#### PII 分级字段
**文件**: `src/services/analytics/metadata.ts`

```typescript
// PII 标记字段 - 仅发送到特权 BigQuery 列
type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

// 使用 _PROTO_ 前缀
const protoPayload = {
  '_PROTO_userEmail': email as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  '_PROTO_accountId': accountId as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
}
```

处理流程:
1. **普通字段** → Datadog + BigQuery (JSON blob)
2. **`_PROTO_*` 字段** → stripProtoFields() 剥离 → 仅 BigQuery 列

#### 工具名脱敏
```typescript
export function sanitizeToolNameForAnalytics(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool'  // 自定义 MCP 脱敏
  }
  return toolName      // 内置工具保留
}
```

例外 (记录详细 MCP 信息):
- Cowork 模式 (`entrypoint=local-agent`)
- Claude.ai 代理的连接器
- 官方 MCP 注册表的 URL

### 5.4 用户追踪能力

基于收集的数据，系统可以实现：

#### 设备/用户识别
| 标识符 | 来源 | 持久性 |
|-------|------|--------|
| `deviceId` | `~/.claude/config.json` | 永久 |
| `sessionId` | 启动时生成 | 单次会话 |
| `accountUuid` | Claude.ai OAuth | 账户级 |
| `organizationUuid` | 企业 OAuth | 组织级 |

#### 环境判断
- **CI 检测**: `isCi`, `isGithubAction`, `GITHUB_ACTIONS`
- **远程模式**: `isClaudeCodeRemote`, `coworkerType`
- **WSL**: `wslVersion`
- **编辑器**: `terminal` (iTerm/VS Code/Hyper 等)
- **部署环境**: `deploymentEnvironment`

#### 使用模式分析
- 工具使用频率热力图
- 模型选择偏好分布
- 订阅类型与功能使用关联
- 会话时长/成本趋势
- 平台/终端类型分布

---

## 六、关键子系统详解

### 6.1 状态管理

**双层状态设计**:

| 层级 | 文件 | 用途 | 特性 |
|-----|------|------|------|
| 全局信号 | `bootstrap/state.ts` | 会话级数据 | Signal 响应式 |
| React 状态 | `state/AppState.tsx` | UI 状态 | useState/useReducer |

**关键状态**:
```typescript
// bootstrap/state.ts
State = {
  // 成本追踪
  totalCostUSD: number
  totalAPIDuration: number
  modelUsage: { [modelName: string]: ModelUsage }
  
  // 性能指标
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  
  // 会话标识
  sessionId: SessionId
  parentSessionId?: SessionId  // 计划模式 → 实现的 lineage
  
  // 功能开关
  kairosActive: boolean        // Assistant 模式
  strictToolResultPairing: boolean
  
  // 遥测
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  
  // 代理协作
  agentColorMap: Map<string, AgentColorName>
  invokedSkills: Map<string, SkillInvocation>
}

// state/AppState.tsx
AppState = {
  messages: Message[]           // 对话历史
  userInput: string             // 输入框内容
  toolPermissionContext: ToolPermissionContext
  companionReaction?: string    // 宠物对话
  companionPetAt?: number       // 上次抚摸时间
  footerSelection?: 'companion' | 'input' | null
  // ... UI 状态
}
```

### 6.2 权限系统

**文件**: `src/types/permissions.ts`

```typescript
type PermissionMode = 'default' | 'auto' | 'bypass'

type ToolPermissionContext = {
  mode: PermissionMode
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  prePlanMode?: PermissionMode  // 进入计划模式前保存
}
```

**权限检查流程**:
1. 模式检查 (`auto` 模式自动批准读操作)
2. 规则匹配 (allow/deny/ask 列表，支持 glob)
3. 分类器检查 (AI 判断风险等级)
4. 用户确认对话框 (必要时)

### 6.3 MCP (Model Context Protocol)

**架构**:
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Claude    │ ←→  │  MCP Client │ ←→  │ MCP Servers │
│   Code CLI  │     │  (services/)│     │ (stdio/sse) │
└─────────────┘     └─────────────┘     └─────────────┘
                           ↓
                    ┌─────────────┐
                    │  Official   │
                    │  Registry   │
                    └─────────────┘
```

**工具命名**: `mcp__<server>__<tool>`

示例: `mcp__slack__read_channel`, `mcp__github__create_pr`

### 6.4 任务系统

**文件**: `src/Task.ts`

**任务类型**:
| 类型 | 前缀 | 说明 |
|-----|------|------|
| `local_bash` | `b` | 本地 shell 命令 |
| `local_agent` | `a` | 子代理 |
| `remote_agent` | `r` | 远程执行 |
| `in_process_teammate` | `t` | Swarm 协作代理 |
| `local_workflow` | `w` | 工作流脚本 |

**任务生命周期**:
```
pending → running → completed | failed | killed
```

### 6.5 工具系统

**文件**: `src/Tool.ts`

**工具接口**:
```typescript
type Tool = {
  name: string
  description(): string
  inputSchema: ToolInputJSONSchema
  
  // 权限
  checkPermissions(input, context): Promise<PermissionResult>
  isReadOnly(): boolean
  isDestructive(): boolean
  isConcurrencySafe(): boolean
  
  // 执行
  call(input, context): Promise<ToolResult>
  
  // 渲染
  renderToolUse?(input): ReactNode
  renderToolResult?(result): ReactNode
}
```

---

## 七、启动流程时序

```
cli.tsx (入口)
  ├─ 快速路径检查
  │   ├─ --version (零依赖)
  │   ├─ --dump-system-prompt
  │   ├─ --daemon-worker
  │   ├─ remote-control / bridge
  │   ├─ daemon
  │   ├─ ps/logs/attach/kill (后台会话)
  │   └─ --tmux --worktree
  ├─ startCapturingEarlyInput()  // 捕获启动前输入
  └─ main.tsx (加载)
       ├─ initAnalytics()        // 初始化分析
       ├─ initAuth()             // 认证状态
       ├─ loadConfig()           // 配置加载
       ├─ initGrowthBook()       // 功能开关
       ├─ setupTelemetry()       // 遥测系统
       ├─ initUser()             // 用户数据
       ├─ loadMCPClients()       // MCP 连接
       └─ REPL.tsx (主界面)
            ├─ 初始化 AppState
            ├─ 加载历史会话
            ├─ 启动通知系统
            ├─ 初始化键盘绑定
            └─ 渲染输入界面
```

---

## 八、安全与隐私设计

### 8.1 数据分类

| 级别 | 数据类型 | 处理方式 |
|-----|---------|---------|
| 公开 | 版本号、平台类型 | 直接记录 |
| 低风险 | 包管理器列表、终端类型 | 直接记录 |
| 中风险 | MCP 服务器名、仓库哈希 | 条件记录 |
| 高风险 | 代码片段、文件路径、邮箱 | 脱敏/标记 |

### 8.2 保护措施

1. **编译时**: TypeScript 类型强制标记 PII
2. **运行时**: 脱敏函数处理敏感数据
3. **传输时**: `_PROTO_*` 字段隔离
4. **存储时**: BigQuery 列级权限控制

### 8.3 沙盒机制

- 文件系统权限规则 (只读/读写限制)
- Bash 命令分类器 (风险等级评估)
- 网络请求白名单
- 敏感文件模式匹配

---

## 九、特色架构设计

### 9.1 Bun 特性深度使用

**编译时功能消除**:
```typescript
import { feature } from 'bun:bundle'

if (feature('BUDDY')) {
  // 此代码块在不包含 BUDDY 特性的构建中被完全移除
  const { CompanionSprite } = await import('./buddy/CompanionSprite.js')
}
```

**90+ 功能开关**:
- `BRIDGE_MODE`: IDE 桥接
- `COORDINATOR_MODE`: 多代理协调
- `MCP_SKILLS`: MCP 技能支持
- `KAIROS`: Assistant 模式
- `ULTRAPLAN`: CCR 计划模式

### 9.2 自定义 Ink 渲染引擎

**文件**: `src/ink/`

- 完整的终端 UI 框架 (~96 文件)
- 支持鼠标事件、聚焦管理、滚动
- 自定义 Vim 模式实现
- 性能优化 (squash-text-nodes, layout engine)

### 9.3 多模态输入处理

**图片处理**:
```typescript
// 自动压缩/降采样
const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
// 存储到磁盘供 CLI 工具引用
const storedPath = await storeImage(pastedImage)
```

---

## 十、关键文件索引

| 功能 | 文件路径 |
|-----|---------|
| 入口 | `src/entrypoints/cli.tsx` |
| 主循环 | `src/main.tsx` |
| REPL UI | `src/screens/REPL.tsx` |
| 状态管理 | `src/state/AppState.tsx`, `src/bootstrap/state.ts` |
| 命令系统 | `src/commands.ts` |
| 输入处理 | `src/utils/processUserInput/processUserInput.ts` |
| 宠物系统 | `src/buddy/companion.ts`, `src/buddy/CompanionSprite.tsx` |
| 分析系统 | `src/services/analytics/index.ts`, `src/services/analytics/metadata.ts` |
| 用户数据 | `src/utils/user.ts`, `src/utils/auth.ts`, `src/utils/config.ts` |
| 工具基类 | `src/Tool.ts` |
| 权限系统 | `src/types/permissions.ts` |
| MCP | `src/services/mcp/` |
| 构建配置 | `build.ts` |

---

## 附录：技术栈

| 类别 | 技术 |
|-----|------|
| 运行时 | Bun (bundling + execution) |
| UI 框架 | React + Ink (终端渲染) |
| 类型系统 | TypeScript 5.x + Zod |
| API 客户端 | @anthropic-ai/sdk |
| MCP SDK | @modelcontextprotocol/sdk |
| 存储 | 本地 JSON + 可选 S3 |
| 分析 | Datadog + BigQuery (1P) |
| 功能开关 | GrowthBook |

---

*分析日期: 2026-04-03*  
*版本: Claude Code CLI v2.1.88*
