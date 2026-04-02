import { getGlobalConfig, type ConnectedProviderInfo } from '../../utils/config.js'
import {
  convertAnthropicMessagesToOpenAI,
  convertAnthropicToolsToOpenAI,
  convertOpenAIStreamToAnthropic,
} from './copilotClient.js'

export const CUSTOM_OPENAI_PROVIDER_ID = 'custom-third-party'
export const CUSTOM_OPENAI_MODEL_PREFIX = 'openai-compatible:'

export type OpenAICompatibleModelInfo = {
  id: string
  label: string
  description: string
}

function getCustomOpenAIProvider(): ConnectedProviderInfo | undefined {
  const config = getGlobalConfig()
  return config.connectedProviders?.[CUSTOM_OPENAI_PROVIDER_ID]
}

export function isCustomOpenAIConnected(): boolean {
  const provider = getCustomOpenAIProvider()
  return !!provider?.apiKey && !!provider?.enterpriseUrl
}

export function isCustomOpenAIModel(model: string): boolean {
  return model.startsWith(CUSTOM_OPENAI_MODEL_PREFIX)
}

export function getCustomOpenAIModelId(model: string): string {
  return model.replace(CUSTOM_OPENAI_MODEL_PREFIX, '')
}

export function getCustomOpenAIModelsCached(): OpenAICompatibleModelInfo[] {
  const provider = getCustomOpenAIProvider()
  return provider?.modelsCache ?? []
}

export function getCustomOpenAIModelDisplayName(model: string): string | undefined {
  const cached = getCustomOpenAIModelsCached()
  return cached.find(item => item.id === model)?.label
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/$/, '')
}

async function fetchOpenAIModelsFromEndpoint(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAICompatibleModelInfo[]> {
  const response = await fetch(`${normalizeOpenAIBaseUrl(baseUrl)}/models`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error')
    throw new Error(`Failed to fetch models (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; owned_by?: string }>
  }

  const models = (data.data ?? [])
    .filter(model => typeof model.id === 'string' && model.id.trim().length > 0)
    .map(model => {
      const rawId = model.id!.trim()
      const label = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : rawId
      const ownerSuffix =
        typeof model.owned_by === 'string' && model.owned_by.trim()
          ? ` · ${model.owned_by.trim()}`
          : ''

      return {
        id: `${CUSTOM_OPENAI_MODEL_PREFIX}${rawId}`,
        label,
        description: `${rawId} via Others${ownerSuffix}`,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  if (models.length === 0) {
    throw new Error('No models returned from the provider')
  }

  return models
}

export async function fetchCustomOpenAIModels(
  baseUrl?: string,
  apiKey?: string,
): Promise<OpenAICompatibleModelInfo[]> {
  const provider = getCustomOpenAIProvider()
  const resolvedBaseUrl = baseUrl ?? provider?.enterpriseUrl
  const resolvedApiKey = apiKey ?? provider?.apiKey

  if (!resolvedBaseUrl || !resolvedApiKey) {
    throw new Error('Custom OpenAI-compatible provider is not configured')
  }

  return fetchOpenAIModelsFromEndpoint(resolvedBaseUrl, resolvedApiKey)
}

export function createCustomOpenAIFetchOverride(
  model: string,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const provider = getCustomOpenAIProvider()
  if (!provider?.apiKey || !provider.enterpriseUrl) {
    throw new Error('Custom OpenAI-compatible provider is not connected')
  }

  const modelId = getCustomOpenAIModelId(model)
  const baseUrl = normalizeOpenAIBaseUrl(provider.enterpriseUrl)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      input instanceof URL ? input.href : typeof input === 'string' ? input : input.url

    if (!url.includes('/messages') && !url.includes('/v1/')) {
      return fetch(input, init)
    }

    if (url.includes('/count_tokens') || url.includes('/models')) {
      return new Response(JSON.stringify({ input_tokens: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let anthropicBody: Record<string, unknown> = {}
    if (init?.body) {
      try {
        anthropicBody = JSON.parse(
          typeof init.body === 'string'
            ? init.body
            : new TextDecoder().decode(init.body as ArrayBuffer),
        )
      } catch {
        return fetch(input, init)
      }
    }

    const systemBlocks =
      anthropicBody.system as Array<{ type: string; text: string }> | string | undefined
    let systemPrompt = ''
    if (typeof systemBlocks === 'string') {
      systemPrompt = systemBlocks
    } else if (Array.isArray(systemBlocks)) {
      systemPrompt = systemBlocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n\n')
    }

    const anthropicMessages = (anthropicBody.messages || []) as Array<{
      role: 'user' | 'assistant'
      content: unknown
    }>
    const openaiMessages = convertAnthropicMessagesToOpenAI(
      anthropicMessages,
      systemPrompt,
    )

    const anthropicTools = (anthropicBody.tools || []) as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>
    const openaiTools =
      anthropicTools.length > 0
        ? convertAnthropicToolsToOpenAI(anthropicTools)
        : undefined

    const isStreaming = anthropicBody.stream === true
    const requestBody: Record<string, unknown> = {
      model: modelId,
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

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: init?.signal,
    })

    if (!response.ok) {
      return response
    }

    if (!isStreaming) {
      const data = (await response.json()) as {
        id?: string
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{
              id: string
              function: { name: string; arguments: string }
            }>
          }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const choice = data.choices?.[0]
      const anthropicContent: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: unknown
      }> = []

      if (choice?.message?.content) {
        anthropicContent.push({ type: 'text', text: choice.message.content })
      }

      if (choice?.message?.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          anthropicContent.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || '{}'),
          })
        }
      }

      return new Response(
        JSON.stringify({
          id: data.id || `msg_openai_compatible_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: anthropicContent,
          model: modelId,
          stop_reason:
            choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
          usage: {
            input_tokens: data.usage?.prompt_tokens || 0,
            output_tokens: data.usage?.completion_tokens || 0,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    if (!response.body) {
      return response
    }

    return new Response(convertOpenAIStreamToAnthropic(response.body, modelId), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}
