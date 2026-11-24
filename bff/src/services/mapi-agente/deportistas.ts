/**
 * Deportistas para el agente: la MISMA fuente que cartera y asistencia
 * (vista `school_athletes`: menores `child`, adultos `adult` y fichas sin
 * cuenta `unregistered`; una fila por inscripción).
 *
 * El BFF entra con service_role y salta la RLS: TODA lectura filtra por
 * `school_id = alcance.schoolId` a mano, y el coach además solo ve a los de
 * sus equipos (plan §7, paso 0). Un id de otra escuela responde «no lo
 * encontré», igual que uno que no existe.
 *
 * Lista permitida de columnas: la vista trae datos médicos y teléfonos de los
 * acudientes, que NUNCA se leen aquí (plan §12.1).
 */

import { supabase } from '../../config/supabase';
import { RechazoHerramienta, type Alcance } from './tipos';

export type TipoDeportista = 'child' | 'adult' | 'unregistered';

export interface Deportista {
    /** Lo que ve y devuelve el modelo: «child:<uuid>», «adult:<uuid>», «unregistered:<uuid>». */
    clave: string;
    tipo: TipoDeportista;
    id: string;
    nombre: string;
    equipos: { id: string; nombre: string | null }[];
    activo: boolean;
    /** Acudiente (menores). */
    parentId: string | null;
    /** Cuenta propia (adultos). */
    userId: string | null;
    plan: string | null;
    estadoInscripcion: string | null;
}

