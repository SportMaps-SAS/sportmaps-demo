/**
 * Lo que el bot SÍ sabe de la escuela, y —más importante— lo que NO.
 *
 * POR QUÉ EXISTE
 *
 * De las 110 preguntas de la batería de QA, unas 30 son sobre la escuela:
 * dónde queda, qué sedes tiene, qué categorías hay, a qué hora entrenan. Hoy el
 * bot no tiene NINGUNA herramienta para eso, así que las escala todas — 4 de
 * cada 5 preguntas terminan en la bandeja de la escuela.
 *
 * Lo bueno de medirlo primero: la batería dio **cero invenciones**. El bot no
 * se inventa un horario, dice que no lo tiene. Esta herramienta no viene a
 * arreglar un invento, viene a que deje de derivar lo que sí puede contestar.
 *
 * LO QUE HAY, MEDIDO EL 2026-09-22 (no supuesto)
 *
 *   sedes           1-2 por escuela, con nombre           → SÍ
 *   ciudad          Dynasty y Monster's; Besser/GYM no    → a veces
 *   dirección       Dynasty y Monster's                   → a veces
 *   equipos         todas las escuelas, con nombre        → SÍ
 *   categorías      SOLO Monster's (13)                   → casi nunca
 *   horarios        CERO en las cuatro escuelas           → NO
 *   edades          age_min/birth_year_min NULL en TODAS  → NO
 *
 * HORARIOS, RE-MEDIDO EL 2026-10-04 (ver `inferirHorarioDeSesiones`)
 *
 *   teams.schedule      25 equipos activos en toda la base; Dynasty 9 de 11.
 *                       UN SOLO formato real: array de {day,time,end,place?,
 *                       group?}; `describirEntrenamiento` los entiende todos.
 *   attendance_sessions la única fuente de sesiones que PASARON. 59 equipos
 *                       con alguna; pero solo 66 filas con hora en 60 días y
 *                       ninguna de un equipo sin schedule que repita hora →
 *                       de acá sale casi siempre el DÍA, rara vez la hora.
 *   training_sessions / training_microcycle_days
 *                       planificación (periodización), no asistencia real;
 *                       incluye sesiones futuras. NO se usa: lo planeado no
 *                       prueba que se entrene ahí.
 *   calendar_events     trainings sueltos (0 equipos repiten 3 de 4 semanas)
 *                       y partidos/competencias. NO se usa.
 *   classes, training_slots, school_trial_slots, school_availability
 *                       vacías para equipos. NO se usan.
 *   coach_/facility_availability
 *                       disponibilidad de coach/cancha para clases sueltas,
 *                       no está atada a un equipo. NO se usa.
 *
 * Por eso el contrato de este servicio es devolver SOLO lo que está lleno y
 * decir explícitamente qué falta. El campo `no_disponible` no es cosmético: es
 * lo que el prompt usa para que el modelo diga «eso no lo tengo» en vez de
 * deducirlo del nombre del equipo.
 *
 * NO SE DEDUCE NADA. «U15 FEMENINO» sugiere sub-15, y es tentador traducirlo a
 * «para niñas de 14 y 15 años». No se hace: la convención varía por federación
 * y por año, y una respuesta con la edad equivocada manda a una familia a la
 * categoría que no es. El nombre se devuelve tal cual y que lo interprete quien
 * sepa.
 */

import { supabase } from '../config/supabase';
import { atencionPresencialDeEscuela } from './whatsapp-ajustes-escuela.service';
import { excepcionesDeEscuela, sesionesDelDia, type ExcepcionSemana, type SesionDelDia } from './semana-equipo.service';

