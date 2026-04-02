# Claude Code Plugins / Skills 架构深度解析

## 1. 定位

Claude Code 的 command surface 并不只是 `/commands` 目录。

源码里，模型与用户可调用的“技能/命令”来源至少包括：

1. built-in slash commands
2. bundled skills
3. built-in plugin skills
4. user/project/managed skill directories
5. plugin commands
6. plugin skills
7. dynamic / conditional skills
8. workflow commands

最终它们都被统一成：
- `Command`

再汇入统一命令系统。

---

## 2. 总体架构

```text
many skill/command sources
  → discover
  → parse/normalize
  → convert to Command
  → merge by precedence
  → filter by availability/isEnabled
  → surface to slash-command registry / model tool surface
```

这说明 plugins + skills 在架构上已经融合成一个统一 command platform。

---

## 3. bundled skills

相关文件：
- `src/skills/bundledSkills.ts`

### 3.1 特征

bundled skill 会在启动时程序化注册到内存 registry：
- `registerBundledSkill()`
- `getBundledSkills()`

### 3.2 输出形态

最终会变成：
- `source: 'bundled'`
- `loadedFrom: 'bundled'`

### 3.3 特别点

如果 skill 自带 reference files：
- 首次调用时才 lazy extract
- prompt 前还会加 base-directory hint

说明 bundled skill 不只是一个 prompt string，也可能带附属资源打包语义。

---

## 4. built-in plugin skills

相关文件：
- `src/plugins/builtinPlugins.ts`

### 4.1 与 bundled skill 的区别

built-in plugin skill：
- 本质上属于 plugin 体系
- 但启用/禁用由用户 settings 控制
- 通过 `getBuiltinPluginSkillCommands()` 转成 command

### 4.2 输出形态

虽然源头上是 plugin，它最终 surface 仍可能表现为：
- `source: 'bundled'`
- `loadedFrom: 'bundled'`

### 4.3 架构意义

这说明“bundled / plugin”在内部实现与最终 command surface 之间并不是一一映射关系。

系统更看重：
- 交付来源
- 启用策略
- command 统一表面

---

## 5. filesystem skill dirs

相关文件：
- `src/skills/loadSkillsDir.ts`
- `src/utils/markdownConfigLoader.ts`

### 5.1 扫描来源

会扫描：
- managed `.claude/skills`
- user `~/.claude/skills`
- 从 cwd 到 git root 之间所有 project `.claude/skills`
- `--add-dir` 提供的 project-like 根

### 5.2 支持格式

主要支持：
- `skill-name/SKILL.md`

同时也兼容 legacy：
- `/commands` 风格
- plain `.md` 文件

### 5.3 去重方式

- 按 realpath dedupe
- first-win by load order

### 5.4 架构意义

这说明 skills 不是单一目录，而是一个**层次化文件系统技能空间**。

---

## 6. conditional / dynamic skills

这是 skill 体系里非常有意思的一层。

### 6.1 conditional skills

带 frontmatter `paths` 的 skill 初始不会直接激活。

只有在匹配文件路径后，才进入有效集合。

### 6.2 dynamic skills

相关函数：
- `discoverSkillDirsForPaths()`
- `addSkillDirectories()`
- `activateConditionalSkillsForPaths()`

机制：
- 沿 touched file path 向上走
- 寻找嵌套 `.claude/skills`
- 动态合并到 session 的 dynamic skill 集
- 更深目录覆盖更浅目录

### 6.3 架构意义

这意味着 skill system 不是静态加载，而是会随着：
- 文件操作
- 工作路径
- 命中文件模式

动态扩展。

也就是一种 **context-sensitive command surface**。

---

## 7. plugin discovery / loading

相关文件：
- `src/utils/plugins/pluginLoader.ts`
- `src/services/plugins/PluginInstallationManager.ts`
- `src/utils/plugins/refresh.ts`

### 7.1 来源

plugin 来源包括：
- marketplace-installed plugins
- settings 中启用的插件
- session-only inline plugins (`--plugin-dir` / SDK)

### 7.2 lifecycle

- 安装/后台 reconcile：`PluginInstallationManager`
- runtime refresh：`refreshActivePlugins()`

说明 plugin 体系并不是只在启动时扫一遍，而是支持 refresh / 安装管理生命周期。

---

## 8. plugin commands 与 plugin skills

相关文件：
- `src/utils/plugins/loadPluginCommands.ts`

### 8.1 两条独立 surface

它会分别加载：
- `getPluginCommands()`
- `getPluginSkills()`

### 8.2 来源位置

从 enabled plugin 中读取：
- `commands/`
- `skills/`
- manifest 声明的额外路径
- inline metadata content

### 8.3 命名方式

plugin 侧通常会做 namespacing：
- `pluginName:...`

### 8.4 架构意义

这说明 plugin 不是简单“加一些 slash command”，而是可以提供两种不同语义面：
- 普通 command
- 真正 skill-like prompt surface

---

## 9. 如何合并进 command system

相关文件：
- `src/commands.ts`

### 9.1 merge 顺序

`loadAllCommands(cwd)` 大致按以下顺序合并：

1. bundled skills
2. built-in plugin skills
3. skill-directory commands
4. workflow commands
5. plugin commands
6. plugin skills
7. built-in slash commands

之后 `getCommands(cwd)`：
- 按 availability 过滤
- 按 `isCommandEnabled` 过滤
- 再把 dynamic skills 插进去
- 按命令名去重

### 9.2 架构意义

命令系统已经不再是“固定命令表”，而是一套：
- multi-source merge
- precedence control
- dynamic augmentation
- enablement gating

统一面。

---

## 10. 模型视角与用户视角还会再过滤一次

相关逻辑：
- `getSkillToolCommands()`
- `getSlashCommandToolSkills()`

这说明：
- 并不是所有 command 都会同样暴露给模型
- “给用户看的 slash command surface”
- “给模型看的可调用 skill surface”

是两个相关但不完全相同的集合。

这是一个非常关键的设计点。

---

## 11. 架构判断

Plugins + Skills 子系统，本质上是一套：
- 多来源命令发现器
- filesystem + marketplace 混合装载器
- 条件激活 / 动态注入系统
- 统一 command surface 适配层

所以它不只是“插件机制”，而是 Claude Code 的 **扩展命令平台**。

---

## 12. 关键文件索引

- `src/commands.ts`
- `src/skills/loadSkillsDir.ts`
- `src/skills/bundledSkills.ts`
- `src/plugins/builtinPlugins.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/refresh.ts`
- `src/utils/markdownConfigLoader.ts`

---

## 13. 一句话结论

Claude Code 的 plugins/skills 架构不是附加命令功能，而是一套支持静态、动态、条件激活与多来源合并的 **统一扩展命令平台**。