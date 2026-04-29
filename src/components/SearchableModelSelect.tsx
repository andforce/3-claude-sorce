import * as React from 'react'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { clamp } from '../ink/layout/geometry.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { Box, Text, useTerminalFocus } from '../ink.js'
import { SearchBox } from './SearchBox.js'

type Props = {
  models: string[]
  providerLabel: string
  baseUrl?: string
  onSelect: (modelId: string) => void
  onCancel: () => void
}

function modelMatches(model: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) {
    return true
  }
  return q
    .split(/\s+/)
    .every(part => model.toLowerCase().includes(part))
}

function HighlightedModel({
  model,
  query,
}: {
  model: string
  query: string
}) {
  const q = query.trim()
  if (!q) {
    return <Text>{model}</Text>
  }

  const firstTerm = q.split(/\s+/)[0]?.toLowerCase()
  if (!firstTerm) {
    return <Text>{model}</Text>
  }

  const index = model.toLowerCase().indexOf(firstTerm)
  if (index < 0) {
    return <Text>{model}</Text>
  }

  return (
    <Text>
      {model.slice(0, index)}
      <Text inverse>{model.slice(index, index + firstTerm.length)}</Text>
      {model.slice(index + firstTerm.length)}
    </Text>
  )
}

export function SearchableModelSelect({
  models,
  providerLabel,
  baseUrl,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const isTerminalFocused = useTerminalFocus()
  const { rows, columns } = useTerminalSize()
  const [focusedIndex, setFocusedIndex] = React.useState(0)
  const { query, cursorOffset } = useSearchInput({
    isActive: true,
    onExit: () => {},
    onCancel,
    backspaceExitsOnEmpty: false,
  })

  const filteredModels = React.useMemo(
    () => models.filter(model => modelMatches(model, query)),
    [models, query],
  )

  React.useEffect(() => {
    setFocusedIndex(0)
  }, [query])

  React.useEffect(() => {
    setFocusedIndex(index => clamp(index, 0, filteredModels.length - 1))
  }, [filteredModels.length])

  const visibleCount = Math.max(4, Math.min(10, rows - 13))
  const searchBoxWidth = Math.max(28, Math.min(96, columns - 8))
  const windowStart = clamp(
    focusedIndex - visibleCount + 1,
    0,
    filteredModels.length - visibleCount,
  )
  const visibleModels = filteredModels.slice(windowStart, windowStart + visibleCount)

  const moveFocus = (delta: 1 | -1) => {
    setFocusedIndex(index => clamp(index + delta, 0, filteredModels.length - 1))
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'up') {
      event.preventDefault()
      event.stopImmediatePropagation()
      moveFocus(-1)
      return
    }
    if (event.key === 'down') {
      event.preventDefault()
      event.stopImmediatePropagation()
      moveFocus(1)
      return
    }
    if (event.key === 'return') {
      event.preventDefault()
      event.stopImmediatePropagation()
      const selected = filteredModels[focusedIndex]
      if (selected) {
        onSelect(selected)
      }
    }
  }

  return (
    <Box flexDirection="column" gap={1} onKeyDown={handleKeyDown} tabIndex={0} autoFocus>
      <Text dimColor>
        {providerLabel}
        {baseUrl ? ` · ${baseUrl}` : ''}
      </Text>
      <SearchBox
        query={query}
        cursorOffset={cursorOffset}
        placeholder="Search models..."
        isFocused
        isTerminalFocused={isTerminalFocused}
        width={searchBoxWidth}
      />
      <Text dimColor>
        {query.trim()
          ? `${filteredModels.length} / ${models.length} models`
          : `${models.length} models`}
      </Text>
      <Box flexDirection="column" height={visibleCount} flexShrink={0}>
        {visibleModels.length === 0 ? (
          <Text dimColor>No models match "{query}"</Text>
        ) : (
          visibleModels.map((model, offset) => {
            const index = windowStart + offset
            const isFocused = index === focusedIndex
            const hasMoreAbove = offset === 0 && windowStart > 0
            const hasMoreBelow =
              offset === visibleModels.length - 1 &&
              windowStart + visibleCount < filteredModels.length
            return (
              <Text key={model} color={isFocused ? 'suggestion' : undefined}>
                {hasMoreAbove ? '↑' : hasMoreBelow ? '↓' : ' '}
                {' '}
                {isFocused ? '❯' : ' '}
                {' '}
                {index + 1}.{' '}
                <HighlightedModel model={model} query={query} />
              </Text>
            )
          })
        )}
      </Box>
      <Text dimColor>Type to filter · ↑/↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  )
}
