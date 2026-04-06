import { logForDebugging } from '../../utils/debug.js'
import { getTelegramRuntimeConfig } from './telegramConfig.js'
import type {
  TelegramAnswerCallbackQueryResponse,
  TelegramBotCommand,
  TelegramCallbackEvent,
  TelegramChatAction,
  TelegramEditMessageResponse,
  TelegramGetMeResponse,
  TelegramGetUpdatesResponse,
  TelegramInboundEvent,
  TelegramInlineKeyboardMarkup,
  TelegramRuntimeConfig,
  TelegramSendChatActionResponse,
  TelegramSendMessageResponse,
  TelegramSetMyCommandsResponse,
  TelegramServiceState,
  TelegramUpdate,
} from './telegramTypes.js'

type Listener = () => void
type InboundListener = (event: TelegramInboundEvent) => void
type CallbackListener = (event: TelegramCallbackEvent) => void

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const MAX_TELEGRAM_MESSAGE_LENGTH = 4000
const POLL_TIMEOUT_SECONDS = 25
const RETRY_DELAY_MS = 3000
const MAX_TELEGRAM_MENU_COMMANDS = 100
const TELEGRAM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeTelegramError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function chunkTelegramMessage(text: string): string[] {
  const normalized = text.trim()
  if (!normalized) return ['模型本轮没有返回可发送的文本结果。']

  const chunks: string[] = []
  for (let i = 0; i < normalized.length; i += MAX_TELEGRAM_MESSAGE_LENGTH) {
    chunks.push(normalized.slice(i, i + MAX_TELEGRAM_MESSAGE_LENGTH))
  }
  return chunks
}

function hasSameConfig(
  left: TelegramRuntimeConfig | undefined,
  right: TelegramRuntimeConfig,
): boolean {
  if (!left) return false
  return (
    left.botToken === right.botToken &&
    left.allowedUserIds.join(',') === right.allowedUserIds.join(',')
  )
}

function normalizeCommandDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim().slice(0, 256)
}

async function getTelegramMenuCommands(): Promise<TelegramBotCommand[]> {
  const { getCommands, getCommandName } = await import('../../commands.js')
  const commands = await getCommands(process.cwd())
  const results: TelegramBotCommand[] = []
  const seen = new Set<string>()

  for (const command of commands) {
    const candidates = [getCommandName(command), ...(command.aliases ?? [])]
    const name = candidates.find(candidate => TELEGRAM_COMMAND_NAME_RE.test(candidate))
    if (!name || seen.has(name)) continue

    results.push({
      command: name,
      description: normalizeCommandDescription(command.description),
    })
    seen.add(name)

    if (results.length >= MAX_TELEGRAM_MENU_COMMANDS) {
      break
    }
  }

  return results
}

class TelegramService {
  private listeners = new Set<Listener>()
  private inboundListeners = new Set<InboundListener>()
  private callbackListeners = new Set<CallbackListener>()
  private state: TelegramServiceState = { status: 'stopped' }
  private config?: TelegramRuntimeConfig
  private abortController: AbortController | null = null
  private runId = 0
  private nextUpdateOffset: number | undefined

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeToInbound = (listener: InboundListener): (() => void) => {
    this.inboundListeners.add(listener)
    return () => {
      this.inboundListeners.delete(listener)
    }
  }

  subscribeToCallbacks = (listener: CallbackListener): (() => void) => {
    this.callbackListeners.add(listener)
    return () => {
      this.callbackListeners.delete(listener)
    }
  }

  getStateSnapshot = (): TelegramServiceState => this.state

  async start(config: TelegramRuntimeConfig): Promise<void> {
    if (this.state.status === 'running' && hasSameConfig(this.config, config)) {
      return
    }

    await this.stop()

    const runId = ++this.runId
    const abortController = new AbortController()
    this.abortController = abortController
    this.config = config
    this.nextUpdateOffset = undefined

    this.setState({
      status: 'starting',
      lastError: undefined,
      botUsername: undefined,
      botDisplayName: undefined,
      startedAt: undefined,
      activeChatId: undefined,
      activeUserId: undefined,
    })

    try {
      const response = await this.callTelegram<TelegramGetMeResponse>(
        config,
        'getMe',
        {},
        abortController.signal,
      )

      if (runId !== this.runId || abortController.signal.aborted) return

      try {
        await this.refreshTelegramMenu(config, abortController.signal)
      } catch (error) {
        if (!abortController.signal.aborted && runId === this.runId) {
          const message = normalizeTelegramError(error)
          logForDebugging(`[telegram] failed to refresh menu: ${message}`, {
            level: 'error',
          })
          this.patchState({ lastError: message })
        }
      }

      if (runId !== this.runId || abortController.signal.aborted) return

      this.setState({
        status: 'running',
        botUsername: response.result?.username,
        botDisplayName: response.result?.first_name,
        startedAt: new Date().toISOString(),
        lastError: undefined,
      })

      logForDebugging(
        `[telegram] connected as @${response.result?.username ?? 'unknown'}`,
      )

      void this.pollLoop(runId, config, abortController.signal)
    } catch (error) {
      if (abortController.signal.aborted || runId !== this.runId) return
      const message = normalizeTelegramError(error)
      this.setState({
        status: 'stopped',
        lastError: message,
      })
      throw error
    }
  }

  async startFromSavedConfig(): Promise<void> {
    await this.start(getTelegramRuntimeConfig())
  }

  async restartFromSavedConfig(): Promise<void> {
    await this.startFromSavedConfig()
  }

