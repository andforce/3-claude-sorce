import { Parser } from '../ink/termio/parser.js'
import {
  colorsEqual,
  defaultStyle,
  stylesEqual,
  type Action,
  type Color,
  type Grapheme,
  type TextStyle,
} from '../ink/termio/types.js'

type Cell = {
  char: string
  continuation: boolean
  style: TextStyle
}

type ScreenState = {
  rows: Cell[][]
  cursorX: number
  cursorY: number
  savedX: number
  savedY: number
  scrollTop: number
  scrollBottom: number
}

const NAMED_FG_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
}

function cloneStyle(style: TextStyle): TextStyle {
  return {
    ...style,
    fg: { ...style.fg } as Color,
    bg: { ...style.bg } as Color,
    underlineColor: { ...style.underlineColor } as Color,
  }
}

function blankCell(): Cell {
  return {
    char: ' ',
    continuation: false,
    style: defaultStyle(),
  }
}

function blankRow(width: number): Cell[] {
  return Array.from({ length: width }, blankCell)
}

function createScreen(width: number, height: number): ScreenState {
  return {
    rows: Array.from({ length: height }, () => blankRow(width)),
    cursorX: 0,
    cursorY: 0,
    savedX: 0,
    savedY: 0,
    scrollTop: 0,
    scrollBottom: Math.max(0, height - 1),
  }
}

