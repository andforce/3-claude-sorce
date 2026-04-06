# Claude Code Memory 架构深度解析

## 1. 定位

Claude Code 的 memory 不是一张单文件笔记，而是一套文件系统驱动的长期上下文体系。

从源码看，它包含至少四层：

1. memdir prompt entrypoint
2. topic-file memory storage
3. runtime relevant-memory retrieval
4. background memory extraction / team memory / agent memory

核心目录：
- `src/memdir/`
- `src/services/extractMemories/`

---

## 2. memdir 模型

核心文件：
- `src/memdir/memdir.ts`

### 2.1 核心约定

入口永远是：
- `MEMORY.md`

它是 always-loaded entrypoint/index。

### 2.2 角色分工

- `MEMORY.md`：索引与操作说明
- 主题文件：具体 durable memory 内容

### 2.3 系统作用

`loadMemoryPrompt()` 会生成 memory 相关 system prompt 指令，并被：
- `src/constants/prompts.ts`
- `src/QueryEngine.ts`

用于拼接主系统 prompt。

### 2.4 架构意义

memory 系统首先是 prompt architecture 的一部分，而不是数据库子系统。

---

## 3. auto memory 路径

相关文件：
- `src/memdir/paths.ts`

### 3.1 路径规则

`getAutoMemPath()` 大致会解析到：
- `<memoryBase>/projects/<sanitized-git-root>/memory/`

支持 override。

### 3.2 auto memory 开关

- `isAutoMemoryEnabled()`

决定整套 auto memory 是否工作。

### 3.3 设计意义

memory 默认是**项目作用域**的，不是全球唯一共享一份。

---

## 4. assistant / KAIROS daily-log 模式

源码里还有另一层模式：
- 不直接写 `MEMORY.md`
- 先写按日期分的 log file
- 再由后续 consolidation 过程蒸馏回 topic files + `MEMORY.md`

### 4.1 架构意义

这说明 memory 不只有静态知识库模式，还有：
- append-only 日志
- 后处理汇总

两阶段写入模式。

---

## 5. memory 如何进入运行时

memory 注入不是单一路径，而是两层：

### 5.1 层一：`MEMORY.md` 永远进 system prompt

通过 `loadMemoryPrompt()` 实现。

### 5.2 层二：相关 topic file 在 runtime 动态 recall

相关文件：
- `src/memdir/findRelevantMemories.ts`
- `src/memdir/memoryScan.ts`
- `src/utils/attachments.ts`

流程：
1. 扫描 memory files
2. 从 frontmatter 构建 manifest
3. 用 side Sonnet query 选出最多 5 个相关 memory file
4. 作为 `relevant_memories` attachment 注入当前运行时

### 5.3 架构意义

这是一种：
- 常驻 index
- 按需正文召回

的 memory 架构，而不是每次把全部 memory 塞进 prompt。

---

## 6. memory retrieval：不是纯规则匹配，而是模型辅助选择

### 6.1 扫描层

`memoryScan.ts` 会读取：
- frontmatter
- `description`
- `type`
- `mtime`

先形成 memory manifest。

### 6.2 选择层

`findRelevantMemories.ts` 不仅仅依赖规则或 embedding，而是使用一个 side Sonnet query 选择相关文件。

### 6.3 架构意义

这说明 Claude Code 的 memory recall 偏向：
- LLM-assisted memory routing

而不是传统固定检索器。

---

## 7. background memory extraction

核心文件：
- `src/services/extractMemories/extractMemories.ts`
- `src/services/extractMemories/prompts.ts`

### 7.1 触发时机

由：
- `backgroundHousekeeping.ts`
- `query/stopHooks.ts`

在 turn 后触发。

### 7.2 它怎么工作

会 fork 一个受限 subagent：
- 读取 recent conversation
- 生成 durable memories
- 仅允许 memory dir 内写入
- 带 memory file manifest 以减少额外 listing
- 用 cursor 只处理新 transcript 片段

### 7.3 特别点

如果主 agent 本 turn 已经写过 memory file：
- extraction 会跳过

### 7.4 架构意义

memory extraction 是异步后台 housekeeping，不阻塞主对话主循环。

---

## 8. team memory

相关文件：
- `src/memdir/teamMemPaths.ts`
- `src/memdir/teamMemPrompts.ts`

### 8.1 存储位置

team memory 存在：
- `<autoMem>/team/`

### 8.2 prompt 暴露方式

prompt 会同时加载：
- private memory index
- team memory index

### 8.3 安全边界

team memory 路径会做严格校验，防止：
- path traversal
- encoded-path 绕过
- Unicode normalization 绕过
- symlink escape

### 8.4 架构意义

team memory 是一套在 auto memory 基础上叠加的共享记忆空间，不是单独另起体系。

---

## 9. agent memory

相关文件：
- `src/tools/AgentTool/agentMemory.ts`

### 9.1 作用域

每个 agent type 可拥有自己的 scoped persistent memory dir：
- `user`
- `project`
- `local`

### 9.2 设计意义

这说明 memory 作用域至少有三层：
- auto/project memory
- team memory
- per-agent memory

并且底层共享同一套 memdir 结构模式。

---

## 10. 架构判断

Claude Code 的 memory 架构可以抽象成：

```text
file-backed memory dir
  → MEMORY.md as persistent entry index
  → topic files as durable facts
  → relevant-memory runtime recall
  → background extraction from transcript
  → optional team / agent scoped overlays
```

这不是传统数据库式 memory，而是：
- prompt-native
- file-native
- LLM-routed
- background-maintained

长期记忆架构。

---

## 11. 关键文件索引

- `src/memdir/memdir.ts`
- `src/memdir/paths.ts`
- `src/memdir/findRelevantMemories.ts`
- `src/memdir/memoryScan.ts`
- `src/memdir/teamMemPaths.ts`
- `src/memdir/teamMemPrompts.ts`
- `src/services/extractMemories/extractMemories.ts`
- `src/services/extractMemories/prompts.ts`
- `src/tools/AgentTool/agentMemory.ts`
- `src/utils/attachments.ts`

---

## 12. 一句话结论

Claude Code 的 memory 架构是一套以文件系统为持久化介质、以 `MEMORY.md` 为索引入口、以 runtime recall 与后台提炼为核心机制的 **长期上下文操作系统**。