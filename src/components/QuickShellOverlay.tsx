import * as React from 'react'
import { useRegisterOverlay } from '../context/overlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, RawAnsi, Text, useInput } from '../ink.js'
import { truncateToWidth } from '../utils/format.js'
import type { ExecResult } from '../utils/Shell.js'
import { Dialog } from './design-system/Dialog.js'
import TextInput from './TextInput.js'

export type QuickShellProgress = {
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  timeoutMs?: number
}

type Props = {
  visible: boolean
  input: string
  cursorOffset: number
  runningCommand: string | null
  progress: QuickShellProgress | null
  result: ExecResult | null
  finalOutput: string
  idleOutput: string
  verbose: boolean
  onInputChange: (value: string) => void
  onCursorOffsetChange: (offset: number) => void
  onSubmit: (command: string) => void
  onHistoryUp: () => void
  onHistoryDown: () => void
  onComplete: () => void
  onClose: () => void
  onInterrupt: () => void
  onWriteInput: (input: string) => void
}

function resultOutput(result: ExecResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

function toAnsiLines(output: string): string[] {
  const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n')
}

function inputForTerminal(
  raw: string,
  key: Parameters<Parameters<typeof useInput>[0]>[1],
  event: Parameters<Parameters<typeof useInput>[0]>[2],
): string {
  if (event.keypress.raw) return event.keypress.raw
  if (event.keypress.sequence) return event.keypress.sequence
  if (key.return) return '\r'
  if (key.tab) return '\t'
  if (key.backspace) return '\x7f'
  if (key.delete) return '\x1b[3~'
  if (key.escape) return '\x1b'
  return raw
}

export function QuickShellOverlay({
  visible,
  input,
  cursorOffset,
  runningCommand,
  progress,
  result,
  finalOutput,
  idleOutput,
  verbose,
  onInputChange,
  onCursorOffsetChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  onComplete,
  onClose,
  onInterrupt,
  onWriteInput,
}: Props): React.ReactNode {
  useRegisterOverlay('quick-shell', visible)
  const { columns, rows } = useTerminalSize()
  const isRunning = runningCommand !== null
  const inputColumns = Math.max(20, columns - 10)
  const outputWidth = Math.max(20, columns - 4)
  const maxOutputRows = Math.max(4, rows - 8)

  useInput(
    (raw, key, event) => {
      if (isRunning) {
        if (key.ctrl && (raw === '`' || raw === ' ' || raw === '@')) {
          onClose()
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && raw === 'c') {
          onInterrupt()
          event.stopImmediatePropagation()
          return
        }
        onWriteInput(inputForTerminal(raw, key, event))
        event.stopImmediatePropagation()
        return
      }

      if (key.escape) {
        onClose()
        event.stopImmediatePropagation()
        return
      }
      if (key.tab && !key.shift) {
        onComplete()
        event.stopImmediatePropagation()
        return
      }
      if (key.ctrl && raw === 'c') {
        onInterrupt()
        event.stopImmediatePropagation()
      }
    },
    { isActive: visible },
  )

  if (!visible) {
    return null
  }

  const status = isRunning
    ? `Running: ${truncateToWidth(runningCommand, Math.max(12, columns - 22))}`
    : result
      ? result.interrupted
        ? 'Interrupted'
        : `Exit ${result.code}`
      : 'Ready'
  const output = isRunning
    ? progress?.fullOutput || progress?.output || ''
    : result
      ? idleOutput || finalOutput || resultOutput(result)
      : idleOutput
  const outputLines = output ? toAnsiLines(output).slice(-maxOutputRows) : []

  return (
    <Dialog
      title="Quick Shell"
      subtitle={status}
      color="bashBorder"
      onCancel={onClose}
      isCancelActive={false}
      hideInputGuide
    >
      <Box flexDirection="column" gap={1} width="100%">
        {isRunning && runningCommand ? (
          <Box flexDirection="row">
            <Text color="bashBorder">$ </Text>
            <Text>{runningCommand}</Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color="bashBorder">$ </Text>
            <TextInput
              value={input}
              onChange={onInputChange}
              onSubmit={onSubmit}
              onExit={onInterrupt}
              onHistoryUp={onHistoryUp}
              onHistoryDown={onHistoryDown}
              multiline={false}
              focus={visible}
              showCursor
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={onCursorOffsetChange}
              disableCursorMovementForUpDownKeys
              disableEscapeDoublePress
              placeholder="shell command"
            />
          </Box>
        )}

        {outputLines.length > 0 ? (
          <Box flexDirection="column" maxHeight={maxOutputRows} overflow="hidden">
            <RawAnsi lines={outputLines} width={outputWidth} />
          </Box>
        ) : result ? (
          <Text dimColor>(no output)</Text>
        ) : null}
      </Box>
    </Dialog>
  )
}
