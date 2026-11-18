/**
 * whatsapp-ausencias.service — «Mi hija no puede ir hoy» (mejora 5, 2026-10-06).
 *
 * Es de lo más frecuente en el chat de Dynasty (docs/analisis/
 * whatsapp-conversaciones-dynasty-2026-10-06.md: «Ausencias, salud,
 * vacaciones», 12 %). Antes caía al modelo, que no tiene dónde registrarlo, y el
 * entrenador se enteraba —si se enteraba— por Milena.
 *
 * Todo es determinista, SIN modelo:
 *   1. `detectaAusencia(texto)`  → ¿avisa una ausencia? ¿qué día? ¿por qué?
 *   2. ¿De quién?                 → un solo deportista activo: ese. Si nombra a
 *                                   uno: ese. Si hay varios: se pregunta con
 *                                   botones y la respuesta se cruza con el aviso
 *                                   que quedó en el chat (sin estado aparte).
 *   3. Registro                   → `athlete_absence_notices` (mig 20261006101628).
 *                                   El roster de asistencia lo cruza y la lista
 *                                   del coach precarga «excusado». 'excused' NO
 *                                   descuenta créditos: no se toca `enrollments`.
 *   4. Avisos                     → in-app + push a los entrenadores del equipo,
 *                                   in-app a la administración (Milena).
 */

import { supabase } from '../config/supabase';
import { sendToUser } from './push.service';
import { todayInZone } from '../utils/businessDate';
import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import type { BotonInteractivo } from './whatsapp.service';

// ─── 1. Detección (pura) ─────────────────────────────────────────────────────

export type MotivoAusencia =
    'enfermedad' | 'cita_medica' | 'viaje' | 'lesion' | 'colegio' | 'familiar' | 'otro';

export interface AusenciaDetectada {
    dia: 'hoy' | 'manana' | 'fecha';
    /** YYYY-MM-DD (zona de negocio). */
    fecha: string;
    motivo?: MotivoAusencia;
}

const VERBO_ASISTIR = '(ir|asistir|entrenar|llegar|venir|llevarl[oa]s?|participar)';

/** «no puede ir», «no va a poder asistir», «no alcanza a llegar», «no la puedo llevar». */
const NO_PUEDE = new RegExp(
    `\\bno (puede|pueden|podra|podran|podria|puedo|podemos|va a poder|van a poder|vamos a poder|voy a poder|alcanza a|alcanzamos a|alcanza|alcanzo a)\\b(?: \\w+){0,3}? ${VERBO_ASISTIR}\\b`,
);
const NO_LO_LLEVO = /\bno (lo|la|los|las) (puedo|podemos|podre|vamos a poder|voy a poder|alcanzo a) llevar\b/;
/** «no va», «no asiste», «no vamos» — solo cuenta con contexto de clase o de día. */
const NO_VA = /\bno (va|van|vamos|voy|ira|iran|iremos|asiste|asisten|asistira|asistiran|asistimos|entrena|entrenara|entrenaran|llega|llegara|viene|vendra|vendran)\b(?! a (pagar|poder pagar|consignar|transferir|abonar|cancelar el|cobrar))/;
const EXCUSA = /\b(excusar(lo|la|los|las)?|lo excuso|la excuso|se excusa|se excusan|va a faltar|van a faltar|faltara|faltaran|falta hoy|falta manana)\b/;
const CONTEXTO = /\b(hoy|manana|entreno|entrenamiento|entrenar|clase|clases|practica|partido|lunes|martes|miercoles|jueves|viernes|sabado|domingo|enferm\w*|fiebre|gripa|cita)\b/;
/** «no sé si pueda ir», «si no puede ir avíseme»: no es un aviso. */
const DUDA = /\b(no se si|todavia no se|aun no se|no estoy segur[oa])\b/;
/** Plata: «el pago no va a llegar hoy» no es una ausencia. */
const DE_PLATA = /\b(pago|pagos|pagar|pague|comprobante|transferencia|consignacion|consigne|factura|cobro|mensualidad|plata|dinero|abono|nequi|daviplata)\b/;
const PREGUNTA_DE_HORARIO = /\b(hay|habra|tienen|tiene) (clase|entreno|entrenamiento|practica)\b/;
/**
 * Un retiro o una salida de grupo no es la ausencia de hoy: «vamos a salir del
 * grupo de capacitaciones porque no alcanzamos a ir» (Monster 2026-11-17, Raúl:
 * el bot contestó «le aviso al entrenador que Raul no va hoy»). Va a la escuela.
 */
