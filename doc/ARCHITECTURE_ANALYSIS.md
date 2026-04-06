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

### 3.3.1 命令注册的真实特征

原文档这里还可以更精确一点。`src/commands.ts` 里的命令注册不是静态常量数组那么简单，而是：

1. **大量 feature-gated require**
   - 例如 `bridge`, `voice`, `ultraplan`, `fork`, `assistant`, `remote-setup`
   - 借助 `bun:bundle` 的 `feature()` 做编译期死代码消除

2. **内外部命令分层**
   - `INTERNAL_ONLY_COMMANDS` 明确列出只在内部构建保留的命令
   - 外部 build 会在 bundle 阶段直接裁掉

3. **命令集合延迟求值**
   - `COMMANDS = memoize(() => [...])`
   - 这样可以避免模块初始化阶段过早读取 config / auth / settings

4. **命令加载不是只有 commands 目录**
   - builtin commands
   - bundled skills
   - builtin plugin skills
   - skill dir commands
   - workflow commands
   - plugin commands
   - plugin skills
   - dynamic skills

### 3.3.2 Slash 命令与普通 prompt 的分流细节

这一点在 `src/utils/processUserInput/processUserInput.ts` 里很关键：

- Slash 命令不是最先无脑执行的。
- 在真正进入 slash path 之前，系统还会先做：
  1. 图片 resize / pasted image metadata 收集
  2. bridge safe command 判断
  3. ultraplan keyword 重写
  4. attachment 提取策略判断

尤其是 bridge / remote-control 场景：
- `skipSlashCommands` 默认可阻止远端输入直接触发本地 slash 命令
- 但 `bridgeOrigin=true` 时，如果命令满足 `isBridgeSafeCommand()`，又会重新放开
- 如果命令存在但不安全，会直接返回：`/<cmd> isn't available over Remote Control.`

这说明命令系统本质上是 **命令发现 + 安全门控 + 环境裁剪** 三段式，不只是一个 parser。

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

> **已拆分为独立文档**: `DATA_COLLECTION_TRACKING_ANALYSIS.md`
>
> 涵盖：遥测架构（Datadog + 1P + OTel + BigQuery）、GrowthBook 远程配置、PII 分级与脱敏、
> 隐私三级控制、组织级 metrics opt-out、sink 熔断、400+ 个 `tengu_*` 行为事件、
> 插件/文件操作遥测、外部端点汇总等。

**认证路径补充**（保留在此处因为与整体架构强相关）：

源码里认证系统是多来源优先级决策系统，至少有以下路径：

1. **Claude.ai OAuth**
   - `CLAUDE_CODE_OAUTH_TOKEN`
   - file descriptor 注入的 OAuth token
   - 本地持久化的 claude.ai token

2. **Anthropic API Key**
   - `ANTHROPIC_API_KEY`
   - `apiKeyHelper`
   - `/login managed key`

3. **第三方提供商认证**
   - Bedrock / Vertex / Foundry
   - 这些路径会显式改变 `isAnthropicAuthEnabled()` 的判断

4. **Managed OAuth** — `CLAUDE_CODE_REMOTE=true` / `claude-desktop` entrypoint

远程模式、桌面模式、bare 模式、SSH socket 模式都会改变认证源选择。

---

## 六、关键子系统详解

### 6.1 状态管理

**真实实现是“双轨状态”而不是简单的 React useState**：

| 层级 | 文件 | 用途 | 实现方式 |
|-----|------|------|------|
| Bootstrap 全局状态 | `src/bootstrap/state.ts` | 进程/会话级、跨 UI 的全局状态 | 自定义 signal + 模块级状态 |
| App UI 状态 | `src/state/AppState.tsx` + `src/state/AppStateStore.ts` | REPL / 组件渲染状态 | 外部 store + `useSyncExternalStore` |

**这里有几个之前文档里没强调的关键点：**

