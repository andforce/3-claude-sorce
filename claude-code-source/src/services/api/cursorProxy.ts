/**
 * Cursor gRPC proxy — translates OpenAI-format chat completions to Cursor's
 * protobuf/HTTP2 Connect protocol. Runs as an in-process local HTTP server
 * and spawns a Node.js subprocess for HTTP/2 transport (Bun's node:http2 is broken).
 *
 * Ported from pi-cursor-auth/src/cursor-proxy.ts.
 */
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf"
import { ValueSchema } from "@bufbuild/protobuf/wkt"
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolDefinitionSchema,
  McpToolResultContentItemSchema,
  ModelDetailsSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb.js"
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync, unlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"

const CURSOR_API_URL = "https://api2.cursor.sh"
const CONNECT_END_STREAM_FLAG = 0b00000010

// ---------------------------------------------------------------------------
// Embedded H2 bridge (written to temp file at runtime, run via Node.js)
// ---------------------------------------------------------------------------

const H2_BRIDGE_CODE = `#!/usr/bin/env node
import http2 from "node:http2";
import crypto from "node:crypto";
const CURSOR_CLIENT_VERSION = "cli-2026.01.09-231024f";
const IDLE_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_IDLE_TIMEOUT_MS || "120000");
function writeMessage(data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  process.stdout.write(lenBuf);
  process.stdout.write(data);
}
let stdinBuf = Buffer.alloc(0);
let stdinResolve = null;
let stdinEnded = false;
process.stdin.on("data", (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinResolve) { const r = stdinResolve; stdinResolve = null; r(); }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (stdinResolve) { const r = stdinResolve; stdinResolve = null; r(); }
});
function waitForData() { return new Promise((resolve) => { stdinResolve = resolve; }); }
async function readExact(n) {
  while (stdinBuf.length < n) { if (stdinEnded) return null; await waitForData(); }
  const result = stdinBuf.subarray(0, n);
  stdinBuf = stdinBuf.subarray(n);
  return Buffer.from(result);
}
async function readMessage() {
  const lenBuf = await readExact(4);
  if (!lenBuf) return null;
  const len = lenBuf.readUInt32BE(0);
  if (len === 0) return Buffer.alloc(0);
  return readExact(len);
}
const configBuf = await readMessage();
if (!configBuf) process.exit(1);
const config = JSON.parse(configBuf.toString("utf8"));
const { accessToken, url, path: rpcPath } = config;
const client = http2.connect(url || "https://api2.cursor.sh");
let timeout = null;
function resetIdleTimeout() {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(() => { h2Stream.close(); client.destroy(); process.exit(1); }, IDLE_TIMEOUT_MS);
  timeout.unref?.();
}
resetIdleTimeout();
client.on("connect", () => { resetIdleTimeout(); });
const h2Stream = client.request({
  ":method": "POST",
  ":path": rpcPath || "/agent.v1.AgentService/Run",
  "content-type": "application/connect+proto",
  "connect-protocol-version": "1",
  te: "trailers",
  authorization: \`Bearer \${accessToken}\`,
  "x-ghost-mode": "true",
  "x-cursor-client-version": CURSOR_CLIENT_VERSION,
  "x-cursor-client-type": "cli",
  "x-request-id": crypto.randomUUID(),
});
const closeWithError = () => { if (timeout) clearTimeout(timeout); h2Stream.close(); client.destroy(); process.exit(1); };
client.on("error", () => { closeWithError(); });
h2Stream.on("data", (chunk) => { resetIdleTimeout(); writeMessage(chunk); });
h2Stream.on("end", () => { if (timeout) clearTimeout(timeout); client.close(); setTimeout(() => process.exit(0), 100); });
h2Stream.on("error", () => { closeWithError(); });
(async () => {
  while (true) {
    const msg = await readMessage();
    if (!msg || msg.length === 0) break;
    if (!h2Stream.closed && !h2Stream.destroyed) h2Stream.write(msg);
  }
})();
`

