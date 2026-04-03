import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * Attach error log sink. Called from setup() for the default
 * command; other entrypoints (subcommands, daemon, bridge) call this directly
 * since they bypass setup().
 */
export function initSinks(): void {
  initializeErrorLogSink()
}
