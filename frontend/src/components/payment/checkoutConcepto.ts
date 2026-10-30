/**
 * «Tipo de Pago» del modal del acudiente (PaymentCheckoutModal, mode='create'),
 * derivado del catálogo único de motivos (lib/motivosDeCobro.ts, plan B4 T5).
 *
 * Antes el modal tenía 6 conceptos fijos y cargaba TODOS los ítems de
 * `school_tournament_items` bajo «Torneos», cobrándolos como 'torneo' (bug L8):
 * una clínica (`clase_extra`) o un viaje quedaban mal categorizados en caja,
 * en el filtro de Pagos y en las llaves restringidas (`only_for`). Ahora cada
 * tipo de servicio presente en el catálogo es su propia opción y el cobro sale
 * con su `kind`: un solo tipo por pago.
 */
import {
    TIPOS_DE_SERVICIO,
    definicionDeMotivo,
    esTipoDeServicio,
    exentoDeUnicidadDePeriodo,
    type MotivoDeCobro,
    type TipoDeServicio,
} from '@/lib/motivosDeCobro';
import { parseOpciones, precioDeServicio, type OpcionDeServicio, type ServicioConPrecios } from '@/lib/preciosDeServicio';

export type ConceptoDeServicio = `servicio:${TipoDeServicio}`;
export type ConceptoCheckout =
    | 'mensualidad' | 'inscripcion_fija' | 'inscripcion_variable' | 'otro' | 'articulos'
    | ConceptoDeServicio;

/** Lo que acepta `initialConceptType`: cualquier motivo, o las dos inscripciones de siempre. */
export type ConceptoInicial = MotivoDeCobro | 'inscripcion_fija' | 'inscripcion_variable';

const PREFIJO_SERVICIO = 'servicio:';

export const esConceptoDeServicio = (c: ConceptoCheckout): c is ConceptoDeServicio => c.startsWith(PREFIJO_SERVICIO);

export const tipoDeServicioDe = (c: ConceptoCheckout): TipoDeServicio | null =>
    esConceptoDeServicio(c) ? (c.slice(PREFIJO_SERVICIO.length) as TipoDeServicio) : null;

/** ¿Se arma con un carrito (artículos o ítems del catálogo de servicios)? */
export const esConceptoDeCarrito = (c: ConceptoCheckout): boolean => c === 'articulos' || esConceptoDeServicio(c);

/** Motivo (`payments.payment_category`) del concepto elegido. */
export function motivoDelConcepto(c: ConceptoCheckout): MotivoDeCobro {
    const tipo = tipoDeServicioDe(c);
    if (tipo) return tipo;
    if (c === 'inscripcion_fija' || c === 'inscripcion_variable') return 'inscripcion';
    return c as 'mensualidad' | 'otro' | 'articulos';
}

/** `payment_category` y `period_uniqueness_exempt` del cobro que el modal inserta, desde el catálogo. */
export function camposDeCategoria(c: ConceptoCheckout): { payment_category: MotivoDeCobro; period_uniqueness_exempt: boolean } {
    const motivo = motivoDelConcepto(c);
    return { payment_category: motivo, period_uniqueness_exempt: exentoDeUnicidadDePeriodo(motivo) };
}

export interface DisponibilidadCheckout {
    /** Concepto de la mensualidad que trae el modal («Plan Sub-12»). */
    conceptoMensualidad: string;
    /** Tarifa del plan (prop `amount`): sin ella no hay «Inscripción (Monto Fijo)». */
    montoPlan: number;
    /** `school_settings.allow_installments`: monto variable y abono libre. */
    permiteAbonos: boolean;
    hayArticulos: boolean;
    /** Tipos con al menos un ítem activo en el catálogo de servicios. */
    tiposDeServicio: readonly TipoDeServicio[];
}

export interface OpcionDeConcepto { value: ConceptoCheckout; label: string }

/**
 * Opciones del selector, en el orden de siempre (mensualidad, inscripción, otro,
 * artículos, servicios). Solo motivos con `enSubidaAcudiente`; un servicio sale
 * únicamente si la escuela tiene ítems de ese tipo.
 */
export function opcionesDeCheckout(d: DisponibilidadCheckout): OpcionDeConcepto[] {
    const ofrece = (m: MotivoDeCobro) => definicionDeMotivo(m).enSubidaAcudiente;
    const out: OpcionDeConcepto[] = [];
    if (ofrece('mensualidad')) out.push({ value: 'mensualidad', label: `Mensualidad (${d.conceptoMensualidad})` });
    // Inscripción de monto fijo solo con tarifa; monto variable y abono libre
    // solo si la escuela recibe abonos (allow_installments). Una escuela sin
    // abonos (Dynasty) no debe dejar que la familia invente un cobro ni un valor.
    if (ofrece('inscripcion') && d.montoPlan > 0) out.push({ value: 'inscripcion_fija', label: 'Inscripción Anual (Monto Fijo)' });
    if (ofrece('inscripcion') && d.permiteAbonos) out.push({ value: 'inscripcion_variable', label: 'Inscripción Anual (Monto Variable)' });
    if (ofrece('otro') && d.permiteAbonos) out.push({ value: 'otro', label: 'Otro Concepto / Abono libre' });
    if (ofrece('articulos') && d.hayArticulos) out.push({ value: 'articulos', label: 'Artículos Deportivos' });
    for (const tipo of TIPOS_DE_SERVICIO) {
        const def = definicionDeMotivo(tipo);
        if (def.enSubidaAcudiente && def.servicio && d.tiposDeServicio.includes(tipo)) {
            out.push({ value: `servicio:${tipo}`, label: def.servicio.grupo });
        }
    }
    return out;
}

