/**
 * alcance — quién habla, en qué escuela y qué puede tocar (plan §7, paso 0:
 * «tenant primero»).
 *
 * Reglas:
 *   · La escuela es la ACTIVA de la sesión: el `x-school-id` que manda el
 *     front, ya validado contra school_members por requireAuth. Si el front no
 *     lo mandó, requireAuth toma «la última membresía»: eso NO vale para el
 *     agente (sería adivinar), así que sin header no hay modo agente.
 *   · Nunca la escuela del ticket (support_tickets.school_id es informativa),
 *     nunca la que diga el mensaje o el modelo.
 *   · Admin = owner/admin/school_admin en esa escuela. Coach = coach en esa
 *     escuela (con sus equipos). Cualquier otro rol sigue en modo soporte.
 *   · El modo agente se prende por escuela (school_settings.mapi_agent_enabled)
 *     y se apaga para todas con MAPI_AGENT_ENABLED=false, sin desplegar.
 */

import { supabase } from '../../config/supabase';
import { idsDeCoach } from '../mapi-contexto.service';
import { fechaColombia } from '../avisos-correo.service';
import type { Alcance, RolAgente } from './tipos';

const ROLES_ADMIN = new Set(['owner', 'admin', 'school_admin']);

export function agenteApagadoGlobal(): boolean {
    return process.env.MAPI_AGENT_ENABLED === 'false';
}

/** Rol del agente según las membresías activas en la escuela. null = sin modo agente. */
export function rolDeMembresias(roles: string[]): RolAgente | null {
    if (roles.some((r) => ROLES_ADMIN.has(r))) return 'admin';
    if (roles.includes('coach')) return 'coach';
    return null;
}

/** Equipos de la escuela que entrena el coach (teams.coach_id y team_coaches; ver idsDeCoach). */
export async function equiposDelCoach(userId: string, schoolId: string): Promise<string[]> {
    const ids = await idsDeCoach(userId);
    const [{ data: directos }, { data: asignados }] = await Promise.all([
        supabase.from('teams').select('id').eq('school_id', schoolId).in('coach_id', ids),
        supabase.from('team_coaches').select('team_id').eq('school_id', schoolId).in('coach_id', ids),
    ]);
    return [...new Set([
        ...((directos as any[]) ?? []).map((t) => t.id as string),
        ...((asignados as any[]) ?? []).map((t) => t.team_id as string),
    ].filter(Boolean))];
}

export interface EntradaAlcance {
    userId: string;
    /** req.schoolId (ya validado por requireAuth). */
    schoolId: string | null | undefined;
    /** El header x-school-id tal como llegó: tiene que coincidir con schoolId. */
    headerSchoolId: string | null | undefined;
    /** req.role: el super admin de plataforma no usa el agente en esta fase. */
    rolSesion?: string | null;
    /** req.headers.authorization: para las RPC que autorizan con auth.uid(). */
    authorization?: string | null;
    ahora?: Date;
}

/**
 * Arma el alcance del turno, o null si esta persona en esta escuela no tiene
 * modo agente (y entonces Mapi responde en modo soporte, como hoy).
 */
export async function alcanceDelTurno(e: EntradaAlcance): Promise<Alcance | null> {
    if (agenteApagadoGlobal()) return null;
    if (!e.schoolId || !e.headerSchoolId || e.headerSchoolId !== e.schoolId) return null;
    if (e.rolSesion === 'super_admin') return null;

    const [{ data: miembros }, { data: ajustes, error: errAjustes }] = await Promise.all([
        supabase.from('school_members').select('role')
            .eq('profile_id', e.userId).eq('school_id', e.schoolId).eq('status', 'active'),
        supabase.from('school_settings')
            .select('mapi_agent_enabled, coach_mapi_attendance, coach_mapi_notices, coach_hide_financial_info')
            .eq('school_id', e.schoolId).maybeSingle(),
    ]);
    // Sin la migración 20261123115649 la columna no existe: error → sin agente.
    if (errAjustes || !(ajustes as any)?.mapi_agent_enabled) return null;

    const rol = rolDeMembresias(((miembros as any[]) ?? []).map((m) => String(m.role)));
    if (!rol) return null;

    const s = ajustes as any;
    const alcance: Alcance = {
        schoolId: e.schoolId,
        userId: e.userId,
        rol,
        teamIds: rol === 'coach' ? await equiposDelCoach(e.userId, e.schoolId) : [],
        ajustes: {
            coachMapiAttendance: s.coach_mapi_attendance !== false,
            coachMapiNotices: s.coach_mapi_notices !== false,
            coachHideFinancialInfo: s.coach_hide_financial_info === true,
        },
        hoy: fechaColombia(e.ahora ?? new Date()),
    };
    // El token va NO enumerable: un log o un JSON.stringify del alcance no lo filtra.
    Object.defineProperty(alcance, 'authorization', {
        value: typeof e.authorization === 'string' && e.authorization.trim() ? e.authorization : null,
        enumerable: false,
        writable: false,
    });
    return alcance;
}
