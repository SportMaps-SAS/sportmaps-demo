/**
 * clase-prueba-agenda.service — la agenda AUTOMÁTICA de la clase de prueba del
 * embudo del interesado (B3, plan docs/specs/whatsapp-monster-plan-B2-B3.md §3 y
 * plan maestro §3). Monster 2026-10-30: «formulario + pago + correo con los datos»
 * pasan a ser un chat: se elige el horario, se separa el cupo, llega el
 * comprobante y la clase queda agendada sin que nadie lea un correo.
 *
 * Qué hay acá:
 *   - `tomarCupo` / `soltarCupo`: las RPC solo-BFF de la migración
 *     embudo_y_agenda_clase_prueba (candado lead → cupos por id).
 *   - `confirmarClasePruebaPagada`: el contrato con B4. Cuando el comprobante de
 *     la clase de prueba coincide, B4 lo llama (import dinámico) y reenvía el
 *     texto. Es IDEMPOTENTE: un segundo llamado devuelve el mismo texto y no
 *     repite avisos. Lanza si el lead no es de esa escuela o la RPC falla: quien
 *     llama lo pasa a una persona.
 *   - `confirmarClaseAgendada`: lo mismo cuando no hay pago de por medio (clase sin
 *     valor, o cambio de horario de una clase ya pagada).
 *   - `avisarEntrenador`: in-app (despachador unificado) al coach del equipo, solo
 *     con `school_trial_class_settings.avisar_entrenador`. Sin teléfono del interesado.
 *   - Jobs: `runCuposSeparados` (aviso «tu cupo vence en 2 h» y liberación a las
 *     `separar_horas` con aviso a la escuela) y `runClasesReprogramadas` /
 *     `avisarClasesCanceladas` (la sesión se canceló por lluvia o el profe la movió
 *     en «Mi semana»: se le escribe a cada agendado con la plantilla de utilidad
 *     «clase reprogramada» y un botón para elegir otro horario, sin cobrar de nuevo).
 *
 * Este archivo NO importa nada de B4 (no hay ciclo) ni de B3-motor: la dirección
 * de la cancha se resuelve aquí con coincidencia EXACTA del nombre (nunca
 * «contiene»: «Pinar» no es «Pinar 2»).
 *
 * IDEMPOTENCIA ENTRE LOS TRES BFF: las notificaciones entran con id
 * determinístico (`uuidDeClave`); los mensajes de WhatsApp de los jobs se
 * reservan antes de salir con una marca en `source_detail` del lead escrita con
 * filtro (si otro BFF ya la puso, el UPDATE no devuelve fila y no se manda).
 */

import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import { uuidDeClave } from './avisos-correo.service';
import {
    ajustesClasePrueba, indicacionesCortesiaDeEscuela, type AjustesClasePrueba, type NombreClase,
} from './whatsapp-ajustes-escuela.service';
import { avanzarEtapaLead, esColumnaInexistente } from './whatsapp-prospecto-lead.service';
import { fechaLegible, horaLegible, normalizar } from './whatsapp-clase-cortesia.service';
import {
    sendInteractiveButtons, sendTextMessage, type BotonInteractivo, type SendTextResult, type WhatsAppIntegration,
} from './whatsapp.service';
import { aWaId, enviarCobroPorPlantilla, ventanaAbierta, type ConceptoCobro, type DatosCobro } from './whatsapp-plantillas.service';

const TZ = 'America/Bogota';

// ─── Botones que este módulo deja en el chat (los atiende el embudo) ─────────
// Mismos ids que whatsapp-embudo-prospecto (BOTON_EMBUDO); se repiten aquí
// para no importar el motor (y que el motor no importe la agenda).

export const BOTON_AGENDA = {
    ELEGIR_HORARIO: 'sm_em_cambiar',
    REPROGRAMAR: 'sm_em_reprogramar',
    OPTIN_SI: 'sm_em_optin_si',
    OPTIN_NO: 'sm_em_optin_no',
} as const;

/** El estado del embudo que viaja en el payload del saliente. */
export const FLUJO_EMBUDO_AGENDA = 'embudo';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type EstadoCupo = 'agendada' | 'separada' | 'lleno' | 'cerrada' | 'error';

export interface ResultadoCupo {
    estado: EstadoCupo;
    /** ISO: hasta cuándo se sostiene el cupo separado. */
    hasta: string | null;
    detalle?: string;
}

/** Lo que el contrato §3 devuelve a B4. */
export interface ConfirmacionClasePrueba {
    texto: string;
    botones?: { id: string; title: string }[];
    step?: string;
}

/** Franja con todo lo que necesita la confirmación. */
export interface FranjaAgenda {
    id: string;
    fecha: string;          // YYYY-MM-DD
    horaInicio: string;     // HH:MM
    horaFin: string | null;
    grupo: string | null;
    teamId: string | null;
    /** Cancha: nombre de la facility (o el lugar de la franja si no hay facility). */
    lugar: string | null;
    direccion: string | null;
    mapsUrl: string | null;
    /** De la cancha: por dónde se entra, qué pasa si llueve. */
    indicaciones: string | null;
    /** Nombre completo del profe que recibe (el primero del equipo). */
    profe: string | null;
    /**
     * Usuarios (auth) de los profes del equipo, para `notifications.user_id`.
     * team_coaches.coach_id ∪ teams.coach_id apuntan a school_staff: se traducen por
     * `coach_auth_id` y, si la ficha no está vinculada, por el correo (la misma regla
     * de user_coached_team_ids()).
     */
    coachUserIds: string[];
}

export interface LeadAgenda {
    id: string;
    schoolId: string;
    nombre: string | null;
    acudiente: string | null;
    telefono: string | null;
    fechaNacimiento: string | null;
    genero: string | null;
    respuestas: Record<string, string> | null;
    trialSlotId: string | null;
    conversationId: string | null;
    sourceDetail: Record<string, any>;
}

export type EventoEntrenador = 'agendada' | 'cambiada' | 'cancelada' | 'llegada';

// ─── RPC del cupo ────────────────────────────────────────────────────────────

/** PGRST202 / 42883: la RPC no existe todavía (migración sin aplicar). */
export function esRpcFaltante(e: { code?: string; message?: string } | null | undefined): boolean {
    return !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function/i.test(String(e.message ?? '')));
}

const ESTADOS_CUPO = new Set<EstadoCupo>(['agendada', 'separada', 'lleno', 'cerrada']);

/**
 * Toma el cupo de la franja para el lead: lo AGENDA (gratis, ya pagó o la
 * escuela no cobra por el chat) o lo SEPARA `separar_horas`. Lo decide la RPC
 * con el candado del lead y del cupo. Nunca lanza.
 */
export async function tomarCupo(leadId: string, slotId: string): Promise<ResultadoCupo> {
    try {
        const { data, error } = await supabase.rpc('tomar_cupo_clase_prueba', { p_lead_id: leadId, p_slot_id: slotId });
        if (error) {
            if (!esRpcFaltante(error)) console.warn('[clase-prueba] tomar_cupo falló', { leadId, slotId, err: error.message });
            return { estado: 'error', hasta: null, detalle: esRpcFaltante(error) ? 'sin_rpc' : error.message };
        }
        const r = (data ?? {}) as Record<string, any>;
        const estado = ESTADOS_CUPO.has(r.estado) ? r.estado as EstadoCupo : 'error';
        return { estado, hasta: typeof r.hasta === 'string' ? r.hasta : null };
    } catch (e: any) {
        return { estado: 'error', hasta: null, detalle: e?.message };
    }
}

/**
 * Suelta el cupo SEPARADO de ese lead (sin cuentas de pago, o cambió de idea).
 * Supone que `soltar_cupos_separados(p_lead_id)` suelta el de ese lead aunque no
 * haya vencido; si ya hay pago, la RPC confirma en vez de soltar. Nunca lanza.
 */
export async function soltarCupo(leadId: string): Promise<void> {
    try {
        const { error } = await supabase.rpc('soltar_cupos_separados', { p_lead_id: leadId, p_limite: 1 });
        if (error && !esRpcFaltante(error)) console.warn('[clase-prueba] soltar cupo falló', { leadId, err: error.message });
    } catch { /* nada que hacer: vence solo */ }
}

