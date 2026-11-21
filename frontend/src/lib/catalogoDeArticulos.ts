/**
 * Catálogo de Artículos Deportivos de la escuela (`school_merchandise_items`)
 * para el cobro MANUAL («Cobros y pagos»). El acudiente ya lo veía al pagar
 * (PaymentCheckoutModal); la escuela tenía que reescribir nombre y precio de un
 * ítem que ella misma había cargado.
 *
 * La línea del cobro no guarda el id del ítem ni la cantidad: se deducen del detalle
 * («Guantes» / «Guantes talla M» / «Guantes talla M x2»), así sigue siendo cierto si la escuela edita
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

export const CANTIDAD_MAXIMA = 99;

/** Cantidad válida: entero entre 1 y 99. */
export function cantidadValida(n: number): number {
    return Math.min(CANTIDAD_MAXIMA, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));
}

/** Detalle del cobro para un ítem: «Guantes», «Guantes talla M» o «Guantes talla M x2». */
export function conceptoDeArticulo(a: Pick<ArticuloDeCatalogo, 'name'>, talla?: string | null, cantidad = 1): string {
    const base = talla ? `${a.name} talla ${talla}` : a.name;
    return cantidad > 1 ? `${base} x${cantidadValida(cantidad)}` : base;
}

/**
 * Valor de la línea al cambiar la cantidad. Parte del valor unitario que la
 * línea ya tiene (así respeta un precio que la escuela haya editado); sin
 * valor escrito usa el precio del catálogo.
 */
export function valorPorCantidad(
    amount: number | null | undefined, cantidadActual: number, cantidadNueva: number, precioCatalogo: number,
): number {
    const unitario = amount != null && amount > 0 ? amount / cantidadValida(cantidadActual) : precioCatalogo;
    return Math.round(unitario * cantidadValida(cantidadNueva));
}

/**
 * Qué ítem (y talla) corresponde al detalle escrito en la línea. Con dos ítems
 * que empiezan igual («Guantes» y «Guantes pro») gana el nombre más largo.
 */
export function articuloElegido(
    concept: string | null | undefined,
    items: readonly ArticuloDeCatalogo[],
): { item: ArticuloDeCatalogo; talla: string | null; cantidad: number } | null {
    const completo = (concept ?? '').trim();
    if (!completo) return null;
    const porLargo = [...items].sort((x, y) => y.name.length - x.name.length);
    // Primero el texto tal cual (un ítem puede llamarse «Pack x2»); después sin el « xN» final.
    const conCantidad = completo.match(/^(.*\S) x(\d{1,2})$/);
    const lecturas: { texto: string; cantidad: number }[] = [{ texto: completo, cantidad: 1 }];
    if (conCantidad && Number(conCantidad[2]) >= 1) lecturas.push({ texto: conCantidad[1], cantidad: Number(conCantidad[2]) });
    // 1) Coincidencia exacta: el nombre solo, o el nombre con una talla que el ítem sí tiene.
    for (const { texto, cantidad } of lecturas) {
        for (const item of porLargo) {
            if (texto === item.name) return { item, talla: null, cantidad };
            const prefijo = `${item.name} talla `;
            if (texto.startsWith(prefijo) && tallasDe(item).includes(texto.slice(prefijo.length).trim())) {
                return { item, talla: texto.slice(prefijo.length).trim(), cantidad };
            }
        }
    }
    // 2) El ítem con una talla escrita a mano que no está en su lista: se reconoce el ítem, sin talla.
    for (const { texto, cantidad } of [...lecturas].reverse()) {
        for (const item of porLargo) {
            if (texto.startsWith(`${item.name} talla `)) return { item, talla: null, cantidad };
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
