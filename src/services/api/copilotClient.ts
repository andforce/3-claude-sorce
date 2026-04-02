import { getGlobalConfig, saveGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'

const COPILOT_API_BASE = 'https://api.githubcopilot.com'
const MODELS_DEV_URL = 'https://models.dev/api.json'

export type CopilotModelInfo = {
  id: string
  label: string
  description: string
}

export function isCopilotModel(model: string): boolean {
  return model.startsWith('copilot:')
}

export function getCopilotModelId(model: string): string {
  return model.replace(/^copilot:/, '')
}

export function getCopilotProvider(): ConnectedProviderInfo | undefined {
  const config = getGlobalConfig()
  return config.connectedProviders?.['github-copilot']
}

export function isCopilotConnected(): boolean {
  return !!getCopilotProvider()?.oauthToken
}

const FALLBACK_COPILOT_MODELS: CopilotModelInfo[] = [
  { id: 'copilot:claude-sonnet-4.6', label: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6 via Copilot' },
  { id: 'copilot:claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5 via Copilot' },
  { id: 'copilot:claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Claude Sonnet 4 via Copilot' },
  { id: 'copilot:claude-opus-4.6', label: 'Claude Opus 4.6', description: 'Claude Opus 4.6 via Copilot' },
  { id: 'copilot:claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Claude Opus 4.5 via Copilot' },
  { id: 'copilot:claude-opus-41', label: 'Claude Opus 4.1', description: 'Claude Opus 4.1 via Copilot' },
  { id: 'copilot:claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Claude Haiku 4.5 via Copilot' },
  { id: 'copilot:gpt-5.4', label: 'GPT-5.4', description: 'OpenAI GPT-5.4 via Copilot' },
  { id: 'copilot:gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'OpenAI GPT-5.4 mini via Copilot' },
  { id: 'copilot:gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'OpenAI GPT-5.3-Codex via Copilot' },
  { id: 'copilot:gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'OpenAI GPT-5.2-Codex via Copilot' },
  { id: 'copilot:gpt-5.2', label: 'GPT-5.2', description: 'OpenAI GPT-5.2 via Copilot' },
  { id: 'copilot:gpt-5.1', label: 'GPT-5.1', description: 'OpenAI GPT-5.1 via Copilot' },
  { id: 'copilot:gpt-5.1-codex', label: 'GPT-5.1-Codex', description: 'OpenAI GPT-5.1-Codex via Copilot' },
  { id: 'copilot:gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-mini', description: 'OpenAI GPT-5.1-Codex-mini via Copilot' },
  { id: 'copilot:gpt-5.1-codex-max', label: 'GPT-5.1-Codex-max', description: 'OpenAI GPT-5.1-Codex-max via Copilot' },
  { id: 'copilot:gpt-5', label: 'GPT-5', description: 'OpenAI GPT-5 via Copilot' },
  { id: 'copilot:gpt-5-mini', label: 'GPT-5-mini', description: 'OpenAI GPT-5-mini via Copilot' },
  { id: 'copilot:gpt-4.1', label: 'GPT-4.1', description: 'OpenAI GPT-4.1 via Copilot' },
  { id: 'copilot:gpt-4o', label: 'GPT-4o', description: 'OpenAI GPT-4o via Copilot' },
  { id: 'copilot:gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', description: 'Google Gemini 3.1 Pro via Copilot' },
  { id: 'copilot:gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Google Gemini 3 Pro via Copilot' },
  { id: 'copilot:gemini-3-flash-preview', label: 'Gemini 3 Flash', description: 'Google Gemini 3 Flash via Copilot' },
  { id: 'copilot:gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Google Gemini 2.5 Pro via Copilot' },
  { id: 'copilot:grok-code-fast-1', label: 'Grok Code Fast 1', description: 'xAI Grok Code Fast 1 via Copilot' },
]

let cachedModels: CopilotModelInfo[] | null = null

export async function fetchCopilotModelsFromModelsDev(): Promise<CopilotModelInfo[]> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return FALLBACK_COPILOT_MODELS

    const data = await response.json() as Record<string, { models?: Record<string, { name?: string }> }>
    const copilotProvider = data['github-copilot']
    if (!copilotProvider?.models) return FALLBACK_COPILOT_MODELS

    const models: CopilotModelInfo[] = Object.entries(copilotProvider.models).map(
      ([modelId, info]) => ({
        id: `copilot:${modelId}`,
        label: info.name || modelId,
        description: `${info.name || modelId} via Copilot`,
      }),
    )

    return models.length > 0 ? models : FALLBACK_COPILOT_MODELS
  } catch {
    return FALLBACK_COPILOT_MODELS
  }
}

export async function getCopilotModels(): Promise<CopilotModelInfo[]> {
  if (cachedModels) return cachedModels

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (cached && cached.models.length > 0) {
    const age = Date.now() - cached.fetchedAt
    if (age < 3600_000) {
      cachedModels = cached.models
      return cachedModels
    }
  }

  const models = await fetchCopilotModelsFromModelsDev()
  cachedModels = models

  saveGlobalConfig({
    ...config,
    copilotModelsCache: { models, fetchedAt: Date.now() },
  })

  return models
}

export function getCopilotModelsCached(): CopilotModelInfo[] {
  if (cachedModels) return cachedModels

  const config = getGlobalConfig()
  const cached = config.copilotModelsCache
  if (cached && cached.models.length > 0) {
    cachedModels = cached.models
    return cachedModels
  }

  return FALLBACK_COPILOT_MODELS
}

export { FALLBACK_COPILOT_MODELS as COPILOT_MODELS }

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
  | { type: 'thinking'; thinking: string }
  | Record<string, unknown>

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export function convertAnthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      const toolResults: OpenAIMessage[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: (block as { type: 'text'; text: string }).text })
        } else if (block.type === 'image') {
          const imgBlock = block as { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}` },
          })
        } else if (block.type === 'tool_result') {
          const trBlock = block as { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }> }
          let content = ''
          if (typeof trBlock.content === 'string') {
            content = trBlock.content
          } else if (Array.isArray(trBlock.content)) {
            content = trBlock.content
              .filter(c => c.type === 'text')
              .map(c => c.text || '')
              .join('\n')
          }
          toolResults.push({
            role: 'tool',
            content,
            tool_call_id: trBlock.tool_use_id,
          })
        }
      }

      if (toolResults.length > 0) {
        result.push(...toolResults)
        if (parts.length > 0) {
          result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
        }
      } else if (parts.length > 0) {
        result.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text! : parts })
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push((block as { type: 'text'; text: string }).text)
        } else if (block.type === 'tool_use') {
          const tuBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          toolCalls.push({
            id: tuBlock.id,
            type: 'function',
            function: {
              name: tuBlock.name,
              arguments: JSON.stringify(tuBlock.input),
            },
          })
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    }
  }

  return result
}

export function convertAnthropicToolsToOpenAI(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
): OpenAITool[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

export type CopilotStreamEvent =
  | { type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; model: string; content: []; usage: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: 'message_stop' }

export async function* streamCopilotRequest(
  model: string,
  messages: AnthropicMessage[],
  systemPrompt: string | undefined,
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>,
  signal: AbortSignal,
): AsyncGenerator<CopilotStreamEvent> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected. Use /connect to authenticate.')
  }

  const copilotModelId = getCopilotModelId(model)
  const openaiMessages = convertAnthropicMessagesToOpenAI(messages, systemPrompt)
  const openaiTools = tools.length > 0 ? convertAnthropicToolsToOpenAI(tools) : undefined

  const requestBody: Record<string, unknown> = {
    model: copilotModelId,
    messages: openaiMessages,
    stream: true,
    max_tokens: 16384,
  }

  if (openaiTools && openaiTools.length > 0) {
    requestBody.tools = openaiTools
    requestBody.tool_choice = 'auto'
  }

  const response = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.oauthToken}`,
      'User-Agent': 'claude-code/2.1.88',
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'user',
    },
    body: JSON.stringify(requestBody),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error')
    throw new Error(`Copilot API error (${response.status}): ${errorText}`)
  }

  if (!response.body) {
    throw new Error('No response body from Copilot API')
  }

  const messageId = `msg_copilot_${Date.now()}`
  let contentIndex = 0
  let hasStartedContent = false
  let currentToolCallIndex = -1
  const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map()
  let totalOutputTokens = 0

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: copilotModelId,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex - 1 }
          }
          for (const [idx, tc] of toolCalls) {
            yield {
              type: 'content_block_stop',
              index: contentIndex + idx,
            }
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
              role?: string
            }
            finish_reason?: string | null
          }>
          usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number }
        }

        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        if (chunk.usage?.completion_tokens) {
          totalOutputTokens = chunk.usage.completion_tokens
        }

        const choice = chunk.choices?.[0]
        if (!choice?.delta) continue

        const delta = choice.delta

        if (delta.content != null && delta.content !== '') {
          if (!hasStartedContent) {
            hasStartedContent = true
            yield {
              type: 'content_block_start',
              index: contentIndex,
              content_block: { type: 'text', text: '' },
            }
          }
          yield {
            type: 'content_block_delta',
            index: contentIndex,
            delta: { type: 'text_delta', text: delta.content },
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              if (hasStartedContent && currentToolCallIndex === -1) {
                yield { type: 'content_block_stop', index: contentIndex }
                contentIndex++
                hasStartedContent = false
              }
              currentToolCallIndex = tc.index
              toolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              })
              const toolBlockIndex = hasStartedContent ? contentIndex + 1 + tc.index : contentIndex + tc.index
              yield {
                type: 'content_block_start' as const,
                index: toolBlockIndex,
                content_block: {
                  type: 'text',
                  text: '',
                } as any,
              }
            } else if (tc.function?.arguments) {
              const existing = toolCalls.get(tc.index)
              if (existing) {
                existing.arguments += tc.function.arguments
              }
            }
          }
        }

        if (choice.finish_reason) {
          if (hasStartedContent) {
            yield { type: 'content_block_stop', index: contentIndex }
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn' },
            usage: { output_tokens: totalOutputTokens },
          }
          yield { type: 'message_stop' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: totalOutputTokens },
  }
  yield { type: 'message_stop' }
}

