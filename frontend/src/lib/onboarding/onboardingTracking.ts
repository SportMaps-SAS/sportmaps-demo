// ============================================================================
// Tracking del asistente de onboarding → analytics_events, vía la RPC
// track_onboarding_event (migración 20261123090000).
//
// Cuatro eventos, uno por ACCIÓN del usuario. Nunca por render ni por scroll:
//   onboarding_step_viewed     el paso se muestra (una vez por paso y sesión)
//   onboarding_step_completed  el paso se guardó bien
//   onboarding_step_skipped    el usuario pulsó «Saltar»
//   onboarding_finished        terminó el asistente (how: 'complete' | 'later')
//
// Los otros seis eventos del embudo (signup_completed, first_plan_created,
// first_athlete_created, first_charge_created, payment_method_configured,
// whatsapp_connected) los emite la base con triggers, para cubrir todos los
// caminos que crean esos registros y no depender de que cada pantalla se acuerde.
//
// Reglas: no lleva datos personales (solo ids de paso y banderas), y NUNCA debe
// romper ni demorar la pantalla: toda falla se traga.
// ============================================================================

export type OnboardingFlow = 'school' | 'venue' | 'parent';
export type OnboardingEventType =
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_step_skipped'
  | 'onboarding_finished';

export interface OnboardingEvent {
  type: OnboardingEventType;
  flow: OnboardingFlow;
  /** Id corto del paso ('branch', 'plan', 'datos'…). Vacío en onboarding_finished. */
  step?: string;
  /** Solo banderas y números pequeños. */
  extra?: Record<string, string | number | boolean>;
}

export type OnboardingSender = (args: {
  p_event_type: string;
  p_flow: string;
  p_step: string | null;
  p_extra: Record<string, string | number | boolean>;
}) => PromiseLike<unknown>;

const STEP_RE = /^[a-z0-9_]{1,40}$/;
const vistos = new Set<string>();

/** Solo para pruebas. */
export function _reiniciarVistos() {
  vistos.clear();
}

export function buildOnboardingRpcArgs(evt: OnboardingEvent) {
  const step = evt.step && STEP_RE.test(evt.step) ? evt.step : null;
  const extra: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(evt.extra ?? {})) {
    if (!/^[a-z_]{1,30}$/.test(k)) continue;
    if (typeof v === 'string') extra[k] = v.slice(0, 40);
    else if (typeof v === 'number' || typeof v === 'boolean') extra[k] = v;
  }
  return { p_event_type: evt.type, p_flow: evt.flow, p_step: step, p_extra: extra };
}

/** Devuelve true si se mandó (o se intentó); false si se omitió por repetido o por paso inválido. */
export function trackOnboarding(send: OnboardingSender, evt: OnboardingEvent): boolean {
  try {
    if (evt.type !== 'onboarding_finished' && !(evt.step && STEP_RE.test(evt.step))) return false;
    if (evt.type === 'onboarding_step_viewed') {
      const clave = `${evt.flow}:${evt.step}`;
      if (vistos.has(clave)) return false;
      vistos.add(clave);
    }
    Promise.resolve(send(buildOnboardingRpcArgs(evt))).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
