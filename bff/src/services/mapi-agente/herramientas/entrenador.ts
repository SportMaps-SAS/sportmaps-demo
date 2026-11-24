/**
 * Oleada 2 — el entrenador en la cancha (plan §19.4, fila 2). Admin y coach:
 * el coach solo con sus equipos (`alcance.teamIds`), el admin con toda la escuela.
 *
 * Regla de la oleada: una herramienta por acción de pantalla, sobre el MISMO
 * servicio o la MISMA RPC de la pantalla. Mapi no decide nada de negocio:
 *
 *   · registrar_asistencia → `guardarSesionAsistencia` (attendance-register.service),
 *     lo mismo que POST /api/v1/attendance/session y la asistencia por WhatsApp:
 *     sesión del día, `upsert_attendance_record`, créditos del plan, reservas y
 *     avisos de hito. La fecha pasa por `resolverFechaDeTrabajo` (ventana
 *     retroactiva de la escuela) y el día pasado deja `attendance_backdated` en
 *     security_audit_log, igual que el handler HTTP. El roster es el de la
 *     pantalla: inscripciones activas del equipo menos las pausadas ese día, cada
 *     registro con SU `enrollmentId` (de ahí sale el crédito).
 *   · evaluar_entreno → RPC `submit_post_training_coach_rating` (CoachEvaluateV2):
 *     Bien · Normal · Le costó = 90 · 70 · 60, solo a los que vinieron, con la
 *     lista cerrada y solo el entrenador asignado (team_coaches).
 *   · felicitar → RPC `give_kudos` (FelicitarSheet): una por deportista al día.
 *
 * Las dos RPC autorizan con `auth.uid()`: con la service key del BFF darían
 * 42501. Se llaman COMO LA PERSONA (utils/userClient.ts) con el header
 * Authorization de la request, que el integrador suma al Alcance como
 * `authorization`. Sin él, esas dos herramientas no se ofrecen.
 *
 * Consultas: equipos_y_horarios, asistencia_de_sesion y semana_del_equipo
 * (semana-equipo.service: horario base + cancelada / movida / extra).
 *
 * Nada de plata: ninguna lectura toca montos, cobros ni pagos (el coach nunca
 * los ve). Datos mínimos (§12.1): nombres, ids, estados y motivos por
 * categoría; nunca teléfonos, notas de las familias ni datos médicos.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../../config/supabase';
import { guardarSesionAsistencia, resolverFechaDeTrabajo, type RegistroAsistencia } from '../../attendance-register.service';
import { findTeamSessionOfDay, pausedEnrollmentIds, toCreditEnrollment, tieneSaldo, PLAN_JOIN, type CreditOutcome } from '../../attendance-credits';
import {
    ajusteDeSesion, excepcionesDeEscuela, excepcionesDelEquipo, normalizarHora, sesionesDelDia, sesionesValidas,
    type ExcepcionSemana, type SesionDelDia,
} from '../../semana-equipo.service';
import { writeAudit } from '../../../utils/auditWrite';
import { coincideNombre, normalizar, parsearClave, resolverDeportista, type TipoDeportista } from '../deportistas';
import { esFechaIso, fechaLarga, nombreDelMes, sumarDias } from '../fechas';
import { RechazoHerramienta, type Alcance, type Herramienta, type HerramientaAccion, type HerramientaConsulta } from '../tipos';

// ─── Utilidades ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const recortar = (s: unknown, n: number) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const texto = (v: unknown) => String(v ?? '').trim() || null;

/** Lista de ids/nombres que manda el modelo. `null` vale como lista vacía. */
const listaDeNombres = z.array(z.string().trim().min(2).max(80)).max(80).nullish().transform((v) => v ?? []);

// ─── Sesión de la persona (RPC que autorizan con auth.uid()) ────────────────

/**
 * El integrador suma al Alcance el header Authorization de la request (el del
 * turno y el del Confirmar). Nunca se guarda en el borrador ni va al modelo.
 */
export type AlcanceConSesion = Alcance & { authorization?: string | null };

export function sesionDe(a: Alcance): string | null {
    const t = (a as AlcanceConSesion).authorization;
    return typeof t === 'string' && /^Bearer\s+\S+$/.test(t.trim()) ? t.trim() : null;
}