export interface InfoDeEscuela {
    nombre: string;
    ciudad: string | null;
    direccion: string | null;
    sedes: string[];
    /** Deportes que aparecen en los equipos, sin repetir. */
    deportes: string[];
    /** Nombre de cada grupo/equipo, tal como lo escribió la escuela. */
    grupos: {
        nombre: string;
        /**
         * Dónde entrena. Prioridad: lugares del horario cargado (Dynasty rota
         * entre canchas) > instalación > `teams.location` > sede del equipo.
         */
        sede: string | null;
        horario: string | null;
        /**
         * 'cargado'  = lo escribió la escuela en el equipo (fiable).
         * 'inferido' = deducido de las asistencias de las últimas 4 semanas;
         *              el bot lo dice con cautela («según las últimas sesiones»).
         * null       = no hay horario.
         */
        horario_fuente: 'cargado' | 'inferido' | null;
        /** false = no recibe atletas nuevos. Los inscritos siguen igual. */
        admite_nuevos: boolean;
        /** Qué decirle a quien pregunte por un grupo cerrado. */
        nota_admision: string | null;
    }[];
    /** Categorías formales, cuando la escuela las cargó. */
    categorias: { nombre: string; rama: string | null }[];
    /** Horario de ATENCIÓN (no de entrenamiento), si está configurado. */
    horario_atencion: string | null;
    /**
     * Dónde y cuándo atiende la escuela EN PERSONA (pagos, trámites), tal como
     * lo escribió la escuela (school_settings.wa_atencion_presencial). Es lo que
     * se contesta a «dónde pago / hasta qué hora atienden / atención
     * presencial». null = no configurado: no se inventa.
     */
    atencion_presencial: string | null;
    /**
     * Qué NO se puede responder con estos datos. El prompt lo usa para que el
     * modelo lo diga en vez de deducirlo.
     */
    no_disponible: string[];
}

const vacio = (v: unknown) => String(v ?? '').trim() === '';

const DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * «[{day:2,time:"16:00",end:"18:00",place:"Coliseo"}]» →
 * «martes 16:00 a 18:00 (Coliseo)»
 *
 * Se formatea acá y no se le pasa el JSON crudo al modelo: leyendo `day: 2` el
 * modelo tiene que acordarse de que 0 es domingo, y si se equivoca le dice a la
 * familia el día que no es. Traducirlo en codigo no falla nunca.
 *
 * `place` es de Dynasty y el formato original no lo tenía: sus grupos rotan
 * entre tres sedes DENTRO de la misma semana. Si viene, se dice.
 */
export function describirEntrenamiento(raw: unknown): string | null {
    let franjas: any[];
    try {
        franjas = typeof raw === 'string' ? JSON.parse(raw) : (raw as any[]);
    } catch { return null; }
    if (!Array.isArray(franjas) || !franjas.length) return null;

    const util = franjas.filter((f) => f && typeof f.day === 'number' && f.time);
    if (!util.length) return null;

    const franja = (f: any) => {
        const hasta = f.end ? ` a ${f.end}` : '';
        const donde = f.place ? ` (${f.place})` : '';
        return `${DIA[f.day] ?? ''} ${f.time}${hasta}${donde}`.trim();
    };

    // Algunos equipos tienen SUBGRUPOS que el sistema no modela como equipos
    // aparte: Dynasty divide «Intermedio» en Origen y Evolución, con horarios y
    // sedes distintas, y en la base hay un solo equipo con 106 atletas. Si se
    // listan las franjas mezcladas, el papá lee nueve dias y no sabe cuales son
    // los de su hijo. Agrupadas, elige — porque el SI sabe en cual esta.
    const grupos = [...new Set(util.map((f: any) => f.group).filter(Boolean))];
    if (grupos.length > 1) {
        return grupos
            .map((g) => `${g}: ${util.filter((f: any) => f.group === g).map(franja).join(' · ')}`)
            .join(' || ');
    }

    return util.map(franja).join(' · ');
}

/** Lugares distintos que aparecen en las franjas del horario cargado. */
function lugaresDelHorario(raw: unknown): string[] {
    let franjas: any[];
    try {
        franjas = typeof raw === 'string' ? JSON.parse(raw) : (raw as any[]);
    } catch { return []; }
    if (!Array.isArray(franjas)) return [];
    return [...new Set(franjas.map((f) => String(f?.place ?? '').trim()).filter(Boolean))];
}

/**
 * Dónde entrena un grupo, de la fuente más específica a la más general.
 *
 * 1. Lugares del horario cargado. Dynasty tiene el equipo en la sede «Coliseo
 *    Dynasty», pero el domingo varios grupos entrenan en Asoalsacia: si se
 *    contestara con la sede del equipo, la familia va al coliseo un domingo.
 * 2. Instalación (`facility_id`) — 28 equipos la tienen.
 * 3. `teams.location`, texto libre de la escuela.
 * 4. Sede del equipo (`branch_id`, 145 de 153 equipos activos), con dirección
 *    si la tiene: es lo que más sirve para «dónde queda».
 */
