/**
 * whatsapp-personal-escuela — ¿el número que escribe es del PERSONAL (de la escuela o
 * de la plataforma)?
 *
 * Por qué existe (Monster 2026-11-08): un admin de SportMaps le escribió a Iván al
 * número del club y Mapi le contestó con el guion de prospecto; los profes (Santiago,
 * Tatiana…) quedaban como «desconocido» y a sus fotos se les preguntaba «¿De qué
 * deportista es este pago?». `wa_identify_staff_admin_by_phone` solo reconoce
 * owner/admin/school_admin. Esto suma, con UNA consulta por escuela (cacheada) y una
 * global para la plataforma:
 *   · owner / admin / school_admin / coach activos de la escuela
 *     (`school_members` → `profiles.phone`);
 *   · admins de plataforma (`profiles.role` en admin/super_admin, y
 *     `platform_admins` activos).
 * El personal se clasifica como `staff` (whatsapp-atencion): el bot no le habla y sus
 * adjuntos no se tratan como de una familia (solo owner/admin siguen la rama de alta
 * por foto de matrícula). Familia gana: un profe que además es acudiente se atiende
 * como familia (la clasificación por teléfono va primero).
 *
 * Los teléfonos se comparan por los 10 dígitos del celular colombiano (como
 * `wa_celular_remitente_co`); un fijo o un número extranjero no cruza. Nunca lanza.
 */
import { supabase } from '../config/supabase';

export type RolDePersonal = 'admin' | 'coach' | 'plataforma';

const TTL_MS = 10 * 60_000;
const ROLES_ADMIN = new Set(['owner', 'admin', 'school_admin']);

/** «+57 319 450 5150», «573194505150», «3194505150» → «3194505150»; null si no es un celular colombiano. Pura. */
export function celular10(tel: string | null | undefined): string | null {
    const d = String(tel ?? '').replace(/\D/g, '');
    const m = /^(?:57)?(3\d{9})$/.exec(d);
    return m ? m[1] : null;
}

/** Del más fuerte al más débil: si un número tiene dos roles, gana admin. Pura. */
function masFuerte(a: RolDePersonal | undefined, b: RolDePersonal): RolDePersonal {
    const peso: Record<RolDePersonal, number> = { admin: 3, plataforma: 2, coach: 1 };
    return a && peso[a] >= peso[b] ? a : b;
}

/** Arma el mapa celular → rol con las filas de la escuela y los teléfonos de la plataforma. Pura. */
export function mapaDePersonal(
    miembros: { role?: string | null; phone?: string | null }[],
    plataforma: (string | null | undefined)[],
): Map<string, RolDePersonal> {
    const mapa = new Map<string, RolDePersonal>();
    for (const m of miembros) {
        const t = celular10(m.phone);
        if (!t) continue;
        const rol: RolDePersonal | null = ROLES_ADMIN.has(String(m.role)) ? 'admin' : m.role === 'coach' ? 'coach' : null;
        if (rol) mapa.set(t, masFuerte(mapa.get(t), rol));
    }
    for (const p of plataforma) {
        const t = celular10(p);
        if (t) mapa.set(t, masFuerte(mapa.get(t), 'plataforma'));
    }
    return mapa;
}

const telefonoDe = (perfil: unknown): string | null => {
    const p = Array.isArray(perfil) ? perfil[0] : perfil;
    return p && typeof p === 'object' ? ((p as any).phone ?? null) : null;
};

let plataforma: { en: number; tels: Promise<string[]> } | null = null;
const porEscuela = new Map<string, { en: number; mapa: Promise<Map<string, RolDePersonal>> }>();

/** Los teléfonos de los admins de la plataforma (global, cacheado). Ante un error, ninguno. */
function telefonosDePlataforma(ahora: number): Promise<string[]> {
    if (plataforma && ahora - plataforma.en < TTL_MS) return plataforma.tels;
    const tels = (async () => {
        const [porRol, tabla] = await Promise.all([
            supabase.from('profiles').select('phone').in('role', ['admin', 'super_admin']).not('phone', 'is', null).limit(200),
            supabase.from('platform_admins').select('profile:profiles(phone)').eq('is_active', true).limit(200),
        ]);
        return [
            ...(((porRol as any)?.data ?? []) as any[]).map((p) => p?.phone ?? null),
            ...(((tabla as any)?.data ?? []) as any[]).map((f) => telefonoDe(f?.profile)),
        ].filter((t): t is string => typeof t === 'string' && t.length > 0);
    })().catch(() => {
        plataforma = null;
        return [] as string[];
    });
    plataforma = { en: ahora, tels };
    return tels;
}

/** El personal de una escuela (owner/admin/school_admin/coach activos + la plataforma): UNA consulta por escuela, cacheada. */
function personalDeEscuela(schoolId: string, ahora: number): Promise<Map<string, RolDePersonal>> {
    const previa = porEscuela.get(schoolId);
    if (previa && ahora - previa.en < TTL_MS) return previa.mapa;
    const mapa = (async () => {
        const [miembros, deLaPlataforma] = await Promise.all([
            supabase.from('school_members').select('role, profile:profiles(phone)')
                .eq('school_id', schoolId).eq('status', 'active')
                .in('role', ['owner', 'admin', 'school_admin', 'coach']).limit(500),
            telefonosDePlataforma(ahora),
        ]);
        if ((miembros as any)?.error) throw new Error(String((miembros as any).error.message ?? 'school_members'));
        const filas = (((miembros as any)?.data ?? []) as any[]).map((m) => ({ role: m?.role ?? null, phone: telefonoDe(m?.profile) }));
        return mapaDePersonal(filas, deLaPlataforma);
    })().catch(() => {
        porEscuela.delete(schoolId);
        return new Map<string, RolDePersonal>();
    });
    porEscuela.set(schoolId, { en: ahora, mapa });
    return mapa;
}

/**
 * ¿Este número es del personal de la escuela o de la plataforma? 'admin' (owner,
 * admin, school_admin), 'coach' o 'plataforma'; null si no (o si no se pudo leer).
 * Nunca lanza.
 */
export async function rolDePersonal(schoolId: string, waPhone: string, ahora = Date.now()): Promise<RolDePersonal | null> {
    try {
        const t = celular10(waPhone);
        if (!t || !schoolId) return null;
        return (await personalDeEscuela(schoolId, ahora)).get(t) ?? null;
    } catch {
        return null;
    }
}

/** Para pruebas: olvida lo cacheado. */
export function _olvidarPersonal(): void {
    plataforma = null;
    porEscuela.clear();
}
