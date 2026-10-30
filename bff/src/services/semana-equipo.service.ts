/**
 * semana-equipo.service — la semana REAL de un equipo: el horario base
 * (`teams.schedule`) con los ajustes que el profe o la escuela cargaron en
 * `team_schedule_exceptions` (migración M1 del plan de Monster, 2026-10-30).
 *
 * POR QUÉ EXISTE
 * Hasta hoy el único horario era `teams.schedule`, que se repite igual cada
 * semana. Monster entrena en parques: si llueve o el profe no puede, el
 * entreno se cancela o se mueve, y el bot seguía ofreciendo la clase de prueba
 * de ese día y diciendo «hoy entrenan…». Un mismo cálculo PURO lo usan los
 * tres que leen el horario:
 *   · el generador de franjas (franjas-cortesia.service): no crea la franja de
 *     un día cancelado, crea la del entreno extra y la movida a su hora nueva;
 *   · «¿hay clase hoy?» (whatsapp-info-escuela.service `horariosDelDia`);
 *   · el bot al leer las franjas (red de seguridad entre una corrida del
 *     generador y la siguiente).
 *
 * QUÉ SIGNIFICA CADA AJUSTE (una fila por equipo + fecha)
 *   cancelada  hora_original NULL = todo el día; con hora = solo esa sesión.
 *   movida     la sesión de hora_original pasa a hora_inicio (y hora_fin /
 *              lugar si vienen; si no, conserva la duración y el lugar).
 *   extra      una sesión que no está en el horario base (hora_inicio…).
 * Un día cancelado entero cancela las sesiones del horario (también las
 * movidas), pero NO los extras: el extra lo agregó alguien a propósito. Un
 * extra a la misma hora de una sesión del horario la confirma (un festivo en
 * que sí se entrena): queda una sola sesión, marcada como extra.
 * Una «movida» cuya hora original ya no está en el horario base se ignora:
 * mandar a una familia a un entreno que no existe es el error caro.
 *
 * Sin la migración (tabla inexistente) todo esto devuelve el horario de hoy.
 */

import { supabase } from '../config/supabase';

export type TipoExcepcion = 'cancelada' | 'movida' | 'extra';

/** Fila de `team_schedule_exceptions` (las horas como las da la base, «HH:MM:SS»). */
export interface ExcepcionSemana {
    team_id?: string | null;
    fecha: string;                 // YYYY-MM-DD
    tipo: TipoExcepcion;
    hora_original?: string | null;
    hora_inicio?: string | null;
    hora_fin?: string | null;
    lugar?: string | null;
}

/** Una sesión de un día concreto, ya con los ajustes aplicados. */
export interface SesionDelDia {
    /** «HH:MM». */
    inicio: string;
    fin: string | null;
    lugar: string | null;
    /** Subgrupo del horario («Origen»); null en un entreno extra. */
    grupo: string | null;
    origen: 'horario' | 'movida' | 'extra';
    /** Hora del horario base que se movió (solo 'movida'). */
    horaOriginal: string | null;
}

