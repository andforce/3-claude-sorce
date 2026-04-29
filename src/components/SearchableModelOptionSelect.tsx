import * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { clamp } from '../ink/layout/geometry.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { Box, Text, useTerminalFocus } from '../ink.js'
import type { OptionWithDescription } from './CustomSelect/index.js'
import { SearchBox } from './SearchBox.js'

type Props = {
  options: OptionWithDescription<string>[]
  selectedValue?: string
  initialFocusValue?: string
  onChange: (value: string) => void
  onFocus: (value: string) => void
  onCancel: () => void
  getSearchText?: (option: OptionWithDescription<string>) => string
}

function optionMatches(
  option: OptionWithDescription<string>,
  query: string,
  getSearchText?: (option: OptionWithDescription<string>) => string,
): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  const haystack = (
    getSearchText?.(option) ??
    `${String(option.label)} ${option.description ?? ''} ${option.value}`
  ).toLowerCase()
  return normalized.split(/\s+/).every(part => haystack.includes(part))
}

function getLabelText(label: React.ReactNode): string | undefined {
  if (typeof label === 'string') {
    return label
  }
  if (typeof label === 'number') {
    return String(label)
  }
  return undefined
}

function HighlightedLabel({
  label,
  query,
}: {
  label: React.ReactNode
  query: string
}) {
  const text = getLabelText(label)
  if (!text) {
    return <>{label}</>
  }

  const firstTerm = query.trim().split(/\s+/)[0]?.toLowerCase()
  if (!firstTerm) {
    return <Text>{text}</Text>
  }

  const index = text.toLowerCase().indexOf(firstTerm)
  if (index < 0) {
    return <Text>{text}</Text>
  }

  return (
    <Text>
      {text.slice(0, index)}
      <Text inverse>{text.slice(index, index + firstTerm.length)}</Text>
      {text.slice(index + firstTerm.length)}
    </Text>
  )
}

export function SearchableModelOptionSelect({
  options,
  selectedValue,
  initialFocusValue,
  onChange,
  onFocus,
  onCancel,
  getSearchText,
}: Props): React.ReactNode {
  const isTerminalFocused = useTerminalFocus()
  const { rows, columns } = useTerminalSize()
  const [query, setQuery] = React.useState('')
  const [focusedIndex, setFocusedIndex] = React.useState(() => {
    const initialIndex = options.findIndex(option => option.value === initialFocusValue)
    return initialIndex >= 0 ? initialIndex : 0
  })

  const filteredOptions = React.useMemo(
    () => options.filter(option => optionMatches(option, query, getSearchText)),
    [getSearchText, options, query],
  )

  React.useEffect(() => {
    setFocusedIndex(0)
  }, [query])

  React.useEffect(() => {
    setFocusedIndex(index => clamp(index, 0, filteredOptions.length - 1))
  }, [filteredOptions.length])

  const focused = filteredOptions[focusedIndex]
  React.useEffect(() => {
    if (focused) {
      onFocus(focused.value)
    }
  }, [focused, onFocus])

  const visibleCount = Math.max(4, Math.min(10, rows - 14, filteredOptions.length || 4))
  const searchBoxWidth = Math.max(28, Math.min(96, columns - 8))
  const windowStart = clamp(
    focusedIndex - visibleCount + 1,
    0,
    filteredOptions.length - visibleCount,
  )
  const visibleOptions = filteredOptions.slice(windowStart, windowStart + visibleCount)

  const updateQuery = (next: string) => {
    setQuery(next)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'up') {
      event.preventDefault()
      event.stopImmediatePropagation()
      setFocusedIndex(index => clamp(index - 1, 0, filteredOptions.length - 1))
      return
    }
    if (event.key === 'down') {
      event.preventDefault()
      event.stopImmediatePropagation()
      setFocusedIndex(index => clamp(index + 1, 0, filteredOptions.length - 1))
      return
    }
    if (event.key === 'return') {
      event.preventDefault()
      event.stopImmediatePropagation()
      const selected = filteredOptions[focusedIndex]
      if (selected) {
        onChange(selected.value)
      }
      return
    }
    if (event.key === 'escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (query) {
        updateQuery('')
      } else {
        onCancel()
      }
      return
    }
    if (event.key === 'backspace') {
      event.preventDefault()
      event.stopImmediatePropagation()
      updateQuery(query.slice(0, -1))
      return
    }
    if (!event.ctrl && !event.meta && event.key.length === 1) {
      event.preventDefault()
      event.stopImmediatePropagation()
      updateQuery(query + event.key)
    }
  }

  return (
    <Box flexDirection="column" onKeyDown={handleKeyDown} tabIndex={0} autoFocus>
      <Box marginBottom={1}>
        <SearchBox
          query={query}
          placeholder="Search models..."
          isFocused
          isTerminalFocused={isTerminalFocused}
          width={searchBoxWidth}
        />
      </Box>
      <Text dimColor>
        {query ? `${filteredOptions.length} / ${options.length} models` : `${options.length} models`}
      </Text>
      <Box flexDirection="column" height={visibleCount} flexShrink={0}>
        {visibleOptions.length === 0 ? (
          <Text dimColor>No models match "{query}"</Text>
        ) : (
          visibleOptions.map((option, offset) => {
            const absoluteIndex = windowStart + offset
            const isFocused = absoluteIndex === focusedIndex
            const isSelected = option.value === selectedValue
            const hasMoreAbove = offset === 0 && windowStart > 0
            const hasMoreBelow =
              offset === visibleOptions.length - 1 &&
              windowStart + visibleCount < filteredOptions.length
            return (
              <Box key={option.value} flexDirection="row">
                <Text color={isFocused ? 'suggestion' : undefined}>
                  {hasMoreAbove ? '↑' : hasMoreBelow ? '↓' : ' '}
                  {' '}
                  {isFocused ? '❯' : ' '}
                  {' '}
                  {absoluteIndex + 1}.{' '}
                  <HighlightedLabel label={option.label} query={query} />
                  {isSelected ? ' ✔' : ''}
                </Text>
                {option.description ? (
                  <Text dimColor>{'  '}{option.description}</Text>
                ) : null}
              </Box>
            )
          })
        )}
      </Box>
      <Text dimColor>Type to filter · ↑/↓ navigate · Enter confirm · ←/→ adjust effort · Esc clear/exit</Text>
    </Box>
  )
}
