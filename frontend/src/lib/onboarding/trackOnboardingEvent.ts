import { supabase } from '@/integrations/supabase/client';
import { trackOnboarding, type OnboardingEvent } from './onboardingTracking';

/**
 * Envía un evento del asistente a la RPC track_onboarding_event. Nunca lanza ni
 * espera: si la RPC aún no existe en la base (migración sin aplicar) o la red
 * falla, la pantalla sigue igual.
 */
export function track(evt: OnboardingEvent): void {
  trackOnboarding(
    (args) => (supabase.rpc as unknown as (fn: string, a: unknown) => PromiseLike<unknown>)('track_onboarding_event', args),
    evt,
  );
}
