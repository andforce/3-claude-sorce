# Claude Code Messages / Transcript 架构深度解析

## 1. 定位

`src/utils/messages.ts` 在整个系统里的地位，比“消息工具函数集”重要得多。

从源码看，它实际上承担了三层职责：

1. transcript canonicalization
2. UI transcript shaping
3. API transcript correctness enforcement

也就是说，这不是普通 helper 文件，而是 Claude Code 的 **transcript engine**。

---

## 2. 两套排序：UI 视图与 API 视图分离

这是最值得先建立的心智模型。

### 2.1 UI 排序

相关函数：
- `normalizeMessages()`
- `reorderMessagesInUI()`
- `buildMessageLookups()`

目的：
- 让用户看到的 transcript 更符合“人类理解顺序”
- 把 tool_use / tool_result / hook attachment 聚成可读 cluster
- 为渲染层预先构建索引，避免每行重复扫描

### 2.2 API 排序

相关函数：
- `reorderAttachmentsForAPI()`
- `normalizeMessagesForAPI()`
- `ensureToolResultPairing()`

目的：
- 满足模型 API 的严格输入约束
- 避免 400 / orphan tool_result / 空 assistant / 非法附件组合

### 2.3 架构意义

系统明确接受这样一个事实：
- **用户看到的 transcript，不等于 API 真正收到的 transcript**

这不是 bug，而是设计。

---

## 3. canonicalization：消息先拆成 block 级规范形态

### 3.1 `normalizeMessages()`

这个函数会把 multi-block user/assistant message 拆成 one-block normalized messages。

作用：
- 让 UI/lookup 更容易按 block 推理
- 在 split 后用 `deriveUUID()` 保持稳定顺序和可追踪性
- 每张图片的 `imagePasteIds` 也按 block 级映射保留

### 3.2 为什么重要

因为 Claude Code 的 message 已经不是简单纯文本。

它可能包含：
- text
- image
- tool_use
- tool_result
- thinking
- attachments
- synthetic system reminders

如果不先 canonicalize 到 block 级，就很难稳定做：
- 渲染聚类
- tool result pairing
- compact slicing
- stream fragment 合并

---

## 4. UI transcript shaping

### 4.1 `reorderMessagesInUI()`

这个函数会把下列内容聚成单个“可理解事件簇”：
- `tool_use`
- pre-hook attachments
- 对应的 `tool_result`
- post-hook attachments

还会把连续 API error system message 压成最后一个。

### 4.2 `buildMessageLookups()`

这个 lookup 预计算层很关键。

它会构建：
- sibling tool uses
- progress 映射
- hook resolution count
- tool-result 映射
- resolved / errored tool-use 集合
- orphaned server/mcp tool use 标记

### 4.3 架构意义

UI 渲染层并不是每次 render 现算 transcript 关系，而是：
- transcript 先标准化
- 再构建 lookup
- render 时 O(1) 读关系

这属于典型的“渲染前预计算”架构优化。

---

## 5. attachment ordering：附件在 API 视图里会“上浮”

### 5.1 `reorderAttachmentsForAPI()`

这个函数会 bottom-up 扫描 attachment message，并把它们往上移动，直到碰到：
- assistant message
- user `tool_result`

### 5.2 为什么这样做

这样可以让 attachment 更稳定地附着到“最近相关的模型上下文单元”上，而不是仅仅保持 UI 中出现顺序。

### 5.3 `normalizeAttachmentForAPI()`

很多 attachment 最终会变成 synthetic meta user messages，通常包在：
- `<system-reminder>...</system-reminder>`

这让后续的 folding / merging 逻辑可以统一处理。

---

## 6. `normalizeMessagesForAPI()`：真正的 API correctness gate

这是整个 transcript pipeline 里最关键的函数之一。

它不是简单格式化，而是在修补真实 API 错误场景。

### 6.1 它做的事