// ─── Formato (puro) ──────────────────────────────────────────────────────────

const primerNombre = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/)[0] ?? '';
const mayuscula = (t: string) => (t ? t[0].toLocaleUpperCase('es-CO') + t.slice(1) : t);

/** «clase de prueba» o «clase de cortesía» (los textos de siempre). Pura. */
export function nombreDeClase(nombre: NombreClase | null | undefined): string {
    return nombre === 'prueba' ? 'clase de prueba' : 'clase de cortesía';
}

/** «8:00 – 10:00 a. m.», «11:00 a. m. – 1:00 p. m.», «4:00 p. m.». Pura. */
export function rangoDeHoras(inicio: string, fin: string | null | undefined): string {
    const a = horaLegible(inicio);
    if (!fin) return a;
    const b = horaLegible(fin);
    const sufA = a.slice(a.indexOf(' ') + 1);
    const sufB = b.slice(b.indexOf(' ') + 1);
    return sufA === sufB ? `${a.slice(0, a.indexOf(' '))} – ${b}` : `${a} – ${b}`;
}

/**
 * La confirmación de la clase (maqueta paso 4): fecha, cancha y dirección,
 * enlace de Maps, indicaciones de la cancha («si llueve…»), profe y qué llevar.
 * Lo que no esté cargado no se dice (nunca se inventa). Nunca dice «gratis».
 * Máximo 3 emojis: el bot recorta el resto (`recortarEmojis`) y una línea que
 * empieza con un emoji recortado se pega a la anterior. Pura.
 */
export function textoConfirmacion(f: FranjaAgenda, o: {
    deportista?: string | null; nombreClase?: NombreClase | null; queLlevar?: string | null; cambio?: boolean;
}): string {
    const clase = nombreDeClase(o.nombreClase);
    const quien = primerNombre(o.deportista);
    const lineas = [
        o.cambio
            ? `Listo, cambié el horario${quien ? ` de *${quien}*` : ''} 🙌 Tu ${clase} quedó agendada:`
            : `${quien ? `La ${clase} de *${quien}*` : `Tu ${clase}`} quedó agendada 🎉`,
        `📅 ${mayuscula(fechaLegible(f.fecha))}, ${rangoDeHoras(f.horaInicio, f.horaFin)}`,
    ];
    const lugar = [f.lugar, f.direccion].filter(Boolean).join(' · ');
    if (lugar) lineas.push(`📍 ${lugar}`);
    if (f.mapsUrl) lineas.push(`Cómo llegar: ${f.mapsUrl}`);
    if (f.indicaciones) lineas.push(f.indicaciones);
    if (f.profe) lineas.push(`Te recibe el profe ${primerNombre(f.profe)}.`);
    if (o.queLlevar) lineas.push(`Qué llevar: ${o.queLlevar}`);
    lineas.push('', '¡Te esperamos en la cancha!');
    return lineas.join('\n');
}

export const PREGUNTA_CONSENTIMIENTO = '¿Te puedo escribir por aquí el recordatorio de la clase y las novedades del club?';
export const BOTONES_CONSENTIMIENTO: BotonInteractivo[] = [
    { id: BOTON_AGENDA.OPTIN_SI, title: 'Sí, claro' },
    { id: BOTON_AGENDA.OPTIN_NO, title: 'No, gracias' },
];

/** ¿Falta preguntarle el consentimiento? (no contestó ni sí ni no). Pura. */
export function faltaConsentimiento(sd: Record<string, any> | null | undefined): boolean {
    return sd?.consentimiento !== 'si' && sd?.consentimiento !== 'no';
}

interface Facility { id: string; name: string | null; address?: string | null; maps_url?: string | null; indicaciones?: string | null }
interface Sede { id: string; name: string | null; address: string | null }

/**
 * La cancha de la franja: coincidencia EXACTA del nombre (sin tildes ni
 * mayúsculas) con una facility; si no, la facility del equipo. La dirección
 * sale de la cancha; si no tiene, de la sede del equipo o de la sede que se
 * llame EXACTO como el lugar. Nunca por «contiene» («Pinar» ≠ «Pinar 2»). Pura.
 */
export function lugarDeFranja(
    location: string | null | undefined,
    facilities: Facility[],
    equipo: { facility_id?: string | null; branch_id?: string | null } | null,
    sedes: Sede[],
): { lugar: string | null; direccion: string | null; mapsUrl: string | null; indicaciones: string | null } {
    const n = normalizar(location);
    const fac = (n ? facilities.find((f) => normalizar(f.name) === n) : undefined)
        ?? (equipo?.facility_id ? facilities.find((f) => f.id === equipo.facility_id) : undefined);
    const sedeLugar = n ? sedes.find((s) => normalizar(s.name) === n) : undefined;
    const sedeEquipo = equipo?.branch_id ? sedes.find((s) => s.id === equipo.branch_id) : undefined;
    const limpio = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
        lugar: limpio(fac?.name) ?? limpio(location),
        direccion: limpio(fac?.address) ?? limpio(sedeLugar?.address) ?? limpio(sedeEquipo?.address),
        mapsUrl: limpio(fac?.maps_url),
        indicaciones: limpio(fac?.indicaciones),
    };
}