/**
 * Concepto con el que abre el modal cuando se entra por un enlace de cobro
 * (`initialConceptType`), antes de saber qué ofrece la escuela. Los motivos que
 * la familia no crea desde la app (seguro, horas, reserva, clase de prueba)
 * abren en la mensualidad, como siempre.
 */
export function conceptoInicial(m: ConceptoInicial | null | undefined, montoPlan: number): ConceptoCheckout {
    if (!m) return 'mensualidad';
    if (m === 'inscripcion_fija' || m === 'inscripcion_variable') return m;
    if (m === 'inscripcion') return montoPlan > 0 ? 'inscripcion_fija' : 'inscripcion_variable';
    if (!definicionDeMotivo(m).enSubidaAcudiente) return 'mensualidad';
    if (m === 'mensualidad' || m === 'articulos' || m === 'otro') return m;
    if (esTipoDeServicio(m)) return `servicio:${m}`;
    return 'mensualidad';
}

/** Equivalente cuando el pedido no está: la otra inscripción, o los servicios «otro». */
const ALTERNATIVA: Partial<Record<ConceptoCheckout, ConceptoCheckout>> = {
    inscripcion_fija: 'inscripcion_variable',
    inscripcion_variable: 'inscripcion_fija',
    otro: 'servicio:otro',
};

/**
 * Ya cargado lo que ofrece la escuela: el concepto si está; si no, su
 * equivalente; si tampoco, la primera opción (la mensualidad). Nunca deja el
 * selector apuntando a algo que no se puede pagar.
 */
export function conceptoDisponible(c: ConceptoCheckout, opciones: readonly OpcionDeConcepto[]): ConceptoCheckout {
    const hay = (x: ConceptoCheckout | undefined) => !!x && opciones.some((o) => o.value === x);
    if (hay(c)) return c;
    const alt = ALTERNATIVA[c];
    if (alt && hay(alt)) return alt;
    return opciones[0]?.value ?? 'mensualidad';
}

// ── Carrito de servicios ────────────────────────────────────────────────────

export interface ItemDeServicio extends ServicioConPrecios {
    id: string;
    name: string;
    kind: TipoDeServicio;
}

export type SeleccionDeServicios = Record<string, { qty: number; opcion: string | null }>;

export interface LineaDeServicio {
    item: ItemDeServicio;
    qty: number;
    opcion: OpcionDeServicio | null;
    /** Precio unitario ya resuelto (opción, afiliado, fecha). */
    precio: number;
}

/**
 * Fila cruda de `school_tournament_items` → ítem del modal. Sin `kind` (columna
 * de F0 sin aplicar) es un torneo, como se cobraba antes.
 */
export function itemDeServicio(row: Record<string, unknown>): ItemDeServicio {
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        price: Number(row.price) || 0,
        kind: esTipoDeServicio(row.kind) ? row.kind : row.kind == null ? 'torneo' : 'otro',
        precio_afiliado: row.precio_afiliado == null ? null : Number(row.precio_afiliado),
        opciones: row.opciones ?? null,
        precios_por_fecha: row.precios_por_fecha ?? null,
        abono_minimo_pct: row.abono_minimo_pct == null ? null : Number(row.abono_minimo_pct),
    };
}

export const tiposConItems = (catalogo: readonly ItemDeServicio[]): TipoDeServicio[] =>
    TIPOS_DE_SERVICIO.filter((t) => catalogo.some((it) => it.kind === t));

/** La opción con que nace la selección de un ítem: la primera, si tiene. */
export const opcionInicial = (item: ItemDeServicio): string | null => parseOpciones(item.opciones)[0]?.clave ?? null;

/**
 * Las líneas elegidas DEL TIPO en pantalla. Lo elegido en otro tipo no cuenta:
 * un pago es de un solo `kind`.
 */
export function lineasDeServicio(
    catalogo: readonly ItemDeServicio[],
    seleccion: SeleccionDeServicios,
    tipo: TipoDeServicio | null,
    { afiliado, hoy }: { afiliado: boolean; hoy: string },
): LineaDeServicio[] {
    if (!tipo) return [];
    return catalogo
        .filter((it) => it.kind === tipo && seleccion[it.id])
        .map((item) => {
            const sel = seleccion[item.id];
            const opciones = parseOpciones(item.opciones);
            const opcion = opciones.find((o) => o.clave === sel.opcion) ?? opciones[0] ?? null;
            return { item, qty: sel.qty, opcion, precio: precioDeServicio(item, { afiliado, hoy, opcion: opcion?.clave ?? null }) };
        });
}

export const totalDeServicios = (lineas: readonly LineaDeServicio[]): number =>
    lineas.reduce((s, l) => s + l.precio * l.qty, 0);

/** «Torneos: Copa Halloween x1», «Vacacionales: Vacacional Suba (2 semanas) x1». */
export function conceptoDeServicios(tipo: TipoDeServicio, lineas: readonly LineaDeServicio[]): string {
    const grupo = definicionDeMotivo(tipo).servicio?.grupo ?? definicionDeMotivo(tipo).etiqueta;
    const texto = lineas.map((l) => `${l.item.name}${l.opcion ? ` (${l.opcion.etiqueta})` : ''} x${l.qty}`).join(', ');
    return `${grupo}: ${texto || 'sin seleccionar'}`;
}

/**
 * Corre las consultas en orden y se queda con la primera que no falle. Sirve
 * para pedir columnas que quizás todavía no existen (migración sin aplicar):
 * PostgREST responde 400 y se pide la versión anterior.
 */
export async function primeraQueResponda<T>(
    consultas: readonly (() => PromiseLike<{ data: T | null; error: unknown }>)[],
): Promise<T | null> {
    for (const consulta of consultas) {
        const { data, error } = await consulta();
        if (!error) return data;
    }
    return null;
}
