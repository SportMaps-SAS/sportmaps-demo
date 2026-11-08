/**
 * Lectura de la base para `ventaActiva` (whatsapp-venta-contexto.ts): los mensajes
 * de la conversación de los últimos `DIAS_CONTEXTO_VENTA` días con columnas
 * MÍNIMAS (del payload solo las marcas que importan, nunca el crudo de Meta), el
 * catálogo vigente y el servicio guardado en el lead del teléfono.
 *
 * Regla de Disk IO (CLAUDE.md): UNA consulta por cosa, con tope; nada de N+1.
 * Nunca lanza: ante cualquier error devuelve null (sin venta = el bot de siempre).
 */
import { supabase } from '../config/supabase';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { serviciosDeAnuncio, type ItemConFicha } from './whatsapp-anuncio-destino';
import { DIAS_CONTEXTO_VENTA, MARCA_VENTA, ventaActiva, type VentaActiva } from './whatsapp-venta-contexto';

/** Las marcas del payload que lee `ventaActiva` (PostgREST: `payload->clave`). */
const CAMPOS_PAYLOAD = [MARCA_VENTA, 'servicio_id', 'step', 'campana_id', 'destino_anuncio', 'caption'];
const SELECT = ['direction', 'type', 'text_body', 'ai_generated', 'wa_timestamp', 'created_at',
    ...CAMPOS_PAYLOAD.map((c) => `${c}:payload->>${c}`)].join(', ');
const TOPE_MENSAJES = 200;

/** Los mensajes de la conversación para decidir la venta (más nuevos primero). Nunca lanza. */
export async function mensajesParaVenta(conversationId: string, dias = DIAS_CONTEXTO_VENTA): Promise<FilaReciente[]> {
    if (!conversationId) return [];
    try {
        const desde = new Date(Date.now() - dias * 24 * 3600_000).toISOString();
        const { data, error } = await supabase.from('whatsapp_messages')
            .select(SELECT)
            .eq('conversation_id', conversationId)
            .gte('created_at', desde)
            .order('created_at', { ascending: false })
            .limit(TOPE_MENSAJES);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map((f) => {
            const payload: Record<string, unknown> = {};
            for (const c of CAMPOS_PAYLOAD) if (f[c] !== null && f[c] !== undefined) payload[c] = f[c];
            return {
                direction: f.direction, type: f.type, text_body: f.text_body ?? (payload.caption as string | undefined) ?? null,
                ai_generated: f.ai_generated, wa_timestamp: f.wa_timestamp, created_at: f.created_at, payload,
            } as FilaReciente;
        });
    } catch {
        return [];
    }
}

/** El servicio guardado en el lead más reciente de ese teléfono (`source_detail.servicio_interes.id`). Nunca lanza. */
export async function servicioDelLead(schoolId: string, telefono: string): Promise<string | null> {
    try {
        const { variantesTelefonoLead } = await import('./whatsapp-prospecto-lead.service');
        const variantes = variantesTelefonoLead(telefono);
        if (!schoolId || !variantes.length) return null;
        const { data, error } = await supabase.from('school_signup_leads')
            .select('servicio:source_detail->servicio_interes->>id')
            .eq('school_id', schoolId).in('phone', variantes).neq('status', 'discarded')
            .order('updated_at', { ascending: false }).limit(1);
        const id = !error && Array.isArray(data) ? (data[0] as any)?.servicio : null;
        return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
    } catch {
        return null;
    }
}

export interface ContextoDeVenta {
    venta: VentaActiva | null;
    /** El catálogo vigente que se leyó (para no volver a leerlo en el mismo turno). */
    items: ItemConFicha[];
}

/**
 * La venta activa de una conversación, leyendo lo mínimo: si la escuela no tiene
 * servicios vigentes, no lee los mensajes. Nunca lanza.
 */
export async function contextoDeVenta(
    schoolId: string, conversationId: string | null, telefono: string,
    o: { items?: ItemConFicha[]; mensajes?: FilaReciente[]; ahora?: number } = {},
): Promise<ContextoDeVenta> {
    try {
        const items = o.items ?? await serviciosDeAnuncio(schoolId, o.ahora);
        if (!items.length) return { venta: null, items };
        const [mensajes, leadServicioId] = await Promise.all([
            o.mensajes ? Promise.resolve(o.mensajes) : conversationId ? mensajesParaVenta(conversationId) : Promise.resolve([]),
            servicioDelLead(schoolId, telefono),
        ]);
        return { venta: ventaActiva(mensajes, items, { ahora: o.ahora, leadServicioId }), items };
    } catch {
        return { venta: null, items: [] };
    }
}