export function resolverSede(t: {
    schedule?: unknown;
    location?: unknown;
    facility?: { name?: string | null } | null;
    branch?: { name?: string | null; address?: string | null } | null;
}): string | null {
    const lugares = lugaresDelHorario(t.schedule);
    if (lugares.length) return lugares.join(' / ');
    if (!vacio(t.facility?.name)) return String(t.facility!.name).trim();
    if (!vacio(t.location)) return String(t.location).trim();
    if (!vacio(t.branch?.name)) {
        const nombre = String(t.branch!.name).trim();
        return vacio(t.branch?.address) ? nombre : `${nombre} (${String(t.branch!.address).trim()})`;
    }
    return null;
}

/** Fila mínima de `attendance_sessions` para inferir el patrón semanal. */
export interface SesionPasada {
    session_date: string;        // 'YYYY-MM-DD'
    start_time?: string | null;  // 'HH:MM:SS'
    end_time?: string | null;
}

/** Ventana y umbrales de la inferencia. Ver justificación abajo. */
export const INFERENCIA = {
    /** Bloques de 7 días hacia atrás desde hoy. */
    semanas: 4,
    /** En cuántos de esos bloques tiene que repetirse el día (y la hora). */
    minSemanas: 3,
    /** Qué parte de las fechas de la ventana tiene que caer en el patrón. */
    minCobertura: 0.75,
} as const;

/** Semana deportiva: lunes primero, domingo al final. */
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];

const diaUTC = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Fecha de hoy en Colombia ('YYYY-MM-DD'): las sesiones se fechan en hora local. */
export function hoyEnBogota(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/**
 * Horario REGULAR deducido de las asistencias que efectivamente se tomaron.
 *
 * Solo se usa cuando el equipo no tiene `teams.schedule`. Lo que se mira son
 * sesiones que PASARON (attendance_sessions con fecha ≤ hoy), no planes.
 *
 * UMBRAL — un día de la semana entra al patrón si hubo sesión ese día en al
 * menos 3 de los últimos 4 bloques de 7 días:
 *   · 4 de 4 es demasiado estricto: un festivo en lunes (Colombia tiene ~10 al
 *     año), una lluvia o un coach que no tomó lista tumba un patrón real.
 *   · 2 de 4 es ruido: medido el 2026-10-04, los equipos de Besser tienen
 *     sesiones en 5-7 días distintos de la semana en 28 días (planillas de
 *     papel cargadas con fechas corridas, reposiciones) y con 2 de 4 saldrían
 *     «lunes a sábado», que es falso.
 * Y además el patrón tiene que explicar ≥75 % de las fechas de la ventana.
 * Sin esa segunda regla, a Besser «INFANTIL FEMENINO» (15 sesiones en los 7
 * días) le saldría «martes, jueves y viernes», que cubre 9 de 15 (60 %): el
 * patrón existe pero el equipo no lo sigue, y mandar a una familia un día
 * suelto es peor que decir «no lo tengo». Con las dos reglas pasan los cuatro
 * equipos de Carmel que entrenan sábado y domingo (7/7, 7/8, 7/8, 7/7) y no
 * pasa ninguno de Besser (43-60 %).
 *
 * HORA — se agrega a un día solo si la MISMA hora de inicio se repite en ≥3
 * de los 4 bloques ese día. Hoy casi ninguna sesión trae hora (66 filas con
 * hora en 60 días en toda la base), así que lo normal es que salga solo el
 * día y el texto lo diga: «la hora no está registrada».
 *
 * El texto lleva la cautela adentro («según las últimas sesiones
 * registradas») para que también la lea el fallback sin modelo.
 */
export function inferirHorarioDeSesiones(sesiones: SesionPasada[], hoy: string): string | null {
    const hoyMs = diaUTC(hoy);
    const DIA_MS = 86_400_000;

    // Una entrada por (fecha, hora): dos sesiones el mismo día y a la misma
    // hora son la misma clase registrada dos veces.
    const vistas = new Set<string>();
    const filas: { bloque: number; dow: number; fecha: string; inicio: string | null; fin: string | null }[] = [];
    for (const s of sesiones) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(String(s?.session_date ?? ''))) continue;
        const fecha = s.session_date.slice(0, 10);
        const atras = Math.round((hoyMs - diaUTC(fecha)) / DIA_MS);
        if (atras < 0 || atras >= INFERENCIA.semanas * 7) continue;
        const inicio = s.start_time ? String(s.start_time).slice(0, 5) : null;
        const clave = `${fecha}|${inicio ?? ''}`;
        if (vistas.has(clave)) continue;
        vistas.add(clave);
        filas.push({
            bloque: Math.floor(atras / 7),
            dow: new Date(diaUTC(fecha)).getUTCDay(),
            fecha,
            inicio,
            fin: s.end_time ? String(s.end_time).slice(0, 5) : null,
        });
    }
    if (!filas.length) return null;

    const diasDelPatron = ORDEN_SEMANA.filter((d) =>
        new Set(filas.filter((f) => f.dow === d).map((f) => f.bloque)).size >= INFERENCIA.minSemanas);
    if (!diasDelPatron.length) return null;

    const fechas = new Set(filas.map((f) => f.fecha));
    const enPatron = new Set(filas.filter((f) => diasDelPatron.includes(f.dow)).map((f) => f.fecha));
    if (enPatron.size / fechas.size < INFERENCIA.minCobertura) return null;

    const franjas = diasDelPatron.map((d) => {
        const delDia = filas.filter((f) => f.dow === d && f.inicio);
        // Hora que se repite en más bloques ese día.
        const porHora = new Map<string, Set<number>>();
        for (const f of delDia) {
            if (!porHora.has(f.inicio!)) porHora.set(f.inicio!, new Set());
            porHora.get(f.inicio!)!.add(f.bloque);
        }
        const top = [...porHora.entries()].sort((a, b) => b[1].size - a[1].size)[0];
        if (!top || top[1].size < INFERENCIA.minSemanas) return { dia: DIA[d], hora: null as string | null };
        const hora = top[0];

        const fines = delDia.filter((f) => f.inicio === hora && f.fin).map((f) => f.fin!);
        const fin = fines.length && fines.every((x) => x === fines[0]) ? fines[0] : null;
        return { dia: DIA[d], hora: fin ? `${hora} a ${fin}` : hora };
    });

    const prefijo = 'según las últimas sesiones registradas: ';
    if (franjas.every((f) => !f.hora)) {
        return `${prefijo}${franjas.map((f) => f.dia).join(' · ')} (la hora no está registrada)`;
    }
    return prefijo + franjas.map((f) => (f.hora ? `${f.dia} ${f.hora}` : `${f.dia} (hora sin registrar)`)).join(' · ');
}

