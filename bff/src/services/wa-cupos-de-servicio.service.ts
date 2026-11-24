/**
 * Cupo de un servicio que el bot vende por WhatsApp (Monster 2026-11-22: «si se
 * llegan a 40 inscritos se cierra» el vacacional).
 *
 * `school_tournament_items.capacity` ya existía, pero solo lo miraba la RPC
 * `wa_crear_cobro_suelto` (carril B, familias con `wa_ventas_habilitadas`). La
 * venta por comprobante —la que usa Monster— no lo contaba nunca. Acá se cuenta
 * y `ventaCerradaDeItem` cierra la VENTA cuando se llena: mismo camino que la
 * clínica (mensaje fijo y a la escuela), sin tocar el reconocimiento de
 * comprobantes ni los saldos de quien ya pagó.
 *
 * Qué es UN inscrito: un cobro VIVO (pending, overdue, awaiting_approval, partial,
 * paid, glosado) de ese servicio. Se suman, sin repetir el mismo pago:
 *   · los enlazados al ítem (las tres fuentes de `_servicio_cupos_vivos`), y
 *   · los cobros de la escuela con `payment_category = kind` del ítem creados
 *     desde que existe el ítem, SOLO cuando la escuela tiene un único servicio
 *     activo de ese tipo. Son los que la escuela registra a mano sin enlazar (el
 *     22-nov Monster tenía 13 cobros de vacacional y solo 10 enlazados).
 *
 * Si la lectura falla NO se cierra la venta (se sigue vendiendo y se avisa en el
 * log): frenar las ventas por un error de lectura en plena pauta es peor que
 * pasarse por uno, que la escuela resuelve.
 *
 * Una lectura por ítem cada 60 s como máximo (lo llaman varias superficies del
 * mismo turno). Nunca lanza.
 */
import { supabase } from '../config/supabase';

/** Los estados que ocupan cupo: los mismos de `_servicio_cupos_vivos`. */
export const ESTADOS_QUE_OCUPAN_CUPO = ['pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado'] as const;

/** Tipos de servicio cuyo `payment_category` es el mismo `kind` del ítem. */
const TIPOS_CON_CATEGORIA_PROPIA: readonly string[] = ['vacacional', 'torneo', 'viaje'];

export interface ItemConCupo {
    id: string;
    kind?: string | null;
    capacity?: number | null;
    created_at?: string | null;
}

/** El cupo configurado (entero > 0) o null = sin límite. Pura. */
export function cupoDelItem(item: Pick<ItemConCupo, 'capacity'> | null | undefined): number | null {
    const n = Number(item?.capacity);
    return item?.capacity !== null && item?.capacity !== undefined && Number.isInteger(n) && n > 0 ? n : null;
}

/** ¿Está lleno? Sin cupo configurado o sin conteo (lectura fallida): no. Pura. */
export function cuposLlenos(cupo: number | null, inscritos: number | null): boolean {
    return cupo !== null && inscritos !== null && inscritos >= cupo;
}

const TTL_MS = 60_000;
const cache = new Map<string, { hasta: number; inscritos: number | null }>();

/** Para las pruebas. */
export function limpiarCacheDeCupos(): void { cache.clear(); }

const ids = (filas: unknown): string[] => (Array.isArray(filas) ? filas : [])
    .map((f: any) => (typeof f?.payment_id === 'string' ? f.payment_id : typeof f?.id === 'string' ? f.id : null))
    .filter((x): x is string => !!x);

/**
 * Cuántos inscritos (cobros vivos) tiene el ítem. null si no se pudo leer. Nunca lanza.
 * Solo tiene sentido llamarla para un ítem con cupo (`cupoDelItem`).
 */
export async function inscritosDelItem(schoolId: string, item: ItemConCupo, ahora = Date.now()): Promise<number | null> {
    const guardado = cache.get(item.id);
    if (guardado && guardado.hasta > ahora) return guardado.inscritos;
    let inscritos: number | null = null;
    try {
        const [sueltos, deComprobante, manuales] = await Promise.all([
            supabase.from('wa_cobros_sueltos').select('payment_id').eq('item_id', item.id).is('anulado_at', null).limit(1000),
            supabase.from('wa_cobros_desde_comprobante').select('payment_id').eq('fuente', 'tournament_item').eq('fuente_id', item.id).limit(1000),
            supabase.from('cobros_servicio_item').select('payment_id').eq('item_id', item.id).is('anulado_at', null).limit(1000),
        ]);
        if (sueltos.error || deComprobante.error || manuales.error) throw new Error('no se pudieron leer los enlaces del ítem');
        const enlazados = [...new Set([...ids(sueltos.data), ...ids(deComprobante.data), ...ids(manuales.data)])];

        const vivos = new Set<string>();
        if (enlazados.length) {
            const r = await supabase.from('payments').select('id')
                .eq('school_id', schoolId)
                .in('id', enlazados).in('status', ESTADOS_QUE_OCUPAN_CUPO as unknown as string[]).limit(1000);
            if (r.error) throw new Error('no se pudieron leer los cobros enlazados');
            for (const id of ids(r.data)) vivos.add(id);
        }

        const kind = String(item.kind ?? '');
        if (TIPOS_CON_CATEGORIA_PROPIA.includes(kind)) {
            const delTipo = await supabase.from('school_tournament_items').select('id')
                .eq('school_id', schoolId).eq('kind', kind).eq('active', true).is('event_id', null).limit(5);
            if (delTipo.error) throw new Error('no se pudieron leer los servicios del tipo');
            // Con dos servicios del mismo tipo la categoría sola no dice de cuál es el cobro: no se suma.
            if (ids(delTipo.data).length === 1) {
                let q = supabase.from('payments').select('id')
                    .eq('school_id', schoolId).eq('payment_category', kind)
                    .in('status', ESTADOS_QUE_OCUPAN_CUPO as unknown as string[]);
                if (item.created_at) q = q.gte('created_at', item.created_at);
                const r = await q.limit(1000);
                if (r.error) throw new Error('no se pudieron leer los cobros por categoría');
                for (const id of ids(r.data)) vivos.add(id);
            }
        }
        inscritos = vivos.size;
    } catch (e: any) {
        console.warn('[wa-cupos] no se pudo contar; la venta sigue abierta', { item: item.id, err: e?.message });
        inscritos = null;
    }
    cache.set(item.id, { hasta: ahora + TTL_MS, inscritos });
    return inscritos;
}

/**
 * Marca `cupos_llenos` en los ítems que tienen cupo y ya lo completaron. Los que no
 * tienen cupo no hacen ninguna lectura. Devuelve los mismos objetos. Nunca lanza.
 */
export async function marcarCuposLlenos<T extends ItemConCupo & { cupos_llenos?: boolean }>(
    schoolId: string, items: T[], ahora = Date.now(),
): Promise<T[]> {
    await Promise.all(items.map(async (it) => {
        const cupo = cupoDelItem(it);
        if (cupo === null) return;
        try {
            it.cupos_llenos = cuposLlenos(cupo, await inscritosDelItem(schoolId, it, ahora));
        } catch {
            it.cupos_llenos = false;
        }
    }));
    return items;
}
