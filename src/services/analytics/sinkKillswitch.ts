export type SinkName = 'datadog' | 'firstParty'

/** Analytics disabled — treat all sinks as killed. */
export function isSinkKilled(_sink: SinkName): boolean {
  return true
}
