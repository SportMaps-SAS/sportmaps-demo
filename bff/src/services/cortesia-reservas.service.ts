/**
 * cortesia-reservas.service — DÓNDE quedan las clases de cortesía y CÓMO se
 * entera la escuela. «Se brinda la información y se agenda, y la dueña tiene
 * que saber dónde quedó agendado» (Dynasty, 2026-10-06).
 *
 * DÓNDE VIVE UNA RESERVA (medido en la base el 2026-10-06):
 *   `school_signup_leads` con `trial_slot_id` → `school_trial_slots`
 *   (label = grupo, slot_date, start_time/end_time, location = sede).
 *   - La crea `submit_school_lead`: la llama el formulario /inscripcion/<slug>
 *     y el bot de WhatsApp (whatsapp-clase-cortesia.service, `how_heard =
 *     'whatsapp'`, `source_detail = {canal:'whatsapp', conversation_id}`).
 *   - Cancelar (`wa_cancelar_clase_de_prueba`) PONE `trial_slot_id = NULL` y
 *     deja la constancia en `notes`: una cancelada deja de verse como reserva.
 *   - Lo que la escuela agenda a mano en el chat desde su celular («Sábado
 *     11 am») NO queda en ninguna tabla.
 *
 * Este módulo:
 *   1. `listarCortesias` — reservas con franja (próximas y pasadas) + leads sin
 *      agendar, para la pestaña «Clases de cortesía» y el resumen de las 7.
 *   2. `avisarCortesia` — aviso inmediato a owner/admins por reserva nueva o
 *      cancelación: in-app (notifications) + push + correo.
 *   3. `marcarAsistencia` — «asistió / no vino», en `source_detail.asistencia`
 *      (sin migración: jsonb que ya existe).
 *
 * IDEMPOTENCIA ENTRE LOS TRES BFF (una sola Supabase): la notificación in-app
 * entra con `id` DETERMINÍSTICO por (evento, lead, franja, usuario); el PK es el
 * candado. El push sale SOLO si ese INSERT entró (el segundo BFF choca con
 * 23505 y no empuja). El correo usa la reserva de `email_sends`
 * (avisos-correo.service). Ningún candado en memoria.
 */

import { supabase } from '../config/supabase';
import { sendToUser } from './push.service';
import { destinatariosDeEscuela, enviarConReserva, uuidDeClave } from './avisos-correo.service';
import { avisarCortesiaPorPlataforma } from './plataforma-wa-avisos.service';
import type { AvisoCortesia, TipoAvisoCortesia } from './whatsapp-clase-cortesia.service';

const TZ = 'America/Bogota';

// ─── Formato (puro) ─────────────────────────────────────────────────────────

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function fechaLarga(fecha: string): string {
    const [y, m, d] = fecha.slice(0, 10).split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
    return `${DIAS[dow]} ${d} de ${MESES[m - 1]}`;
}

export function hora12(hora: string): string {
    const [hh, mm] = hora.split(':').map(Number);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm || 0).padStart(2, '0')} ${hh >= 12 ? 'p. m.' : 'a. m.'}`;
}

/** 'YYYY-MM-DD' en Bogotá (UTC-5 fijo, sin horario de verano). */
export function hoyBogota(ahora: Date | number = Date.now()): string {
    return new Date(new Date(ahora).getTime() - 5 * 3600_000).toISOString().slice(0, 10);
}

export function sumarDias(fecha: string, n: number): string {
    const [y, m, d] = fecha.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/** Enlace para escribirle directo: wa.me/<dígitos>. Celular de 10 dígitos → +57. */
export function enlaceWaMe(telefono: string | null | undefined): string | null {
    const d = String(telefono ?? '').replace(/\D/g, '');
    if (d.length < 7) return null;
    return `https://wa.me/${/^3\d{9}$/.test(d) ? `57${d}` : d}`;
}

/** '3001112233' → '••• ••• 2233'. Para correos de resumen: reconocerlo sin regalar el número. */
export function enmascararTelefonoLead(tel: string | null | undefined): string {
    const d = String(tel ?? '').replace(/\D/g, '');
    return d.length < 6 ? 'sin teléfono' : `••• ••• ${d.slice(-4)}`;
}

