import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

/**
 * Internal metrics exporter — no network I/O.
 */
export class BigQueryMetricsExporter implements PushMetricExporter {
  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA
  }
}
