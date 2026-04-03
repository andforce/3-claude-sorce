import type { GrowthBookUserAttributes } from './growthbook.js'

export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

export function getEventSamplingConfig(): EventSamplingConfig {
  return {}
}

export function shouldSampleEvent(_eventName: string): number | null {
  return null
}

export async function shutdown1PEventLogging(): Promise<void> {}

export function is1PEventLoggingEnabled(): boolean {
  return false
}

export function logEventTo1P(
  _eventName: string,
  _metadata: Record<string, number | boolean | undefined> = {},
): void {}

export type GrowthBookExperimentData = {
  experimentId: string
  variationId: number
  userAttributes?: GrowthBookUserAttributes
  experimentMetadata?: Record<string, unknown>
}

export function logGrowthBookExperimentTo1P(
  _data: GrowthBookExperimentData,
): void {}

export function initialize1PEventLogging(): void {}

export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {}
