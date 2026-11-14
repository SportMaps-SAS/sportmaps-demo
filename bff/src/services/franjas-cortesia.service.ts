/**
 * Franjas de clase de cortesía generadas desde los ENTRENAMIENTOS reales.
 *
 * POR QUÉ EXISTE
 *
 * El bot de WhatsApp agenda la clase de cortesía con las franjas de
 * `school_trial_slots` (ver whatsapp-clase-cortesia.service.ts). Esas franjas
 * hasta hoy se cargaban a mano y Dynasty no tiene ninguna futura: el bot solo
 * puede ofrecer «déjame tus datos». Decisión del usuario (2026-10-06): la
 * clase de cortesía es ir a un entrenamiento real del grupo, así que las
 * franjas salen de `teams.schedule` — todos los grupos con horario cargado, y
 * sin límite de cupos (el prospecto se suma al entrenamiento, no ocupa una
 * plaza aparte).
 *
 * QUÉ HACE
 *
 *   · Para cada equipo activo con horario, una franja por cada sesión semanal
 *     de las próximas N semanas (default 3): fecha, hora inicio/fin, sede
 *     (= `place`), label = nombre del grupo (+ subgrupo si lo tiene), team_id.
 *   · Idempotente: la clave es (team_id, slot_date, start_time). Lee lo que ya
 *     existe antes de insertar y, para las carreras entre los 3 BFF, el índice
 *     único de la migración 20261006084303 hace que el segundo reciba 23505.
 *   · Cierra (is_open=false, NUNCA borra) las franjas que ÉL generó y que ya no
 *     corresponden a ningún entrenamiento (horario cambiado, grupo cerrado o
 *     dado de baja), siempre que no tengan reservas. Una familia que ya
 *     reservó tiene que ver su clase; eso se le avisa a la escuela por reporte.
 *
 * DECISIONES (y por qué)
 *
 *   · `day` sigue la convención de JS (0 = domingo … 6 = sábado), la misma que
 *     `describirEntrenamiento` en whatsapp-info-escuela.service.ts.
 *   · Se excluyen los equipos «NO USAR» (Dynasty tiene uno activo) y los que la
 *     escuela marcó `admite_nuevos = false`: ofrecerle a un prospecto la
 *     clase de un grupo que no recibe nuevos es prometer un cupo que no hay.
 *   · FESTIVOS: no se crean franjas en festivos de Colombia. Muchas escuelas no
 *     entrenan ese día (los coliseos cierran) y el error caro es mandar a una
 *     familia a un entrenamiento que no ocurre; perder una franja de ~40 por
 *     semana no le cuesta nada a nadie. Se puede forzar con `incluirFestivos`.
 *   · Sin límite de cupos: `max_capacity` es NOT NULL con CHECK > 0, así que
 *     va un valor alto (CUPOS_SIN_LIMITE). El bot no muestra «999 cupos»: ver
 *     `esSinLimite`.
 *   · Inserta con service_role directo a la tabla: `create_school_trial_slot`
 *     exige el JWT de un admin y este proceso no tiene uno. Por eso se repite
 *     aquí la misma validación de esa RPC (label no vacío, fecha ≥ hoy) y
 *     `created_by` = owner de la escuela, que es quien «publica» la franja.
 *
 * AJUSTES POR ESCUELA (migración M1, Monster 2026-10-30). Sin ellos, el plan es
 * idéntico al de antes (prueba con el horario de Dynasty):
 *
 *   · Semana del profe (`team_schedule_exceptions`, semana-equipo.service):
 *     un día cancelado no tiene franja, la sesión movida va a su hora nueva y
 *     el entreno extra tiene la suya — también en festivo: alguien lo agregó
 *     a propósito.
 *   · `school_trial_class_settings.dias_semana` (0 = domingo … 6 = sábado):
 *     solo esos días. Monster: sábado y domingo.
 *   · `cupos_por_sesion`: el cupo de cada franja nueva, y el de las abiertas
 *     que ya existen si sus reservas caben (CHECK reserved_count ≤ max_capacity).
 *     NULL = sin límite, y las existentes no se tocan.
 *   · `teams.recibe_clase_prueba = false`: el equipo no tiene franjas.
 *   · Al cerrar una obsoleta se anota `cerrada_por = 'horario'`; solo esas se
 *     reabren si la sesión vuelve (el profe deshace la cancelación). Las que
 *     cerró la escuela, o las cerradas antes de la migración (NULL), nunca.
 *   · `soloEquipo`: sincroniza un equipo (lo pide «Mi semana» al guardar).
 */