1. `AppState` **不是**普通 React Context + `useReducer`。
   - 它实际通过 `createStore()` 创建外部 store。
   - 组件通过 `useAppState(selector)` 订阅状态切片。
   - 底层使用 `useSyncExternalStore`，避免全量重渲染。

2. `AppStateProvider` 里还包了一层：
   - `MailboxProvider`
   - `VoiceProvider`（feature-gated）

3. 设置变更不是组件内部局部处理，而是通过 `useSettingsChange()` → `applySettingsChange()` 同步灌回 store。

4. `bootstrap/state.ts` 里维护了大量**进程级遥测、会话 lineage、插件、计划模式、teleport、channel allowlist、session persistence** 等跨模块状态，职责比文档里原先写的更重。

**关键状态（bootstrap/state.ts）**:
```typescript
State = {
  // 路径与会话身份
  originalCwd: string
  projectRoot: string
  cwd: string
  sessionId: SessionId
  parentSessionId?: SessionId
  sessionProjectDir: string | null

  // 成本与模型统计
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride?: ModelSetting
  initialMainLoopModel: ModelSetting

  // Turn 级性能指标
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number

  // 遥测 / OTel
  meter: Meter | null
  loggerProvider: LoggerProvider | null
  meterProvider: MeterProvider | null
  tracerProvider: BasicTracerProvider | null
  eventLogger: Logger | null

  // API / 调试回放
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  lastClassifierRequests: unknown[] | null
  cachedClaudeMdContent: string | null
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>

  // 代理 / 协作
  agentColorMap: Map<string, AgentColorName>
  invokedSkills: Map<string, SkillInvocation>
  mainThreadAgentType?: string

  // 会话行为 / 模式
  kairosActive: boolean
  strictToolResultPairing: boolean
  sessionBypassPermissionsMode: boolean
  scheduledTasksEnabled: boolean
  sessionCronTasks: SessionCronTask[]
  sessionCreatedTeams: Set<string>
  sessionTrustAccepted: boolean
  sessionPersistenceDisabled: boolean
  hasExitedPlanMode: boolean

  // 渠道 / 远程 / direct connect
  isRemoteMode: boolean
  directConnectServerUrl?: string
  allowedChannels: ChannelEntry[]
  hasDevChannels: boolean
}
```

**关键状态（AppState）**:
```typescript
AppState = {
  messages: Message[]
  userInput: string
  toolPermissionContext: ToolPermissionContext
  companionReaction?: string
  companionPetAt?: number
  footerSelection?: 'companion' | 'input' | null
  // 以及 prompt suggestion、selection、fullscreen、permission dialog 等大量 UI 状态
}
```

### 6.1.1 配置与持久化系统

这一块原文档明显写少了。`src/utils/config.ts` 实际上是整个 CLI 的**持久化中枢**之一。

它至少维护两层配置：

| 层级 | 类型 | 作用 |
|-----|------|------|
| GlobalConfig | `~/.claude/...` | 用户级偏好、认证、实验缓存、IDE/通知、宠物 soul |
| ProjectConfig | 项目级 | 当前仓库允许工具、MCP server、worktree session、trust dialog 等 |

**ProjectConfig 负责**：
- `allowedTools`
- `mcpContextUris`
- `mcpServers`
- `hasTrustDialogAccepted`
- `activeWorktreeSession`
- `remoteControlSpawnMode`
- 最近一次会话性能/成本统计

**GlobalConfig 负责**：
- `userID`
- `theme`
- `oauthAccount`
- `primaryApiKey`
- `env`
- `companion` / `companionMuted`
- IDE 自动连接 / 自动安装扩展
- Push 通知开关
- 各类 migration / onboarding / hint / upsell 计数器
- GrowthBook / Statsig / Dynamic config 缓存
- `githubRepoPaths`
- `deepLinkTerminal`
- `skillUsage`

**一个很关键的真实设计点**：
- 宠物的 `bones` 不持久化，只持久化 `StoredCompanion = {name, personality, hatchedAt}`。
- 所以用户不能靠改 config 伪造 legendary；读取时会重新根据 `userId` roll。

