import { useCallback, useEffect, useRef } from 'react'
import type { AppStateStore } from '../state/AppState.js'
import { telegramService } from '../services/telegram/TelegramService.js'
import {
  TELEGRAM_CHANNEL_SERVER,
  type TelegramInboundEvent,
} from '../services/telegram/telegramTypes.js'
import { hasTelegramRuntimeConfig } from '../services/telegram/telegramConfig.js'
import {
  handleTelegramCallback,
  logTelegramInteractiveError,
  maybeHandleTelegramInteractiveInput,
} from '../services/telegram/interactiveCommands.js'
import type { Message } from '../types/message.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { getContentText } from '../utils/messages.js'
import { logForDebugging } from '../utils/debug.js'

type Props = {
  messages: Message[]
  isLoading: boolean
  store: AppStateStore
}

type ActiveTelegramTurn = {
  chatId: string
  responseParts: string[]
}

const TELEGRAM_TYPING_REFRESH_MS = 4000

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim()
}

export function useTelegramBridge({ messages, isLoading, store }: Props): void {
  const pendingInboundRef = useRef<TelegramInboundEvent[]>([])
  const activeTurnRef = useRef<ActiveTelegramTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)
  const autoStartAttemptedRef = useRef(false)
  const typingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const typingChatIdRef = useRef<string | null>(null)

  const stopTypingKeepAlive = useCallback(() => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current)
      typingIntervalRef.current = null
    }
    typingChatIdRef.current = null
  }, [])

  const sendTyping = useCallback(
    (chatId: string) => {
      void telegramService.sendChatAction(chatId, 'typing').catch(error => {
        logForDebugging(
          `[telegram] failed to send typing action: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: 'error' },
        )
        if (
          error instanceof Error &&
          error.message === 'Telegram service is not running'
        ) {
          stopTypingKeepAlive()
        }
      })
    },
    [stopTypingKeepAlive],
  )

  const startTypingKeepAlive = useCallback(
    (chatId: string) => {
      if (
        typingChatIdRef.current === chatId &&
        typingIntervalRef.current !== null
      ) {
        return
      }

      stopTypingKeepAlive()
      typingChatIdRef.current = chatId
      sendTyping(chatId)
      typingIntervalRef.current = setInterval(() => {
        sendTyping(chatId)
      }, TELEGRAM_TYPING_REFRESH_MS)
    },
    [sendTyping, stopTypingKeepAlive],
  )

  useEffect(() => {
    if (autoStartAttemptedRef.current) return
    autoStartAttemptedRef.current = true
    if (!hasTelegramRuntimeConfig()) return

    void telegramService.startFromSavedConfig().catch(error => {
      logForDebugging(
        `[telegram] auto-start failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { level: 'error' },
      )
    })
  }, [])

  useEffect(() => stopTypingKeepAlive, [stopTypingKeepAlive])

  useEffect(() => {
    return telegramService.subscribe(() => {
      if (telegramService.getStateSnapshot().status !== 'running') {
        stopTypingKeepAlive()
      }
    })
  }, [stopTypingKeepAlive])

  useEffect(() => {
    return telegramService.subscribeToInbound(event => {
      void (async () => {
        try {
          if (await maybeHandleTelegramInteractiveInput(event, store)) {
            return
          }

          pendingInboundRef.current.push(event)
          sendTyping(event.chatId)
          enqueue({
            value: event.text,
            mode: 'prompt',
            skipSlashCommands: true,
            bridgeOrigin: true,
            origin: {
              kind: 'channel',
              server: TELEGRAM_CHANNEL_SERVER,
            } as const,
          })
        } catch (error) {
          logTelegramInteractiveError(error)
          await telegramService.sendMessage(
            event.chatId,
            `Telegram 交互处理失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).catch(() => {})
        }
      })()
    })
  }, [sendTyping, store])

  useEffect(() => {
    return telegramService.subscribeToCallbacks(event => {
      void (async () => {
        try {
          await handleTelegramCallback(event, store)
        } catch (error) {
          logTelegramInteractiveError(error)
          await telegramService.answerCallbackQuery(
            event.callbackQueryId,
            '处理按钮操作失败',
          ).catch(() => {})
          await telegramService.sendMessage(
            event.chatId,
            `Telegram 按钮操作失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ).catch(() => {})
        }
      })()
    })
  }, [store])

  useEffect(() => {
    const newMessages = messages.slice(lastProcessedMessageCountRef.current)

    for (const message of newMessages) {
      if (
        message.type === 'user' &&
        message.origin?.kind === 'channel' &&
        message.origin.server === TELEGRAM_CHANNEL_SERVER
      ) {
        const inbound = pendingInboundRef.current.shift()
        if (inbound) {
          activeTurnRef.current = {
            chatId: inbound.chatId,
            responseParts: [],
          }
          startTypingKeepAlive(inbound.chatId)
        }
        continue
      }

      if (message.type === 'assistant' && activeTurnRef.current) {
        const text = getContentText(message.message.content)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
        continue
      }

      if (
        message.type === 'system' &&
        message.subtype === 'local_command' &&
        activeTurnRef.current
      ) {
        const text = stripXmlTags(message.content)
        if (text) {
          activeTurnRef.current.responseParts.push(text)
        }
      }
    }

    lastProcessedMessageCountRef.current = messages.length
  }, [messages, startTypingKeepAlive])

  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    previousLoadingRef.current = isLoading

    if (!wasLoading || isLoading || !activeTurnRef.current) {
      return
    }

    const completedTurn = activeTurnRef.current
    activeTurnRef.current = null

    void (async () => {
      try {
        await telegramService.sendMessage(
          completedTurn.chatId,
          completedTurn.responseParts.join('\n\n').trim() ||
            '这一轮没有可回传的文本结果，请查看本地终端会话。',
        )
      } catch (error) {
        logForDebugging(
          `[telegram] failed to send outbound reply: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: 'error' },
        )
      } finally {
        stopTypingKeepAlive()
      }
    })()
  }, [isLoading, stopTypingKeepAlive])
}
