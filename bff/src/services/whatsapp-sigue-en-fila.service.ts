/**
 * whatsapp-sigue-en-fila — «tu mensaje sigue en fila» (B6, plan maestro del bot de
 * Monster, 2026-10-30).
 *
 * Cuando el bot pasa una conversación a una persona («Le aviso a la escuela…»)
 * y en 2 h HÁBILES (lun–sáb 8:00–18:00, hora de Bogotá) nadie de la escuela le
 * escribió, el bot le confirma UNA vez a la familia que su mensaje sigue en fila.
 * El aviso al EQUIPO ya existe (SLA de `revisarSlaDeEscalaciones`); esto es lo
 * que ve la familia, que hasta hoy se quedaba sin saber si alguien la leyó.
 *
 * SOLO para escuelas con `school_settings.wa_temas_a_persona` configurado (no
 * nulo): Dynasty y las demás no cambian. Con el modo discreto de la escuela
 * prendido tampoco sale (en discreto a la familia no se le promete nada).
 *
 * Idempotente entre los 3 BFF: la marca `payload.sigue_en_fila_at` del saliente
 * que pasó a la persona se escribe con un UPDATE condicional (solo uno lo logra),
 * y además no sale si ya salió uno en esa conversación en 72 h.
 * Cero IO para las demás escuelas: la primera lectura (school_settings con la
 * columna no nula) vuelve vacía y no se lee nada más. Nunca lanza.
 */
import { supabase } from '../config/supabase';
import { slaVencido, type HorarioDeAtencion } from './whatsapp-reglas-turno';
import { respondioUnaPersona } from './whatsapp-escalaciones.service';
import { ajustesDesdeFila, modoDiscretoDeEscuela } from './whatsapp-ajustes-escuela.service';
import { modoDiscreto } from './whatsapp-modo-discreto';
import type { WhatsAppIntegration } from './whatsapp.service';

/** Lun–sáb 8:00–18:00 (0 = domingo, sin atención). */
export const HORARIO_SIGUE_EN_FILA: HorarioDeAtencion = {
    tz: 'America/Bogota',
    dias: Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((d) => [d, ['08:00', '18:00']])) as Record<string, [string, string]>,
};

/** Minutos hábiles sin respuesta de la escuela antes del aviso. */
export const MIN_HABILES_SIGUE_EN_FILA = 120;

/** Hasta cuándo se mira atrás. */
const VENTANA_HORAS = 72;

/** Los salientes del bot que dejan a la familia esperando a una persona. */
export const PASOS_A_PERSONA = ['escalated', 'identificacion_ambigua', 'puerta_club_recibido', 'puerta_otro_tema', 'embudo_a_persona'];

export const PASO_SIGUE_EN_FILA = 'sigue_en_fila';

export const TEXTO_SIGUE_EN_FILA =
    'Tu mensaje sigue en fila 🙌 La escuela ya lo tiene y te responde por aquí apenas pueda.';

/** ¿Ya pasaron las 2 h hábiles (lun–sáb 8–18) desde que se pasó a la persona? Pura. */
export function tocaAvisar(pasadoAt: string, ahora: number): boolean {
    return slaVencido(pasadoAt, ahora, HORARIO_SIGUE_EN_FILA, MIN_HABILES_SIGUE_EN_FILA);
}

export interface ResultadoSigueEnFila {
    escuelas: number;
    revisadas: number;
    avisados: number;
    atendidas: number;
    errores: number;
}

interface Pendiente {
    id: string;
    conversationId: string;
    integrationId: string;
    createdAt: string;
    payload: Record<string, any>;
}

/** Marca el saliente (UPDATE condicional: entre los 3 BFF, uno solo). */
async function marcar(e: Pendiente, resultado: string, ahora: number): Promise<boolean> {
    const { data, error } = await supabase.from('whatsapp_messages')
        .update({ payload: { ...e.payload, sigue_en_fila_at: new Date(ahora).toISOString(), sigue_en_fila: resultado } })
        .eq('id', e.id)
        .is('payload->>sigue_en_fila_at', null)
        .select('id');
    return !error && Array.isArray(data) && data.length > 0;
}

