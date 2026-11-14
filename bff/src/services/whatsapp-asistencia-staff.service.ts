/**
 * whatsapp-asistencia-staff — asistencia por WhatsApp para el STAFF de la escuela
 * (docs/specs/whatsapp-conversacion-v2-dynasty.md §3.8).
 *
 * NO envía mensajes ni toca la cola: cada función devuelve `RespuestaStaff`
 * ({ texto, botones, … }) y quien conecte el job/bot la manda con
 * sendInteractiveButtons / sendTextMessage. Tampoco habla con Meta salvo para
 * bajar la foto cuando se le pasa `mediaId`.
 *
 * Dos caminos, el entrenador/dueña manda:
 *   1. FOTO de la planilla de papel → OCR → equipo inferido de los nombres →
 *      cruce con el roster → resumen «Intermedio, 22-oct: 14 presentes, 3 sin
 *      marca, 1 no encontrada» con [Guardar] [Corregir] [Descartar].
 *      REVISIÓN OBLIGATORIA: nunca se guarda sin que la persona toque Guardar.
 *   2. «lista» → grupos con franja activa ±2 h como botones → lista numerada →
 *      «faltaron 3 y 7» / «todos» / «ninguno» (parser determinista, sin LLM) → guardar.
 *
 * Estado de la conversación = la fila de `attendance_sheet_intake` (status
 * 'por_revisar'); no hay tabla ni memoria nuevas. Todo el acceso a esa tabla es
 * defensivo: si la migración aún no está aplicada, devuelve `estado:'no_disponible'`
 * y el flujo normal del bot sigue.
 *
 * Quién entra: solo owner/admin/coach según `wa_identify_staff_by_phone`. Un admin
 * que también es acudiente NO pierde el camino de pagos: si el mensaje no es de
 * asistencia (`null` / `no_aplica`), el caller sigue con su flujo normal.
 *
 * Ids de botón (todos empiezan con `asis_`):
 *   asis_guardar:<intakeId>  asis_corregir:<intakeId>  asis_descartar:<intakeId>
 *   asis_equipo:<intakeId>:<teamId|otro>   asis_grupo:<teamId>
 */
import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import { formatDateInZone } from '../utils/businessDate';
import { downloadMedia, type WhatsAppIntegration } from './whatsapp.service';
import {
    extractAttendanceSheet, interpretarMarca, resolverFechasColumnas, type AttendanceSheetResult,
} from './attendance-sheet-ocr.service';
import {
    inferirEquipo, cruzarConRoster, franjasActivas, fechaSesionSugerida, normalizarNombre,
    type RosterEquipo, type HorarioEquipo, type AtletaRoster, type FilaPlanilla, type CruceResultado,
    type InferenciaEquipo, type FranjaHorario,
} from './attendance-team-inference';
import { guardarSesionAsistencia, resolverFechaDeTrabajo, type RegistroAsistencia } from './attendance-register.service';

export const BUCKET_PLANILLAS = 'payment-receipts';
const TABLA = 'attendance_sheet_intake';
const MAX_BYTES = 8 * 1024 * 1024;
const VIGENCIA_ESTADO_H = 6;

export type RolStaff = 'owner' | 'admin' | 'coach';
export interface StaffIdentificado {
    resultado: 'staff' | 'no_staff' | 'ambiguo';
    profileId?: string; role?: RolStaff; schoolId?: string;
}
export interface BotonStaff { id: string; title: string }
export type EstadoRespuesta =
    | 'resumen' | 'pregunta_equipo' | 'pregunta_grupo' | 'lista' | 'guardada' | 'descartada'
    | 'correccion' | 'error' | 'no_aplica' | 'no_disponible';