/** Todas las formas en que puede estar guardado un mismo número. */
export function variantesTelefono(tel: string | null | undefined): string[] {
    const d = String(tel ?? '').replace(/\D/g, '');
    if (d.length < 7) return [];
    const t10 = d.slice(-10);
    return [...new Set([t10, `57${t10}`, `+57${t10}`, d, `+${d}`])];
}

/** Edad por fecha de nacimiento; si no hay, la que el bot dejó en `notes`. */
export function edadDeLead(birthDate: string | null | undefined, notes: string | null | undefined, hoy: string): number | null {
    if (birthDate) {
        const [y, m, d] = String(birthDate).slice(0, 10).split('-').map(Number);
        const [hy, hm, hd] = hoy.split('-').map(Number);
        let e = hy - y;
        if (hm < m || (hm === m && hd < d)) e--;
        if (e >= 0 && e < 120) return e;
    }
    const m = /Edad informada:\s*(\d{1,2})/i.exec(String(notes ?? ''));
    return m ? Number(m[1]) : null;
}

/** «Su hijo/a de 12 años (acudiente: Ana)» / «Adulto (25 años)». */
export function paraQuien(edad: number | null, acudiente: string | null | undefined): string {
    if (edad === null) return acudiente ? `Menor de edad (acudiente: ${acudiente})` : 'Edad sin informar';
    if (edad < 18) return `Menor de ${edad} años${acudiente ? ` (acudiente: ${acudiente})` : ''}`;
    return `Adulto (${edad} años)`;
}

// ─── Listado ────────────────────────────────────────────────────────────────

export type Asistencia = 'asistio' | 'no_vino';
export type OrigenReserva = 'whatsapp' | 'web';

export interface ReservaCortesia {
    leadId: string;
    nombre: string;
    acudiente: string | null;
    telefono: string | null;
    waMe: string | null;
    edad: number | null;
    paraQuien: string;
    grupo: string;
    fecha: string;
    horaInicio: string;
    horaFin: string | null;
    sede: string | null;
    estado: string;
    origen: OrigenReserva;
    conversationId: string | null;
    asistencia: Asistencia | null;
    creadaEn: string;
}

export interface LeadSinAgendar {
    leadId: string;
    nombre: string;
    telefono: string | null;
    waMe: string | null;
    edad: number | null;
    paraQuien: string;
    estado: string;
    origen: OrigenReserva;
    conversationId: string | null;
    creadoEn: string;
    /** Constancia de una clase cancelada (la deja wa_cancelar_clase_de_prueba en notes). */
    cancelada: boolean;
}

export function origenDe(row: { how_heard?: string | null; source_detail?: any }): OrigenReserva {
    return row.source_detail?.canal === 'whatsapp' || row.how_heard === 'whatsapp' ? 'whatsapp' : 'web';
}

export function aReserva(row: any, hoy: string, convPorTel: Map<string, string> = new Map()): ReservaCortesia | null {
    const s = Array.isArray(row.school_trial_slots) ? row.school_trial_slots[0] : row.school_trial_slots;
    if (!s) return null;
    const edad = edadDeLead(row.birth_date, row.notes, hoy);
    const asis = row.source_detail?.asistencia;
    return {
        leadId: row.id,
        nombre: row.full_name,
        acudiente: row.guardian_name ?? null,
        telefono: row.phone ?? null,
        waMe: enlaceWaMe(row.phone),
        edad,
        paraQuien: paraQuien(edad, row.guardian_name),
        grupo: String(s.label ?? 'Clase de cortesía'),
        fecha: String(s.slot_date).slice(0, 10),
        horaInicio: String(s.start_time).slice(0, 5),
        horaFin: s.end_time ? String(s.end_time).slice(0, 5) : null,
        sede: s.location ?? null,
        estado: row.status,
        origen: origenDe(row),
        conversationId: row.source_detail?.conversation_id ?? conversacionPorTelefono(row.phone, convPorTel),
        asistencia: asis === 'asistio' || asis === 'no_vino' ? asis : null,
        creadaEn: row.created_at,
    };
}

function conversacionPorTelefono(tel: string | null | undefined, convPorTel: Map<string, string>): string | null {
    for (const v of variantesTelefono(tel)) {
        const c = convPorTel.get(v);
        if (c) return c;
    }
    return null;
}

