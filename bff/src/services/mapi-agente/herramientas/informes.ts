/**
 * Oleada 4 — informes, torneos y clase de prueba (plan §19.4, fila 4; spec
 * mapi-asistente-por-rol §4.3). Admin con toda la escuela; coach con sus
 * equipos y sin plata.
 *
 * Una herramienta por acción de pantalla, sobre el MISMO servicio o la MISMA
 * RPC de la pantalla:
 *
 *   · generar_reporte
 *       asistencia    → `historialDeAsistencia` (routes/attendance.ts, lo de
 *                       GET /attendance/history, extraído sin cambiarlo). El coach
 *                       solo con uno de sus equipos y sin la parte de planes.
 *       inscripciones → `ocupacionYCrecimiento` (routes/reports.ts, la parte de
 *                       inscripciones de GET /reports/school/summary). Solo admin.
 *       cartera       → `armarInformeCartera` (el informe de Finanzas › Cartera). Solo admin.
 *     Devuelve cifras y el ENLACE de la pantalla donde se descarga; no arma archivos.
 *   · informes_del_atleta → athlete_reports (mismas columnas del tablero de
 *     Informe mensual). El coach, con la regla de `coach_can_see_report`.
 *   · enviar_informe_atleta → `deliverPublishedReports` con `reportIds`, el mismo
 *     envío puntual de POST /school/reports/send (coach: solo con
 *     reports_release_by = 'coach' y solo sus equipos).
 *   · torneos → la lista de GET /events/school-tournaments + inscritos.
 *   · convocar_a_torneo → `addFromSchool` (tournament-players.service): «Traer de
 *     la escuela» a la nómina de un equipo del torneo. Sin aviso ni cobro.
 *   · inscribir_a_torneo → `inscribirAtletaDesdeLaEscuela` (routes/events.route.ts,
 *     lo de POST /school-tournaments/:id/register-athlete): soportes, RPC
 *     `school_register_athlete_for_tournament` y aviso a la familia. Crea un
 *     COBRO por deportista si el torneo es pago: nace apagada (MAPI_INSCRIBIR_TORNEO).
 *   · clases_de_prueba → RPC `clases_prueba_semana` (+ `listar_clase_prueba` para
 *     la administración), las de «Semana» del profe y la pestaña «Clase de prueba».
 *   · agendar_clase_de_prueba → RPC `agendar_clase_prueba_desde_chat`, el
 *     «Agendar» del buzón de WhatsApp, sin pago.
 *
 * Las RPC de torneos y de clase de prueba autorizan con auth.uid(): se llaman
 * COMO LA PERSONA con el header Authorization que el integrador suma al Alcance
 * (`authorization`, mismo campo que herramientas/entrenador.ts). Sin él, esas
 * herramientas no se ofrecen.
 *
 * Datos mínimos (§12.1): nombres, ids, estados y fechas. Nunca teléfonos,
 * correos, documentos, notas de la familia ni datos médicos. Todo texto de la
 * base es DATO.
 */

import { z } from 'zod';
import type { Request } from 'express';
import { supabase } from '../../../config/supabase';
import { userClient } from '../../../utils/userClient';
import { motivoDeLaPor, rpcPor, type RpcPor } from '../rpc-por';
import { historialDeAsistencia } from '../../../routes/attendance';
import { ocupacionYCrecimiento } from '../../../routes/reports';
import { inscribirAtletaDesdeLaEscuela } from '../../../routes/events.route';
import { armarInformeCartera, etiquetaMes, fmtCop } from '../../informe-cartera.service';
import { deliverPublishedReports } from '../../report-delivery.service';
import { assertTournamentOrganizer, TOURNAMENT_OWNER_ROLES } from '../../tournament/tournament-access';
import { LiveError, listTeams, type LiveEvent } from '../../tournament/tournament-live.service';
import { addFromSchool, categoryLabel } from '../../tournament/tournament-players.service';
import { agrupar, columnaDe, normalizar, resolverDeportista, type Deportista, type TipoDeportista } from '../deportistas';
import { esFechaIso, esMes, fechaLarga, limitesDelMes, nombreDelMes, sumarDias } from '../fechas';
import { RechazoHerramienta, type Alcance, type Herramienta, type HerramientaAccion, type HerramientaConsulta } from '../tipos';

// ─── Utilidades ─────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const dia = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null);
const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
const lista = (nombres: string[], max = 6) =>
    nombres.length <= max ? nombres.join(', ') : `${nombres.slice(0, max).join(', ')} y ${nombres.length - max} más`;

const validarCon = <T>(schema: z.ZodType<T>, mensaje: string) => (args: unknown): T => {
    const r = schema.safeParse(args ?? {});
    if (!r.success) throw new RechazoHerramienta(mensaje);
    return r.data;
};

/** «4:00 p. m.» desde «16:00:00». Pura. */
export function horaCorta(h: unknown): string {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(h ?? ''));
    if (!m) return '';
    const hh = Number(m[1]);
    return `${hh % 12 === 0 ? 12 : hh % 12}:${m[2]} ${hh >= 12 ? 'p. m.' : 'a. m.'}`;
}
const rangoHoras = (ini: unknown, fin: unknown) => [horaCorta(ini), horaCorta(fin)].filter(Boolean).join(' a ');

// ─── Sesión de la persona (RPC que autorizan con auth.uid()) ────────────────

/**
 * El integrador suma al Alcance el header Authorization de la request (el del
 * turno y el del Confirmar). Nunca se guarda en el borrador ni va al modelo.
 * Hoy solo lo usa inscribir_a_torneo (la ruta del torneo, sin `_por`). Las
 * clases de prueba y agendar van por su `_por` (rpc-por.ts), con o sin JWT.
 */
export type AlcanceConSesion = Alcance & { authorization?: string | null };

export function sesionDe(a: Alcance): string | null {
    const t = (a as AlcanceConSesion).authorization;
    return typeof t === 'string' && /^Bearer\s+\S+$/.test(t.trim()) ? t.trim() : null;
}

/** Cliente de Supabase que actúa COMO la persona (utils/userClient). */
function comoLaPersona(a: Alcance) {
    const auth = sesionDe(a);
    if (!auth) throw new RechazoHerramienta('Esto necesita tu sesión de la app. Hazlo desde la pantalla.');
    return userClient({ headers: { authorization: auth } } as unknown as Request);
}

// ─── Equipos de la escuela ──────────────────────────────────────────────────

interface Equipo { id: string; nombre: string }

async function equiposDelAlcance(a: Alcance): Promise<Equipo[]> {
    if (a.rol === 'coach' && !a.teamIds.length) return [];
    let q = supabase.from('teams').select('id, name').eq('school_id', a.schoolId);
    if (a.rol === 'coach') q = q.in('id', a.teamIds);
    const { data, error } = await q.limit(300);
    if (error) throw new Error(`teams: ${error.message}`);
    return ((data as any[]) ?? [])
        .map((t) => ({ id: String(t.id), nombre: String(t.name ?? '').trim() || 'Equipo sin nombre' }))
        .sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
}

/** Equipo por id o por nombre («sub 12» = «Sub-12»), de esta escuela y, si es coach, de los suyos. */
export async function resolverEquipo(a: Alcance, texto: string): Promise<Equipo> {
    const t = texto.trim();
    if (UUID.test(t)) {
        const id = t.toLowerCase();
        if (a.rol === 'coach' && !a.teamIds.includes(id)) throw new RechazoHerramienta('Ese equipo no está entre los que entrenas.');
        const { data, error } = await supabase.from('teams').select('id, name').eq('school_id', a.schoolId).eq('id', id).maybeSingle();
        if (error) throw new Error(`teams: ${error.message}`);
        if (!data) throw new RechazoHerramienta('No encontré ese equipo en esta escuela.');
        return { id: String((data as any).id), nombre: String((data as any).name ?? '').trim() || 'Equipo sin nombre' };
    }
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
    throw new RechazoHerramienta(`Hay varios equipos que coinciden: ${lista(candidatos.map((e) => e.nombre))}. ¿Cuál?`);
}

// ═══ generar_reporte ═════════════════════════════════════════════════════════

export const TIPOS_REPORTE = ['asistencia', 'inscripciones', 'cartera'] as const;
export type TipoReporte = (typeof TIPOS_REPORTE)[number];
export interface ArgsReporte { tipo: TipoReporte; periodo: string | null; equipo: string | null }