/** El aviso al entrenador: sin teléfono, con lo que el profe necesita en la cancha. Pura. */
export function contenidoAvisoEntrenador(
    evento: EventoEntrenador, lead: Pick<LeadAgenda, 'nombre' | 'fechaNacimiento' | 'genero' | 'respuestas'>,
    f: Pick<FranjaAgenda, 'fecha' | 'horaInicio' | 'horaFin' | 'grupo' | 'lugar'>, nombreClase: NombreClase | null,
): { titulo: string; mensaje: string } {
    const clase = mayuscula(nombreDeClase(nombreClase));
    const titulo = {
        agendada: `🔔 ${clase} agendada`,
        cambiada: `${clase}: cambio de horario`,
        cancelada: `${clase} cancelada`,
        llegada: `Llegó a su ${nombreDeClase(nombreClase)}`,
    }[evento];
    const anio = lead.fechaNacimiento ? String(lead.fechaNacimiento).slice(0, 4) : null;
    const sexo = /^f/i.test(lead.genero ?? '') ? 'Mujer' : /^m/i.test(lead.genero ?? '') ? 'Hombre' : null;
    const respuestas = Object.values(lead.respuestas ?? {}).map((v) => String(v).trim()).filter(Boolean);
    const quien = [lead.nombre?.trim() || 'Interesado', anio, sexo, ...respuestas].filter(Boolean).join(' · ');
    const cuando = `${mayuscula(fechaLegible(f.fecha))}, ${rangoDeHoras(f.horaInicio, f.horaFin)}`;
    const donde = [f.grupo, f.lugar].filter(Boolean).join(' · ');
    return { titulo, mensaje: [quien.slice(0, 400), cuando, donde].filter(Boolean).join('\n') };
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

/** Lead de ESA escuela (nunca de otra). Nunca lanza: null si no existe. */
export async function leerLeadAgenda(schoolId: string, leadId: string): Promise<LeadAgenda | null> {
    const consulta = (cols: string) => supabase.from('school_signup_leads').select(cols)
        .eq('id', leadId).eq('school_id', schoolId).maybeSingle();
    try {
        let r: any = await consulta('id, school_id, full_name, guardian_name, phone, birth_date, gender, trial_slot_id, source_detail, respuestas');
        if (r.error && esColumnaInexistente(r.error)) {
            r = await consulta('id, school_id, full_name, guardian_name, phone, birth_date, gender, trial_slot_id, source_detail');
        }
        const l = r.data;
        if (r.error || !l) return null;
        const sd = (l.source_detail ?? {}) as Record<string, any>;
        return {
            id: l.id, schoolId: l.school_id, nombre: l.full_name ?? null, acudiente: l.guardian_name ?? null,
            telefono: l.phone ?? null, fechaNacimiento: l.birth_date ?? null, genero: l.gender ?? null,
            respuestas: (l.respuestas ?? sd.embudo?.respuestas ?? null) as Record<string, string> | null,
            trialSlotId: l.trial_slot_id ?? null, conversationId: sd.conversation_id ?? null, sourceDetail: sd,
        };
    } catch {
        return null;
    }
}

/**
 * school_staff → nombre del profe (el primero con nombre, en el orden del equipo) y
 * los usuarios a los que se avisa: `coach_auth_id`, o el perfil con el mismo correo
 * si la ficha no está vinculada. Solo staff activo. Nunca lanza.
 */
export async function profesDeStaff(staffIds: string[]): Promise<{ profe: string | null; coachUserIds: string[] }> {
    if (!staffIds.length) return { profe: null, coachUserIds: [] };
    try {
        const { data } = await supabase.from('school_staff')
            .select('id, full_name, coach_auth_id, email, status').in('id', staffIds);
        const porId = new Map(((data ?? []) as any[]).filter((x) => x.status === 'active').map((x) => [x.id, x]));
        const ordenados = staffIds.map((id) => porId.get(id)).filter(Boolean) as any[];
        const profe = ordenados.map((x) => String(x.full_name ?? '').trim()).find(Boolean) || null;
        const ids = new Set<string>(ordenados.map((x) => x.coach_auth_id).filter((x): x is string => !!x));
        const correos = [...new Set(ordenados.filter((x) => !x.coach_auth_id && x.email)
            .map((x) => String(x.email).trim().toLowerCase()).filter(Boolean))];
        if (correos.length) {
            const { data: perfiles } = await supabase.from('profiles').select('id, email').in('email', correos);
            for (const p of (perfiles ?? []) as any[]) if (p.id) ids.add(p.id);
        }
        return { profe, coachUserIds: [...ids] };
    } catch {
        return { profe: null, coachUserIds: [] };
    }
}

/** Franja con cancha, dirección, Maps, indicaciones y profe. Nunca lanza: null si no existe. */
export async function franjaDeAgenda(schoolId: string, slotId: string): Promise<FranjaAgenda | null> {
    try {
        const { data: s } = await supabase.from('school_trial_slots')
            .select('id, label, slot_date, start_time, end_time, location, team_id')
            .eq('id', slotId).eq('school_id', schoolId).maybeSingle();
        const slot = s as any;
        if (!slot) return null;
        const teamId: string | null = slot.team_id ?? null;
        const facs = async (): Promise<Facility[]> => {
            let r: any = await supabase.from('facilities').select('id, name, address, maps_url, indicaciones')
                .eq('school_id', schoolId).limit(100);
            if (r.error && esColumnaInexistente(r.error)) r = await supabase.from('facilities').select('id, name').eq('school_id', schoolId).limit(100);
            return (r.data ?? []) as Facility[];
        };
        const [equipo, tc, facilities, sedes] = await Promise.all([
            teamId ? supabase.from('teams').select('id, name, coach_id, facility_id, branch_id').eq('id', teamId).maybeSingle() : Promise.resolve({ data: null }),
            teamId ? supabase.from('team_coaches').select('coach_id').eq('team_id', teamId).limit(20) : Promise.resolve({ data: [] }),
            facs().catch(() => [] as Facility[]),
            supabase.from('school_branches').select('id, name, address').eq('school_id', schoolId).limit(50),
        ]);
        const t = (equipo as any)?.data ?? null;
        // teams.coach_id y team_coaches.coach_id son ids de school_staff, NO de profiles.
        const staffIds = [...new Set([
            ...(((tc as any)?.data ?? []) as any[]).map((r) => r.coach_id),
            t?.coach_id,
        ].filter((x): x is string => typeof x === 'string' && !!x))];
        const { profe, coachUserIds } = await profesDeStaff(staffIds);
        const l = lugarDeFranja(slot.location, facilities, t, ((sedes as any)?.data ?? []) as Sede[]);
        return {
            id: slot.id, fecha: String(slot.slot_date).slice(0, 10), horaInicio: String(slot.start_time).slice(0, 5),
            horaFin: slot.end_time ? String(slot.end_time).slice(0, 5) : null,
            grupo: slot.label ?? t?.name ?? null, teamId, ...l, profe, coachUserIds,
        };
    } catch {
        return null;
    }
}

// ─── Avisos ──────────────────────────────────────────────────────────────────

type Insertar = (fila: Record<string, unknown>) => Promise<{ error: { code?: string; message: string } | null }>;
const insertarNotificacion: Insertar = async (fila) => supabase.from('notifications').insert(fila) as any;

/**
 * Aviso in-app al entrenador del equipo de la franja (team_coaches ∪
 * teams.coach_id) con id determinístico: el despachador unificado lo entrega
 * (push/correo según sus preferencias). Solo con `avisar_entrenador`. Devuelve
 * cuántos entraron. Nunca lanza.
 */
export async function avisarEntrenador(
    evento: EventoEntrenador, lead: LeadAgenda, franja: FranjaAgenda,
    deps: { ajustes?: AjustesClasePrueba; insertar?: Insertar } = {},
): Promise<number> {
    try {
        const aj = deps.ajustes ?? await ajustesClasePrueba(lead.schoolId);
        if (!aj.avisarEntrenador || !franja.coachUserIds.length) return 0;
        const c = contenidoAvisoEntrenador(evento, lead, franja, aj.nombreClase);
        const insertar = deps.insertar ?? insertarNotificacion;
        let n = 0;
        for (const uid of franja.coachUserIds) {
            const { error } = await insertar({
                id: uuidDeClave(`clase_prueba_coach:${evento}:${lead.id}:${franja.id}:${uid}`),
                user_id: uid,
                school_id: lead.schoolId,
                title: c.titulo,
                message: c.mensaje,
                type: evento === 'agendada' ? 'success' : 'info',
                category: 'enrollment',
                link: `/training-plans?tab=semana&fecha=${franja.fecha}`,
                data: { tipo: 'clase_prueba_entrenador', evento, lead_id: lead.id, slot_id: franja.id, team_id: franja.teamId },
            });
            // 23505 = ya se avisó (otro BFF o un segundo llamado): no cuenta ni se repite.
            if (!error) n++;
            else if (error.code !== '23505') console.warn('[clase-prueba] aviso al entrenador no entró', { err: error.message });
        }
        return n;
    } catch (e: any) {
        console.warn('[clase-prueba] no se pudo avisar al entrenador', { err: e?.message });
        return 0;
    }
}

async function idsDeAdministracion(schoolId: string): Promise<string[]> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active').in('role', ['owner', 'admin', 'school_admin']),
    ]);
    const ids = new Set<string>();
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) ids.add(m.profile_id);
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);
    return [...ids];
}

/** In-app a la administración con id determinístico. Nunca lanza. */
async function avisarAdministracion(schoolId: string, clave: string, titulo: string, mensaje: string, data: Record<string, unknown>): Promise<number> {
    try {
        const ids = await idsDeAdministracion(schoolId);
        let n = 0;
        for (const uid of ids) {
            const { error } = await insertarNotificacion({
                id: uuidDeClave(`${clave}:${uid}`), user_id: uid, school_id: schoolId, title: titulo, message: mensaje,
                type: 'info', category: 'enrollment', link: '/whatsapp?tab=cortesias', data,
            });
            if (!error) n++;
        }
        return n;
    } catch {
        return 0;
    }
}

export interface DepsAgenda {
    leerLead: typeof leerLeadAgenda;
    franja: typeof franjaDeAgenda;
    ajustes: typeof ajustesClasePrueba;
    queLlevar: (schoolId: string) => Promise<string | null>;
    /** RPC confirmar_cupo_clase_prueba. Lanza si falla. */
    confirmarCupo: (leadId: string, paymentId: string) => Promise<{ estado: string; slot_id: string | null }>;
    avanzarEtapa: typeof avanzarEtapaLead;
    avisarEntrenador: typeof avisarEntrenador;
    /** Aviso a la administración (el de siempre de la clase de cortesía, tipo 'reservada'). */
    avisarEscuela: (a: { schoolId: string; lead: LeadAgenda; franja: FranjaAgenda; contactWaId: string | null }) => Promise<void>;
}