let h2BridgePath: string | null = null

function getH2BridgePath(): string {
  if (h2BridgePath && existsSync(h2BridgePath)) return h2BridgePath
  h2BridgePath = join(tmpdir(), `cursor-h2-bridge-${process.pid}.mjs`)
  writeFileSync(h2BridgePath, H2_BRIDGE_CODE, { mode: 0o700 })
  return h2BridgePath
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** OpenAI chat message; content may be a string or multimodal parts array. */
interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content:
    | string
    | null
    | Array<{ type?: string; text?: string; image_url?: { url?: string } }>
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

/**
 * Cursor gRPC expects plain text user/assistant strings. If we pass a
 * multimodal content array through as-is, protobuf string coercion yields
 * "[object Object]".
 */
function openAIContentToString(content: OpenAIMessage["content"]): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const lines: string[] = []
    for (const part of content) {
      if (part == null || typeof part !== "object") continue
      if (part.type === "text" && typeof part.text === "string") {
        lines.push(part.text)
      } else if (part.type === "image_url") {
        const url = part.image_url?.url
        lines.push(url ? `[Image: ${url}]` : "[Image]")
      } else {
        lines.push(JSON.stringify(part))
      }
    }
    return lines.join("\n")
  }
  return ""
}

interface OpenAIToolDef {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface ChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: OpenAIToolDef[]
  tool_choice?: unknown
}

interface CursorRequestPayload {
  requestBytes: Uint8Array
  blobStore: Map<string, Uint8Array>
  mcpTools: McpToolDefinition[]
}

interface PendingExec {
  execId: string
  execMsgId: number
  toolCallId: string
  toolName: string
  decodedArgs: string
}

interface ActiveBridge {
  bridge: ReturnType<typeof spawnBridge>
  heartbeatTimer: NodeJS.Timeout
  blobStore: Map<string, Uint8Array>
  mcpTools: McpToolDefinition[]
  pendingExecs: PendingExec[]
  onResume: ((sendFrame: (data: Uint8Array) => void) => void) | null
}

const activeBridges = new Map<string, ActiveBridge>()

// ---------------------------------------------------------------------------
// H2 Bridge IPC
// ---------------------------------------------------------------------------

function lpEncode(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(4 + data.length)
  buf.writeUInt32BE(data.length, 0)
  buf.set(data, 4)
  return buf
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length)
  frame[0] = flags
  frame.writeUInt32BE(data.length, 1)
  frame.set(data, 5)
  return frame
}

function spawnBridge(accessToken: string): {
  proc: ChildProcess
  write: (data: Uint8Array) => void
  end: () => void
  onData: (cb: (chunk: Buffer) => void) => void
  onClose: (cb: (code: number) => void) => void
} {
  const bridgePath = getH2BridgePath()
  const proc = spawn("node", [bridgePath], {
    stdio: ["pipe", "pipe", "ignore"],
  })

  const config = JSON.stringify({
    accessToken,
    url: CURSOR_API_URL,
    path: "/agent.v1.AgentService/Run",
  })
  proc.stdin!.write(lpEncode(new TextEncoder().encode(config)))

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
  }

  let pending = Buffer.alloc(0)
  proc.stdout!.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0)
      if (pending.length < 4 + len) break
      const payload = pending.subarray(4, 4 + len)
      pending = pending.subarray(4 + len)
      cbs.data?.(Buffer.from(payload))
    }
  })

  proc.on("close", (code) => {
    cbs.close?.(code ?? 1)
  })

  return {
    proc,
    write(data) {
      try { proc.stdin!.write(lpEncode(data)) } catch {}
    },
    end() {
      try {
        proc.stdin!.write(lpEncode(new Uint8Array(0)))
        proc.stdin!.end()
      } catch {}
    },
    onData(cb) { cbs.data = cb },
    onClose(cb) { cbs.close = cb },
  }
}

// ---------------------------------------------------------------------------
// Proxy Server
// ---------------------------------------------------------------------------

