/**
 * mapi-contexto.service — quién es el usuario que le escribe a Mapi.
 *
 * Antes el bot no recibía nada del usuario: ni rol, ni escuela, ni equipos.
 * Contestaba "si eres coach…" a una cuenta de escuela y le ofrecía "Registrar
 * un nuevo atleta" a un coach que quería renombrar su equipo (análisis
 * 2026-10-06). Con esto el prompt sabe a quién le habla y el mapa de la app
 * se recorta a los roles que el usuario realmente tiene.
 *
 * Todo es de solo lectura y falla en silencio: si una consulta se cae, el bot
 * sigue respondiendo con menos contexto en vez de no responder.
 */

import { supabase } from '../config/supabase';

export interface ContextoMapi {
    nombre: string | null;
    /** Claves del mapa de la app: school, coach, parent, athlete, … */
    roles: string[];
    /** Rol tal como lo ve el usuario, para el prompt. */
    rolesVisibles: string[];
    escuelaActiva: string | null;
    otrasEscuelas: string[];
    equiposQueEntrena: string[];
    modulosApagados: string[];
}

// school_members.role → clave del mapa. owner/admin/school_admin operan la
// escuela con el mismo menú que `school`.
const ROL_MIEMBRO: Record<string, string> = {
    owner: 'school',
    admin: 'school',
    school_admin: 'school',
    coach: 'coach',
    parent: 'parent',
    athlete: 'athlete',
    reporter: 'reporter',
};

const ROL_VISIBLE: Record<string, string> = {
    owner: 'dueño/administrador de la escuela',
    admin: 'administrador de la escuela',
    school_admin: 'administrador de la escuela',
    school: 'administrador de la escuela',
    coach: 'entrenador (coach)',
    parent: 'acudiente (padre/madre)',
    athlete: 'deportista',
    reporter: 'reportero',
    wellness_professional: 'profesional de bienestar',
    personal_trainer: 'entrenador personal',
    store_owner: 'dueño de tienda',
    external_vendor: 'proveedor',
    organizer: 'organizador de eventos',
};

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/**
 * Ids con los que un coach puede figurar en `teams.coach_id` y
 * `team_coaches.coach_id`: su perfil (cuentas viejas) y sus filas de
 * school_staff (coach_auth_id = perfil), que es lo que guarda hoy la app.
 * TeamsPage acepta las dos.
 */
export async function idsDeCoach(userId: string): Promise<string[]> {
    const { data: staff } = await supabase.from('school_staff').select('id').eq('coach_auth_id', userId);
    return uniq([userId, ...((staff as any[]) || []).map((s) => s.id)]);
}

export async function construirContextoMapi(userId: string, schoolId: string | null): Promise<ContextoMapi> {
    const ctx: ContextoMapi = {
        nombre: null,
        roles: [],
        rolesVisibles: [],
        escuelaActiva: null,
        otrasEscuelas: [],
        equiposQueEntrena: [],
        modulosApagados: [],
    };

    const [perfil, membresias] = await Promise.all([
        supabase.from('profiles').select('full_name, role').eq('id', userId).maybeSingle(),
        supabase.from('school_members').select('role, school_id, schools(name)').eq('profile_id', userId).eq('status', 'active'),
    ]).catch(() => [{ data: null }, { data: null }] as any[]);

    const p: any = perfil?.data;
    ctx.nombre = p?.full_name ?? null;

    const filas: any[] = Array.isArray(membresias?.data) ? membresias.data : [];
    // La escuela activa la decide la sesión (req.schoolId), nunca se adivina:
    // antes, sin escuela se tomaba «la primera» y a quien está en dos escuelas
    // le podía llegar contexto de la otra. Una escuela que no es suya tampoco
    // vale (defensa extra: el BFF entra con service_role y salta la RLS).
    const idActiva = schoolId && filas.some((m) => m.school_id === schoolId) ? schoolId : null;
    const enActiva = filas.filter((m) => m.school_id === idActiva);
    const nombreDe = (m: any) => (Array.isArray(m.schools) ? m.schools[0]?.name : m.schools?.name) ?? null;

    ctx.escuelaActiva = enActiva.map(nombreDe).find(Boolean) ?? null;
    ctx.otrasEscuelas = uniq(filas.filter((m) => m.school_id !== idActiva).map(nombreDe).filter(Boolean));

    // Los roles de la escuela activa mandan; el de profiles cubre a quien no
    // es miembro de ninguna (wellness, tienda, organizador…).
    const rolesCrudos = uniq([...enActiva.map((m) => String(m.role)), ...(enActiva.length ? [] : [String(p?.role ?? '')])])
        .filter(Boolean);
    ctx.roles = uniq(rolesCrudos.map((r) => ROL_MIEMBRO[r] ?? r));
    ctx.rolesVisibles = uniq(rolesCrudos.map((r) => ROL_VISIBLE[r] ?? r));

    const tareas: Promise<void>[] = [];

    if (ctx.roles.includes('coach') && idActiva) {
        tareas.push((async () => {
            const ids = await idsDeCoach(userId);
            const [{ data: directos }, { data: asignados }] = await Promise.all([
                // teams.coach_id guarda el id de school_staff (no el del perfil):
                // con .eq('coach_id', userId) Mapi le decía a Carlos Ramírez que
                // no tenía equipos teniendo Lightning y Thunder (2026-10-27).
                supabase.from('teams').select('name').eq('school_id', idActiva).in('coach_id', ids),
                supabase.from('team_coaches').select('teams(name)').eq('school_id', idActiva).in('coach_id', ids),
            ]);
            ctx.equiposQueEntrena = uniq([
                ...((directos as any[]) || []).map((t) => t.name),
                ...((asignados as any[]) || []).map((a) => (Array.isArray(a.teams) ? a.teams[0]?.name : a.teams?.name)),
            ].filter(Boolean)).slice(0, 15);
        })().catch(() => {}));
    }

    if (idActiva) {
        tareas.push((async () => {
            const { data } = await supabase
                .from('school_module_overrides')
                .select('module_key')
                .eq('school_id', idActiva)
                .eq('enabled', false);
            ctx.modulosApagados = ((data as any[]) || []).map((m) => m.module_key);
        })().catch(() => {}));
    }

    await Promise.all(tareas);
    return ctx;
}

/** Bloque de texto para el prompt de sistema. */
export function contextoComoTexto(ctx: ContextoMapi): string {
    const lineas = [
        `Nombre: ${ctx.nombre ?? '(sin nombre)'}`,
        `Rol: ${ctx.rolesVisibles.length ? ctx.rolesVisibles.join(' y ') : 'desconocido'}`,
        `Escuela activa: ${ctx.escuelaActiva ?? '(ninguna)'}`,
    ];
    if (ctx.otrasEscuelas.length) lineas.push(`También está en: ${ctx.otrasEscuelas.join(', ')}`);
    if (ctx.roles.includes('coach')) {
        lineas.push(`Equipos que entrena: ${ctx.equiposQueEntrena.length ? ctx.equiposQueEntrena.join(', ') : '(no tiene equipos asignados todavía)'}`);
    }
    if (ctx.modulosApagados.length) lineas.push(`Módulos APAGADOS en su escuela: ${ctx.modulosApagados.join(', ')}`);
    return lineas.join('\n');
}
