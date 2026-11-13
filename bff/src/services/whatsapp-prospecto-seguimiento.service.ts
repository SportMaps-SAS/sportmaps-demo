/**
 * Seguimiento de ~20 h al interesado que dejó de escribir (auditoría
 * 2026-10-28, decisión del usuario 2026-10-29: «mixto, sin marketing»).
 *
 * Embudo de Dynasty en 14 días: 41 interesados → 1 inscrito. La mayoría pregunta,
 * recibe horarios o precios y no vuelve. Antes de que se cierre la ventana de
 * 24 h de Meta (después solo se puede escribir con plantilla, y una plantilla
 * de «¿te ayudo a agendar?» es MARKETING: 3× más cara y con otro consentimiento),
 * le llega UN mensaje corto que retoma lo último que preguntó. Lo redacta el
 * modelo con la ficha y el tono de la escuela (whatsapp-prospecto-ia), así que
 * solo corre en escuelas con ficha.
 *
 * Reglas:
 *  - Una vez por interesado (marca `source_detail.seguimiento_20h_at`, reclamada
 *    con UPDATE condicional: entre los BFF solo uno la toma).
 *  - Solo si no reservó clase, no está inscrito ni descartado, y su último
 *    mensaje fue hace 18–22 h (la ventana sigue abierta).
 *  - Nunca si la escuela le escribió después (una persona está atendiendo), si
 *    la conversación está tomada, el bot apagado o el número dado de baja.
 *  - De 8:00 a 20:00 hora de Colombia: a nadie le llega un mensaje de la
 *    escuela de madrugada.
 *  - Solo en el BFF que recibe el webhook (mismo interruptor que la cola).
 *
 * Nunca lanza.
 */
import { supabase } from '../config/supabase';
import type { WhatsAppIntegration } from './whatsapp.service';
import type { FilaReciente } from './whatsapp-reglas-turno';

export const PASO_SEGUIMIENTO_20H = 'prospecto_seguimiento_20h';
export const DESDE_H = 18;
export const HASTA_H = 22;
const HORA_INICIO = 8;
const HORA_FIN = 20;

export interface LeadCandidato {
    id: string;
    schoolId: string;
    conversationId: string;
    sourceDetail: Record<string, any>;
}

export interface ConversacionDelLead {
    id: string;
    integrationId: string;
    contactWaId: string;
    lastInboundAt: string | null;
}

const hora = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/** Hora de Bogotá (0–23). Pura. */
export function horaBogota(ahora: Date): number {
    return Number(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false })) % 24;
}

/**
 * ¿Toca el seguimiento? Pura. `recientes` son los mensajes de las últimas 24 h.
 * Motivo en texto para el log cuando no.
 */
export function tocaSeguimiento(
    conv: Pick<ConversacionDelLead, 'lastInboundAt'>,
    recientes: FilaReciente[],
    ahora: Date,
): { toca: boolean; motivo: string } {
    const h = horaBogota(ahora);
    if (h < HORA_INICIO || h >= HORA_FIN) return { toca: false, motivo: 'fuera_de_horario' };
    const ultimo = conv.lastInboundAt ? new Date(conv.lastInboundAt).getTime() : NaN;
    if (Number.isNaN(ultimo)) return { toca: false, motivo: 'sin_entrante' };
    const edadH = (ahora.getTime() - ultimo) / 3600_000;
    if (edadH < DESDE_H || edadH > HASTA_H) return { toca: false, motivo: 'fuera_de_rango' };
    // Una persona de la escuela escribió en la conversación (en las 24 h que se
    // leen): ese interesado lo está atendiendo ella. Antes solo contaba si
    // escribió DESPUÉS del último mensaje del interesado, y …5543 (2026-10-29)
    // recibió «¿Te funciona el sábado a las 11?» cuando Milena ya se lo había
    // propuesto y ella había dicho «Ahh listo».
    const escuelaEscribio = recientes.some((f) => f.direction === 'outbound' && f.ai_generated === false
        && !(f.payload?.automatico === true || f.payload?.automatico === 'true'));
    if (escuelaEscribio) return { toca: false, motivo: 'escuela_atendiendo' };
    if (recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_SEGUIMIENTO_20H)) {
        return { toca: false, motivo: 'ya_enviado' };
    }
    // Ya tiene un cupo SEPARADO o AGENDADO por el embudo (esperando el pago, o confirmado): este seguimiento no le
    // ofrece otra reserva (Monster 2026-11-13, Astolfo Tique: separó Suba el sábado 11–1 y a las 20 h el bot le armó
    // una clase nueva en la sede Norte). Lo atiende la escuela.
    if (tieneCupoDelEmbudo(recientes)) return { toca: false, motivo: 'cupo_separado' };
    return { toca: true, motivo: 'ok' };
}

