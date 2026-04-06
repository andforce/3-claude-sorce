# Claude Code 源码还原与构建

## 从源码重新构建
```bash
# 1. 安装 Bun（构建工具）
curl -LO https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip
unzip bun-darwin-aarch64.zip -d /tmp/bun && sudo cp /tmp/bun/bun-darwin-aarch64/bun /usr/local/bin/bun

# 2. 安装/更新依赖（可选，node_modules 已包含在仓库中）
pnpm install --registry https://registry.npmjs.org

# 3. 构建
bun run build.ts

# 4. 运行
bun dist/cli.js --version
```

从 `@anthropic-ai/claude-code` v2.1.88 npm 包中的 `cli.js.map` source map 文件还原出的完整源代码，并配置为可编译运行。

## 效果验证

```
$ bun dist/cli.js --version
2.1.88 (Claude Code)

$ bun dist/cli.js --help
Usage: claude [options] [command] [prompt]
Claude Code - starts an interactive session by default...
```

## 源码还原方法

```bash
# 1. 下载 npm 包
npm pack @anthropic-ai/claude-code --registry https://registry.npmjs.org

# 2. 解压
tar xzf anthropic-ai-claude-code-2.1.88.tgz

# 3. 解析 cli.js.map，将 sourcesContent 按原始路径写出
node -e "
const fs = require('fs'), path = require('path');
const map = JSON.parse(fs.readFileSync('package/cli.js.map', 'utf8'));
const outDir = './claude-code-source';
for (let i = 0; i < map.sources.length; i++) {
  const content = map.sourcesContent[i];
  if (!content) continue;
  let relPath = map.sources[i];
  while (relPath.startsWith('../')) relPath = relPath.slice(3);
  const outPath = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
}
"
```

source map 包含 **4756** 个源文件及完整 `sourcesContent`，可无损还原所有 TypeScript/TSX 原始代码。

## 构建环境搭建

### 依赖

| 工具 | 用途 |
|------|------|
| [Bun](https://bun.sh) v1.3.11 | 构建工具（源码使用 `bun:bundle` 特性） |
| [pnpm](https://pnpm.io) v10+ | 包管理 |
| Node.js v18+ | 运行时 |

### 安装步骤

```bash
# 1. 安装 Bun（macOS arm64）
curl -LO https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip
unzip bun-darwin-aarch64.zip

# 2. 安装依赖（pnpm + npm registry）
pnpm install --registry https://registry.npmjs.org

# 3. 构建
bun run build.ts

# 4. 运行
bun dist/cli.js --version
```

## 构建说明

### 为什么需要 Bun？

源码中大量使用了 `bun:bundle` 的 `feature()` API：

```typescript
import { feature } from 'bun:bundle'

// 编译期特性开关，Bun 构建时进行死代码消除
const coordinatorModule = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js')
  : null
```

这是 Bun bundler 的专有特性，等价于 webpack 的 `DefinePlugin`，在构建时静态替换为 `true`/`false` 并消除死分支。

### 特性开关配置

`build.ts` 中定义了 90+ 个特性开关，均已按**生产外部版本**的默认值设置：

```typescript
const featureFlags = {
  BRIDGE_MODE: false,        // IDE 桥接（生产关闭）
  COORDINATOR_MODE: false,   // 多代理协调（内部功能）
  KAIROS: false,             // 助手模式（内部功能）
  BUILTIN_EXPLORE_PLAN_AGENTS: true,  // 内置探索/计划代理（启用）
  TOKEN_BUDGET: true,        // Token 预算显示（启用）
  // ...等 80+ 个开关
}
```

### MACRO 常量注入

源码使用 `MACRO.VERSION` 等编译期常量（类似 C 语言的宏）：

```typescript
console.log(`${MACRO.VERSION} (Claude Code)`)  // → "2.1.88 (Claude Code)"
```

在 `build.ts` 中通过 `define` 注入：

```typescript
define: {
  'MACRO.VERSION': JSON.stringify('2.1.88'),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify('...'),
  // ...
}
```

### 私有包处理

以下内部包不在公开 npm 中，已创建功能存根：

| 包名 | 说明 |
|------|------|
| `color-diff-napi` | 语法高亮 native 模块（存根：禁用高亮） |
| `modifiers-napi` | macOS 按键修饰符 native 模块（存根：返回空） |
| `@ant/claude-for-chrome-mcp` | Chrome 扩展 MCP 服务器（存根） |
| `@anthropic-ai/mcpb` | MCP bundle 处理器（存根） |
| `@anthropic-ai/sandbox-runtime` | 沙盒运行时（存根） |

### commander 兼容性补丁

源码使用 `-d2e` 作为调试标志的短选项（多字符短选项），但 commander v14 只允许单字符短选项。
已对 `node_modules/commander/lib/option.js` 做最小化补丁，将正则从 `/^-[^-]$/` 改为 `/^-[^-]+$/`。

## 目录结构

```
.
├── src/                  # 核心源码（1902 个文件）
│   ├── entrypoints/
│   │   └── cli.tsx       # ← 构建入口点
│   ├── main.tsx          # 主 REPL 逻辑（由 cli.tsx 动态 import）
│   ├── Tool.ts           # 工具类型系统
│   ├── Task.ts           # 任务管理
│   ├── QueryEngine.ts    # 查询引擎
│   ├── assistant/        # 会话历史管理
│   ├── bridge/           # IDE 桥接层（31）
│   ├── buddy/            # 子代理系统（6）
│   ├── cli/              # CLI 参数解析（19）
│   ├── commands/         # 斜杠命令（207）
│   ├── components/       # 终端 UI 组件（389）
│   ├── constants/        # 全局常量（21）
│   ├── context/          # 上下文管理（9）
│   ├── entrypoints/      # 各类入口点（8）
│   ├── hooks/            # 生命周期钩子（104）
│   ├── ink/              # 自研终端渲染引擎（96）
│   ├── keybindings/      # 键盘快捷键（14）
│   ├── memdir/           # 记忆目录（8）
│   ├── migrations/       # 数据迁移（11）
│   ├── plugins/          # 插件系统（2）
│   ├── remote/           # 远程执行（4）
│   ├── services/         # 核心服务（130）
│   ├── skills/           # 技能系统（20）
│   ├── state/            # 状态管理（6）
│   ├── tasks/            # 任务执行（12）
│   ├── tools/            # 工具实现（184）
│   ├── types/            # 类型定义（11）
│   ├── utils/            # 工具函数（564）
│   ├── vim/              # Vim 模式（5）
│   └── voice/            # 语音输入（1）
├── vendor/               # 内部 vendor 代码（4 文件）
├── node_modules/         # 依赖（pnpm 安装 + 私有包存根）
├── dist/                 # 构建产出
│   └── cli.js            # 可执行文件（22MB）
├── build.ts              # Bun 构建脚本（含特性开关配置）
├── tsconfig.json         # TypeScript 配置
└── package.json          # 项目配置
```

## 统计

| 指标 | 数值 |
|------|------|
| 源文件总数 | 4,756 |
| 核心源码（src/ + vendor/） | 1,906 文件 |
| 第三方依赖（node_modules/） | 2,850 + npm 安装 |
| Source Map 大小 | 57 MB |
| 构建产出大小 | 22 MB |
| 包版本 | 2.1.88 |
| 特性开关数量 | 90 个 |