/**
 * Equipos que la propia escuela marcó para no usarse. Dynasty tiene
 * «MINIVOLLEY -BENJAMINES (DUPLICADO - NO USAR)» activo: listarlo le ofrece a
 * un prospecto un grupo que no existe, y además aparecía como «sin horario».
 */
const MARCADO_NO_USAR = /\bno\s+usar\b/i;

/** «{"dias":{"1":["16:00","20:00"]}}» → «lunes a viernes de 4:00 p. m. a 8:00 p. m.» */
function describirAtencion(bh: any): string | null {
    const dias = bh?.dias;
    if (!dias || typeof dias !== 'object') return null;

    const NOMBRES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const partes: string[] = [];
    for (let d = 0; d <= 6; d++) {
        const r = dias[String(d)];
        if (Array.isArray(r) && r.length === 2) partes.push(`${NOMBRES[d]} de ${r[0]} a ${r[1]}`);
    }
    return partes.length ? partes.join(', ') : null;
}

/**
 * Todo lo publicable de una escuela, para que el bot conteste sin inventar.
 *
 * No recibe `parent_id`: nada de esto es privado — son los mismos datos que
 * cualquiera ve en el perfil público de la escuela. Por eso tampoco hace falta
 * que el acudiente esté identificado para preguntarlo.
 */