export interface RespuestaStaff {
    estado: EstadoRespuesta;
    texto: string;
    botones?: BotonStaff[];
    intakeId?: string | null;
    /** Solo al guardar: sesiones creadas/actualizadas. */
    sesiones?: Array<{ teamId: string; fecha: string; sessionId: string; presentes: number; ausentes: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────
const tabla = () => supabase.from(TABLA);
const recorta = (t: string, n: number) => Array.from(t).slice(0, n).join('');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const fechaCorta = (iso: string) => { const [, m, d] = iso.split('-').map(Number); return `${d}-${MESES[m - 1]}`; };
const bonito = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** La tabla aún no existe en la base viva (migración sin aplicar) o PostgREST no la ve. */
export function esTablaAusente(err: any): boolean {
    const m = `${err?.code ?? ''} ${err?.message ?? ''}`;
    return /42P01|PGRST205|PGRST202|does not exist|schema cache|Could not find/i.test(m);
}

const NO_DISPONIBLE: RespuestaStaff = {
    estado: 'no_disponible',
    texto: 'La asistencia por WhatsApp todavía no está habilitada en tu escuela. Pásala desde la app.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Identificación del staff
// ─────────────────────────────────────────────────────────────────────────────
export async function identificarStaffPorTelefono(integrationId: string, contactWaId: string): Promise<StaffIdentificado> {
    try {
        const { data, error } = await supabase.rpc('wa_identify_staff_by_phone', {
            p_integration_id: integrationId, p_contact_wa_id: contactWaId,
        });
        if (error || !data) return { resultado: 'no_staff' };
        const d = data as any;
        if (d.resultado === 'staff' && d.profile_id && ['owner', 'admin', 'coach'].includes(d.role)) {
            return { resultado: 'staff', profileId: d.profile_id, role: d.role, schoolId: d.school_id };
        }
        return { resultado: d.resultado === 'ambiguo' ? 'ambiguo' : 'no_staff' };
    } catch {
        return { resultado: 'no_staff' };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rosters, horarios y permisos (lecturas por lote, sin N+1)
// ─────────────────────────────────────────────────────────────────────────────
export interface EquipoEscuela { id: string; name: string; schedule: FranjaHorario[] | null }

/** Equipo vigente: `teams.active` (boolean) y `teams.status` ('active'/'inactive'). OJO: `teams` NO tiene `is_active`
 *  (pedirla hacía fallar la consulta con 42703 y todo terminaba en «No tienes equipos asignados», B2 2026-10-26). */
export const equipoVigente = (t: { active?: boolean | null; status?: string | null; name?: string | null }) =>
    t.active !== false && t.status !== 'inactive' && !/duplicado|no usar/i.test(t.name ?? '');

/** Igual que `cargarEquipos` pero LANZA si la consulta falla (para distinguir «error» de «sin equipos»). */
export async function cargarEquiposOFallar(schoolId: string): Promise<EquipoEscuela[]> {
    const { data, error } = await supabase.from('teams').select('id, name, schedule, active, status')
        .eq('school_id', schoolId);
    if (error) {
        // No tragarse el error: un 42703 aquí se ve igual que «no hay equipos».
        console.error('[asistencia-staff] cargarEquipos falló', { schoolId, code: error.code, message: error.message });
        throw new Error(`No se pudieron cargar los equipos: ${error.message}`);
    }
    return (data ?? [])
        .filter((t: any) => equipoVigente(t))
        .map((t: any) => ({ id: t.id, name: t.name, schedule: Array.isArray(t.schedule) ? t.schedule : null }));
}

/** Equipos vigentes de la escuela. Si la consulta falla queda en el log y devuelve []. */
export async function cargarEquipos(schoolId: string): Promise<EquipoEscuela[]> {
    try { return await cargarEquiposOFallar(schoolId); } catch { return []; }
}

/** ¿La escuela dejó que sus coaches suban fotos de planillas? (`school_settings.coach_can_upload_attendance_sheets`, default false). */
export function puedeSubirPlanilla(role: string | null | undefined, flag: boolean | null | undefined): boolean {
    if (role === 'coach') return flag === true;
    return ['owner', 'admin', 'super_admin', 'school_admin', 'school'].includes(role ?? '');
}

export async function coachPuedeSubirPlanillas(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase.from('school_settings')
        .select('coach_can_upload_attendance_sheets').eq('school_id', schoolId).maybeSingle();
    if (error) console.error('[asistencia-staff] no pude leer coach_can_upload_attendance_sheets', { schoolId, message: error.message });
    return (data as any)?.coach_can_upload_attendance_sheets === true;
}

export const TEXTO_SIN_PERMISO_PLANILLA = 'Tu escuela no tiene habilitado que los entrenadores suban planillas de asistencia. Pídeselo a la escuela.';

/** Rosters (inscripciones activas) de los equipos pedidos, 1 consulta de inscripciones + 3 de nombres. */
export async function cargarRosters(schoolId: string, equipos: EquipoEscuela[]): Promise<RosterEquipo[]> {
    if (!equipos.length) return [];
    const { data: enr } = await supabase.from('enrollments')
        .select('team_id, child_id, user_id, unregistered_athlete_id')
        .eq('school_id', schoolId).eq('status', 'active').in('team_id', equipos.map((e) => e.id));
    const filas = (enr ?? []) as any[];
    const nombres = async (tbl: string, ids: string[]): Promise<Map<string, string>> => {
        const m = new Map<string, string>();
        const uniq = [...new Set(ids)];
        for (let i = 0; i < uniq.length; i += 200) {
            const { data } = await supabase.from(tbl).select('id, full_name').in('id', uniq.slice(i, i + 200));
            for (const r of (data ?? []) as any[]) m.set(r.id, r.full_name);
        }
        return m;
    };
    const [ch, us, un] = await Promise.all([
        nombres('children', filas.map((f) => f.child_id).filter(Boolean)),
        nombres('profiles', filas.map((f) => f.user_id).filter(Boolean)),
        nombres('unregistered_athletes', filas.map((f) => f.unregistered_athlete_id).filter(Boolean)),
    ]);
    return equipos.map((e) => {
        const vistos = new Set<string>();
        const atletas: AtletaRoster[] = [];
        for (const f of filas.filter((x) => x.team_id === e.id)) {
            const [id, kind, nombre] = f.child_id ? [f.child_id, 'child', ch.get(f.child_id)]
                : f.user_id ? [f.user_id, 'user', us.get(f.user_id)]
                : f.unregistered_athlete_id ? [f.unregistered_athlete_id, 'unregistered', un.get(f.unregistered_athlete_id)]
                : [null, null, null];
            if (!id || !nombre || vistos.has(id)) continue;
            vistos.add(id);
            atletas.push({ id, kind: kind as string, nombre });
        }
        return { team_id: e.id, team_name: e.name, atletas };
    });
}

/** Admin/owner: todos los equipos. Coach: los suyos (team_coaches o teams.coach_id). */
export async function equiposPermitidos(schoolId: string, staff: StaffIdentificado, equipos: EquipoEscuela[]): Promise<EquipoEscuela[]> {
    if (staff.role !== 'coach') return equipos;
    // team_coaches.coach_id y teams.coach_id apuntan a school_staff.id (no al profile). Puede haber más de una
    // fila de school_staff del mismo coach en la escuela: se aceptan todas (maybeSingle fallaba en silencio).
    const { data: st, error: stErr } = await supabase.from('school_staff').select('id')
        .eq('coach_auth_id', staff.profileId).eq('school_id', schoolId);
    if (stErr) console.error('[asistencia-staff] school_staff del coach', { schoolId, message: stErr.message });
    const staffIds = ((st ?? []) as any[]).map((r) => r.id).filter(Boolean) as string[];
    if (!staffIds.length) return [];
    const [{ data: tc, error: tcErr }, { data: legacy, error: lgErr }] = await Promise.all([
        supabase.from('team_coaches').select('team_id').in('coach_id', staffIds),
        supabase.from('teams').select('id').eq('school_id', schoolId).in('coach_id', staffIds),
    ]);
    if (tcErr || lgErr) console.error('[asistencia-staff] asignación del coach', { schoolId, tc: tcErr?.message, legacy: lgErr?.message });
    const ok = new Set<string>([...(tc ?? []).map((r: any) => r.team_id), ...(legacy ?? []).map((r: any) => r.id)]);
    return equipos.filter((e) => ok.has(e.id));
}

const refDeAtleta = (a: AtletaRoster): Pick<RegistroAsistencia, 'childId' | 'userId' | 'unregisteredAthleteId'> =>
    a.kind === 'child' ? { childId: a.id } : a.kind === 'user' ? { userId: a.id } : { unregisteredAthleteId: a.id };

// ─────────────────────────────────────────────────────────────────────────────
// Camino 1 — foto de la planilla
// ─────────────────────────────────────────────────────────────────────────────
export interface EquipoCruzado {
    team_id: string; team_name: string;
    /** Fechas con ≥1 presente (ISO), las que se guardarían. */
    fechas: string[];
    cruce: CruceResultado;
}
export interface MatchesFoto { modo: 'foto'; equipos: EquipoCruzado[]; hoy: string; fechaPorDefecto?: string | null }
export interface MatchesLista {
    modo: 'lista'; team_id: string; team_name: string; fecha: string;
    roster: Array<{ n: number; id: string; kind: string; nombre: string }>;
}

/** Arma el cruce de UN equipo a partir del OCR. Pura (sin base). */
export function construirCruce(
    ocr: AttendanceSheetResult, team: { team_id: string; team_name: string }, atletas: AtletaRoster[],
    opciones: { hoy: string; fechaPorDefecto?: string | null; nombresDelEquipo?: string[] },
): EquipoCruzado {
    const resueltas = resolverFechasColumnas(ocr.columns, ocr.monthHeader, opciones.hoy);
    let labelFecha = new Map(resueltas.filter((r) => r.fecha).map((r) => [r.label, r.fecha as string]));
    // Hoja sin encabezados de día legibles: una sola «columna» con la fecha sugerida (hoy / última clase).
    let filas = ocr.rows;
    if (labelFecha.size === 0) {
        const f = opciones.fechaPorDefecto ?? opciones.hoy;
        labelFecha = new Map([['*', f]]);
        filas = ocr.rows.map((r) => ({ ...r, marks: { '*': Object.values(r.marks)[0] ?? '' } }));
    }
    const fechasTodas = [...new Set(labelFecha.values())].filter((f) => f <= opciones.hoy).sort();
    const filasCruce: FilaPlanilla[] = filas
        .filter((r) => !opciones.nombresDelEquipo || opciones.nombresDelEquipo.includes(r.name))
        .map((r) => {
            const marcasPorFecha: FilaPlanilla['marcasPorFecha'] = {};
            for (const [label, fecha] of labelFecha) {
                if (fecha > opciones.hoy) continue;
                marcasPorFecha[fecha] = interpretarMarca(r.marks[label]);
            }
            return { nombre: r.name, struck: r.struck || /retirad/i.test(r.note ?? ''), marcasPorFecha, nota: r.note };
        });
    const cruce = cruzarConRoster(filasCruce, atletas, fechasTodas);
    const fechas = cruce.porFecha.filter((d) => d.presentes.length > 0).map((d) => d.fecha);
    return { team_id: team.team_id, team_name: team.team_name, fechas, cruce };
}

export function textoResumenEquipos(equipos: EquipoCruzado[]): string {
    const lineas: string[] = [];
    for (const e of equipos) {
        const nombre = bonito(e.team_name);
        const nEnc = e.cruce.noEncontradas.length;
        if (!e.fechas.length) { lineas.push(`*${nombre}:* no encontré marcas de asistencia que se puedan guardar.`); continue; }
        const mostrar = e.fechas.slice(-6);
        if (e.fechas.length > mostrar.length) lineas.push(`_${e.fechas.length - mostrar.length} fechas anteriores más en la planilla._`);
        for (const f of mostrar) {
            const d = e.cruce.porFecha.find((x) => x.fecha === f)!;
            const partes = [`${d.presentes.length} presentes`, `${d.sinMarca.length} sin marca`];
            if (d.dudosas.length) partes.push(`${d.dudosas.length} dudosas`);
            lineas.push(`*${nombre}, ${fechaCorta(f)}:* ${partes.join(', ')}`);
        }
        if (nEnc) {
            const ej = e.cruce.noEncontradas.slice(0, 3).map((f) => f.sugerencia ? `${f.nombreHoja} (¿${bonito(f.sugerencia.nombre)}?)` : f.nombreHoja);
            lineas.push(`${nEnc} no encontrada${nEnc > 1 ? 's' : ''}: ${ej.join(', ')}${nEnc > 3 ? '…' : ''}`);
        }
        if (e.cruce.ambiguas.length) lineas.push(`${e.cruce.ambiguas.length} nombre(s) ambiguo(s) (no se guardan).`);
        if (e.cruce.duplicados.length) lineas.push(`${e.cruce.duplicados.length} deportista(s) repetido(s) en la hoja.`);
    }
    lineas.push('', '«Sin marca» no cuenta como falta: solo se guardan los presentes. Revisa y toca *Guardar*.');
    return lineas.join('\n');
}

const botonesResumen = (id: string): BotonStaff[] => [
    { id: `asis_guardar:${id}`, title: 'Guardar' },
    { id: `asis_corregir:${id}`, title: 'Corregir' },
    { id: `asis_descartar:${id}`, title: 'Descartar' },
];

async function obtenerImagen(p: RecibirPlanillaParams): Promise<{ base64: string; mime: string; buffer: Buffer } | { error: string }> {
    if (p.buffer) return { base64: p.buffer.toString('base64'), mime: p.mime ?? 'image/jpeg', buffer: p.buffer };
    if (p.base64) {
        const b = Buffer.from(p.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
        return { base64: b.toString('base64'), mime: p.mime ?? 'image/jpeg', buffer: b };
    }
    if (p.mediaId) {
        const r = await downloadMedia(p.integration as WhatsAppIntegration, p.mediaId);
        if (!r.ok || !r.base64) return { error: r.error ?? 'No pude bajar la foto.' };
        const buffer = Buffer.from(r.base64, 'base64');
        return { base64: r.base64, mime: r.mimeType ?? p.mime ?? 'image/jpeg', buffer };
    }
    return { error: 'No llegó ninguna foto.' };
}

export interface RecibirPlanillaParams {
    integration: Pick<WhatsAppIntegration, 'id' | 'school_id'> & Partial<WhatsAppIntegration>;
    waId: string;
    staff: StaffIdentificado;
    mediaId?: string | null;
    buffer?: Buffer | null;
    base64?: string | null;
    mime?: string | null;
    queueId?: string | null;
    source?: 'whatsapp' | 'app';
    ahora?: Date;
    /** Si es true y el OCR dice que NO es planilla, devuelve `no_aplica` (para no secuestrar un comprobante). */
    soloSiEsPlanilla?: boolean;
}

/**
 * Foto de planilla → intake `por_revisar` + resumen. Devuelve `no_aplica` si la
 * imagen no es una planilla de asistencia (el caller sigue con comprobantes,
 * matrícula, etc.). Guarda la foto ANTES del OCR para no perderla.
 */
export async function recibirPlanillaDeStaff(p: RecibirPlanillaParams): Promise<RespuestaStaff> {
    const schoolId = p.staff.schoolId ?? p.integration.school_id;
    const ahora = p.ahora ?? new Date();
    const hoy = formatDateInZone(ahora);

    const img = await obtenerImagen(p);
    if ('error' in img) return { estado: 'error', texto: 'No pude abrir la foto. Mándala de nuevo, de frente y con buena luz.' };
    if (img.buffer.length > MAX_BYTES) return { estado: 'error', texto: 'La foto pesa demasiado. Tómala de nuevo o recórtala.' };

    // Permiso y equipos ANTES de subir la foto y de pagar el OCR (B2: el OCR se cobraba y luego fallaba).
    // Desde la app la ruta ya validó el permiso; por WhatsApp se valida aquí.
    if (p.staff.role === 'coach' && (p.source ?? 'whatsapp') !== 'app' && !(await coachPuedeSubirPlanillas(schoolId))) {
        return { estado: 'error', texto: TEXTO_SIN_PERMISO_PLANILLA };
    }
    let permitidos: EquipoEscuela[];
    try {
        permitidos = await equiposPermitidos(schoolId, p.staff, await cargarEquiposOFallar(schoolId));
    } catch {
        return { estado: 'error', texto: 'No pude cargar tus equipos en este momento. Intenta de nuevo en unos minutos.' };
    }
    if (!permitidos.length) return { estado: 'error', texto: 'No tienes equipos asignados para pasar lista.' };

    const ext = img.mime === 'application/pdf' ? 'pdf' : (img.mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const photoPath = `${schoolId}/attendance/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from(BUCKET_PLANILLAS).upload(photoPath, img.buffer, { contentType: img.mime, upsert: false });
    if (upErr) return { estado: 'error', texto: 'No pude guardar la foto. Intenta de nuevo en un momento.' };

    const quitarFoto = () => supabase.storage.from(BUCKET_PLANILLAS).remove([photoPath]);

    let ocr: AttendanceSheetResult;
    try {
        ocr = await extractAttendanceSheet(img.base64, img.mime);
    } catch (err: any) {
        // Cuota/caída del OCR: la foto queda guardada y el intake en 'error' para reintentar desde la app.
        const { error } = await tabla().insert({
            school_id: schoolId, integration_id: p.integration.id, queue_id: p.queueId ?? null, source: p.source ?? 'whatsapp',
            submitted_by: p.staff.profileId ?? null, submitted_by_wa_id: p.waId || null, photo_path: photoPath,
            status: 'error', notas: `OCR no disponible: ${String(err?.message ?? err).slice(0, 300)}`,
        });
        if (error && esTablaAusente(error)) { await quitarFoto(); return NO_DISPONIBLE; }
        return { estado: 'error', texto: 'No pude leer la planilla en este momento. Quedó guardada; inténtalo de nuevo en unos minutos o súbela desde la app.' };
    }

    if (!ocr.isAttendanceSheet) {
        await quitarFoto();
        return { estado: 'no_aplica', texto: '' };
    }
    if (!ocr.rows.length) {
        await quitarFoto();
        return { estado: 'error', texto: 'No pude leer filas en la foto. Toma la hoja completa, de frente, sin dobleces y con buena luz.' };
    }

    // Equipo: rosters de los equipos que puede tocar quien la mandó (ya validados arriba).
    const rosters = await cargarRosters(schoolId, permitidos);
    const horarios: HorarioEquipo[] = permitidos.map((e) => ({ team_id: e.id, team_name: e.name, schedule: e.schedule }));
    const nombresOCR = ocr.rows.filter((r) => !r.struck).map((r) => r.name);
    const inferencia = inferirEquipo({ nombresOCR, encabezadoOCR: ocr.groupHeader ?? ocr.title, ahora, rosters, horarios });

    const equipos = await armarEquipos(ocr, inferencia, rosters, permitidos, { hoy, ahora });
    const equipoUnico = equipos.length === 1 ? equipos[0] : null;
    const seguro = inferencia.particion ? true : inferencia.team_id && inferencia.confianza === 'alta';

    const { data: intake, error: insErr } = await tabla().insert({
        school_id: schoolId, integration_id: p.integration.id, queue_id: p.queueId ?? null, source: p.source ?? 'whatsapp',
        submitted_by: p.staff.profileId ?? null, submitted_by_wa_id: p.waId || null, photo_path: photoPath,
        team_id: seguro && equipoUnico ? equipoUnico.team_id : null,
        session_date: equipoUnico?.fechas[equipoUnico.fechas.length - 1] ?? null,
        extracted: ocr, matches: equipos.length ? { modo: 'foto', equipos, hoy } satisfies MatchesFoto : null,
        team_candidates: inferencia, status: 'por_revisar',
    }).select('id').single();
    if (insErr || !intake) {
        await quitarFoto();
        if (esTablaAusente(insErr)) return NO_DISPONIBLE;
        return { estado: 'error', texto: 'Leí la planilla pero no pude guardarla para revisión. Intenta de nuevo.' };
    }

    if (!seguro) return preguntarEquipo(intake.id as string, inferencia, permitidos);
    return { estado: 'resumen', intakeId: intake.id as string, texto: textoResumenEquipos(equipos), botones: botonesResumen(intake.id as string) };
}

async function armarEquipos(
    ocr: AttendanceSheetResult, inf: InferenciaEquipo, rosters: RosterEquipo[], permitidos: EquipoEscuela[],
    ctx: { hoy: string; ahora: Date },
): Promise<EquipoCruzado[]> {
    const hacer = (teamId: string, nombres?: string[]) => {
        const r = rosters.find((x) => x.team_id === teamId)!;
        const eq = permitidos.find((e) => e.id === teamId);
        const sug = fechaSesionSugerida(eq?.schedule ?? null, ctx.ahora).fecha;
        return construirCruce(ocr, r, r.atletas, { hoy: ctx.hoy, fechaPorDefecto: sug, nombresDelEquipo: nombres });
    };
    if (inf.particion) return inf.particion.map((pt) => hacer(pt.team_id, pt.nombres));
    if (inf.team_id) return [hacer(inf.team_id)];
    return [];
}

function preguntarEquipo(intakeId: string, inf: InferenciaEquipo, permitidos: EquipoEscuela[]): RespuestaStaff {
    const cands = (inf.candidatos.length ? inf.candidatos : permitidos.map((e) => ({ team_id: e.id, team_name: e.name })))
        .slice(0, 2).map((c) => ({ id: `asis_equipo:${intakeId}:${c.team_id}`, title: recorta(bonito(c.team_name), 20) }));
    return {
        estado: 'pregunta_equipo', intakeId,
        texto: `Leí la planilla pero no estoy seguro de qué grupo es. ${inf.motivo}\n¿De qué grupo es?`,
        botones: [...cands, { id: `asis_equipo:${intakeId}:otro`, title: 'Otro' }],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Camino 2 — «lista»
// ─────────────────────────────────────────────────────────────────────────────
const DISPARADORES_LISTA = new Set(['lista', 'pasar lista', 'tomar lista', 'asistencia', 'la lista', 'quiero pasar lista']);
export const esDisparadorDeLista = (texto: string) => DISPARADORES_LISTA.has(normalizarNombre(texto));

export type RespuestaLista =
    | { ok: true; tipo: 'todos' | 'ninguno' | 'faltaron' | 'presentes'; numeros: number[]; ausentes: number[] }
    | { ok: false; error: string }
    | null;

/**
 * Parser determinista (sin LLM) de la respuesta a la lista numerada.
 *   «todos» · «ninguno» · «faltaron 3 y 7» · «falto el 5» · «no vinieron 2, 4 y 9» ·
 *   «todos menos 3» · «3-5» (rangos) · «vinieron 1 2 5» / «solo 1,2» (solo esos asistieron)
 * Devuelve null si el texto no parece una respuesta a la lista (el bot sigue normal).
 */
export function parsearRespuestaLista(texto: string, total: number): RespuestaLista {
    const t = normalizarNombre(texto);
    if (!t) return null;
    if (/^(todos|todas|todos vinieron|vinieron todos|completo|nadie falto|no falto nadie|sin faltas?)$/.test(t)) {
        return { ok: true, tipo: 'todos', numeros: [], ausentes: [] };
    }
    if (/^(ninguno|ninguna|nadie|nadie vino|no vino nadie|no vinieron|no hubo clase|ninguno vino)$/.test(t)) {
        return { ok: true, tipo: 'ninguno', numeros: [], ausentes: Array.from({ length: total }, (_, i) => i + 1) };
    }
    const kw = /^(faltaron|falto|faltan|falta|ausentes?|ausencias?|no vinieron|no vino|no asistieron|no asistio|todos menos|menos|vinieron|vino|solo|solamente|presentes?|asistieron|asistio)\b/.exec(t);
    if (!kw) return null;
    // Los números se leen del texto original: normalizarNombre borra el «-» de los rangos («3-5»).
    const resto = texto.toLowerCase();
    const numeros: number[] = [];
    const sinRangos = resto.replace(/(\d+)\s*(?:-|–|a|al)\s*(\d+)/g, (_m, a, b) => {
        const [x, y] = [Number(a), Number(b)];
        if (y >= x && y - x <= 200) for (let i = x; i <= y; i++) numeros.push(i);
        return ' ';
    });
    for (const m of sinRangos.matchAll(/\d+/g)) numeros.push(Number(m[0]));
    const unicos = [...new Set(numeros)].sort((a, b) => a - b);
    if (!unicos.length) return { ok: false, error: 'No entendí los números. Escribe por ejemplo «faltaron 3 y 7», «todos» o «ninguno».' };
    const fuera = unicos.filter((n) => n < 1 || n > total);
    if (fuera.length) return { ok: false, error: `El número ${fuera.join(', ')} no está en la lista (va de 1 a ${total}). Escríbelo de nuevo.` };
    const sonPresentes = /^(vinieron|vino|solo|solamente|presentes?|asistieron|asistio)$/.test(kw[0]);
    if (sonPresentes) {
        const aus = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !unicos.includes(n));
        return { ok: true, tipo: 'presentes', numeros: unicos, ausentes: aus };
    }
    return { ok: true, tipo: 'faltaron', numeros: unicos, ausentes: unicos };
}

async function iniciarLista(p: { staff: StaffIdentificado; schoolId: string; ahora: Date }): Promise<RespuestaStaff> {
    const todos = await cargarEquipos(p.schoolId);
    const permitidos = await equiposPermitidos(p.schoolId, p.staff, todos);
    if (!permitidos.length) return { estado: 'error', texto: 'No tienes equipos asignados para pasar lista.' };
    const horarios: HorarioEquipo[] = permitidos.map((e) => ({ team_id: e.id, team_name: e.name, schedule: e.schedule }));
    const activas = franjasActivas(horarios, p.ahora);
    // Un equipo con dos subgrupos activos a la vez sale en un solo botón (el roster es del equipo).
    const porEquipo = new Map<string, { team_id: string; team_name: string; grupos: string[]; time: string }>();
    for (const f of activas) {
        const x = porEquipo.get(f.team_id) ?? { team_id: f.team_id, team_name: f.team_name, grupos: [], time: f.time };
        if (f.group && !x.grupos.includes(f.group)) x.grupos.push(f.group);
        porEquipo.set(f.team_id, x);
    }
    const hayActivas = porEquipo.size > 0;
    const opciones = hayActivas
        ? [...porEquipo.values()].map((x) => ({ id: `asis_grupo:${x.team_id}`, title: recorta(bonito(x.team_name) + (x.grupos.length === 1 ? ` · ${x.grupos[0]}` : ''), 20) }))
        : permitidos.slice(0, 10).map((e) => ({ id: `asis_grupo:${e.id}`, title: recorta(bonito(e.name), 20) }));
    return {
        estado: 'pregunta_grupo',
        texto: hayActivas ? '¿De qué grupo pasas lista?' : 'No veo clases en esta franja (±2 h). ¿De qué grupo pasas lista?',
        botones: opciones,
    };
}

async function elegirGrupoLista(p: { staff: StaffIdentificado; waId: string; integration: RecibirIntegracion; teamId: string; ahora: Date; queueId?: string | null }): Promise<RespuestaStaff> {
    const schoolId = p.staff.schoolId ?? p.integration.school_id;
    const todos = await cargarEquipos(schoolId);
    const permitidos = await equiposPermitidos(schoolId, p.staff, todos);
    const eq = permitidos.find((e) => e.id === p.teamId);
    if (!eq) return { estado: 'error', texto: 'Ese grupo no está entre los tuyos.' };
    const [roster] = await cargarRosters(schoolId, [eq]);
    const atletas = [...roster.atletas].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    if (!atletas.length) return { estado: 'error', texto: `${bonito(eq.name)} no tiene deportistas activos.` };
    const hoy = formatDateInZone(p.ahora);
    const matches: MatchesLista = {
        modo: 'lista', team_id: eq.id, team_name: eq.name, fecha: hoy,
        roster: atletas.map((a, i) => ({ n: i + 1, id: a.id, kind: a.kind ?? 'child', nombre: a.nombre })),
    };
    // Una lista abierta anterior del mismo coach se reemplaza (queda descartada).
    const { error: e0 } = await tabla().update({ status: 'descartada', notas: 'reemplazada por otra lista' })
        .eq('submitted_by_wa_id', p.waId).eq('status', 'por_revisar').eq('school_id', schoolId).eq('source', 'whatsapp').is('photo_path', null);
    if (e0 && esTablaAusente(e0)) return NO_DISPONIBLE;
    const { data: intake, error } = await tabla().insert({
        school_id: schoolId, integration_id: p.integration.id, queue_id: p.queueId ?? null, source: 'whatsapp',
        submitted_by: p.staff.profileId ?? null, submitted_by_wa_id: p.waId, photo_path: null,
        team_id: eq.id, session_date: hoy, extracted: { modo: 'lista' }, matches, status: 'por_revisar',
    }).select('id').single();
    if (error || !intake) return esTablaAusente(error) ? NO_DISPONIBLE : { estado: 'error', texto: 'No pude abrir la lista. Intenta de nuevo.' };
    const lineas = matches.roster.map((r) => `${r.n}. ${bonito(r.nombre)}`);
    return {
        estado: 'lista', intakeId: intake.id as string,
        texto: `*${bonito(eq.name)}, ${fechaCorta(hoy)}*\n${lineas.join('\n')}\n\nResponde «faltaron 3 y 7», «todos» o «ninguno».`,
    };
}

type RecibirIntegracion = Pick<WhatsAppIntegration, 'id' | 'school_id'> & Partial<WhatsAppIntegration>;

async function guardarLista(intake: any, r: Extract<RespuestaLista, { ok: true }>, staff: StaffIdentificado): Promise<RespuestaStaff> {
    const m = intake.matches as MatchesLista;
    if (!(await coachPuedeConEquipos(staff, intake.school_id, [m.team_id]))) return { estado: 'error', intakeId: intake.id, texto: SIN_PERMISO };
    const ausSet = new Set(r.ausentes);
    const records: RegistroAsistencia[] = m.roster.map((x) => ({
        ...refDeAtleta({ id: x.id, kind: x.kind, nombre: x.nombre }),
        status: ausSet.has(x.n) ? 'absent' : 'present',
    }));
    const res = await guardarConPermiso({
        schoolId: intake.school_id, teamId: m.team_id, fecha: m.fecha, records, staff,
        notes: 'whatsapp_lista', esHistorica: false,
    });
    if (!res.ok) return { estado: 'error', intakeId: intake.id, texto: res.texto };
    const presentes = m.roster.length - ausSet.size;
    await tabla().update({ status: 'guardada', session_id: res.sessionId, reviewed_by: staff.profileId ?? null, reviewed_at: new Date().toISOString() }).eq('id', intake.id);
    const nombresAus = m.roster.filter((x) => ausSet.has(x.n)).map((x) => bonito(x.nombre.split(' ')[0]));
    return {
        estado: 'guardada', intakeId: intake.id,
        sesiones: [{ teamId: m.team_id, fecha: m.fecha, sessionId: res.sessionId, presentes, ausentes: ausSet.size }],
        texto: `Guardada: ${bonito(m.team_name)}, ${fechaCorta(m.fecha)}: ${presentes} presentes, ${ausSet.size} faltaron`
            + `${nombresAus.length && nombresAus.length <= 6 ? ` (${nombresAus.join(', ')})` : ''}.\nSi te equivocaste, escribe «lista» y repítela.`,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guardado común (reusa POST /session vía guardarSesionAsistencia)
// ─────────────────────────────────────────────────────────────────────────────
async function guardarConPermiso(p: {
    schoolId: string; teamId: string; fecha: string; records: RegistroAsistencia[]; staff: StaffIdentificado; notes: string; esHistorica: boolean;
}): Promise<{ ok: true; sessionId: string } | { ok: false; texto: string; cerrada?: boolean }> {
    const rol = p.staff.role === 'owner' ? 'owner' : p.staff.role ?? 'coach';
    const f = await resolverFechaDeTrabajo(p.fecha, rol, p.schoolId);
    if (!f.ok) return { ok: false, texto: String((f.body as any).error ?? 'Esa fecha no se puede cargar.') };
    // Días pasados: la sesión nueva entra ya cerrada → sin descuentos ni avisos viejos.
    const r = await guardarSesionAsistencia({
        schoolId: p.schoolId, teamId: p.teamId, date: f.date, esRetroactiva: f.esRetroactiva,
        records: p.records, markedBy: p.staff.profileId ?? null,
        finalized: p.esHistorica && f.esRetroactiva, notes: p.notes,
    });
    if (!r.ok) {
        const b = r.body as any;
        if (b?.reason === 'session_finalized') return { ok: false, cerrada: true, texto: `La lista del ${fechaCorta(p.fecha)} ya estaba cerrada. Para cambiarla hay que reabrirla desde la app.` };
        if (b?.reason === 'multiple_sessions_today') return { ok: false, texto: 'Ese grupo tiene varios bloques ese día. Pásala desde la app eligiendo el bloque.' };
        return { ok: false, texto: String(b?.error ?? 'No pude guardar la asistencia.') };
    }
    return { ok: true, sessionId: r.sessionId };
}

/** Un coach solo guarda en equipos que tiene asignados (el BFF corre con service role: este es el gate). */
async function coachPuedeConEquipos(staff: StaffIdentificado, schoolId: string, teamIds: string[]): Promise<boolean> {
    if (staff.role !== 'coach') return true;
    const todos = await cargarEquipos(schoolId);
    const ok = new Set((await equiposPermitidos(schoolId, staff, todos)).map((e) => e.id));
    return teamIds.every((t) => ok.has(t));
}
const SIN_PERMISO = 'Ese grupo no está entre los tuyos.';

/** Guarda un intake de foto: una sesión por (equipo, fecha) con presentes. «Sin marca» no se escribe. */
async function guardarFoto(intake: any, staff: StaffIdentificado, correcciones: Correcciones | undefined, ahora: Date): Promise<RespuestaStaff> {
    const m = intake.matches as MatchesFoto | null;
    if (!m?.equipos?.length) return { estado: 'error', intakeId: intake.id, texto: 'Esta planilla no tiene un grupo definido. Elige el grupo primero.' };
    const equipos = correcciones ? aplicarCorrecciones(m.equipos, correcciones) : m.equipos;
    if (!(await coachPuedeConEquipos(staff, intake.school_id, equipos.map((e) => e.team_id)))) return { estado: 'error', intakeId: intake.id, texto: SIN_PERMISO };
    const sesiones: NonNullable<RespuestaStaff['sesiones']> = [];
    const avisos: string[] = [];
    for (const e of equipos) {
        for (const d of e.cruce.porFecha) {
            if (!d.presentes.length) continue;
            const todos = await cargarRosterPorIds(intake.school_id, e.team_id);
            const records: RegistroAsistencia[] = d.presentes
                .filter((f) => f.atletaId)
                .map((f) => ({ ...refDeAtleta(todos.get(f.atletaId!) ?? { id: f.atletaId!, kind: 'child', nombre: f.nombreHoja }), status: 'present' }));
            if (!records.length) continue;
            const r = await guardarConPermiso({
                schoolId: intake.school_id, teamId: e.team_id, fecha: d.fecha, records, staff,
                notes: 'whatsapp_foto', esHistorica: d.fecha < formatDateInZone(ahora),
            });
            if (r.ok) sesiones.push({ teamId: e.team_id, fecha: d.fecha, sessionId: r.sessionId, presentes: records.length, ausentes: 0 });
            else avisos.push(`${bonito(e.team_name)} ${fechaCorta(d.fecha)}: ${r.texto}`);
        }
    }
    if (!sesiones.length) return { estado: 'error', intakeId: intake.id, texto: avisos.length ? avisos.join('\n') : 'No había nada para guardar.' };
    await tabla().update({
        status: 'guardada', session_id: sesiones[0].sessionId, reviewed_by: staff.profileId ?? null, reviewed_at: new Date().toISOString(),
        matches: { ...m, equipos }, notas: avisos.length ? avisos.join(' | ').slice(0, 500) : null,
    }).eq('id', intake.id);
    const total = sesiones.reduce((s, x) => s + x.presentes, 0);
    return {
        estado: 'guardada', intakeId: intake.id, sesiones,
        texto: `Guardé ${sesiones.length} sesión${sesiones.length > 1 ? 'es' : ''} con ${total} asistencias.`
            + (avisos.length ? `\nNo se guardó:\n${avisos.join('\n')}` : ''),
    };
}

async function cargarRosterPorIds(schoolId: string, teamId: string): Promise<Map<string, AtletaRoster>> {
    const [r] = await cargarRosters(schoolId, [{ id: teamId, name: '', schedule: null }]);
    return new Map((r?.atletas ?? []).map((a) => [a.id, a]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Correcciones (desde la app) y confirmación
// ─────────────────────────────────────────────────────────────────────────────
export interface Correcciones {
    /** Reemplaza el equipo (recalcula el cruce desde el OCR). */
    teamId?: string;
    /** Presentes finales por fecha, ids de atleta (lo que el coach dejó marcado en la grilla). */
    porFecha?: Array<{ teamId?: string; fecha: string; presentes: string[] }>;
}

/** Aplica la grilla editada: deja como presentes exactamente los ids dados. Pura. */
export function aplicarCorrecciones(equipos: EquipoCruzado[], c: Correcciones): EquipoCruzado[] {
    if (!c.porFecha?.length) return equipos;
    return equipos.map((e) => {
        const nuevas = c.porFecha!.filter((x) => !x.teamId || x.teamId === e.team_id);
        if (!nuevas.length) return e;
        const porFecha = e.cruce.porFecha.map((d) => {
            const ed = nuevas.find((x) => x.fecha === d.fecha);
            if (!ed) return d;
            const set = new Set(ed.presentes);
            const todas = [...d.presentes, ...d.sinMarca];
            const conocidos = new Map(todas.map((f) => [f.atletaId, f]));
            const presentes = ed.presentes.map((id) => conocidos.get(id) ?? ({
                nombreHoja: '(agregado a mano)', atletaId: id, atletaNombre: null, score: 1, estado: 'exacto' as const,
                sugerencia: null, marcasPorFecha: { [d.fecha]: 'asistio' as const },
            }));
            return { ...d, presentes, sinMarca: todas.filter((f) => !set.has(f.atletaId!)) };
        });
        const extras = nuevas.filter((x) => !porFecha.some((d) => d.fecha === x.fecha));
        for (const x of extras) {
            porFecha.push({
                fecha: x.fecha, sinMarca: [], dudosas: [],
                presentes: x.presentes.map((id) => ({
                    nombreHoja: '(agregado a mano)', atletaId: id, atletaNombre: null, score: 1, estado: 'exacto' as const,
                    sugerencia: null, marcasPorFecha: { [x.fecha]: 'asistio' as const },
                })),
            });
        }
        porFecha.sort((a, b) => a.fecha.localeCompare(b.fecha));
        return { ...e, cruce: { ...e.cruce, porFecha }, fechas: porFecha.filter((d) => d.presentes.length).map((d) => d.fecha) };
    });
}

export type AccionPlanilla = 'guardar' | 'descartar' | 'corregir' | { equipo: string };

/**
 * Acción sobre un intake. `staff` es quien la toca (marca `marked_by` y valida
 * el alcance del coach). Reglas: solo se actúa sobre filas `por_revisar` de SU escuela.
 */
export async function confirmarPlanilla(
    intakeId: string, accion: AccionPlanilla,
    opts: { staff: StaffIdentificado; correcciones?: Correcciones; ahora?: Date },
): Promise<RespuestaStaff> {
    const { data: intake, error } = await tabla().select('*').eq('id', intakeId).maybeSingle();
    if (error) return esTablaAusente(error) ? NO_DISPONIBLE : { estado: 'error', texto: 'No pude abrir esa planilla.' };
    if (!intake || (opts.staff.schoolId && intake.school_id !== opts.staff.schoolId)) return { estado: 'error', texto: 'No encontré esa planilla.' };
    if (intake.status === 'guardada') return { estado: 'guardada', intakeId, texto: 'Esa planilla ya estaba guardada.' };
    if (intake.status === 'descartada') return { estado: 'descartada', intakeId, texto: 'Esa planilla ya estaba descartada.' };
    if (intake.status !== 'por_revisar') return { estado: 'error', intakeId, texto: 'Esa planilla no se pudo leer; súbela de nuevo.' };

    const staff: StaffIdentificado = { ...opts.staff, schoolId: intake.school_id };

    if (accion === 'descartar') {
        await tabla().update({ status: 'descartada', reviewed_by: staff.profileId ?? null, reviewed_at: new Date().toISOString() }).eq('id', intakeId);
        return { estado: 'descartada', intakeId, texto: 'Listo, descarté la planilla. No se guardó nada.' };
    }

    if (accion === 'corregir') {
        return {
            estado: 'correccion', intakeId,
            texto: 'Para corregir nombres o marcas abre la app: Asistencia → *Planillas por revisar*. Ahí ves la foto al lado y ajustas antes de guardar.\nSi está bien así, toca Guardar.',
            botones: [{ id: `asis_guardar:${intakeId}`, title: 'Guardar así' }, { id: `asis_descartar:${intakeId}`, title: 'Descartar' }],
        };
    }

    if (typeof accion === 'object') return cambiarEquipo(intake, accion.equipo, staff, opts.ahora ?? new Date());

    if (intake.matches?.modo === 'lista') {
        return { estado: 'error', intakeId, texto: 'Responde con los números: «faltaron 3 y 7», «todos» o «ninguno».' };
    }
    if (opts.correcciones?.teamId && opts.correcciones.teamId !== intake.team_id) {
        const r = await cambiarEquipo(intake, opts.correcciones.teamId, staff, opts.ahora ?? new Date(), true);
        if (r.estado === 'error') return r;
        const { data: nuevo } = await tabla().select('*').eq('id', intakeId).maybeSingle();
        return guardarFoto(nuevo, staff, opts.correcciones, opts.ahora ?? new Date());
    }
    return guardarFoto(intake, staff, opts.correcciones, opts.ahora ?? new Date());
}

/** Cambia el equipo de un intake de foto y recalcula el cruce desde el OCR guardado. */
async function cambiarEquipo(intake: any, teamId: string, staff: StaffIdentificado, ahora: Date, silencioso = false): Promise<RespuestaStaff> {
    if (teamId === 'otro') {
        const todos = await cargarEquipos(intake.school_id);
        const permitidos = await equiposPermitidos(intake.school_id, staff, todos);
        return {
            estado: 'pregunta_equipo', intakeId: intake.id, texto: 'Elige el grupo de la planilla:',
            botones: permitidos.slice(0, 10).map((e) => ({ id: `asis_equipo:${intake.id}:${e.id}`, title: recorta(bonito(e.name), 20) })),
        };
    }
    const todos = await cargarEquipos(intake.school_id);
    const permitidos = await equiposPermitidos(intake.school_id, staff, todos);
    const eq = permitidos.find((e) => e.id === teamId);
    if (!eq) return { estado: 'error', intakeId: intake.id, texto: 'Ese grupo no está entre los tuyos.' };
    const ocr = intake.extracted as AttendanceSheetResult;
    if (!ocr?.rows?.length) return { estado: 'error', intakeId: intake.id, texto: 'Esta planilla no tiene filas leídas.' };
    const [roster] = await cargarRosters(intake.school_id, [eq]);
    const hoy = formatDateInZone(ahora);
    const e = construirCruce(ocr, roster, roster.atletas, { hoy, fechaPorDefecto: fechaSesionSugerida(eq.schedule, ahora).fecha });
    const matches: MatchesFoto = { modo: 'foto', equipos: [e], hoy };
    await tabla().update({ team_id: eq.id, session_date: e.fechas[e.fechas.length - 1] ?? null, matches }).eq('id', intake.id);
    if (silencioso) return { estado: 'resumen', intakeId: intake.id, texto: '' };
    return { estado: 'resumen', intakeId: intake.id, texto: textoResumenEquipos([e]), botones: botonesResumen(intake.id) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Punto de entrada único para el job/bot: texto o botón de un contacto
// ─────────────────────────────────────────────────────────────────────────────
export interface MensajeStaffParams {
    integration: RecibirIntegracion;
    waId: string;
    texto?: string | null;
    botonId?: string | null;
    /** Si el caller ya identificó al staff, evita la segunda llamada al RPC. */
    staff?: StaffIdentificado;
    ahora?: Date;
    queueId?: string | null;
}

/**
 * Procesa un texto o un botón. Devuelve `null` si NO es de asistencia → el caller
 * sigue su flujo normal (pagos, atención, etc.). Solo responde cuando:
 *   · llega un botón `asis_*`;
 *   · el texto es «lista» (o equivalente);
 *   · hay una lista abierta (≤ 6 h) y el texto es una respuesta válida o claramente de lista.
 */
export async function procesarMensajeStaff(p: MensajeStaffParams): Promise<RespuestaStaff | null> {
    const esBoton = !!p.botonId && p.botonId.startsWith('asis_');
    const texto = (p.texto ?? '').trim();
    if (!esBoton && !texto) return null;
    // Barato primero: sin botón ni palabra clave solo importa si hay una lista abierta.
    const candidatoTexto = !esBoton && (esDisparadorDeLista(texto) || /\d|todos|todas|ninguno|ninguna|nadie|falt|vini|solo/i.test(texto));
    if (!esBoton && !candidatoTexto) return null;

    const staff = p.staff ?? await identificarStaffPorTelefono(p.integration.id, p.waId);
    if (staff.resultado !== 'staff') return null;
    const schoolId = staff.schoolId ?? p.integration.school_id;
    if (staff.schoolId && staff.schoolId !== p.integration.school_id) return null;
    const ahora = p.ahora ?? new Date();

    if (esBoton) {
        const [, a, b] = p.botonId!.split(':');
        const accion = p.botonId!.split(':')[0];
        if (accion === 'asis_grupo') return elegirGrupoLista({ staff, waId: p.waId, integration: p.integration, teamId: a, ahora, queueId: p.queueId });
        if (accion === 'asis_equipo') return confirmarPlanilla(a, { equipo: b }, { staff, ahora });
        if (accion === 'asis_guardar') return confirmarPlanilla(a, 'guardar', { staff, ahora });
        if (accion === 'asis_corregir') return confirmarPlanilla(a, 'corregir', { staff, ahora });
        if (accion === 'asis_descartar') return confirmarPlanilla(a, 'descartar', { staff, ahora });
        return null;
    }

    if (esDisparadorDeLista(texto)) return iniciarLista({ staff, schoolId, ahora });

    // ¿hay lista abierta? (estado = la fila por_revisar sin foto de este contacto)
    const desde = new Date(ahora.getTime() - VIGENCIA_ESTADO_H * 3600_000).toISOString();
    const { data: abierta, error } = await tabla().select('*')
        .eq('school_id', schoolId).eq('submitted_by_wa_id', p.waId).eq('source', 'whatsapp')
        .eq('status', 'por_revisar').is('photo_path', null).gte('created_at', desde)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !abierta || abierta.matches?.modo !== 'lista') return null;
    const total = (abierta.matches as MatchesLista).roster.length;
    if (/^(cancelar|cancela|salir)$/i.test(normalizarNombre(texto))) {
        await tabla().update({ status: 'descartada', reviewed_at: new Date().toISOString() }).eq('id', abierta.id);
        return { estado: 'descartada', intakeId: abierta.id, texto: 'Listo, cancelé la lista. No se guardó nada.' };
    }
    const r = parsearRespuestaLista(texto, total);
    if (!r) return null;
    if (!r.ok) return { estado: 'lista', intakeId: abierta.id, texto: r.error };
    return guardarLista(abierta, r, staff);
}