const SALIDA_DE_GRUPO = /\b(salir|salimos|salgo|salirnos|salirme|retir\w*|darnos de baja|darme de baja|dar de baja|dejar(?:emos| de)?|dejamos de|cancelar(?:emos)? la (?:inscripcion|matricula)|ya no (?:vamos|voy|va|van) a (?:ir|asistir|entrenar|seguir))\b[^.!?]{0,60}\b(grupo|grupos|club|escuela|capacitacion\w*|clases|entrenamientos|programa|curso)\b/;
const AVISO_DE_SALIDA = /\b(salir (?:oa |o a )?del grupo|del grupo de capacitacion\w*|nos retiramos|me retiro|lo retiro|la retiro|los retiro)\b/;

const MESES_RE = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)';
/** «los sábados», «todos los lunes», «cada viernes», «sábados de 9 a 1». */
const HORARIO_FIJO = /\b(todos los|cada|los) (lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b|\b(sabados|domingos)\b/;
/** «este mes no va a entrenar», «durante dos meses», «unas semanas»: una pausa, no la ausencia de hoy (Dynasty 10-13 y 10-17). */
const PERIODO_LARGO = /\b(este mes|el proximo mes|el mes que viene|todo el mes|\d+ meses|meses|dos semanas|tres semanas|varias semanas|unas semanas|durante)\b/;
/** Una fecha de calendario: «7 de noviembre». El detector solo sabe de hoy, mañana o el próximo día de la semana. */
const FECHA_DE_CALENDARIO = new RegExp(`\\b\\d{1,2} de ${MESES_RE}\\b|\\b${MESES_RE}\\b`);
/** Un evento: «comunicado», «torneo», «selección». Con un día de la semana nombrado («no va el sábado al torneo») sí avisa. */
const EVENTO = /\b(comunicado|torneos?|seleccion|campamento|festival|gira|cuadrangular|curso)\b/;

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const MOTIVOS: [MotivoAusencia, RegExp][] = [
    ['lesion', /\b(lesion\w*|lesiono|esguince|torcedura|fractura|golpe\w*|se golpeo|se doblo)\b/],
    ['cita_medica', /\b(cita|medico|medica|odontolog\w*|dentista|examenes medicos|terapia|urgencias)\b/],
    ['enfermedad', /\b(enferm\w*|fiebre|gripa|gripe|malestar|vomit\w*|diarrea|resfri\w*|tos|virus|dolor\w*|indispuest[oa]|maluco|maluca|incapacidad)\b/],
    ['viaje', /\b(viaj\w*|paseo|vacaciones|fuera de la ciudad|de viaje)\b/],
    ['colegio', /\b(colegio|examen\w*|tareas?|evaluacion\w*|izada|actividad del colegio|universidad)\b/],
    ['familiar', /\b(calamidad|familiar|funeral|velorio|cumpleanos|matrimonio|boda)\b/],
];

function sumarDias(fecha: string, n: number): string {
    const [y, m, d] = fecha.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
}

function diaDeSemana(fecha: string): number {
    const [y, m, d] = fecha.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** ¿«mañana» como día (tomorrow) y no como franja («esta mañana», «en la mañana»)? */
function diceManana(n: string): boolean {
    const re = /\bmanana\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(n))) {
        const antes = n.slice(0, m.index);
        if (/\b(la|esta|por la|en la|de la|toda la|pasado)\s*$/.test(antes)) continue;
        return true;
    }
    return false;
}

/**
 * ¿El texto AVISA que un deportista no va a ir? Devuelve el día y el motivo, o
 * null. Pura: `hoy` (YYYY-MM-DD) se inyecta para los tests.
 *
 * Solo hoy o adelante: «en septiembre no asistió» es un reclamo, no un aviso.
 */