export async function infoDeEscuela(schoolId: string): Promise<InfoDeEscuela> {
    const hoy = hoyEnBogota();
    const desde = new Date(diaUTC(hoy) - (INFERENCIA.semanas * 7 - 1) * 86_400_000).toISOString().slice(0, 10);

    const [escuela, sedes, equipos, categorias, ajustes, sesiones, presencial] = await Promise.all([
        supabase.from('schools').select('name, city, address').eq('id', schoolId).maybeSingle(),
        supabase.from('school_branches').select('name').eq('school_id', schoolId).limit(50),
        supabase.from('teams')
            .select('id, name, sport, location, schedule, active, admite_nuevos, nota_admision, '
                + 'branch:school_branches(name, address), facility:facilities(name)')
            .eq('school_id', schoolId).limit(100),
        supabase.from('school_categories')
            .select('name, rama, sort_order')
            .eq('school_id', schoolId).eq('is_active', true)
            .order('sort_order', { ascending: true, nullsFirst: false }).limit(60),
        // whatsapp_settings se llavea por `integration_id`, NO por school_id.
        // La version anterior filtraba por una columna que no existe: fallaba en
        // silencio y el horario de atencion salia null aunque estuviera puesto.
        supabase.from('whatsapp_settings')
            .select('business_hours, integration:school_whatsapp_integrations!inner(school_id)')
            .eq('integration.school_id', schoolId)
            .maybeSingle(),
        // Asistencias de las últimas 4 semanas, para los equipos sin horario
        // cargado. Solo fechas ≤ hoy: una sesión creada a futuro no prueba
        // que se entrene. Si la consulta falla, se sigue sin inferir (nunca
        // se rompe la respuesta por esto).
        supabase.from('attendance_sessions')
            .select('team_id, session_date, start_time, end_time')
            .eq('school_id', schoolId)
            .not('team_id', 'is', null)
            .gte('session_date', desde)
            .lte('session_date', hoy)
            .limit(5000),
        atencionPresencialDeEscuela(schoolId),
    ]);

    const e = (escuela.data ?? {}) as any;

    // Los equipos dados de baja no se nombran: una familia preguntando por
    // grupos no necesita saber cuáles ya no existen. Tampoco los que la
    // escuela marcó «NO USAR» en el nombre.
    const eq = ((equipos.data ?? []) as any[])
        .filter((t) => t.active !== false && !MARCADO_NO_USAR.test(String(t.name ?? '')));

    const sesionesPorEquipo = new Map<string, SesionPasada[]>();
    for (const s of ((sesiones as any)?.data ?? []) as any[]) {
        if (!s?.team_id) continue;
        if (!sesionesPorEquipo.has(s.team_id)) sesionesPorEquipo.set(s.team_id, []);
        sesionesPorEquipo.get(s.team_id)!.push(s);
    }

    const grupos = eq.map((t) => {
        // Prioridad: lo que la escuela escribió > lo que se ve en las
        // asistencias > nada. Nunca se mezclan: si hay horario cargado, las
        // sesiones no lo corrigen (una semana atípica no cambia el horario).
        const cargado = describirEntrenamiento(t.schedule);
        const inferido = cargado ? null
            : inferirHorarioDeSesiones(sesionesPorEquipo.get(t.id) ?? [], hoy);
        const horario = cargado ?? inferido;
        return {
            nombre: String(t.name ?? '').trim(),
            sede: resolverSede(t),
            horario,
            horario_fuente: (cargado ? 'cargado' : inferido ? 'inferido' : null) as InfoDeEscuela['grupos'][number]['horario_fuente'],
            admite_nuevos: t.admite_nuevos !== false,
            nota_admision: vacio(t.nota_admision) ? null : String(t.nota_admision).trim(),
        };
    }).filter((g) => g.nombre);

    const info: InfoDeEscuela = {
        nombre: e.name ?? 'la escuela',
        ciudad: vacio(e.city) ? null : String(e.city).trim(),
        direccion: vacio(e.address) ? null : String(e.address).trim(),
        sedes: ((sedes.data ?? []) as any[]).map((b) => String(b.name ?? '').trim()).filter(Boolean),
        deportes: [...new Set(eq.map((t) => String(t.sport ?? '').trim()).filter(Boolean))],
        grupos,
        categorias: ((categorias.data ?? []) as any[])
            .map((c) => ({ nombre: String(c.name ?? '').trim(), rama: vacio(c.rama) ? null : String(c.rama).trim() }))
            .filter((c) => c.nombre),
        horario_atencion: describirAtencion((ajustes.data as any)?.business_hours),
        atencion_presencial: presencial ?? null,
        no_disponible: [],
    };

    // Lo que falta se dice EXPLÍCITO. Un campo vacío el modelo lo puede leer
    // como «no aplica» y rellenarlo; una frase que diga «no tengo horarios de
    // entrenamiento» no deja lugar a eso.
    // El horario se avisa POR GRUPO, no en bloque. Dynasty tenía 5 de 11
    // cargados el 09-22 (9 de 10 el 10-04): decir «no tengo horarios» sería
    // falso, y no decir nada haría que el modelo diera por completa una lista
    // a la que le faltan grupos. Un horario inferido NO cuenta como faltante:
    // ya viene con su cautela en el texto y en `horario_fuente`.
    const sinHorario = grupos.filter((g) => !g.horario).map((g) => g.nombre);
    if (sinHorario.length === grupos.length && grupos.length) {
        info.no_disponible.push('horarios de entrenamiento (días y horas de cada grupo)');
    } else if (sinHorario.length) {
        info.no_disponible.push(
            `horario de estos grupos: ${sinHorario.join(', ')}`);
    }
    info.no_disponible.push('edades exactas de cada categoría');
    info.no_disponible.push('precios de mensualidad, inscripción y uniforme');
    if (!info.sedes.length && !info.direccion) info.no_disponible.push('dirección y sedes');
    if (!info.horario_atencion && !info.atencion_presencial) info.no_disponible.push('horario de atención de la escuela');

    return info;
}