async function reporteAsistencia(a: Alcance, periodo: string, equipoTexto: string | null) {
    let equipo: Equipo | null = equipoTexto ? await resolverEquipo(a, equipoTexto) : null;
    if (!equipo && a.rol === 'coach') {
        // El histórico de toda la escuela es de la administración: el coach, por equipo.
        const mios = await equiposDelAlcance(a);
        if (!mios.length) throw new RechazoHerramienta('Todavía no tienes equipos asignados.');
        if (mios.length > 1) throw new RechazoHerramienta(`¿De cuál equipo? Entrenas ${lista(mios.map((e) => e.nombre), 10)}.`);
        equipo = mios[0];
    }
    const r = await historialDeAsistencia(a.schoolId, { month: periodo, ...(equipo ? { teamId: equipo.id } : {}) });
    if (!r.ok) throw new RechazoHerramienta(r.error);
    const d = r.datos;
    const t = d.totals;
    const f = d.desfases;
    return {
        reporte: 'asistencia',
        mes: nombreDelMes(periodo),
        de: equipo ? equipo.nombre : 'toda la escuela',
        ...(t.records === 0 ? { nota: 'No hay listas de asistencia registradas en ese mes.' } : {}),
        asistencia: {
            porcentaje: t.rate, presentes: t.present, tardes: t.late, faltas: t.absent, excusas: t.excused,
            marcas: t.records, deportistas: t.athletes, dias_con_lista: t.days,
        },
        ...(!equipo && d.contexts.length
            ? { por_grupo: d.contexts.slice(0, 20).map((c) => ({ grupo: c.name, porcentaje: c.rate, deportistas: c.athletes, marcas: c.total })) }
            : {}),
        menos_asistencia: d.athletes
            .filter((x) => x.total >= 3)
            .sort((x, y) => x.rate - y.rate || x.full_name.localeCompare(y.full_name, 'es'))
            .slice(0, 5)
            .map((x) => ({ nombre: x.full_name, porcentaje: x.rate, vino: x.present + x.late, de: x.total })),
        como_se_cuenta: 'Porcentaje = presentes y tardes sobre todas las marcas del mes (la excusa cuenta como no asistió), igual que el Histórico de asistencia.',
        // Planes = cobros: solo la administración.
        ...(a.rol === 'admin' && f && (f.excedidos || f.con_vencido)
            ? {
                fuera_de_plan: {
                    deportistas_que_pasaron_su_plan: f.excedidos, con_plan_vencido: f.con_vencido,
                    clases_de_mas: f.clases_de_mas, clases_con_plan_vencido: f.clases_vencidas, valor: fmtCop(f.valor_total),
                },
            }
            : {}),
        pantalla: a.rol === 'admin'
            ? { nombre: 'Histórico de asistencia', enlace: '/attendance-history', descarga: 'ahí se descarga en CSV' }
            : { nombre: 'Asistencia', enlace: '/coach-attendance' },
    };
}

async function reporteInscripciones(periodo: string, schoolId: string, conEquipo: boolean) {
    const r = await ocupacionYCrecimiento(schoolId, null);
    const i = r.meses.indexOf(periodo);
    const pct = r.realTotalCapacity > 0 ? Number(((r.totalStudents / r.realTotalCapacity) * 100).toFixed(1)) : null;
    return {
        reporte: 'inscripciones',
        inscripciones_activas: r.totalStudents,
        capacidad: r.realTotalCapacity,
        ocupacion_pct: pct,
        mes: i >= 0
            ? { mes: nombreDelMes(periodo), nuevos: r.growthDataList[i].nuevos, retiros: r.growthDataList[i].retiros }
            : null,
        ...(i < 0 ? { nota: `Reportes Gerenciales muestra los últimos 6 meses; ${nombreDelMes(periodo)} no está entre ellos.` } : {}),
        ultimos_6_meses: r.growthDataList.map((g, k) => ({
            mes: r.meses[k] ? nombreDelMes(r.meses[k] as string) : g.month, nuevos: g.nuevos, retiros: g.retiros,
        })),
        ocupacion_por_equipo: r.occupancyData.map((o) => ({ equipo: o.name, inscritos: o.occupied, cupos: o.total_capacity, vacantes: o.vacant })),
        ...(conEquipo ? { nota_equipo: 'Esta pantalla no separa nuevos y retiros por equipo; la ocupación por equipo sí está.' } : {}),
        como_se_cuenta: 'Nuevos: inscripciones creadas ese mes que siguen activas. Retiros: inscripciones creadas ese mes que hoy están inactivas o retiradas. Mismo cálculo de Reportes Gerenciales.',
        pantalla: { nombre: 'Reportes Gerenciales', enlace: '/school-reports', descarga: 'botón «Exportar CSV»' },
    };
}

async function reporteCartera(schoolId: string, periodo: string | null) {
    const inf = await armarInformeCartera(schoolId);
    const m = inf.morosos;
    const delMes = periodo ? m.porMes.find((x) => x.mes === periodo) : null;
    return {
        reporte: 'cartera',
        corte: inf.hoy,
        vencido: { total: fmtCop(m.total), familias: m.familias, deportistas: m.atletas, cobros: m.cobros },
        ...(periodo ? { del_mes: { mes: etiquetaMes(periodo), cobros: delMes?.cobros ?? 0, total: fmtCop(delMes?.total ?? 0) } } : {}),
        por_antiguedad: m.porAntiguedad.map((x) => ({ tramo: x.tramo, cobros: x.cobros, total: fmtCop(x.total) })),
        por_vencer: { total: fmtCop(inf.pendientes.porVencerTotal), familias: inf.pendientes.porVencerFamilias },
        comprobantes_en_revision: { cobros: inf.pendientes.enRevision.length, total: fmtCop(inf.pendientes.enRevisionTotal) },
        detalle: 'Para ver quiénes deben, usa la herramienta cartera.',
        pantalla: { nombre: 'Finanzas › pestaña «Cartera»', enlace: '/finances', descarga: 'botón «Descargar informe» (CSV para Excel)' },
    };
}