const PASOS_CON_CUPO = new Set(['embudo_esperando_pago', 'embudo_agendada', 'esperando_pago', 'agendada']);

/** ¿Algún saliente deja ver que el embudo ya separó o agendó una clase? Pura. */
export function tieneCupoDelEmbudo(recientes: FilaReciente[]): boolean {
    return recientes.some((f) => f.direction === 'outbound' && (
        PASOS_CON_CUPO.has(String(f.payload?.step ?? '')) || PASOS_CON_CUPO.has(String(f.payload?.paso_embudo ?? ''))));
}

export interface DepsSeguimiento20h {
    candidatos: () => Promise<LeadCandidato[]>;
    conversacion: (conversationId: string) => Promise<ConversacionDelLead | null>;
    recientes: (conversationId: string) => Promise<FilaReciente[]>;
    puedeHablar: (integrationId: string, conversationId: string, waId: string) => Promise<boolean>;
    /** ¿Hay un cupo separado/agendado por el embudo en los últimos 4 días? (los `recientes` solo cubren 24 h). */
    cupoSeparado?: (conversationId: string) => Promise<boolean>;
    integracion: (integrationId: string) => Promise<WhatsAppIntegration | null>;
    reclamar: (lead: LeadCandidato, iso: string) => Promise<boolean>;
    soltar: (lead: LeadCandidato) => Promise<void>;
    redactar: (integ: WhatsAppIntegration, conversationId: string, recientes: FilaReciente[]) => Promise<string | null>;
    /** `extra` va al payload del saliente (la marca de la venta de un servicio). */
    enviar: (integ: WhatsAppIntegration, conversationId: string, waId: string, texto: string, extra?: Record<string, unknown>,
        botones?: import('./whatsapp-venta-servicio').BotonDeVenta[]) => Promise<void>;
    /**
     * ¿El lead o la conversación están en la VENTA de un servicio? Entonces el
     * seguimiento es determinista y solo del servicio (sin IA ni clase de prueba).
     * null = no es una venta (lo redacta el modelo como siempre); `texto: null` =
     * venta sin nada que recordar (ya mandó el comprobante).
     */
    ventaDelLead: (lead: LeadCandidato, conv: ConversacionDelLead, recientes: FilaReciente[], ahora: Date)
        => Promise<SeguimientoDeVenta | null>;
}

export interface SeguimientoDeVenta { itemId: string; texto: string | null; /** Botones con que sale (Monster 2026-11-09): [Separar mi cupo] o [Ya pagué], y [Hablar con alguien]. */ botones?: import('./whatsapp-venta-servicio').BotonDeVenta[] }

const PALABRA_DE_EVENTO = /cl[ií]nica|torneo|campeonato|vacacional|vacaciones|campamento|copa\b/i;

/**
 * ¿Puede ser la venta de un servicio? El lead guardó un servicio, un saliente trae
 * la marca (venta, ficha, campaña), la escuela pegó un texto largo o el interesado
 * nombró un evento. Si no, ni se lee el catálogo. Pura.
 */
export function pareceVentaDeServicio(lead: Pick<LeadCandidato, 'sourceDetail'>, recientes: FilaReciente[]): boolean {
    if (lead.sourceDetail?.servicio_interes?.id) return true;
    return recientes.some((f) => {
        const p = f.payload ?? {};
        if (f.direction === 'outbound') {
            // `venta_servicio_id` = MARCA_VENTA (literal: este job no carga el catálogo si no hace falta).
            return Boolean(p.venta_servicio_id || p.servicio_id || p.destino_anuncio || p.campana_id
                || p.step === 'campana_respuesta_si' || (f.ai_generated === false && String(f.text_body ?? '').length >= 60));
        }
        return f.direction === 'inbound' && PALABRA_DE_EVENTO.test(String(f.text_body ?? ''));
    });
}

/**
 * El seguimiento de una venta: el servicio del lead (`source_detail.servicio_interes`)
 * o el de la conversación (`ventaActiva` sobre las 24 h), con el precio de hoy y la
 * fecha correcta del tramo. Monster 2026-11-08: el seguimiento redactado por la IA
 * le ofrecía la clase de prueba ($15.000) a interesados de la clínica y decía
 * «la preventa va hasta el 9 de noviembre» (era hasta el 10). Nunca lanza.
 */
