import { useEntitlements } from '@/hooks/useEntitlements';

/** Flag `school_settings.live_match_enabled`. Alias fino de useEntitlements().liveMatchEnabled. */
export function useLiveMatchEnabled(): boolean {
  return useEntitlements().liveMatchEnabled;
}
