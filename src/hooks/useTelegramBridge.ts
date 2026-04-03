import { useEffect, useRef } from 'react'
import { telegramService } from '../services/telegram/TelegramService.js'
import {
  TELEGRAM_CHANNEL_SERVER,
  type TelegramInboundEvent,
} from '../services/telegram/telegramTypes.js'
import type { Message } from '../types/message.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { getContentText } from '../utils/messages.js'
import { logForDebugging } from '../utils/debug.js'

type Props = {
  messages: Message[]
  isLoading: boolean
}

type ActiveTelegramTurn = {
  chatId: string
  lastAssistantText?: string
}

export function useTelegramBridge({ messages, isLoading }: Props): void {
  const pendingInboundRef = useRef<TelegramInboundEvent[]>([])
  const activeTurnRef = useRef<ActiveTelegramTurn | null>(null)
  const lastProcessedMessageCountRef = useRef(messages.length)
  const previousLoadingRef = useRef(isLoading)

  useEffect(() => {
    return telegramService.subscribeToInbound(event => {
      pendingInboundRef.current.push(event)
      enqueue({
        value: event.text,
        mode: 'prompt',
        skipSlashCommands: true,
        origin: {
          kind: 'channel',
          server: TELEGRAM_CHANNEL_SERVER,
        } as const,
      })
    })
  }, [])

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
          }
        }
        continue
      }

      if (message.type === 'assistant' && activeTurnRef.current) {
        const text = getContentText(message.message.content)
        if (text) {
          activeTurnRef.current.lastAssistantText = text
        }
      }
    }

    lastProcessedMessageCountRef.current = messages.length
  }, [messages])

  useEffect(() => {
    const wasLoading = previousLoadingRef.current
    previousLoadingRef.current = isLoading

    if (!wasLoading || isLoading || !activeTurnRef.current) {
      return
    }

    const { chatId, lastAssistantText } = activeTurnRef.current
    activeTurnRef.current = null

    void telegramService
      .sendMessage(
        chatId,
        lastAssistantText ?? '这一轮没有可回传的文本结果，请查看本地终端会话。',
      )
      .catch(error => {
        logForDebugging(
          `[telegram] failed to send outbound reply: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { level: 'error' },
        )
      })
  }, [isLoading])
}