/**
 * Texto de respaldo, sin pasar por el modelo.
 *
 * Si la segunda llamada al LLM falla, la familia igual se queda con lo que la
 * escuela sí tiene cargado. Mismo criterio que `fallbackMediosDePago`.
 */
export function fallbackInfoEscuela(i: InfoDeEscuela): string {
    const l: string[] = [`*${i.nombre}*`, ''];

    if (i.ciudad || i.direccion) l.push(`📍 ${[i.direccion, i.ciudad].filter(Boolean).join(', ')}`);
    if (i.sedes.length > 1) l.push(`*Sedes:* ${i.sedes.join(' · ')}`);
    if (i.atencion_presencial) l.push(`*Atención presencial (pagos y trámites):* ${i.atencion_presencial}`);
    else if (i.horario_atencion) l.push(`*Atención:* ${i.horario_atencion}`);

    if (i.grupos.length) {
        l.push('', '*Grupos:*');
        for (const g of i.grupos.slice(0, 12)) {
            l.push(`• ${g.nombre}${g.admite_nuevos ? '' : ' — sin cupos'}`);
            // El horario es lo que más preguntan: si está, se da también sin
            // modelo. El inferido ya trae «según las últimas sesiones…».
            if (g.horario) l.push(`   ${g.horario}`);
        }
    }

    const faltaAlguno = !i.grupos.length || i.grupos.some((g) => g.horario_fuente !== 'cargado');
    l.push('', faltaAlguno
        ? 'Los horarios que no aparecen acá y los precios te los confirma la escuela directamente.'
        : 'Los precios te los confirma la escuela directamente.');
    return l.join('\n');
}

// ─── Horario de HOY (Dynasty 2026-10-08) ─────────────────────────────────────
//
// «¿Cambiaron el horario de hoy?» de un desconocido recibía
// «escríbeme tu correo». El horario del día es público: sale de
// `teams.schedule` (lo que la escuela cargó) con los ajustes de la semana que
// el profe o la escuela cargaron en `team_schedule_exceptions` (semana-equipo,
// migración M1, 2026-10-30): un entreno cancelado no sale en «hoy entrenan» y
// se dice que se canceló; uno movido sale a su hora nueva. Sin ajustes (o sin
// la migración) el texto es el de siempre. Igual se dice que un cambio de
// última hora lo avisa la escuela.

/** Franjas de un `teams.schedule` para un día de la semana (0 = domingo). Pura. */
export function franjasDelDia(raw: unknown, dia: number): string | null {
    let franjas: any[];
    try {
        franjas = typeof raw === 'string' ? JSON.parse(raw) : (raw as any[]);
    } catch { return null; }
    if (!Array.isArray(franjas)) return null;
    const delDia = franjas.filter((f) => f && f.day === dia && f.time);
    if (!delDia.length) return null;
    return delDia
        .map((f) => `${f.group ? `${f.group}: ` : ''}${f.time}${f.end ? ` a ${f.end}` : ''}${f.place ? ` (${f.place})` : ''}`)
        .join(' · ');
}

export interface HorarioDelDia {
    /** «jueves» */
    dia: string;
    grupos: { nombre: string; franjas: string }[];
    /** Cuántos equipos activos tienen horario cargado (0 = no se puede contestar). */
    conHorario: number;
    /** Grupos que hoy entrenaban y se les canceló el entreno (team_schedule_exceptions). */
    cancelados?: string[];
}

/** Día de la semana de una fecha 'YYYY-MM-DD' (0 = domingo). */
function diaDeLaSemana(fecha: string): number {
    return new Date(diaUTC(fecha)).getUTCDay();
}

