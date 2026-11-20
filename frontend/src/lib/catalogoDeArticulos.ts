/**
 * Catálogo de Artículos Deportivos de la escuela (`school_merchandise_items`)
 * para el cobro MANUAL («Cobros y pagos»). El acudiente ya lo veía al pagar
 * (PaymentCheckoutModal); la escuela tenía que reescribir nombre y precio de un
 * ítem que ella misma había cargado.
 *
 * La línea del cobro no guarda el id del ítem: lo elegido se deduce del detalle
 * («Guantes» / «Guantes talla M»), así sigue siendo cierto si la escuela edita
 * el texto a mano después de elegir.
 */
import { supabase } from '@/integrations/supabase/client';

export interface ArticuloDeCatalogo {
    id: string;
    name: string;
    price: number;
    /** Tallas en texto libre separadas por coma («S, M, L»), o null. */
    size_options: string | null;
}

export function tallasDe(a: Pick<ArticuloDeCatalogo, 'size_options'>): string[] {
    return (a.size_options ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Detalle del cobro para un ítem: «Guantes» o «Guantes talla M». */
export function conceptoDeArticulo(a: Pick<ArticuloDeCatalogo, 'name'>, talla?: string | null): string {
    return talla ? `${a.name} talla ${talla}` : a.name;
}

/**
 * Qué ítem (y talla) corresponde al detalle escrito en la línea. Con dos ítems
 * que empiezan igual («Guantes» y «Guantes pro») gana el nombre más largo.
 */
export function articuloElegido(
    concept: string | null | undefined,
    items: readonly ArticuloDeCatalogo[],
): { item: ArticuloDeCatalogo; talla: string | null } | null {
    const c = (concept ?? '').trim();
    if (!c) return null;
    const porLargo = [...items].sort((x, y) => y.name.length - x.name.length);
    for (const item of porLargo) {
        if (c === item.name) return { item, talla: null };
        const prefijo = `${item.name} talla `;
        if (c.startsWith(prefijo)) {
            const talla = c.slice(prefijo.length).trim();
            return { item, talla: tallasDe(item).includes(talla) ? talla : null };
        }
    }
    return null;
}

/**
 * Ítems activos del catálogo, o [] si la escuela no tiene el módulo activado
 * (`school_settings.merchandise_enabled`, mismo gate que ve el acudiente).
 * Nunca lanza: sin catálogo el cobro manual sigue funcionando a mano.
 */
export async function cargarArticulosDelCatalogo(schoolId: string): Promise<ArticuloDeCatalogo[]> {
    try {
        const { data: settings } = await supabase.from('school_settings')
            .select('merchandise_enabled').eq('school_id', schoolId).maybeSingle();
        if (!(settings as { merchandise_enabled?: boolean } | null)?.merchandise_enabled) return [];
        const { data: items } = await supabase.from('school_merchandise_items' as never)
            .select('id, name, price, size_options')
            .eq('school_id', schoolId).eq('active', true)
            .order('sort_order', { ascending: true });
        return ((items as unknown as ArticuloDeCatalogo[] | null) ?? [])
            .map((i) => ({ ...i, price: Number(i.price) }));
    } catch {
        return [];
    }
}