export const generarReporte: HerramientaConsulta<ArgsReporte> = {
    tipo: 'consulta',
    nombre: 'generar_reporte',
    descripcion: 'Reporte en cifras con el mismo cálculo de la pantalla, más el enlace de esa pantalla para descargarlo: asistencia de un mes (de un equipo o de la escuela), inscripciones (nuevos, retiros y ocupación) o cartera. El entrenador solo pide asistencia de sus equipos. Si el mes o el equipo no están claros, pregunta.',
    esquema: {
        type: 'object',
        properties: {
            tipo: { type: 'string', enum: [...TIPOS_REPORTE] },
            periodo: { type: ['string', 'null'], description: 'Mes AAAA-MM; null = el mes en curso' },
            equipo: { type: ['string', 'null'], description: 'Id o nombre del equipo; null = toda la escuela' },
        },
        required: ['tipo', 'periodo', 'equipo'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar(args) {
        const r = z.object({
            tipo: z.enum(TIPOS_REPORTE),
            periodo: z.string().trim().nullish(),
            equipo: z.string().trim().max(80).nullish(),
        }).safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Dime qué reporte: asistencia, inscripciones o cartera, y el mes (AAAA-MM).');
        if (r.data.periodo && !esMes(r.data.periodo)) throw new RechazoHerramienta('El mes tiene que venir como AAAA-MM (ej. 2026-11).');
        return { tipo: r.data.tipo, periodo: r.data.periodo || null, equipo: r.data.equipo || null };
    },
    async ejecutar(a, args) {
        if (args.tipo !== 'asistencia' && a.rol !== 'admin') {
            throw new RechazoHerramienta(`El reporte de ${args.tipo} es de la administración. Como entrenador puedes pedir el de asistencia de tus equipos.`);
        }
        const periodo = args.periodo ?? a.hoy.slice(0, 7);
        if (periodo > a.hoy.slice(0, 7)) throw new RechazoHerramienta(`${capital(nombreDelMes(periodo))} todavía no empieza.`);
        if (args.tipo === 'asistencia') return reporteAsistencia(a, periodo, args.equipo);
        if (args.tipo === 'inscripciones') return reporteInscripciones(periodo, a.schoolId, !!args.equipo);
        return reporteCartera(a.schoolId, args.periodo);
    },
};

// ═══ Informe mensual del atleta ══════════════════════════════════════════════

/** athlete_reports.subject_type por tipo de deportista. */
const SUJETO: Record<TipoDeportista, 'child' | 'profile' | 'unregistered'> = { child: 'child', adult: 'profile', unregistered: 'unregistered' };
const ESTADO_INFORME: Record<string, string> = {
    borrador: 'en borrador', listo: 'listo para publicar', publicado: 'publicado', retenido: 'retenido por la escuela',
};
const mesDe = (r: { period_year: number; period_month: number }) => `${r.period_year}-${String(r.period_month).padStart(2, '0')}`;

/**
 * Los informes que el coach ve: los de un deportista que entrenó en alguno de
 * sus equipos EN ESE MES (misma regla que coach_can_see_report, la RLS que usa
 * la pantalla), no solo los del equipo actual.
 */
async function filtrarParaCoach(a: Alcance, d: Deportista, filas: any[]): Promise<any[]> {
    if (!filas.length) return filas;
    const { data, error } = await supabase.from('enrollments').select('start_date, end_date, status')
        .eq('school_id', a.schoolId).eq(columnaDe(d.tipo), d.id).in('team_id', a.teamIds);
    if (error) throw new Error(`enrollments: ${error.message}`);
    const ins = ((data as any[]) ?? []).filter((e) => String(e.status) !== 'cancelled');
    return filas.filter((r) => {
        const { desde, hasta } = limitesDelMes(mesDe(r));
        return ins.some((e) => (!e.start_date || String(e.start_date) <= hasta) && (!e.end_date || String(e.end_date) >= desde));
    });
}

export const informesDelAtleta: HerramientaConsulta<{ deportista: string }> = {
    tipo: 'consulta',
    nombre: 'informes_del_atleta',
    descripcion: 'Informes mensuales de un deportista (los de Informe mensual): de qué meses hay, si están en borrador, publicados o enviados, y si la familia ya los vio.',
    esquema: {
        type: 'object',
        properties: { deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' } },
        required: ['deportista'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar: validarCon(z.object({ deportista: z.string().min(5).max(80) }), 'Falta el deportista: búscalo primero con buscar_deportista.'),
    async ejecutar(a, { deportista }) {
        const d = await resolverDeportista(a, deportista);
        const { data, error } = await supabase.from('athlete_reports')
            .select('period_year, period_month, status, team_id, published_at, sent_at, viewed_at, recipient_id')
            .eq('school_id', a.schoolId).eq('subject_type', SUJETO[d.tipo]).eq('subject_id', d.id)
            .order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(12);
        if (error) throw new Error(`athlete_reports: ${error.message}`);
        let filas = (data as any[]) ?? [];
        if (a.rol === 'coach') filas = await filtrarParaCoach(a, d, filas);

        const equipos = [...new Set(filas.map((r) => r.team_id).filter(Boolean))] as string[];
        const nombres = new Map<string, string>();
        if (equipos.length) {
            const { data: ts } = await supabase.from('teams').select('id, name').eq('school_id', a.schoolId).in('id', equipos);
            for (const t of (ts as any[]) ?? []) nombres.set(t.id, t.name);
        }
        return {
            nombre: d.nombre,
            informes: filas.map((r) => ({
                mes: nombreDelMes(mesDe(r)),
                estado: ESTADO_INFORME[r.status] ?? r.status,
                equipo: nombres.get(r.team_id) ?? null,
                publicado: dia(r.published_at),
                enviado: dia(r.sent_at),
                visto_por_la_familia: dia(r.viewed_at),
                ...(r.status === 'publicado' && !r.recipient_id ? { sin_acudiente_con_cuenta: true } : {}),
            })),
            ...(filas.length === 0 ? { nota: `${d.nombre} no tiene informes mensuales todavía.` } : {}),
            pantalla: { nombre: 'Informe mensual', enlace: '/informe-mensual' },
        };
    },
};

// ─── enviar_informe_atleta ──────────────────────────────────────────────────

export interface ArgsEnviarInforme { deportista: string; mes: string }

interface EnvioArmado {
    d: Deportista;
    informeId: string;
    anio: number;
    mes: number;
    etiqueta: string;
    destinatario: string;
    recipientId: string;
}

async function armarEnvio(a: Alcance, args: ArgsEnviarInforme): Promise<{ ok: true; x: EnvioArmado } | { ok: false; motivo: string }> {
    const d = await resolverDeportista(a, args.deportista);
    const [anio, mes] = args.mes.split('-').map(Number);
    const etiqueta = nombreDelMes(args.mes);

    if (a.rol === 'coach') {
        // Mismo gate de POST /school/reports/send: delegar la liberación no es darle toda la escuela.
        const { data: s } = await supabase.from('school_settings').select('reports_release_by').eq('school_id', a.schoolId).maybeSingle();
        if ((s as any)?.reports_release_by !== 'coach') {
            return { ok: false, motivo: 'En esta escuela el envío de los informes lo hace la administración.' };
        }
    }

    const { data, error } = await supabase.from('athlete_reports')
        // `snapshot` se lee solo para saber si existe (no va al modelo): sin él, el envío
        // falla después del Confirmar («sin snapshot»), y la tarjeta ya prometió el correo.
        .select('id, status, sent_at, recipient_id, team_id, snapshot')
        .eq('school_id', a.schoolId).eq('subject_type', SUJETO[d.tipo]).eq('subject_id', d.id)
        .eq('period_year', anio).eq('period_month', mes).maybeSingle();
    if (error) throw new Error(`athlete_reports: ${error.message}`);
    const inf = data as any;
    if (!inf) return { ok: false, motivo: `${d.nombre} no tiene informe de ${etiqueta}.` };
    if (a.rol === 'coach' && !a.teamIds.includes(inf.team_id)) {
        return { ok: false, motivo: 'Ese informe es de un equipo que no entrenas: lo envía la administración.' };
    }
    if (inf.status !== 'publicado') {
        return { ok: false, motivo: `El informe de ${etiqueta} está ${ESTADO_INFORME[inf.status] ?? inf.status}: primero se publica en Informe mensual.` };
    }
    if (inf.sent_at) return { ok: false, motivo: `El informe de ${etiqueta} ya se envió el ${fechaLarga(String(inf.sent_at).slice(0, 10))}.` };
    if (!inf.snapshot) return { ok: false, motivo: `El informe de ${etiqueta} figura publicado pero no tiene contenido: revísalo en Informe mensual antes de enviarlo.` };
    if (!inf.recipient_id) {
        return { ok: false, motivo: `${d.nombre} no tiene acudiente con cuenta en la app: el informe queda publicado y la familia lo verá cuando active su cuenta.` };
    }
    // El correo se lee para saber si se puede enviar; nunca sale de aquí.
    const { data: perfil } = await supabase.from('profiles').select('email').eq('id', inf.recipient_id).maybeSingle();
    if (!(perfil as any)?.email) return { ok: false, motivo: 'La cuenta que recibe el informe no tiene correo: no se puede enviar.' };

    return {
        ok: true,
        x: { d, informeId: String(inf.id), anio, mes, etiqueta, destinatario: d.tipo === 'child' ? 'la familia' : 'el deportista', recipientId: String(inf.recipient_id) },
    };
}

const MOTIVO_ENVIO: Record<string, string> = {
    'ya lo está enviando otro proceso': 'Ya se estaba enviando en ese momento.',
    'sin acudiente vinculado': 'No tiene acudiente con cuenta en la app.',
    'destinatario sin correo': 'La cuenta que lo recibe no tiene correo.',
    'sin snapshot': 'El informe publicado no tiene contenido: revísalo en Informe mensual.',
};
const motivoEnvio = (r: string | undefined) =>
    !r ? 'Ya no estaba pendiente de envío.' : MOTIVO_ENVIO[r] ?? (r.startsWith('error de envío') ? 'El correo falló; intenta más tarde.' : r);

export const enviarInformeAtleta: HerramientaAccion<ArgsEnviarInforme> = {
    tipo: 'accion',
    nombre: 'enviar_informe_atleta',
    descripcion: 'PREPARA el envío del informe mensual YA PUBLICADO de un deportista a su familia (correo con resumen y enlace, más aviso en la app). Es el mismo «Enviar» de Informe mensual. La persona confirma en la tarjeta.',
    esquema: {
        type: 'object',
        properties: {
            deportista: { type: 'string', description: 'id del deportista (ej. "child:…")' },
            mes: { type: 'string', description: 'Mes del informe, AAAA-MM' },
        },
        required: ['deportista', 'mes'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    validar(args) {
        const r = z.object({ deportista: z.string().min(5).max(80), mes: z.string().trim() }).safeParse(args ?? {});
        if (!r.success || !esMes(r.data.mes)) throw new RechazoHerramienta('Faltan datos: el deportista y el mes del informe (AAAA-MM).');
        return r.data;
    },
    async preparar(a, args) {
        const r = await armarEnvio(a, args);
        if (!r.ok) return r;
        const { x } = r;
        return {
            ok: true,
            args,
            targetKey: `informe:${x.informeId}`,
            vista: {
                titulo: `Enviar el informe de ${x.d.nombre} · ${capital(x.etiqueta)}`,
                lineas: [
                    `Informe mensual de ${x.etiqueta}, ya publicado.`,
                    `A ${x.destinatario} le llega por correo (resumen y enlace) y como aviso en la app.`,
                    'Es el mismo envío del botón «Enviar» de Informe mensual.',
                ],
                aviso: 'El correo sale apenas confirmes y no se puede deshacer.',
                botonConfirmar: 'Enviar',
            },
            huella: { informe: x.informeId, destinatario: x.recipientId, pendiente: true },
        };
    },
    async ejecutar(a, args) {
        const r = await armarEnvio(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const salida = await deliverPublishedReports(a.schoolId, x.anio, x.mes, {
            reportIds: [x.informeId],
            ...(a.rol === 'coach' ? { teamIds: a.teamIds } : {}),
        });
        const fila = salida.results.find((f) => f.report_id === x.informeId);
        if (fila?.sent) return { estado: 'executed', resultado: { nombre: x.d.nombre, mes: x.etiqueta, destinatario: x.destinatario } };
        return { estado: 'failed', resultado: { nombre: x.d.nombre, mes: x.etiqueta, motivo: motivoEnvio(fila?.reason) } };
    },
    mensajeResultado(r, args) {
        const x = r.resultado as any;
        if (r.estado !== 'executed') return `No se envió el informe de ${nombreDelMes(args.mes)}. ${x.motivo || ''}`.trim();
        return `Se envió el informe de ${x.mes} de ${x.nombre}: a ${x.destinatario} le llega por correo y como aviso en la app.`;
    },
};

// ═══ Torneos ═════════════════════════════════════════════════════════════════

const ESTADO_TORNEO: Record<string, string> = {
    draft: 'borrador', active: 'activo', closed: 'cerrado', completed: 'finalizado', cancelled: 'cancelado',
};
export const FILTROS_TORNEO = ['vigentes', 'activos', 'borradores', 'finalizados'] as const;
const ESTADOS_POR_FILTRO: Record<(typeof FILTROS_TORNEO)[number], string[]> = {
    vigentes: ['draft', 'active', 'closed'], activos: ['active'], borradores: ['draft'], finalizados: ['completed', 'cancelled'],
};

/** Precio por deportista con la misma regla de la RPC: la fase vigente más próxima; si no, la última. Pura. */
export function precioVigente(fases: { price_solo?: unknown; valid_until?: unknown }[], hoy: string): number | null {
    const conPrecio = fases.filter((f) => f.price_solo != null);
    const vigente = conPrecio.filter((f) => String(f.valid_until ?? '') >= hoy)
        .sort((x, y) => String(x.valid_until).localeCompare(String(y.valid_until)))[0];
    const ultima = conPrecio.slice().sort((x, y) => String(y.valid_until ?? '').localeCompare(String(x.valid_until ?? '')))[0];
    const f = vigente ?? ultima;
    return f ? Number(f.price_solo) : null;
}

export const torneos: HerramientaConsulta<{ estado: (typeof FILTROS_TORNEO)[number] | null }> = {
    tipo: 'consulta',
    nombre: 'torneos',
    descripcion: 'Torneos que organiza la escuela, con su estado, fechas, inscritos, cupo y valor de inscripción. Devuelve el id que usan convocar_a_torneo e inscribir_a_torneo. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            estado: { type: ['string', 'null'], enum: [...FILTROS_TORNEO, null], description: 'null = todos' },
        },
        required: ['estado'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: validarCon(
        z.object({ estado: z.enum(FILTROS_TORNEO).nullish().transform((v) => v ?? null) }),
        'El estado del torneo no es válido: vigentes, activos, borradores, finalizados o null.',
    ),
    async ejecutar(a, { estado }) {
        let q = supabase.from('events')
            .select('id, title, sport, event_date, end_date, status, tournament_scope, registrations_open, registration_deadline, is_paid, capacity')
            .eq('school_id', a.schoolId).in('creator_role', [...TOURNAMENT_OWNER_ROLES]);
        if (estado) q = q.in('status', ESTADOS_POR_FILTRO[estado]);
        const { data, error } = await q.order('event_date', { ascending: false }).limit(30);
        if (error) throw new Error(`events: ${error.message}`);
        const evs = (data as any[]) ?? [];
        const ids = evs.map((e) => e.id);

        const porEvento = <T,>(filas: any[] | null | undefined) => {
            const m = new Map<string, T[]>();
            for (const f of filas ?? []) m.set(f.event_id, [...(m.get(f.event_id) ?? []), f]);
            return m;
        };
        const [regs, dels, fases] = ids.length
            ? await Promise.all([
                supabase.from('event_registrations').select('event_id, status').in('event_id', ids).neq('status', 'cancelled').limit(5000),
                supabase.from('event_delegations').select('event_id, status').in('event_id', ids).limit(2000),
                supabase.from('event_price_phases').select('event_id, price_solo, valid_until').in('event_id', ids),
            ])
            : [{ data: [] }, { data: [] }, { data: [] }];
        const regsPor = porEvento<any>((regs as any).data);
        const delsPor = porEvento<any>((dels as any).data);
        const fasesPor = porEvento<any>((fases as any).data);

        return {
            torneos: evs.map((e) => {
                const interno = e.tournament_scope === 'internal';
                const precio = e.is_paid === false ? null : precioVigente(fasesPor.get(e.id) ?? [], a.hoy);
                return {
                    id: e.id,
                    nombre: e.title,
                    estado: ESTADO_TORNEO[e.status] ?? e.status,
                    tipo: interno ? 'interno (inscripción por deportista)' : 'externo (inscripción por delegaciones)',
                    deporte: e.sport ?? null,
                    fecha: dia(e.event_date),
                    hasta: dia(e.end_date),
                    inscripciones: e.registrations_open === false ? 'cerradas' : 'abiertas',
                    cierre_inscripciones: dia(e.registration_deadline),
                    ...(interno ? { inscritos: regsPor.get(e.id)?.length ?? 0 } : { delegaciones: delsPor.get(e.id)?.length ?? 0 }),
                    cupo: e.capacity ?? null,
                    inscripcion: e.is_paid === false ? 'gratis' : precio && precio > 0 ? fmtCop(precio) : 'sin tarifa configurada',
                };
            }),
            ...(evs.length === 0 ? { nota: 'La escuela no tiene torneos con ese estado.' } : {}),
            pantalla: { nombre: 'Torneos', enlace: '/school/tournaments' },
        };
    },
};

// ─── convocar_a_torneo ──────────────────────────────────────────────────────

const TOPE_CONVOCAR = 40;

export interface ArgsConvocar { torneo: string; equipo_torneo: string | null; deportistas: string[] }

async function torneoDeLaEscuela(a: Alcance, id: string): Promise<LiveEvent> {
    if (!UUID.test(id)) throw new RechazoHerramienta('Ese id de torneo no es válido. Búscalo con la herramienta torneos.');
    try {
        // El mismo gate de las pantallas de torneos: solo usa la escuela de la sesión.
        return await assertTournamentOrganizer({ schoolId: a.schoolId } as any, id);
    } catch (err) {
        if (err instanceof LiveError) throw new RechazoHerramienta('No encontré ese torneo entre los que organiza tu escuela.');
        throw err;
    }
}

/** Deportistas que nombró el modelo, sin repetir. Los que no se encuentran se reportan, no rompen. */
async function resolverVarios(a: Alcance, claves: string[]): Promise<{ ds: Deportista[]; noEncontrados: number }> {
    const ds: Deportista[] = [];
    let noEncontrados = 0;
    for (const c of [...new Set(claves.map((x) => x.trim()))]) {
        try {
            const d = await resolverDeportista(a, c);
            if (!ds.some((x) => x.clave === d.clave)) ds.push(d);
        } catch (err) {
            if (!(err instanceof RechazoHerramienta)) throw err;
            noEncontrados++;
        }
    }
    return { ds, noEncontrados };
}

/** El equipo de la escuela dentro del torneo: por id, por nombre o el único que haya. */
function elegirEquipoDelTorneo(titulo: string, propios: { id: string; name: string }[], texto: string | null) {
    const nombres = () => lista(propios.map((e) => e.name), 10);
    if (!texto) {
        if (propios.length === 1) return propios[0];
        throw new RechazoHerramienta(`¿A cuál equipo del torneo? ${nombres()}.`);
    }
    const t = texto.trim();
    if (UUID.test(t)) {
        const e = propios.find((x) => x.id === t.toLowerCase());
        if (e) return e;
    } else {
        const exactos = propios.filter((x) => clave(x.name) === clave(t));
        const parecidos = exactos.length ? exactos : propios.filter((x) => clave(x.name).includes(clave(t)));
        if (parecidos.length === 1) return parecidos[0];
        if (parecidos.length > 1) throw new RechazoHerramienta(`Hay varios equipos del torneo que coinciden: ${lista(parecidos.map((x) => x.name))}. ¿Cuál?`);
    }
    throw new RechazoHerramienta(`«${titulo}» no tiene un equipo de la escuela llamado «${t}». Tiene: ${nombres()}.`);
}

interface ConvocatoriaArmada {
    ev: LiveEvent;
    equipo: { id: string; nombre: string };
    nuevos: Deportista[];
    yaEstaban: number;
    noTraibles: string[];
    inactivos: string[];
    noEncontrados: number;
}

async function armarConvocatoria(a: Alcance, args: ArgsConvocar): Promise<{ ok: true; x: ConvocatoriaArmada } | { ok: false; motivo: string }> {
    const ev = await torneoDeLaEscuela(a, args.torneo);
    if (ev.status === 'cancelled' || ev.status === 'completed') {
        return { ok: false, motivo: `«${ev.title}» está ${ESTADO_TORNEO[ev.status]}.` };
    }
    const propios = (await listTeams(ev)).filter((t) => !t.is_external);
    if (!propios.length) return { ok: false, motivo: `«${ev.title}» no tiene equipos de la escuela todavía: créalo en la pantalla del torneo.` };
    const equipo = elegirEquipoDelTorneo(ev.title, propios, args.equipo_torneo);

    const { ds, noEncontrados } = await resolverVarios(a, args.deportistas);
    // «Traer de la escuela» trae hijos (children) activos; adultos y fichas sin cuenta se agregan a mano.
    const noTraibles = ds.filter((d) => d.tipo !== 'child').map((d) => d.nombre);
    const inactivos = ds.filter((d) => d.tipo === 'child' && !d.activo).map((d) => d.nombre);
    const candidatos = ds.filter((d) => d.tipo === 'child' && d.activo);

    const { data, error } = await supabase.from('event_team_members').select('child_id').eq('team_id', equipo.id);
    if (error) throw new Error(`event_team_members: ${error.message}`);
    const ya = new Set(((data as any[]) ?? []).map((r) => r.child_id).filter(Boolean));
    const nuevos = candidatos.filter((d) => !ya.has(d.id)).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
    const yaEstaban = candidatos.length - nuevos.length;

    if (!nuevos.length) {
        const porQue = [
            ...(yaEstaban ? [`${plural(yaEstaban, 'ya estaba', 'ya estaban')} en la nómina de «${equipo.name}».`] : []),
            ...(noTraibles.length ? [`${lista(noTraibles)}: adultos o fichas sin cuenta, se agregan a mano en la nómina.`] : []),
            ...(inactivos.length ? [`${lista(inactivos)}: inactivos en la escuela.`] : []),
            ...(noEncontrados ? [`${plural(noEncontrados, 'deportista no está', 'deportistas no están')} en la escuela.`] : []),
        ];
        return { ok: false, motivo: ['No hay a quién convocar.', ...porQue].join(' ') };
    }
    if (nuevos.length > TOPE_CONVOCAR) return { ok: false, motivo: `Son ${nuevos.length}: el tope por vez es ${TOPE_CONVOCAR}. Divídelo.` };
    return { ok: true, x: { ev, equipo: { id: equipo.id, nombre: equipo.name }, nuevos, yaEstaban, noTraibles, inactivos, noEncontrados } };
}

export const convocarATorneo: HerramientaAccion<ArgsConvocar> = {
    tipo: 'accion',
    nombre: 'convocar_a_torneo',
    descripcion: 'PREPARA CONVOCAR: agrega deportistas a la NÓMINA de un equipo de la escuela ya creado en un torneo que organiza (el «Traer de la escuela» del torneo). No inscribe en categoría, no cobra ni avisa a la familia. Úsala cuando piden «convocar» o «armar la nómina»; para inscribir con cobro es inscribir_a_torneo. La persona confirma en la tarjeta. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            torneo: { type: 'string', description: 'id del torneo (de la herramienta torneos)' },
            equipo_torneo: { type: ['string', 'null'], description: 'Id o nombre del equipo dentro del torneo; null si la escuela tiene uno solo' },
            deportistas: { type: 'array', items: { type: 'string' }, description: 'ids de los deportistas (ej. "child:…")' },
        },
        required: ['torneo', 'equipo_torneo', 'deportistas'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar: validarCon(
        z.object({
            torneo: z.string().trim().min(10).max(60),
            equipo_torneo: z.string().trim().max(80).nullish().transform((v) => v || null),
            deportistas: z.array(z.string().min(5).max(80)).min(1).max(TOPE_CONVOCAR),
        }),
        `Faltan datos: el torneo, el equipo del torneo y de 1 a ${TOPE_CONVOCAR} deportistas.`,
    ),
    async preparar(a, args) {
        const r = await armarConvocatoria(a, args);
        if (!r.ok) return r;
        const { x } = r;
        const n = x.nuevos.length;
        return {
            ok: true,
            // La lista ORIGINAL, no solo los nuevos: al confirmar se re-prepara con estos
            // args y la vista tiene que salir igual («1 ya estaba en la nómina» incluido),
            // o el hash no coincide y el primer Confirmar da 409 sin que nada cambie
            // (evals de punta a punta, 2026-11-25). Si la realidad cambia, el hash lo detecta.
            args: { torneo: x.ev.id, equipo_torneo: x.equipo.id, deportistas: args.deportistas },
            targetKey: `torneo:${x.ev.id}:equipo:${x.equipo.id}`,
            vista: {
                titulo: `Convocar a ${x.ev.title}`,
                lineas: [
                    `${plural(n, 'deportista', 'deportistas')} a la nómina de «${x.equipo.nombre}».`,
                    ...(x.yaEstaban ? [`${plural(x.yaEstaban, 'ya estaba', 'ya estaban')} en la nómina.`] : []),
                    ...(x.noTraibles.length ? [`No se traen desde la escuela (adultos o fichas sin cuenta): ${lista(x.noTraibles)}. Agrégalos a mano en la nómina.`] : []),
                    ...(x.inactivos.length ? [`Inactivos, no se convocan: ${lista(x.inactivos)}.`] : []),
                    ...(x.noEncontrados ? [`${plural(x.noEncontrados, 'deportista no está', 'deportistas no están')} en la escuela.`] : []),
                    'No se le avisa a la familia ni se cobra nada.',
                ],
                aviso: null,
                detalle: { etiqueta: n === 1 ? 'Ver a quién' : `Ver los ${n}`, items: x.nuevos.map((d) => d.nombre) },
                botonConfirmar: `Convocar a ${n}`,
            },
            huella: { torneo: x.ev.id, equipo: x.equipo.id, nuevos: x.nuevos.map((d) => d.id).sort() },
        };
    },
    async ejecutar(a, args) {
        const r = await armarConvocatoria(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        let agregados = 0;
        try {
            agregados = (await addFromSchool(x.ev, x.equipo.id, x.nuevos.map((d) => d.id))).added;
        } catch (err: any) {
            return { estado: 'failed', resultado: { torneo: x.ev.title, equipo: x.equipo.nombre, motivo: err instanceof LiveError ? err.message : 'No se pudo guardar la nómina.' } };
        }
        const n = x.nuevos.length;
        return {
            estado: agregados === n ? 'executed' : agregados > 0 ? 'partial' : 'failed',
            resultado: {
                torneo: x.ev.title, equipo: x.equipo.nombre, agregados, pedidos: n,
                ...(agregados === 0 ? { motivo: 'Ya estaban en la nómina.' } : {}),
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed') return `No se agregó a nadie a la nómina${x.torneo ? ` de ${x.torneo}` : ''}. ${x.motivo || ''}`.trim();
        const base = `${x.agregados === 1 ? 'Quedó 1 deportista' : `Quedaron ${x.agregados} deportistas`} en la nómina de «${x.equipo}» en ${x.torneo}.`;
        return r.estado === 'partial' ? `${base} ${x.pedidos - x.agregados} ya estaban.` : base;
    },
};

// ─── inscribir_a_torneo ─────────────────────────────────────────────────────

export const TOPE_INSCRIPCION = 30;
/** Columnas de school_athletes (lista permitida: la vista trae datos médicos y teléfonos). */
const COLS_ATLETA = 'id, full_name, athlete_type, team_id, enrolled_team_id, team_name, is_active, parent_id, user_id, plan_name, enrollment_status';

export interface ArgsInscribir { torneo: string; categoria: string | null; equipo: string | null; deportistas: string[] | null }

async function deportistasDelEquipo(a: Alcance, equipo: Equipo): Promise<Deportista[]> {
    const res = await Promise.all(['team_id', 'enrolled_team_id'].map((col) =>
        supabase.from('school_athletes').select(COLS_ATLETA).eq('school_id', a.schoolId).eq(col, equipo.id).limit(500)));
    const filas: any[] = [];
    for (const r of res) {
        if (r.error) throw new Error(`school_athletes: ${r.error.message}`);
        filas.push(...((r.data as any[]) ?? []));
    }
    return agrupar(filas).filter((d) => d.activo);
}

interface InscripcionArmada {
    ev: { id: string; title: string; gratis: boolean };
    categoria: { id: string; nombre: string };
    nuevos: Deportista[];
    yaInscritos: number;
    sinPagador: string[];
    fichas: string[];
    inactivos: string[];
    noEncontrados: number;
    precio: number | null;
}

async function armarInscripcion(a: Alcance, args: ArgsInscribir): Promise<{ ok: true; x: InscripcionArmada } | { ok: false; motivo: string }> {
    if (!sesionDe(a)) throw new RechazoHerramienta('Inscribir a un torneo necesita tu sesión de la app. Hazlo desde la pantalla del torneo.');
    if (!!args.equipo === !!(args.deportistas && args.deportistas.length)) {
        throw new RechazoHerramienta('Dime un equipo o una lista de deportistas, uno de los dos.');
    }
    if (!UUID.test(args.torneo)) throw new RechazoHerramienta('Ese id de torneo no es válido. Búscalo con la herramienta torneos.');
    const { data: evData, error: evErr } = await supabase.from('events')
        .select('id, title, tournament_scope, status, is_paid, capacity')
        .eq('id', args.torneo.toLowerCase()).eq('school_id', a.schoolId).in('creator_role', [...TOURNAMENT_OWNER_ROLES]).maybeSingle();
    if (evErr) throw new Error(`events: ${evErr.message}`);
    const ev = evData as any;
    if (!ev) throw new RechazoHerramienta('No encontré ese torneo entre los que organiza tu escuela.');
    if (ev.tournament_scope !== 'internal') {
        return { ok: false, motivo: `«${ev.title}» es externo: las delegaciones se inscriben en la pantalla del torneo.` };
    }
    if (!['active', 'closed'].includes(ev.status)) {
        return { ok: false, motivo: ev.status === 'draft' ? `«${ev.title}» todavía no está publicado.` : `«${ev.title}» está ${ESTADO_TORNEO[ev.status] ?? ev.status}.` };
    }

    const { data: cats, error: catErr } = await supabase.from('event_categories_config')
        .select('id, category, division, level, rama').eq('event_id', ev.id).eq('active', true);
    if (catErr) throw new Error(`event_categories_config: ${catErr.message}`);
    const categorias = ((cats as any[]) ?? []).map((c) => ({ id: String(c.id), nombre: categoryLabel(c) ?? String(c.category ?? 'Categoría') }));
    if (!categorias.length) return { ok: false, motivo: `«${ev.title}» no tiene categorías activas.` };
    let categoria = categorias.length === 1 && !args.categoria ? categorias[0] : undefined;
    if (args.categoria) {
        const t = args.categoria.trim();
        const exactas = categorias.filter((c) => c.id === t.toLowerCase() || clave(c.nombre) === clave(t));
        const parecidas = exactas.length ? exactas : categorias.filter((c) => clave(c.nombre).includes(clave(t)));
        if (parecidas.length === 1) categoria = parecidas[0];
        else if (parecidas.length > 1) throw new RechazoHerramienta(`Hay varias categorías que coinciden: ${lista(parecidas.map((c) => c.nombre))}. ¿Cuál?`);
        else throw new RechazoHerramienta(`«${ev.title}» no tiene la categoría «${t}». Tiene: ${lista(categorias.map((c) => c.nombre), 10)}.`);
    }
    if (!categoria) throw new RechazoHerramienta(`¿En qué categoría? ${lista(categorias.map((c) => c.nombre), 10)}.`);

    let ds: Deportista[];
    let noEncontrados = 0;
    if (args.equipo) {
        ds = await deportistasDelEquipo(a, await resolverEquipo(a, args.equipo));
    } else {
        ({ ds, noEncontrados } = await resolverVarios(a, args.deportistas ?? []));
    }
    const gratis = ev.is_paid === false;
    // La RPC inscribe hijos (con acudiente si el torneo cobra) y adultos con cuenta.
    const fichas = ds.filter((d) => d.tipo === 'unregistered').map((d) => d.nombre);
    const inactivos = ds.filter((d) => d.tipo !== 'unregistered' && !d.activo).map((d) => d.nombre);
    const sinPagador = ds.filter((d) => d.tipo === 'child' && d.activo && !gratis && !d.parentId).map((d) => d.nombre);
    const candidatos = ds.filter((d) => d.tipo !== 'unregistered' && d.activo && (gratis || d.tipo !== 'child' || !!d.parentId));

    const { data: regs, error: regErr } = await supabase.from('event_registrations')
        .select('child_id, user_id, category_id').eq('event_id', ev.id).neq('status', 'cancelled').limit(5000);
    if (regErr) throw new Error(`event_registrations: ${regErr.message}`);
    const filasRegs = (regs as any[]) ?? [];
    const enLaCategoria = new Set(filasRegs.filter((r) => r.category_id === categoria!.id).map((r) => r.child_id ?? r.user_id).filter(Boolean));
    const nuevos = candidatos.filter((d) => !enLaCategoria.has(d.id)).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
    const yaInscritos = candidatos.length - nuevos.length;

    if (!nuevos.length) {
        const porQue = [
            ...(yaInscritos ? [`${plural(yaInscritos, 'ya estaba inscrito', 'ya estaban inscritos')} en ${categoria.nombre}.`] : []),
            ...(sinPagador.length ? [`Sin acudiente que pague: ${lista(sinPagador)}.`] : []),
            ...(fichas.length ? [`Fichas sin cuenta (no se pueden inscribir): ${lista(fichas)}.`] : []),
            ...(inactivos.length ? [`Inactivos: ${lista(inactivos)}.`] : []),
            ...(noEncontrados ? [`${plural(noEncontrados, 'deportista no está', 'deportistas no están')} en la escuela.`] : []),
            ...(!ds.length && args.equipo ? ['El equipo no tiene deportistas activos.'] : []),
        ];
        return { ok: false, motivo: ['No hay a quién inscribir.', ...porQue].join(' ') };
    }
    if (nuevos.length > TOPE_INSCRIPCION) return { ok: false, motivo: `Son ${nuevos.length}: el tope por vez es ${TOPE_INSCRIPCION}. Divídelo por deportistas.` };
    const cupo = Number(ev.capacity) || 0;
    if (cupo > 0 && filasRegs.length + nuevos.length > cupo) {
        return { ok: false, motivo: `«${ev.title}» tiene cupo para ${cupo} y ya hay ${filasRegs.length} inscritos: caben ${Math.max(0, cupo - filasRegs.length)}. Sube el cupo en la pantalla del torneo o inscribe menos.` };
    }

    let precio: number | null = null;
    if (!gratis) {
        const { data: fs, error: fErr } = await supabase.from('event_price_phases').select('price_solo, valid_until').eq('event_id', ev.id);
        if (fErr) throw new Error(`event_price_phases: ${fErr.message}`);
        precio = precioVigente((fs as any[]) ?? [], a.hoy);
        if (!precio || precio <= 0) return { ok: false, motivo: `«${ev.title}» no tiene una tarifa válida todavía: configúrala en la pantalla del torneo o márcalo como gratis.` };
    }
    return {
        ok: true,
        x: { ev: { id: ev.id, title: ev.title, gratis }, categoria, nuevos, yaInscritos, sinPagador, fichas, inactivos, noEncontrados, precio },
    };
}

/** «Faltan 2 soporte(s): …» en vez del código. Pura. */
function motivoInscripcion(r: { status: number; body: any }): string {
    const e = String(r.body?.error ?? '');
    if (r.status === 409 && e.startsWith('SOPORTES_INCOMPLETOS')) return e.replace(/^SOPORTES_INCOMPLETOS:\s*/, '');
    if (r.status === 403) return 'sin permiso para inscribir en este torneo';
    return e || 'error al inscribir';
}

export const inscribirATorneo: HerramientaAccion<ArgsInscribir> = {
    tipo: 'accion',
    nombre: 'inscribir_a_torneo',
    plata: true,
    descripcion: 'PREPARA INSCRIBIR deportistas (o un equipo de la escuela completo) en una categoría de un torneo INTERNO que organiza la escuela. La inscripción queda aprobada, avisa a la familia y, si el torneo cobra, crea un cobro a cada familia: la vista previa dice cuánto. Para «convocar» o armar la nómina usa convocar_a_torneo. Los torneos EXTERNOS (de otro organizador) no se inscriben desde aquí: se hacen por delegaciones en la pantalla del torneo. La persona confirma en la tarjeta. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            torneo: { type: 'string', description: 'id del torneo (de la herramienta torneos)' },
            categoria: { type: ['string', 'null'], description: 'Id o nombre de la categoría; null si el torneo tiene una sola' },
            equipo: { type: ['string', 'null'], description: 'Equipo de la escuela a inscribir completo; null si van deportistas' },
            deportistas: { type: ['array', 'null'], items: { type: 'string' }, description: 'ids de deportistas; null si va un equipo' },
        },
        required: ['torneo', 'categoria', 'equipo', 'deportistas'],
        additionalProperties: false,
    },
    roles: ['admin'],
    // Crea cobros: nace apagada y además necesita la sesión de la persona (la RPC valida auth.uid()).
    habilitada: (a) => process.env.MAPI_INSCRIBIR_TORNEO === 'true' && sesionDe(a) !== null,
    validar: validarCon(
        z.object({
            torneo: z.string().trim().min(10).max(60),
            categoria: z.string().trim().max(80).nullish().transform((v) => v || null),
            equipo: z.string().trim().max(80).nullish().transform((v) => v || null),
            deportistas: z.array(z.string().min(5).max(80)).max(TOPE_INSCRIPCION).nullish().transform((v) => (v && v.length ? v : null)),
        }),
        `Faltan datos: el torneo, la categoría y un equipo o hasta ${TOPE_INSCRIPCION} deportistas.`,
    ),
    async preparar(a, args) {
        const r = await armarInscripcion(a, args);
        if (!r.ok) return r;
        const { x } = r;
        const n = x.nuevos.length;
        const total = x.precio ? x.precio * n : 0;
        return {
            ok: true,
            // Los args ORIGINALES (equipo o lista), con torneo y categoría ya resueltos. El
            // Confirmar re-prepara con ellos: la vista sale igual (ya inscritos, fichas sin
            // cuenta…) y el hash coincide. Antes se guardaba solo a los nuevos con
            // equipo: null, la vista perdía esas líneas y el primer Confirmar daba 409
            // siempre (evals de punta a punta, 2026-11-25). Si alguien entra o sale del
            // equipo entre la tarjeta y el clic, la huella cambia y se pide confirmar otra vez.
            args: { ...args, torneo: x.ev.id, categoria: x.categoria.id },
            targetKey: `torneo:${x.ev.id}:categoria:${x.categoria.id}`,
            vista: {
                titulo: `Inscribir en ${x.ev.title} · ${x.categoria.nombre}`,
                lineas: [
                    `${plural(n, 'deportista', 'deportistas')}. La inscripción queda aprobada.`,
                    x.ev.gratis
                        ? 'El torneo es gratis: no se crea ningún cobro.'
                        : `Se crea un cobro de ${fmtCop(x.precio ?? 0)} a cada familia: ${plural(n, 'cobro', 'cobros')} por ${fmtCop(total)}. Lo verán en Mis pagos.`,
                    'A cada familia le llega un aviso en la app.',
                    ...(x.yaInscritos ? [`${plural(x.yaInscritos, 'ya estaba inscrito', 'ya estaban inscritos')} en esta categoría.`] : []),
                    ...(x.sinPagador.length ? [`Sin acudiente que pague, no se inscriben: ${lista(x.sinPagador)}.`] : []),
                    ...(x.fichas.length ? [`Fichas sin cuenta, no se pueden inscribir: ${lista(x.fichas)}.`] : []),
                    ...(x.inactivos.length ? [`Inactivos, no se inscriben: ${lista(x.inactivos)}.`] : []),
                    ...(x.noEncontrados ? [`${plural(x.noEncontrados, 'deportista no está', 'deportistas no están')} en la escuela.`] : []),
                    'Si la escuela exige soportes, a quien le falten no se le inscribe (sale en el resultado).',
                ],
                aviso: x.ev.gratis ? null : 'Los cobros se crean apenas confirmes.',
                detalle: { etiqueta: n === 1 ? 'Ver a quién' : `Ver los ${n}`, items: x.nuevos.map((d) => d.nombre) },
                botonConfirmar: `Inscribir a ${n}`,
            },
            huella: { torneo: x.ev.id, categoria: x.categoria.id, nuevos: x.nuevos.map((d) => d.clave).sort(), precio: x.precio, gratis: x.ev.gratis },
        };
    },
    async ejecutar(a, args) {
        const r = await armarInscripcion(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const client = comoLaPersona(a);
        const authorization = sesionDe(a) as string;
        let inscritos = 0;
        let yaEstaban = 0;
        const fallos: { deportista: string; motivo: string }[] = [];
        // Uno por uno, como el botón de la pantalla: cada inscripción es su propia transacción en la RPC.
        for (const d of x.nuevos) {
            try {
                const res = await inscribirAtletaDesdeLaEscuela({
                    client, authorization, schoolId: a.schoolId, eventId: x.ev.id, categoryId: x.categoria.id,
                    ...(d.tipo === 'child' ? { childId: d.id } : { athleteUserId: d.id }),
                });
                if (res.status === 201) inscritos++;
                else if (res.status === 200) yaEstaban++;
                else fallos.push({ deportista: d.nombre, motivo: motivoInscripcion(res) });
            } catch (err: any) {
                console.error('[mapi-agente] inscribir_a_torneo falló para un deportista:', err?.message || String(err));
                fallos.push({ deportista: d.nombre, motivo: 'error del sistema' });
            }
        }
        const n = x.nuevos.length;
        return {
            estado: inscritos + yaEstaban === n ? 'executed' : inscritos > 0 ? 'partial' : 'failed',
            resultado: {
                torneo: x.ev.title, categoria: x.categoria.nombre, inscritos, ya_estaban: yaEstaban,
                cobros: x.ev.gratis ? 0 : inscritos, valor_cobro: x.precio ? fmtCop(x.precio) : null,
                fallos: fallos.slice(0, 30),
                ...(inscritos === 0 && fallos.length ? { motivo: `${fallos[0].deportista}: ${fallos[0].motivo}` } : {}),
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado === 'failed' && !x.inscritos) {
            return `No se inscribió a nadie${x.torneo ? ` en ${x.torneo}` : ''}. ${x.motivo || ''}`.trim();
        }
        const cobros = x.cobros ? ` Se ${x.cobros === 1 ? 'creó' : 'crearon'} ${plural(x.cobros, 'cobro', 'cobros')} de ${x.valor_cobro}.` : '';
        const ya = x.ya_estaban ? ` ${plural(x.ya_estaban, 'ya estaba inscrito', 'ya estaban inscritos')}.` : '';
        const fallos = (x.fallos ?? []) as { deportista: string; motivo: string }[];
        const noSalio = fallos.length ? ` No se inscribió a ${fallos.slice(0, 5).map((f) => `${f.deportista} (${f.motivo})`).join(', ')}${fallos.length > 5 ? ` y ${fallos.length - 5} más` : ''}.` : '';
        const quedaron = x.inscritos === 1 ? 'Quedó inscrito 1 deportista' : `Quedaron inscritos ${x.inscritos} deportistas`;
        return `${quedaron} en ${x.torneo} · ${x.categoria}.${cobros}${ya}${noSalio}`;
    },
};

// ═══ Clase de prueba ═════════════════════════════════════════════════════════

const ESTADO_PAGO_CLASE: Record<string, string> = {
    paid: 'pagada', partial: 'abono', pending: 'pendiente', overdue: 'vencida', awaiting_approval: 'comprobante en revisión',
};
const CANAL: Record<string, string> = { presencial: 'en la escuela', whatsapp: 'WhatsApp', formulario: 'formulario' };
const asistenciaLegible = (v: unknown) => (v === 'asistio' ? 'asistió' : v === 'no_vino' ? 'no vino' : null);

function errorDeRpc(error: { code?: string; message?: string }, nombre: RpcPor): never {
    if (error.code === '42501') throw new RechazoHerramienta('No tienes acceso a esa información en esta escuela.');
    // Sin la `_por` (migración sin aplicar) o mal llamada: lo dice rpc-por.
    const propio = motivoDeLaPor(error, nombre);
    if (propio) throw new RechazoHerramienta(propio);
    if (error.code === 'PGRST202' || error.code === '42883') throw new RechazoHerramienta('La agenda de clases de prueba no está activa en esta escuela.');
    throw new Error(`${nombre}: ${error.message}`);
}

export const clasesDePrueba: HerramientaConsulta<{ fecha: string | null }> = {
    tipo: 'consulta',
    nombre: 'clases_de_prueba',
    descripcion: 'Agenda de clases de prueba de un día (o de los próximos 7 días si no se da fecha): quién viene, a qué grupo y hora, y si asistió. A la administración le suma los prospectos pendientes. El entrenador solo ve las de sus equipos. Sin teléfonos.',
    esquema: {
        type: 'object',
        properties: { fecha: { type: ['string', 'null'], description: 'AAAA-MM-DD; null = de hoy a 7 días' } },
        required: ['fecha'],
        additionalProperties: false,
    },
    roles: ['admin', 'coach'],
    // Las RPC de la pantalla autorizan con auth.uid(): van por su _por, a nombre del actor.
    validar(args) {
        const r = z.object({ fecha: z.string().trim().nullish() }).safeParse(args ?? {});
        if (!r.success || (r.data.fecha && !esFechaIso(r.data.fecha))) throw new RechazoHerramienta('La fecha tiene que venir como AAAA-MM-DD.');
        return { fecha: r.data.fecha || null };
    },
    async ejecutar(a, { fecha }) {
        const desde = fecha ?? a.hoy;
        const hasta = fecha ?? sumarDias(a.hoy, 6);
        // La RPC ya recorta al coach a sus equipos y le esconde los montos.
        const { data, error } = await rpcPor(a, 'clases_prueba_semana', { p_school_id: a.schoolId, p_desde: desde, p_hasta: hasta });
        if (error) errorDeRpc(error, 'clases_prueba_semana');
        const filas = Array.isArray(data) ? (data as any[]) : [];
        const salida: Record<string, unknown> = {
            desde, hasta,
            clases: filas.slice(0, 40).map((r) => ({
                prospecto: r.lead_id ?? null,
                nombre: r.nombre ?? 'Sin nombre',
                fecha: dia(r.franja?.fecha),
                hora: rangoHoras(r.franja?.hora_inicio, r.franja?.hora_fin) || null,
                grupo: r.equipo?.nombre ?? r.franja?.etiqueta ?? null,
                lugar: r.franja?.lugar ?? null,
                estado: r.estado_cupo === 'agendada' ? 'agendada' : 'cupo separado, falta el pago',
                asistencia: asistenciaLegible(r.asistencia),
                // El coach no ve plata: ni el monto ni si pagó.
                ...(a.rol === 'admin' && r.pago
                    ? { pago: `${ESTADO_PAGO_CLASE[r.pago.estado] ?? r.pago.estado}${r.pago.monto ? ` · ${fmtCop(Number(r.pago.monto))}` : ''}` }
                    : {}),
            })),
            total: filas.length,
            ...(filas.length === 0 ? { nota: a.rol === 'coach' ? 'No hay clases de prueba en tus equipos en esas fechas.' : 'No hay clases de prueba agendadas en esas fechas.' } : {}),
        };

        if (a.rol === 'admin') {
            const { data: p, error: e2 } = await rpcPor(a, 'listar_clase_prueba', { p_school_id: a.schoolId });
            if (e2) errorDeRpc(e2, 'listar_clase_prueba');
            const prospectos = Array.isArray(p) ? (p as any[]) : [];
            const sinClase = prospectos.filter((x) => !x.estado_cupo && !x.fecha_clase);
            salida.prospectos = {
                pendientes: prospectos.length,
                sin_clase_agendada: sinClase.length,
                // Lista permitida: nada de teléfono, correo, notas ni fecha de nacimiento.
                recientes_sin_clase: sinClase.slice(0, 15).map((x) => ({
                    prospecto: x.id,
                    nombre: x.full_name ?? 'Sin nombre',
                    acudiente: x.guardian_name ?? null,
                    canal: CANAL[x.canal] ?? x.canal ?? null,
                    desde: dia(x.created_at),
                    grupo: x.grupo ?? null,
                })),
            };
        }
        salida.pantalla = a.rol === 'admin'
            ? { nombre: 'Deportistas › pestaña «Clase de prueba»', enlace: '/students' }
            : { nombre: 'Sesiones › Semana', enlace: '/training-plans?tab=semana' };
        return salida;
    },
};

// ─── agendar_clase_de_prueba ────────────────────────────────────────────────

export interface ArgsAgendar { prospecto: string; fecha: string; equipo: string | null; hora: string | null }

interface AgendaArmada {
    leadId: string;
    nombre: string;
    conversacion: string;
    previo: string | null;
    cupo: { id: string; fecha: string; inicio: string; fin: string | null; lugar: string | null; grupo: string | null };
}

async function armarAgenda(a: Alcance, args: ArgsAgendar): Promise<{ ok: true; x: AgendaArmada } | { ok: false; motivo: string }> {
    if (!esFechaIso(args.fecha)) return { ok: false, motivo: 'La fecha tiene que venir como AAAA-MM-DD.' };
    if (args.fecha < a.hoy) return { ok: false, motivo: 'Esa fecha ya pasó.' };
    if (!UUID.test(args.prospecto)) throw new RechazoHerramienta('Ese prospecto no es válido. Búscalo con clases_de_prueba.');

    const { data: l, error } = await supabase.from('school_signup_leads')
        .select('id, full_name, status, trial_slot_id, source_detail')
        .eq('id', args.prospecto.toLowerCase()).eq('school_id', a.schoolId).maybeSingle();
    if (error) throw new Error(`school_signup_leads: ${error.message}`);
    const lead = l as any;
    if (!lead) throw new RechazoHerramienta('No encontré ese prospecto en esta escuela.');
    const nombre = String(lead.full_name ?? '').trim();
    if (!['new', 'contacted'].includes(lead.status)) return { ok: false, motivo: `${nombre || 'Ese prospecto'} ya no está pendiente: se inscribió o se descartó.` };
    if (!nombre) return { ok: false, motivo: 'Ese prospecto no tiene el nombre del deportista: complétalo en la conversación antes de agendar.' };

    // La pantalla agenda desde la conversación de WhatsApp (buzón › «Agendar»).
    const conv = String(lead.source_detail?.conversation_id ?? '');
    if (!UUID.test(conv)) {
        return { ok: false, motivo: `${nombre} no llegó por WhatsApp: la app agenda la clase de prueba desde la conversación (buzón › «Agendar»), y este prospecto no tiene una.` };
    }
    const { data: c } = await supabase.from('whatsapp_conversations').select('id, school_id').eq('id', conv).maybeSingle();
    if (!c || (c as any).school_id !== a.schoolId) return { ok: false, motivo: `No encontré la conversación de WhatsApp de ${nombre} en esta escuela.` };

    const equipo = args.equipo ? await resolverEquipo(a, args.equipo) : null;
    const { data: s, error: sErr } = await supabase.from('school_trial_slots')
        .select('id, label, slot_date, start_time, end_time, location, team_id, max_capacity, reserved_count, is_open')
        .eq('school_id', a.schoolId).eq('slot_date', args.fecha).eq('is_open', true).order('start_time');
    if (sErr) throw new Error(`school_trial_slots: ${sErr.message}`);
    const hora = args.hora ? args.hora.slice(0, 5).padStart(5, '0') : null;
    const delDia = ((s as any[]) ?? [])
        .filter((x) => !equipo || x.team_id === equipo.id)
        .filter((x) => !hora || String(x.start_time).slice(0, 5) === hora);
    const donde = `${fechaLarga(args.fecha)}${equipo ? ` para ${equipo.nombre}` : ''}${hora ? ` a las ${horaCorta(hora)}` : ''}`;
    if (!delDia.length) return { ok: false, motivo: `No hay cupos de clase de prueba abiertos el ${donde}.` };
    if (lead.trial_slot_id && delDia.some((x) => x.id === lead.trial_slot_id)) {
        return { ok: false, motivo: `${nombre} ya está agendado en ese cupo.` };
    }
    const libres = delDia.filter((x) => Number(x.reserved_count) < Number(x.max_capacity));
    if (!libres.length) return { ok: false, motivo: `Los cupos del ${donde} ya están llenos.` };

    const equipos = [...new Set(libres.map((x) => x.team_id).filter(Boolean))] as string[];
    const nombres = new Map<string, string>();
    if (equipos.length) {
        const { data: ts } = await supabase.from('teams').select('id, name').eq('school_id', a.schoolId).in('id', equipos);
        for (const t of (ts as any[]) ?? []) nombres.set(t.id, t.name);
    }
    const grupoDe = (x: any) => nombres.get(x.team_id) ?? x.label ?? null;
    if (libres.length > 1) {
        const opciones = libres.map((x) => `${horaCorta(x.start_time)}${grupoDe(x) ? ` (${grupoDe(x)})` : ''}`);
        return { ok: false, motivo: `El ${fechaLarga(args.fecha)} hay ${libres.length} cupos libres: ${lista(opciones, 8)}. ¿Cuál? Dime el equipo o la hora.` };
    }
    const x = libres[0];
    return {
        ok: true,
        x: {
            leadId: String(lead.id), nombre, conversacion: conv, previo: lead.trial_slot_id ?? null,
            cupo: {
                id: String(x.id), fecha: String(x.slot_date).slice(0, 10), inicio: String(x.start_time), fin: x.end_time ? String(x.end_time) : null,
                lugar: x.location ?? null, grupo: grupoDe(x),
            },
        },
    };
}

const MENSAJE_RPC_AGENDA: Record<string, string> = {
    CUPO_LLENO: 'Ese cupo se llenó mientras tanto. Pídeme otro.',
    CUPO_NO_DISPONIBLE: 'Ese cupo ya no está disponible.',
    CUPO_NO_EXISTE: 'Ese cupo ya no existe.',
    NOMBRE_REQUERIDO: 'Falta el nombre del deportista.',
};

export const agendarClaseDePrueba: HerramientaAccion<ArgsAgendar> = {
    tipo: 'accion',
    nombre: 'agendar_clase_de_prueba',
    descripcion: 'PREPARA agendar la clase de prueba de un prospecto que llegó por WhatsApp en un cupo abierto (el «Agendar» del buzón). No registra pagos ni le escribe a la familia. La persona confirma en la tarjeta. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            prospecto: { type: 'string', description: 'id del prospecto (de clases_de_prueba)' },
            fecha: { type: 'string', description: 'Día de la clase, AAAA-MM-DD' },
            equipo: { type: ['string', 'null'], description: 'Equipo del cupo, si ese día hay varios' },
            hora: { type: ['string', 'null'], description: 'Hora del cupo HH:MM (24 h), si ese día hay varios' },
        },
        required: ['prospecto', 'fecha', 'equipo', 'hora'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar(args) {
        const r = z.object({
            prospecto: z.string().trim().min(10).max(60),
            fecha: z.string().trim(),
            equipo: z.string().trim().max(80).nullish(),
            hora: z.string().trim().regex(/^\d{1,2}:\d{2}$/).nullish(),
        }).safeParse(args ?? {});
        if (!r.success || !esFechaIso(r.data.fecha)) throw new RechazoHerramienta('Faltan datos: el prospecto, la fecha (AAAA-MM-DD) y, si hace falta, el equipo o la hora (HH:MM).');
        return { prospecto: r.data.prospecto, fecha: r.data.fecha, equipo: r.data.equipo || null, hora: r.data.hora || null };
    },
    async preparar(a, args) {
        const r = await armarAgenda(a, args);
        if (!r.ok) return r;
        const { x } = r;
        return {
            ok: true,
            args: { ...args, hora: x.cupo.inicio.slice(0, 5) },
            targetKey: `prospecto:${x.leadId}`,
            vista: {
                titulo: `Agendar la clase de prueba de ${x.nombre}`,
                lineas: [
                    `${capital(fechaLarga(x.cupo.fecha))}, ${rangoHoras(x.cupo.inicio, x.cupo.fin)}`,
                    ...([x.cupo.grupo, x.cupo.lugar].filter(Boolean).length ? [[x.cupo.grupo, x.cupo.lugar].filter(Boolean).join(' · ')] : []),
                    ...(x.previo ? ['Tenía otro cupo: ese se libera.'] : []),
                    'No le escribe a la familia: el mensaje de confirmación lo mandas tú desde la conversación de WhatsApp.',
                    'No registra el pago de la clase.',
                ],
                aviso: null,
                botonConfirmar: 'Agendar',
            },
            huella: { prospecto: x.leadId, cupo: x.cupo.id, previo: x.previo },
        };
    },
    async ejecutar(a, args) {
        const r = await armarAgenda(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        // La _por no recibe plata: registrar el pago de la clase no es de Mapi.
        const { data, error } = await rpcPor(a, 'agendar_clase_prueba_desde_chat', {
            p_conversation_id: x.conversacion,
            p_slot_id: x.cupo.id,
            // El nombre que ya tiene el prospecto: la RPC lo reescribe con este.
            p_nombre: x.nombre,
            p_fecha_nacimiento: null,
            p_genero: null,
            p_acudiente: null,
        });
        if (error) {
            const k = Object.keys(MENSAJE_RPC_AGENDA).find((c) => String(error.message ?? '').includes(c));
            const propio = motivoDeLaPor(error, 'agendar_clase_prueba_desde_chat');
            return {
                estado: 'failed',
                resultado: { nombre: x.nombre, motivo: k ? MENSAJE_RPC_AGENDA[k] : propio ?? (error.code === '42501' ? 'No tienes permiso para agendar en esta escuela.' : 'No se pudo agendar.') },
            };
        }
        return {
            estado: 'executed',
            resultado: {
                nombre: x.nombre, fecha: x.cupo.fecha, hora: rangoHoras(x.cupo.inicio, x.cupo.fin), grupo: x.cupo.grupo,
                ya_estaba: (data as any)?.ya_agendada === true,
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado !== 'executed') return `No se agendó la clase de prueba${x.nombre ? ` de ${x.nombre}` : ''}. ${x.motivo || ''}`.trim();
        return `Quedó agendada la clase de prueba de ${x.nombre} el ${fechaLarga(x.fecha)}, ${x.hora}${x.grupo ? ` (${x.grupo})` : ''}. El mensaje para la familia no sale solo: mándalo desde la conversación de WhatsApp.`;
    },
};

// ─── Catálogo del módulo ────────────────────────────────────────────────────

export const HERRAMIENTAS_INFORMES: Herramienta[] = [
    generarReporte,
    informesDelAtleta,
    enviarInformeAtleta,
    torneos,
    convocarATorneo,
    inscribirATorneo,
    clasesDePrueba,
    agendarClaseDePrueba,
];