/** Cliente que actúa COMO la persona (mismo patrón que utils/userClient.ts). */
function comoLaPersona(a: Alcance) {
    const auth = sesionDe(a);
    if (!auth) throw new RechazoHerramienta('Esta acción necesita tu sesión de la app. Hazla desde la pantalla.');
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

// ─── Equipos ────────────────────────────────────────────────────────────────

interface Equipo {
    id: string;
    nombre: string;
    deporte: string | null;
    categoria: string | null;
    schedule: unknown;
}

/** Lista permitida de columnas de `teams` (nada de precios: price_monthly nunca se lee). */
const COLS_EQUIPO = 'id, name, sport, age_group, schedule, active, status';

/** Equipo vigente: misma regla que `equipoVigente` de whatsapp-asistencia-staff.service. */
const vigente = (t: any) => t.active !== false && t.status !== 'inactive' && !/duplicado|no usar/i.test(t.name ?? '');

const aEquipo = (t: any): Equipo => ({
    id: String(t.id),
    nombre: String(t.name ?? '').trim() || 'Equipo sin nombre',
    deporte: texto(t.sport),
    categoria: texto(t.age_group),
    schedule: t.schedule ?? null,
});

/** Equipos vigentes del alcance: el admin, toda la escuela; el coach, solo los suyos. */
async function equiposDelAlcance(a: Alcance): Promise<Equipo[]> {
    if (a.rol === 'coach' && !a.teamIds.length) return [];
    let q = supabase.from('teams').select(COLS_EQUIPO).eq('school_id', a.schoolId);
    if (a.rol === 'coach') q = q.in('id', a.teamIds);
    const { data, error } = await q.limit(300);
    if (error) throw new Error(`teams: ${error.message}`);
    return ((data as any[]) ?? []).filter(vigente).map(aEquipo).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
}

/** Equipo por id o por nombre («sub 12» = «Sub-12»), dentro del alcance. */
export async function resolverEquipo(a: Alcance, textoEquipo: string): Promise<Equipo> {
    const t = textoEquipo.trim();
    if (UUID.test(t)) {
        const id = t.toLowerCase();
        if (a.rol === 'coach' && !a.teamIds.includes(id)) throw new RechazoHerramienta('Ese equipo no está entre los que entrenas.');
        const { data, error } = await supabase.from('teams').select(COLS_EQUIPO).eq('school_id', a.schoolId).eq('id', id).maybeSingle();
        if (error) throw new Error(`teams: ${error.message}`);
        if (!data) throw new RechazoHerramienta('No encontré ese equipo en esta escuela.');
        return aEquipo(data);
    }
    const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
    const buscado = clave(t);
    if (!buscado) throw new RechazoHerramienta('Dime el nombre del equipo.');
    const todos = await equiposDelAlcance(a);
    const exactos = todos.filter((e) => clave(e.nombre) === buscado);
    const candidatos = exactos.length ? exactos : todos.filter((e) => clave(e.nombre).includes(buscado));
    if (candidatos.length === 1) return candidatos[0];
    if (!candidatos.length) {
        throw new RechazoHerramienta(a.rol === 'coach'
            ? `No encontré «${t}» entre tus equipos.`
            : `No encontré un equipo llamado «${t}» en esta escuela.`);
    }
    throw new RechazoHerramienta(`Hay varios equipos que coinciden: ${candidatos.slice(0, 6).map((e) => e.nombre).join(', ')}. ¿Cuál?`);
}

// ─── Horarios (semana-equipo.service) ───────────────────────────────────────

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** «lun, mié 16:00–17:30 (Origen) · Parque» por bloque del horario base. Pura. */
export function horarioBase(schedule: unknown): string[] {
    const grupos = new Map<string, { dias: number[]; ini: string; fin: string | null; lugar: string | null; grupo: string | null }>();
    for (const f of sesionesValidas(schedule)) {
        const ini = normalizarHora(f.time)!;
        const fin = normalizarHora(f.end);
        const lugar = texto(f.place);
        const grupo = texto(f.group);
        const k = JSON.stringify([ini, fin, lugar, grupo]);
        const g = grupos.get(k) ?? { dias: [], ini, fin, lugar, grupo };
        if (!g.dias.includes(f.day)) g.dias.push(f.day);
        grupos.set(k, g);
    }
    return [...grupos.values()].slice(0, 12).map((g) => {
        const dias = g.dias.sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((d) => DIAS[d]).join(', ');
        return `${dias} ${g.ini}${g.fin ? `–${g.fin}` : ''}${g.grupo ? ` (${g.grupo})` : ''}${g.lugar ? ` · ${recortar(g.lugar, 80)}` : ''}`;
    });
}

/** Una sesión del día como texto corto, con su ajuste si lo tiene. Pura. */
export function sesionTexto(s: SesionDelDia): string {
    const ajuste = s.origen === 'movida' ? ` [movida, era a las ${s.horaOriginal}]` : s.origen === 'extra' ? ' [extra]' : '';
    return `${s.inicio}${s.fin ? `–${s.fin}` : ''}${s.grupo ? ` (${s.grupo})` : ''}${s.lugar ? ` · ${recortar(s.lugar, 80)}` : ''}${ajuste}`;
}

/** Horas del horario base que se cancelaron ese día. Pura. */
export function canceladasDelDia(schedule: unknown, excepciones: ExcepcionSemana[], fecha: string): string[] {
    return sesionesDelDia(schedule, [], fecha)
        .filter((s) => ajusteDeSesion(excepciones, fecha, s.inicio)?.tipo === 'cancelada')
        .map((s) => s.inicio);
}

/** Plan del entreno (planificación, `training_sessions`) por equipo y día. Solo objetivos y número de bloques. */
async function planesDelEntreno(schoolId: string, teamIds: string[], fechas: string[]): Promise<Map<string, { objetivos: string; bloques: number }>> {
    const out = new Map<string, { objetivos: string; bloques: number }>();
    if (!teamIds.length) return out;
    const { data, error } = await supabase.from('training_sessions').select('team_id, session_date, objectives, session_blocks')
        .eq('school_id', schoolId).in('team_id', teamIds).in('session_date', fechas).limit(500);
    if (error) return out; // la planificación es un extra: sin ella, la consulta sigue
    for (const r of (data as any[]) ?? []) {
        const k = `${r.team_id}|${String(r.session_date).slice(0, 10)}`;
        if (out.has(k)) continue;
        out.set(k, { objetivos: recortar(r.objectives, 160), bloques: Array.isArray(r.session_blocks) ? r.session_blocks.length : 0 });
    }
    return out;
}

// ─── Roster y lista del día (lo mismo que ve la pantalla) ───────────────────

interface Miembro {
    clave: string;
    tipo: TipoDeportista;
    id: string;
    nombre: string;
    enrollmentId: string;
}

type Ids = Record<TipoDeportista, Set<string>>;
const idsVacios = (): Ids => ({ child: new Set(), adult: new Set(), unregistered: new Set() });

function claveDeFila(r: any): { tipo: TipoDeportista; id: string; clave: string } | null {
    if (r?.child_id) return { tipo: 'child', id: String(r.child_id), clave: `child:${r.child_id}` };
    if (r?.user_id) return { tipo: 'adult', id: String(r.user_id), clave: `adult:${r.user_id}` };
    if (r?.unregistered_athlete_id) return { tipo: 'unregistered', id: String(r.unregistered_athlete_id), clave: `unregistered:${r.unregistered_athlete_id}` };
    return null;
}

/** Nombres por clave (children / profiles / unregistered_athletes, solo id y nombre). */
async function nombresDe(ids: Ids): Promise<Map<string, string>> {
    const tablas: [TipoDeportista, string][] = [['child', 'children'], ['adult', 'profiles'], ['unregistered', 'unregistered_athletes']];
    const res = await Promise.all(tablas.map(([tipo, tabla]) => (ids[tipo].size
        ? supabase.from(tabla).select('id, full_name').in('id', [...ids[tipo]])
        : Promise.resolve({ data: [] as any[], error: null }))));
    const out = new Map<string, string>();
    res.forEach((r: any, i) => {
        if (r.error) throw new Error(`${tablas[i][1]}: ${r.error.message}`);
        for (const f of r.data ?? []) out.set(`${tablas[i][0]}:${f.id}`, String(f.full_name ?? '').trim() || 'Deportista sin nombre');
    });
    return out;
}

/**
 * El roster de la lista, como GET /attendance/roster/team/:id: inscripciones
 * ACTIVAS del equipo menos las pausadas ESE día. Uno por deportista.
 */
async function rosterDelEquipo(schoolId: string, teamId: string, fecha: string): Promise<{ miembros: Miembro[]; pausados: number }> {
    const { data, error } = await supabase.from('enrollments').select('id, child_id, user_id, unregistered_athlete_id')
        .eq('school_id', schoolId).eq('status', 'active').eq('team_id', teamId).limit(500);
    if (error) throw new Error(`enrollments: ${error.message}`);
    const todas = (data as any[]) ?? [];
    const pausadas = await pausedEnrollmentIds(schoolId, fecha);
    const porClave = new Map<string, Omit<Miembro, 'nombre'>>();
    for (const e of todas.filter((x) => !pausadas.has(x.id))) {
        const k = claveDeFila(e);
        if (k && !porClave.has(k.clave)) porClave.set(k.clave, { ...k, enrollmentId: String(e.id) });
    }
    const ids = idsVacios();
    for (const m of porClave.values()) ids[m.tipo].add(m.id);
    const nombres = await nombresDe(ids);
    const miembros = [...porClave.values()]
        .map((m) => ({ ...m, nombre: nombres.get(m.clave) ?? 'Deportista sin nombre' }))
        .sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
    return { miembros, pausados: todas.length - todas.filter((x) => !pausadas.has(x.id)).length };
}

type Sesion = { tipo: 'ninguna' } | { tipo: 'una'; id: string; cerrada: boolean } | { tipo: 'varias'; n: number };

interface Lista {
    sesion: Sesion;
    miembros: Miembro[];
    pausados: number;
    /** clave → estado guardado (present / late / absent / excused). */
    marcas: Map<string, string>;
    /** clave → aviso de ausencia activo ese día. */
    avisos: Map<string, { motivo: string; quien: string }>;
    /** Marcados ese día que ya no están en el roster (cambio de equipo, pausa…). */
    fuera: { clave: string; nombre: string; estado: string }[];
}

async function leerLista(a: Alcance, teamId: string, fecha: string): Promise<Lista> {
    const [lookup, roster, avisosRes] = await Promise.all([
        findTeamSessionOfDay(teamId, fecha),
        rosterDelEquipo(a.schoolId, teamId, fecha),
        // «Mi hija no puede ir»: la pantalla los precarga como «Excusa». Sin la nota (texto libre de la familia).
        supabase.from('athlete_absence_notices').select('child_id, user_id, reason, source')
            .eq('school_id', a.schoolId).eq('absence_date', fecha).eq('status', 'active').limit(2000),
    ]);

    const sesion: Sesion = lookup.kind === 'none' ? { tipo: 'ninguna' }
        : lookup.kind === 'one' ? { tipo: 'una', id: String(lookup.session.id), cerrada: lookup.session.finalized === true }
            : { tipo: 'varias', n: lookup.sessions.length };

    let registros: any[] = [];
    if (sesion.tipo !== 'ninguna') {
        let q = supabase.from('attendance_records').select('child_id, user_id, unregistered_athlete_id, status').eq('school_id', a.schoolId);
        q = sesion.tipo === 'una' ? q.eq('session_id', sesion.id) : q.eq('team_id', teamId).eq('attendance_date', fecha);
        const { data, error } = await q.limit(1000);
        if (error) throw new Error(`attendance_records: ${error.message}`);
        registros = (data as any[]) ?? [];
    }

    const marcas = new Map<string, string>();
    for (const r of registros) {
        const k = claveDeFila(r);
        if (k) marcas.set(k.clave, String(r.status));
    }
    const avisos = new Map<string, { motivo: string; quien: string }>();
    // Sin la migración la tabla no existe: la lista sigue sin avisos, como la pantalla.
    for (const v of (avisosRes.error ? [] : (avisosRes.data as any[]) ?? [])) {
        const k = claveDeFila({ child_id: v.child_id, user_id: v.user_id });
        if (k) avisos.set(k.clave, { motivo: String(v.reason ?? 'otro').replace(/_/g, ' '), quien: v.source === 'staff' ? 'la escuela' : 'la familia' });
    }

    const enRoster = new Set(roster.miembros.map((m) => m.clave));
    const ajenos = [...marcas.keys()].filter((k) => !enRoster.has(k));
    let fuera: Lista['fuera'] = [];
    if (ajenos.length) {
        const ids = idsVacios();
        for (const k of ajenos) { const p = parsearClave(k); if (p) ids[p.tipo].add(p.id); }
        const nombres = await nombresDe(ids);
        fuera = ajenos.map((k) => ({ clave: k, nombre: nombres.get(k) ?? 'Deportista', estado: marcas.get(k)! }));
    }
    return { sesion, miembros: roster.miembros, pausados: roster.pausados, marcas, avisos, fuera };
}

/** Estados de la lista en palabras de la pantalla V2 (asistenciaModel.ETIQUETA). */
const ETIQUETA: Record<string, string> = { present: 'Vino', absent: 'Faltó', excused: 'Excusa', late: 'Tarde' };

function textoSesion(s: Sesion): string {
    if (s.tipo === 'ninguna') return 'sin tomar';
    if (s.tipo === 'varias') return `varios bloques (${s.n})`;
    return s.cerrada ? 'cerrada' : 'abierta';
}

/**
 * Los ids o nombres que mandó el modelo, contra una lista cerrada de
 * candidatos (el roster o los que vinieron). Nunca adivina: si no está o
 * coincide con varios, rechaza con el porqué.
 */
export function resolverEnLista<T extends { clave: string; nombre: string }>(
    textos: string[], candidatos: T[], noEsta: (t: string) => string,
): T[] {
    return textos.map((t) => {
        const p = parsearClave(t);
        let hit = p ? candidatos.filter((c) => c.clave === `${p.tipo}:${p.id}`) : candidatos.filter((c) => coincideNombre(c.nombre, t));
        if (hit.length > 1) {
            const exacto = hit.filter((c) => normalizar(c.nombre) === normalizar(t));
            if (exacto.length === 1) hit = exacto;
        }
        if (!hit.length) throw new RechazoHerramienta(noEsta(p ? 'Ese deportista' : `«${t}»`));
        if (hit.length > 1) throw new RechazoHerramienta(`«${t}» coincide con ${hit.length}: ${hit.slice(0, 5).map((c) => c.nombre).join(', ')}. Usa el nombre completo.`);
        return hit[0];
    });
}

/** Una persona no puede estar en dos listas a la vez. */
function sinRepetidos(listas: Record<string, { clave: string; nombre: string }[]>): void {
    const visto = new Map<string, string>();
    for (const [lista, ms] of Object.entries(listas)) {
        for (const m of ms) {
            const otra = visto.get(m.clave);
            if (otra && otra !== lista) throw new RechazoHerramienta(`${m.nombre} está en dos listas (${otra} y ${lista}). ¿Cuál es?`);
            visto.set(m.clave, lista);
        }
    }
}

// ═══ CONSULTAS ═══════════════════════════════════════════════════════════════

// ─── equipos_y_horarios ─────────────────────────────────────────────────────

export const equiposYHorarios: HerramientaConsulta<Record<string, never>> = {
    tipo: 'consulta',
    nombre: 'equipos_y_horarios',
    descripcion: 'Equipos que ve la persona (el entrenador, solo los suyos) con su horario, las sesiones de hoy y de mañana con los cambios de la semana (cancelada, movida, extra), si la lista de hoy ya se tomó y el plan del entreno si lo hay. Devuelve el id de cada equipo.',
    esquema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    roles: ['admin', 'coach'],
    validar: () => ({}),
    async ejecutar(a) {
        const equipos = (await equiposDelAlcance(a)).slice(0, 60);
        if (!equipos.length) {
            return { equipos: [], nota: a.rol === 'coach' ? 'No tienes equipos asignados en esta escuela.' : 'La escuela no tiene equipos activos.' };
        }
        const manana = sumarDias(a.hoy, 1);
        const ids = equipos.map((e) => e.id);
        const [excepciones, { data: listas, error: errListas }, { data: inscritas, error: errInsc }, planes] = await Promise.all([
            excepcionesDeEscuela(a.schoolId, a.hoy, manana),
            supabase.from('attendance_sessions').select('team_id, finalized')
                .eq('school_id', a.schoolId).eq('session_date', a.hoy).in('team_id', ids).limit(500),
            supabase.from('enrollments').select('team_id')
                .eq('school_id', a.schoolId).eq('status', 'active').in('team_id', ids).limit(5000),
            planesDelEntreno(a.schoolId, ids, [a.hoy, manana]),
        ]);
        if (errListas) throw new Error(`attendance_sessions: ${errListas.message}`);
        if (errInsc) throw new Error(`enrollments: ${errInsc.message}`);

        const listaDeHoy = new Map<string, boolean[]>();
        for (const s of (listas as any[]) ?? []) listaDeHoy.set(s.team_id, [...(listaDeHoy.get(s.team_id) ?? []), s.finalized === true]);
        const inscritos = new Map<string, number>();
        for (const e of (inscritas as any[]) ?? []) inscritos.set(e.team_id, (inscritos.get(e.team_id) ?? 0) + 1);

        return {
            hoy: fechaLarga(a.hoy),
            manana: fechaLarga(manana),
            equipos: equipos.map((e) => {
                const exc = excepcionesDelEquipo(excepciones, e.id);
                const hoy = sesionesDelDia(e.schedule, exc, a.hoy);
                const lista = listaDeHoy.get(e.id);
                const canceladasHoy = canceladasDelDia(e.schedule, exc, a.hoy);
                const planHoy = planes.get(`${e.id}|${a.hoy}`);
                const planManana = planes.get(`${e.id}|${manana}`);
                return {
                    id: e.id,
                    nombre: e.nombre,
                    ...(e.deporte ? { deporte: e.deporte } : {}),
                    ...(e.categoria ? { categoria: e.categoria } : {}),
                    inscritos_activos: inscritos.get(e.id) ?? 0,
                    horario: horarioBase(e.schedule),
                    sesiones_hoy: hoy.map(sesionTexto),
                    ...(canceladasHoy.length ? { canceladas_hoy: canceladasHoy } : {}),
                    sesiones_manana: sesionesDelDia(e.schedule, exc, manana).map(sesionTexto),
                    lista_de_hoy: !lista?.length ? (hoy.length ? 'sin tomar' : 'sin entreno hoy') : lista.every(Boolean) ? 'cerrada' : 'abierta',
                    ...(planHoy ? { plan_de_hoy: planHoy } : {}),
                    ...(planManana ? { plan_de_manana: planManana } : {}),
                };
            }),
        };
    },
};

// ─── asistencia_de_sesion ───────────────────────────────────────────────────

export interface ArgsEquipoFecha { equipo: string; fecha?: string }

const esquemaEquipoFecha = z.object({
    equipo: z.string().trim().min(2).max(80),
    fecha: z.string().trim().nullish().transform((v) => v || undefined),
});

export const asistenciaDeSesion: HerramientaConsulta<ArgsEquipoFecha> = {
    tipo: 'consulta',
    nombre: 'asistencia_de_sesion',
    descripcion: 'Quién vino y quién no en la lista de un equipo un día: vino, tarde, faltó, excusa o sin marca, y quién avisó que no venía (familia o escuela). Devuelve el id de cada deportista.',
    esquema: {
        type: 'object',
        properties: {
            equipo: { type: 'string', description: 'id o nombre del equipo' },
            fecha: { type: ['string', 'null'], description: 'AAAA-MM-DD; null = hoy' },
        },
        required: ['equipo', 'fecha'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar(args) {
        const r = esquemaEquipoFecha.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Falta el equipo (id o nombre) y, si no es hoy, la fecha AAAA-MM-DD.');
        return r.data;
    },
    async ejecutar(a, args) {
        const fecha = args.fecha ?? a.hoy;
        if (!esFechaIso(fecha)) throw new RechazoHerramienta('La fecha tiene que venir como AAAA-MM-DD.');
        const equipo = await resolverEquipo(a, args.equipo);
        const l = await leerLista(a, equipo.id, fecha);
        const conteo = { vinieron: 0, tarde: 0, faltaron: 0, con_excusa: 0, sin_marca: 0 };
        const deportistas = l.miembros.slice(0, 80).map((m) => {
            const marca = l.marcas.get(m.clave);
            const aviso = l.avisos.get(m.clave);
            return {
                id: m.clave,
                nombre: m.nombre,
                estado: marca ? (ETIQUETA[marca] ?? marca) : 'sin marca',
                ...(aviso ? { aviso: `avisó ${aviso.quien}: ${aviso.motivo}` } : {}),
            };
        });
        for (const m of l.miembros) {
            const marca = l.marcas.get(m.clave);
            if (marca === 'present') conteo.vinieron++;
            else if (marca === 'late') conteo.tarde++;
            else if (marca === 'absent') conteo.faltaron++;
            else if (marca === 'excused') conteo.con_excusa++;
            else conteo.sin_marca++;
        }
        return {
            equipo: equipo.nombre,
            fecha: fechaLarga(fecha),
            lista: textoSesion(l.sesion),
            resumen: { ...conteo, en_la_lista: l.miembros.length },
            deportistas,
            ...(l.miembros.length > 80 ? { nota: `Se muestran 80 de ${l.miembros.length}.` } : {}),
            ...(l.fuera.length ? { marcados_que_ya_no_estan_en_el_equipo: l.fuera.map((f) => ({ id: f.clave, nombre: f.nombre, estado: ETIQUETA[f.estado] ?? f.estado })) } : {}),
            ...(l.pausados ? { en_pausa_ese_dia: l.pausados } : {}),
            ...(l.sesion.tipo === 'ninguna' && conteo.sin_marca ? { nota_lista: 'Ese día no se ha tomado lista.' } : {}),
            ...(l.sesion.tipo === 'una' && !l.sesion.cerrada && conteo.sin_marca ? { nota_lista: 'Los que queden sin marca pasan a «Faltó» al cerrar la lista.' } : {}),
        };
    },
};

// ─── semana_del_equipo ──────────────────────────────────────────────────────

export const semanaDelEquipo: HerramientaConsulta<{ equipo: string }> = {
    tipo: 'consulta',
    nombre: 'semana_del_equipo',
    descripcion: 'Los próximos 7 días de un equipo (desde hoy): sesiones con hora y lugar ya con los ajustes (cancelada, movida, extra) y el plan del entreno si lo hay.',
    esquema: {
        type: 'object',
        properties: { equipo: { type: 'string', description: 'id o nombre del equipo' } },
        required: ['equipo'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar(args) {
        const r = z.object({ equipo: z.string().trim().min(2).max(80) }).safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Falta el equipo (id o nombre).');
        return r.data;
    },
    async ejecutar(a, { equipo: textoEquipo }) {
        const equipo = await resolverEquipo(a, textoEquipo);
        const hasta = sumarDias(a.hoy, 6);
        const dias = Array.from({ length: 7 }, (_, i) => sumarDias(a.hoy, i));
        const [todas, planes] = await Promise.all([
            excepcionesDeEscuela(a.schoolId, a.hoy, hasta),
            planesDelEntreno(a.schoolId, [equipo.id], dias),
        ]);
        const exc = excepcionesDelEquipo(todas, equipo.id);
        return {
            equipo: equipo.nombre,
            horario_base: horarioBase(equipo.schedule),
            dias: dias.map((f) => {
                const canceladas = canceladasDelDia(equipo.schedule, exc, f);
                const plan = planes.get(`${equipo.id}|${f}`);
                return {
                    fecha: fechaLarga(f),
                    sesiones: sesionesDelDia(equipo.schedule, exc, f).map(sesionTexto),
                    ...(canceladas.length ? { canceladas } : {}),
                    ...(plan ? { plan } : {}),
                };
            }),
        };
    },
};

// ═══ ACCIONES ════════════════════════════════════════════════════════════════

// ─── registrar_asistencia ───────────────────────────────────────────────────

export const LOS_DEMAS_LISTA = ['presentes', 'ausentes', 'sin_cambios'] as const;

export interface ArgsAsistencia {
    equipo: string;
    fecha?: string;
    presentes: string[];
    ausentes: string[];
    excusados: string[];
    los_demas: (typeof LOS_DEMAS_LISTA)[number];
}

const esquemaAsistencia = z.object({
    equipo: z.string().trim().min(2).max(80),
    fecha: z.string().trim().nullish().transform((v) => v || undefined),
    presentes: listaDeNombres,
    ausentes: listaDeNombres,
    excusados: listaDeNombres,
    los_demas: z.enum(LOS_DEMAS_LISTA),
});

interface Cambio { m: Miembro; nuevo: 'present' | 'absent' | 'excused'; antes: string | null }

interface ArmadoAsistencia {
    equipo: Equipo;
    fecha: string;
    esRetroactiva: boolean;
    sesionId: string | null;
    l: Lista;
    final: Map<string, string>;
    cambios: Cambio[];
    porAviso: Miembro[];
    contraAviso: Miembro[];
    conservadas: number;
    creditos: { descuentan: number; sinSaldo: number; devuelven: number };
    args: Required<Omit<ArgsAsistencia, 'fecha'>> & { fecha: string };
}

const habilitadaAsistencia = (a: Alcance) => a.rol === 'admin' || a.ajustes.coachMapiAttendance;

/** Lo que el crédito del plan haría con estos cambios (misma inscripción y saldo que usa el servicio). */
async function vistaDeCreditos(schoolId: string, fecha: string, cambios: Cambio[]) {
    const vaPresente = cambios.filter((c) => c.nuevo === 'present' && c.antes !== 'present');
    const dejaPresente = cambios.filter((c) => c.nuevo !== 'present' && c.antes === 'present');
    const ids = [...new Set([...vaPresente, ...dejaPresente].map((c) => c.m.enrollmentId))];
    const out = { descuentan: 0, sinSaldo: 0, devuelven: 0 };
    if (!ids.length) return out;
    const { data, error } = await supabase.from('enrollments')
        .select(`id, sessions_used, secondary_sessions_used, expires_at, ${PLAN_JOIN}`)
        .eq('school_id', schoolId).in('id', ids);
    if (error) throw new Error(`enrollments: ${error.message}`);
    const credito = new Map(((data as any[]) ?? []).map((r) => [String(r.id), toCreditEnrollment(r)]));
    // Sin plan (inscripción de equipo puro) no hay clases que contar. Con plan, el
    // saldo se juzga con la fecha del EVENTO, como el servicio (tieneSaldo).
    const conPlan = (id: string) => {
        const cr = credito.get(id);
        return cr && (cr.plan_name !== null || cr.max_sessions !== null) ? cr : null;
    };
    for (const c of vaPresente) {
        const cr = conPlan(c.m.enrollmentId);
        if (!cr) continue;
        if (tieneSaldo(cr, false, fecha)) out.descuentan++;
        else out.sinSaldo++;
    }
    for (const c of dejaPresente) if (conPlan(c.m.enrollmentId)) out.devuelven++;
    return out;
}

async function armarAsistencia(a: Alcance, args: ArgsAsistencia): Promise<{ ok: true; x: ArmadoAsistencia } | { ok: false; motivo: string }> {
    if (!habilitadaAsistencia(a)) throw new RechazoHerramienta('La escuela no tiene habilitado pasar lista por Mapi para entrenadores.');
    const equipo = await resolverEquipo(a, args.equipo);
    const pedida = args.fecha ?? a.hoy;
    if (!esFechaIso(pedida)) return { ok: false, motivo: 'La fecha tiene que venir como AAAA-MM-DD.' };
    // La MISMA ventana de la pantalla: futuro no, el coach hasta los días que dejó la escuela.
    const f = await resolverFechaDeTrabajo(pedida, a.rol === 'admin' ? 'admin' : 'coach', a.schoolId);
    if (!f.ok) return { ok: false, motivo: String((f.body as any)?.error ?? 'Esa fecha no se puede cargar.') };
    const fecha = f.date;
    const dia = fechaLarga(fecha);

    const l = await leerLista(a, equipo.id, fecha);
    if (l.sesion.tipo === 'varias') return { ok: false, motivo: `${equipo.nombre} tiene varios bloques el ${dia}. Pasa esa lista desde la app eligiendo el bloque.` };
    if (l.sesion.tipo === 'una' && l.sesion.cerrada) {
        return { ok: false, motivo: `La lista de ${equipo.nombre} del ${dia} ya está cerrada. Para cambiarla hay que reabrirla desde la app.` };
    }
    if (!l.miembros.length) return { ok: false, motivo: `${equipo.nombre} no tiene deportistas activos en la lista del ${dia}.` };

    const noEsta = (quien: string) => `${quien} no está en la lista de ${equipo.nombre} del ${dia} (puede estar en pausa o en otro equipo). Revísalo con asistencia_de_sesion.`;
    const presentes = resolverEnLista(args.presentes, l.miembros, noEsta);
    const ausentes = resolverEnLista(args.ausentes, l.miembros, noEsta);
    const excusados = resolverEnLista(args.excusados, l.miembros, noEsta);
    sinRepetidos({ presentes, ausentes, excusados });

    const explicito = new Map<string, 'present' | 'absent' | 'excused'>();
    for (const m of presentes) explicito.set(m.clave, 'present');
    for (const m of ausentes) explicito.set(m.clave, 'absent');
    for (const m of excusados) explicito.set(m.clave, 'excused');

    // Igual que la pantalla: lo ya guardado se respeta; quien avisó arranca en «Excusa».
    const final = new Map<string, string>();
    const cambios: Cambio[] = [];
    const porAviso: Miembro[] = [];
    const contraAviso: Miembro[] = [];
    let conservadas = 0;
    for (const m of l.miembros) {
        const antes = l.marcas.get(m.clave) ?? null;
        let nuevo = explicito.get(m.clave);
        if (nuevo && nuevo !== 'excused' && l.avisos.has(m.clave) && antes !== nuevo) contraAviso.push(m);
        if (!nuevo && antes) conservadas++;
        if (!nuevo && !antes && args.los_demas !== 'sin_cambios') {
            nuevo = l.avisos.has(m.clave) ? 'excused' : args.los_demas === 'presentes' ? 'present' : 'absent';
            if (nuevo === 'excused') porAviso.push(m);
        }
        if (nuevo) final.set(m.clave, nuevo);
        else if (antes) final.set(m.clave, antes);
        if (nuevo && nuevo !== antes) cambios.push({ m, nuevo, antes });
    }
    if (!cambios.length) return { ok: false, motivo: `La lista de ${equipo.nombre} del ${dia} ya está así: no hay nada que cambiar.` };

    const creditos = await vistaDeCreditos(a.schoolId, fecha, cambios);
    return {
        ok: true,
        x: {
            equipo, fecha, esRetroactiva: f.esRetroactiva, sesionId: l.sesion.tipo === 'una' ? l.sesion.id : null, l, final, cambios,
            porAviso, contraAviso, conservadas, creditos,
            args: {
                equipo: equipo.id, fecha,
                presentes: presentes.map((m) => m.clave), ausentes: ausentes.map((m) => m.clave), excusados: excusados.map((m) => m.clave),
                los_demas: args.los_demas,
            },
        },
    };
}

const primeros = (ms: { nombre: string }[], n = 4) => `${ms.slice(0, n).map((m) => m.nombre).join(', ')}${ms.length > n ? ` y ${ms.length - n} más` : ''}`;

/** Conteo de la lista como quedaría. «Vinieron» incluye a los que llegaron tarde (resumir de la V2). */
function conteoFinal(x: ArmadoAsistencia) {
    const c = { vinieron: 0, faltaron: 0, excusas: 0, sinMarca: 0 };
    for (const m of x.l.miembros) {
        const s = x.final.get(m.clave);
        if (s === 'present' || s === 'late') c.vinieron++;
        else if (s === 'absent') c.faltaron++;
        else if (s === 'excused') c.excusas++;
        else c.sinMarca++;
    }
    return c;
}

function vistaAsistencia(x: ArmadoAsistencia) {
    const c = conteoFinal(x);
    const cr = x.creditos;
    return {
        titulo: `Lista de ${x.equipo.nombre}`,
        lineas: [
            `${capital(fechaLarga(x.fecha))}${x.esRetroactiva ? ' (día pasado)' : ''}`,
            `Vinieron ${c.vinieron} · faltaron ${c.faltaron} · con excusa ${c.excusas}${c.sinMarca ? ` · sin marca ${c.sinMarca}` : ''}`,
            ...(x.porAviso.length ? [`Con excusa porque avisaron que no venían: ${primeros(x.porAviso)}.`] : []),
            ...(x.contraAviso.length ? [`${primeros(x.contraAviso)} tenía aviso de ausencia y queda como lo marcaste.`] : []),
            ...(x.conservadas ? [`${plural(x.conservadas, 'deportista ya tenía', 'deportistas ya tenían')} marca y no cambia.`] : []),
            ...(c.sinMarca ? ['Quien quede sin marca pasa a «Faltó» cuando se cierre la lista.'] : []),
            ...(cr.descuentan ? [`${plural(cr.descuentan, 'deportista descuenta', 'deportistas descuentan')} una clase de su plan (si tenía reserva ese día, se usa la reserva).`] : []),
            ...(cr.sinSaldo ? [`${plural(cr.sinSaldo, 'deportista no tiene', 'deportistas no tienen')} clases disponibles o tiene el plan vencido: la asistencia queda igual y se le avisa a la familia.`] : []),
            ...(cr.devuelven ? [`${plural(cr.devuelven, 'deportista recupera', 'deportistas recuperan')} la clase que se le había descontado.`] : []),
            ...(x.esRetroactiva ? ['Es un día pasado: queda registrado quién lo cargó.'] : []),
        ],
        aviso: 'Mientras la lista siga abierta la puedes corregir.',
        detalle: {
            etiqueta: x.cambios.length === 1 ? 'Ver el cambio' : `Ver los ${x.cambios.length} cambios`,
            items: x.cambios
                .map((c) => `${c.m.nombre} · ${ETIQUETA[c.nuevo]}${c.antes ? ` (antes: ${ETIQUETA[c.antes] ?? c.antes})` : ''}`)
                .sort((p, q) => p.localeCompare(q, 'es')),
        },
        botonConfirmar: 'Guardar lista',
    };
}

function registroDe(c: Cambio): RegistroAsistencia {
    return {
        childId: c.m.tipo === 'child' ? c.m.id : undefined,
        userId: c.m.tipo === 'adult' ? c.m.id : undefined,
        unregisteredAthleteId: c.m.tipo === 'unregistered' ? c.m.id : undefined,
        status: c.nuevo,
        // Igual que construirRegistros de la V2: el crédito sale de la inscripción que se ve en la lista.
        enrollmentId: c.m.enrollmentId,
        isSecondary: false,
    };
}

export const registrarAsistencia: HerramientaAccion<ArgsAsistencia> = {
    tipo: 'accion',
    nombre: 'registrar_asistencia',
    descripcion: 'PREPARA la lista de asistencia de un equipo un día (la persona confirma en la tarjeta). Mismo guardado que la pantalla: descuenta o devuelve clases del plan y respeta la ventana para días pasados. Quien avisó que no venía queda con excusa salvo que lo nombres.',
    esquema: {
        type: 'object',
        properties: {
            equipo: { type: 'string', description: 'id o nombre del equipo' },
            fecha: { type: ['string', 'null'], description: 'AAAA-MM-DD; null = hoy' },
            presentes: { type: 'array', items: { type: 'string' }, description: 'ids (o nombres) de los que vinieron' },
            ausentes: { type: 'array', items: { type: 'string' }, description: 'los que faltaron' },
            excusados: { type: 'array', items: { type: 'string' }, description: 'los que faltaron con excusa' },
            los_demas: {
                type: 'string',
                enum: [...LOS_DEMAS_LISTA],
                description: 'Los no nombrados y sin marca: "presentes" («vinieron todos menos…»), "ausentes" («solo vinieron…») o "sin_cambios" (solo los nombrados)',
            },
        },
        required: ['equipo', 'fecha', 'presentes', 'ausentes', 'excusados', 'los_demas'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    habilitada: habilitadaAsistencia,
    validar(args) {
        const r = esquemaAsistencia.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos para la lista: equipo, fecha (o null para hoy), presentes, ausentes, excusados y qué hacer con los demás.');
        return r.data;
    },
    async preparar(a, args) {
        const r = await armarAsistencia(a, args);
        if (!r.ok) return r;
        const { x } = r;
        return {
            ok: true,
            // Ya resuelto: el equipo por id, la fecha fija y los nombres como ids.
            args: x.args,
            vista: vistaAsistencia(x),
            targetKey: `asistencia:${x.equipo.id}:${x.fecha}`,
            huella: {
                equipo: x.equipo.id,
                fecha: x.fecha,
                sesion: x.sesionId,
                cambios: x.cambios.map((c) => [c.m.clave, c.nuevo, c.antes, c.m.enrollmentId]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))),
            },
        };
    },
    async ejecutar(a, args) {
        // Se vuelve a armar: si la lista cambió en la app entre la vista y el clic, se escribe lo de ahora.
        const r = await armarAsistencia(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const res = await guardarSesionAsistencia({
            schoolId: a.schoolId, teamId: x.equipo.id, date: x.fecha, esRetroactiva: x.esRetroactiva,
            records: x.cambios.map(registroDe), markedBy: a.userId,
        });
        if (!res.ok) return { estado: 'failed', resultado: { motivo: String((res.body as any)?.error ?? 'No se pudo guardar la lista.') } };

        const outcomes = Object.values(res.creditOutcomes) as CreditOutcome[];
        const creditos = {
            descontadas: outcomes.filter((o) => o === 'deducted').length,
            con_reserva: outcomes.filter((o) => o === 'covered_by_booking').length,
            sin_clases: outcomes.filter((o) => o === 'no_credits' || o === 'expired').length,
            devueltas: outcomes.filter((o) => o === 'returned' || o === 'booking_released').length,
        };
        // Igual que POST /attendance/session: reescribir un día pasado mueve créditos y queda auditado.
        if (x.esRetroactiva) {
            await writeAudit(
                { userId: a.userId, schoolId: a.schoolId, role: a.rol, userAgent: 'mapi-agente' },
                'attendance_backdated', 'attendance_sessions', res.sessionId, null,
                { fecha_registrada: x.fecha, fecha_real: a.hoy, team_id: x.equipo.id, registros: x.cambios.length, creditos: res.creditOutcomes },
                { metadata: { via: 'mapi' } },
            );
        }
        const c = conteoFinal(x);
        return {
            estado: 'executed',
            resultado: {
                equipo: x.equipo.nombre, fecha: x.fecha, sesion_creada: res.sesionCreada, cambios: x.cambios.length,
                vinieron: c.vinieron, faltaron: c.faltaron, excusas: c.excusas, sin_marca: c.sinMarca, creditos,
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se guardó la lista. ${x.motivo || 'Intenta de nuevo o hazlo desde la app.'}`.trim();
        const partes = [`vinieron ${x.vinieron}`, `faltaron ${x.faltaron}`, ...(x.excusas ? [`con excusa ${x.excusas}`] : []), ...(x.sin_marca ? [`sin marca ${x.sin_marca}`] : [])];
        const base = `Quedó guardada la lista de ${x.equipo} del ${fechaLarga(x.fecha)}: ${partes.join(', ')}.`;
        const sin = x.creditos?.sin_clases ?? 0;
        return sin ? `${base} ${plural(sin, 'deportista no tenía', 'deportistas no tenían')} clases disponibles en su plan: la asistencia quedó y se le avisó a la familia.` : base;
    },
};

// ─── evaluar_entreno ────────────────────────────────────────────────────────

/** Escala de «Evaluar al equipo» (coachV2Logic.EFFORT_DE): Bien · Normal · Le costó. */
export const EFFORT = { bien: 90, normal: 70, le_costo: 60 } as const;
export type Como = keyof typeof EFFORT;
const ETIQUETA_COMO: Record<Como, string> = { bien: 'Bien', normal: 'Normal', le_costo: 'Le costó' };

/** Lo ya guardado → Bien / Normal / Le costó (coachV2Logic.comoDesdeEffort). Pura. */
export function comoDesdeEffort(v: unknown): Como | null {
    const n = Number(v);
    if (v === null || v === undefined || !Number.isFinite(n)) return null;
    return n >= 80 ? 'bien' : n >= 70 ? 'normal' : 'le_costo';
}

export const LOS_DEMAS_EVALUACION = ['normal', 'bien', 'sin_cambios'] as const;

export interface ArgsEvaluar {
    equipo: string;
    fecha?: string;
    bien: string[];
    le_costo: string[];
    los_demas: (typeof LOS_DEMAS_EVALUACION)[number];
    nota?: string;
}

const esquemaEvaluar = z.object({
    equipo: z.string().trim().min(2).max(80),
    fecha: z.string().trim().nullish().transform((v) => v || undefined),
    bien: listaDeNombres,
    le_costo: listaDeNombres,
    los_demas: z.enum(LOS_DEMAS_EVALUACION),
    nota: z.string().trim().max(500).nullish().transform((v) => v || undefined),
});

interface Evaluable { clave: string; tipo: 'child' | 'adult'; id: string; nombre: string }

interface ArmadoEvaluar {
    equipo: Equipo;
    fecha: string;
    sesionId: string;
    evaluables: Evaluable[];
    final: Map<string, Como>;
    envios: { e: Evaluable; como: Como; antes: Como | null }[];
    sinCuenta: number;
    conInforme: Evaluable[];
    args: Required<Omit<ArgsEvaluar, 'fecha' | 'nota'>> & { fecha: string; nota?: string };
}

/** ¿Es entrenador asignado del equipo? El mismo cruce que hace la RPC (school_staff activo + team_coaches). */
async function esEntrenadorDelEquipo(a: Alcance, teamId: string): Promise<boolean> {
    const { data: staff, error } = await supabase.from('school_staff').select('id')
        .eq('coach_auth_id', a.userId).eq('school_id', a.schoolId).eq('status', 'active').limit(5);
    if (error) throw new Error(`school_staff: ${error.message}`);
    const ids = ((staff as any[]) ?? []).map((s) => String(s.id));
    if (!ids.length) return false;
    const { data: tc, error: errTc } = await supabase.from('team_coaches').select('id').eq('team_id', teamId).in('coach_id', ids).limit(1);
    if (errTc) throw new Error(`team_coaches: ${errTc.message}`);
    return ((tc as any[]) ?? []).length > 0;
}

async function armarEvaluacion(a: Alcance, args: ArgsEvaluar): Promise<{ ok: true; x: ArmadoEvaluar } | { ok: false; motivo: string }> {
    const equipo = await resolverEquipo(a, args.equipo);
    const fecha = args.fecha ?? a.hoy;
    if (!esFechaIso(fecha)) return { ok: false, motivo: 'La fecha tiene que venir como AAAA-MM-DD.' };
    if (fecha > a.hoy) return { ok: false, motivo: 'No se puede evaluar un entreno que todavía no pasó.' };
    const dia = fechaLarga(fecha);

    if (!(await esEntrenadorDelEquipo(a, equipo.id))) {
        return { ok: false, motivo: `Solo el entrenador asignado a ${equipo.nombre} puede evaluar su entreno (en la app funciona igual). Pídele a la administración que te asigne.` };
    }
    const lookup = await findTeamSessionOfDay(equipo.id, fecha);
    if (lookup.kind === 'none') return { ok: false, motivo: `No hay lista de ${equipo.nombre} el ${dia}: primero se pasa lista.` };
    if (lookup.kind === 'many') return { ok: false, motivo: `${equipo.nombre} tiene varios bloques el ${dia}. Evalúa desde la app eligiendo el bloque.` };
    if (lookup.session.finalized !== true) {
        return { ok: false, motivo: `La lista de ${equipo.nombre} del ${dia} sigue abierta. Ciérrala primero en la app («Cerrar y evaluar»): solo se evalúa a los que vinieron.` };
    }
    const sesionId = String(lookup.session.id);

    const [{ data: regs, error: errRegs }, { data: previas, error: errPrev }] = await Promise.all([
        supabase.from('attendance_records').select('child_id, user_id, unregistered_athlete_id, status')
            .eq('school_id', a.schoolId).eq('session_id', sesionId).in('status', ['present', 'late']).limit(500),
        supabase.from('performance_entries').select('subject_type, subject_id, value')
            .eq('school_id', a.schoolId).eq('context_type', 'session').eq('context_id', sesionId).eq('metric_key', 'coach_effort_rating').limit(500),
    ]);
    if (errRegs) throw new Error(`attendance_records: ${errRegs.message}`);
    if (errPrev) throw new Error(`performance_entries: ${errPrev.message}`);

    // Como la pantalla: solo los que vinieron (presente o tarde) y con cuenta (la RPC no evalúa fichas sin cuenta).
    let sinCuenta = 0;
    const ids = idsVacios();
    const vistos = new Map<string, { tipo: 'child' | 'adult'; id: string }>();
    for (const r of (regs as any[]) ?? []) {
        const k = claveDeFila(r);
        if (!k) continue;
        if (k.tipo === 'unregistered') { sinCuenta++; continue; }
        if (vistos.has(k.clave)) continue;
        vistos.set(k.clave, { tipo: k.tipo, id: k.id });
        ids[k.tipo].add(k.id);
    }
    const nombres = await nombresDe(ids);
    const evaluables: Evaluable[] = [...vistos.entries()]
        .map(([clave, v]) => ({ clave, ...v, nombre: nombres.get(clave) ?? 'Deportista' }))
        .sort((p, q) => p.nombre.localeCompare(q.nombre, 'es'));
    if (!evaluables.length) return { ok: false, motivo: `Nadie con cuenta vino al entreno de ${equipo.nombre} del ${dia}: no hay a quién evaluar.` };

    const antes = new Map<string, Como>();
    for (const p of (previas as any[]) ?? []) {
        const como = comoDesdeEffort(p.value);
        if (como) antes.set(`${p.subject_type === 'child' ? 'child' : 'adult'}:${p.subject_id}`, como);
    }

    const noVino = (quien: string) => `${quien} no figura entre los que vinieron al entreno de ${equipo.nombre} del ${dia} (o es una ficha sin cuenta): solo se evalúa a los que vinieron.`;
    const bien = resolverEnLista(args.bien, evaluables, noVino);
    const leCosto = resolverEnLista(args.le_costo, evaluables, noVino);
    sinRepetidos({ bien, 'le costó': leCosto });
    const explicito = new Map<string, Como>([...bien.map((e) => [e.clave, 'bien'] as const), ...leCosto.map((e) => [e.clave, 'le_costo'] as const)]);

    // Igual que la pantalla: lo ya evaluado se respeta y el resto arranca en «Normal»; «A todos: Bien» pisa todo.
    const final = new Map<string, Como>();
    for (const e of evaluables) {
        const previa = antes.get(e.clave) ?? null;
        const como = explicito.get(e.clave)
            ?? (args.los_demas === 'bien' ? 'bien' : args.los_demas === 'normal' ? (previa ?? 'normal') : previa ?? undefined);
        if (como) final.set(e.clave, como);
    }

    // Un informe del mes ya publicado no se puede tocar (la RPC rechaza TODO el lote): se deja por fuera y se dice.
    const [anio, mes] = fecha.split('-').map(Number);
    const candidatos = evaluables.filter((e) => final.get(e.clave) && final.get(e.clave) !== (antes.get(e.clave) ?? null));
    const conInforme: Evaluable[] = [];
    if (candidatos.length) {
        const { data: informes, error: errInf } = await supabase.from('athlete_reports').select('subject_type, subject_id')
            .eq('school_id', a.schoolId).eq('status', 'publicado').eq('period_year', anio).eq('period_month', mes)
            .in('subject_id', candidatos.map((e) => e.id));
        if (errInf) throw new Error(`athlete_reports: ${errInf.message}`);
        const publicados = new Set(((informes as any[]) ?? []).map((r) => `${r.subject_type === 'child' ? 'child' : 'adult'}:${r.subject_id}`));
        for (const e of candidatos) if (publicados.has(e.clave)) conInforme.push(e);
    }
    const bloqueados = new Set(conInforme.map((e) => e.clave));
    for (const e of conInforme) {
        if (explicito.has(e.clave)) return { ok: false, motivo: `${e.nombre} ya tiene publicado el informe de ${nombreDelMes(fecha.slice(0, 7))}: su evaluación de ese mes ya no se puede cambiar.` };
    }
    const envios = candidatos.filter((e) => !bloqueados.has(e.clave))
        .map((e) => ({ e, como: final.get(e.clave)!, antes: antes.get(e.clave) ?? null }));
    if (!envios.length && !args.nota) {
        return { ok: false, motivo: conInforme.length
            ? 'Los informes de ese mes ya se publicaron: esa evaluación ya no se puede cambiar.'
            : `El entreno de ${equipo.nombre} del ${dia} ya está evaluado así: no hay nada que cambiar.` };
    }
    for (const e of conInforme) {
        const previa = antes.get(e.clave);
        if (previa) final.set(e.clave, previa);
        else final.delete(e.clave);
    }

    return {
        ok: true,
        x: {
            equipo, fecha, sesionId, evaluables, final, envios, sinCuenta, conInforme,
            args: {
                equipo: equipo.id, fecha, bien: bien.map((e) => e.clave), le_costo: leCosto.map((e) => e.clave), los_demas: args.los_demas,
                ...(args.nota ? { nota: args.nota } : {}),
            },
        },
    };
}

function vistaEvaluacion(x: ArmadoEvaluar, nota?: string) {
    const c = { bien: 0, normal: 0, le_costo: 0, sin: 0 };
    for (const e of x.evaluables) {
        const como = x.final.get(e.clave);
        if (como) c[como]++;
        else c.sin++;
    }
    return {
        titulo: `Evaluar el entreno de ${x.equipo.nombre}`,
        lineas: [
            capital(fechaLarga(x.fecha)),
            `Bien ${c.bien} · Normal ${c.normal} · Le costó ${c.le_costo}${c.sin ? ` · sin evaluar ${c.sin}` : ''}`,
            'Es lo que la familia ve como «Así le fue».',
            ...(nota ? [`Nota para las familias: «${recortar(nota, 200)}»`] : []),
            ...(x.conInforme.length ? [`${primeros(x.conInforme)}: el informe del mes ya se publicó y su evaluación no cambia.`] : []),
            ...(x.sinCuenta ? [`${plural(x.sinCuenta, 'ficha sin cuenta no se evalúa', 'fichas sin cuenta no se evalúan')} (igual que en la app).`] : []),
        ],
        aviso: 'Puedes cambiarla después.',
        detalle: x.envios.length ? {
            etiqueta: x.envios.length === 1 ? 'Ver el cambio' : `Ver los ${x.envios.length} cambios`,
            items: x.envios
                .map((v) => `${v.e.nombre} · ${ETIQUETA_COMO[v.como]}${v.antes ? ` (antes: ${ETIQUETA_COMO[v.antes]})` : ''}`)
                .sort((p, q) => p.localeCompare(q, 'es')),
        } : null,
        botonConfirmar: 'Guardar evaluación',
    };
}

/** El error de la RPC en palabras de la pantalla (coachV2Logic.mensajeErrorEvaluar). */
function motivoEvaluar(error: any): string {
    const code = String(error?.code ?? '');
    const msg = String(error?.message ?? '').trim();
    if (code === '42501') return 'no figuras como entrenador de este equipo. Pídele a la administración que te asigne.';
    if (code === 'P0002') return 'ese entreno ya no existe.';
    if (msg && ['55000', '22023', 'P0001'].includes(code)) return msg;
    return 'error del servidor al guardar la evaluación.';
}

export const evaluarEntreno: HerramientaAccion<ArgsEvaluar> = {
    tipo: 'accion',
    nombre: 'evaluar_entreno',
    descripcion: 'PREPARA «cómo le fue» a los que vinieron a un entreno con la lista cerrada: Bien, Normal o Le costó (la persona confirma en la tarjeta). Sirve para todo el equipo o para uno solo. Solo el entrenador asignado al equipo.',
    esquema: {
        type: 'object',
        properties: {
            equipo: { type: 'string', description: 'id o nombre del equipo' },
            fecha: { type: ['string', 'null'], description: 'AAAA-MM-DD del entreno; null = hoy' },
            bien: { type: 'array', items: { type: 'string' }, description: 'ids (o nombres) a los que les fue bien' },
            le_costo: { type: 'array', items: { type: 'string' }, description: 'a los que les costó' },
            los_demas: {
                type: 'string',
                enum: [...LOS_DEMAS_EVALUACION],
                description: 'Los no nombrados: "normal" (lo ya evaluado se respeta), "bien" (a todos) o "sin_cambios" (solo los nombrados)',
            },
            nota: { type: ['string', 'null'], description: 'Nota opcional para las familias' },
        },
        required: ['equipo', 'fecha', 'bien', 'le_costo', 'los_demas', 'nota'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    // La RPC autoriza con auth.uid(): sin la sesión de la persona no se ofrece.
    habilitada: (a) => !!sesionDe(a),
    validar(args) {
        const r = esquemaEvaluar.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos para evaluar: equipo, fecha (o null para hoy), bien, le_costo y qué hacer con los demás.');
        return r.data;
    },
    async preparar(a, args) {
        const r = await armarEvaluacion(a, args);
        if (!r.ok) return r;
        const { x } = r;
        return {
            ok: true,
            args: x.args,
            vista: vistaEvaluacion(x, x.args.nota),
            targetKey: `evaluar:${x.sesionId}`,
            huella: {
                sesion: x.sesionId,
                envios: x.envios.map((v) => [v.e.clave, v.como, v.antes]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))),
                nota: x.args.nota ?? null,
            },
        };
    },
    async ejecutar(a, args) {
        const r = await armarEvaluacion(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const { data, error } = await comoLaPersona(a).rpc('submit_post_training_coach_rating', {
            p_session_id: x.sesionId,
            p_ratings: x.envios.map((v) => ({ ...(v.e.tipo === 'child' ? { child_id: v.e.id } : { user_id: v.e.id }), effort_pct: EFFORT[v.como] })),
            p_coach_notes: x.args.nota ?? null,
        });
        if (error) return { estado: 'failed', resultado: { motivo: `No se guardó: ${motivoEvaluar(error)}` } };
        return {
            estado: 'executed',
            resultado: {
                equipo: x.equipo.nombre, fecha: x.fecha,
                guardados: Number((data as any)?.saved ?? x.envios.length),
                pendientes: Number((data as any)?.pending ?? 0),
                con_nota: !!x.args.nota,
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return x.motivo || 'No se guardó la evaluación.';
        if (!x.guardados && x.con_nota) return `Quedó guardada la nota para las familias del entreno de ${x.equipo} del ${fechaLarga(x.fecha)}.`;
        const base =`Quedó guardada la evaluación del entreno de ${x.equipo} del ${fechaLarga(x.fecha)} (${plural(x.guardados, 'deportista', 'deportistas')}${x.con_nota ? ', con la nota para las familias' : ''}).`;
        return x.pendientes ? `${base} Faltan ${x.pendientes} por evaluar.` : base;
    },
};

// ─── felicitar ──────────────────────────────────────────────────────────────

export interface ArgsFelicitar { deportista: string; mensaje: string }

/** Columna de athlete_kudos según el tipo de deportista. */
const COL_KUDOS: Record<TipoDeportista, 'child_id' | 'athlete_user_id' | 'unregistered_athlete_id'> = {
    child: 'child_id', adult: 'athlete_user_id', unregistered: 'unregistered_athlete_id',
};

const DESTINO_KUDOS: Record<TipoDeportista, string> = {
    child: 'Le llega a su familia como notificación en la app.',
    adult: 'Le llega como notificación en la app.',
    unregistered: 'Le llega a la cuenta vinculada a la ficha, si tiene.',
};

/** El error de give_kudos en palabras de la pantalla (v2Contratos.mensajeDe). */
function motivoKudos(error: any, nombre: string): string {
    const code = String(error?.code ?? '');
    if (String(error?.message ?? '').includes('KUDOS_DAILY_LIMIT')) return `${nombre} ya recibió una felicitación hoy. Mañana se puede otra vez.`;
    if (code === '42501') return 'No tienes permiso para felicitar a este deportista.';
    if (['PGRST202', '42883'].includes(code)) return 'Felicitar todavía no está disponible en esta escuela.';
    if (code === '22023') return String(error?.message ?? 'Revisa los datos.');
    return 'No se pudo enviar la felicitación.';
}

export const felicitar: HerramientaAccion<ArgsFelicitar> = {
    tipo: 'accion',
    nombre: 'felicitar',
    descripcion: 'PREPARA una felicitación del entrenador a un deportista (la persona confirma en la tarjeta); a la familia le llega en la app. Una por deportista al día; el mensaje, corto (máx. 200 caracteres).',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' },
            mensaje: { type: 'string', description: 'Texto de la felicitación, máx. 200 caracteres' },
        },
        required: ['deportista', 'mensaje'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    // give_kudos autoriza con auth.uid(): sin la sesión de la persona no se ofrece.
    habilitada: (a) => !!sesionDe(a),
    validar(args) {
        const r = z.object({ deportista: z.string().min(5).max(80), mensaje: z.string().trim().min(1).max(200) }).safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Falta el deportista o el mensaje (entre 1 y 200 caracteres).');
        return r.data;
    },
    async preparar(a, args) {
        const d = await resolverDeportista(a, args.deportista);
        const { data, error } = await supabase.from('athlete_kudos').select('id')
            .eq('school_id', a.schoolId).eq(COL_KUDOS[d.tipo], d.id).eq('kudos_date', a.hoy).limit(1);
        if (error) {
            if (/42P01|PGRST205|does not exist|schema cache/i.test(`${(error as any).code ?? ''} ${error.message}`)) {
                return { ok: false, motivo: 'Felicitar todavía no está disponible en esta escuela.' };
            }
            throw new Error(`athlete_kudos: ${error.message}`);
        }
        if (((data as any[]) ?? []).length) return { ok: false, motivo: `${d.nombre} ya recibió una felicitación hoy. Mañana se puede otra vez.` };
        return {
            ok: true,
            args: { deportista: d.clave, mensaje: args.mensaje },
            vista: {
                titulo: `Felicitar a ${d.nombre}`,
                lineas: [`«${args.mensaje}»`, DESTINO_KUDOS[d.tipo], 'Sale a tu nombre.'],
                aviso: 'Una felicitación por deportista al día.',
                botonConfirmar: 'Felicitar',
            },
            targetKey: `felicitar:${d.clave}`,
            huella: { deportista: d.clave, mensaje: args.mensaje },
        };
    },
    async ejecutar(a, args) {
        const d = await resolverDeportista(a, args.deportista);
        const { data, error } = await comoLaPersona(a).rpc('give_kudos', {
            p_school_id: a.schoolId,
            p_child_id: d.tipo === 'child' ? d.id : null,
            p_athlete_user_id: d.tipo === 'adult' ? d.id : null,
            p_unregistered_athlete_id: d.tipo === 'unregistered' ? d.id : null,
            p_message: args.mensaje,
        });
        if (error) return { estado: 'failed', resultado: { motivo: motivoKudos(error, d.nombre) } };
        return { estado: 'executed', resultado: { nombre: d.nombre, kudos_id: data ?? null } };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se envió la felicitación. ${x.motivo || ''}`.trim();
        return `Se envió la felicitación a ${x.nombre}.`;
    },
};

// ─── Catálogo del módulo ────────────────────────────────────────────────────

export const HERRAMIENTAS_ENTRENADOR: Herramienta[] = [
    equiposYHorarios,
    asistenciaDeSesion,
    semanaDelEquipo,
    registrarAsistencia,
    evaluarEntreno,
    felicitar,
];
