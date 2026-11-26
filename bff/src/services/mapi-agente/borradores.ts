/**
 * borradores — lo que pasa entre la vista previa y el clic (plan §10).
 *
 * Una acción de Mapi nunca se ejecuta en el turno del modelo: queda como
 * borrador en `mapi_action_drafts` y la persona la confirma. Al confirmar:
 *   1. Reclamo atómico (UPDATE … WHERE status='draft' AND no vencido). Es lo
 *      que garantiza que dos clics ejecuten UNA sola vez.
 *   2. Permisos con el rol y los flags ACTUALES (el alcance de esta request).
 *   3. Se vuelve a preparar y se compara el hash con la vista previa que vio
 *      la persona. Si cambió algo, el borrador pasa a `superseded`, nace uno
 *      nuevo con la vista previa nueva y se pide confirmar otra vez.
 *   4. Se ejecuta y queda el resultado (executed / partial / failed).
 * Un borrador que queda en `executing` más de 10 minutos (el proceso murió a
 * mitad) pasa a `failed` «interrumpido» y nunca se reintenta solo.
 * Sin cron: el vencimiento se aplica al listar (regla de Disk IO).
 */

import { createHash } from 'node:crypto';
import { supabase } from '../../config/supabase';
import { buscarHerramienta } from './registro';
import { RechazoHerramienta, type Alcance, type HerramientaAccion, type Preparado, type VistaPrevia } from './tipos';

export const VIGENCIA_MIN = 30;
export const MIN_INTERRUMPIDO = 10;