const DEPS_AGENDA: DepsAgenda = {
    leerLead: leerLeadAgenda,
    franja: franjaDeAgenda,
    ajustes: ajustesClasePrueba,
    queLlevar: indicacionesCortesiaDeEscuela,
    async confirmarCupo(leadId, paymentId) {
        const { data, error } = await supabase.rpc('confirmar_cupo_clase_prueba', { p_lead_id: leadId, p_payment_id: paymentId });
        if (error) throw new Error(`confirmar_cupo_clase_prueba: ${error.message}`);
        const r = (data ?? {}) as Record<string, any>;
        return { estado: String(r.estado ?? ''), slot_id: r.slot_id ?? null };
    },
    avanzarEtapa: avanzarEtapaLead,
    avisarEntrenador,
    async avisarEscuela({ schoolId, lead, franja, contactWaId }) {
        if (!lead.conversationId || !contactWaId) return;
        const { avisarEscuelaCortesia } = await import('./whatsapp-clase-cortesia.service');
        await avisarEscuelaCortesia({
            tipo: 'reservada', schoolId, conversationId: lead.conversationId, contactWaId,
            leadId: lead.id, nombre: lead.nombre, acudiente: lead.acudiente,
            franja: {
                id: franja.id, grupo: franja.grupo ?? 'Clase de prueba', fecha: franja.fecha, horaInicio: franja.horaInicio,
                horaFin: franja.horaFin, sede: franja.lugar, cupos: 0, direccion: franja.direccion, teamId: franja.teamId,
            },
        });
    },
};

/** wa_id del teléfono del lead (colombiano → 57…; extranjero → sus dígitos). Pura. */
export function waIdDeTelefono(telefono: string | null | undefined): string | null {
    const co = aWaId(telefono);
    if (co) return co;
    const d = String(telefono ?? '').replace(/\D/g, '');
    return d.length >= 10 ? d : null;
}

/**
 * Lo que pasa al quedar agendada (una sola vez por evento): etapa del lead,
 * aviso al entrenador y aviso a la administración. Nunca lanza.
 */
async function alAgendar(d: DepsAgenda, lead: LeadAgenda, franja: FranjaAgenda | null, evento: 'agendada' | 'cambiada',
    extra: Record<string, unknown>, contactWaId: string | null, aj: AjustesClasePrueba): Promise<void> {
    await d.avanzarEtapa(lead.id, 'agendado', extra).catch(() => null);
    if (!franja) return;
    await d.avisarEntrenador(evento, lead, franja, { ajustes: aj }).catch(() => 0);
    await d.avisarEscuela({ schoolId: lead.schoolId, lead, franja, contactWaId }).catch(() => undefined);
}

/**
 * CONTRATO B4 → B2 (plan maestro §3). B4 lo llama cuando el comprobante de la
 * clase de prueba de un interesado coincide (D9: al recibir) y reenvía el texto.
 *
 *  - agendada / ya_agendada → la confirmación (idempotente: mismo texto, los avisos
 *    salen solo la primera vez). Si nunca contestó el consentimiento, la pregunta va
 *    al final con [Sí, claro][No, gracias].
 *  - sin_cupo → el horario se llenó: botón «Elegir horario» (no se cobra de nuevo).
 *  - sin_separar → pagó sin elegir horario: botón «Elegir horario».
 *
 * Lanza si el lead no es de esa escuela o la RPC falla: B4 lo pasa a una persona.
 */
export async function confirmarClasePruebaPagada(
    p: { schoolId: string; leadId: string; paymentId: string; telefono: string },
    deps: Partial<DepsAgenda> = {},
): Promise<ConfirmacionClasePrueba> {
    const d: DepsAgenda = { ...DEPS_AGENDA, ...deps };
    const lead = await d.leerLead(p.schoolId, p.leadId);
    if (!lead) throw new Error('clase_prueba: el lead no existe en esta escuela');
    const r = await d.confirmarCupo(p.leadId, p.paymentId);
    const aj = await d.ajustes(p.schoolId);
    const clase = nombreDeClase(aj.nombreClase);
    const elegir = [{ id: BOTON_AGENDA.ELEGIR_HORARIO, title: 'Elegir horario' }];

    if (r.estado === 'sin_cupo') {
        return {
            texto: `Recibí tu pago ✅ Pero el horario que separaste ya se llenó 😕\n\n` +
                `Toca *Elegir horario* y te muestro los que siguen abiertos; no tienes que pagar de nuevo.`,
            botones: elegir, step: 'clase_prueba_sin_cupo',
        };
    }
    if (r.estado === 'sin_separar') {
        return {
            texto: `Recibí tu pago ✅ Ahora elige el horario de la ${clase} 👇`,
            botones: elegir, step: 'clase_prueba_sin_horario',
        };
    }
    if (r.estado !== 'agendada' && r.estado !== 'ya_agendada') {
        throw new Error(`clase_prueba: estado inesperado de confirmar_cupo (${r.estado})`);
    }
    const slotId = r.slot_id ?? lead.trialSlotId;
    const [franja, queLlevar] = await Promise.all([
        slotId ? d.franja(p.schoolId, slotId) : Promise.resolve(null),
        d.queLlevar(p.schoolId).catch(() => null),
    ]);
    if (r.estado === 'agendada') {
        await alAgendar(d, lead, franja, 'agendada', { agendado_por: 'pago', payment_id: p.paymentId },
            waIdDeTelefono(p.telefono) ?? waIdDeTelefono(lead.telefono), aj);
    }
    const texto = franja
        ? textoConfirmacion(franja, { deportista: lead.nombre, nombreClase: aj.nombreClase, queLlevar })
        : `Tu ${clase} quedó agendada 🎉 La escuela te confirma los detalles por aquí.`;
    if (faltaConsentimiento(lead.sourceDetail)) {
        return { texto: `${texto}\n\n${PREGUNTA_CONSENTIMIENTO}`, botones: BOTONES_CONSENTIMIENTO, step: 'clase_prueba_agendada' };
    }
    return { texto, step: 'clase_prueba_agendada' };
}

/**
 * Agendada SIN pago de por medio: clase sin valor, o cambio de horario de una
 * clase ya pagada (el cobro queda atado al lead, no a la franja). La usa el
 * embudo después de `tomarCupo` = 'agendada'. Nunca lanza.
 */
export async function confirmarClaseAgendada(
    p: { schoolId: string; leadId: string; slotId: string; evento: 'agendada' | 'cambiada'; contactWaId: string | null },
    deps: Partial<DepsAgenda> = {},
): Promise<{ texto: string; consentimientoPendiente: boolean }> {
    const d: DepsAgenda = { ...DEPS_AGENDA, ...deps };
    try {
        const [lead, franja, aj, queLlevar] = await Promise.all([
            d.leerLead(p.schoolId, p.leadId),
            d.franja(p.schoolId, p.slotId),
            d.ajustes(p.schoolId),
            d.queLlevar(p.schoolId).catch(() => null),
        ]);
        if (lead) await alAgendar(d, lead, franja, p.evento, { agendado_por: 'bot' }, p.contactWaId, aj);
        const texto = franja
            ? textoConfirmacion(franja, { deportista: lead?.nombre, nombreClase: aj.nombreClase, queLlevar, cambio: p.evento === 'cambiada' })
            : `Tu ${nombreDeClase(aj.nombreClase)} quedó agendada 🎉 La escuela te confirma los detalles por aquí.`;
        return { texto, consentimientoPendiente: faltaConsentimiento(lead?.sourceDetail) };
    } catch {
        return { texto: 'Tu clase quedó agendada 🎉 La escuela te confirma los detalles por aquí.', consentimientoPendiente: false };
    }
}

// ─── Jobs: envío por WhatsApp ────────────────────────────────────────────────

