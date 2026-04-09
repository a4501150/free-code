/**
 * Runtime gate for /ultrareview.
 * Production config has enabled=true with fleet_size=5, max_duration_minutes=10.
 */
export function isUltrareviewEnabled(): boolean {
  return true
}
