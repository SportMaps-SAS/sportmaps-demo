/**
 * Rescate por plantilla del interesado al que nadie le contestó (Monster 2026-11-12, @Andrey_0630: escribió
 * «Me interesa entrenar con ustedes» y el bot calló 17 h; con la ventana de 24 h cerrada solo se puede escribir
 * con una plantilla aprobada).
 *
 * Complementa al seguimiento de 20 h (whatsapp-prospecto-seguimiento.service), que manda TEXTO dentro de la
 * ventana y solo a quien ya recibió algo. Este manda la plantilla `seguimiento_interesado` (marketing) a quien
 * quedó con su último mensaje sin respuesta de nadie.
 *
 * Reglas (todas, no una):
 *  - Interesado registrado (`school_signup_leads` new/contacted, sin clase reservada) con conversación.
 *  - Su último mensaje tiene entre 20 h y 7 días, y NADIE (bot, escuela, automático) escribió después.
 *  - Una sola vez por interesado (marca `source_detail.rescate_plantilla_at`, reclamada con UPDATE condicional).
 *  - CONSENTIMIENTO: `wa_can_send_template` (opt-in vigente, sin baja, no bloqueado). Sin él NO se envía: es la
 *    regla de la plataforma para toda plantilla, y la de marketing cuesta ~3× y exige consentimiento.
 *  - La plantilla debe estar APROBADA en la WABA actual de la integración; si no, no se hace nada.
 *  - Bot encendido, conversación no tomada, de 8:00 a 20:00 hora de Colombia.
 *  - Tope por corrida.
 *
 * Nunca lanza.
 */
import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import type { WhatsAppIntegration } from './whatsapp.service';
import { horaBogota } from './whatsapp-prospecto-seguimiento.service';

export const PLANTILLA_RESCATE = 'seguimiento_interesado';
export const PASO_RESCATE = 'prospecto_rescate_plantilla';
export const DESDE_H = 20;
export const HASTA_DIAS = 7;
const HORA_INICIO = 8;
const HORA_FIN = 20;
const TOPE_POR_CORRIDA = 15;

export interface LeadRescate { id: string; schoolId: string; conversationId: string; sourceDetail: Record<string, any> }
export interface ConversacionRescate {
    id: string; integrationId: string; contactWaId: string; contactName: string | null;
    contactKind: string | null; lastInboundAt: string | null;
}

