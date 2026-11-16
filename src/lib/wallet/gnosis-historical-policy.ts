/** An engineering ceiling for sampled historical EMA events, not an oracle SLA.
 * Current prices, minute valuations and every bar open/close retain 86400s. */
export const GNOSIS_HISTORY_POLICY = Object.freeze({
  id: 'gnosis-ema-history-event-grace-v2', intervalSeconds: 900, heartbeatSeconds: 86400,
  maximumDeliveryExcessSeconds: 60, phase: 'event', successor: 'immediate-canonical-before-strict-bar-close',
  pricing: 'last-actually-available-round-until-ordered-transmission',
} as const);
export const GNOSIS_LEGACY_REFERENCE_IDENTITY = 'gnosis-reference:v1:ad484e3db350420d213a71f09bedc9d92d3da3e7e165ebe3e548635bfb10985b';