export function detectaAusencia(texto: string | null | undefined, hoy: string = todayInZone()): AusenciaDetectada | null {
    const n = normalizarFrase(texto);
    if (!n || n.length > 400) return null;
    if (DUDA.test(n) || DE_PLATA.test(n)) return null;
    if (PREGUNTA_DE_HORARIO.test(n) && !NO_PUEDE.test(n)) return null;
    if ((SALIDA_DE_GRUPO.test(n) || AVISO_DE_SALIDA.test(n)) && !/\bhoy\b/.test(n) && !diceManana(n)) return null;
    // Sin «hoy» ni «mañana», un horario fijo («los sábados de 9 a 1») o un evento
    // con fecha («el torneo del 7 de noviembre», «el comunicado») no es la
    // ausencia de hoy: va a la escuela. (Dynasty 10-20: «Paula no puede ir… estudia
    // inglés los sábados» recibió «le aviso al entrenador que Maria no va hoy».)
    if (!/\bhoy\b/.test(n) && !diceManana(n)) {
        const diaNombrado = DIAS.some((d) => new RegExp(`\\b${d}\\b`).test(n));
        if (HORARIO_FIJO.test(n) || FECHA_DE_CALENDARIO.test(n) || PERIODO_LARGO.test(n)
            || (EVENTO.test(n) && !diaNombrado)) return null;
    }

    let dispara = NO_PUEDE.test(n) || NO_LO_LLEVO.test(n);
    if (!dispara && (NO_VA.test(n) || EXCUSA.test(n)) && CONTEXTO.test(n)) dispara = true;
    if (!dispara) return null;

    // «Si no puede ir, avíseme» es una condición, no un aviso.
    const m = n.match(NO_PUEDE) ?? n.match(NO_VA) ?? n.match(NO_LO_LLEVO);
    if (m && m.index !== undefined && /\b(si|cuando|en caso de que|por si)\s*$/.test(n.slice(0, m.index))) return null;

    let dia: AusenciaDetectada['dia'] = 'hoy';
    let fecha = hoy;
    if (/\bhoy\b/.test(n)) {
        // hoy manda
    } else if (/\bpasado manana\b/.test(n)) {
        dia = 'fecha'; fecha = sumarDias(hoy, 2);
    } else if (diceManana(n)) {
        dia = 'manana'; fecha = sumarDias(hoy, 1);
    } else {
        const nombrado = DIAS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(n));
        if (nombrado >= 0) {
            const proximo = /\b(proximo|siguiente)\b/.test(n);
            let delta = (nombrado - diaDeSemana(hoy) + 7) % 7;
            if (proximo && delta === 0) delta = 7;
            if (delta === 1) { dia = 'manana'; fecha = sumarDias(hoy, 1); }
            else if (delta > 0) { dia = 'fecha'; fecha = sumarDias(hoy, delta); }
        }
    }

    const motivo = MOTIVOS.find(([, re]) => re.test(n))?.[0];
    return motivo ? { dia, fecha, motivo } : { dia, fecha };
}

// ─── 2. ¿De quién? (puro) ────────────────────────────────────────────────────

export interface CandidatoAusencia {
    /** 'c:<child_id>' o 'u:<profile_id>' (atleta adulto). */
    clave: string;
    childId: string | null;
    userId: string | null;
    nombre: string;
    teamIds: string[];
}

/** «SOFIA ANDREA PÉREZ» → «Sofia». */
export function primerNombre(nombreCompleto: string | null | undefined): string {
    const p = (nombreCompleto || '').trim().split(/\s+/)[0] || '';
    return p ? p.charAt(0).toLocaleUpperCase('es') + p.slice(1).toLocaleLowerCase('es') : 'tu deportista';
}

/**
 * Los candidatos que el texto nombra: por primer nombre, «los dos / ambos /
 * todos», o el número de la opción («2») cuando el texto es solo eso.
 */
