/**
 * Precios de un servicio del catálogo (`school_tournament_items`) con los
 * campos de la migración M2 `comprobantes_con_motivo` (plan maestro §2):
 *
 *   precio_afiliado   numeric   lo que paga quien ya es del club (NULL = el general)
 *   opciones          jsonb     [{clave, etiqueta, precio, precio_afiliado}] («1 semana», «2 semanas»…)
 *   precios_por_fecha jsonb     [{desde: 'YYYY-MM-DD', precio}] desde esa fecha, otro precio general
 *   abono_minimo_pct  smallint  1–100: con cuánto se separa el cupo (NULL = sin abono)
 *
 * Caso que lo pidió (Monster, 2026-10-30): clínica a $250.000 para afiliados,
 * preventa $300.000 y desde el 10 de noviembre $350.000, cupo con el 50 %; y
 * el vacacional con precio por semanas, para afiliados y externos.
 *
 * Regla del precio (la misma que calcula `wa_crear_cobro_desde_comprobante`):
 * con opción manda la opción (su precio de afiliado si es afiliado y lo
 * tiene); sin opción, el precio de afiliado si es afiliado y lo tiene; si no,
 * el precio general vigente en la fecha. El cambio por fecha mueve el precio
 * general, no el de afiliados.
 *
 * Todo es tolerante: un jsonb mal formado o una columna que todavía no existe
 * se leen como «sin ese ajuste», nunca rompen la pantalla.
 */

export interface OpcionDeServicio {
    clave: string;
    etiqueta: string;
    precio: number;
    precio_afiliado: number | null;
}

export interface PrecioPorFecha {
    desde: string;
    precio: number;
}

/** Lo que hace falta de una fila de `school_tournament_items` para ponerle precio. */
export interface ServicioConPrecios {
    price: number;
    precio_afiliado?: number | null;
    opciones?: unknown;
    precios_por_fecha?: unknown;
    abono_minimo_pct?: number | null;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILAS = 12;
const MAX_ETIQUETA = 40;

const esPrecio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const aPrecio = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return esPrecio(n) ? n : null;
};

/** «$250.000», «250000», «250,000» → 250000. Vacío → null. Inválido → NaN. */
export function parsePesos(texto: string): number | null {
    const t = texto.replace(/[$\s]/g, '').replace(/\./g, '').replace(/,/g, '');
    if (!t) return null;
    return /^\d+$/.test(t) ? Number(t) : NaN;
}