/** «7:00», «07:00», «07:00:00» → «07:00». null si no es una hora. */
export function normalizarHora(h: unknown): string | null {
    const m = String(h ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!m) return null;
    const hh = Number(m[1]); const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const minutosDe = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const horaDe = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const texto = (v: unknown) => String(v ?? '').trim() || null;

/** Día de la semana de 'YYYY-MM-DD' (0 = domingo), igual que `teams.schedule[].day`. */
export function diaDeLaSemana(fecha: string): number {
    return new Date(Date.UTC(+fecha.slice(0, 4), +fecha.slice(5, 7) - 1, +fecha.slice(8, 10))).getUTCDay();
}

/** `teams.schedule` crudo (array o string JSON) → filas. [] si no se entiende. */
export function leerHorario(raw: unknown): any[] {
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}

/** Filas válidas del horario base (misma regla que el generador desde 2026-10-06). */
export function sesionesValidas(raw: unknown): any[] {
    return leerHorario(raw)
        .filter((f) => f && Number.isInteger(f.day) && f.day >= 0 && f.day <= 6 && normalizarHora(f.time));
}

/** Solo los ajustes de un equipo. */
export function excepcionesDelEquipo(excepciones: ExcepcionSemana[] | null | undefined, teamId: string): ExcepcionSemana[] {
    return (excepciones ?? []).filter((e) => e.team_id === teamId);
}

/**
 * Sesiones de UN equipo en UNA fecha: el horario base de ese día de la semana
 * con los ajustes aplicados. PURA. `excepciones` tienen que ser de ese equipo
 * (las de otra fecha se ignoran). Sin ajustes devuelve exactamente el horario
 * base, en su orden: es lo que garantiza que las escuelas sin ajustes ven lo
 * de siempre. Los extras van al final, por hora.
 */
export function sesionesDelDia(schedule: unknown, excepciones: ExcepcionSemana[] | null | undefined, fecha: string): SesionDelDia[] {
    const dia = fecha.slice(0, 10);
    const dow = diaDeLaSemana(dia);
    let sesiones: SesionDelDia[] = sesionesValidas(schedule)
        .filter((f) => f.day === dow)
        .map((f) => ({
            inicio: normalizarHora(f.time)!,
            fin: normalizarHora(f.end),
            lugar: texto(f.place),
            grupo: texto(f.group),
            origen: 'horario' as const,
            horaOriginal: null,
        }));

    const delDia = (excepciones ?? []).filter((e) => String(e?.fecha ?? '').slice(0, 10) === dia);
    if (!delDia.length) return sesiones;

    // 1. Canceladas: todo el día, o una sesión por su hora.
    if (delDia.some((e) => e.tipo === 'cancelada' && !normalizarHora(e.hora_original))) sesiones = [];
    const canceladas = new Set(delDia.filter((e) => e.tipo === 'cancelada')
        .map((e) => normalizarHora(e.hora_original)).filter(Boolean) as string[]);
    sesiones = sesiones.filter((s) => !canceladas.has(s.inicio));

    // 2. Movidas: la sesión de hora_original pasa a la hora nueva.
    for (const e of delDia.filter((x) => x.tipo === 'movida')) {
        const original = normalizarHora(e.hora_original);
        const inicio = normalizarHora(e.hora_inicio);
        if (!original || !inicio) continue;
        sesiones = sesiones.map((s) => {
            if (s.origen !== 'horario' || s.inicio !== original) return s;
            let fin = normalizarHora(e.hora_fin);
            if (!fin && s.fin && minutosDe(s.fin) > minutosDe(s.inicio)) {
                const nuevoFin = minutosDe(inicio) + (minutosDe(s.fin) - minutosDe(s.inicio));
                fin = nuevoFin < 24 * 60 ? horaDe(nuevoFin) : null;
            }
            return { ...s, inicio, fin, lugar: texto(e.lugar) ?? s.lugar, origen: 'movida', horaOriginal: original };
        });
    }

    // 3. Extras, sin duplicar una sesión que ya está a esa hora. Un extra a la
    //    hora de una sesión del horario la CONFIRMA (p. ej. «este festivo sí
    //    entrenamos»): esa sesión queda marcada como extra.
    const extras = delDia.filter((e) => e.tipo === 'extra')
        .map((e) => ({ e, inicio: normalizarHora(e.hora_inicio) }))
        .filter((x): x is { e: ExcepcionSemana; inicio: string } => !!x.inicio)
        .sort((a, b) => a.inicio.localeCompare(b.inicio));
    for (const { e, inicio } of extras) {
        const misma = sesiones.findIndex((s) => s.inicio === inicio);
        if (misma >= 0) {
            if (sesiones[misma].origen === 'horario') sesiones[misma] = { ...sesiones[misma], origen: 'extra' };
            continue;
        }
        sesiones.push({
            inicio, fin: normalizarHora(e.hora_fin), lugar: texto(e.lugar), grupo: null, origen: 'extra', horaOriginal: null,
        });
    }
    return sesiones;
}

/**
 * ¿Qué le pasó a la sesión del horario base de las `hora` de esa fecha? Para
 * revisar una franja ya creada (la red de seguridad del bot). PURA.
 *   null       → nada, sigue igual.
 *   cancelada  → no hay entreno a esa hora.
 *   movida     → se movió (puede ser a la misma hora con otro lugar).
 */
export function ajusteDeSesion(
    excepciones: ExcepcionSemana[] | null | undefined, fecha: string, hora: string,
): null | { tipo: 'cancelada' } | { tipo: 'movida'; inicio: string; fin: string | null; lugar: string | null } {
    const dia = fecha.slice(0, 10);
    const h = normalizarHora(hora);
    if (!h) return null;
    const delDia = (excepciones ?? []).filter((e) => String(e?.fecha ?? '').slice(0, 10) === dia);
    // Un extra a esa hora es un entreno que alguien agregó a propósito: vale
    // aunque el día se haya cancelado (mismo criterio que `sesionesDelDia`).
    if (delDia.some((e) => e.tipo === 'extra' && normalizarHora(e.hora_inicio) === h)) return null;
    if (delDia.some((e) => e.tipo === 'cancelada' && (!normalizarHora(e.hora_original) || normalizarHora(e.hora_original) === h))) {
        return { tipo: 'cancelada' };
    }
    const movida = delDia.find((e) => e.tipo === 'movida' && normalizarHora(e.hora_original) === h && normalizarHora(e.hora_inicio));
    if (movida) {
        return { tipo: 'movida', inicio: normalizarHora(movida.hora_inicio)!, fin: normalizarHora(movida.hora_fin), lugar: texto(movida.lugar) };
    }
    return null;
}

// ─── Supabase (cacheado) ───────────────────────────────────────────────────

export const TTL_EXCEPCIONES_MS = 10 * 60 * 1000;
const cache = new Map<string, { en: number; filas: ExcepcionSemana[] }>();

export function limpiarCacheSemana(): void {
    cache.clear();
}

/** 42P01 / PGRST205: la migración todavía no creó la tabla. */
function tablaNoExiste(error: any): boolean {
    return error?.code === '42P01' || error?.code === 'PGRST205'
        || /team_schedule_exceptions/.test(String(error?.message ?? ''));
}

/**
 * Ajustes de la semana de TODA la escuela entre `desde` y `hasta` (incluidos).
 * Cacheado 10 min: lo lee el bot en cada turno. `sinCache` lo usa el
 * generador, que corre justo después de que el profe cambia algo. Nunca lanza:
 * sin tabla o con error devuelve [] (= el horario de siempre).
 */
export async function excepcionesDeEscuela(
    schoolId: string, desde: string, hasta: string, opciones: { sinCache?: boolean; ahora?: number } = {},
): Promise<ExcepcionSemana[]> {
    const clave = `${schoolId}|${desde}|${hasta}`;
    const ahora = opciones.ahora ?? Date.now();
    const c = cache.get(clave);
    if (!opciones.sinCache && c && ahora - c.en < TTL_EXCEPCIONES_MS) return c.filas;
    try {
        const { data, error } = await supabase.from('team_schedule_exceptions')
            .select('team_id, fecha, tipo, hora_original, hora_inicio, hora_fin, lugar')
            .eq('school_id', schoolId)
            .gte('fecha', desde)
            .lte('fecha', hasta)
            .limit(2000);
        if (error) {
            // Sin la migración se recuerda el «no hay» (no se reintenta cada turno).
            if (tablaNoExiste(error)) guardar(clave, ahora, []);
            return [];
        }
        const filas = ((data ?? []) as any[])
            .filter((r) => r && ['cancelada', 'movida', 'extra'].includes(r.tipo) && /^\d{4}-\d{2}-\d{2}/.test(String(r.fecha ?? '')))
            .map((r): ExcepcionSemana => ({
                team_id: r.team_id ?? null,
                fecha: String(r.fecha).slice(0, 10),
                tipo: r.tipo,
                hora_original: r.hora_original ?? null,
                hora_inicio: r.hora_inicio ?? null,
                hora_fin: r.hora_fin ?? null,
                lugar: r.lugar ?? null,
            }));
        guardar(clave, ahora, filas);
        return filas;
    } catch {
        return [];
    }
}

function guardar(clave: string, en: number, filas: ExcepcionSemana[]): void {
    if (cache.size > 500) cache.clear();
    cache.set(clave, { en, filas });
}