let proxyServer: Server | undefined
let proxyPort: number | undefined

export function getCursorProxyPort(): number | undefined {
  return proxyPort
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

export async function startCursorProxy(
  getAccessToken: () => Promise<string>,
): Promise<number> {
  if (proxyServer && proxyPort) return proxyPort

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      try {
        const bodyText = await readBody(req)
        const body = JSON.parse(bodyText) as ChatCompletionRequest
        const accessToken = await getAccessToken()
        handleChatCompletion(body, accessToken, res)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          error: { message, type: "server_error", code: "internal_error" },
        }))
      }
      return
    }

    res.writeHead(404)
    res.end("Not Found")
  })

  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        proxyPort = addr.port
        proxyServer = server
        resolve(addr.port)
      } else {
        reject(new Error("Failed to bind Cursor proxy to a port"))
      }
    })
    server.on("error", reject)
  })
}

export function stopCursorProxy(): void {
  if (proxyServer) {
    proxyServer.close()
    proxyServer = undefined
    proxyPort = undefined
  }
  for (const [key, active] of activeBridges) {
    clearInterval(active.heartbeatTimer)
    active.bridge.end()
    activeBridges.delete(key)
  }
  if (h2BridgePath) {
    try { unlinkSync(h2BridgePath) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Chat Completion Handler
// ---------------------------------------------------------------------------

function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  res: ServerResponse,
): void {
  const { systemPrompt, userText, turns, toolResults } = parseMessages(body.messages)
  const modelId = body.model
  const tools = body.tools ?? []

  if (!userText && toolResults.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      error: { message: "No user message found", type: "invalid_request_error" },
    }))
    return
  }

  const bridgeKey = deriveBridgeKey(modelId, body.messages)
  const activeBridge = activeBridges.get(bridgeKey)

  if (activeBridge && toolResults.length > 0) {
    activeBridges.delete(bridgeKey)
    handleToolResultResume(activeBridge, toolResults, modelId, tools, accessToken, bridgeKey, res)
    return
  }

  if (activeBridge) {
    clearInterval(activeBridge.heartbeatTimer)
    activeBridge.bridge.end()
    activeBridges.delete(bridgeKey)
  }

  const mcpTools = buildMcpToolDefinitions(tools)
  const payload = buildCursorRequest(modelId, systemPrompt, userText, turns)
  payload.mcpTools = mcpTools

  if (body.stream === false) {
    handleNonStreamingResponse(payload, accessToken, modelId, res)
    return
  }
  handleStreamingResponse(payload, accessToken, modelId, bridgeKey, res)
}

// ---------------------------------------------------------------------------
// Message Parsing
// ---------------------------------------------------------------------------

interface ToolResultInfo {
  toolCallId: string
  content: string
}

interface ParsedMessages {
  systemPrompt: string
  userText: string
  turns: Array<{ userText: string; assistantText: string }>
  toolResults: ToolResultInfo[]
}

function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  let systemPrompt = "You are a helpful assistant."
  const pairs: Array<{ userText: string; assistantText: string }> = []
  const toolResults: ToolResultInfo[] = []

  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => openAIContentToString(m.content))
  if (systemParts.length > 0) systemPrompt = systemParts.join("\n")

  const nonSystem = messages.filter((m) => m.role !== "system")
  let pendingUser = ""

  for (const msg of nonSystem) {
    if (msg.role === "tool") {
      toolResults.push({
        toolCallId: msg.tool_call_id ?? "",
        content: openAIContentToString(msg.content),
      })
    } else if (msg.role === "user") {
      if (pendingUser) pairs.push({ userText: pendingUser, assistantText: "" })
      pendingUser = openAIContentToString(msg.content)
    } else if (msg.role === "assistant") {
      const text = openAIContentToString(msg.content)
      if (pendingUser) {
        pairs.push({ userText: pendingUser, assistantText: text })
        pendingUser = ""
      }
    }
  }

  let lastUserText = ""
  if (pendingUser) {
    lastUserText = pendingUser
  } else if (pairs.length > 0 && toolResults.length === 0) {
    const last = pairs.pop()!
    lastUserText = last.userText
  }

  return { systemPrompt, userText: lastUserText, turns: pairs, toolResults }
}