export interface DepsEnvio {
    ahora: () => Date;
    /** La integración activa (exactamente una; más de una no se adivina). */
    integracion: (schoolId: string) => Promise<WhatsAppIntegration | null>;
    conversacion: (integrationId: string, waId: string) => Promise<{ id: string; last_inbound_at: string | null } | null>;
    /** Bot encendido, conversación no tomada por una persona y contacto no dado de baja. */
    puedeEscribir: (integrationId: string, conversationId: string | null, waId: string) => Promise<boolean>;
    enviarTexto: (integ: WhatsAppIntegration, waId: string, texto: string, botones?: BotonInteractivo[]) => Promise<SendTextResult>;
    registrarSaliente: (a: { integ: WhatsAppIntegration; conversationId: string; waId: string; waMessageId: string | null;
        texto: string; tipo: 'text' | 'interactive'; payload: Record<string, unknown> }) => Promise<void>;
    enviarPlantilla: typeof enviarCobroPorPlantilla;
    /**
     * Reserva el envío: escribe `source_detail[clave] = valor` solo si nadie lo
     * escribió antes con ese mismo `id` (otro BFF). true = este proceso manda.
     */
    reservar: (leadId: string, clave: string, valor: Record<string, unknown> & { id: string }) => Promise<boolean>;
    log: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void };
}

const DEPS_ENVIO: DepsEnvio = {
    ahora: () => new Date(),
    async integracion(schoolId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status')
            .eq('school_id', schoolId).eq('status', 'active');
        const activas = ((data as any[]) ?? []).filter((i) => i.access_token_encrypted && i.phone_number_id);
        return activas.length === 1 ? (activas[0] as WhatsAppIntegration) : null;
    },
    async conversacion(integrationId, waId) {
        const { data } = await supabase.from('whatsapp_conversations')
            .select('id, last_inbound_at').eq('integration_id', integrationId).eq('contact_wa_id', waId).maybeSingle();
        return (data as any) ?? null;
    },
    async puedeEscribir(integrationId, conversationId, waId) {
        const [{ botEncendido }, { conversacionTomada }, { estaDadoDeBaja }] = await Promise.all([
            import('./whatsapp-atencion.service'), import('./whatsapp-tomada.service'), import('./whatsapp-optin.service'),
        ]);
        if (!(await botEncendido(integrationId))) return false;
        if (conversationId && await conversacionTomada(conversationId)) return false;
        return !(await estaDadoDeBaja(integrationId, waId));
    },
    async enviarTexto(integ, waId, texto, botones) {
        if (botones?.length) {
            const r = await sendInteractiveButtons(integ, waId, texto, botones);
            if (r.ok) return r;
        }
        return sendTextMessage(integ, waId, texto);
    },
    async registrarSaliente(a) {
        await supabase.rpc('wa_record_outbound_message', {
            p_conversation_id: a.conversationId,
            p_integration_id: a.integ.id,
            p_wa_message_id: a.waMessageId || `local-${crypto.randomUUID()}`,
            p_type: a.tipo,
            p_text_body: a.texto,
            // Lo mandó un job: no es una persona de la escuela (no calla al bot).
            p_payload: { ...a.payload, automatico: true },
            p_ai_generated: false,
            p_to_wa_id: a.waId,
        });
    },
    enviarPlantilla: enviarCobroPorPlantilla,
    async reservar(leadId, clave, valor) {
        const { data: l } = await supabase.from('school_signup_leads').select('source_detail').eq('id', leadId).maybeSingle();
        const sd = ((l as any)?.source_detail ?? {}) as Record<string, any>;
        if (sd[clave]?.id === valor.id) return false;
        const previo = sd[clave]?.id ?? null;
        let q = supabase.from('school_signup_leads')
            .update({ source_detail: { ...sd, [clave]: valor }, updated_at: new Date().toISOString() })
            .eq('id', leadId);
        // Escritura con filtro: si otro BFF ya cambió la marca, no devuelve fila.
        q = previo ? q.eq(`source_detail->${clave}->>id`, previo) : q.is(`source_detail->${clave}`, null);
        const { data, error } = await q.select('id');
        return !error && Array.isArray(data) && data.length > 0;
    },
    log: console,
};

type Canal = 'texto' | 'plantilla' | 'ninguno';

/**
 * Manda un aviso del job: dentro de la ventana de 24 h, texto (con botones si
 * vienen); fuera, la plantilla de UTILIDAD (exige consentimiento). Sin
 * `concepto`, solo texto: fuera de la ventana no sale. Devuelve por dónde
 * salió. Nunca lanza.
 */
async function enviarAviso(d: DepsEnvio, a: {
    schoolId: string; telefono: string | null; texto: string; botones?: BotonInteractivo[]; step: string;
    estado: Record<string, unknown>; concepto?: ConceptoCobro; datos?: DatosCobro;
}): Promise<{ canal: Canal; motivo?: string }> {
    try {
        const waId = waIdDeTelefono(a.telefono);
        if (!waId) return { canal: 'ninguno', motivo: 'telefono_invalido' };
        const integ = await d.integracion(a.schoolId);
        if (!integ) return { canal: 'ninguno', motivo: 'sin_integracion' };
        const conv = await d.conversacion(integ.id, waId);
        if (!(await d.puedeEscribir(integ.id, conv?.id ?? null, waId))) return { canal: 'ninguno', motivo: 'no_se_escribe' };
        const payload = { step: a.step, ...a.estado };
        if (conv && ventanaAbierta(conv.last_inbound_at, d.ahora().getTime())) {
            const r = await d.enviarTexto(integ, waId, a.texto, a.botones);
            if (r.ok) {
                await d.registrarSaliente({
                    integ, conversationId: conv.id, waId, waMessageId: r.waMessageId ?? null, texto: a.texto,
                    tipo: a.botones?.length ? 'interactive' : 'text', payload,
                }).catch(() => undefined);
                return { canal: 'texto' };
            }
        }
        if (!a.concepto || !a.datos) return { canal: 'ninguno', motivo: 'ventana_cerrada' };
        const p = await d.enviarPlantilla({
            schoolId: a.schoolId, concepto: a.concepto, telefono: waId, datos: a.datos, tokenBoton: null,
            ahora: d.ahora(), payloadExtra: payload,
        });
        return p.enviado ? { canal: 'plantilla' } : { canal: 'ninguno', motivo: p.motivo };
    } catch (e: any) {
        return { canal: 'ninguno', motivo: e?.message ?? 'error' };
    }
}

/** Hora de Bogotá (0–23). Pura. */
export function horaBogota(ahora: Date): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(ahora));
}

const fechaBogota = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** «hoy a las 4:45 p. m.» / «mañana a las 12:30 a. m.» / «el sábado 31 de octubre a las …». Pura. */
export function cuandoVence(hasta: string, ahora: Date): string {
    const h = new Date(hasta);
    const hora = horaLegible(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(h));
    const dia = fechaBogota(h);
    const hoy = fechaBogota(ahora);
    const manana = fechaBogota(new Date(ahora.getTime() + 24 * 3600_000));
    if (dia === hoy) return `hoy a las ${hora}`;
    if (dia === manana) return `mañana a las ${hora}`;
    return `el ${fechaLegible(dia)} a las ${hora}`;
}

/** Texto del aviso «tu cupo vence en 2 h» (dentro de la ventana). Pura. */
export function textoCupoPorVencer(o: {
    acudiente?: string | null; deportista?: string | null; nombreClase?: NombreClase | null;
    fecha: string; horaInicio: string; vence: string;
}): string {
    const hola = primerNombre(o.acudiente) ? `Hola, ${primerNombre(o.acudiente)} 👋` : 'Hola 👋';
    const de = primerNombre(o.deportista) ? ` de *${primerNombre(o.deportista)}*` : '';
    return `${hola} El cupo que te separé para la ${nombreDeClase(o.nombreClase)}${de} ` +
        `(${fechaLegible(o.fecha)}, ${horaLegible(o.horaInicio)}) vence ${o.vence} ⏳\n\n` +
        'Si ya pagaste, envíame aquí la foto o el PDF del comprobante 📸 y queda agendada.';
}

/** Texto de «clase reprogramada» (dentro de la ventana). Nunca vuelve a cobrar. Pura. */
export function textoClaseReprogramada(o: {
    acudiente?: string | null; deportista?: string | null; nombreClase?: NombreClase | null;
    fecha: string; horaInicio: string; motivo: string;
}): string {
    const hola = primerNombre(o.acudiente) ? `Hola, ${primerNombre(o.acudiente)} 👋` : 'Hola 👋';
    const de = primerNombre(o.deportista) ? ` de *${primerNombre(o.deportista)}*` : '';
    return `${hola} La ${nombreDeClase(o.nombreClase)}${de} del ${fechaLegible(o.fecha)} a las ${horaLegible(o.horaInicio)} ` +
        `no se va a realizar por ${o.motivo}. 🙏\n\n` +
        'Toca *Elegir otro horario* y escoge una nueva fecha, sin costo adicional.';
}