import { supabase } from '../config/supabase';
import { esFestivoColombia } from '../utils/festivos-colombia';
import {
    excepcionesDeEscuela, excepcionesDelEquipo, normalizarHora, sesionesDelDia, sesionesValidas, type ExcepcionSemana,
} from './semana-equipo.service';

export { normalizarHora };

/**
 * «Sin límite» de cupos. `max_capacity` no admite NULL ni 0, así que se usa un
 * número que ningún entrenamiento alcanza. Cualquier franja con al menos la
 * mitad de esto disponible se muestra como «cupos disponibles», sin número.
 */
export const CUPOS_SIN_LIMITE = 999;
export const SEMANAS_POR_DEFECTO = 3;

/** ¿Este número de cupos es el «sin límite» y no debe mostrarse como cifra? */
export function esSinLimite(cupos: number): boolean {
    return cupos >= CUPOS_SIN_LIMITE / 2;
}

/** Misma regla que whatsapp-info-escuela.service.ts: la escuela lo marcó así. */
const MARCADO_NO_USAR = /\bno\s+usar\b/i;

export interface EquipoParaFranjas {
    id: string;
    name: string | null;
    active?: boolean | null;
    admite_nuevos?: boolean | null;
    /** Mig. M1; ausente o null = recibe (como antes). */
    recibe_clase_prueba?: boolean | null;
    schedule: unknown;
}

export interface FranjaPlaneada {
    team_id: string;
    /** Nombre del equipo, para el reporte (el label puede llevar subgrupo). */
    equipo: string;
    label: string;
    slot_date: string;   // YYYY-MM-DD
    start_time: string;  // HH:MM
    end_time: string | null;
    location: string | null;
}

export interface FranjaExistente {
    id: string;
    team_id: string | null;
    slot_date: string;
    start_time: string;
    reserved_count: number;
    is_open: boolean;
    generated_from_schedule?: boolean | null;
    max_capacity?: number | null;
    /** Mig. M1: 'escuela' | 'horario' | null (cerrada antes de la migración o abierta). */
    cerrada_por?: string | null;
}

export interface PlanDeFranjas {
    franjas: FranjaPlaneada[];
    festivosOmitidos: { fecha: string; label: string }[];
    excluidos: { equipo: string; motivo: string }[];
    /** Dos sesiones del mismo equipo, mismo día y misma hora (subgrupos): se deja una. */
    choques: { fecha: string; hora: string; labels: string[] }[];
}