export interface FiltroCortesias {
    /** Fecha de la clase desde/hasta (YYYY-MM-DD, inclusive). */
    desde?: string;
    hasta?: string;
    /** Leads sin agendar creados en los últimos N días (default 14). */
    diasLeads?: number;
}

export interface ListadoCortesias {
    reservas: ReservaCortesia[];
    sinAgendar: LeadSinAgendar[];
}

const COLUMNAS_LEAD = 'id, full_name, guardian_name, phone, birth_date, notes, status, how_heard, source_detail, created_at, trial_slot_id';

/**
 * Reservas (con franja) y leads sin agendar de UNA escuela. `school_id` va en
 * cada consulta: el endpoint ya validó que quien pide administra esa escuela.
 */
export async function listarCortesias(schoolId: string, f: FiltroCortesias = {}, ahora = Date.now()): Promise<ListadoCortesias> {
    const hoy = hoyBogota(ahora);
    let q = supabase.from('school_signup_leads')
        .select(`${COLUMNAS_LEAD}, school_trial_slots!inner(id, label, slot_date, start_time, end_time, location)`)
        .eq('school_id', schoolId)
        .not('trial_slot_id', 'is', null)
        .neq('status', 'discarded');
    if (f.desde) q = q.gte('school_trial_slots.slot_date', f.desde);
    if (f.hasta) q = q.lte('school_trial_slots.slot_date', f.hasta);
    const desdeLeads = new Date(ahora - (f.diasLeads ?? 14) * 86_400_000).toISOString();

    const [conSlot, sinSlot, convs] = await Promise.all([
        q.order('created_at', { ascending: false }).limit(500),
        supabase.from('school_signup_leads')
            .select(COLUMNAS_LEAD)
            .eq('school_id', schoolId)
            .is('trial_slot_id', null)
            .in('status', ['new', 'contacted'])
            .gte('created_at', desdeLeads)
            .order('created_at', { ascending: false })
            .limit(200),
        supabase.from('whatsapp_conversations')
            .select('id, contact_wa_id')
            .eq('school_id', schoolId)
            .order('last_message_at', { ascending: false })
            .limit(1000),
    ]);
    if (conSlot.error) throw new Error(conSlot.error.message);

    const convPorTel = new Map<string, string>();
    for (const c of (convs.data ?? []) as any[]) {
        for (const v of variantesTelefono(c.contact_wa_id)) if (!convPorTel.has(v)) convPorTel.set(v, c.id);
    }

    const reservas = ((conSlot.data ?? []) as any[])
        .map((r) => aReserva(r, hoy, convPorTel))
        .filter((r): r is ReservaCortesia => !!r)
        .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio));

    const sinAgendar: LeadSinAgendar[] = ((sinSlot.data ?? []) as any[]).map((r) => {
        const edad = edadDeLead(r.birth_date, r.notes, hoy);
        return {
            leadId: r.id,
            nombre: r.full_name,
            telefono: r.phone ?? null,
            waMe: enlaceWaMe(r.phone),
            edad,
            paraQuien: paraQuien(edad, r.guardian_name),
            estado: r.status,
            origen: origenDe(r),
            conversationId: r.source_detail?.conversation_id ?? conversacionPorTelefono(r.phone, convPorTel),
            creadoEn: r.created_at,
            cancelada: /cancelada/i.test(String(r.notes ?? '')),
        };
    });

    return { reservas, sinAgendar };
}

// ─── Asistencia ─────────────────────────────────────────────────────────────

/**
 * «Asistió / no vino» (o null para desmarcar). Se guarda en
 * `source_detail.asistencia` conservando el resto del jsonb. Filtrado por
 * `school_id`: un lead de otra escuela devuelve 'no_encontrado'.
 */
export async function marcarAsistencia(
    schoolId: string, leadId: string, asistencia: Asistencia | null, porUsuario: string,
): Promise<'ok' | 'no_encontrado' | 'sin_reserva'> {
    const { data: lead, error } = await supabase.from('school_signup_leads')
        .select('id, source_detail, trial_slot_id')
        .eq('id', leadId).eq('school_id', schoolId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!lead) return 'no_encontrado';
    if (!(lead as any).trial_slot_id) return 'sin_reserva';
    const detalle = { ...((lead as any).source_detail ?? {}) };
    if (asistencia) {
        detalle.asistencia = asistencia;
        detalle.asistencia_at = new Date().toISOString();
        detalle.asistencia_por = porUsuario;
    } else {
        delete detalle.asistencia; delete detalle.asistencia_at; delete detalle.asistencia_por;
    }
    const { error: e2 } = await supabase.from('school_signup_leads')
        .update({ source_detail: detalle, updated_at: new Date().toISOString() })
        .eq('id', leadId).eq('school_id', schoolId);
    if (e2) throw new Error(e2.message);
    return 'ok';
}