export const MOTIVO_REPROGRAMADA_POR_DEFECTO = 'un cambio en la programación del entrenamiento';
export const BOTON_REPROGRAMAR: BotonInteractivo[] = [{ id: BOTON_AGENDA.REPROGRAMAR, title: 'Elegir otro horario' }];

const pesos = (n: number | null | undefined) => (n && n > 0 ? `$${Math.round(n).toLocaleString('es-CO')}` : null);

// ─── Job: cupos separados ────────────────────────────────────────────────────

/** El aviso sale entre 2 h 15 min y 10 min antes de vencer. */
export const AVISO_DESDE_MIN = 135;
export const AVISO_HASTA_MIN = 10;
/** Solo de día (Bogotá): de noche el cupo vence sin aviso y la escuela se entera. */
export const AVISO_HORA_MIN = 7;
export const AVISO_HORA_MAX = 21;

export interface ResumenCupos {
    porVencer: number;
    avisados: number;
    omitidos: number;
    liberados: number;
    confirmados: number;
    errores: number;
    sinMigracion?: boolean;
    desactivado?: boolean;
}

export interface DepsCupos extends DepsEnvio {
    /** Leads con cupo separado que vence entre `desde` y `hasta` (ISO). */
    cuposPorVencer: (desde: string, hasta: string) => Promise<any[] | 'sin_migracion'>;
    slots: (ids: string[]) => Promise<any[]>;
    /** RPC soltar_cupos_separados(NULL): los vencidos. [{lead_id, school_id, phone, accion, slot_id?}] */
    soltarVencidos: () => Promise<any[] | 'sin_migracion'>;
    leads: (ids: string[]) => Promise<any[]>;
    ajustes: typeof ajustesClasePrueba;
    avisarLiberado: (fila: { lead_id: string; school_id: string; slot_id?: string | null }, lead: any, horas: number | null) => Promise<void>;
    /** Agenda (etapa + avisos) y devuelve la confirmación para el interesado, o null. */
    alConfirmar: (fila: { lead_id: string; school_id: string; phone?: string | null }) =>
        Promise<{ texto: string; telefono: string | null; slotId: string; teamId: string | null } | null>;
}

const DEPS_CUPOS: Omit<DepsCupos, keyof DepsEnvio> = {
    async cuposPorVencer(desde, hasta) {
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, school_id, full_name, guardian_name, phone, status, cupo_separado_slot_id, cupo_separado_hasta, source_detail')
            .gt('cupo_separado_hasta', desde).lte('cupo_separado_hasta', hasta)
            .in('status', ['new', 'contacted']).limit(200);
        if (error) return esColumnaInexistente(error) ? 'sin_migracion' : [];
        return (data ?? []) as any[];
    },
    async slots(ids) {
        if (!ids.length) return [];
        const { data } = await supabase.from('school_trial_slots')
            .select('id, label, slot_date, start_time, end_time, location, team_id').in('id', ids);
        return (data ?? []) as any[];
    },
    async soltarVencidos() {
        const { data, error } = await supabase.rpc('soltar_cupos_separados', { p_lead_id: null, p_limite: 200 });
        if (error) return esRpcFaltante(error) ? 'sin_migracion' : [];
        return Array.isArray(data) ? data : [];
    },
    async leads(ids) {
        if (!ids.length) return [];
        const { data } = await supabase.from('school_signup_leads')
            .select('id, school_id, full_name, guardian_name, phone, source_detail').in('id', ids);
        return (data ?? []) as any[];
    },
    ajustes: ajustesClasePrueba,
    async avisarLiberado(fila, lead, horas) {
        const nombre = lead?.full_name?.trim() || 'Un interesado';
        await avisarAdministracion(fila.school_id,
            `clase_prueba_cupo_liberado:${fila.lead_id}:${fila.slot_id ?? fechaBogota(new Date())}`,
            'Cupo de clase de prueba liberado',
            `${nombre}: no llegó el comprobante${horas ? ` en ${horas} h` : ''} y el cupo quedó libre. ` +
            'Escríbele por WhatsApp si quiere otro horario.',
            { tipo: 'clase_prueba_cupo_liberado', lead_id: fila.lead_id, slot_id: fila.slot_id ?? null });
    },
    async alConfirmar(fila) {
        // El pago llegó por otro lado (registrado a mano o revisado): queda agendada.
        const d = { ...DEPS_AGENDA };
        const lead = await d.leerLead(fila.school_id, fila.lead_id);
        if (!lead?.trialSlotId) return null;
        const [franja, aj, queLlevar] = await Promise.all([
            d.franja(fila.school_id, lead.trialSlotId), d.ajustes(fila.school_id), d.queLlevar(fila.school_id).catch(() => null),
        ]);
        await alAgendar(d, lead, franja, 'agendada', { agendado_por: 'pago' }, waIdDeTelefono(fila.phone ?? lead.telefono), aj);
        if (!franja) return null;
        return {
            texto: textoConfirmacion(franja, { deportista: lead.nombre, nombreClase: aj.nombreClase, queLlevar }),
            telefono: fila.phone ?? lead.telefono, slotId: franja.id, teamId: franja.teamId,
        };
    },
};

/**
 * Job (cada 15 min, kill-switch `DISABLE_CUPOS_SEPARADOS=true`):
 *  1. Aviso «tu cupo vence en 2 h» a los separados que vencen en 10 min–2 h 15 min,
 *     solo de día; dentro de la ventana por texto, fuera por la plantilla de
 *     utilidad `clase_prueba_cupo_por_vencer` (exige el «Sí, claro»). Una vez por cupo.
 *  2. `soltar_cupos_separados()`: los vencidos se liberan SIN mensaje al interesado
 *     y la escuela recibe el aviso; si ya había pago, la RPC confirma en vez de
 *     soltar y se avisa como agendada.
 * Una lectura por lote (sin N+1 en las consultas de leads y franjas). Nunca lanza.
 */
