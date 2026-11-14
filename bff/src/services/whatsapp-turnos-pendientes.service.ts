/**
 * Turnos del bot que no pueden perderse en un reinicio (auditoría 2026-10-28,
 * A-01 / C-02; migración 20261029110305).
 *
 * El webhook contesta 200 a Meta y el turno corre después, en memoria: 10 s de
 * ráfaga más 5–40 s de modelo. Un despliegue o un reinicio en ese rato dejaba
 * el mensaje sin respuesta y sin rastro, y Meta no lo reintenta (ya recibió el
 * 200). Dos defensas:
 *
 *  1. APAGADO ORDENADO (index.ts): ante SIGTERM se deja de recibir y se esperan
 *     los turnos en curso de este proceso (`esperarTareasEnCurso`).
 *  2. ANOTACIÓN DURABLE: cada turno se anota en `whatsapp_turnos_pendientes` al
 *     lanzarse y se borra al terminar, pase lo que pase (corrido, absorbido por
 *     un mensaje más nuevo, candado ocupado o error). Si el proceso muere sin
 *     apagado ordenado, la fila queda; el barrido la relanza.
 *
 * El barrido corre SOLO donde corre la cola de comprobantes (prod: el webhook
 * de Meta llega ahí). En dev/stg `DISABLE_WHATSAPP_QUEUE_CRON=true`: un BFF con
 * código de develop no puede contestarle a familias reales.
 *
 * Nunca lanza: si la tabla no existe (migración sin aplicar) todo sigue como
 * antes.
 */
import { supabase } from '../config/supabase';
import type { WhatsAppIntegration } from './whatsapp.service';

export interface TurnoAnotado {
    waMessageId: string;
    conversationId: string;
    integrationId: string;
    contactWaId: string;
    texto: string | null;
    optedOut: boolean;
    botonId: string | null;
    origen: 'texto' | 'audio';
}

/** Un turno anotado hace menos de esto puede seguir corriendo en otro proceso. */
export const GRACIA_MS = 3 * 60_000;
/** Más viejo que esto ya no se contesta: la respuesta llegaría fuera de lugar. */
export const VENCE_MS = 2 * 3600_000;
const MAX_INTENTOS = 2;

// ─── 1. Tareas en curso de ESTE proceso (apagado ordenado) ──────────────────

const enCurso = new Set<Promise<unknown>>();

/** Registra una tarea en segundo plano para que el apagado la espere. */
export function seguirTarea<T>(p: Promise<T>): Promise<T> {
    enCurso.add(p);
    const quitar = () => { enCurso.delete(p); };
    p.then(quitar, quitar);
    return p;
}

/** Cuántas tareas siguen corriendo (para el log del apagado). */
export function tareasEnCurso(): number {
    return enCurso.size;
}

/** Espera a que terminen las tareas en curso, como mucho `maxMs`. true = terminaron todas. */
export async function esperarTareasEnCurso(maxMs: number): Promise<boolean> {
    if (!enCurso.size) return true;
    let vencio = false;
    const limite = new Promise<void>((r) => setTimeout(() => { vencio = true; r(); }, maxMs).unref?.());
    await Promise.race([Promise.allSettled([...enCurso]), limite]);
    return !vencio && enCurso.size === 0;
}

// ─── 2. Anotación durable ────────────────────────────────────────────────────