/** JSON con las llaves ordenadas: el mismo contenido da el mismo hash. Pura. */
export function canonico(x: unknown): string {
    if (x === null || typeof x !== 'object') return JSON.stringify(x ?? null);
    if (Array.isArray(x)) return `[${x.map(canonico).join(',')}]`;
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(',')}}`;
}

export function hashDe(tool: string, huella: unknown, vista: VistaPrevia): string {
    return createHash('sha256').update(canonico({ tool, huella, vista })).digest('hex');
}

export interface FilaBorrador {
    id: string;
    school_id: string;
    user_id: string;
    ticket_id: string | null;
    message_id: string | null;
    tool: string;
    target_key: string | null;
    args: any;
    preview: VistaPrevia;
    content_hash: string;
    status: string;
    replaced_by: string | null;
    result: any;
    failure_reason: string | null;
    created_at: string;
    expires_at: string;
    executed_at: string | null;
}

/** Lo que recibe el chat para dibujar la tarjeta. */
export interface TarjetaAccion {
    id: string;
    herramienta: string;
    estado: string;
    vista: VistaPrevia;
    expiraEn: string;
    mensajeId: string | null;
    reemplazadaPor: string | null;
    motivo: string | null;
    creadaEn: string;
}

export function aTarjeta(f: FilaBorrador): TarjetaAccion {
    return {
        id: f.id,
        herramienta: f.tool,
        estado: f.status,
        vista: f.preview,
        expiraEn: f.expires_at,
        mensajeId: f.message_id,
        reemplazadaPor: f.replaced_by,
        motivo: f.failure_reason,
        creadaEn: f.created_at,
    };
}

export async function crearBorrador(p: {
    alcance: Alcance;
    ticketId: string | null;
    messageId?: string | null;
    herramienta: HerramientaAccion;
    preparado: Extract<Preparado<any>, { ok: true }>;
}): Promise<FilaBorrador> {
    const { alcance: a, herramienta: h, preparado: prep } = p;
    const { data, error } = await supabase.from('mapi_action_drafts').insert({
        school_id: a.schoolId,
        user_id: a.userId,
        ticket_id: p.ticketId,
        message_id: p.messageId ?? null,
        tool: h.nombre,
        target_key: prep.targetKey,
        args: prep.args,
        preview: prep.vista,
        content_hash: hashDe(h.nombre, prep.huella, prep.vista),
        // Igual al DEFAULT de la columna; explícito para la memoria del modo pruebas
        // del canal (cortafuegos: una tabla virtual no tiene DEFAULT).
        status: 'draft',
        expires_at: new Date(Date.now() + VIGENCIA_MIN * 60_000).toISOString(),
    }).select('*').single();
    if (error || !data) throw new Error(`no se pudo guardar el borrador: ${error?.message}`);
    const fila = data as FilaBorrador;

    // §10.4: un borrador nuevo de la misma herramienta sobre el mismo objeto
    // reemplaza al anterior que siga pendiente.
    if (prep.targetKey) {
        await supabase.from('mapi_action_drafts')
            .update({ status: 'superseded', replaced_by: fila.id })
            .eq('user_id', a.userId).eq('school_id', a.schoolId).eq('tool', h.nombre)
            .eq('target_key', prep.targetKey).eq('status', 'draft').neq('id', fila.id);
    }
    return fila;
}

/** Vence los pendientes pasados de hora y marca los interrumpidos. Sin cron. */
export async function vencerPendientes(userId: string): Promise<void> {
    const ahora = new Date();
    await supabase.from('mapi_action_drafts').update({ status: 'expired' })
        .eq('user_id', userId).eq('status', 'draft').lt('expires_at', ahora.toISOString());
    await supabase.from('mapi_action_drafts')
        .update({ status: 'failed', failure_reason: 'interrumpido: quedó a mitad de ejecución; revisar a mano' })
        .eq('user_id', userId).eq('status', 'executing')
        .lt('executing_since', new Date(ahora.getTime() - MIN_INTERRUMPIDO * 60_000).toISOString());
}

export async function tarjetasDelTicket(userId: string, ticketId: string): Promise<TarjetaAccion[]> {
    await vencerPendientes(userId).catch(() => {});
    const { data, error } = await supabase.from('mapi_action_drafts').select('*')
        .eq('user_id', userId).eq('ticket_id', ticketId)
        .order('created_at', { ascending: false }).limit(30);
    // Sin la migración la tabla no existe: el chat sigue sin tarjetas.
    if (error) return [];
    return ((data as FilaBorrador[]) ?? []).reverse().map(aTarjeta);
}

/** Las propuestas que siguen vivas en el chat (pendientes y sin vencer), las 5 más nuevas. */
export async function pendientesDelTicket(userId: string, ticketId: string): Promise<TarjetaAccion[]> {
    const ahora = Date.now();
    return (await tarjetasDelTicket(userId, ticketId))
        .filter((t) => t.estado === 'draft' && Date.parse(t.expiraEn) > ahora)
        .slice(-5);
}

/** Ventana de las propuestas de WhatsApp que el modelo ve como pendientes (§12.10). */
export const VENTANA_CANAL_MIN = 30;

/**
 * Propuestas vivas de un canal SIN hilo (WhatsApp: ticket_id null), de este
 * usuario en ESTA escuela y de los últimos 30 min, las 5 más nuevas en orden.
 * Las de la app (con ticket) no se mezclan.
 */
export async function pendientesDelCanal(userId: string, schoolId: string, ahora = Date.now()): Promise<TarjetaAccion[]> {
    await vencerPendientes(userId).catch(() => {});
    const { data, error } = await supabase.from('mapi_action_drafts').select('*')
        .eq('user_id', userId).eq('school_id', schoolId).is('ticket_id', null).eq('status', 'draft')
        .gt('expires_at', new Date(ahora).toISOString())
        .gte('created_at', new Date(ahora - VENTANA_CANAL_MIN * 60_000).toISOString())
        .order('created_at', { ascending: false }).limit(5);
    if (error) return [];
    return ((data as FilaBorrador[]) ?? []).reverse().map(aTarjeta);
}

export async function asociarMensaje(ids: string[], messageId: string): Promise<void> {
    if (!ids.length) return;
    await supabase.from('mapi_action_drafts').update({ message_id: messageId }).in('id', ids);
}

async function leerPropio(userId: string, id: string): Promise<FilaBorrador | null> {
    const { data } = await supabase.from('mapi_action_drafts').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    return (data as FilaBorrador) ?? null;
}

async function cerrar(id: string, cambios: Record<string, unknown>): Promise<FilaBorrador> {
    const { data, error } = await supabase.from('mapi_action_drafts').update(cambios).eq('id', id).select('*').single();
    if (error || !data) throw new Error(`no se pudo actualizar el borrador: ${error?.message}`);
    return data as FilaBorrador;
}

export async function cancelarBorrador(userId: string, id: string): Promise<TarjetaAccion | null> {
    const { data } = await supabase.from('mapi_action_drafts').update({ status: 'cancelled' })
        .eq('id', id).eq('user_id', userId).eq('status', 'draft').select('*').maybeSingle();
    if (data) return aTarjeta(data as FilaBorrador);
    const actual = await leerPropio(userId, id);
    return actual ? aTarjeta(actual) : null;
}

export type ResultadoConfirmar =
    /** No es suyo o no existe. */
    | { tipo: 'no_encontrado' }
    /** Ya no estaba pendiente (otro clic, cancelado, vencido): se responde el estado actual. */
    | { tipo: 'sin_cambio'; tarjeta: TarjetaAccion }
    /** La sesión está en otra escuela: no se toca el borrador. */
    | { tipo: 'otra_escuela'; tarjeta: TarjetaAccion }
    /** Cambió algo desde la vista previa: hay una tarjeta nueva para confirmar. */
    | { tipo: 'cambio'; tarjeta: TarjetaAccion; nueva: TarjetaAccion }
    /** Se ejecutó (o falló al ejecutar / al revalidar). `mensaje` es el texto fijo del servidor. */
    | { tipo: 'final'; tarjeta: TarjetaAccion; mensaje: string; ticketId: string | null }
    /** Herramienta de `segundoPlano`: quedó ejecutándose; al terminar llama `alTerminar`. */
    | { tipo: 'en_curso'; tarjeta: TarjetaAccion; ticketId: string | null };

export type Final = Extract<ResultadoConfirmar, { tipo: 'final' }>;

export async function confirmarBorrador(p: {
    userId: string;
    id: string;
    alcance: Alcance | null;
    /** Solo para herramientas de `segundoPlano`: recibe el resultado cuando termina. */
    alTerminar?: (f: Final) => Promise<void>;
}): Promise<ResultadoConfirmar> {
    const previo = await leerPropio(p.userId, p.id);
    if (!previo) return { tipo: 'no_encontrado' };
    if (p.alcance && p.alcance.schoolId !== previo.school_id) return { tipo: 'otra_escuela', tarjeta: aTarjeta(previo) };

    // 1. Reclamo atómico.
    const { data: reclamado } = await supabase.from('mapi_action_drafts')
        .update({ status: 'executing', executing_since: new Date().toISOString() })
        .eq('id', p.id).eq('user_id', p.userId).eq('status', 'draft').gt('expires_at', new Date().toISOString())
        .select('*').maybeSingle();
    if (!reclamado) {
        const actual = await leerPropio(p.userId, p.id);
        if (actual?.status === 'draft') {
            // Pendiente pero vencido.
            return { tipo: 'sin_cambio', tarjeta: aTarjeta(await cerrar(p.id, { status: 'expired' })) };
        }
        return { tipo: 'sin_cambio', tarjeta: aTarjeta(actual ?? previo) };
    }
    const b = reclamado as FilaBorrador;
    const fallar = async (motivo: string) => {
        const f = await cerrar(b.id, { status: 'failed', failure_reason: motivo.slice(0, 500) });
        return { tipo: 'final' as const, tarjeta: aTarjeta(f), mensaje: `No se hizo: ${motivo}`, ticketId: b.ticket_id };
    };

    // 2. Permisos actuales.
    const h = p.alcance ? buscarHerramienta(b.tool, p.alcance) : null;
    if (!p.alcance || !h || h.tipo !== 'accion') return fallar('ya no tienes permiso para esta acción en esta escuela.');

    // 3. Re-preparar y comparar.
    let prep: Preparado<any>;
    let args: any;
    try {
        args = h.validar(b.args);
        prep = await h.preparar(p.alcance, args);
    } catch (err: any) {
        return fallar(err instanceof RechazoHerramienta ? err.message : 'no se pudo volver a verificar la acción.');
    }
    if (!prep.ok) return fallar(prep.motivo);
    if (hashDe(b.tool, prep.huella, prep.vista) !== b.content_hash) {
        const nueva = await crearBorrador({ alcance: p.alcance, ticketId: b.ticket_id, messageId: b.message_id, herramienta: h, preparado: prep });
        const vieja = await cerrar(b.id, { status: 'superseded', replaced_by: nueva.id });
        return { tipo: 'cambio', tarjeta: aTarjeta(vieja), nueva: aTarjeta(nueva) };
    }

    // 4. Ejecutar.
    const alcance = p.alcance;
    const argsListos = prep.args;
    const ejecutarYCerrar = async (): Promise<Final> => {
        let r;
        try {
            r = await h.ejecutar(alcance, argsListos);
        } catch (err: any) {
            console.error(`[mapi-agente] ejecutar ${b.tool} falló:`, err?.message || String(err));
            return fallar(err instanceof RechazoHerramienta ? err.message : 'error del sistema al ejecutar. No se reintenta solo.');
        }
        const fila = await cerrar(b.id, {
            status: r.estado,
            result: r.resultado,
            executed_at: new Date().toISOString(),
            ...(r.estado === 'failed' ? { failure_reason: String((r.resultado as any)?.motivo || (r.resultado as any)?.error || 'falló').slice(0, 500) } : {}),
        });
        return { tipo: 'final', tarjeta: aTarjeta(fila), mensaje: h.mensajeResultado(r, argsListos), ticketId: b.ticket_id };
    };

    if (!h.segundoPlano) return ejecutarYCerrar();

    // Segundo plano: el request responde ya; la acción sigue en este proceso.
    // Nada de lo que pase aquí puede tumbar el BFF: todo error se atrapa. Si
    // `cerrar` falla, el borrador queda `executing` y a los 10 min se marca
    // «interrumpido» (nunca se reintenta solo).
    void ejecutarYCerrar()
        .then((f) => p.alTerminar?.(f))
        .catch((err: any) => console.error(`[mapi-agente] ${b.tool} en segundo plano no cerró:`, err?.message || String(err)));
    return { tipo: 'en_curso', tarjeta: aTarjeta(b), ticketId: b.ticket_id };
}