const DIA_MS = 86_400_000;
const diaUTC = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const isoDe = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Fecha de hoy en Colombia: las franjas se fechan en hora local. */
export function hoyBogota(ahora = new Date()): string {
    return ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

export const claveFranja = (teamId: string, fecha: string, hora: string) =>
    `${teamId}|${fecha.slice(0, 10)}|${normalizarHora(hora) ?? hora}`;

export interface OpcionesPlan {
    incluirFestivos?: boolean;
    /** Ajustes de la semana de la escuela (se filtran por equipo). [] o ausente = horario base. */
    excepciones?: ExcepcionSemana[] | null;
    /** Días con clase de prueba (0 = domingo … 6 = sábado). null o vacío = todos. */
    diasSemana?: number[] | null;
}

/** `dias_semana` válido (enteros 0–6, sin repetir) o null = todos los días. Pura. */
export function diasSemanaValidos(raw: unknown): number[] | null {
    if (!Array.isArray(raw)) return null;
    const dias = [...new Set(raw.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
    return dias.length ? dias : null;
}

/**
 * Plan PURO (sin base): qué franjas deberían existir en la ventana
 * [desde, desde + 7·semanas). No mira lo que ya hay: eso es `compararConExistentes`.
 */
export function planificarFranjas(
    equipos: EquipoParaFranjas[],
    desde: string,
    semanas = SEMANAS_POR_DEFECTO,
    opciones: OpcionesPlan = {},
): PlanDeFranjas {
    const plan: PlanDeFranjas = { franjas: [], festivosOmitidos: [], excluidos: [], choques: [] };
    const dias = Math.max(1, Math.floor(semanas)) * 7;
    const inicio = diaUTC(desde);
    const diasSemana = diasSemanaValidos(opciones.diasSemana);

    for (const t of equipos) {
        const nombre = String(t.name ?? '').trim();
        if (!nombre) continue;
        if (t.active === false) { plan.excluidos.push({ equipo: nombre, motivo: 'inactivo' }); continue; }
        if (MARCADO_NO_USAR.test(nombre)) { plan.excluidos.push({ equipo: nombre, motivo: 'marcado NO USAR' }); continue; }
        if (t.admite_nuevos === false) { plan.excluidos.push({ equipo: nombre, motivo: 'no admite nuevos' }); continue; }
        if (t.recibe_clase_prueba === false) { plan.excluidos.push({ equipo: nombre, motivo: 'no recibe clase de prueba' }); continue; }

        const excepciones = excepcionesDelEquipo(opciones.excepciones, t.id);
        const conExtras = excepciones.some((e) => e.tipo === 'extra');
        if (!sesionesValidas(t.schedule).length && !conExtras) {
            plan.excluidos.push({ equipo: nombre, motivo: 'sin horario cargado' });
            continue;
        }

        const vistas = new Map<string, FranjaPlaneada>();
        for (let i = 0; i < dias; i++) {
            const fecha = isoDe(inicio + i * DIA_MS);
            const dow = new Date(inicio + i * DIA_MS).getUTCDay();
            if (diasSemana && !diasSemana.includes(dow)) continue;
            for (const s of sesionesDelDia(t.schedule, excepciones, fecha)) {
                // El subgrupo va en el label: Dynasty divide «INTERMEDIO» en
                // Origen y Evolución con horarios y sedes distintas; sin él, la
                // familia no sabe a cuál de los dos va.
                const label = s.grupo ? `${nombre} · ${s.grupo}` : nombre;
                const hora = s.inicio;
                // El festivo se salta salvo el entreno extra: ese lo agregó el
                // profe para ese día, sabiendo que es festivo.
                if (!opciones.incluirFestivos && s.origen !== 'extra' && esFestivoColombia(fecha)) {
                    plan.festivosOmitidos.push({ fecha, label });
                    continue;
                }
                const clave = claveFranja(t.id, fecha, hora);
                const previa = vistas.get(clave);
                if (previa) {
                    // Dos subgrupos a la misma hora el mismo día: la clave única
                    // de la base es (team_id, fecha, hora), así que cabe una sola
                    // franja. Se deja la primera y se reporta.
                    plan.choques.push({ fecha, hora, labels: [previa.label, label] });
                    continue;
                }
                const franja: FranjaPlaneada = {
                    team_id: t.id,
                    equipo: nombre,
                    label,
                    slot_date: fecha,
                    start_time: hora,
                    end_time: s.fin,
                    location: s.lugar,
                };
                vistas.set(clave, franja);
                plan.franjas.push(franja);
            }
        }
    }

    plan.franjas.sort((a, b) => (a.slot_date + a.start_time + a.label).localeCompare(b.slot_date + b.start_time + b.label));
    return plan;
}

/**
 * Qué crear y qué cerrar, contra lo que ya está en la base.
 *
 *   crear   = planeadas cuya clave no existe (abierta o cerrada: si la escuela
 *             cerró una a mano, no se reabre ni se duplica).
 *   cerrar  = generadas por este servicio, abiertas, futuras dentro de la
 *             ventana, SIN reservas, que ya no están en el plan.
 *   conservadasConReserva = las mismas pero con reservas: no se tocan.
 *   reabrir = generadas, CERRADAS POR EL HORARIO (`cerrada_por = 'horario'`),
 *             que vuelven a estar en el plan (el profe deshizo la cancelación).
 *             Las que cerró la escuela o las de antes de la migración, nunca.
 *   ajustarCupo = con `cupos` (cupos_por_sesion): generadas, abiertas (o por
 *             reabrir) y planeadas cuyo max_capacity no es ese, si sus
 *             reservas caben (CHECK reserved_count ≤ max_capacity). Sin
 *             `cupos` no se toca ninguna (como antes).
 */
export function compararConExistentes(
    plan: FranjaPlaneada[],
    existentes: FranjaExistente[],
    ventana: { desde: string; hasta: string },
    opciones: { cupos?: number | null } = {},
): {
    crear: FranjaPlaneada[]; yaExistian: number; cerrar: FranjaExistente[]; conservadasConReserva: FranjaExistente[];
    reabrir: FranjaExistente[]; ajustarCupo: FranjaExistente[];
} {
    const hay = new Set(existentes.filter((e) => e.team_id)
        .map((e) => claveFranja(e.team_id!, e.slot_date, e.start_time)));
    const planeadas = new Set(plan.map((p) => claveFranja(p.team_id, p.slot_date, p.start_time)));
    const enVentana = (e: FranjaExistente) => e.slot_date.slice(0, 10) >= ventana.desde && e.slot_date.slice(0, 10) < ventana.hasta;
    const planeada = (e: FranjaExistente) => !!e.team_id && planeadas.has(claveFranja(e.team_id, e.slot_date, e.start_time));

    const crear = plan.filter((p) => !hay.has(claveFranja(p.team_id, p.slot_date, p.start_time)));
    const obsoletas = existentes.filter((e) =>
        e.generated_from_schedule === true && e.is_open && e.team_id && enVentana(e) && !planeada(e));
    const reabrir = existentes.filter((e) =>
        e.generated_from_schedule === true && !e.is_open && e.cerrada_por === 'horario' && enVentana(e) && planeada(e));
    const cupos = opciones.cupos != null && Number.isInteger(opciones.cupos) && opciones.cupos > 0 ? opciones.cupos : null;
    const ajustarCupo = cupos == null ? [] : existentes.filter((e) =>
        e.generated_from_schedule === true && (e.is_open || reabrir.includes(e)) && enVentana(e) && planeada(e)
        && e.max_capacity != null && Number(e.max_capacity) !== cupos && (e.reserved_count ?? 0) <= cupos);

    return {
        crear,
        yaExistian: plan.length - crear.length,
        cerrar: obsoletas.filter((e) => (e.reserved_count ?? 0) === 0),
        conservadasConReserva: obsoletas.filter((e) => (e.reserved_count ?? 0) > 0),
        reabrir,
        ajustarCupo,
    };
}

/**
 * Fila lista para insertar. Repite la validación de `create_school_trial_slot`.
 * `cupos` = cupos_por_sesion de la escuela; sin él, sin límite (como antes).
 */
export function filaParaInsertar(f: FranjaPlaneada, schoolId: string, ownerId: string | null, hoy: string, cupos?: number | null) {
    const label = f.label.trim();
    if (!label) throw new Error('Label requerido');
    if (f.slot_date < hoy) throw new Error('La fecha debe ser futura');
    return {
        school_id: schoolId,
        team_id: f.team_id,
        label,
        slot_date: f.slot_date,
        start_time: f.start_time,
        end_time: f.end_time,
        location: f.location,
        max_capacity: cupos != null && Number.isInteger(cupos) && cupos > 0 ? cupos : CUPOS_SIN_LIMITE,
        is_open: true,
        created_by: ownerId,
        generated_from_schedule: true,
    };
}

export interface ReporteFranjas {
    schoolId: string;
    escuela: string;
    aplicado: boolean;
    ventana: { desde: string; hasta: string };
    plan: PlanDeFranjas;
    creadas: number;
    yaExistian: number;
    /** Insert que chocó con el índice único (otro BFF ganó la carrera). */
    duplicadasEnCarrera: number;
    cerradas: number;
    /** Cerradas por el horario que volvieron (sin aplicar: «se reabrirían»). */
    reabiertas: number;
    /** Franjas abiertas a las que se les puso `cupos_por_sesion`. */
    cuposAjustados: number;
    conservadasConReserva: { id: string; label?: string; slot_date: string; start_time: string }[];
    errores: string[];
    /** Lo que se crearía/creó, para el reporte por grupo. */
    nuevas: FranjaPlaneada[];
}

const esDuplicado = (e: any) => e?.code === '23505' || /duplicate key/i.test(String(e?.message ?? ''));

/**
 * `cupos_por_sesion` y `dias_semana` de la escuela (migración M1). Sin las
 * columnas, sin fila o con error → null los dos (= como antes). Nunca lanza.
 */
export async function ajustesDelGenerador(schoolId: string): Promise<{ cupos: number | null; diasSemana: number[] | null }> {
    try {
        const { data, error } = await supabase.from('school_trial_class_settings')
            .select('cupos_por_sesion, dias_semana').eq('school_id', schoolId).maybeSingle();
        if (error || !data) return { cupos: null, diasSemana: null };
        const cupos = Number((data as any).cupos_por_sesion);
        return {
            cupos: Number.isInteger(cupos) && cupos > 0 ? cupos : null,
            diasSemana: diasSemanaValidos((data as any).dias_semana),
        };
    } catch {
        return { cupos: null, diasSemana: null };
    }
}

/**
 * Sincroniza la ventana rodante de una escuela. Sin `aplicar` no escribe nada
 * (simulación). Nunca lanza por errores de la base: los devuelve en `errores`.
 * `soloEquipo`: solo las franjas de ese equipo (las demás ni se leen ni se
 * tocan) — lo pide «Mi semana» después de que el profe ajusta su semana.
 */
export async function sincronizarFranjasDeEscuela(
    schoolId: string,
    opciones: { semanas?: number; aplicar?: boolean; incluirFestivos?: boolean; hoy?: string; soloEquipo?: string | null } = {},
): Promise<ReporteFranjas> {
    const semanas = opciones.semanas ?? SEMANAS_POR_DEFECTO;
    const hoy = opciones.hoy ?? hoyBogota();
    const hasta = isoDe(diaUTC(hoy) + semanas * 7 * DIA_MS);
    const soloEquipo = opciones.soloEquipo || null;
    const reporte: ReporteFranjas = {
        schoolId, escuela: schoolId, aplicado: !!opciones.aplicar, ventana: { desde: hoy, hasta },
        plan: { franjas: [], festivosOmitidos: [], excluidos: [], choques: [] },
        creadas: 0, yaExistian: 0, duplicadasEnCarrera: 0, cerradas: 0, reabiertas: 0, cuposAjustados: 0,
        conservadasConReserva: [], errores: [], nuevas: [],
    };

    // `recibe_clase_prueba` llega con la migración M1: sin ella, todos reciben.
    const leerEquipos = (columnas: string) => {
        let q = supabase.from('teams').select(columnas).eq('school_id', schoolId);
        if (soloEquipo) q = q.eq('id', soloEquipo);
        return q.limit(500);
    };
    const [escuela, equiposConColumna, ajustes, excepciones] = await Promise.all([
        supabase.from('schools').select('name, owner_id').eq('id', schoolId).maybeSingle(),
        leerEquipos('id, name, active, admite_nuevos, schedule, recibe_clase_prueba'),
        ajustesDelGenerador(schoolId),
        // Sin caché: corre justo después de que el profe cambió su semana.
        excepcionesDeEscuela(schoolId, hoy, hasta, { sinCache: true }),
    ]);
    let equipos: any = equiposConColumna;
    if (equipos.error && /recibe_clase_prueba/.test(String(equipos.error.message ?? ''))) {
        equipos = await leerEquipos('id, name, active, admite_nuevos, schedule');
    }
    if (escuela.error || !escuela.data) {
        reporte.errores.push(`escuela: ${escuela.error?.message ?? 'no existe'}`);
        return reporte;
    }
    if (equipos.error) {
        reporte.errores.push(`equipos: ${equipos.error.message}`);
        return reporte;
    }
    reporte.escuela = (escuela.data as any).name ?? schoolId;
    const ownerId: string | null = (escuela.data as any).owner_id ?? null;

    reporte.plan = planificarFranjas((equipos.data ?? []) as EquipoParaFranjas[], hoy, semanas,
        { incluirFestivos: opciones.incluirFestivos, excepciones, diasSemana: ajustes.diasSemana });

    // `generated_from_schedule` llega con la migración 20261006084303 y
    // `cerrada_por` con M1. Si faltan se lee sin ellas: la simulación sirve
    // igual; sin `generated_from_schedule` ninguna franja figura como generada
    // (no se cierra nada por error) y sin `cerrada_por` no se reabre ninguna.
    const leerExistentes = (columnas: string) => {
        let q = supabase.from('school_trial_slots').select(columnas).eq('school_id', schoolId).gte('slot_date', hoy);
        if (soloEquipo) q = q.eq('team_id', soloEquipo);
        return q.limit(5000);
    };
    const BASE = 'id, team_id, label, slot_date, start_time, reserved_count, is_open';
    let existentes: any = await leerExistentes(`${BASE}, generated_from_schedule, max_capacity, cerrada_por`);
    let conCerradaPor = true;
    if (existentes.error && /cerrada_por/.test(String(existentes.error.message ?? ''))) {
        conCerradaPor = false;
        existentes = await leerExistentes(`${BASE}, generated_from_schedule, max_capacity`);
    }
    let sinMigracion = false;
    if (existentes.error && /generated_from_schedule/.test(String(existentes.error.message ?? ''))) {
        sinMigracion = true;
        existentes = await leerExistentes(BASE);
    }
    if (existentes.error) {
        reporte.errores.push(`franjas existentes: ${existentes.error.message}`);
        return reporte;
    }

    const filas = (existentes.data ?? []) as any[];
    const cmp = compararConExistentes(reporte.plan.franjas, filas as FranjaExistente[], reporte.ventana,
        { cupos: ajustes.cupos });
    reporte.yaExistian = cmp.yaExistian;
    reporte.nuevas = cmp.crear;
    reporte.conservadasConReserva = cmp.conservadasConReserva.map((e: any) => ({
        id: e.id, label: e.label, slot_date: e.slot_date, start_time: e.start_time,
    }));

    if (!opciones.aplicar) {
        // «se cerrarían / se reabrirían / se ajustarían»
        reporte.cerradas = cmp.cerrar.length;
        reporte.reabiertas = cmp.reabrir.length;
        reporte.cuposAjustados = cmp.ajustarCupo.length;
        return reporte;
    }
    if (sinMigracion) {
        reporte.errores.push('falta aplicar la migración 20261006084303 (generated_from_schedule + índice único): no se escribe nada');
        return reporte;
    }

    // Insert por lotes; si un lote choca con el índice único (otro BFF metió
    // alguna en el medio), ese lote se reintenta fila por fila para no perder
    // las que sí faltan.
    const LOTE = 100;
    for (let i = 0; i < cmp.crear.length; i += LOTE) {
        const lote = cmp.crear.slice(i, i + LOTE);
        let filasLote: ReturnType<typeof filaParaInsertar>[];
        try {
            filasLote = lote.map((f) => filaParaInsertar(f, schoolId, ownerId, hoy, ajustes.cupos));
        } catch (e: any) {
            reporte.errores.push(`validación: ${e?.message}`);
            continue;
        }
        const { error } = await supabase.from('school_trial_slots').insert(filasLote);
        if (!error) { reporte.creadas += filasLote.length; continue; }
        if (!esDuplicado(error)) { reporte.errores.push(`insertar: ${error.message}`); continue; }
        for (const fila of filasLote) {
            const r = await supabase.from('school_trial_slots').insert(fila);
            if (!r.error) reporte.creadas++;
            else if (esDuplicado(r.error)) reporte.duplicadasEnCarrera++;
            else reporte.errores.push(`insertar ${fila.label} ${fila.slot_date} ${fila.start_time}: ${r.error.message}`);
        }
    }

    if (cmp.cerrar.length) {
        // El filtro reserved_count = 0 se repite en el UPDATE: si alguien
        // reservó entre la lectura y ahora, esa franja NO se cierra. Con M1 se
        // anota que la cerró el horario: así se puede reabrir si vuelve.
        const { data, error } = await supabase.from('school_trial_slots')
            .update(conCerradaPor ? { is_open: false, cerrada_por: 'horario' } : { is_open: false })
            .in('id', cmp.cerrar.map((e) => e.id))
            .eq('generated_from_schedule', true)
            .eq('reserved_count', 0)
            .select('id');
        if (error) reporte.errores.push(`cerrar obsoletas: ${error.message}`);
        else reporte.cerradas = (data ?? []).length;
    }

    if (conCerradaPor && cmp.reabrir.length) {
        // Solo las que cerró el horario: los filtros se repiten en el UPDATE.
        const { data, error } = await supabase.from('school_trial_slots')
            .update({ is_open: true, cerrada_por: null })
            .in('id', cmp.reabrir.map((e) => e.id))
            .eq('generated_from_schedule', true)
            .eq('cerrada_por', 'horario')
            .eq('is_open', false)
            .select('id');
        if (error) reporte.errores.push(`reabrir: ${error.message}`);
        else reporte.reabiertas = (data ?? []).length;
    }

    if (ajustes.cupos != null && cmp.ajustarCupo.length) {
        // reserved_count ≤ cupos se repite en el UPDATE (CHECK de la tabla, y
        // una reserva que entre entre la lectura y ahora).
        const { data, error } = await supabase.from('school_trial_slots')
            .update({ max_capacity: ajustes.cupos })
            .in('id', cmp.ajustarCupo.map((e) => e.id))
            .eq('generated_from_schedule', true)
            .lte('reserved_count', ajustes.cupos)
            .select('id');
        if (error) reporte.errores.push(`ajustar cupos: ${error.message}`);
        else reporte.cuposAjustados = (data ?? []).length;
    }

    return reporte;
}

/**
 * Job diario: mantiene la ventana rodante en las escuelas con la opción
 * activa. Lo corren los 3 BFF a la misma hora; es seguro por el índice único
 * (23505 = otro ya la creó) y porque cerrar es idempotente.
 */
export async function runFranjasCortesia(): Promise<{ escuelas: number; creadas: number; cerradas: number; errores: number }> {
    const total = { escuelas: 0, creadas: 0, cerradas: 0, errores: 0 };
    const { data, error } = await supabase.from('school_settings')
        .select('school_id').eq('courtesy_from_training', true).limit(1000);
    if (error) {
        // 42703 = la columna todavía no existe (migración sin aplicar). No es
        // una falla del job: simplemente no hay nada que hacer aún.
        if ((error as any).code === '42703' || /courtesy_from_training/.test(error.message)) {
            console.log('[franjas-cortesia] migración 20261006084303 sin aplicar: no hay escuelas con la opción.');
        } else {
            console.error('[franjas-cortesia] no se pudo leer school_settings:', error.message);
            total.errores++;
        }
        return total;
    }
    for (const fila of (data ?? []) as any[]) {
        try {
            const r = await sincronizarFranjasDeEscuela(fila.school_id, { aplicar: true });
            total.escuelas++;
            total.creadas += r.creadas;
            total.cerradas += r.cerradas;
            total.errores += r.errores.length;
            if (r.errores.length) console.warn('[franjas-cortesia]', r.escuela, r.errores);
            if (r.conservadasConReserva.length) {
                console.warn(`[franjas-cortesia] ${r.escuela}: ${r.conservadasConReserva.length} franja(s) con reserva ya no coinciden con el horario; quedan abiertas para no dejar plantada a la familia.`);
            }
        } catch (e: any) {
            total.errores++;
            console.error('[franjas-cortesia] escuela', fila.school_id, e?.message ?? e);
        }
    }
    return total;
}
