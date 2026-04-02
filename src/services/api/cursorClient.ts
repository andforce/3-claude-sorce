import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalConfig, saveGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertOpenAIStreamToAnthropic,
  type AnthropicMessage,
} from './copilotClient.js'
import { startCursorProxy, stopCursorProxy, getCursorProxyPort } from './cursorProxy.js'

const CURSOR_API_BASE = 'https://api2.cursor.sh'
const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll'
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'
const CURSOR_CLIENT_VERSION = 'cli-2026.02.13-41ac335'

export type CursorModelInfo = {
  id: string
  label: string
  description: string
}

// ---------------------------------------------------------------------------
// Model identification
// ---------------------------------------------------------------------------

export function isCursorModel(model: string): boolean {
  return model.startsWith('cursor:')
}

export function getCursorModelId(model: string): string {
  return model.replace(/^cursor:/, '')
}

export function getCursorProvider(): ConnectedProviderInfo | undefined {
  const config = getGlobalConfig()
  return config.connectedProviders?.['cursor']
}

export function isCursorConnected(): boolean {
  return !!getCursorProvider()?.oauthToken
}

// ---------------------------------------------------------------------------
// PKCE authentication helpers
// ---------------------------------------------------------------------------

export async function generateCursorAuthParams(): Promise<{
  verifier: string
  challenge: string
  uuid: string
  loginUrl: string
}> {
  const verifierBytes = randomBytes(96)
  const verifier = verifierBytes.toString('base64url')
  const hashBuffer = createHash('sha256').update(verifier).digest()
  const challenge = Buffer.from(hashBuffer).toString('base64url')
  const uuid = randomUUID()

  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  })
  const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`
  return { verifier, challenge, uuid, loginUrl }
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600_000
    }
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
      return decoded.exp * 1000 - 5 * 60 * 1000
    }
  } catch {
    // ignore
  }
  return Date.now() + 3600_000
}

async function refreshCursorToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  expires: number
}> {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  if (!response.ok) {
    throw new Error(`Cursor token refresh failed: ${response.status}`)
  }

  const data = await response.json() as { accessToken: string; refreshToken: string }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expires: getTokenExpiry(data.accessToken),
  }
}

async function getValidAccessToken(): Promise<string> {
  const provider = getCursorProvider()
  if (!provider?.oauthToken) {
    throw new Error('Cursor is not connected')
  }

  const expiry = provider.tokenExpiry || 0
  if (Date.now() < expiry) {
    return provider.oauthToken
  }

  if (!provider.refreshToken) {
    throw new Error('Cursor token expired and no refresh token available. Please reconnect via /connect.')
  }

  const refreshed = await refreshCursorToken(provider.refreshToken)
  saveGlobalConfig(current => ({
    ...current,
    connectedProviders: {
      ...(current.connectedProviders || {}),
      cursor: {
        ...current.connectedProviders?.cursor,
        oauthToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiry: refreshed.expires,
        connectedAt: current.connectedProviders?.cursor?.connectedAt || new Date().toISOString(),
      },
    },
  }))
  return refreshed.accessToken
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire-format decoder (no external dependency)
// ---------------------------------------------------------------------------
// GetUsableModelsResponse: field 1 (repeated ModelDetails)
// ModelDetails fields:
//   1: model_id (string), 2: thinking_details (message), 3: display_model_id (string),
//   4: display_name (string), 5: display_name_short (string), 6: aliases (repeated string)

function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos]!
    result |= (byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result, pos]
}

function parseProtobufFields(buf: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>()
  let offset = 0
  while (offset < buf.length) {
    const [tag, tagEnd] = readVarint(buf, offset)
    offset = tagEnd
    const fieldNumber = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === 0) {
      const [, varEnd] = readVarint(buf, offset)
      offset = varEnd
    } else if (wireType === 2) {
      const [length, dataOffset] = readVarint(buf, offset)
      const data = buf.subarray(dataOffset, dataOffset + length)
      if (!fields.has(fieldNumber)) fields.set(fieldNumber, [])
      fields.get(fieldNumber)!.push(data)
      offset = dataOffset + length
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else {
      break
    }
  }
  return fields
}

function getProtoString(fields: Map<number, Uint8Array[]>, fieldNumber: number): string {
  const values = fields.get(fieldNumber)
  if (!values || values.length === 0) return ''
  return new TextDecoder().decode(values[0])
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null
  let offset = 0
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!
    const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset)
    const messageLength = view.getUint32(1, false)
    const frameEnd = offset + 5 + messageLength
    if (frameEnd > payload.length) return null
    if ((flags & 0b0000_0001) !== 0) return null
    if (!((flags & 0b0000_0010) !== 0)) {
      return payload.subarray(offset + 5, frameEnd)
    }
    offset = frameEnd
  }
  return null
}

function parseModelsFromProtobuf(buf: Uint8Array): CursorModelInfo[] {
  const response = parseProtobufFields(buf)
  const modelEntries = response.get(1) || []
  const models: CursorModelInfo[] = []
  const seen = new Set<string>()

  for (const modelBuf of modelEntries) {
    const fields = parseProtobufFields(modelBuf)
    const modelId = getProtoString(fields, 1)
    if (!modelId || seen.has(modelId)) continue
    seen.add(modelId)

    const displayName = getProtoString(fields, 4) || getProtoString(fields, 5) || getProtoString(fields, 3) || modelId

    models.push({
      id: `cursor:${modelId}`,
      label: displayName,
      description: `${displayName} via Cursor`,
    })
  }

  return models.sort((a, b) => a.label.localeCompare(b.label))
}

// ---------------------------------------------------------------------------
// Dynamic model fetching via GetUsableModels gRPC endpoint
// ---------------------------------------------------------------------------

export async function fetchCursorUsableModels(apiKey: string): Promise<CursorModelInfo[] | null> {
  const reqPath = join(tmpdir(), `cursor-req-${Date.now()}.bin`)
  const respPath = join(tmpdir(), `cursor-resp-${Date.now()}.bin`)
  try {
    writeFileSync(reqPath, Buffer.alloc(0))
    const headers: Record<string, string> = {
      'content-type': 'application/proto',
      te: 'trailers',
      authorization: `Bearer ${apiKey}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-version': CURSOR_CLIENT_VERSION,
      'x-cursor-client-type': 'cli',
    }
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`])
    const url = `${CURSOR_API_BASE}/agent.v1.AgentService/GetUsableModels`
    const args = [
      'curl', '-s', '--http2', '--max-time', '5',
      '-X', 'POST',
      ...headerArgs,
      '--data-binary', `@${reqPath}`,
      '-o', respPath,
      '-w', '%{http_code}',
      url,
    ]
    const status = execSync(
      args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' '),
      { timeout: 7000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim()

    if (!status.startsWith('2')) return null
    if (!existsSync(respPath)) return null

    const responseBytes = new Uint8Array(readFileSync(respPath))
    if (responseBytes.length === 0) return null

    let payload = responseBytes
    const framedBody = decodeConnectUnaryBody(responseBytes)
    if (framedBody) payload = framedBody

    const models = parseModelsFromProtobuf(payload)
    if (models.length === 0) {
      const directModels = parseModelsFromProtobuf(responseBytes)
      return directModels.length > 0 ? directModels : null
    }
    return models
  } catch {
    return null
  } finally {
    try { unlinkSync(reqPath) } catch {}
    try { unlinkSync(respPath) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Model list management
// ---------------------------------------------------------------------------

const FALLBACK_CURSOR_MODELS: CursorModelInfo[] = [
  { id: 'cursor:composer-2', label: 'Composer 2', description: 'Composer 2 via Cursor' },
  { id: 'cursor:claude-4-sonnet', label: 'Claude 4 Sonnet', description: 'Claude 4 Sonnet via Cursor' },
  { id: 'cursor:claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', description: 'Claude 3.5 Sonnet via Cursor' },
  { id: 'cursor:gpt-4o', label: 'GPT-4o', description: 'GPT-4o via Cursor' },
  { id: 'cursor:gpt-4o-mini', label: 'GPT-4o Mini', description: 'GPT-4o Mini via Cursor' },
  { id: 'cursor:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Gemini 2.5 Pro via Cursor' },
  { id: 'cursor:cursor-small', label: 'Cursor Small', description: 'Cursor Small via Cursor' },
]

let cachedCursorModels: CursorModelInfo[] | null = null

export async function getCursorModels(): Promise<CursorModelInfo[]> {
  if (cachedCursorModels) return cachedCursorModels

  const config = getGlobalConfig()
  const cached = config.cursorModelsCache
  if (cached && cached.models.length > 0) {
    const age = Date.now() - cached.fetchedAt
    if (age < 3600_000) {
      cachedCursorModels = cached.models
      return cachedCursorModels
    }
  }

  const provider = getCursorProvider()
  if (provider?.oauthToken) {
    const token = await getValidAccessToken()
    const models = await fetchCursorUsableModels(token)
    if (models && models.length > 0) {
      cachedCursorModels = models
      saveGlobalConfig(current => ({
        ...current,
        cursorModelsCache: { models, fetchedAt: Date.now() },
      }))
      return models
    }
  }

  if (cached && cached.models.length > 0) {
    cachedCursorModels = cached.models
    return cachedCursorModels
  }

  return FALLBACK_CURSOR_MODELS
}

export function getCursorModelsCached(): CursorModelInfo[] {
  if (cachedCursorModels) return cachedCursorModels

  const config = getGlobalConfig()
  const cached = config.cursorModelsCache
  if (cached && cached.models.length > 0) {
    cachedCursorModels = cached.models
    return cachedCursorModels
  }

  return FALLBACK_CURSOR_MODELS
}

export { FALLBACK_CURSOR_MODELS as CURSOR_MODELS }

// ---------------------------------------------------------------------------
// Local proxy management
// ---------------------------------------------------------------------------
// Cursor's chat API uses gRPC/protobuf over HTTP/2, not a simple REST endpoint.
// We run an in-process local OpenAI-compatible proxy (cursorProxy.ts) that
// handles protobuf encoding and spawns a Node.js H2 bridge subprocess.

let proxyStarting: Promise<number> | null = null

async function ensureCursorProxy(): Promise<number> {
  const existingPort = getCursorProxyPort()
  if (existingPort !== undefined) return existingPort

  if (proxyStarting) return proxyStarting

  proxyStarting = startCursorProxy(async () => getValidAccessToken())
  try {
    return await proxyStarting
  } finally {
    proxyStarting = null
  }
}

process.on('exit', () => {
  stopCursorProxy()
})

// ---------------------------------------------------------------------------
// Fetch override – Anthropic SDK → local proxy (OpenAI format) → Cursor gRPC
// ---------------------------------------------------------------------------

export function createCursorFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const cursorModelId = getCursorModelId(model)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    if (url.includes('/count_tokens') || url.includes('/models')) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const proxyPort = await ensureCursorProxy()

    let anthropicBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        anthropicBody = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as ArrayBuffer))
      } catch {
        return fetch(input, init)
      }
    }

    const systemBlocks = anthropicBody.system as Array<{ type: string; text: string }> | string | undefined
    let systemPrompt = ''
    if (typeof systemBlocks === 'string') {
      systemPrompt = systemBlocks
    } else if (Array.isArray(systemBlocks)) {
      systemPrompt = systemBlocks
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n\n')
    }

    const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
    const openaiMessages = convertAnthropicMessagesToOpenAI(anthropicMessages, systemPrompt)

    const anthropicTools = (anthropicBody.tools || []) as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
    const openaiTools = anthropicTools.length > 0 ? convertAnthropicToolsToOpenAI(anthropicTools) : undefined

    const isStreaming = anthropicBody.stream === true

    const requestBody: Record<string, unknown> = {
      model: cursorModelId,
      messages: openaiMessages,
      stream: isStreaming,
    }

    if (anthropicBody.max_tokens) {
      requestBody.max_tokens = anthropicBody.max_tokens
    }

    if (openaiTools && openaiTools.length > 0) {
      requestBody.tools = openaiTools
      requestBody.tool_choice = 'auto'
    }

    // Route to in-process local proxy, which handles the gRPC/protobuf translation
    const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!proxyResponse.ok) {
      return proxyResponse
    }

    if (!isStreaming) {
      const data = await proxyResponse.json() as {
        id: string
        choices: Array<{
          message: {
            role: string
            content: string | null
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason: string
        }>
        usage?: { prompt_tokens: number; completion_tokens: number }
      }

      const choice = data.choices[0]
      const anthropicContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = []

      if (choice?.message?.content) {
        anthropicContent.push({ type: 'text', text: choice.message.content })
      }

      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          anthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
      }

      const anthropicResponse = {
        id: data.id || `msg_cursor_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent,
        model: cursorModelId,
        stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0,
        },
      }

      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!proxyResponse.body) {
      return proxyResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(
      proxyResponse.body,
      cursorModelId,
    )

    return new Response(transformStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