// ---------------------------------------------------------------------------
// MCP Tool Definitions
// ---------------------------------------------------------------------------

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] }
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema))
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "claude-code",
      toolName: fn.name,
      inputSchema,
    })
  })
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value)
    return toJson(ValueSchema, parsed)
  } catch {}
  return new TextDecoder().decode(value)
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value)
  }
  return decoded
}

// ---------------------------------------------------------------------------
// gRPC Request Building
// ---------------------------------------------------------------------------

function buildCursorRequest(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>()

  const turnBytes: Uint8Array[] = []
  for (const turn of turns) {
    const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: randomUUID() })
    const userMsgBytes = toBinary(UserMessageSchema, userMsg)

    const stepBytes: Uint8Array[] = []
    if (turn.assistantText) {
      const step = create(ConversationStepSchema, {
        message: {
          case: "assistantMessage",
          value: create(AssistantMessageSchema, { text: turn.assistantText }),
        },
      })
      stepBytes.push(toBinary(ConversationStepSchema, step))
    }

    const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: userMsgBytes, steps: stepBytes })
    const turnStructure = create(ConversationTurnStructureSchema, {
      turn: { case: "agentConversationTurn", value: agentTurn },
    })
    turnBytes.push(toBinary(ConversationTurnStructureSchema, turnStructure))
  }

  const systemJson = JSON.stringify({ role: "system", content: systemPrompt })
  const systemBytes = new TextEncoder().encode(systemJson)
  const systemBlobId = new Uint8Array(createHash("sha256").update(systemBytes).digest())
  blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes)

  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [systemBlobId],
    turns: turnBytes,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  })

  const userMessage = create(UserMessageSchema, { text: userText, messageId: randomUUID() })
  const action = create(ConversationActionSchema, {
    action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) },
  })

  const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId })

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    conversationId: randomUUID(),
  })

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  })

  return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] }
}

// ---------------------------------------------------------------------------
// Connect Protocol Helpers
// ---------------------------------------------------------------------------

function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data))
    const error = payload?.error
    if (error) {
      const code = typeof error.code === "string" ? error.code : "unknown"
      const message = typeof error.message === "string" ? error.message : "Unknown error"
      return new Error(`Connect error ${code}: ${message}`)
    }
    return null
  } catch {
    return new Error("Failed to parse Connect end stream")
  }
}

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  })
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat))
}

// ---------------------------------------------------------------------------
// Server Message Processing
// ---------------------------------------------------------------------------

interface StreamState {
  thinkingActive: boolean
  toolCallIndex: number
  pendingExecs: PendingExec[]
}

function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
): void {
  const msgCase = msg.message.case

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(msg.message.value, onText)
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame)
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec)
  }
}

