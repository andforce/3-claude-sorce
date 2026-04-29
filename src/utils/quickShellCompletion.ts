import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { stringWidth } from '../ink/stringWidth.js'
import { pwd } from './cwd.js'

export type QuickShellCompletionResult = {
  input: string
  cursorOffset: number
  output: string
}

type TokenInfo = {
  start: number
  end: number
  token: string
}

type DecodedToken = {
  value: string
  quote: "'" | '"' | null
}

type Match = {
  name: string
  isDirectory: boolean
}

function tokenAtCursor(input: string, cursorOffset: number): TokenInfo {
  const end = Math.max(0, Math.min(cursorOffset, input.length))
  let start = 0
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < end; i++) {
    const char = input[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      start = i + 1
    }
  }

  return { start, end, token: input.slice(start, end) }
}

function decodeToken(token: string): DecodedToken {
  const quote = token[0] === "'" || token[0] === '"' ? token[0] : null
  const body = quote ? token.slice(1) : token
  if (quote === "'") {
    return { value: body, quote }
  }

  let value = ''
  let escaped = false
  for (const char of body) {
    if (escaped) {
      value += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    value += char
  }
  if (escaped) value += '\\'
  return { value, quote }
}

function encodeToken(value: string, quote: "'" | '"' | null, complete: boolean): string {
  if (quote === "'") {
    return `'${value.replace(/'/g, `'\\''`)}${complete ? "' " : ''}`
  }
  if (quote === '"') {
    return `"${value.replace(/(["\\$`])/g, '\\$1')}${complete ? '" ' : ''}`
  }
  const escaped = value.replace(/([\\\s"'$`!&|;<>(){}[\]*?~#])/g, '\\$1')
  return escaped + (complete ? ' ' : '')
}

function splitPathPrefix(value: string): { dirPart: string; basePrefix: string } {
  const slashIndex = value.lastIndexOf('/')
  if (slashIndex === -1) {
    return { dirPart: '', basePrefix: value }
  }
  return {
    dirPart: value.slice(0, slashIndex + 1),
    basePrefix: value.slice(slashIndex + 1),
  }
}

function resolveDirectory(dirPart: string): string {
  if (dirPart === '~') {
    return homedir()
  }
  if (dirPart.startsWith('~/')) {
    return resolve(homedir(), dirPart.slice(2))
  }
  if (isAbsolute(dirPart)) {
    return dirPart
  }
  return resolve(pwd(), dirPart || '.')
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]!
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
  }
  return prefix
}

function padToWidth(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - stringWidth(value)))
}

function formatMatches(matches: Match[], columns: number): string {
  const labels = matches.map(match => `${match.name}${match.isDirectory ? '/' : ''}`)
  const itemWidth = Math.min(
    Math.max(1, columns),
    Math.max(...labels.map(label => stringWidth(label)), 1) + 2,
  )
  const itemsPerRow = Math.max(1, Math.floor(Math.max(1, columns) / itemWidth))
  const rows: string[] = []

  for (let index = 0; index < labels.length; index += itemsPerRow) {
    rows.push(
      labels
        .slice(index, index + itemsPerRow)
        .map(label => padToWidth(label, itemWidth))
        .join('')
        .trimEnd(),
    )
  }

  return rows.join('\n')
}

export async function completeQuickShellInput(
  input: string,
  cursorOffset: number,
  columns: number,
): Promise<QuickShellCompletionResult> {
  const token = tokenAtCursor(input, cursorOffset)
  const decoded = decodeToken(token.token)
  const { dirPart, basePrefix } = splitPathPrefix(decoded.value)
  const directory = resolveDirectory(dirPart)

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { input, cursorOffset, output: '' }
  }

  const matches = entries
    .filter(entry => {
      if (!basePrefix.startsWith('.') && entry.name.startsWith('.')) {
        return false
      }
      return entry.name.startsWith(basePrefix)
    })
    .map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (matches.length === 0) {
    return { input, cursorOffset, output: '' }
  }

  const replaceToken = (value: string, complete: boolean): QuickShellCompletionResult => {
    const replacement = encodeToken(value, decoded.quote, complete)
    return {
      input: input.slice(0, token.start) + replacement + input.slice(token.end),
      cursorOffset: token.start + replacement.length,
      output: '',
    }
  }

  if (matches.length === 1) {
    const match = matches[0]!
    return replaceToken(`${dirPart}${match.name}${match.isDirectory ? '/' : ''}`, !match.isDirectory)
  }

  const prefix = commonPrefix(matches.map(match => match.name))
  const completed =
    prefix.length > basePrefix.length
      ? replaceToken(`${dirPart}${prefix}`, false)
      : { input, cursorOffset, output: '' }

  return {
    ...completed,
    output: formatMatches(matches, columns),
  }
}