const COLUMNAS = 'id, full_name, athlete_type, team_id, enrolled_team_id, team_name, is_active, parent_id, user_id, plan_name, enrollment_status';
const TIPOS = new Set<TipoDeportista>(['child', 'adult', 'unregistered']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizar(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function parsearClave(s: unknown): { tipo: TipoDeportista; id: string } | null {
    if (typeof s !== 'string') return null;
    const [tipo, id] = s.trim().split(':');
    if (!TIPOS.has(tipo as TipoDeportista) || !UUID.test(id ?? '')) return null;
    return { tipo: tipo as TipoDeportista, id: id.toLowerCase() };
}

/**
 * Patrón ILIKE tolerante a tildes para la palabra más larga: cada vocal y la n
 * pasan a `_` («maria» → «m_r__») y el filtro fino se hace en JS. Así no se lee
 * la escuela entera en cada búsqueda.
 */
export function patronIlike(texto: string): string | null {
    const palabras = normalizar(texto).replace(/[^a-z\s]/g, ' ').split(' ').filter((p) => p.length >= 2);
    if (!palabras.length) return null;
    const larga = palabras.sort((a, b) => b.length - a.length)[0];
    return `%${larga.replace(/[aeioun]/g, '_')}%`;
}

/**
 * Apodos frecuentes → nombre completo probable. Solo se usan cuando la búsqueda
 * literal no encontró a nadie («majo» → «maria jose»). Evals 2026-11-24: el
 * modelo a veces preguntaba en vez de reintentar.
 */
const APODOS: Record<string, string[]> = {
    majo: ['maria jose'], mafe: ['maria fernanda'], malu: ['maria lucia'], mariajo: ['maria jose'],
    juanes: ['juan esteban'], juanpa: ['juan pablo'], juanjo: ['juan jose'], juancho: ['juan'],
    santi: ['santiago'], tomi: ['tomas'], nico: ['nicolas'], sebas: ['sebastian'], alejo: ['alejandro'],
    pipe: ['felipe'], mati: ['matias'], samu: ['samuel'], benja: ['benjamin'], emi: ['emiliano', 'emily'],
    vale: ['valentina', 'valeria'], dani: ['daniel', 'daniela'], cami: ['camila', 'camilo'], sofi: ['sofia'],
    isa: ['isabella', 'isabel'], gabi: ['gabriela', 'gabriel'], caro: ['carolina'], pao: ['paola'],
    manu: ['manuela', 'manuel'], anto: ['antonella', 'antonio'], fer: ['fernanda', 'fernando'],
};

/** Búsquedas alternativas para un texto con apodo (máximo 3). Pura. */
export function variantesDeApodo(texto: string): string[] {
    const palabras = normalizar(texto).replace(/[^a-z\s]/g, ' ').split(' ').filter(Boolean);
    const salida: string[] = [];
    palabras.forEach((p, i) => {
        for (const completo of APODOS[p] ?? []) {
            salida.push([...palabras.slice(0, i), completo, ...palabras.slice(i + 1)].join(' '));
        }
    });
    return [...new Set(salida)].slice(0, 3);
}

export function coincideNombre(nombre: string, texto: string): boolean {
    const n = normalizar(nombre);
    return normalizar(texto).replace(/[^a-z\s]/g, ' ').split(' ').filter((p) => p.length >= 2).every((p) => n.includes(p));
}

/** Agrupa las filas de la vista (una por inscripción) en un deportista por clave. */
export function agrupar(filas: any[]): Deportista[] {
    const porClave = new Map<string, Deportista>();
    for (const f of filas) {
        const tipo = f.athlete_type as TipoDeportista;
        if (!TIPOS.has(tipo) || !f.id) continue;
        const clave = `${tipo}:${f.id}`;
        const d: Deportista = porClave.get(clave) ?? {
            clave, tipo, id: f.id, nombre: String(f.full_name || 'Deportista sin nombre').trim(),
            equipos: [], activo: false, parentId: f.parent_id ?? null, userId: f.user_id ?? null,
            plan: f.plan_name ?? null, estadoInscripcion: f.enrollment_status ?? null,
        };
        d.activo = d.activo || f.is_active === true;
        // team_name es el nombre de team_id; el de enrolled_team_id se completa después.
        const sumar = (id: string | null | undefined, nombre: string | null) => {
            if (!id) return;
            const e = d.equipos.find((x) => x.id === id);
            if (!e) d.equipos.push({ id, nombre });
            else if (!e.nombre && nombre) e.nombre = nombre;
        };
        sumar(f.team_id, f.team_name ?? null);
        sumar(f.enrolled_team_id, f.enrolled_team_id === f.team_id ? (f.team_name ?? null) : null);
        d.plan ??= f.plan_name ?? null;
        d.estadoInscripcion ??= f.enrollment_status ?? null;
        porClave.set(clave, d);
    }
    return [...porClave.values()];
}

/** ¿Este alcance puede ver a este deportista? Admin: toda su escuela. Coach: sus equipos. */
export function visiblePara(a: Alcance, d: Deportista): boolean {
    if (a.rol === 'admin') return true;
    return d.equipos.some((e) => a.teamIds.includes(e.id));
}

export async function buscarEnEscuela(a: Alcance, texto: string): Promise<Deportista[]> {
    const patron = patronIlike(texto);
    if (!patron) return [];
    const { data, error } = await supabase.from('school_athletes').select(COLUMNAS)
        .eq('school_id', a.schoolId).ilike('full_name', patron).limit(400);
    if (error) throw new Error(error.message);
    return agrupar((data as any[]) ?? [])
        .filter((d) => coincideNombre(d.nombre, texto))
        .filter((d) => visiblePara(a, d));
}

/**
 * El deportista que nombró el modelo, validado contra la escuela de la sesión
 * y, si es coach, contra sus equipos. Lanza RechazoHerramienta si no aplica.
 */
export async function resolverDeportista(a: Alcance, clave: unknown): Promise<Deportista> {
    const p = parsearClave(clave);
    if (!p) throw new RechazoHerramienta('Ese identificador de deportista no es válido. Búscalo primero con buscar_deportista.');
    const { data, error } = await supabase.from('school_athletes').select(COLUMNAS)
        .eq('school_id', a.schoolId).eq('id', p.id).eq('athlete_type', p.tipo);
    if (error) throw new Error(error.message);
    const [d] = agrupar((data as any[]) ?? []);
    if (!d) throw new RechazoHerramienta('No encontré ese deportista en esta escuela.');
    if (!visiblePara(a, d)) throw new RechazoHerramienta('Ese deportista no está en los equipos que entrenas.');
    await completarNombresDeEquipo(a.schoolId, [d]);
    return d;
}

/** La vista solo trae el nombre del equipo de team_id; el de enrolled_team_id se completa aquí. */
export async function completarNombresDeEquipo(schoolId: string, ds: Deportista[]): Promise<void> {
    const faltan = [...new Set(ds.flatMap((d) => d.equipos.filter((e) => !e.nombre).map((e) => e.id)))];
    if (!faltan.length) return;
    const { data } = await supabase.from('teams').select('id, name').eq('school_id', schoolId).in('id', faltan);
    const nombres = new Map(((data as any[]) ?? []).map((t) => [t.id, t.name]));
    for (const d of ds) for (const e of d.equipos) e.nombre ??= nombres.get(e.id) ?? null;
}

/** Columna de las tablas de asistencia/avisos/cobros que identifica a este deportista. */
export function columnaDe(tipo: TipoDeportista): 'child_id' | 'user_id' | 'unregistered_athlete_id' {
    return tipo === 'child' ? 'child_id' : tipo === 'adult' ? 'user_id' : 'unregistered_athlete_id';
}
