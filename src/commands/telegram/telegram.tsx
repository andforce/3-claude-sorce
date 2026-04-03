import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ListItem } from '../../components/design-system/ListItem.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { telegramService } from '../../services/telegram/TelegramService.js'
import {
  clearTelegramConfig,
  formatAllowedTelegramUserIds,
  getTelegramConfig,
  maskTelegramToken,
  parseAllowedTelegramUserIds,
  saveTelegramConfig,
} from '../../services/telegram/telegramConfig.js'

type Step =
  | { type: 'menu' }
  | { type: 'edit-token' }
  | { type: 'edit-user-ids' }
  | { type: 'confirm-clear' }

type Notice = {
  text: string
  tone: 'success' | 'error' | 'info'
}

function TextInput({
  title,
  hint,
  initialValue,
  masked = false,
  onSubmit,
  onCancel,
}: {
  title: string
  hint: string
  initialValue?: string
  masked?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(initialValue ?? '')
  const [cursorOffset, setCursorOffset] = React.useState(
    (initialValue ?? '').length,
  )

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      onSubmit(value.trim())
      return
    }

    if (key.leftArrow) {
      setCursorOffset(current => Math.max(0, current - 1))
      return
    }

    if (key.rightArrow) {
      setCursorOffset(current => Math.min(value.length, current + 1))
      return
    }

    if (key.backspace || key.delete) {
      if (cursorOffset === 0) return
      const nextValue =
        value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
      setValue(nextValue)
      setCursorOffset(current => Math.max(0, current - 1))
      return
    }

    if (input) {
      const nextValue =
        value.slice(0, cursorOffset) + input + value.slice(cursorOffset)
      setValue(nextValue)
      setCursorOffset(current => current + input.length)
    }
  })

  const displayValue = masked ? '*'.repeat(value.length) : value
  const cursorChar =
    cursorOffset < displayValue.length ? displayValue[cursorOffset] : ' '

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Value:</Text>
        <Box>
          <Text>{displayValue.slice(0, cursorOffset)}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{displayValue.slice(cursorOffset + 1)}</Text>
        </Box>
      </Box>
      <Text dimColor>[Enter] 保存 · [Esc] 返回</Text>
    </Box>
  )
}

function ConfirmClear({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      onConfirm()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="yellow">这会清空 Telegram Bot Token 和 user id 白名单。</Text>
      <Text dimColor>
        如果当前 bot 正在运行，会一并停止。按 Enter 确认，Esc 返回。
      </Text>
    </Box>
  )
}

function TelegramDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}) {
  const serviceState = React.useSyncExternalStore(
    telegramService.subscribe,
    telegramService.getStateSnapshot,
  )
  const [config, setConfig] = React.useState(() => getTelegramConfig())
  const [step, setStep] = React.useState<Step>({ type: 'menu' })
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const menuItems = React.useMemo(
    () => [
      {
        label: '设置 Bot Token',
        action: () => setStep({ type: 'edit-token' }),
      },
      {
        label: '设置允许访问的 Telegram user id',
        action: () => setStep({ type: 'edit-user-ids' }),
      },
      {
        label:
          serviceState.status === 'running' ? '停止当前 Telegram Bot' : '启动当前 Telegram Bot',
        action: async () => {
          setBusy(true)
          try {
            if (serviceState.status === 'running') {
              await telegramService.stop()
              setNotice({ text: 'Telegram Bot 已停止。', tone: 'success' })
            } else {
              await telegramService.startFromSavedConfig()
              setNotice({
                text: 'Telegram Bot 已启动，可以在 Telegram 私聊中发送消息。',
                tone: 'success',
              })
            }
          } catch (error) {
            setNotice({
              text: error instanceof Error ? error.message : '启动 Telegram Bot 失败',
              tone: 'error',
            })
          } finally {
            setBusy(false)
          }
        },
      },
      {
        label: '清空 Telegram 配置',
        action: () => setStep({ type: 'confirm-clear' }),
      },
      {
        label: '关闭',
        action: () => onDone(undefined, { display: 'skip' }),
      },
    ],
    [onDone, serviceState.status],
  )

  React.useEffect(() => {
    setFocusIndex(current => Math.min(current, menuItems.length - 1))
  }, [menuItems.length])

  const refreshConfig = React.useCallback(() => {
    setConfig(getTelegramConfig())
  }, [])

  const maybeRestartService = React.useCallback(async () => {
    if (serviceState.status !== 'running') return
    await telegramService.restartFromSavedConfig()
  }, [serviceState.status])

  const saveToken = React.useCallback(
    async (value: string) => {
      if (!value) {
        setNotice({ text: 'Bot Token 不能为空。', tone: 'error' })
        setStep({ type: 'menu' })
        return
      }

      setBusy(true)
      try {
        saveTelegramConfig({ botToken: value })
        refreshConfig()
        await maybeRestartService()
        setNotice({ text: 'Bot Token 已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存 Bot Token 失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [maybeRestartService, refreshConfig],
  )

  const saveUserIds = React.useCallback(
    async (value: string) => {
      const userIds = parseAllowedTelegramUserIds(value)
      if (userIds.length === 0) {
        setNotice({
          text: '至少需要一个有效的 Telegram user id。',
          tone: 'error',
        })
        setStep({ type: 'menu' })
        return
      }

      setBusy(true)
      try {
        saveTelegramConfig({ allowedUserIds: userIds })
        refreshConfig()
        await maybeRestartService()
        setNotice({ text: 'Telegram user id 白名单已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存 Telegram user id 失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [maybeRestartService, refreshConfig],
  )

  const clearConfigAndStop = React.useCallback(async () => {
    setBusy(true)
    try {
      await telegramService.stop()
      clearTelegramConfig()
      refreshConfig()
      setNotice({ text: 'Telegram 配置已清空。', tone: 'success' })
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : '清空 Telegram 配置失败',
        tone: 'error',
      })
    } finally {
      setBusy(false)
      setStep({ type: 'menu' })
    }
  }, [refreshConfig])

  useInput((_, key) => {
    if (step.type !== 'menu' || busy) return

    if (key.escape) {
      onDone(undefined, { display: 'skip' })
      return
    }

    if (key.upArrow) {
      setFocusIndex(current => (current - 1 + menuItems.length) % menuItems.length)
      return
    }

    if (key.downArrow) {
      setFocusIndex(current => (current + 1) % menuItems.length)
      return
    }

    if (key.return) {
      void menuItems[focusIndex]?.action()
    }
  })

  const noticeColor =
    notice?.tone === 'error'
      ? 'red'
      : notice?.tone === 'success'
        ? 'green'
        : 'cyan'

  if (step.type === 'edit-token') {
    return (
      <Dialog title="Telegram Bot Token" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="Bot Token"
          hint="从 BotFather 获取 token。保存后，如当前 bot 正在运行会自动重启。"
          initialValue={config?.botToken}
          masked={true}
          onSubmit={value => {
            void saveToken(value)
          }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-user-ids') {
    return (
      <Dialog
        title="Telegram User IDs"
        onCancel={() => setStep({ type: 'menu' })}
      >
        <TextInput
          title="允许访问的 Telegram user id"
          hint="可输入一个或多个 user id，支持空格或逗号分隔。可通过 @userinfobot 查询。"
          initialValue={formatAllowedTelegramUserIds(config?.allowedUserIds)}
          onSubmit={value => {
            void saveUserIds(value)
          }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'confirm-clear') {
    return (
      <Dialog title="Clear Telegram Config" onCancel={() => setStep({ type: 'menu' })}>
        <ConfirmClear
          onConfirm={() => {
            void clearConfigAndStop()
          }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  return (
    <Dialog title="Telegram" onCancel={() => onDone(undefined, { display: 'skip' })}>
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          在当前 Openclaude 进程内启动 Telegram 长轮询，并把私聊消息接入当前会话。
        </Text>
        <Text>
          状态:
          {' '}
          <Text color={serviceState.status === 'running' ? 'green' : 'yellow'}>
            {serviceState.status === 'running'
              ? '运行中'
              : serviceState.status === 'starting'
                ? '启动中'
                : '未启动'}
          </Text>
        </Text>
        <Text>Bot Token: {maskTelegramToken(config?.botToken)}</Text>
        <Text>
          允许 user id:
          {' '}
          {config?.allowedUserIds?.length
            ? config.allowedUserIds.join(', ')
            : '未配置'}
        </Text>
        <Text>
          当前 bot:
          {' '}
          {serviceState.botUsername
            ? `@${serviceState.botUsername}`
            : '尚未连接 Telegram'}
        </Text>
        <Text>
          最近会话:
          {' '}
          {serviceState.activeUserId && serviceState.activeChatId
            ? `user ${serviceState.activeUserId} / chat ${serviceState.activeChatId}`
            : '暂无'}
        </Text>
        {serviceState.lastError ? (
          <Text color="red">最近错误: {serviceState.lastError}</Text>
        ) : null}
        {notice ? <Text color={noticeColor}>{notice.text}</Text> : null}
        {busy ? <Text dimColor>处理中，请稍候...</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {menuItems.map((item, index) => (
            <ListItem key={item.label} isFocused={focusIndex === index}>
              <Text>{item.label}</Text>
            </ListItem>
          ))}
        </Box>
        <Text dimColor>上下箭头选择，Enter 执行，Esc 关闭</Text>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <TelegramDialog onDone={onDone} />
}

export default call
