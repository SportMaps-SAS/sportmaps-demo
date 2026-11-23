// ============================================================================
// Reglas del asistente y del checklist de la academia, sin React, para poder
// probarlas. La fuente de los datos es la RPC get_onboarding_status().
//
// Compatibilidad: las claves `branch_confirmed` y `has_charges` llegan con la
// migración 20261123084254. Mientras no esté aplicada vienen `undefined` y cada
// regla cae al comportamiento anterior, para que el frontend se pueda desplegar
// antes o después de la base sin romper nada.
// ============================================================================

export type SchoolWizardStepId = 'branch' | 'model' | 'team' | 'plan' | 'coach' | 'student' | 'payments';

export interface SchoolOnboardingStatusLike {
  has_branches?: boolean | null;
  branch_confirmed?: boolean | null;
  has_teams?: boolean | null;
  has_plans?: boolean | null;
  has_staff?: boolean | null;
  has_students?: boolean | null;
  payment_setup_completed?: boolean | null;
  has_charges?: boolean | null;
}

/**
 * ¿La sede está confirmada? Antes se usaba `has_branches`, que es true desde que
 * nace la escuela (un trigger crea la «Sede Principal»): el paso «Tu sede» nunca
 * se mostraba y ninguna academia nueva quedaba con dirección (hallazgo B).
 */
export function isBranchConfirmed(status: SchoolOnboardingStatusLike): boolean {
  if (typeof status.branch_confirmed === 'boolean') return status.branch_confirmed;
  return !!status.has_branches;
}

export function isSchoolWizardStepDone(id: SchoolWizardStepId, status: SchoolOnboardingStatusLike): boolean {
  switch (id) {
    case 'branch':   return isBranchConfirmed(status);
    // «Modelo» solo cuenta como hecho cuando ya hay un equipo o un plan: el
    // valor de schools.business_model puede venir de un default.
    case 'model':    return !!status.has_teams || !!status.has_plans;
    case 'team':     return !!status.has_teams;
    case 'plan':     return !!status.has_plans;
    case 'coach':    return !!status.has_staff;
    case 'student':  return !!status.has_students;
    case 'payments': return !!status.payment_setup_completed;
    default:         return false;
  }
}

/**
 * Checklist del panel para la academia (hallazgo E). Estaba condicionado a
 * `onboarding_status !== 'completed'`, y como el asistente bloquea el panel
 * hasta quedar en `completed`, el dueño nunca lo veía.
 *
 * Ahora acompaña a la academia DESPUÉS del asistente y hasta su primer cobro.
 * Se exige `has_charges === false` explícito: si la clave no llega (migración
 * sin aplicar) no se muestra, para no ponerle una tarjeta de «configura tu
 * cuenta» a escuelas que llevan meses operando.
 */
export function shouldShowSchoolChecklist(args: {
  onboardingStatus: string | null | undefined;
  steps: ReadonlyArray<{ completed: boolean }>;
  hasCharges: boolean | null | undefined;
}): boolean {
  if (args.onboardingStatus !== 'completed') return false; // antes de eso manda el asistente
  if (args.steps.length === 0) return false;
  if (args.steps.every((s) => s.completed)) return false;
  return args.hasCharges === false;
}