export async function seguimientoDeVentaDelLead(
    lead: LeadCandidato, conv: ConversacionDelLead, recientes: FilaReciente[], ahora: Date,
): Promise<SeguimientoDeVenta | null> {
    // Filtro gratis (sin leer el catálogo): ni el lead ni las 24 h tienen señal de venta.
    if (!pareceVentaDeServicio(lead, recientes)) return null;
    try {
        const { serviciosDeAnuncio } = await import('./whatsapp-anuncio-destino');
        const { ventaActiva } = await import('./whatsapp-venta-contexto');
        const { textoSeguimientoDeVenta, tienePrecioDeAfiliado, botonesDeCierre } = await import('./whatsapp-venta-servicio');
        const { hoyBogota } = await import('./wa-cobro-desde-comprobante.service');
        const items = await serviciosDeAnuncio(lead.schoolId, ahora.getTime());
        if (!items.length) return null;
        const servicioDelLead = lead.sourceDetail?.servicio_interes?.id;
        const venta = ventaActiva(recientes, items, {
            ahora: ahora.getTime(), leadServicioId: typeof servicioDelLead === 'string' ? servicioDelLead : null,
        });
        if (!venta) return null;
        let afiliado = false;
        if (tienePrecioDeAfiliado(venta.item)) {
            const { esAfiliado } = await import('./wa-afiliado.service');
            afiliado = (await esAfiliado(lead.schoolId, conv.contactWaId)).afiliado;
        }
        return {
            itemId: venta.item.id,
            texto: textoSeguimientoDeVenta(venta.item, { recientes, afiliado, hoy: hoyBogota(ahora.getTime()), ahora: ahora.getTime() }),
            botones: botonesDeCierre(venta.item, recientes, ahora.getTime()),
        };
    } catch {
        return null;
    }
}

/**
 * El texto del seguimiento: lo redacta el modelo con la ficha y el tono de la
 * escuela. null = sin ficha, tope de respuestas o el modelo dijo NADA.
 * Exportada para el número de pruebas (`/avanzar seguimiento`).
 */
export async function redactarSeguimiento20h(
    integ: WhatsAppIntegration, conversationId: string, recientes: FilaReciente[],
): Promise<string | null> {
    const bot = await import('./whatsapp-bot.service');
    const { infoDeEscuela, fallbackInfoEscuela } = await import('./whatsapp-info-escuela.service');
    const { preciosParaProspecto } = await import('./whatsapp-precios.service');
    const { ajustesWhatsAppDeEscuela } = await import('./whatsapp-ajustes-escuela.service');
    const { redactarRespuestaDeProspecto } = await import('./whatsapp-prospecto-ia.service');
    const schoolId = integ.school_id;
    const ajustes = await ajustesWhatsAppDeEscuela(schoolId);
    const [escuela, info, precios, enlace] = await Promise.all([
        bot.nombreDeEscuela(schoolId),
        infoDeEscuela(schoolId).catch(() => null),
        preciosParaProspecto(schoolId, ajustes.responderPrecios).catch(() => null),
        bot.enlaceDeInscripcion(schoolId).catch(() => null),
    ]);
    return redactarRespuestaDeProspecto({
        schoolId, conversationId, escuela, nuevo: '', recientes, seguimiento: true,
        grupos: info ? fallbackInfoEscuela(info) : null, precios, enlace,
    });
}

