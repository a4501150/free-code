/**
 * Subscription switch notifications were backed by a removed persistent counter.
 * Keep this hook as a no-op so callers don't show a recurring nag.
 */
export function useCanSwitchToExistingSubscription(): void {}