export async function anotarTurno(t: TurnoAnotado): Promise<void> {
    try {
        await supabase.from('whatsapp_turnos_pendientes').upsert({
            wa_message_id: t.waMessageId,
            conversation_id: t.conversationId,
            integration_id: t.integrationId,
            contact_wa_id: t.contactWaId,
            texto: t.texto,
            opted_out: t.optedOut,
            boton_id: t.botonId,
            origen: t.origen,
        }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
    } catch { /* sin la tabla, como antes */ }
}

export async function soltarTurno(waMessageId: string): Promise<void> {
    try {
        await supabase.from('whatsapp_turnos_pendientes').delete().eq('wa_message_id', waMessageId);
    } catch { /* idem */ }
}

// ─── 3. Barrido ──────────────────────────────────────────────────────────────

export interface FilaPendiente {
    wa_message_id: string;
    conversation_id: string;
    integration_id: string;
    contact_wa_id: string;
    texto: string | null;
    opted_out: boolean;
    boton_id: string | null;
    origen: 'texto' | 'audio';
    intentos: number;
    created_at: string;
}

export type DecisionBarrido = 'esperar' | 'relanzar' | 'descartar';

/** Qué hacer con una fila pendiente. Pura. */
export function decidirPendiente(f: Pick<FilaPendiente, 'created_at' | 'intentos'>, ahora = Date.now()): DecisionBarrido {
    const edad = ahora - new Date(f.created_at).getTime();
    if (!Number.isFinite(edad) || edad < GRACIA_MS) return 'esperar';
    if (edad > VENCE_MS || f.intentos >= MAX_INTENTOS) return 'descartar';
    return 'relanzar';
}

export interface DepsBarrido {
    pendientes: () => Promise<FilaPendiente[]>;
    /** ¿Ya salió algo (bot o persona) en la conversación después de ese mensaje? */
    yaRespondido: (conversationId: string, desdeIso: string) => Promise<boolean>;
    integracion: (integrationId: string) => Promise<WhatsAppIntegration | null>;
    marcarIntento: (waMessageId: string, intentos: number) => Promise<void>;
    soltar: (waMessageId: string) => Promise<void>;
    relanzar: (integ: WhatsAppIntegration, f: FilaPendiente) => Promise<void>;
}

const DEPS: DepsBarrido = {
    async pendientes() {
        const desde = new Date(Date.now() - VENCE_MS - 3600_000).toISOString();
        const { data, error } = await supabase.from('whatsapp_turnos_pendientes')
            .select('wa_message_id, conversation_id, integration_id, contact_wa_id, texto, opted_out, boton_id, origen, intentos, created_at')
            .gte('created_at', desde)
            .lte('created_at', new Date(Date.now() - GRACIA_MS).toISOString())
            .order('created_at', { ascending: true })
            .limit(50);
        // Lo más viejo que la ventana de lectura ya no se contesta: se limpia.
        await supabase.from('whatsapp_turnos_pendientes').delete().lt('created_at', desde);
        return error || !Array.isArray(data) ? [] : (data as FilaPendiente[]);
    },
    async yaRespondido(conversationId, desdeIso) {
        const { data } = await supabase.from('whatsapp_messages')
            .select('id').eq('conversation_id', conversationId).eq('direction', 'outbound')
            .gt('created_at', desdeIso).limit(1);
        return Array.isArray(data) && data.length > 0;
    },
    async integracion(integrationId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('*').eq('id', integrationId).eq('status', 'active').maybeSingle();
        return (data as WhatsAppIntegration | null) ?? null;
    },
    async marcarIntento(waMessageId, intentos) {
        await supabase.from('whatsapp_turnos_pendientes').update({ intentos }).eq('wa_message_id', waMessageId);
    },
    soltar: soltarTurno,
    async relanzar(integ, f) {
        const { correrTurnoAgrupado } = await import('./whatsapp-turno-agrupado.service');
        const { runBotTurn } = await import('./whatsapp-bot.service');
        // Sin la espera de la ráfaga (ya pasó) y con el mismo candado: si otro
        // turno de la conversación está corriendo, espera a que termine.
        await correrTurnoAgrupado({
            conversationId: f.conversation_id,
            waMessageId: f.wa_message_id,
            esperaMs: 0,
            correr: () => runBotTurn(integ, f.conversation_id, f.contact_wa_id, f.texto, f.wa_message_id,
                f.opted_out, f.boton_id, { origen: f.origen }),
        });
    },
};

export interface ResumenBarrido { revisados: number; relanzados: number; descartados: number; yaRespondidos: number }

export async function barrerTurnosPendientes(
    opciones: { ahora?: number; deps?: Partial<DepsBarrido> } = {},
): Promise<ResumenBarrido> {
    const d: DepsBarrido = { ...DEPS, ...(opciones.deps ?? {}) };
    const ahora = opciones.ahora ?? Date.now();
    const r: ResumenBarrido = { revisados: 0, relanzados: 0, descartados: 0, yaRespondidos: 0 };
    let filas: FilaPendiente[] = [];
    try { filas = await d.pendientes(); } catch { return r; }

    for (const f of filas) {
        r.revisados++;
        try {
            const decision = decidirPendiente(f, ahora);
            if (decision === 'esperar') continue;
            if (decision === 'descartar') {
                console.warn('[wa-turnos] turno perdido que ya no se contesta', { conversationId: f.conversation_id, intentos: f.intentos });
                await d.soltar(f.wa_message_id);
                r.descartados++;
                continue;
            }
            if (await d.yaRespondido(f.conversation_id, f.created_at)) {
                await d.soltar(f.wa_message_id);
                r.yaRespondidos++;
                continue;
            }
            const integ = await d.integracion(f.integration_id);
            if (!integ) { await d.soltar(f.wa_message_id); r.descartados++; continue; }
            // El intento se anota ANTES: si este proceso también muere, no se
            // relanza para siempre.
            await d.marcarIntento(f.wa_message_id, f.intentos + 1);
            console.warn('[wa-turnos] relanzando un turno que se perdió en un reinicio', { conversationId: f.conversation_id });
            await d.relanzar(integ, f);
            await d.soltar(f.wa_message_id);
            r.relanzados++;
        } catch (e: any) {
            console.warn('[wa-turnos] no se pudo revisar un turno pendiente', { conversationId: f.conversation_id, err: e?.message });
        }
    }
    return r;
}
