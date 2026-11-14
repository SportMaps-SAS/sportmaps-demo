/**
 * Alcance de las escrituras biomecánicas del atleta (BFF, service role).
 *
 * El BFF escribe con SUPABASE_SERVICE_ROLE_KEY, así que salta RLS: las mismas
 * reglas que la migración 20261027124411_cierre_policies_autoadjudicables pone
 * en las policies (bag_athlete_insert, bc_athlete_insert) tienen que repetirse
 * aquí, o la ruta deja abierto lo que la base cerró.
 *
 *  - atletaPerteneceAEscuela  ≈ es_miembro_o_inscrito_de_escuela(school)
 *  - esStaffDeEscuela         ≈ es_staff_de_escuela(profile, school)
 *  - sesionEsDelAtleta        ≈ rama de sesión de puede_registrar_captura_biomecanica
 *
 * Reciben el cliente como parámetro para poder probarlas sin red.
 */

// Lo mínimo del cliente de supabase-js que usan estas funciones.
type Consulta = {
    select: (cols: string) => Consulta;
    eq: (col: string, val: unknown) => Consulta;
    not: (col: string, op: string, val: unknown) => Consulta;
    limit: (n: number) => Consulta;
    maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
};
export type ClienteAlcance = { from: (tabla: string) => unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

async function existe(db: ClienteAlcance, tabla: string, armar: (q: Consulta) => Consulta): Promise<boolean> {
    const base = (db.from(tabla) as Consulta).select('id');
    const { data, error } = await armar(base).limit(1).maybeSingle();
    if (error) throw error;
    return data != null;
}

/** El atleta es miembro activo de la escuela o tiene una inscripción activa propia en ella. */
export async function atletaPerteneceAEscuela(db: ClienteAlcance, athleteId: string, schoolId: string): Promise<boolean> {
    if (await existe(db, 'school_members', q => q.eq('profile_id', athleteId).eq('school_id', schoolId).eq('status', 'active'))) return true;
    return existe(db, 'enrollments', q => q.eq('user_id', athleteId).eq('school_id', schoolId).eq('status', 'active'));
}

/** El perfil TRABAJA en la escuela: miembro no parent/athlete/accountant, coach en school_staff, o dueño. */
export async function esStaffDeEscuela(db: ClienteAlcance, profileId: string, schoolId: string): Promise<boolean> {
    if (await existe(db, 'school_members', q => q
        .eq('profile_id', profileId).eq('school_id', schoolId).eq('status', 'active')
        .not('role', 'in', '(parent,athlete,accountant)'))) return true;
    if (await existe(db, 'school_staff', q => q.eq('coach_auth_id', profileId).eq('school_id', schoolId).eq('status', 'active'))) return true;
    return existe(db, 'schools', q => q.eq('id', schoolId).eq('owner_id', profileId));
}

/** La sesión es de esa escuela y está asignada a ese atleta. */
export async function sesionEsDelAtleta(db: ClienteAlcance, sessionPlanId: string, schoolId: string, athleteId: string): Promise<boolean> {
    return existe(db, 'trainer_session_plans', q => q.eq('id', sessionPlanId).eq('school_id', schoolId).eq('client_id', athleteId));
}

/**
 * Valida un grant atleta → coach. Devuelve null si es válido o el motivo
 * (para responder 400/403) si no.
 */
export async function validarGrantBiomecanico(
    db: ClienteAlcance, athleteId: string, coachId: unknown, schoolId: unknown,
): Promise<{ status: 400 | 403; error: string } | null> {
    if (!esUuid(coachId) || !esUuid(schoolId)) return { status: 400, error: 'coach_id y school_id deben ser UUID válidos.' };
    if (coachId === athleteId) return { status: 400, error: 'No puedes otorgarte acceso a ti mismo.' };
    if (!(await atletaPerteneceAEscuela(db, athleteId, schoolId))) {
        return { status: 403, error: 'Solo puedes otorgar acceso dentro de una escuela a la que perteneces.' };
    }
    if (!(await esStaffDeEscuela(db, coachId, schoolId))) {
        return { status: 403, error: 'El entrenador no trabaja en esa escuela.' };
    }
    return null;
}

/** Valida la escuela (y la sesión, si viene) de una captura del propio atleta. */
export async function validarCapturaBiomecanica(
    db: ClienteAlcance, athleteId: string, schoolId: unknown, sessionPlanId: unknown,
): Promise<{ status: 400 | 403; error: string } | null> {
    if (!esUuid(schoolId)) return { status: 400, error: 'school_id debe ser un UUID válido.' };
    if (sessionPlanId != null && !esUuid(sessionPlanId)) return { status: 400, error: 'session_plan_id debe ser un UUID válido.' };
    if (!(await atletaPerteneceAEscuela(db, athleteId, schoolId))) {
        return { status: 403, error: 'No perteneces a esa escuela.' };
    }
    if (sessionPlanId != null && !(await sesionEsDelAtleta(db, sessionPlanId as string, schoolId, athleteId))) {
        return { status: 403, error: 'Esa sesión no es tuya o no es de esa escuela.' };
    }
    return null;
}