/** Sesiones ya ajustadas → «Origen: 09:30 a 11:30 (Parque) (cambio de horario)». Pura. */
export function franjasDeSesiones(sesiones: SesionDelDia[]): string | null {
    if (!sesiones.length) return null;
    return sesiones
        .map((s) => `${s.grupo ? `${s.grupo}: ` : ''}${s.inicio}${s.fin ? ` a ${s.fin}` : ''}${s.lugar ? ` (${s.lugar})` : ''}`
            + (s.origen === 'movida' ? ' (cambio de horario)' : s.origen === 'extra' ? ' (entreno extra)' : ''))
        .join(' · ');
}

/**
 * Grupos que entrenan hoy (hora de Bogotá), según el horario cargado y los
 * ajustes de la semana. null si no se pudo leer. `excepciones` se inyecta en
 * las pruebas; por defecto, semana-equipo (cacheado 10 min, nunca lanza).
 */
export async function horariosDelDia(
    schoolId: string,
    fecha = hoyEnBogota(),
    deps: { excepciones?: (schoolId: string, desde: string, hasta: string) => Promise<ExcepcionSemana[]> } = {},
): Promise<HorarioDelDia | null> {
    try {
        const [{ data, error }, excepciones] = await Promise.all([
            supabase.from('teams')
                .select('id, name, schedule, active')
                .eq('school_id', schoolId).limit(100),
            (deps.excepciones ?? excepcionesDeEscuela)(schoolId, fecha, fecha).catch(() => [] as ExcepcionSemana[]),
        ]);
        if (error || !Array.isArray(data)) return null;
        const dia = diaDeLaSemana(fecha);
        const activos = (data as any[])
            .filter((t) => t.active !== false && !MARCADO_NO_USAR.test(String(t.name ?? '')) && String(t.name ?? '').trim());
        const conHorario = activos.filter((t) => describirEntrenamiento(t.schedule)).length;
        const cancelados: string[] = [];
        const grupos = activos
            .map((t) => {
                const nombre = String(t.name).trim();
                const base = franjasDelDia(t.schedule, dia);
                const delEquipo = (excepciones ?? []).filter((e) => e.team_id === t.id && e.fecha === fecha);
                // Sin ajustes, exactamente lo de siempre.
                if (!delEquipo.length) return { nombre, franjas: base };
                const sesiones = sesionesDelDia(t.schedule, delEquipo, fecha);
                if (base && !sesiones.length) cancelados.push(nombre);
                return { nombre, franjas: franjasDeSesiones(sesiones) };
            })
            .filter((g): g is { nombre: string; franjas: string } => !!g.franjas);
        return { dia: DIA[dia], grupos, conHorario, ...(cancelados.length ? { cancelados } : {}) };
    } catch {
        return null;
    }
}

/** «*Infantil*» · «*Infantil* y *Mayores*» · «*A*, *B* y *C*». */
function listaDeGrupos(nombres: string[]): string {
    const n = nombres.map((x) => `*${x}*`);
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
}

/** Texto para «¿hay clase hoy? / ¿cambió el horario de hoy?». Pura. null si no hay horarios cargados. */
export function textoHorarioDeHoy(h: HorarioDelDia, pasadoALaEscuela: boolean): string | null {
    if (!h.conHorario) return null;
    const cierre = 'Si hay un cambio de última hora, la escuela lo avisa por aquí.'
        + (pasadoALaEscuela ? ' Ya le pasé tu mensaje para que te lo confirme.' : '');
    const cancelados = (h.cancelados ?? []).slice(0, 15);
    const deCancelados = cancelados.length
        ? `Hoy se canceló el entreno de ${listaDeGrupos(cancelados)}.` : '';
    if (!h.grupos.length) {
        if (cancelados.length) {
            return `Según el horario de la escuela, hoy *${h.dia}* no hay entrenamientos: se canceló el de `
                + `${listaDeGrupos(cancelados)}.\n\n${cierre}`;
        }
        return `Según el horario de la escuela, hoy *${h.dia}* no hay entrenamientos programados.\n\n${cierre}`;
    }
    const lineas = h.grupos.slice(0, 15).map((g) => `• *${g.nombre}*: ${g.franjas}`);
    return `Según el horario de la escuela, hoy *${h.dia}* entrenan:\n\n${lineas.join('\n')}\n\n`
        + (deCancelados ? `${deCancelados}\n\n` : '') + cierre;
}
