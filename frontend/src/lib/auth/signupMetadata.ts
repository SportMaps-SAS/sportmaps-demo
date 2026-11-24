// ============================================================================
// Metadata que viaja en supabase.auth.signUp (raw_user_meta_data).
//
// Vivía como objeto literal dentro de AuthContext.signUp con 6 campos fijos, y
// todo lo demás que armaba RegisterPage se perdía en silencio. Así se descartó
// el deporte principal de la academia: campo obligatorio en el registro que
// nunca llegó a la base (docs/onboarding/registros-19-22-nov-2026-y-tutorial-
// guiado.md, hallazgo A).
//
// Dos límites a propósito:
//  - `suggested_categories` NO se envía. user_metadata viaja dentro del JWT en
//    cada petición; una lista de categorías lo engordaría para todos los usos.
//    Con `sport_name` basta para derivarlas cuando haga falta.
//  - `referral_code` y `school_type` tampoco: hoy no llegan y encenderlos cambia
//    comportamiento (referidos, tipo de escuela) que no es de este arreglo.
// ============================================================================

export interface SignupUserData {
  full_name?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  role?: string | null;
  invitation_code?: string | null;
  school_name?: string | null;
  sport_id?: string | number | null;
  sport_name?: string | null;
  whatsapp_consent?: boolean | null;
  // RegisterPage arma más campos; se ignoran acá (ver arriba).
  [extra: string]: unknown;
}

const MAX_SPORT_NAME = 80;

// Quien abre una cuenta para operar un negocio (academia, club, organizador) puede
// aceptar avisos por WhatsApp sobre su cuenta. La casilla nace SIN marcar y solo
// viaja cuando la persona la marcó: el consentimiento es explícito.
const ROLES_CON_CONSENTIMIENTO = new Set(['school', 'facility_manager', 'organizer']);

export function buildSignupMetadata(userData: SignupUserData): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    full_name: userData.full_name,
    phone: userData.phone,
    date_of_birth: userData.date_of_birth,
    role: userData.role,
    invitation_code: userData.invitation_code,
    school_name: userData.school_name,
  };

  if (userData.whatsapp_consent === true && ROLES_CON_CONSENTIMIENTO.has(String(userData.role))) {
    metadata.whatsapp_consent = true;
  }

  // El deporte solo tiene sentido para quien crea una academia.
  if (userData.role === 'school') {
    const sportName = typeof userData.sport_name === 'string' ? userData.sport_name.trim() : '';
    if (sportName && sportName.length <= MAX_SPORT_NAME) {
      metadata.sport_name = sportName;
      if (typeof userData.sport_id === 'string' || typeof userData.sport_id === 'number') {
        metadata.sport_id = userData.sport_id;
      }
    }
  }

  return metadata;
}

/**
 * Deporte con el que el asistente precarga «Primer equipo», para no volver a
 * preguntar lo que ya se pidió en el registro. Manda lo guardado en la escuela;
 * el metadata de la sesión cubre el rato en que la migración aún no está viva.
 * Solo devuelve un valor que exista en el catálogo del selector.
 */
export function resolveSignupSport(args: {
  schoolSports?: string[] | null;
  metadataSport?: unknown;
  catalog: readonly string[];
}): string {
  const candidatos = [
    ...(Array.isArray(args.schoolSports) ? args.schoolSports : []),
    typeof args.metadataSport === 'string' ? args.metadataSport : '',
  ];
  for (const c of candidatos) {
    const limpio = (c || '').trim().toLowerCase();
    if (!limpio) continue;
    const match = args.catalog.find((s) => s.trim().toLowerCase() === limpio);
    if (match) return match;
  }
  return '';
}
