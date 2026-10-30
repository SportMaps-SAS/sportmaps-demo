/**
 * prospecto-ciclo-clase.service — cerrar el ciclo de la clase de cortesía
 * (embudo de prospectos de Dynasty, 2026-10-08).
 *
 * 24 prospectos → 3 reservas → 0 inscripciones registradas. Después de la
 * reserva no pasaba nada medible: una familia escribió «Hola llegamos, ¿a quién
 * le avisamos?», el bot contestó «ya le pasé tu mensaje» y nadie respondió; no
 * había asistencia, ni seguimiento, ni el lead avanzaba. Tres piezas:
 *
 *   1. LLEGADA. «llegué / llegamos / ya estamos aquí» el DÍA de su clase →
 *      una línea de bienvenida (+ qué llevar / a quién buscar, del ajuste de la
 *      escuela `wa_cortesia_indicaciones`), aviso in-app + push a owner/admins
 *      (`avisarCortesia` tipo 'llegada', idempotente por clave) y el lead pasa
 *      a «asistio».
 *   2. SEGUIMIENTO de la noche, 20:00 COT del día de la clase: «¿Cómo le fue?»
 *      + el enlace de inscripción (/join de la escuela), SOLO con la ventana de
 *      24 h abierta (no hay plantilla aprobada para esto: sin ventana, nada).
 *      Uno por reserva entre los 3 BFF: se reclama con un UPDATE condicional
 *      sobre `source_detail.seguimiento_clase_at` (el que lo logra, manda).
 *   3. INSCRIPCIÓN. Un lead agendado / que asistió cuyo teléfono (o correo)
 *      aparece en una inscripción NUEVA de esa escuela pasa a «inscrito»
 *      (`status = converted`, `converted_enrollment_id`).
 *
 * Nada de esto pide el correo: después de reservar no se le pide nada más.
 * Nunca lanza.
 */
import { supabase } from '../config/supabase';
import type { WhatsAppIntegration } from './whatsapp.service';
import {
    avanzarEtapaLead, etapaDeLead, variantesTelefonoLead, type EtapaLead,
} from './whatsapp-prospecto-lead.service';
import { ahoraBogota, minutosDeHora, nombresDelLead } from './recordatorio-cortesia.service';

// ─── 1. Llegada ──────────────────────────────────────────────────────────────