export function createCopilotFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const provider = getCopilotProvider()
  if (!provider?.oauthToken) {
    throw new Error('GitHub Copilot is not connected')
  }

  const copilotModelId = getCopilotModelId(model)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    // Token counting and other non-creation endpoints are not supported via Copilot
    if (url.includes('/count_tokens') || url.includes('/models')) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

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
      model: copilotModelId,
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

    const copilotResponse = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.oauthToken}`,
        'User-Agent': 'claude-code/2.1.88',
        'Openai-Intent': 'conversation-edits',
        'x-initiator': 'user',
      },
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!copilotResponse.ok) {
      return copilotResponse
    }

    if (!isStreaming) {
      const data = await copilotResponse.json() as {
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
        id: data.id || `msg_copilot_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent,
        model: copilotModelId,
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

    if (!copilotResponse.body) {
      return copilotResponse
    }

    const transformStream = convertOpenAIStreamToAnthropic(
      copilotResponse.body,
      copilotModelId,
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

export function convertOpenAIStreamToAnthropic(
  openaiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let contentIndex = 0
  let hasStartedText = false
  let totalOutputTokens = 0
  const messageId = `msg_copilot_${Date.now()}`
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
  let sentMessageStart = false

  return new ReadableStream({
    async start(controller) {
      const reader = openaiStream.getReader()

      function emitEvent(event: Record<string, unknown>) {
        const eventType = event.type as string
        controller.enqueue(
          encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') {
              if (hasStartedText) {
                emitEvent({ type: 'content_block_stop', index: contentIndex })
              }
              for (const [idx, tc] of toolCalls) {
                const toolBlockIndex = (hasStartedText ? 1 : 0) + idx
                emitEvent({
                  type: 'content_block_stop',
                  index: toolBlockIndex,
                })
              }
              emitEvent({
                type: 'message_delta',
                delta: { stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn' },
                usage: { output_tokens: totalOutputTokens },
              })
              emitEvent({ type: 'message_stop' })
              controller.close()
              return
            }

            let chunk: Record<string, unknown>
            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }

            if (!sentMessageStart) {
              sentMessageStart = true
              emitEvent({
                type: 'message_start',
                message: {
                  id: messageId,
                  type: 'message',
                  role: 'assistant',
                  model,
                  content: [],
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              })
            }

            const usage = chunk.usage as { completion_tokens?: number } | undefined
            if (usage?.completion_tokens) {
              totalOutputTokens = usage.completion_tokens
            }

            const choices = chunk.choices as Array<{
              delta?: {
                content?: string | null
                tool_calls?: Array<{
                  index: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string | null
            }> | undefined

            const choice = choices?.[0]
            if (!choice?.delta) continue

            const delta = choice.delta

            if (delta.content != null && delta.content !== '') {
              if (!hasStartedText) {
                hasStartedText = true
                emitEvent({
                  type: 'content_block_start',
                  index: contentIndex,
                  content_block: { type: 'text', text: '' },
                })
              }
              emitEvent({
                type: 'content_block_delta',
                index: contentIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  if (hasStartedText && toolCalls.size === 0) {
                    emitEvent({ type: 'content_block_stop', index: contentIndex })
                    contentIndex++
                  }
                  toolCalls.set(tc.index, {
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  })
                  const toolBlockIndex = contentIndex + tc.index
                  emitEvent({
                    type: 'content_block_start',
                    index: toolBlockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: tc.id,
                      name: tc.function?.name || '',
                      input: {},
                    },
                  })
                } else if (tc.function?.arguments) {
                  const existing = toolCalls.get(tc.index)
                  if (existing) {
                    existing.arguments += tc.function.arguments
                    const toolBlockIndex = contentIndex + tc.index
                    emitEvent({
                      type: 'content_block_delta',
                      index: toolBlockIndex,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: tc.function.arguments,
                      },
                    })
                  }
                }
              }
            }

            if (choice.finish_reason) {
              if (hasStartedText && toolCalls.size === 0) {
                emitEvent({ type: 'content_block_stop', index: contentIndex })
              }
              for (const [idx, tc] of toolCalls) {
                const toolBlockIndex = contentIndex + idx
                emitEvent({ type: 'content_block_stop', index: toolBlockIndex })
              }
              emitEvent({
                type: 'message_delta',
                delta: {
                  stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
                },
                usage: { output_tokens: totalOutputTokens },
              })
              emitEvent({ type: 'message_stop' })
              controller.close()
              return
            }
          }
        }

        if (!sentMessageStart) {
          emitEvent({
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        }
        emitEvent({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: totalOutputTokens },
        })
        emitEvent({ type: 'message_stop' })
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}