### 6.1.2 会话持久化与项目身份

源码里对“项目身份”做了比普通 CLI 更严格的区分：
- `originalCwd`: 进程启动时目录
- `cwd`: 当前执行目录
- `projectRoot`: 稳定项目根，只在启动时确定

这意味着：
- 中途切换 worktree / cwd 不会改变会话所属项目身份
- history / skills / session registry / Claude.md 加载更依赖 `projectRoot`
- 文件操作则可能依赖当前 `cwd`

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

> 数据分类、PII 保护、隐私控制等详细内容已合并至 `DATA_COLLECTION_TRACKING_ANALYSIS.md` 第五～七章。

### 8.1 沙盒机制

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

## 十、补充结论：当前文档里原先遗漏/需要修正的点

### 10.1 原文档遗漏的重要机制

1. **AppState 不是普通 React state**
   - 实际是外部 store + selector + `useSyncExternalStore`
   - 这会影响你对渲染性能、订阅粒度、状态变更传播方式的判断

2. **配置系统远比“本地 JSON”复杂**
   - 有 `GlobalConfig` / `ProjectConfig` 双层
   - 配置项里包含认证、MCP、IDE、宠物、提示策略、实验缓存、repo path mapping、deep link terminal、notification 开关、worktree session 等

3. **认证系统是多源裁决，不是单一路径**
   - OAuth / API Key / file descriptor / managed context / third-party provider 并存
   - bare/remote/desktop/ssh 等运行环境会切换认证优先级

4. **命令系统本质是“动态装载系统”**
   - 不只是 `/commands` 目录
   - 还包括 skills、plugins、builtin plugin skills、workflow、dynamic skills

5. **Bridge / Remote Control 对 slash command 有二次裁剪**
   - 是否允许远端输入触发本地 slash command 不是固定的
   - 有 `skipSlashCommands` + `bridgeOrigin` + `isBridgeSafeCommand()` 三重控制

6. **Bootstrap state 的职责非常重**
   - 它不只是“全局状态”，还是：
     - 遥测总线的上下文
     - 会话 lineage 容器
     - last API request 回放缓存
     - plan/auto mode 生命周期开关
     - remote / channel / teleport / team session 状态容器

### 10.2 原文档措辞需要更精确的地方

- “React + Ink” 没错，但要补一句：这是 **自定义 Ink 分支/扩展体系**，不是只用官方 Ink 组件。
- “状态管理 = AppState.ts + bootstrap/state.ts” 没错，但更准确应写成：
  - `bootstrap/state.ts` = 进程级事实源
  - `AppStateStore` = UI 订阅层
- “命令系统” 不应只理解为 slash commands；在源码里它已经和 skills / plugins / workflow 融合成统一 command surface。
- “数据收集” 那部分应明确：
  - 大量字段经过脱敏和分级控制
  - 但系统确实具备设备、组织、仓库、环境、行为链路级别的稳定识别能力

---

## 十一、关键文件索引

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

## 十二、扩展分析文档索引

我已经把几个最关键、最值得单独阅读的子系统拆成独立文档：