1. 调整 attachment 顺序
2. 去掉 virtual/display-only message
3. 去掉或降级过时 `tool_reference`
4. 处理超限 image/document block
5. 合并相邻 user message
6. 合并同 id assistant stream fragment
7. 规范化 tool input / tool name
8. 把不合适的 text sibling 从 tool-reference message 挪开
9. 去掉 orphaned thinking-only assistant
10. 去掉 final assistant 尾部 thinking
11. 去掉 whitespace-only assistant
12. 给空 assistant 注入 placeholder
13. 合并 `<system-reminder>` 与相邻 `tool_result`
14. 把 `is_error` tool_result 规范成 text-only
15. snip mode 时附加 `[id:...]`
16. 最后验证 image 合法性

### 6.2 设计判断

这说明 Claude Code 的 transcript engine 已经从“message formatting”升级成了 **API defensive normalization layer**。

---

## 7. tool result pairing：最强一致性守卫

### 7.1 `ensureToolResultPairing()`

它会处理两类不一致：

#### forward mismatch
有 `tool_use`，但没有 `tool_result`
- 插入 synthetic error `tool_result`

#### reverse mismatch
有 `tool_result`，但没有对应 `tool_use`
- 删除 orphaned / duplicate `tool_result`

### 7.2 还会处理什么

- duplicate `tool_use` id
- orphaned `server_tool_use` / `mcp_tool_use`
- 清理后若破坏 role alternation，还会补 placeholder 保持 transcript 合法

### 7.3 strict mode

在 strict mode 下，它不是 repair，而是 throw。

目的：
- 避免在 HFI / 高保真轨迹场景中引入 synthetic placeholder 污染数据

### 7.4 架构意义

这说明 transcript engine 有双模式：
- production 容错修复
- strict 数据保真

---

## 8. stream assembly：流式阶段与最终一致性解耦

### 8.1 `handleMessageFromStream()`

它负责 live stream 期间的组装：
- spinner 状态
- streaming text
- streaming thinking
- partial tool-input JSON
- TTFT 指标

### 8.2 为什么不是直接最终写入

因为 stream fragment 自身不保证 API-safe。

最终仍然要在：
- `normalizeMessagesForAPI()`

阶段做最终一致性校正。

### 8.3 设计价值

这是一种非常稳健的架构：
- streaming path 追求低延迟与可见性
- final normalization path 保证正确性

两者职责不混。

---

## 9. compact boundary 是 transcript 一级概念

相关函数：
- `createCompactBoundaryMessage()`
- `createMicrocompactBoundaryMessage()`
- `findLastCompactBoundaryIndex()`
- `getMessagesAfterCompactBoundary()`

### 9.1 意味着什么

compact 不是“内部压缩一下就完了”，而是 transcript 中的显式边界事件。

### 9.2 作用

- 标记 summarize / microcompact 边界
- 计算 post-compact slice
- 给 query runtime 提供 API-facing history 裁切依据

这使 compact 成为 runtime 的一等机制，而不是隐性 side effect。

---

## 10. resume / recovery 也复用 transcript invariants

相关文件：
- `src/utils/conversationRecovery.ts`

恢复时也会先做：
- `filterUnresolvedToolUses()`
- `filterOrphanedThinkingOnlyMessages()`
- `filterWhitespaceOnlyAssistantMessages()`

再插入 continuation / sentinel message。

说明 transcript correctness 不是只在“正常流程”里维护，而是恢复流程也复用同一套约束。

---

## 11. 架构判断

`messages.ts` 本质上是：

- transcript canonicalizer
- UI transcript shaper
- API transcript validator
- streaming assembler
- compact-boundary interpreter

它在系统里扮演的是 **message semantics kernel**。

如果没有它：
- UI transcript 会乱
- API 调用会频繁 400
- tool_use / tool_result 会失配
- compact / resume / stream fallback 会变得不可控

---

## 12. 关键文件索引

- `src/utils/messages.ts`
- `src/components/Messages.tsx`
- `src/query.ts`
- `src/services/api/claude.ts`
- `src/utils/conversationRecovery.ts`

---

## 13. 一句话结论

Claude Code 的 `messages.ts` 不是消息工具集，而是一套同时服务 UI 与 API 的 **transcript correctness engine**。