/** Fecha real (no solo la forma): «2026-02-30» no pasa. */
function esFechaValida(s: string): boolean {
    if (!FECHA.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseOpciones(raw: unknown): OpcionDeServicio[] {
    if (!Array.isArray(raw)) return [];
    const out: OpcionDeServicio[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        const etiqueta = typeof o.etiqueta === 'string' ? o.etiqueta.trim() : '';
        const precio = aPrecio(o.precio);
        if (!etiqueta || precio === null) continue;
        const clave = typeof o.clave === 'string' && o.clave.trim() ? o.clave.trim() : claveDeEtiqueta(etiqueta);
        if (out.some((x) => x.clave === clave)) continue;
        out.push({ clave, etiqueta, precio, precio_afiliado: aPrecio(o.precio_afiliado) });
    }
    return out;
}

/** Ordenados por fecha; las filas sin fecha válida o sin precio se ignoran. */
export function parsePreciosPorFecha(raw: unknown): PrecioPorFecha[] {
    if (!Array.isArray(raw)) return [];
    const out: PrecioPorFecha[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const o = r as Record<string, unknown>;
        const desde = typeof o.desde === 'string' ? o.desde.slice(0, 10) : '';
        const precio = aPrecio(o.precio);
        if (!esFechaValida(desde) || precio === null || out.some((x) => x.desde === desde)) continue;
        out.push({ desde, precio });
    }
    return out.sort((a, b) => a.desde.localeCompare(b.desde));
}

/** Abono mínimo en % (1–100) o null. */
export function abonoMinimoPct(item: Pick<ServicioConPrecios, 'abono_minimo_pct'>): number | null {
    const n = Number(item.abono_minimo_pct);
    return item.abono_minimo_pct != null && Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** Precio general vigente el día `hoy` (YYYY-MM-DD): el último cambio con `desde` ≤ hoy, o `price`. */
export function precioGeneralEn(item: Pick<ServicioConPrecios, 'price' | 'precios_por_fecha'>, hoy: string): number {
    let precio = Number(item.price) || 0;
    for (const p of parsePreciosPorFecha(item.precios_por_fecha)) {
        if (p.desde <= hoy) precio = p.precio;
    }
    return precio;
}

/** Precio a cobrar. Ver la regla en el encabezado. */
export function precioDeServicio(
    item: ServicioConPrecios,
    { afiliado, hoy, opcion = null }: { afiliado: boolean; hoy: string; opcion?: string | null },
): number {
    const op = opcion ? parseOpciones(item.opciones).find((o) => o.clave === opcion) : undefined;
    if (op) return afiliado && op.precio_afiliado !== null ? op.precio_afiliado : op.precio;
    const deAfiliado = aPrecio(item.precio_afiliado);
    if (afiliado && deAfiliado !== null) return deAfiliado;
    return precioGeneralEn(item, hoy);
}

/** Valor mínimo para separar el cupo (redondeado hacia arriba al peso), o null si no hay abono. */
export function abonoMinimo(precio: number, pct: number | null): number | null {
    if (pct === null || !(precio > 0)) return null;
    return Math.ceil((precio * pct) / 100);
}

/** «1 semana» → «1_semana». Estable: el bot y los cobros la pueden guardar. */
export function claveDeEtiqueta(etiqueta: string): string {
    const base = etiqueta
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        .slice(0, 40);
    return base || 'opcion';
}

// ── Para mostrar ────────────────────────────────────────────────────────────

const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «2026-11-10» → «10 nov» (sin depender del Intl del navegador). */
export function fechaCorta(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const mes = m ? MESES[Number(m[2]) - 1] : undefined;
    return m && mes ? `${Number(m[3])} ${mes}` : iso;
}

/** Lo que se ve de los precios especiales en la lista del catálogo. */
export function etiquetasDePrecios(item: ServicioConPrecios): string[] {
    const out: string[] = [];
    const afiliado = Number(item.precio_afiliado);
    if (item.precio_afiliado != null && Number.isFinite(afiliado)) out.push(`Afiliados ${pesos(afiliado)}`);
    const opciones = parseOpciones(item.opciones);
    if (opciones.length > 0) out.push(opciones.length === 1 ? '1 opción' : `${opciones.length} opciones`);
    for (const p of parsePreciosPorFecha(item.precios_por_fecha)) out.push(`Desde ${fechaCorta(p.desde)}: ${pesos(p.precio)}`);
    const pct = abonoMinimoPct(item);
    if (pct !== null) out.push(`Abono ${pct} %`);
    return out;
}

// ── Formulario del editor ──────────────────────────────────────────────────

export interface FilaOpcion { clave?: string; etiqueta: string; precio: string; precioAfiliado: string }
export interface FilaFecha { desde: string; precio: string }

export interface FormularioDePrecios {
    precioAfiliado: string;
    opciones: FilaOpcion[];
    preciosPorFecha: FilaFecha[];
    abonoPct: string;
}

export interface ColumnasDePrecios {
    precio_afiliado: number | null;
    opciones: OpcionDeServicio[] | null;
    precios_por_fecha: PrecioPorFecha[] | null;
    abono_minimo_pct: number | null;
}

export const FORMULARIO_VACIO: FormularioDePrecios = { precioAfiliado: '', opciones: [], preciosPorFecha: [], abonoPct: '' };

/** Fila guardada → formulario (para editar). */
export function formularioDePrecios(item: Partial<ServicioConPrecios> | null | undefined): FormularioDePrecios {
    if (!item) return { ...FORMULARIO_VACIO, opciones: [], preciosPorFecha: [] };
    const af = aPrecio(item.precio_afiliado);
    const pct = abonoMinimoPct({ abono_minimo_pct: item.abono_minimo_pct ?? null });
    return {
        precioAfiliado: af === null ? '' : String(af),
        opciones: parseOpciones(item.opciones).map((o) => ({
            clave: o.clave,
            etiqueta: o.etiqueta,
            precio: String(o.precio),
            precioAfiliado: o.precio_afiliado === null ? '' : String(o.precio_afiliado),
        })),
        preciosPorFecha: parsePreciosPorFecha(item.precios_por_fecha).map((p) => ({ desde: p.desde, precio: String(p.precio) })),
        abonoPct: pct === null ? '' : String(pct),
    };
}

/**
 * Formulario → columnas de M2, o el primer error en palabras de la escuela.
 * Las filas que quedaron vacías se descartan sin quejarse (un «+ Agregar» de más
 * no debe impedir guardar).
 */
export function columnasDePrecios(f: FormularioDePrecios): { ok: true; columnas: ColumnasDePrecios } | { ok: false; error: string } {
    const precioAfiliado = parsePesos(f.precioAfiliado);
    if (Number.isNaN(precioAfiliado)) return { ok: false, error: 'El precio para afiliados debe ser un número.' };

    const opciones: OpcionDeServicio[] = [];
    for (const fila of f.opciones) {
        const etiqueta = fila.etiqueta.trim();
        const precio = parsePesos(fila.precio);
        const precioAf = parsePesos(fila.precioAfiliado);
        if (!etiqueta && precio === null && precioAf === null) continue;
        if (!etiqueta) return { ok: false, error: 'Cada opción necesita un nombre, p. ej. «1 semana».' };
        if (etiqueta.length > MAX_ETIQUETA) return { ok: false, error: `El nombre «${etiqueta.slice(0, 20)}…» es muy largo (máximo ${MAX_ETIQUETA} letras).` };
        if (precio === null || Number.isNaN(precio)) return { ok: false, error: `Falta el precio de «${etiqueta}».` };
        if (Number.isNaN(precioAf)) return { ok: false, error: `El precio para afiliados de «${etiqueta}» debe ser un número.` };
        if (opciones.some((o) => o.etiqueta.toLowerCase() === etiqueta.toLowerCase())) return { ok: false, error: `La opción «${etiqueta}» está repetida.` };
        let clave = fila.clave?.trim() || claveDeEtiqueta(etiqueta);
        for (let i = 2; opciones.some((o) => o.clave === clave); i++) clave = `${claveDeEtiqueta(etiqueta)}_${i}`;
        opciones.push({ clave, etiqueta, precio, precio_afiliado: precioAf });
    }
    if (opciones.length > MAX_FILAS) return { ok: false, error: `Máximo ${MAX_FILAS} opciones.` };

    const fechas: PrecioPorFecha[] = [];
    for (const fila of f.preciosPorFecha) {
        const desde = fila.desde.trim();
        const precio = parsePesos(fila.precio);
        if (!desde && precio === null) continue;
        if (!esFechaValida(desde)) return { ok: false, error: 'Elige la fecha desde la que cambia el precio.' };
        if (precio === null || Number.isNaN(precio)) return { ok: false, error: `Falta el precio desde el ${desde}.` };
        if (fechas.some((x) => x.desde === desde)) return { ok: false, error: `La fecha ${desde} está repetida.` };
        fechas.push({ desde, precio });
    }
    if (fechas.length > MAX_FILAS) return { ok: false, error: `Máximo ${MAX_FILAS} cambios de precio.` };
    fechas.sort((a, b) => a.desde.localeCompare(b.desde));

    let abono: number | null = null;
    if (f.abonoPct.trim()) {
        const n = Number(f.abonoPct.trim().replace('%', ''));
        if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false, error: 'El abono debe ser un porcentaje entre 1 y 100.' };
        abono = n;
    }

    return {
        ok: true,
        columnas: {
            precio_afiliado: precioAfiliado,
            opciones: opciones.length > 0 ? opciones : null,
            precios_por_fecha: fechas.length > 0 ? fechas : null,
            abono_minimo_pct: abono,
        },
    };
}
