import type { TelegramConfig } from '../../utils/config.js'

export const TELEGRAM_CHANNEL_SERVER = 'telegram'

export type TelegramRuntimeConfig = {
  botToken: string
  allowedUserIds: string[]
}

export type TelegramServiceStatus = 'stopped' | 'starting' | 'running'

export type TelegramServiceState = {
  status: TelegramServiceStatus
  botUsername?: string
  botDisplayName?: string
  lastError?: string
  startedAt?: string
  activeChatId?: string
  activeUserId?: string
}

export type TelegramInboundEvent = {
  kind: 'inbound-message'
  chatId: string
  userId: string
  text: string
  messageId: number
  updateId: number
}

export type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat?: {
      id?: number
      type?: string
    }
    from?: {
      id?: number
      is_bot?: boolean
    }
  }
}

export type TelegramGetMeResponse = {
  ok: boolean
  description?: string
  result?: {
    id: number
    is_bot: boolean
    first_name?: string
    username?: string
  }
}

export type TelegramGetUpdatesResponse = {
  ok: boolean
  description?: string
  result?: TelegramUpdate[]
}

export type TelegramSendMessageResponse = {
  ok: boolean
  description?: string
}

export type TelegramConfigDraft = Partial<TelegramConfig>
