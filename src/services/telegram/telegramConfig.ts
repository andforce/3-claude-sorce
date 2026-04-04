import {
  getGlobalConfig,
  saveGlobalConfig,
  type TelegramConfig,
} from '../../utils/config.js'
import type {
  TelegramConfigDraft,
  TelegramRuntimeConfig,
} from './telegramTypes.js'

export function getTelegramConfig(): TelegramConfig | undefined {
  return getGlobalConfig().telegram
}

export function hasTelegramRuntimeConfig(): boolean {
  const telegram = getTelegramConfig()
  return Boolean(
    telegram?.botToken?.trim() &&
      (telegram.allowedUserIds?.filter(Boolean).length ?? 0) > 0,
  )
}

export function saveTelegramConfig(updates: TelegramConfigDraft): void {
  saveGlobalConfig(current => ({
    ...current,
    telegram: {
      ...(current.telegram ?? {}),
      ...updates,
      updatedAt: new Date().toISOString(),
    },
  }))
}

export function clearTelegramConfig(): void {
  saveGlobalConfig(current => ({
    ...current,
    telegram: undefined,
  }))
}

export function maskTelegramToken(token?: string): string {
  if (!token) return '未配置'
  if (token.length <= 12) return `${token.slice(0, 4)}...`
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}

export function parseAllowedTelegramUserIds(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\s,]+/)
      .map(part => part.trim())
      .filter(Boolean)
      .filter(part => /^\d+$/.test(part)),
  )]
}

export function formatAllowedTelegramUserIds(userIds?: string[]): string {
  if (!userIds || userIds.length === 0) return ''
  return userIds.join(', ')
}

export function getTelegramRuntimeConfig(): TelegramRuntimeConfig {
  const telegram = getTelegramConfig()
  const botToken = telegram?.botToken?.trim()
  const allowedUserIds = telegram?.allowedUserIds?.filter(Boolean) ?? []

  if (!botToken) {
    throw new Error('请先在 /telegram 中配置 Bot Token')
  }

  if (allowedUserIds.length === 0) {
    throw new Error('请先在 /telegram 中配置允许访问的 Telegram user id')
  }

  return {
    botToken,
    allowedUserIds,
  }
}