export async function runCuposSeparados(opciones: { deps?: Partial<DepsCupos> } = {}): Promise<ResumenCupos> {
    const r: ResumenCupos = { porVencer: 0, avisados: 0, omitidos: 0, liberados: 0, confirmados: 0, errores: 0 };
    if (process.env.DISABLE_CUPOS_SEPARADOS === 'true') return { ...r, desactivado: true };
    const d: DepsCupos = { ...DEPS_ENVIO, ...DEPS_CUPOS, ...opciones.deps };
    const ahora = d.ahora();
    try {
        // 1. Por vencer.
        const desde = new Date(ahora.getTime() + AVISO_HASTA_MIN * 60_000).toISOString();
        const hasta = new Date(ahora.getTime() + AVISO_DESDE_MIN * 60_000).toISOString();
        const hora = horaBogota(ahora);
        const porVencer = await d.cuposPorVencer(desde, hasta);
        if (porVencer === 'sin_migracion') return { ...r, sinMigracion: true };
        const pendientes = porVencer.filter((l) => l.cupo_separado_slot_id && l.cupo_separado_hasta
            && l.source_detail?.aviso_cupo_por_vencer?.id !== `${l.cupo_separado_slot_id}:${l.cupo_separado_hasta}`);
        r.porVencer = pendientes.length;
        if (pendientes.length && hora >= AVISO_HORA_MIN && hora < AVISO_HORA_MAX) {
            const slots = new Map((await d.slots([...new Set(pendientes.map((l) => l.cupo_separado_slot_id))])).map((s) => [s.id, s]));
            const ajustesPorEscuela = new Map<string, AjustesClasePrueba>();
            for (const l of pendientes) {
                const s = slots.get(l.cupo_separado_slot_id);
                if (!s) { r.omitidos++; continue; }
                if (!ajustesPorEscuela.has(l.school_id)) ajustesPorEscuela.set(l.school_id, await d.ajustes(l.school_id));
                const aj = ajustesPorEscuela.get(l.school_id)!;
                const id = `${l.cupo_separado_slot_id}:${l.cupo_separado_hasta}`;
                if (!(await d.reservar(l.id, 'aviso_cupo_por_vencer', { id, at: ahora.toISOString() }))) { r.omitidos++; continue; }
                const fecha = String(s.slot_date).slice(0, 10);
                const horaInicio = String(s.start_time).slice(0, 5);
                const vence = cuandoVence(l.cupo_separado_hasta, ahora);
                const envio = await enviarAviso(d, {
                    schoolId: l.school_id, telefono: l.phone,
                    texto: textoCupoPorVencer({
                        acudiente: l.guardian_name, deportista: l.full_name, nombreClase: aj.nombreClase, fecha, horaInicio, vence,
                    }),
                    step: 'clase_prueba_cupo_por_vencer',
                    estado: {
                        flujo: FLUJO_EMBUDO_AGENDA, paso_embudo: 'esperando_pago',
                        datos_embudo: { leadId: l.id, slotId: l.cupo_separado_slot_id, hasta: l.cupo_separado_hasta, teamId: s.team_id ?? null },
                    },
                    concepto: 'clase_prueba_cupo_por_vencer',
                    datos: {
                        nombreContacto: primerNombre(l.guardian_name) || primerNombre(l.full_name) || 'familia',
                        nombreAtleta: primerNombre(l.full_name) || 'tu deportista', nombreEscuela: '',
                        monto: pesos(aj.precio) ?? '', dia: fechaLegible(fecha), hora: horaLegible(horaInicio), vence,
                    },
                });
                if (envio.canal === 'ninguno') { r.omitidos++; d.log.info?.('[clase-prueba] aviso de cupo no salió', { lead: l.id, motivo: envio.motivo }); }
                else r.avisados++;
            }
        }

        // 2. Vencidos.
        const vencidos = await d.soltarVencidos();
        if (vencidos === 'sin_migracion') return { ...r, sinMigracion: true };
        if (vencidos.length) {
            const leads = new Map((await d.leads([...new Set(vencidos.map((v) => v.lead_id))])).map((l) => [l.id, l]));
            for (const v of vencidos) {
                try {
                    if (v.accion === 'confirmada') {
                        // El pago llegó por otro lado (registrado a mano o revisado): queda agendada
                        // y se le dice, solo si la ventana sigue abierta (no hay plantilla para esto).
                        const c = await d.alConfirmar(v);
                        if (c) {
                            await enviarAviso(d, {
                                schoolId: v.school_id, telefono: c.telefono, texto: c.texto, step: 'clase_prueba_agendada',
                                estado: { flujo: FLUJO_EMBUDO_AGENDA, paso_embudo: 'agendada', datos_embudo: { leadId: v.lead_id, slotId: c.slotId, teamId: c.teamId } },
                            });
                        }
                        r.confirmados++;
                    } else if (v.accion === 'liberada') {
                        const aj = await d.ajustes(v.school_id);
                        await d.avisarLiberado(v, leads.get(v.lead_id), aj.separarHoras);
                        r.liberados++;
                    }
                } catch {
                    r.errores++;
                }
            }
        }
    } catch (e: any) {
        r.errores++;
        d.log.warn?.('[clase-prueba] runCuposSeparados falló', { err: e?.message });
    }
    return r;
}

// ─── Clases reprogramadas (lluvia / el profe canceló o movió la sesión) ──────

export interface ExcepcionSemana {
    school_id?: string;
    team_id: string;
    fecha: string;                  // YYYY-MM-DD
    tipo: 'cancelada' | 'movida' | 'extra';
    hora_original: string | null;   // NULL en 'cancelada' = todo el día
    motivo?: string | null;
}

export interface SlotParaExcepcion { id: string; team_id: string | null; slot_date: string; start_time: string }

/**
 * Franjas que quedaron sin sesión: 'cancelada' (todo el día si no trae hora) y
 * 'movida' (la sesión de la hora original ya no es a esa hora). 'extra' no
 * afecta a nadie. Devuelve cada franja con su excepción. Pura.
 */
export function franjasAfectadas<S extends SlotParaExcepcion>(excepciones: ExcepcionSemana[], slots: S[]): { slot: S; excepcion: ExcepcionSemana }[] {
    const salida: { slot: S; excepcion: ExcepcionSemana }[] = [];
    const vistos = new Set<string>();
    const hhmm = (h: string | null | undefined) => (h ? String(h).slice(0, 5) : null);
    for (const e of excepciones) {
        if (e.tipo !== 'cancelada' && e.tipo !== 'movida') continue;
        for (const s of slots) {
            if (s.team_id !== e.team_id || String(s.slot_date).slice(0, 10) !== e.fecha || vistos.has(s.id)) continue;
            const original = hhmm(e.hora_original);
            if (e.tipo === 'movida' && !original) continue;
            if (original && hhmm(s.start_time) !== original) continue;
            vistos.add(s.id);
            salida.push({ slot: s, excepcion: e });
        }
    }
    return salida;
}

export interface ResumenReprogramadas {
    excepciones: number;
    franjas: number;
    agendados: number;
    porTexto: number;
    porPlantilla: number;
    sinCanal: number;
    yaAvisados: number;
    errores: number;
    sinTabla?: boolean;
}

export interface DepsReprogramadas extends DepsEnvio {
    excepciones: (schoolId: string, desde: string, hasta: string, teamId?: string | null) => Promise<ExcepcionSemana[] | 'sin_tabla'>;
    slotsDeEquipos: (schoolId: string, teamIds: string[], fechas: string[]) => Promise<any[]>;
    /** Leads agendados (trial_slot_id) o con cupo separado en esas franjas. */
    leadsDeFranjas: (slotIds: string[]) => Promise<any[]>;
    ajustes: typeof ajustesClasePrueba;
}

const esTablaFaltante = (e: any) => e?.code === '42P01' || e?.code === 'PGRST205'
    || /team_schedule_exceptions/.test(String(e?.message ?? '')) && /exist|find/i.test(String(e?.message ?? ''));

/**
 * El motivo que escribió el profe al cancelar («lluvia», «por lluvia») → lo que va
 * después de «no se va a realizar por …». Recortado a 120; null si no hay. Pura.
 */
export function motivoDeReprogramacion(m: unknown): string | null {
    if (typeof m !== 'string') return null;
    const t = m.replace(/\s+/g, ' ').trim().replace(/^por\s+/i, '').replace(/[.!]+$/, '').trim();
    return t ? Array.from(t).slice(0, 120).join('') : null;
}

const COLS_EXCEPCION = 'school_id, team_id, fecha, tipo, hora_original';

/**
 * Lee excepciones de «Mi semana». `motivo` llega con una migración aparte: sin la
 * columna se lee sin ella (el aviso dice el motivo genérico). Nunca lanza por la base.
 */
async function leerExcepciones(consulta: (cols: string) => PromiseLike<{ data: any; error: any }>): Promise<ExcepcionSemana[] | 'sin_tabla'> {
    let r = await consulta(`${COLS_EXCEPCION}, motivo`);
    if (r.error && esColumnaInexistente(r.error)) r = await consulta(COLS_EXCEPCION);
    if (r.error) return esTablaFaltante(r.error) ? 'sin_tabla' : [];
    return ((r.data ?? []) as any[]).map((e) => ({ ...e, fecha: String(e.fecha).slice(0, 10), motivo: motivoDeReprogramacion(e.motivo) }));
}