export function atletasNombrados(texto: string, candidatos: CandidatoAusencia[]): CandidatoAusencia[] {
    const n = normalizarFrase(texto);
    if (!n || !candidatos.length) return [];
    if (/\b(los dos|las dos|ambos|ambas|todos|todas|los tres|las tres|los 2|las 2)\b/.test(n)) return candidatos;
    const num = n.match(/^(?:el |la |opcion )?(\d)$/);
    if (num) {
        const i = Number(num[1]) - 1;
        return candidatos[i] ? [candidatos[i]] : [];
    }
    const porPrimerNombre = candidatos.filter((c) => {
        const nombre = normalizarFrase(primerNombre(c.nombre));
        return nombre.length >= 2 && new RegExp(`\\b${nombre}\\b`).test(n);
    });
    if (porPrimerNombre.length) return porPrimerNombre;
    // Las familias dicen el segundo nombre («Paula» por «María Paula», «Isabella»
    // por «Tania Isabella»; Dynasty 10-13/10-17/10-20). Solo cuenta si apunta a UN
    // deportista: con dos que comparten el nombre se pregunta, no se adivina.
    const porOtroNombre = candidatos.filter((c) => normalizarFrase(c.nombre).split(' ')
        .some((p) => p.length >= 3 && !PARTICULAS_DE_NOMBRE.has(p) && new RegExp(`\\b${p}\\b`).test(n)));
    return porOtroNombre.length === 1 ? porOtroNombre : [];
}

const PARTICULAS_DE_NOMBRE = new Set(['del', 'las', 'los', 'van', 'von']);

// ─── 3. Mensajes (puros) ─────────────────────────────────────────────────────

const DIAS_LEGIBLES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function diaLegible(a: Pick<AusenciaDetectada, 'dia' | 'fecha'>): string {
    if (a.dia === 'hoy') return 'hoy';
    if (a.dia === 'manana') return 'mañana';
    const [, m, d] = a.fecha.split('-').map(Number);
    return `el ${DIAS_LEGIBLES[diaDeSemana(a.fecha)]} ${d} de ${MESES[m - 1]}`;
}