function handleInteractionUpdate(
  update: any,
  onText: (text: string, isThinking?: boolean) => void,
): void {
  const updateCase = update.message?.case
  if (updateCase === "textDelta") {
    const delta = update.message.value.text || ""
    if (delta) onText(delta, false)
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || ""
    if (delta) onText(delta, true)
  }
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case

  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId
    const blobIdKey = Buffer.from(blobId).toString("hex")
    const blobData = blobStore.get(blobIdKey)
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
    })
    const clientMsg = create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } })
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)))
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData)
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
    })
    const clientMsg = create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } })
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)))
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): void {
  const execCase = execMsg.message.case

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [],
      projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [],
    })
    const result = create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
    })
    sendExecResult(execMsg, "requestContextResult", result, sendFrame)
    return
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = execMsg.message.value as any
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {})
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: mcpArgs.toolCallId || randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    })
    return
  }

  const REJECT = "Tool not available in this environment. Use the MCP tools provided instead."

  if (execCase === "readArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "readResult", create(ReadResultSchema, {
      result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "lsArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "lsResult", create(LsResultSchema, {
      result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "grepArgs") {
    sendExecResult(execMsg, "grepResult", create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "writeArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "writeResult", create(WriteResultSchema, {
      result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "deleteArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "shellResult", create(ShellResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "", reason: REJECT, isReadonly: false,
      }) },
    }), sendFrame)
    return
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: { case: "rejected", value: create(ShellRejectedSchema, {
        command: args.command ?? "", workingDirectory: args.workingDirectory ?? "", reason: REJECT, isReadonly: false,
      }) },
    }), sendFrame)
    return
  }
  if (execCase === "writeShellStdinArgs") {
    sendExecResult(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "fetchArgs") {
    const args = execMsg.message.value as any
    sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT }) },
    }), sendFrame)
    return
  }
  if (execCase === "diagnosticsArgs") {
    sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame)
    return
  }

  const miscMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  }
  const resultCase = miscMap[execCase as string]
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame)
  }
}

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id, execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  })
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  })
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
}

// ---------------------------------------------------------------------------
// Bridge Key
// ---------------------------------------------------------------------------

function deriveBridgeKey(modelId: string, messages: OpenAIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user")?.content ?? ""
  return createHash("sha256").update(`${modelId}:${firstUser.slice(0, 200)}`).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Streaming Handler
// ---------------------------------------------------------------------------

function streamSSE(
  res: ServerResponse,
  _payload: CursorRequestPayload,
  _accessToken: string,
  modelId: string,
  bridgeKey: string,
  bridge: ReturnType<typeof spawnBridge>,
  heartbeatTimer: NodeJS.Timeout,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
): void {
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 28)}`
  const created = Math.floor(Date.now() / 1000)

  let closed = false
  const sendSSE = (data: object) => { if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`) }
  const sendDone = () => { if (!closed) res.write("data: [DONE]\n\n") }
  const closeRes = () => { if (closed) return; closed = true; res.end() }

  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: completionId, object: "chat.completion.chunk", created, model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })

  const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] }
  let mcpExecReceived = false
  let pendingBuffer = Buffer.alloc(0)

  const processChunk = (incoming: Buffer) => {
    pendingBuffer = Buffer.concat([pendingBuffer, incoming])

    while (pendingBuffer.length >= 5) {
      const flags = pendingBuffer[0]!
      const msgLen = pendingBuffer.readUInt32BE(1)
      if (pendingBuffer.length < 5 + msgLen) break

      const messageBytes = pendingBuffer.subarray(5, 5 + msgLen)
      pendingBuffer = pendingBuffer.subarray(5 + msgLen)

      if (flags & CONNECT_END_STREAM_FLAG) {
        const endError = parseConnectEndStream(messageBytes)
        if (endError) sendSSE(makeChunk({ content: `\n[Error: ${endError.message}]` }))
        continue
      }

      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes)
        processServerMessage(
          serverMessage, blobStore, mcpTools,
          (data) => bridge.write(data), state,
          (text, isThinking) => {
            if (isThinking) {
              if (!state.thinkingActive) { state.thinkingActive = true; sendSSE(makeChunk({ role: "assistant", content: "<think>" })) }
              sendSSE(makeChunk({ content: text }))
            } else {
              if (state.thinkingActive) { state.thinkingActive = false; sendSSE(makeChunk({ content: "</think>" })) }
              sendSSE(makeChunk({ content: text }))
            }
          },
          (exec) => {
            state.pendingExecs.push(exec)
            mcpExecReceived = true
            if (state.thinkingActive) { sendSSE(makeChunk({ content: "</think>" })); state.thinkingActive = false }
            sendSSE(makeChunk({
              tool_calls: [{ index: state.toolCallIndex++, id: exec.toolCallId, type: "function",
                function: { name: exec.toolName, arguments: exec.decodedArgs } }],
            }))
            activeBridges.set(bridgeKey, {
              bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs: state.pendingExecs, onResume: null,
            })
            sendSSE(makeChunk({}, "tool_calls"))
            sendDone()
            closeRes()
          },
        )
      } catch {
        // Skip unparseable messages
      }
    }
  }

  bridge.onData(processChunk)

  bridge.onClose(() => {
    clearInterval(heartbeatTimer)
    if (!mcpExecReceived) {
      if (state.thinkingActive) sendSSE(makeChunk({ content: "</think>" }))
      sendSSE(makeChunk({}, "stop"))
      sendDone()
      closeRes()
    }
  })
}