export async function runSigueEnFila(
    ahora = Date.now(),
    deps: {
        enviar?: (integration: WhatsAppIntegration, conversationId: string, contactWaId: string, texto: string,
            context: Record<string, unknown>) => Promise<void>;
    } = {},
): Promise<ResultadoSigueEnFila> {
    const r: ResultadoSigueEnFila = { escuelas: 0, revisadas: 0, avisados: 0, atendidas: 0, errores: 0 };
    try {
        // 1. Solo las escuelas con su lista de temas (sin la columna: error → nada).
        const { data: ajustes, error } = await supabase.from('school_settings')
            .select('school_id, wa_modo_discreto, wa_temas_a_persona')
            .not('wa_temas_a_persona', 'is', null)
            .limit(500);
        if (error || !Array.isArray(ajustes) || !ajustes.length) return r;
        const discretoPorEscuela = new Map<string, boolean>((ajustes as any[]).map((a) => [
            String(a.school_id), modoDiscretoDeEscuela(ajustesDesdeFila(a), modoDiscreto()),
        ]));
        r.escuelas = discretoPorEscuela.size;

        const { data: integs } = await supabase.from('school_whatsapp_integrations')
            .select('*').in('school_id', [...discretoPorEscuela.keys()]).eq('status', 'active');
        const porId = new Map<string, WhatsAppIntegration>(((integs ?? []) as any[]).map((i) => [String(i.id), i as WhatsAppIntegration]));
        if (!porId.size) return r;

        // 2. Lo que se pasó a una persona hace entre 2 h y 72 h, sin marcar.
        const { data: filas, error: e2 } = await supabase.from('whatsapp_messages')
            .select('id, conversation_id, integration_id, created_at, payload')
            .eq('direction', 'outbound')
            .in('integration_id', [...porId.keys()])
            .in('payload->>step', PASOS_A_PERSONA)
            .is('payload->>sigue_en_fila_at', null)
            .gte('created_at', new Date(ahora - VENTANA_HORAS * 3600_000).toISOString())
            .lte('created_at', new Date(ahora - MIN_HABILES_SIGUE_EN_FILA * 60_000).toISOString())
            .order('created_at', { ascending: false })
            .limit(200);
        if (e2 || !Array.isArray(filas)) return r;

        // Una por conversación (la más reciente); las demás se marcan sin avisar.
        const vistas = new Set<string>();
        const enviar = deps.enviar ?? (async (integration: WhatsAppIntegration, conversationId: string, contactWaId: string,
            texto: string, context: Record<string, unknown>) => {
            const { deliver } = await import('./whatsapp-bot.service');
            await deliver(integration, conversationId, contactWaId, texto, context);
        });
        for (const f of filas as any[]) {
            const e: Pendiente = {
                id: f.id, conversationId: f.conversation_id, integrationId: f.integration_id,
                createdAt: f.created_at, payload: (f.payload ?? {}) as Record<string, any>,
            };
            try {
                if (vistas.has(e.conversationId)) { await marcar(e, 'duplicada', ahora); continue; }
                vistas.add(e.conversationId);
                if (!tocaAvisar(e.createdAt, ahora)) continue; // se vuelve a mirar en el próximo tick
                const integration = porId.get(e.integrationId);
                if (!integration) continue;
                r.revisadas++;
                if (discretoPorEscuela.get(String(integration.school_id))) { await marcar(e, 'discreto', ahora); continue; }

                const { data: conv } = await supabase.from('whatsapp_conversations')
                    .select('id, contact_wa_id, status, tomada_por, tomada_hasta')
                    .eq('id', e.conversationId).maybeSingle();
                const c = conv as any;
                const tomada = !!c?.tomada_por && (!c?.tomada_hasta || new Date(c.tomada_hasta).getTime() > ahora);
                const atendida = !c || c.status === 'closed' || tomada || await respondioUnaPersona(e.conversationId, e.createdAt);
                if (atendida) { await marcar(e, 'atendida', ahora); r.atendidas++; continue; }

                // Una sola vez: si ya salió uno en esta conversación en 72 h, no se repite.
                const { count } = await supabase.from('whatsapp_messages')
                    .select('id', { count: 'exact', head: true })
                    .eq('conversation_id', e.conversationId).eq('direction', 'outbound')
                    .eq('payload->>step', PASO_SIGUE_EN_FILA)
                    .gte('created_at', new Date(ahora - VENTANA_HORAS * 3600_000).toISOString());
                if ((count ?? 0) > 0) { await marcar(e, 'ya_avisado', ahora); continue; }

                if (!(await marcar(e, 'avisada', ahora))) continue;
                await enviar(integration, e.conversationId, String(c.contact_wa_id), TEXTO_SIGUE_EN_FILA,
                    { step: PASO_SIGUE_EN_FILA, escalacion_id: e.id });
                r.avisados++;
            } catch (err: any) {
                r.errores++;
                console.warn('[sigue-en-fila] no se pudo revisar una conversación', { id: e.id, err: err?.message });
            }
        }
        return r;
    } catch (err: any) {
        console.warn('[sigue-en-fila] falló la revisión', { err: err?.message });
        r.errores++;
        return r;
    }
}
