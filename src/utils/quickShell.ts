import { spawn } from 'child_process'
import treeKill from 'tree-kill'
import { findSuitableShell, setCwd, type ExecResult } from './Shell.js'
import { pwd } from './cwd.js'
import { errorMessage } from './errors.js'
import { quote } from './bash/shellQuote.js'
import { subprocessEnv } from './subprocessEnv.js'
import { QuickShellTerminal } from './quickShellTerminal.js'

const MAX_INLINE_OUTPUT_CHARS = 200_000
const MAX_PROGRESS_LINES = 100

export type QuickShellProgressCallback = (
  lastLines: string,
  allLines: string,
  totalLines: number,
  totalBytes: number,
  isIncomplete: boolean,
) => void

export type QuickShellCommand = {
  kill: () => void
  cleanup?: () => void
  write: (input: string) => void
  result: Promise<ExecResult>
}

export type QuickShellCommandOptions = {
  columns?: number
  rows?: number
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_INLINE_OUTPUT_CHARS) {
    return { text, truncated: false }
  }
  return {
    text: text.slice(text.length - MAX_INLINE_OUTPUT_CHARS),
    truncated: true,
  }
}

function stripScriptArtifacts(text: string): string {
  return text.replace(/\x04\x08\x08/g, '').replace(/\^D\x08\x08/g, '')
}

function normalizeDisplayOutput(text: string): string {
  return stripScriptArtifacts(text).replace(/\r\n/g, '\n').replace(/\r/g, '')
}

function stripMarkerForDisplay(text: string, marker: string): string {
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex === -1) {
    return text
  }

  return text.slice(0, markerIndex).replace(/(?:\r?\n|\r)$/, '')
}

function removeMarker(text: string, marker: string): {
  output: string
  code?: number
  cwd?: string
} {
  const normalized = normalizeDisplayOutput(text)
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex === -1) {
    return { output: normalized }
  }

  const before = stripMarkerForDisplay(normalized, marker)
  const markerLine = normalized.slice(markerIndex).split('\n')[0] ?? ''
  const markerParts = markerLine.startsWith(`${marker}:`)
    ? markerLine.slice(marker.length + 1).split(':')
    : []
  const codeText = markerParts[0]
  const cwdText = markerParts.slice(1).join(':')
  const code = codeText ? Number(codeText) : undefined
  return {
    output: before,
    code: Number.isFinite(code) ? code : undefined,
    cwd: cwdText || undefined,
  }
}

function buildScriptArgs(shellPath: string, shellScript: string): string[] {
  if (process.platform === 'linux') {
    return [
      '-q',
      '-e',
      '-c',
      `${quote([shellPath])} -ic ${quote([shellScript])}`,
      '/dev/null',
    ]
  }
  return ['-q', '/dev/null', shellPath, '-ic', shellScript]
}

function buildRunner(shellPath: string, shellScript: string): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  if (process.platform === 'darwin') {
    return {
      command: 'expect',
      args: [
        '-c',
        [
          'log_user 1',
          'set timeout -1',
          'spawn -noecho $env(OPENCLAUDE_QUICK_SHELL_SHELL) -ic $env(OPENCLAUDE_QUICK_SHELL_SCRIPT)',
          'interact',
          'set result [wait]',
          'exit [lindex $result 3]',
        ].join('\n'),
      ],
      env: {
        OPENCLAUDE_QUICK_SHELL_SHELL: shellPath,
        OPENCLAUDE_QUICK_SHELL_SCRIPT: shellScript,
      },
    }
  }

  return {
    command: 'script',
    args: buildScriptArgs(shellPath, shellScript),
    env: {},
  }
}

function renderTerminalOutput(terminal: QuickShellTerminal): string {
  const lines = terminal.renderLines()
  return lines.some(line => line.length > 0) ? lines.join('\n') : ''
}

