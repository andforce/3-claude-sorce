type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

/**
 * Organization metrics opt-out — no network; treated as disabled.
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  return { enabled: false, hasError: false }
}

export const _clearMetricsEnabledCacheForTesting = (): void => {}