function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  res: ServerResponse,
): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })
  const bridge = spawnBridge(accessToken)
  bridge.write(frameConnectMessage(payload.requestBytes))
  const heartbeatTimer = setInterval(() => { bridge.write(makeHeartbeatBytes()) }, 5_000)
  streamSSE(res, payload, accessToken, modelId, bridgeKey, bridge, heartbeatTimer, payload.blobStore, payload.mcpTools)
}

// ---------------------------------------------------------------------------
// Tool Result Resume
// ---------------------------------------------------------------------------

function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  modelId: string,
  _tools: OpenAIToolDef[],
  _accessToken: string,
  bridgeKey: string,
  res: ServerResponse,
): void {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs } = active

  for (const exec of pendingExecs) {
    const result = toolResults.find((r) => r.toolCallId === exec.toolCallId)
    const mcpResult = result
      ? create(McpResultSchema, {
          result: { case: "success", value: create(McpSuccessSchema, {
            content: [create(McpToolResultContentItemSchema, {
              content: { case: "text", value: create(McpTextContentSchema, { text: result.content }) },
            })],
            isError: false,
          }) },
        })
      : create(McpResultSchema, {
          result: { case: "error", value: create(McpErrorSchema, { error: "Tool result not provided" }) },
        })

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId, execId: exec.execId,
      message: { case: "mcpResult" as any, value: mcpResult as any },
    })
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    })
    bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)))
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })
  streamSSE(res, { requestBytes: new Uint8Array(0), blobStore, mcpTools }, "", modelId, bridgeKey, bridge, heartbeatTimer, blobStore, mcpTools)
}

// ---------------------------------------------------------------------------
// Non-Streaming Handler
// ---------------------------------------------------------------------------

function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  res: ServerResponse,
): void {
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 28)}`
  const created = Math.floor(Date.now() / 1000)

  collectFullResponse(payload, accessToken).then((fullText) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      id: completionId, object: "chat.completion", created, model: modelId,
      choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }))
  }).catch((err) => {
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } }))
  })
}

async function collectFullResponse(payload: CursorRequestPayload, accessToken: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let fullText = ""
    const bridge = spawnBridge(accessToken)
    bridge.write(frameConnectMessage(payload.requestBytes))
    const heartbeatTimer = setInterval(() => { bridge.write(makeHeartbeatBytes()) }, 5_000)
    let pendingBuffer = Buffer.alloc(0)
    const state: StreamState = { thinkingActive: false, toolCallIndex: 0, pendingExecs: [] }

    bridge.onData((incoming) => {
      pendingBuffer = Buffer.concat([pendingBuffer, incoming])
      while (pendingBuffer.length >= 5) {
        const flags = pendingBuffer[0]!
        const msgLen = pendingBuffer.readUInt32BE(1)
        if (pendingBuffer.length < 5 + msgLen) break
        const messageBytes = pendingBuffer.subarray(5, 5 + msgLen)
        pendingBuffer = pendingBuffer.subarray(5 + msgLen)
        if (flags & CONNECT_END_STREAM_FLAG) continue
        try {
          const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes)
          processServerMessage(serverMessage, payload.blobStore, payload.mcpTools,
            (data) => bridge.write(data), state,
            (text) => { fullText += text }, () => {})
        } catch {}
      }
    })

    bridge.onClose(() => { clearInterval(heartbeatTimer); resolve(fullText) })
  })
}
