/**
 * CSV para Excel en español (Colombia).
 *
 * Excel en es-CO abre un .csv con doble clic usando el separador de lista del
 * sistema, que es `;` (la coma es el separador decimal). Con `,` todo caía en
 * la columna A, y sin BOM los acentos salían como "CategorÃ­a". Reglas:
 *   · BOM UTF-8 al inicio (U+FEFF) para que Excel detecte la codificación.
 *   · Separador `;`, fin de línea CRLF.
 *   · Comillas dobles alrededor de toda celda con `;`, comillas, saltos de
 *     línea o espacios en los bordes; las comillas internas se duplican.
 *   · Números: sin separador de miles, decimal con coma (1234,5). Excel los
 *     reconoce como número y se pueden sumar.
 *   · Texto que empieza por = + - @ (o tab/CR) se antepone con ' para que Excel
 *     no lo ejecute como fórmula (inyección CSV: el concepto lo escribe un usuario).
 */

import { chargeCategoryOf } from '../payment-accounts';

export type CsvCell = string | number | null | undefined;

export const CSV_SEPARATOR = ';';
export const CSV_BOM = '\uFEFF';

function formatNumber(n: number): string {
    if (!Number.isFinite(n)) return '';
    // Sin notación científica ni separador de miles; decimal con coma.
    const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
    return s.replace('.', ',');
}

export function csvCell(value: CsvCell): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return formatNumber(value);
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (s.includes(CSV_SEPARATOR) || s.includes('"') || s.includes('\n') || s.includes('\r') || s !== s.trim()) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/** Arma el contenido completo (con BOM). Cada fila es un arreglo de celdas. */
export function buildCsv(rows: CsvCell[][]): string {
    return CSV_BOM + rows.map((r) => r.map(csvCell).join(CSV_SEPARATOR)).join('\r\n') + '\r\n';
}

/** Descarga el CSV en el navegador. */
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
    const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ─── Libro de caja línea por línea ───────────────────────────────────────────

export interface LedgerExportLine {
    date: string | null;            // YYYY-MM-DD (date de la base) o null
    tercero: string | null;
    concept: string;
    category: string | null;
    method: string | null;
    reference: string | null;
    direction: 'income' | 'expense';
    amount: number;
}

const METHOD_LABEL: Record<string, string> = {
    transfer: 'Transferencia', cash: 'Efectivo', card: 'Tarjeta', pse: 'PSE', other: 'Otro',
    nequi: 'Nequi', daviplata: 'Daviplata', wompi: 'Wompi', mercadopago: 'Mercado Pago',
};

/** payments.payment_category (CHECK de la base, payments_payment_category_check) → etiqueta. */
export const INCOME_CATEGORY_LABEL: Record<string, string> = {
    mensualidad: 'Mensualidad', inscripcion: 'Inscripción', articulos: 'Artículos', torneo: 'Torneo', otro: 'Otro',
    seguro: 'Seguro', excedente: 'Horas adicionales', clase_extra: 'Clase extra', vacacional: 'Vacacional',
    viaje: 'Viaje', clase_prueba: 'Clase de prueba',
};

/**
 * Categoría de un INGRESO del libro, para la columna «Categoría».
 *
 * `payment_category` manda. Sin ella (las mensualidades generadas por el cron
 * y los cobros viejos la tienen NULL) se deduce del concepto con la misma regla
 * que usa el resto de la app (`chargeCategoryOf`): antes la celda quedaba vacía
 * y en el Excel no se distinguía la mensualidad de la inscripción o el seguro.
 * Sin nada reconocible, vacía (no se inventa «Mensualidad»).
 */
export function incomeCategoryLabel(
    paymentCategory: string | null | undefined,
    concept: string | null | undefined,
): string | null {
    if (paymentCategory && paymentCategory !== 'otro') {
        return INCOME_CATEGORY_LABEL[paymentCategory] ?? paymentCategory;
    }
    const inferred = chargeCategoryOf(paymentCategory, concept);
    return inferred ? (INCOME_CATEGORY_LABEL[inferred] ?? inferred) : null;
}

export function methodLabel(m: string | null | undefined): string {
    if (!m) return '';
    return METHOD_LABEL[m] ?? m;
}

/** `2026-10-05` → `05/10/2026` (sin pasar por Date: un `date` no tiene zona). */
export function isoDateToCo(d: string | null): string {
    if (!d) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
}