const DEPS_REPROGRAMADAS: Omit<DepsReprogramadas, keyof DepsEnvio> = {
    async excepciones(schoolId, desde, hasta, teamId) {
        return leerExcepciones((cols) => {
            let q = supabase.from('team_schedule_exceptions').select(cols)
                .eq('school_id', schoolId).in('tipo', ['cancelada', 'movida'])
                .gte('fecha', desde).lte('fecha', hasta);
            if (teamId) q = q.eq('team_id', teamId);
            return q.limit(500) as any;
        });
    },
    async slotsDeEquipos(schoolId, teamIds, fechas) {
        if (!teamIds.length || !fechas.length) return [];
        const { data } = await supabase.from('school_trial_slots')
            .select('id, team_id, label, slot_date, start_time, end_time, location')
            .eq('school_id', schoolId).in('team_id', teamIds).in('slot_date', fechas).limit(1000);
        return (data ?? []) as any[];
    },
    async leadsDeFranjas(slotIds) {
        if (!slotIds.length) return [];
        const cols = 'id, school_id, full_name, guardian_name, phone, status, trial_slot_id, source_detail';
        const [agendados, separados] = await Promise.all([
            supabase.from('school_signup_leads').select(cols).in('trial_slot_id', slotIds).in('status', ['new', 'contacted']).limit(500),
            supabase.from('school_signup_leads').select(`${cols}, cupo_separado_slot_id`)
                .in('cupo_separado_slot_id', slotIds).in('status', ['new', 'contacted']).limit(500),
        ]);
        const porId = new Map<string, any>();
        for (const l of ((agendados as any).data ?? []) as any[]) porId.set(l.id, l);
        // Sin la migración la segunda consulta falla: solo quedan los agendados.
        for (const l of ((separados as any).error ? [] : ((separados as any).data ?? [])) as any[]) if (!porId.has(l.id)) porId.set(l.id, l);
        return [...porId.values()];
    },
    ajustes: ajustesClasePrueba,
};

const sumarDias = (iso: string, n: number) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)).toISOString().slice(0, 10);

/**
 * Una sesión con clases de prueba se canceló (lluvia) o el profe la movió en
 * «Mi semana»: a cada agendado (o con cupo separado) de esas franjas se le
 * escribe UNA vez por franja. Dentro de la ventana, texto con el botón «Elegir
 * otro horario»; fuera, la plantilla de utilidad `clase_prueba_reprogramada`
 * (exige el «Sí, claro»). El estado del embudo viaja en el saliente: el botón
 * ofrece los horarios del mismo grupo y `tomarCupo` agenda sin cobrar de nuevo
 * (el pago está atado al lead). La franja vieja la cierra el generador cuando
 * ya no le queda nadie. Nunca lanza.
 */
export async function avisarClasesCanceladas(p: {
    schoolId: string; teamId?: string | null; excepciones?: ExcepcionSemana[]; deps?: Partial<DepsReprogramadas>;
}): Promise<ResumenReprogramadas> {
    const r: ResumenReprogramadas = { excepciones: 0, franjas: 0, agendados: 0, porTexto: 0, porPlantilla: 0, sinCanal: 0, yaAvisados: 0, errores: 0 };
    const d: DepsReprogramadas = { ...DEPS_ENVIO, ...DEPS_REPROGRAMADAS, ...p.deps };
    try {
        const hoy = fechaBogota(d.ahora());
        const exc = p.excepciones ?? await d.excepciones(p.schoolId, hoy, sumarDias(hoy, 28), p.teamId);
        if (exc === 'sin_tabla') return { ...r, sinTabla: true };
        const vigentes = exc.filter((e) => (e.tipo === 'cancelada' || e.tipo === 'movida') && e.fecha >= hoy
            && (!p.teamId || e.team_id === p.teamId));
        r.excepciones = vigentes.length;
        if (!vigentes.length) return r;
        const slots = await d.slotsDeEquipos(p.schoolId, [...new Set(vigentes.map((e) => e.team_id))], [...new Set(vigentes.map((e) => e.fecha))]);
        const afectadas = franjasAfectadas(vigentes, slots as SlotParaExcepcion[]);
        r.franjas = afectadas.length;
        if (!afectadas.length) return r;
        const porSlot = new Map(afectadas.map((a) => [a.slot.id, a]));
        const leads = await d.leadsDeFranjas([...porSlot.keys()]);
        const aj = await d.ajustes(p.schoolId);
        for (const l of leads) {
            const slotId: string | null = porSlot.has(l.trial_slot_id) ? l.trial_slot_id
                : porSlot.has(l.cupo_separado_slot_id) ? l.cupo_separado_slot_id : null;
            if (!slotId) continue;
            r.agendados++;
            const { slot, excepcion } = porSlot.get(slotId)!;
            if (l.source_detail?.reprogramada?.id === slotId) { r.yaAvisados++; continue; }
            if (!(await d.reservar(l.id, 'reprogramada', { id: slotId, at: d.ahora().toISOString(), tipo: excepcion.tipo }))) {
                r.yaAvisados++;
                continue;
            }
            const fecha = String(slot.slot_date).slice(0, 10);
            const horaInicio = String(slot.start_time).slice(0, 5);
            const motivo = motivoDeReprogramacion(excepcion.motivo) ?? MOTIVO_REPROGRAMADA_POR_DEFECTO;
            const envio = await enviarAviso(d, {
                schoolId: p.schoolId, telefono: l.phone,
                texto: textoClaseReprogramada({ acudiente: l.guardian_name, deportista: l.full_name, nombreClase: aj.nombreClase, fecha, horaInicio, motivo }),
                botones: BOTON_REPROGRAMAR,
                step: 'clase_prueba_reprogramada',
                estado: {
                    flujo: FLUJO_EMBUDO_AGENDA, paso_embudo: 'reprogramar',
                    datos_embudo: { leadId: l.id, teamId: (slot as any).team_id ?? null, slotId, reprogramada: true },
                },
                concepto: 'clase_prueba_reprogramada',
                datos: {
                    nombreContacto: primerNombre(l.guardian_name) || primerNombre(l.full_name) || 'familia',
                    nombreAtleta: primerNombre(l.full_name) || 'tu deportista', nombreEscuela: '', monto: '',
                    dia: fechaLegible(fecha), hora: horaLegible(horaInicio), motivo,
                },
            });
            if (envio.canal === 'texto') r.porTexto++;
            else if (envio.canal === 'plantilla') r.porPlantilla++;
            else { r.sinCanal++; d.log.info?.('[clase-prueba] aviso de reprogramación no salió', { lead: l.id, motivo: envio.motivo }); }
        }
    } catch (e: any) {
        r.errores++;
        d.log.warn?.('[clase-prueba] avisarClasesCanceladas falló', { schoolId: p.schoolId, err: e?.message });
    }
    return r;
}

/**
 * Job (red de seguridad del aviso que dispara «Mi semana» al guardar): las
 * excepciones creadas o tocadas en las últimas 48 h, de hoy en adelante, en UNA
 * consulta; después una pasada por escuela. Idempotente por lead y franja.
 */
export async function runClasesReprogramadas(opciones: { deps?: Partial<DepsReprogramadas> & {
    recientes?: (desde: string, hoy: string) => Promise<ExcepcionSemana[] | 'sin_tabla'>;
} } = {}): Promise<{ escuelas: number; avisos: number; sinTabla?: boolean }> {
    const ahora = (opciones.deps?.ahora ?? (() => new Date()))();
    const hoy = fechaBogota(ahora);
    const recientes = opciones.deps?.recientes ?? (async (desde: string, desdeFecha: string) => {
        return leerExcepciones((cols) => supabase.from('team_schedule_exceptions').select(cols)
            .in('tipo', ['cancelada', 'movida']).gte('updated_at', desde).gte('fecha', desdeFecha).limit(1000) as any);
    });
    try {
        const exc = await recientes(new Date(ahora.getTime() - 48 * 3600_000).toISOString(), hoy);
        if (exc === 'sin_tabla') return { escuelas: 0, avisos: 0, sinTabla: true };
        const porEscuela = new Map<string, ExcepcionSemana[]>();
        for (const e of exc) {
            if (!e.school_id) continue;
            if (!porEscuela.has(e.school_id)) porEscuela.set(e.school_id, []);
            porEscuela.get(e.school_id)!.push(e);
        }
        let avisos = 0;
        for (const [schoolId, excepciones] of porEscuela) {
            const r = await avisarClasesCanceladas({ schoolId, excepciones, deps: opciones.deps });
            avisos += r.porTexto + r.porPlantilla;
        }
        return { escuelas: porEscuela.size, avisos };
    } catch {
        return { escuelas: 0, avisos: 0 };
    }
}
