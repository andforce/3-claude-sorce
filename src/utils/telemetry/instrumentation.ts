/**
 * OpenTelemetry bootstrap — disabled; exports retained for call sites.
 */

export function bootstrapTelemetry(): void {}

export function parseExporterTypes(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

export function isTelemetryEnabled(): boolean {
  return false
}

export async function initializeTelemetry(): Promise<undefined> {
  return undefined
}

export async function flushTelemetry(): Promise<void> {}