function resizeScreen(
  screen: ScreenState,
  width: number,
  height: number,
): ScreenState {
  const next = createScreen(width, height)
  const copyHeight = Math.min(height, screen.rows.length)
  for (let y = 0; y < copyHeight; y++) {
    const source = screen.rows[y] ?? []
    const target = next.rows[y]!
    for (let x = 0; x < Math.min(width, source.length); x++) {
      target[x] = {
        char: source[x]?.char ?? ' ',
        continuation: source[x]?.continuation ?? false,
        style: cloneStyle(source[x]?.style ?? defaultStyle()),
      }
    }
  }
  next.cursorX = clamp(screen.cursorX, 0, width - 1)
  next.cursorY = clamp(screen.cursorY, 0, height - 1)
  next.savedX = clamp(screen.savedX, 0, width - 1)
  next.savedY = clamp(screen.savedY, 0, height - 1)
  next.scrollTop = clamp(screen.scrollTop, 0, height - 1)
  next.scrollBottom = clamp(screen.scrollBottom, next.scrollTop, height - 1)
  return next
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isDefaultColor(color: Color): boolean {
  return color.type === 'default'
}

function styleToAnsi(style: TextStyle): string {
  const codes: string[] = []
  if (style.bold) codes.push('1')
  if (style.dim) codes.push('2')
  if (style.italic) codes.push('3')
  if (style.underline !== 'none') codes.push(style.underline === 'double' ? '21' : '4')
  if (style.blink) codes.push('5')
  if (style.inverse) codes.push('7')
  if (style.hidden) codes.push('8')
  if (style.strikethrough) codes.push('9')
  if (style.overline) codes.push('53')

  const fg = colorToAnsi(style.fg, false)
  const bg = colorToAnsi(style.bg, true)
  if (fg) codes.push(fg)
  if (bg) codes.push(bg)

  return codes.length ? `\x1b[${codes.join(';')}m` : ''
}

function colorToAnsi(color: Color, background: boolean): string | undefined {
  if (color.type === 'default') {
    return undefined
  }
  if (color.type === 'named') {
    const fgCode = NAMED_FG_CODES[color.name]
    if (fgCode === undefined) return undefined
    return String(background ? fgCode + 10 : fgCode)
  }
  if (color.type === 'indexed') {
    return `${background ? 48 : 38};5;${color.index}`
  }
  return `${background ? 48 : 38};2;${color.r};${color.g};${color.b}`
}

function isDefaultStyle(style: TextStyle): boolean {
  const empty = defaultStyle()
  return (
    style.bold === empty.bold &&
    style.dim === empty.dim &&
    style.italic === empty.italic &&
    style.underline === empty.underline &&
    style.blink === empty.blink &&
    style.inverse === empty.inverse &&
    style.hidden === empty.hidden &&
    style.strikethrough === empty.strikethrough &&
    style.overline === empty.overline &&
    isDefaultColor(style.fg) &&
    isDefaultColor(style.bg) &&
    colorsEqual(style.underlineColor, empty.underlineColor)
  )
}

function isBlankDefault(cell: Cell): boolean {
  return !cell.continuation && cell.char === ' ' && isDefaultStyle(cell.style)
}

function renderRow(row: Cell[]): string {
  let last = row.length - 1
  while (last >= 0 && isBlankDefault(row[last]!)) {
    last--
  }
  if (last < 0) return ''

  let output = ''
  let currentStyle = defaultStyle()
  for (let index = 0; index <= last; index++) {
    const cell = row[index]!
    if (cell.continuation) continue
    if (!stylesEqual(currentStyle, cell.style)) {
      output += '\x1b[0m' + styleToAnsi(cell.style)
      currentStyle = cloneStyle(cell.style)
    }
    output += cell.char
  }

  if (!stylesEqual(currentStyle, defaultStyle())) {
    output += '\x1b[0m'
  }
  return output
}

export class QuickShellTerminal {
  private parser = new Parser()
  private width: number
  private height: number
  private normal: ScreenState
  private alternate: ScreenState
  private active: ScreenState

  constructor(width: number, height: number) {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.normal = createScreen(this.width, this.height)
    this.alternate = createScreen(this.width, this.height)
    this.active = this.normal
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, width)
    const nextHeight = Math.max(1, height)
    if (nextWidth === this.width && nextHeight === this.height) return

    this.width = nextWidth
    this.height = nextHeight
    this.normal = resizeScreen(this.normal, nextWidth, nextHeight)
    this.alternate = resizeScreen(this.alternate, nextWidth, nextHeight)
    this.active = this.active === this.alternate ? this.alternate : this.normal
  }

  reset(): void {
    this.parser.reset()
    this.normal = createScreen(this.width, this.height)
    this.alternate = createScreen(this.width, this.height)
    this.active = this.normal
  }

  feed(input: string): void {
    for (const action of this.parser.feed(input)) {
      this.apply(action)
    }
  }

  renderLines(): string[] {
    return this.active.rows.map(renderRow)
  }

  renderText(): string {
    return this.renderLines().join('\n')
  }

  private apply(action: Action): void {
    switch (action.type) {
      case 'text':
        this.writeText(action.graphemes, action.style)
        break
      case 'cursor':
        this.applyCursor(action.action)
        break
      case 'erase':
        this.applyErase(action.action)
        break
      case 'scroll':
        this.applyScroll(action.action)
        break
      case 'mode':
        if (action.action.type === 'alternateScreen') {
          this.active = action.action.enabled ? this.alternate : this.normal
          if (action.action.enabled) {
            this.alternate = createScreen(this.width, this.height)
            this.active = this.alternate
          }
        }
        break
      case 'reset':
        this.reset()
        break
      default:
        break
    }
  }

  private writeText(graphemes: Grapheme[], style: TextStyle): void {
    for (const grapheme of graphemes) {
      const value = grapheme.value
      const codePoints = [...value]

      if (codePoints.some(char => (char.codePointAt(0) ?? 0) < 0x20)) {
        for (const char of codePoints) {
          this.writeControlOrText(char, 1, style)
        }
        continue
      }

      this.writeCell(value, grapheme.width, style)
    }
  }

  private writeControlOrText(
    value: string,
    width: 1 | 2,
    style: TextStyle,
  ): void {
    const codePoint = value.codePointAt(0)
    if (value === '\r') {
      this.active.cursorX = 0
      return
    }
    if (value === '\n') {
      this.lineFeed()
      return
    }
    if (value === '\b') {
      this.active.cursorX = Math.max(0, this.active.cursorX - 1)
      return
    }
    if (value === '\t') {
      const spaces = 8 - (this.active.cursorX % 8)
      for (let i = 0; i < spaces; i++) {
        this.writeCell(' ', 1, style)
      }
      return
    }
    if (codePoint !== undefined && codePoint < 0x20) {
      return
    }
    this.writeCell(value, width, style)
  }

  private writeCell(char: string, width: 1 | 2, style: TextStyle): void {
    if (this.active.cursorX >= this.width) {
      this.lineFeed()
      this.active.cursorX = 0
    }
    if (width === 2 && this.active.cursorX === this.width - 1) {
      this.writeCell(' ', 1, style)
      this.lineFeed()
      this.active.cursorX = 0
    }

    const row = this.active.rows[this.active.cursorY]!
    const x = this.active.cursorX
    this.clearWideAt(row, x)
    row[x] = {
      char,
      continuation: false,
      style: cloneStyle(style),
    }
    if (width === 2 && x + 1 < this.width) {
      row[x + 1] = {
        char: '',
        continuation: true,
        style: cloneStyle(style),
      }
    }
    this.active.cursorX += width
  }

  private clearWideAt(row: Cell[], x: number): void {
    if (x > 0 && row[x]?.continuation) {
      row[x - 1] = blankCell()
    }
    if (x + 1 < row.length && row[x + 1]?.continuation) {
      row[x + 1] = blankCell()
    }
  }

  private lineFeed(): void {
    if (this.active.cursorY === this.active.scrollBottom) {
      this.scrollUp(1)
      return
    }
    this.active.cursorY = clamp(this.active.cursorY + 1, 0, this.height - 1)
  }

  private scrollUp(count: number): void {
    for (let i = 0; i < count; i++) {
      this.active.rows.splice(this.active.scrollTop, 1)
      this.active.rows.splice(this.active.scrollBottom, 0, blankRow(this.width))
    }
  }

  private scrollDown(count: number): void {
    for (let i = 0; i < count; i++) {
      this.active.rows.splice(this.active.scrollBottom, 1)
      this.active.rows.splice(this.active.scrollTop, 0, blankRow(this.width))
    }
  }

  private applyCursor(action: Extract<Action, { type: 'cursor' }>['action']): void {
    switch (action.type) {
      case 'move':
        if (action.direction === 'up') {
          this.active.cursorY = clamp(this.active.cursorY - action.count, 0, this.height - 1)
        } else if (action.direction === 'down') {
          this.active.cursorY = clamp(this.active.cursorY + action.count, 0, this.height - 1)
        } else if (action.direction === 'forward') {
          this.active.cursorX = clamp(this.active.cursorX + action.count, 0, this.width - 1)
        } else {
          this.active.cursorX = clamp(this.active.cursorX - action.count, 0, this.width - 1)
        }
        break
      case 'position':
        this.active.cursorY = clamp(action.row - 1, 0, this.height - 1)
        this.active.cursorX = clamp(action.col - 1, 0, this.width - 1)
        break
      case 'column':
        this.active.cursorX = clamp(action.col - 1, 0, this.width - 1)
        break
      case 'row':
        this.active.cursorY = clamp(action.row - 1, 0, this.height - 1)
        break
      case 'save':
        this.active.savedX = this.active.cursorX
        this.active.savedY = this.active.cursorY
        break
      case 'restore':
        this.active.cursorX = this.active.savedX
        this.active.cursorY = this.active.savedY
        break
      case 'nextLine':
        for (let i = 0; i < action.count; i++) {
          this.lineFeed()
        }
        this.active.cursorX = 0
        break
      case 'prevLine':
        this.active.cursorY = clamp(this.active.cursorY - action.count, 0, this.height - 1)
        this.active.cursorX = 0
        break
      default:
        break
    }
  }

  private applyErase(action: Extract<Action, { type: 'erase' }>['action']): void {
    if (action.type === 'chars') {
      const row = this.active.rows[this.active.cursorY]!
      const end = Math.min(this.width, this.active.cursorX + action.count)
      for (let x = this.active.cursorX; x < end; x++) row[x] = blankCell()
      return
    }

    if (action.type === 'line') {
      this.eraseLine(this.active.cursorY, action.region)
      return
    }

    if (action.region === 'all' || action.region === 'scrollback') {
      this.active.rows = Array.from({ length: this.height }, () => blankRow(this.width))
      this.active.cursorX = 0
      this.active.cursorY = 0
      return
    }
    if (action.region === 'toEnd') {
      this.eraseLine(this.active.cursorY, 'toEnd')
      for (let y = this.active.cursorY + 1; y < this.height; y++) {
        this.active.rows[y] = blankRow(this.width)
      }
      return
    }
    this.eraseLine(this.active.cursorY, 'toStart')
    for (let y = 0; y < this.active.cursorY; y++) {
      this.active.rows[y] = blankRow(this.width)
    }
  }

  private eraseLine(
    y: number,
    region: 'toEnd' | 'toStart' | 'all',
  ): void {
    const row = this.active.rows[y]
    if (!row) return
    const start = region === 'toEnd' ? this.active.cursorX : 0
    const end = region === 'toStart' ? this.active.cursorX + 1 : this.width
    for (let x = start; x < end; x++) row[x] = blankCell()
  }

  private applyScroll(action: Extract<Action, { type: 'scroll' }>['action']): void {
    if (action.type === 'up') {
      this.scrollUp(action.count)
    } else if (action.type === 'down') {
      this.scrollDown(action.count)
    } else {
      const top = clamp(action.top - 1, 0, this.height - 1)
      const bottom = clamp(action.bottom - 1, top, this.height - 1)
      this.active.scrollTop = top
      this.active.scrollBottom = bottom
      this.active.cursorX = 0
      this.active.cursorY = 0
    }
  }
}