function normalizar(texto: string | null | undefined): string {
    return String(texto ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[¡!¿?.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const LLEGADA: RegExp[] = [
    /\b(ya )?(llegue|llegamos|llego|llegaron)\b/,
    /\bya (estamos|estoy|esta|estan) (aqui|aca|afuera|abajo|en la (sede|cancha|entrada|porteria|puerta|recepcion|coliseo))\b/,
    /\b(estamos|estoy) (aqui|aca) (afuera|abajo|en la (sede|cancha|entrada|porteria|puerta|recepcion))\b/,
    /\b(estamos|estoy) en la (entrada|porteria|puerta|recepcion)\b/,
];
const NO_LLEGADA: RegExp[] = [
    /\bno (he |hemos )?(llegue|llegamos|llego|llegaron|alcanz\w*)\b/,
    /\b(todavia|aun) no\b/,
    /\b(vamos|voy|van) a llegar\b/,
    /\b(llegamos|llego|llegue) (tarde|en|a las|como|mas)\b/,
    /\bcuando llego|como llego|a que hora llego|si llegamos|cuando llegue|cuando lleguemos\b/,
];

/** ¿Avisa que ya está en la sede? «Hola llegamos», «ya estamos aquí». Pura. */
export function esLlegada(texto: string | null | undefined): boolean {
    const t = normalizar(texto);
    if (!t || t.length > 160) return false;
    if (NO_LLEGADA.some((re) => re.test(t))) return false;
    return LLEGADA.some((re) => re.test(t));
}

/** La respuesta: una línea + lo que la escuela configuró. Pura. */
export function textoBienvenidaLlegada(indicaciones: string | null | undefined): string {
    const ind = String(indicaciones ?? '').trim();
    return '¡Bienvenidos! Ya le aviso a la escuela 🙌' + (ind ? `\n\n${ind}` : '');
}

export interface ReservaDeHoy {
    leadId: string;
    nombre: string | null;
    franja: import('./whatsapp-clase-cortesia.service').FranjaCortesia;
    /** source_detail.llegada_at si ya se registró la llegada. */
    llegadaAt: string | null;
}

export interface DepsLlegada {
    reservaDeHoy: (schoolId: string, contactWaId: string, hoyIso: string) => Promise<ReservaDeHoy | null>;
    indicaciones: (schoolId: string) => Promise<string | null>;
    marcarAsistio: (leadId: string, extra: Record<string, unknown>) => Promise<unknown>;
    avisar: (a: import('./whatsapp-clase-cortesia.service').AvisoCortesia) => Promise<void>;
    ahora: () => Date;
}

const DEPS_LLEGADA: DepsLlegada = {
    async reservaDeHoy(schoolId, contactWaId, hoyIso) {
        const variantes = variantesTelefonoLead(contactWaId);
        if (!variantes.length) return null;
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, full_name, source_detail, status, school_trial_slots!inner(id, label, slot_date, start_time, end_time, location)')
            .eq('school_id', schoolId)
            .in('phone', variantes)
            .in('status', ['new', 'contacted', 'converted'])
            .eq('school_trial_slots.slot_date', hoyIso)
            .order('created_at', { ascending: false })
            .limit(3);
        if (error || !Array.isArray(data)) return null;
        for (const l of data as any[]) {
            const s = Array.isArray(l.school_trial_slots) ? l.school_trial_slots[0] : l.school_trial_slots;
            if (!s || String(s.slot_date).slice(0, 10) !== hoyIso) continue;
            return {
                leadId: l.id,
                nombre: l.full_name ?? null,
                llegadaAt: l.source_detail?.llegada_at ?? null,
                franja: {
                    id: s.id, grupo: s.label ?? 'Clase de cortesía', fecha: hoyIso,
                    horaInicio: String(s.start_time).slice(0, 5), horaFin: s.end_time ? String(s.end_time).slice(0, 5) : null,
                    sede: s.location ?? null, cupos: 0,
                },
            };
        }
        return null;
    },
    async indicaciones(schoolId) {
        const { indicacionesCortesiaDeEscuela } = await import('./whatsapp-ajustes-escuela.service');
        return indicacionesCortesiaDeEscuela(schoolId);
    },
    marcarAsistio: (leadId, extra) => avanzarEtapaLead(leadId, 'asistio', extra),
    async avisar(a) {
        const { avisarCortesia } = await import('./cortesia-reservas.service');
        await avisarCortesia(a);
    },
    ahora: () => new Date(),
};

export interface ParamsLlegada {
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    texto: string;
    /** Manda la respuesta (el bot: `deliver` con su step). */
    responder: (texto: string) => Promise<void>;
}

/**
 * Si el mensaje es una llegada y ese número tiene clase HOY: responde, avisa a
 * la escuela y mueve el lead a «asistio». true = el turno quedó atendido.
 * La segunda llegada del mismo día no se contesta igual (false: sigue el flujo
 * normal, que la manda al buzón). Nunca lanza.
 */
export async function atenderLlegada(p: ParamsLlegada, deps: Partial<DepsLlegada> = {}): Promise<boolean> {
    const d: DepsLlegada = { ...DEPS_LLEGADA, ...deps };
    try {
        if (!esLlegada(p.texto)) return false;
        const ahora = d.ahora();
        const hoy = ahoraBogota(ahora).iso;
        const reserva = await d.reservaDeHoy(p.schoolId, p.contactWaId, hoy);
        if (!reserva) return false;
        if (reserva.llegadaAt && ahoraBogota(new Date(reserva.llegadaAt)).iso === hoy) return false;

        const indicaciones = await d.indicaciones(p.schoolId).catch(() => null);
        await p.responder(textoBienvenidaLlegada(indicaciones));
        await d.marcarAsistio(reserva.leadId, { llegada_at: ahora.toISOString() });
        await d.avisar({
            tipo: 'llegada', schoolId: p.schoolId, conversationId: p.conversationId, contactWaId: p.contactWaId,
            leadId: reserva.leadId, nombre: reserva.nombre, franja: reserva.franja,
        });
        return true;
    } catch (e: any) {
        console.warn('[prospecto-ciclo] la llegada falló', { conversationId: p.conversationId, err: e?.message });
        return false;
    }
}

// ─── 2. Seguimiento de la noche ──────────────────────────────────────────────

/** Ventana del job (COT): de 20:00 a 21:59; los ticks después de las 20:00 recogen un BFF dormido. */
export const SEGUIMIENTO_DESDE_MIN = 20 * 60;
export const SEGUIMIENTO_HASTA_MIN = 22 * 60;
/** La clase tiene que haber terminado (sin hora de fin: 60 min después del inicio). */
const DURACION_POR_DEFECTO_MIN = 60;

export function claseTerminada(horaInicio: string, horaFin: string | null, ahoraMin: number): boolean {
    const fin = horaFin ? minutosDeHora(horaFin) : minutosDeHora(horaInicio) + DURACION_POR_DEFECTO_MIN;
    return Number.isFinite(fin) && ahoraMin >= fin;
}

/** «¿Cómo le fue?» + el enlace de inscripción. Pura. */
export function textoSeguimientoClase(a: {
    saludo: string; atleta: string | null; esAcudiente: boolean; enlace: string | null; asistio: boolean;
    /** Nombre de la clase de la escuela (B3, textos-clase-prueba). Por defecto, «clase de cortesía». */
    nombreClase?: string;
}): string {
    const clase = a.nombreClase || 'clase de cortesía';
    const pregunta = a.esAcudiente && a.atleta
        ? `¿Cómo le fue a *${a.atleta}* en la ${clase} de hoy?`
        : `¿Cómo te fue en la ${clase} de hoy?`;
    const cierre = a.enlace
        ? `Si quieren seguir entrenando con nosotros, aquí pueden hacer la inscripción: ${a.enlace}`
        : 'Si quieren seguir entrenando con nosotros, respóndeme por aquí y la escuela les ayuda con la inscripción.';
    const saludo = a.saludo && a.saludo !== 'hola' ? `Hola ${a.saludo} 👋` : 'Hola 👋';
    return `${saludo} ${pregunta}${a.asistio ? ' Gracias por venir 🙌' : ''}\n\n${cierre}`;
}

export interface ReservaParaSeguimiento {
    leadId: string;
    schoolId: string;
    nombre: string | null;
    acudiente: string | null;
    telefono: string | null;
    etapa: EtapaLead;
    sourceDetail: Record<string, any>;
    slot: { id: string; slot_date: string; start_time: string; end_time: string | null };
}

export interface ResumenSeguimiento { candidatas: number; enviados: number; omitidos: number; fallidos: number }

export interface DepsSeguimiento {
    reservasDelDia: (fecha: string) => Promise<ReservaParaSeguimiento[]>;
    integracion: (schoolId: string) => Promise<WhatsAppIntegration | null>;
    conversacion: (integrationId: string, waId: string) => Promise<{ id: string; last_inbound_at: string | null } | null>;
    botEncendido: (integrationId: string) => Promise<boolean>;
    tomada: (conversationId: string) => Promise<boolean>;
    dadoDeBaja: (integrationId: string, waId: string) => Promise<boolean>;
    /** Lo que escribió el contacto en las últimas 24 h (para no preguntarle «¿cómo te fue?» a quien canceló). */
    entrantesDelDia: (conversationId: string) => Promise<string[]>;
    enlace: (schoolId: string) => Promise<string | null>;
    /** Nombre de la clase de la escuela («clase de cortesía» | «clase de prueba»). */
    nombreClase?: (schoolId: string) => Promise<string>;
    /** true = este BFF lo tomó (nadie lo había mandado). */
    reclamar: (r: ReservaParaSeguimiento, iso: string) => Promise<boolean>;
    /** Devuelve el reclamo si el envío falló (otro tick lo intenta). */
    soltar: (r: ReservaParaSeguimiento) => Promise<void>;
    /** true = salió (o quedó de borrador en modo asistido). */
    enviar: (integ: WhatsAppIntegration, conversationId: string, waId: string, texto: string, payload: Record<string, unknown>) => Promise<boolean>;
}

export const PASO_SEGUIMIENTO_CLASE = 'cortesia_seguimiento_noche';

const DEPS_SEGUIMIENTO: DepsSeguimiento = {
    async reservasDelDia(fecha) {
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, school_id, full_name, guardian_name, phone, status, trial_slot_id, source_detail, '
                + 'school_trial_slots!inner(id, slot_date, start_time, end_time)')
            .not('trial_slot_id', 'is', null)
            .in('status', ['new', 'contacted'])
            .eq('school_trial_slots.slot_date', fecha)
            .limit(1000);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).flatMap((l) => {
            const s = Array.isArray(l.school_trial_slots) ? l.school_trial_slots[0] : l.school_trial_slots;
            if (!s || String(s.slot_date).slice(0, 10) !== fecha) return [];
            return [{
                leadId: l.id, schoolId: l.school_id, nombre: l.full_name ?? null, acudiente: l.guardian_name ?? null,
                telefono: l.phone ?? null, etapa: etapaDeLead(l), sourceDetail: l.source_detail ?? {},
                slot: {
                    id: s.id, slot_date: String(s.slot_date).slice(0, 10), start_time: String(s.start_time).slice(0, 5),
                    end_time: s.end_time ? String(s.end_time).slice(0, 5) : null,
                },
            }];
        });
    },
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
    async botEncendido(integrationId) {
        const { botEncendido } = await import('./whatsapp-atencion.service');
        return botEncendido(integrationId);
    },
    async tomada(conversationId) {
        const { conversacionTomada } = await import('./whatsapp-tomada.service');
        return conversacionTomada(conversationId);
    },
    async dadoDeBaja(integrationId, waId) {
        const { estaDadoDeBaja } = await import('./whatsapp-optin.service');
        return estaDadoDeBaja(integrationId, waId);
    },
    async entrantesDelDia(conversationId) {
        const { data } = await supabase.from('whatsapp_messages')
            .select('text_body')
            .eq('conversation_id', conversationId).eq('direction', 'inbound')
            .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
            .limit(40);
        return ((data as any[]) ?? []).map((m) => String(m.text_body ?? '')).filter(Boolean);
    },
    async enlace(schoolId) {
        const { enlaceDeInscripcion } = await import('./whatsapp-bot.service');
        return enlaceDeInscripcion(schoolId);
    },
    async nombreClase(schoolId) {
        const { textosClaseDeEscuela } = await import('./textos-clase-prueba');
        return (await textosClaseDeEscuela(schoolId)).nombre;
    },
    async reclamar(r, iso) {
        // UPDATE condicional: entre los 3 BFF, solo uno encuentra la marca vacía.
        const { data, error } = await supabase.from('school_signup_leads')
            .update({ source_detail: { ...r.sourceDetail, seguimiento_clase_at: iso, seguimiento_clase_slot: r.slot.id } })
            .eq('id', r.leadId)
            .is('source_detail->>seguimiento_clase_at', null)
            .select('id');
        return !error && Array.isArray(data) && data.length === 1;
    },
    async soltar(r) {
        await supabase.from('school_signup_leads')
            .update({ source_detail: { ...r.sourceDetail } })
            .eq('id', r.leadId);
    },
    async enviar(integ, conversationId, waId, texto, payload) {
        const { deliver } = await import('./whatsapp-bot.service');
        await deliver(integ, conversationId, waId, texto, payload);
        return true;
    },
};

/**
 * Corre cada 15 min de 20:00 a 21:45 COT. Reservas de HOY ya terminadas, con
 * la ventana de 24 h abierta, sin seguimiento previo. Nunca lanza.
 */
export async function runSeguimientoNocheCortesia(
    opciones: { ahora?: Date; deps?: Partial<DepsSeguimiento> } = {},
): Promise<ResumenSeguimiento> {
    const d: DepsSeguimiento = { ...DEPS_SEGUIMIENTO, ...(opciones.deps ?? {}) };
    const ahora = opciones.ahora ?? new Date();
    const hoy = ahoraBogota(ahora);
    const resumen: ResumenSeguimiento = { candidatas: 0, enviados: 0, omitidos: 0, fallidos: 0 };
    if (hoy.minutos < SEGUIMIENTO_DESDE_MIN || hoy.minutos >= SEGUIMIENTO_HASTA_MIN) return resumen;

    const { aWaId, ventanaAbierta } = await import('./whatsapp-plantillas.service');
    let reservas: ReservaParaSeguimiento[] = [];
    try { reservas = await d.reservasDelDia(hoy.iso); } catch { return resumen; }
    reservas = reservas.filter((r) => !r.sourceDetail?.seguimiento_clase_at
        && claseTerminada(r.slot.start_time, r.slot.end_time, hoy.minutos));
    resumen.candidatas = reservas.length;

    const integraciones = new Map<string, WhatsAppIntegration | null>();
    for (const r of reservas) {
        try {
            const waId = aWaId(r.telefono);
            if (!waId) { resumen.omitidos++; continue; }
            if (!integraciones.has(r.schoolId)) integraciones.set(r.schoolId, await d.integracion(r.schoolId));
            const integ = integraciones.get(r.schoolId);
            if (!integ) { resumen.omitidos++; continue; }
            const conv = await d.conversacion(integ.id, waId);
            // Sin ventana no hay plantilla aprobada para esto: nada.
            if (!conv || !ventanaAbierta(conv.last_inbound_at, ahora.getTime())) { resumen.omitidos++; continue; }
            if (!(await d.botEncendido(integ.id)) || await d.tomada(conv.id) || await d.dadoDeBaja(integ.id, waId)) {
                resumen.omitidos++; continue;
            }
            // …0683 (2026-10-22): «voy a cancelar la clase» / «No me da tiempo de ir»
            // y esa noche le llegó «¿Cómo le fue en la clase?».
            if ((await d.entrantesDelDia(conv.id).catch(() => [] as string[])).some(avisaQueNoVa)) {
                resumen.omitidos++; continue;
            }
            if (!(await d.reclamar(r, ahora.toISOString()))) { resumen.omitidos++; continue; }

            const { saludo, atleta } = nombresDelLead({ full_name: r.nombre, guardian_name: r.acudiente });
            const texto = textoSeguimientoClase({
                saludo, atleta, esAcudiente: !!r.acudiente, enlace: await d.enlace(r.schoolId).catch(() => null),
                asistio: r.etapa === 'asistio',
                nombreClase: d.nombreClase ? await d.nombreClase(r.schoolId).catch(() => undefined) : undefined,
            });
            const env = await d.enviar(integ, conv.id, waId, texto, {
                step: PASO_SEGUIMIENTO_CLASE, lead_id: r.leadId, trial_slot_id: r.slot.id,
            });
            if (env) resumen.enviados++;
            else { resumen.fallidos++; await d.soltar(r).catch(() => undefined); }
        } catch (e: any) {
            resumen.fallidos++;
            console.warn('[prospecto-ciclo] seguimiento de la noche falló', { leadId: r.leadId, err: e?.message });
        }
    }
    return resumen;
}

/** ¿El texto dice que no va a ir a la clase? Pura. */
export function avisaQueNoVa(texto: string): boolean {
    const n = texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    return /\bcancel\w*|\bno (me|nos) da (el )?tiempo\b|\bno (voy|vamos|puedo|podemos|alcanzo|alcanzamos) (a )?(ir|asistir|llegar)\b|\bno (vamos|voy) a poder\b|\bno podre(mos)?\b/.test(n);
}

// ─── 3. Inscripción con el mismo teléfono o correo ───────────────────────────

/** Leads abiertos de WhatsApp de los últimos N días que se revisan contra las inscripciones. */
const DIAS_CRUCE = 45;

export interface LeadParaCruce {
    id: string; school_id: string; phone: string | null; email: string | null; created_at: string;
}

/** ¿La inscripción es de este lead? Pura (el cruce de ids lo arma quien llama). */
export function inscripcionDelLead(
    lead: LeadParaCruce,
    perfilesDelLead: Set<string>,
    inscripciones: { id: string; school_id: string; user_id: string | null; child_id: string | null; created_at: string }[],
    padreDeHijo: Map<string, string>,
): string | null {
    const desde = new Date(lead.created_at).getTime();
    const e = inscripciones.find((x) => x.school_id === lead.school_id
        && new Date(x.created_at).getTime() >= desde
        && ((x.user_id && perfilesDelLead.has(x.user_id))
            || (x.child_id && perfilesDelLead.has(padreDeHijo.get(x.child_id) ?? ''))));
    return e?.id ?? null;
}

/**
 * Marca «inscrito» a los leads de WhatsApp (respondidos, agendados o que
 * asistieron) cuyo teléfono o correo ya tiene una inscripción NUEVA en esa
 * escuela, propia o de un hijo. Idempotente: solo toca filas new/contacted.
 */
export async function detectarInscripcionesDeLeads(ahora: Date = new Date()): Promise<number> {
    try {
        const desde = new Date(ahora.getTime() - DIAS_CRUCE * 86400_000).toISOString();
        const { data: leads, error } = await supabase.from('school_signup_leads')
            .select('id, school_id, phone, email, created_at, status, trial_slot_id, source_detail')
            .eq('how_heard', 'whatsapp')
            .in('status', ['new', 'contacted'])
            .gte('created_at', desde)
            .limit(500);
        if (error || !Array.isArray(leads) || !leads.length) return 0;
        const lista = (leads as any[]).filter((l) => l.status === 'contacted' || l.trial_slot_id) as LeadParaCruce[];
        if (!lista.length) return 0;

        const variantesDe = new Map<string, string[]>(lista.map((l) => [l.id, variantesTelefonoLead(l.phone ?? '')]));
        const telefonos = [...new Set([...variantesDe.values()].flat())];
        const correos = [...new Set(lista.map((l) => (l.email || '').trim().toLowerCase()).filter(Boolean))];
        const perfiles: { id: string; phone: string | null; email: string | null }[] = [];
        for (let i = 0; i < telefonos.length; i += 200) {
            const { data } = await supabase.from('profiles').select('id, phone, email').in('phone', telefonos.slice(i, i + 200));
            perfiles.push(...((data as any[]) ?? []));
        }
        if (correos.length) {
            const { data } = await supabase.from('profiles').select('id, phone, email').in('email', correos.slice(0, 200));
            perfiles.push(...((data as any[]) ?? []));
        }
        if (!perfiles.length) return 0;

        const perfilesDe = new Map<string, Set<string>>();
        for (const l of lista) {
            const vars = variantesDe.get(l.id) ?? [];
            const correo = (l.email || '').trim().toLowerCase();
            perfilesDe.set(l.id, new Set(perfiles
                .filter((p) => (p.phone && vars.includes(p.phone)) || (correo && (p.email || '').toLowerCase() === correo))
                .map((p) => p.id)));
        }
        const ids = [...new Set(perfiles.map((p) => p.id))].slice(0, 300);
        const { data: hijos } = await supabase.from('children').select('id, parent_id').in('parent_id', ids);
        const padreDeHijo = new Map<string, string>(((hijos as any[]) ?? []).map((h) => [h.id, h.parent_id]));
        const escuelas = [...new Set(lista.map((l) => l.school_id))];
        const [{ data: propias }, { data: deHijos }] = await Promise.all([
            supabase.from('enrollments').select('id, school_id, user_id, child_id, created_at')
                .in('school_id', escuelas).in('user_id', ids).gte('created_at', desde),
            padreDeHijo.size
                ? supabase.from('enrollments').select('id, school_id, user_id, child_id, created_at')
                    .in('school_id', escuelas).in('child_id', [...padreDeHijo.keys()].slice(0, 300)).gte('created_at', desde)
                : Promise.resolve({ data: [] as any[] }),
        ]);
        const inscripciones = [...((propias as any[]) ?? []), ...((deHijos as any[]) ?? [])];

        let marcados = 0;
        for (const l of lista) {
            const enrollmentId = inscripcionDelLead(l, perfilesDe.get(l.id) ?? new Set(), inscripciones, padreDeHijo);
            if (!enrollmentId) continue;
            const etapa = await avanzarEtapaLead(l.id, 'inscrito', { inscrito_enrollment_id: enrollmentId }, ahora);
            if (etapa === 'inscrito') {
                await supabase.from('school_signup_leads').update({ converted_enrollment_id: enrollmentId })
                    .eq('id', l.id).is('converted_enrollment_id', null);
                marcados++;
            }
        }
        return marcados;
    } catch (e: any) {
        console.warn('[prospecto-ciclo] cruce de inscripciones falló', { err: e?.message });
        return 0;
    }
}

// ─── 4. Después de reservar no se pide el correo ─────────────────────────────

/** Días hacia atrás en que una clase reservada todavía cuenta (la noche del seguimiento, la inscripción). */
const DIAS_RESERVA_RECIENTE = 14;

/**
 * ¿Este número tiene una clase de cortesía reservada (futura o de los últimos
 * 14 días) en la escuela? Entonces es un prospecto ya atendido: «escríbeme tu
 * correo» después de reservar (Dynasty 2026-10-07, a un «Gracias») sobra.
 * Nunca lanza (false).
 */
export async function yaReservoClase(schoolId: string, contactWaId: string, ahora: Date = new Date()): Promise<boolean> {
    try {
        const variantes = variantesTelefonoLead(contactWaId);
        if (!variantes.length) return false;
        const desde = ahoraBogota(new Date(ahora.getTime() - DIAS_RESERVA_RECIENTE * 86400_000)).iso;
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, school_trial_slots!inner(slot_date)')
            .eq('school_id', schoolId)
            .in('phone', variantes)
            .neq('status', 'discarded')
            .gte('school_trial_slots.slot_date', desde)
            .limit(1);
        return !error && Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}
