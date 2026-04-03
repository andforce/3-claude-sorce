/**
 * Shared analytics configuration — analytics disabled at build.
 */

/**
 * Check if analytics operations should be disabled
 */
export function isAnalyticsDisabled(): boolean {
  return true
}

/**
 * Check if the feedback survey should be suppressed.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return true
}