export const LEDGER_CSV_HEADER = ['Fecha', 'Tercero', 'Concepto', 'Categoría', 'Método', 'Referencia', 'Entrada', 'Salida'];

export function ledgerCsvRows(lines: LedgerExportLine[]): CsvCell[][] {
    let entradas = 0, salidas = 0;
    const body: CsvCell[][] = lines.map((l) => {
        const amt = Number(l.amount) || 0;
        if (l.direction === 'income') entradas += amt; else salidas += amt;
        return [
            isoDateToCo(l.date),
            l.tercero ?? '',
            l.concept,
            l.category ?? '',
            methodLabel(l.method),
            l.reference ?? '',
            l.direction === 'income' ? amt : null,
            l.direction === 'expense' ? amt : null,
        ];
    });
    return [LEDGER_CSV_HEADER, ...body, ['', '', 'TOTAL', '', '', '', entradas, salidas]];
}

// ─── Tienda escolar (migración 20261013170548) ───────────────────────────────

/** Etiqueta de la línea de tienda en el libro exportado y en el EdR. */
export const STORE_SALES_LABEL = 'Ventas de tienda';

/**
 * Ventas cobradas de la tienda → líneas de ingreso del libro exportado. La
 * tienda no está en cash_ledger (contrato §6): se agrega aquí, con su neto de
 * reembolsos, para que el CSV cuadre con el indicador de ingresos.
 */
export function storeLinesToLedgerExport(lines: Array<{
    paid_date: string; reference: string | null; payment_method: string | null; income_amount: number | string;
}>): LedgerExportLine[] {
    return lines
        .filter((l) => Number(l.income_amount) > 0)
        .map((l) => ({
            date: l.paid_date,
            tercero: null,
            concept: l.reference ? `Venta tienda ${l.reference}` : 'Venta tienda',
            category: STORE_SALES_LABEL,
            method: l.payment_method,
            reference: l.reference,
            direction: 'income' as const,
            amount: Number(l.income_amount),
        }));
}

/** Orden del libro: fecha DESC, sin fecha al final (igual que finance_ledger_page). */
export function sortLedgerExport(lines: LedgerExportLine[]): LedgerExportLine[] {
    return [...lines].sort((a, b) => {
        if (a.date === b.date) return 0;
        if (a.date === null) return 1;
        if (b.date === null) return -1;
        return a.date < b.date ? 1 : -1;
    });
}

export interface PnlCsvInput {
    year: number;
    income: number;
    expense: number;
    net: number;
    catRows: Array<{ name: string; value: number }>;
    monthly: Array<{ month: string; ingresos: number; egresos: number; cobros?: number; tienda?: number }>;
    /** null = la escuela no tiene tienda: el CSV sale igual que antes. */
    store: { cobros: number; tienda: number } | null;
}

/** CSV del estado de resultados. Con tienda: desglose Mensualidades y cobros / Ventas de tienda. */
export function pnlCsvRows(r: PnlCsvInput): CsvCell[][] {
    const resumen: CsvCell[][] = r.store
        ? [
            ['Ingresos — Mensualidades y cobros', r.store.cobros],
            [`Ingresos — ${STORE_SALES_LABEL}`, r.store.tienda],
            ['Ingresos', r.income],
        ]
        : [['Ingresos', r.income]];
    const flujo: CsvCell[][] = r.store
        ? [
            ['Mes', 'Mensualidades y cobros', STORE_SALES_LABEL, 'Ingresos', 'Egresos', 'Neto'],
            ...r.monthly.map((m): CsvCell[] => [m.month, m.cobros ?? 0, m.tienda ?? 0, m.ingresos, m.egresos, m.ingresos - m.egresos]),
        ]
        : [
            ['Mes', 'Ingresos', 'Egresos', 'Neto'],
            ...r.monthly.map((m): CsvCell[] => [m.month, m.ingresos, m.egresos, m.ingresos - m.egresos]),
        ];
    return [
        [`Estado de resultados ${r.year}`],
        [],
        ['RESUMEN'],
        ...resumen,
        ['Egresos', r.expense],
        ['Neto', r.net],
        [],
        ['EGRESOS POR CATEGORÍA'],
        ['Categoría', 'Monto'],
        ...r.catRows.map((c): CsvCell[] => [c.name, c.value]),
        [],
        ['FLUJO MENSUAL'],
        ...flujo,
    ];
}