const DEPS: DepsSeguimiento20h = {
    async candidatos() {
        const desde = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, school_id, source_detail')
            .in('status', ['new', 'contacted'])
            .is('trial_slot_id', null)
            .is('source_detail->>seguimiento_20h_at', null)
            .not('source_detail->>conversation_id', 'is', null)
            .gte('updated_at', desde)
            .limit(200);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map((l) => ({
            id: l.id, schoolId: l.school_id, conversationId: String(l.source_detail?.conversation_id),
            sourceDetail: l.source_detail ?? {},
        }));
    },
    async conversacion(conversationId) {
        const { data } = await supabase.from('whatsapp_conversations')
            .select('id, integration_id, contact_wa_id, last_inbound_at').eq('id', conversationId).maybeSingle();
        const c = data as any;
        return c ? { id: c.id, integrationId: c.integration_id, contactWaId: c.contact_wa_id, lastInboundAt: c.last_inbound_at } : null;
    },
    async recientes(conversationId) {
        const { mensajesRecientes } = await import('./whatsapp-bot.service');
        return mensajesRecientes(conversationId);
    },
    async puedeHablar(integrationId, conversationId, waId) {
        const [{ botEncendido }, { conversacionTomada }, { estaDadoDeBaja }] = await Promise.all([
            import('./whatsapp-atencion.service'), import('./whatsapp-tomada.service'), import('./whatsapp-optin.service'),
        ]);
        return await botEncendido(integrationId) && !(await conversacionTomada(conversationId))
            && !(await estaDadoDeBaja(integrationId, waId));
    },
    async cupoSeparado(conversationId) {
        const desde = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();
        const { data, error } = await supabase.from('whatsapp_messages').select('payload')
            .eq('conversation_id', conversationId).eq('direction', 'outbound').gte('created_at', desde)
            .in('payload->>step', ['embudo_esperando_pago', 'embudo_agendada']).limit(1);
        // Ante la duda (error de lectura) NO se envía.
        return Boolean(error) || (data ?? []).length > 0;
    },
    async integracion(integrationId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('*').eq('id', integrationId).eq('status', 'active').maybeSingle();
        return (data as WhatsAppIntegration | null) ?? null;
    },
    async reclamar(lead, iso) {
        const { data, error } = await supabase.from('school_signup_leads')
            .update({ source_detail: { ...lead.sourceDetail, seguimiento_20h_at: iso } })
            .eq('id', lead.id)
            .is('source_detail->>seguimiento_20h_at', null)
            .select('id');
        return !error && Array.isArray(data) && data.length === 1;
    },
    async soltar(lead) {
        await supabase.from('school_signup_leads').update({ source_detail: { ...lead.sourceDetail } }).eq('id', lead.id);
    },
    redactar: redactarSeguimiento20h,
    async enviar(integ, conversationId, waId, texto, extra, botones) {
        const { deliver } = await import('./whatsapp-bot.service');
        await deliver(integ, conversationId, waId, texto, { ...(extra ?? {}), step: PASO_SEGUIMIENTO_20H }, botones?.length ? { botones } : undefined);
    },
    ventaDelLead: seguimientoDeVentaDelLead,
};

export interface ResumenSeguimiento20h { candidatos: number; enviados: number; omitidos: number; fallidos: number }

export async function runSeguimientoProspectos20h(
    opciones: { ahora?: Date; deps?: Partial<DepsSeguimiento20h> } = {},
): Promise<ResumenSeguimiento20h> {
    const d: DepsSeguimiento20h = { ...DEPS, ...(opciones.deps ?? {}) };
    const ahora = opciones.ahora ?? new Date();
    const r: ResumenSeguimiento20h = { candidatos: 0, enviados: 0, omitidos: 0, fallidos: 0 };
    const h = horaBogota(ahora);
    if (h < HORA_INICIO || h >= HORA_FIN) return r;

    let leads: LeadCandidato[] = [];
    try { leads = await d.candidatos(); } catch { return r; }
    r.candidatos = leads.length;

    for (const lead of leads) {
        try {
            const conv = await d.conversacion(lead.conversationId);
            if (!conv) { r.omitidos++; continue; }
            const recientes = await d.recientes(conv.id);
            if (!tocaSeguimiento(conv, recientes, ahora).toca) { r.omitidos++; continue; }
            if (d.cupoSeparado && await d.cupoSeparado(conv.id)) { r.omitidos++; continue; }
            if (!(await d.puedeHablar(conv.integrationId, conv.id, conv.contactWaId))) { r.omitidos++; continue; }
            const integ = await d.integracion(conv.integrationId);
            if (!integ) { r.omitidos++; continue; }
            if (!(await d.reclamar(lead, ahora.toISOString()))) { r.omitidos++; continue; }
            // Venta de un servicio: el texto del servicio, determinista y una vez (la marca
            // del lead ya quedó puesta). Nunca la clase de prueba ni una fecha inventada.
            const venta = await d.ventaDelLead(lead, conv, recientes, ahora).catch(() => null);
            if (venta) {
                if (!venta.texto) { r.omitidos++; continue; }
                const { MARCA_VENTA } = await import('./whatsapp-venta-contexto');
                await d.enviar(integ, conv.id, conv.contactWaId, venta.texto, { [MARCA_VENTA]: venta.itemId, seguimiento_de_venta: true },
                    ...(venta.botones?.length ? [venta.botones] as const : []));
                r.enviados++;
                continue;
            }
            const texto = await d.redactar(integ, conv.id, recientes);
            // Sin ficha, sin texto o el modelo dijo NADA: la marca queda puesta
            // (no se vuelve a intentar con ese interesado).
            if (!texto) { r.omitidos++; continue; }
            await d.enviar(integ, conv.id, conv.contactWaId, texto);
            r.enviados++;
        } catch (e: any) {
            r.fallidos++;
            await d.soltar(lead).catch(() => undefined);
            console.warn('[wa-seguimiento-20h] falló', { leadId: lead.id, err: e?.message });
        }
    }
    return r;
}