  async stop(): Promise<void> {
    this.runId++
    this.abortController?.abort()
    this.abortController = null
    this.config = undefined
    this.nextUpdateOffset = undefined

    if (this.state.status !== 'stopped') {
      this.setState({
        ...this.state,
        status: 'stopped',
        startedAt: undefined,
      })
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<number | undefined> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    let lastMessageId: number | undefined
    for (const chunk of chunkTelegramMessage(text)) {
      const response = await this.callTelegram<TelegramSendMessageResponse>(
        this.config,
        'sendMessage',
        {
          chat_id: Number(chatId),
          text: chunk,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
      )
      lastMessageId = response.result?.message_id
    }
    return lastMessageId
  }

  async sendChatAction(
    chatId: string,
    action: TelegramChatAction = 'typing',
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    await this.callTelegram<TelegramSendChatActionResponse>(
      this.config,
      'sendChatAction',
      {
        chat_id: Number(chatId),
        action,
      },
    )
  }

  async editMessage(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    await this.callTelegram<TelegramEditMessageResponse>(
      this.config,
      'editMessageText',
      {
        chat_id: Number(chatId),
        message_id: messageId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    )
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    if (!this.config) {
      throw new Error('Telegram service is not running')
    }

    await this.callTelegram<TelegramAnswerCallbackQueryResponse>(
      this.config,
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
      },
    )
  }

  private setState(nextState: TelegramServiceState): void {
    this.state = nextState
    for (const listener of this.listeners) {
      listener()
    }
  }

  private patchState(patch: Partial<TelegramServiceState>): void {
    this.setState({
      ...this.state,
      ...patch,
    })
  }

  private emitInbound(event: TelegramInboundEvent): void {
    for (const listener of this.inboundListeners) {
      listener(event)
    }
  }

  private emitCallback(event: TelegramCallbackEvent): void {
    for (const listener of this.callbackListeners) {
      listener(event)
    }
  }

  private async pollLoop(
    runId: number,
    config: TelegramRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && runId === this.runId) {
      try {
        const response = await this.callTelegram<TelegramGetUpdatesResponse>(
          config,
          'getUpdates',
          {
            offset: this.nextUpdateOffset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        )

        if (signal.aborted || runId !== this.runId) return

        if (this.state.lastError) {
          this.patchState({ lastError: undefined })
        }

        for (const update of response.result ?? []) {
          this.handleUpdate(update, config)
        }
      } catch (error) {
        if (signal.aborted || runId !== this.runId) return

        const message = normalizeTelegramError(error)
        logForDebugging(`[telegram] polling failed: ${message}`, {
          level: 'error',
        })
        this.patchState({ lastError: message })
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  private async refreshTelegramMenu(
    config: TelegramRuntimeConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const commands = await getTelegramMenuCommands()

    await this.callTelegram<TelegramSetMyCommandsResponse>(
      config,
      'setMyCommands',
      {
        commands,
      },
      signal,
    )

    logForDebugging(`[telegram] refreshed menu commands: ${commands.length}`)
  }

  private handleUpdate(
    update: TelegramUpdate,
    config: TelegramRuntimeConfig,
  ): void {
    this.nextUpdateOffset = update.update_id + 1

    const message = update.message
    const callbackQuery = update.callback_query

    if (callbackQuery?.data) {
      const chatId = callbackQuery.message?.chat?.id
      const userId = callbackQuery.from?.id
      const messageId = callbackQuery.message?.message_id
      if (
        chatId !== undefined &&
        userId !== undefined &&
        messageId !== undefined &&
        !callbackQuery.from?.is_bot
      ) {
        if (!config.allowedUserIds.includes(String(userId))) {
          return
        }
        this.emitCallback({
          kind: 'callback-query',
          callbackQueryId: callbackQuery.id,
          chatId: String(chatId),
          userId: String(userId),
          messageId,
          data: callbackQuery.data,
        })
      }
      return
    }

    const chatId = message?.chat?.id
    const userId = message?.from?.id

    if (!message || chatId === undefined || userId === undefined) return
    if (message.from?.is_bot) return
    if (message.chat?.type !== 'private') return

    const normalizedChatId = String(chatId)
    const normalizedUserId = String(userId)

    if (!config.allowedUserIds.includes(normalizedUserId)) {
      void this.sendMessage(
        normalizedChatId,
        '这个 Telegram user id 尚未被当前 /telegram 配置授权。',
      ).catch(() => {})
      return
    }

    this.patchState({
      activeChatId: normalizedChatId,
      activeUserId: normalizedUserId,
    })

    const text = message.text?.trim()

    if (!text) {
      void this.sendMessage(
        normalizedChatId,
        '当前只支持文本消息，请发送纯文本内容。',
      ).catch(() => {})
      return
    }

    if (text === '/start') {
      void this.sendMessage(
        normalizedChatId,
        'Telegram 已连接到当前 Openclaude 会话。直接发送文本即可开始远程对话。',
      ).catch(() => {})
      return
    }

    this.emitInbound({
      kind: 'inbound-message',
      chatId: normalizedChatId,
      userId: normalizedUserId,
      text,
      messageId: message.message_id,
      updateId: update.update_id,
    })
  }

  private async callTelegram<T>(
    config: TelegramRuntimeConfig,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${config.botToken}/${method}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      },
    )

    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`)
    }

    const json = await response.json() as {
      ok?: boolean
      description?: string
    }

    if (!json.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${json.description ?? 'unknown error'}`,
      )
    }

    return json as T
  }
}

export const telegramService = new TelegramService()