// ─── Aviso inmediato a la escuela ───────────────────────────────────────────

const TITULO: Record<TipoAvisoCortesia, string> = {
    reservada: 'Nueva clase de cortesía agendada',
    datos: 'Un prospecto dejó sus datos para una clase de cortesía',
    cancelada: 'Clase de cortesía cancelada',
    cancelacion_pedida: 'Piden cancelar una clase de cortesía',
    no_reservada: 'Clase de cortesía por confirmar',
    llegada: 'Llegó un prospecto a su clase de cortesía',
};

const ACCION: Record<TipoAvisoCortesia, string> = {
    reservada: 'Quedó en la pestaña «Clases de cortesía» de WhatsApp.',
    datos: 'No eligió horario: escríbele para agendarla.',
    cancelada: 'El cupo quedó libre.',
    cancelacion_pedida: 'Cancélala y libera el cupo; el asistente le dijo que le confirmarían.',
    no_reservada: 'El asistente no pudo tomar el cupo: confírmale el horario por WhatsApp.',
    llegada: 'Ya está en la sede: que alguien lo reciba.',
};

export interface ContenidoAviso {
    titulo: string;
    cuerpo: string;
    lineas: string[];
    urlChat: string;
    urlCortesias: string;
    waMe: string | null;
}

function frontend(): string {
    return (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');
}

/**
 * Todo lo que dice el aviso. Pura: se prueba sin base. `nombreClase`: el de la
 * escuela (B3, «clase de prueba»); por defecto, los títulos de siempre.
 */
export function contenidoAviso(a: AvisoCortesia, contacto: string | null = null, nombreClase = 'clase de cortesía'): ContenidoAviso {
    const titulo = nombreClase === 'clase de cortesía' ? TITULO[a.tipo]
        : TITULO[a.tipo].replace(/clase de cortesía/g, nombreClase).replace(/Clase de cortesía/g, nombreClase[0].toUpperCase() + nombreClase.slice(1));
    const nombre = a.nombre?.trim() || contacto?.trim() || 'Un prospecto';
    const edad = typeof a.edad === 'number' ? a.edad : null;
    const quien = paraQuien(edad, a.acudiente);
    const f = a.franja ?? null;
    const cuando = f
        ? `${fechaLarga(f.fecha)}, ${hora12(f.horaInicio)}${f.horaFin ? ` a ${hora12(f.horaFin)}` : ''}`
        : 'Sin horario: contáctalo para agendar';
    const waMe = enlaceWaMe(a.contactWaId);
    const urlChat = `${frontend()}/whatsapp?tab=conversaciones&conversacion=${encodeURIComponent(a.conversationId)}`;
    const urlCortesias = `${frontend()}/whatsapp?tab=cortesias`;
    const lineas = [
        `Nombre: ${nombre}`,
        ...(contacto && contacto.trim() && contacto.trim() !== nombre ? [`Quien escribe: ${contacto.trim()}`] : []),
        `Para quién: ${quien}`,
        `Teléfono: +${String(a.contactWaId).replace(/\D/g, '')}${waMe ? ` — ${waMe}` : ''}`,
        ...(f ? [`Grupo: ${f.grupo}`] : []),
        `Día y hora: ${cuando}`,
        ...(f?.sede ? [`Sede: ${f.sede}`] : []),
        ACCION[a.tipo],
        `Chat: ${urlChat}`,
    ];
    const cuerpo = `${nombre} — ${f ? `${f.grupo}, ${fechaLarga(f.fecha)} ${hora12(f.horaInicio)}` : 'sin horario'}. ${ACCION[a.tipo]}`;
    return { titulo, cuerpo, lineas, urlChat, urlCortesias, waMe };
}

/** Clave del evento: la misma para los tres BFF. */
export function claveAviso(a: AvisoCortesia): string {
    return `wa_clase_cortesia:${a.tipo}:${a.leadId ?? a.conversationId}:${a.franja?.id ?? 'sin'}`;
}

async function destinatariosIds(schoolId: string): Promise<string[]> {
    const [{ data: escuela }, { data: miembros }] = await Promise.all([
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('profile_id')
            .eq('school_id', schoolId).eq('status', 'active')
            .in('role', ['owner', 'admin', 'school_admin']),
    ]);
    const ids = new Set<string>();
    for (const m of (miembros ?? []) as any[]) if (m.profile_id) ids.add(m.profile_id);
    if ((escuela as any)?.owner_id) ids.add((escuela as any).owner_id);
    return [...ids];
}

/**
 * In-app + push + correo a owner/admins. Nunca lanza: una falla acá no puede
 * dejar a la familia sin respuesta. Devuelve cuántos in-app entraron (pruebas).
 */
export async function avisarCortesia(a: AvisoCortesia): Promise<{ inApp: number; push: number; correo: string }> {
    const salida = { inApp: 0, push: 0, correo: 'no' };
    try {
        const { data: conv } = await supabase.from('whatsapp_conversations')
            .select('contact_name').eq('id', a.conversationId).maybeSingle();
        const { textosClaseDeEscuela } = await import('./textos-clase-prueba');
        const c = contenidoAviso(a, (conv as any)?.contact_name ?? null, (await textosClaseDeEscuela(a.schoolId)).nombre);
        const clave = claveAviso(a);
        const ids = await destinatariosIds(a.schoolId);
        // Canal de plataforma (WhatsApp personal de la dueña con opt-in). Flag apagado = nada.
        avisarCortesiaPorPlataforma({ schoolId: a.schoolId, clave, titulo: c.titulo, cuerpo: c.cuerpo });

        await Promise.allSettled(ids.map(async (uid) => {
            const { error } = await supabase.from('notifications').insert({
                id: uuidDeClave(`${clave}:${uid}`),
                user_id: uid,
                school_id: a.schoolId,
                title: c.titulo,
                message: c.lineas.filter((l) => !l.startsWith('Chat: ')).join('\n'),
                type: a.tipo === 'reservada' ? 'success' : 'info',
                category: 'enrollment',
                link: '/whatsapp?tab=cortesias',
                data: {
                    tipo: 'whatsapp_clase_cortesia', evento: a.tipo, school_id: a.schoolId,
                    conversation_id: a.conversationId, lead_id: a.leadId ?? null, wa_me: c.waMe,
                },
            });
            // 23505 = otro BFF ya avisó a este usuario por este evento: no se repite el push.
            if (error && (error as any).code === '23505') return;
            if (error) console.warn('[cortesia-aviso] in-app no entró; se empuja igual', { err: error.message });
            else salida.inApp++;
            const r = await sendToUser(uid, {
                title: c.titulo,
                body: c.cuerpo,
                data: { tipo: 'whatsapp_clase_cortesia', conversation_id: a.conversationId, school_id: a.schoolId, link: '/whatsapp?tab=cortesias' },
            }).catch(() => null);
            if (r && r.sent > 0) salida.push++;
        }));

        // La llegada es para ESTE momento: push e in-app; un correo llega tarde.
        const { escuela, correos } = a.tipo === 'llegada'
            ? { escuela: '', correos: [] as string[] }
            : await destinatariosDeEscuela(a.schoolId);
        if (correos.length) {
            salida.correo = await enviarConReserva({
                clave,
                tipo: 'wa_clase_cortesia',
                schoolId: a.schoolId,
                refId: a.conversationId,
                destinos: correos,
                data: { schoolName: escuela, titulo: c.titulo, lineasJson: JSON.stringify(c.lineas), url: c.urlChat },
                respaldo: {
                    subject: `${c.titulo} — ${escuela}`,
                    titulo: c.titulo,
                    lineas: [...c.lineas, `Todas las clases de cortesía: ${c.urlCortesias}`],
                    enlace: { url: c.urlChat, texto: 'Abrir el chat en SportMaps' },
                },
            });
        }
    } catch (e: any) {
        console.warn('[cortesia-aviso] no se pudo avisar a la escuela', { err: e?.message });
    }
    return salida;
}