export async function runQuickShellCommand(
  command: string,
  abortSignal: AbortSignal,
  onProgress: QuickShellProgressCallback,
  options: QuickShellCommandOptions = {},
): Promise<QuickShellCommand> {
  const shellPath = await findSuitableShell()
  const cwd = pwd()
  const columns = Math.max(20, Math.floor(options.columns ?? process.stdout.columns ?? 120))
  const rows = Math.max(4, Math.floor(options.rows ?? process.stdout.rows ?? 24))
  const terminal = new QuickShellTerminal(columns, rows)
  let stdout = ''
  let stderr = ''
  let combinedOutput = ''
  let totalBytes = 0
  let totalLines = 0
  let killed = false
  const marker = `__OPENCLAUDE_QUICK_SHELL_${Math.random()
    .toString(16)
    .slice(2)}__`

  const script = `stty rows ${rows} cols ${columns} 2>/dev/null || true
${command}
__openclaude_quick_shell_code=$?
printf '\\n${marker}:%s:%s\\n' "$__openclaude_quick_shell_code" "$PWD"
exit $__openclaude_quick_shell_code`

  const runner = buildRunner(shellPath, script)
  const child = spawn(runner.command, runner.args, {
    cwd,
    detached: true,
    env: {
      ...subprocessEnv(),
      ...runner.env,
      SHELL: shellPath,
      CLAUDECODE: '1',
      TERM:
        !process.env.TERM || process.env.TERM === 'dumb'
          ? 'xterm-256color'
          : process.env.TERM,
      CLICOLOR: process.env.CLICOLOR ?? '1',
      COLORTERM: process.env.COLORTERM ?? 'truecolor',
      COLUMNS: String(columns),
      LINES: String(rows),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const kill = (): void => {
    killed = true
    if (child.pid) {
      treeKill(child.pid)
    } else {
      child.kill()
    }
  }

  const abortHandler = (): void => {
    kill()
  }
  abortSignal.addEventListener('abort', abortHandler, { once: true })

  const appendOutput = (chunk: Buffer | string, isStderr: boolean): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString()
    if (isStderr) {
      stderr += text
    } else {
      stdout += text
    }
    totalBytes += Buffer.byteLength(text)
    totalLines += (text.match(/\n/g) ?? []).length
    combinedOutput += text

    const truncated = truncateOutput(combinedOutput)
    combinedOutput = truncated.text
    const displayOutput = stripMarkerForDisplay(
      stripScriptArtifacts(combinedOutput),
      marker,
    )
    terminal.reset()
    terminal.feed(displayOutput)
    const terminalOutput = renderTerminalOutput(terminal)
    onProgress(
      tailLines(terminalOutput, 5),
      tailLines(terminalOutput, MAX_PROGRESS_LINES),
      totalLines,
      totalBytes,
      truncated.truncated,
    )
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => appendOutput(chunk, false))
  child.stderr?.on('data', chunk => appendOutput(chunk, true))

  const result = new Promise<ExecResult>(resolve => {
    child.once('error', error => {
      abortSignal.removeEventListener('abort', abortHandler)
      const parsed = removeMarker(combinedOutput, marker)
      resolve({
        stdout: renderTerminalOutput(terminal) || parsed.output,
        stderr: stderr ? `${stderr}\n${errorMessage(error)}` : errorMessage(error),
        code: 1,
        interrupted: killed || abortSignal.aborted,
      })
    })

    child.once('exit', code => {
      abortSignal.removeEventListener('abort', abortHandler)
      const parsed = removeMarker(combinedOutput, marker)
      const nextCwd = parsed.cwd
      let cwdError = ''
      if (nextCwd && nextCwd !== cwd) {
        try {
          setCwd(nextCwd, cwd)
        } catch (error) {
          cwdError = errorMessage(error)
        }
      }
      resolve({
        stdout: renderTerminalOutput(terminal) || parsed.output,
        stderr: cwdError,
        code:
          parsed.code ??
          code ??
          (killed || abortSignal.aborted ? 130 : 1),
        interrupted: killed || abortSignal.aborted,
      })
    })
  })

  const write = (input: string): void => {
    if (!input || !child.stdin?.writable) {
      return
    }
    child.stdin.write(input)
  }

  const cleanup = (): void => {
    child.stdin?.destroy()
  }

  return { kill, cleanup, write, result }
}