| 模块 | 文档 |
|---|---|
| 主循环 / tool loop / compact / retry | `QUERY_RUNTIME_ANALYSIS.md` |
| REPL 交互编排 / fullscreen / permission / notifications | `REPL_ORCHESTRATION_ANALYSIS.md` |
| MCP 配置 / approval / lifecycle / tools/resources 注入 | `MCP_ARCHITECTURE_ANALYSIS.md` |
| Agent / Subagent / teammate / remote agent / worktree | `AGENT_RUNTIME_ANALYSIS.md` |
| Messages / transcript / normalization / pairing | `MESSAGES_TRANSCRIPT_ANALYSIS.md` |
| Permissions / allow-ask-deny / denial tracking | `PERMISSIONS_ARCHITECTURE_ANALYSIS.md` |
| Settings / remote policy / managed config | `SETTINGS_AND_REMOTE_POLICY_ANALYSIS.md` |
| **数据收集 / 追踪 / 隐私 / 端点 / 事件体系** | **`DATA_COLLECTION_TRACKING_ANALYSIS.md`** |
| Telemetry / analytics / sinks / 1P logging | `TELEMETRY_ANALYTICS_ANALYSIS.md` |
| Bridge / remote control / REPL bridge / transport | `BRIDGE_REMOTE_CONTROL_ANALYSIS.md` |
| Plugins / skills / bundled/plugin/dynamic surface | `PLUGINS_AND_SKILLS_ANALYSIS.md` |
| API / provider / stream / retry / error mapping | `API_PROVIDER_ARCHITECTURE_ANALYSIS.md` |
| Hooks / lifecycle / runtime interception | `HOOKS_LIFECYCLE_ANALYSIS.md` |
| Memory / memdir / extraction / team memory | `MEMORY_ARCHITECTURE_ANALYSIS.md` |
| Policy limits / org capability gating | `POLICY_LIMITS_ANALYSIS.md` |

### 12.1 建议阅读顺序

如果你要建立完整心智模型，建议按下面顺序读：

1. `ARCHITECTURE_ANALYSIS.md`
   - 看整体版图
2. `QUERY_RUNTIME_ANALYSIS.md`
   - 看真正的 runtime heart
3. `MESSAGES_TRANSCRIPT_ANALYSIS.md`
   - 看 transcript correctness engine
4. `REPL_ORCHESTRATION_ANALYSIS.md`
   - 看终端交互层如何承载 runtime
5. `API_PROVIDER_ARCHITECTURE_ANALYSIS.md`
   - 看模型调用与 provider 抽象
6. `PERMISSIONS_ARCHITECTURE_ANALYSIS.md`
   - 看安全决策层
7. `SETTINGS_AND_REMOTE_POLICY_ANALYSIS.md`
   - 看配置与远程策略平面
8. `MCP_ARCHITECTURE_ANALYSIS.md`
   - 看扩展平台与外部能力注入
9. `AGENT_RUNTIME_ANALYSIS.md`
   - 看多代理 / 子代理执行系统
10. `HOOKS_LIFECYCLE_ANALYSIS.md`
   - 看运行时拦截与扩展点
11. `MEMORY_ARCHITECTURE_ANALYSIS.md`
   - 看长期上下文系统
12. `DATA_COLLECTION_TRACKING_ANALYSIS.md`
   - 看数据收集、追踪、隐私控制全貌
13. `TELEMETRY_ANALYTICS_ANALYSIS.md`
   - 看遥测管道内部实现细节
14. `BRIDGE_REMOTE_CONTROL_ANALYSIS.md`
   - 看远程控制与桥接
15. `PLUGINS_AND_SKILLS_ANALYSIS.md`
   - 看技能与插件扩展平台
16. `POLICY_LIMITS_ANALYSIS.md`
   - 看组织级能力 gating

### 12.2 继续深挖时仍值得追加的模块

在已经拆出的 10 份文档基础上，后面如果继续推进到“系统级审计文档”，最值得继续下钻的是：

1. **`src/services/api/`**
   - Anthropic API 调用、stream protocol、错误恢复、provider 差异

2. **`src/utils/model/` + provider 体系**
   - 模型选择、provider 路由、3P provider 适配

3. **`src/hooks/` 生命周期体系**
   - prompt submit hook、tool hook、stop hook 的全链路

4. **`src/memdir/` / memory / team memory / extractMemories**
   - 长期记忆、项目记忆、团队记忆同步

5. **`src/services/policyLimits/`**
   - org policy 与功能禁用/限制的运行时作用面

6. **`src/ink/` 自定义终端渲染引擎**
   - 如果要分析终端 UI 性能与渲染机制，这块值得单独成册

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