function listaDeNombres(nombres: string[]): string {
    if (nombres.length <= 1) return nombres[0] ?? '';
    return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

export function textoConfirmacion(
    nombres: string[], a: Pick<AusenciaDetectada, 'dia' | 'fecha' | 'motivo'>, hayEntrenador: boolean,
): string {
    const quien = listaDeNombres(nombres);
    const va = nombres.length > 1 ? 'van' : 'va';
    const cierre = a.motivo === 'enfermedad' || a.motivo === 'lesion' || a.motivo === 'cita_medica'
        ? (nombres.length > 1 ? ' ¡Que se mejoren!' : ' ¡Que se mejore!')
        : a.motivo === 'viaje' ? ' ¡Buen viaje!' : '';
    return hayEntrenador
        ? `Listo, le aviso al entrenador que ${quien} no ${va} ${diaLegible(a)}.${cierre}`
        : `Listo, quedó registrado que ${quien} no ${va} ${diaLegible(a)} y le aviso a la escuela.${cierre}`;
}

export const PREFIJO_BOTON_AUSENCIA = 'sm_ausencia:';

export function botonesDeAusencia(candidatos: CandidatoAusencia[], fecha: string): BotonInteractivo[] | null {
    if (candidatos.length < 2 || candidatos.length > 3) return null;
    // Meta corta el título en 20 caracteres.
    return candidatos.map((c) => ({
        id: `${PREFIJO_BOTON_AUSENCIA}${c.clave}:${fecha}`,
        title: primerNombre(c.nombre).slice(0, 20),
    }));
}

export function textoPreguntaQuien(candidatos: CandidatoAusencia[], a: AusenciaDetectada): string {
    const opciones = candidatos.map((c, i) => `${i + 1}. ${primerNombre(c.nombre)}`).join('\n');
    return `Entendido. ¿Quién no va ${diaLegible(a)}?\n${opciones}\n\n` +
        'Responde con el nombre (o «los dos» si no va ninguno).';
}

/** `sm_ausencia:c:<uuid>:2026-10-06` → { clave, fecha }. */
export function leerBotonAusencia(botonId: string | null | undefined): { clave: string; fecha: string } | null {
    if (!botonId?.startsWith(PREFIJO_BOTON_AUSENCIA)) return null;
    const m = botonId.slice(PREFIJO_BOTON_AUSENCIA.length).match(/^([cu]:[0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i);
    return m ? { clave: m[1], fecha: m[2] } : null;
}

const VENTANA_PENDIENTE_MS = 30 * 60_000;

/**
 * El aviso que quedó sin «de quién» en esta conversación: el entrante más
 * reciente (últimos 30 min, sin contar el actual) que `detectaAusencia` lee como
 * aviso. Sin estado aparte: funciona igual en modo asistido, donde la pregunta
 * es un borrador y no un saliente.
 */
export function ausenciaPendiente(
    recientes: FilaReciente[], waMessageIdActual: string, hoy: string = todayInZone(), ahora = Date.now(),
): AusenciaDetectada | null {
    const filas = recientes
        .filter((f) => f.direction === 'inbound' && f.wa_message_id !== waMessageIdActual)
        .filter((f) => new Date(f.wa_timestamp || f.created_at || 0).getTime() >= ahora - VENTANA_PENDIENTE_MS)
        .sort((a, b) => new Date(b.wa_timestamp || b.created_at || 0).getTime()
            - new Date(a.wa_timestamp || a.created_at || 0).getTime());
    for (const f of filas) {
        const a = detectaAusencia(f.text_body, hoy);
        if (a) return a;
    }
    return null;
}

// ─── 4. Datos ────────────────────────────────────────────────────────────────

/** Deportistas activos de la familia EN ESTA escuela (hijos + el adulto mismo). */
export async function candidatosDeLaFamilia(schoolId: string, parentId: string): Promise<CandidatoAusencia[]> {
    const { data: hijos } = await supabase.from('children')
        .select('id, full_name, is_active')
        .eq('parent_id', parentId);
    const hijosActivos = ((hijos as any[]) ?? []).filter((h) => h.is_active !== false);
    const childIds = hijosActivos.map((h) => h.id as string);

    const filtro = childIds.length
        ? `user_id.eq.${parentId},child_id.in.(${childIds.join(',')})`
        : `user_id.eq.${parentId}`;
    const { data: inscripciones } = await supabase.from('enrollments')
        .select('child_id, user_id, team_id')
        .eq('school_id', schoolId)
        .eq('status', 'active')
        .or(filtro);

    const porClave = new Map<string, CandidatoAusencia>();
    for (const e of (inscripciones as any[]) ?? []) {
        const hijo = e.child_id ? hijosActivos.find((h) => h.id === e.child_id) : null;
        if (e.child_id && !hijo) continue;
        const clave = e.child_id ? `c:${e.child_id}` : `u:${e.user_id}`;
        const c: CandidatoAusencia = porClave.get(clave) ?? {
            clave, childId: e.child_id ?? null, userId: e.child_id ? null : e.user_id,
            nombre: hijo?.full_name ?? '', teamIds: [],
        };
        if (e.team_id && !c.teamIds.includes(e.team_id)) c.teamIds.push(e.team_id);
        porClave.set(clave, c);
    }
    const lista = [...porClave.values()];
    // El adulto que se inscribió a sí mismo: su nombre sale de profiles.
    const adulto = lista.find((c) => c.userId);
    if (adulto && !adulto.nombre) {
        const { data: p } = await supabase.from('profiles').select('full_name').eq('id', parentId).maybeSingle();
        adulto.nombre = (p as any)?.full_name ?? '';
    }
    return lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Perfiles de los entrenadores de esos equipos (teams.coach_id + team_coaches → school_staff). */
async function entrenadoresDe(schoolId: string, teamIds: string[]): Promise<string[]> {
    if (!teamIds.length) return [];
    const [{ data: equipos }, { data: tc }] = await Promise.all([
        supabase.from('teams').select('id, coach_id').eq('school_id', schoolId).in('id', teamIds),
        supabase.from('team_coaches').select('coach_id').in('team_id', teamIds),
    ]);
    const staffIds = new Set<string>();
    for (const t of (equipos as any[]) ?? []) if (t.coach_id) staffIds.add(t.coach_id);
    for (const t of (tc as any[]) ?? []) if (t.coach_id) staffIds.add(t.coach_id);
    if (!staffIds.size) return [];
    const { data: staff } = await supabase.from('school_staff')
        .select('coach_auth_id').eq('school_id', schoolId).in('id', [...staffIds]);
    return [...new Set(((staff as any[]) ?? []).map((s) => s.coach_auth_id).filter(Boolean))] as string[];
}

async function administracionDe(schoolId: string): Promise<string[]> {
    const { data } = await supabase.from('school_members')
        .select('profile_id').eq('school_id', schoolId).eq('status', 'active')
        .in('role', ['owner', 'admin', 'school_admin']);
    return [...new Set(((data as any[]) ?? []).map((m) => m.profile_id).filter(Boolean))] as string[];
}

/**
 * Inserta el aviso. 'nuevo' si quedó registrado, 'ya_estaba' si ya había un
 * aviso activo de ese atleta ese día (el índice único lo garantiza aunque dos
 * mensajes lleguen a la vez), 'error' si no se pudo.
 */
async function guardarAviso(
    schoolId: string, c: CandidatoAusencia, a: AusenciaDetectada,
    extra: { parentId: string; conversationId: string; nota: string },
): Promise<'nuevo' | 'ya_estaba' | 'error'> {
    let q = supabase.from('athlete_absence_notices').select('id')
        .eq('school_id', schoolId).eq('absence_date', a.fecha).eq('status', 'active');
    q = c.childId ? q.eq('child_id', c.childId) : q.eq('user_id', c.userId as string);
    const { data: ya } = await q.maybeSingle();
    if (ya) return 'ya_estaba';

    const { error } = await supabase.from('athlete_absence_notices').insert({
        school_id: schoolId,
        child_id: c.childId,
        user_id: c.userId,
        absence_date: a.fecha,
        reason: a.motivo ?? null,
        note: extra.nota.slice(0, 500) || null,
        source: 'whatsapp',
        reported_by: extra.parentId,
        conversation_id: extra.conversationId,
    });
    if (!error) return 'nuevo';
    if ((error as any).code === '23505') return 'ya_estaba';
    console.error('[ausencias] no se pudo guardar el aviso:', error.message);
    return 'error';
}

const MOTIVO_LEGIBLE: Record<MotivoAusencia, string> = {
    enfermedad: 'enfermo/a', cita_medica: 'cita médica', viaje: 'de viaje', lesion: 'lesión',
    colegio: 'colegio', familiar: 'asunto familiar', otro: 'otro',
};

async function avisarAlEquipo(
    schoolId: string, registrados: CandidatoAusencia[], a: AusenciaDetectada, nota: string,
): Promise<boolean> {
    const teamIds = [...new Set(registrados.flatMap((c) => c.teamIds))];
    const [coaches, admins] = await Promise.all([entrenadoresDe(schoolId, teamIds), administracionDe(schoolId)]);
    const nombres = listaDeNombres(registrados.map((c) => primerNombre(c.nombre)));
    const verbo = registrados.length > 1 ? 'no van' : 'no va';
    const porque = a.motivo ? ` (${MOTIVO_LEGIBLE[a.motivo]})` : '';
    const title = `Aviso de ausencia: ${nombres}`;
    const message = `La familia avisó por WhatsApp que ${nombres} ${verbo} ${diaLegible(a)}${porque}. ` +
        'Ya aparece como «excusado» en la lista.';
    const data = {
        origen: 'whatsapp_ausencia', fecha: a.fecha, motivo: a.motivo ?? null, nota: nota.slice(0, 300),
        atletas: registrados.map((c) => c.clave),
    };

    const filas = [
        ...coaches.map((uid) => ({ user_id: uid, school_id: schoolId, type: 'info', category: 'system',
            title, message, link: '/coach-attendance', data })),
        ...admins.filter((uid) => !coaches.includes(uid)).map((uid) => ({ user_id: uid, school_id: schoolId,
            type: 'info', category: 'system', title, message, link: '/attendance-supervision', data })),
    ];
    try {
        if (filas.length) {
            const { error } = await supabase.from('notifications').insert(filas);
            if (error) console.error('[ausencias] no se pudo crear la notificación:', error.message);
        }
        // Push solo al entrenador: es quien pasa la lista. A la administración
        // le basta el aviso in-app (con 400 atletas, un push por ausencia es ruido).
        await Promise.all(coaches.map((uid) => sendToUser(uid, {
            title, body: message, data: { link: '/coach-attendance', tipo: 'ausencia' },
        }).catch(() => null)));
    } catch (err) {
        // Un aviso que falla no deshace el registro ni deja a la familia sin respuesta.
        console.error('[ausencias] fallo avisando al equipo:', (err as any)?.message ?? err);
    }
    return coaches.length > 0;
}

// ─── 4b. Segundo lector (Decisions API de Google) ───────────────────────────

/**
 * Lo que la regex no distingue bien, lo lee un segundo lector (Decisions API,
 * misma GEMINI_API_KEY del OCR). Solo puede hacer DOS cosas, las dos en la
 * dirección segura: (1) frenar una confirmación falsa y (2) pasar a la escuela
 * una ausencia larga o de evento. NUNCA confirma una ausencia por su cuenta.
 * Si falla, se apaga (`AUSENCIAS_SEGUNDO_LECTOR=off`) o no responde: todo sigue
 * exactamente como antes.
 */
export interface LecturaFamilia {
    opcion: string;
    probabilidades: Record<string, number>;
    confianza: number;
}

export interface SegundoLector {
    /** Clasifica el texto; null si no hay llave, falla o tarda de más. */
    leer: (texto: string) => Promise<LecturaFamilia | null>;
    /** Pasa el aviso a la escuela (buzón + push) y le dice a la familia que lo recibió. */
    escalarLarga: (texto: string) => Promise<void>;
}

export const UMBRAL_FRENAR_CONFIRMACION = 0.2;   // regex dijo «ausencia» y la API da menos → no se confirma
export const UMBRAL_ESCALAR_LARGA = 0.85;        // la regex calló y la API ve una ausencia larga/evento → a la escuela
export const SEGUNDO_LECTOR_APAGADO = () => (process.env.AUSENCIAS_SEGUNDO_LECTOR || '').toLowerCase() === 'off';

const CATEGORIAS_DE_AUSENCIA = ['ausencia_proxima', 'ausencia_larga_o_evento'];

/** Prefiltro barato: solo se consulta a la API si el texto puede hablar de no ir. */
const PUEDE_SER_AUSENCIA = /\b(no (puede|puedo|podemos|podra|podre|va|voy|vamos|vaya|vayamos|asist\w*|alcanz\w*|iremos|ira|ire)|nos (toca|va a tocar) faltar|faltar\w*|falt[oa]\w*|ausen\w*|viaj\w*|vacacion\w*|incapacid\w*|no podra|no podran)\b/;

export type DecisionSegundoLector = 'seguir' | 'no_confirmar' | 'escalar_larga';

/** Pura: decide qué hace el segundo lector con lo que dijo la regex y lo que leyó la API. */
export function decidirConSegundoLector(regexDetecto: boolean, lectura: LecturaFamilia | null): DecisionSegundoLector {
    if (!lectura) return 'seguir';
    const p = lectura.probabilidades ?? {};
    const pAusencia = CATEGORIAS_DE_AUSENCIA.reduce((a, k) => a + (Number(p[k]) || 0), 0);
    if (regexDetecto) return pAusencia < UMBRAL_FRENAR_CONFIRMACION ? 'no_confirmar' : 'seguir';
    return (Number(p.ausencia_larga_o_evento) || 0) >= UMBRAL_ESCALAR_LARGA ? 'escalar_larga' : 'seguir';
}

// ─── 5. El turno ─────────────────────────────────────────────────────────────

export type EnviarAusencia = (texto: string, paso: string, botones?: BotonInteractivo[] | null) => Promise<void>;

export interface TurnoAusencia {
    schoolId: string;
    parentId: string | null;
    conversationId: string;
    waMessageId: string;
    texto: string;
    rafaga: string;
    botonId: string | null;
    recientes: FilaReciente[];
}

/**
 * Atiende el turno si es un aviso de ausencia (o la respuesta a «¿quién no
 * va?»). Devuelve true si respondió; false para que el turno siga su curso.
 * Nunca lanza.
 */
export async function atenderAusenciaEnBot(
    t: TurnoAusencia, enviar: EnviarAusencia, hoy: string = todayInZone(), segundoLector?: SegundoLector,
): Promise<boolean> {
    try {
        if (!t.parentId) return false;

        // a) Tocó un botón de «¿quién?».
        const boton = leerBotonAusencia(t.botonId);
        if (boton) {
            const candidatos = await candidatosDeLaFamilia(t.schoolId, t.parentId);
            const elegido = candidatos.filter((c) => c.clave === boton.clave);
            if (!elegido.length) return false;
            const previo = ausenciaPendiente(t.recientes, t.waMessageId, hoy);
            const a: AusenciaDetectada = {
                dia: boton.fecha === hoy ? 'hoy' : boton.fecha === sumarDias(hoy, 1) ? 'manana' : 'fecha',
                fecha: boton.fecha,
                ...(previo?.fecha === boton.fecha && previo.motivo ? { motivo: previo.motivo } : {}),
            };
            return registrarYConfirmar(t, elegido, a, enviar);
        }

        // b) El mensaje (o la ráfaga) avisa una ausencia.
        const a = detectaAusencia(t.texto, hoy) ?? (t.rafaga !== t.texto ? detectaAusencia(t.rafaga, hoy) : null);
        const sl = segundoLector && !SEGUNDO_LECTOR_APAGADO() ? segundoLector : null;
        const textoLeido = (t.rafaga || t.texto || '').trim();
        if (sl && textoLeido && textoLeido.length <= 400) {
            // Solo se consulta si la regex disparó o el texto puede hablar de no ir.
            if (a || PUEDE_SER_AUSENCIA.test(normalizarFrase(textoLeido))) {
                const decision = decidirConSegundoLector(!!a, await sl.leer(textoLeido).catch(() => null));
                if (decision === 'no_confirmar') {
                    console.info('[ausencias] segundo lector: no es un aviso de ausencia; no se confirma', { conversationId: t.conversationId });
                    return false;
                }
                if (decision === 'escalar_larga') {
                    console.info('[ausencias] segundo lector: ausencia larga o de evento; va a la escuela', { conversationId: t.conversationId });
                    await sl.escalarLarga(textoLeido);
                    return true;
                }
            }
        }
        if (a) {
            const candidatos = await candidatosDeLaFamilia(t.schoolId, t.parentId);
            if (!candidatos.length) return false; // sin deportista activo: que lo vea el modelo / la escuela
            const nombrados = atletasNombrados(t.rafaga || t.texto, candidatos);
            const elegidos = nombrados.length ? nombrados : candidatos.length === 1 ? candidatos : [];
            if (elegidos.length) return registrarYConfirmar(t, elegidos, a, enviar);
            // El texto ya lista las opciones: se entiende sin botones (modo asistido).
            await enviar(textoPreguntaQuien(candidatos, a), 'ausencia_quien', botonesDeAusencia(candidatos, a.fecha));
            return true;
        }

        // c) Respuesta escrita a «¿quién no va?» («Sofía», «los dos», «2»).
        const corto = normalizarFrase(t.texto).split(' ').filter(Boolean).length <= 6;
        if (!corto) return false;
        const pendiente = ausenciaPendiente(t.recientes, t.waMessageId, hoy);
        if (!pendiente) return false;
        const candidatos = await candidatosDeLaFamilia(t.schoolId, t.parentId);
        if (candidatos.length < 2) return false;
        const elegidos = atletasNombrados(t.texto, candidatos);
        if (!elegidos.length) return false;
        return registrarYConfirmar(t, elegidos, pendiente, enviar);
    } catch (err) {
        console.error('[ausencias] el turno falló; sigue el flujo normal:', (err as any)?.message ?? err);
        return false;
    }
}

async function registrarYConfirmar(
    t: TurnoAusencia, elegidos: CandidatoAusencia[], a: AusenciaDetectada, enviar: EnviarAusencia,
): Promise<boolean> {
    const nota = (t.rafaga || t.texto || '').trim();
    const resultados = await Promise.all(elegidos.map(async (c) => ({
        c, r: await guardarAviso(t.schoolId, c, a, { parentId: t.parentId as string, conversationId: t.conversationId, nota }),
    })));
    if (resultados.every((x) => x.r === 'error')) return false; // que lo atienda el flujo normal
    const nuevos = resultados.filter((x) => x.r === 'nuevo').map((x) => x.c);
    // Solo se avisa por lo nuevo: el segundo «no va hoy» no repite el push.
    const hayEntrenador = nuevos.length
        ? await avisarAlEquipo(t.schoolId, nuevos, a, nota)
        : elegidos.some((c) => c.teamIds.length > 0);
    const nombres = resultados.filter((x) => x.r !== 'error').map((x) => primerNombre(x.c.nombre));
    await enviar(textoConfirmacion(nombres, a, hayEntrenador), 'ausencia_registrada');
    return true;
}