/** Primer nombre limpio («Anderson⚡ (@Andrey_0630)» → «Anderson»). Sin nombre: «por aquí». Pura. */
export function primerNombre(nombre: string | null | undefined): string {
    const limpio = String(nombre ?? '').replace(/\(@[^)]*\)/g, '').replace(/[^\p{L}\p{N}\s'´-]/gu, ' ').trim();
    const p = limpio.split(/\s+/)[0] ?? '';
    return p.length >= 2 && p.length <= 40 && !/^\d+$/.test(p) ? p : 'por aquí';
}

/** ¿Toca el rescate? Pura. `hayEscrituraPosterior`: alguien escribió después del último mensaje del interesado. */
export function tocaRescate(
    conv: Pick<ConversacionRescate, 'lastInboundAt' | 'contactKind'>,
    hayEscrituraPosterior: boolean,
    ahora: Date,
): { toca: boolean; motivo: string } {
    const h = horaBogota(ahora);
    if (h < HORA_INICIO || h >= HORA_FIN) return { toca: false, motivo: 'fuera_de_horario' };
    if (conv.contactKind && !['desconocido', 'familia_sin_cuenta'].includes(conv.contactKind)) {
        return { toca: false, motivo: 'no_es_interesado' };
    }
    const ultimo = conv.lastInboundAt ? new Date(conv.lastInboundAt).getTime() : NaN;
    if (Number.isNaN(ultimo)) return { toca: false, motivo: 'sin_entrante' };
    const edadH = (ahora.getTime() - ultimo) / 3600_000;
    if (edadH < DESDE_H) return { toca: false, motivo: 'muy_reciente' };
    if (edadH > HASTA_DIAS * 24) return { toca: false, motivo: 'muy_viejo' };
    if (hayEscrituraPosterior) return { toca: false, motivo: 'ya_tuvo_respuesta' };
    return { toca: true, motivo: 'ok' };
}

export interface DepsRescate {
    candidatos: () => Promise<LeadRescate[]>;
    conversacion: (conversationId: string) => Promise<ConversacionRescate | null>;
    hayEscrituraPosterior: (conv: ConversacionRescate) => Promise<boolean>;
    puedeHablar: (integrationId: string, conversationId: string, waId: string) => Promise<boolean>;
    integracion: (integrationId: string) => Promise<WhatsAppIntegration | null>;
    /** Plantilla APROBADA en la WABA actual: { idioma, components } o null. */
    plantillaAprobada: (integ: WhatsAppIntegration) => Promise<{ idioma: string; components: any[] } | null>;
    consentimiento: (integrationId: string, waId: string) => Promise<boolean>;
    reclamar: (lead: LeadRescate, iso: string) => Promise<boolean>;
    soltar: (lead: LeadRescate) => Promise<void>;
    nombreEscuela: (schoolId: string) => Promise<string>;
    enviar: (integ: WhatsAppIntegration, conv: ConversacionRescate, plantilla: { idioma: string; components: any[] },
        variables: string[]) => Promise<boolean>;
}

const DEPS: DepsRescate = {
    async candidatos() {
        const desde = new Date(Date.now() - HASTA_DIAS * 24 * 3600_000).toISOString();
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, school_id, source_detail')
            .in('status', ['new', 'contacted'])
            .is('trial_slot_id', null)
            .is('source_detail->>rescate_plantilla_at', null)
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
            .select('id, integration_id, contact_wa_id, contact_name, contact_kind, last_inbound_at')
            .eq('id', conversationId).maybeSingle();
        const c = data as any;
        return c ? {
            id: c.id, integrationId: c.integration_id, contactWaId: c.contact_wa_id, contactName: c.contact_name ?? null,
            contactKind: c.contact_kind ?? null, lastInboundAt: c.last_inbound_at,
        } : null;
    },
    async hayEscrituraPosterior(conv) {
        // Cualquier saliente (bot, escuela, plantilla, automático) DESPUÉS del último mensaje del interesado.
        const { data, error } = await supabase.from('whatsapp_messages').select('id')
            .eq('conversation_id', conv.id).eq('direction', 'outbound')
            .gt('created_at', new Date(new Date(conv.lastInboundAt as string).getTime() - 2 * 60_000).toISOString())
            .limit(1);
        // Ante la duda (error de lectura) se asume que sí hubo respuesta: no se envía.
        return Boolean(error) || (data ?? []).length > 0;
    },
    async puedeHablar(integrationId, conversationId, waId) {
        const [{ botEncendido }, { conversacionTomada }, { estaDadoDeBaja }] = await Promise.all([
            import('./whatsapp-atencion.service'), import('./whatsapp-tomada.service'), import('./whatsapp-optin.service'),
        ]);
        return await botEncendido(integrationId) && !(await conversacionTomada(conversationId))
            && !(await estaDadoDeBaja(integrationId, waId));
    },
    async integracion(integrationId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('*').eq('id', integrationId).eq('status', 'active').maybeSingle();
        return (data as WhatsAppIntegration | null) ?? null;
    },
    async plantillaAprobada(integ) {
        const { data } = await supabase.from('whatsapp_template_status')
            .select('language, status, waba_id, components')
            .eq('integration_id', integ.id).eq('name', PLANTILLA_RESCATE).eq('status', 'APPROVED').limit(5);
        const f = ((data ?? []) as any[]).find((x) => !integ.waba_id || x.waba_id === integ.waba_id);
        return f ? { idioma: String(f.language), components: (f.components ?? []) as any[] } : null;
    },
    async consentimiento(integrationId, waId) {
        const { consentimientoDe } = await import('./whatsapp-plantilla-manual.service');
        return (await consentimientoDe(integrationId, waId)) === 'ok';
    },
    async reclamar(lead, iso) {
        const { data, error } = await supabase.from('school_signup_leads')
            .update({ source_detail: { ...lead.sourceDetail, rescate_plantilla_at: iso } })
            .eq('id', lead.id)
            .is('source_detail->>rescate_plantilla_at', null)
            .select('id');
        return !error && Array.isArray(data) && data.length === 1;
    },
    async soltar(lead) {
        await supabase.from('school_signup_leads').update({ source_detail: { ...lead.sourceDetail } }).eq('id', lead.id);
    },
    async nombreEscuela(schoolId) {
        const { nombreDeEscuela } = await import('./whatsapp-bot.service');
        return nombreDeEscuela(schoolId);
    },
    async enviar(integ, conv, plantilla, variables) {
        const { sendRawPayload } = await import('./whatsapp.service');
        const { armarPayloadPlantilla, renderizarCuerpo } = await import('./whatsapp-plantillas.service');
        const payload = armarPayloadPlantilla({
            toWaId: conv.contactWaId, plantilla: PLANTILLA_RESCATE, idioma: plantilla.idioma, variables, tokenBoton: null,
        });
        const r = await sendRawPayload(integ, payload);
        if (!r.ok) throw new Error(r.error ?? 'error_graph');
        await supabase.rpc('wa_record_outbound_message', {
            p_conversation_id: conv.id,
            p_integration_id: integ.id,
            p_wa_message_id: r.waMessageId || `local-${crypto.randomUUID()}`,
            p_type: 'template',
            p_text_body: renderizarCuerpo(plantilla.components, variables),
            p_payload: { automatico: true, step: PASO_RESCATE, plantilla: PLANTILLA_RESCATE, variables },
            p_ai_generated: false,
            p_to_wa_id: conv.contactWaId,
        });
        return true;
    },
};

export interface ResumenRescate { candidatos: number; enviados: number; omitidos: number; fallidos: number }

export async function runRescateProspectosPorPlantilla(
    opciones: { ahora?: Date; deps?: Partial<DepsRescate> } = {},
): Promise<ResumenRescate> {
    const d: DepsRescate = { ...DEPS, ...(opciones.deps ?? {}) };
    const ahora = opciones.ahora ?? new Date();
    const r: ResumenRescate = { candidatos: 0, enviados: 0, omitidos: 0, fallidos: 0 };
    const h = horaBogota(ahora);
    if (h < HORA_INICIO || h >= HORA_FIN) return r;

    let leads: LeadRescate[] = [];
    try { leads = await d.candidatos(); } catch { return r; }
    r.candidatos = leads.length;

    for (const lead of leads) {
        if (r.enviados >= TOPE_POR_CORRIDA) break;
        try {
            const conv = await d.conversacion(lead.conversationId);
            if (!conv) { r.omitidos++; continue; }
            // El filtro barato primero (sin leer mensajes): edad, tipo y horario.
            if (!tocaRescate(conv, false, ahora).toca) { r.omitidos++; continue; }
            if (await d.hayEscrituraPosterior(conv)) { r.omitidos++; continue; }
            if (!(await d.puedeHablar(conv.integrationId, conv.id, conv.contactWaId))) { r.omitidos++; continue; }
            // Sin consentimiento NO se envía (regla de la plataforma para toda plantilla).
            if (!(await d.consentimiento(conv.integrationId, conv.contactWaId))) { r.omitidos++; continue; }
            const integ = await d.integracion(conv.integrationId);
            if (!integ) { r.omitidos++; continue; }
            const plantilla = await d.plantillaAprobada(integ);
            if (!plantilla) { r.omitidos++; continue; }
            if (!(await d.reclamar(lead, ahora.toISOString()))) { r.omitidos++; continue; }
            const escuela = await d.nombreEscuela(lead.schoolId);
            await d.enviar(integ, conv, plantilla, [primerNombre(conv.contactName), escuela]);
            r.enviados++;
        } catch (e: any) {
            r.fallidos++;
            await d.soltar(lead).catch(() => undefined);
            console.warn('[wa-rescate-plantilla] falló', { leadId: lead.id, err: e?.message });
        }
    }
    return r;
}
