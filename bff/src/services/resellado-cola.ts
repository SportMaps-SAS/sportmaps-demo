/**
 * resellado-cola — reglas puras del Paso 4 de
 * docs/specs/seguridad-veredicto-comprobante-plan.md: qué cobros de la cola
 * «por validar» hay que volver a sellar con el servidor antes de levantar la
 * pausa de «Aprobar todos los verdes».
 *
 * El I/O vive en `scripts/resellar-cola-comprobantes.ts`; aquí solo lo que se
 * puede probar sin base.
 */
import { rutaDelComprobante } from './comprobante-sellado.service';

/** Columnas que lee el script (una sola consulta a la cola). */
export const COLUMNAS_RESELLADO = 'id, school_id, status, receipt_url, receipt_verdict, receipt_image_sha256_source, '
    + 'amount_source, amount, receipt_submitted_at, created_at';

export interface FilaResellado {
    id: string;
    school_id: string | null;
    status: string;
    receipt_url: string | null;
    receipt_verdict: string | null;
    receipt_image_sha256_source: string | null;
    amount_source?: string | null;
    amount?: number | null;
    receipt_submitted_at?: string | null;
    created_at?: string | null;
}

/**
 * Lo que haría `sellarComprobante(id, { sistema: true })` con la fila:
 * - `sellar`: descarga, UNA lectura OCR, veredicto y `evaluatePaymentReceipt`.
 * - `compartido`: otro cobro vivo tiene el mismo archivo; no se lee (el sellado es del principal).
 * - `ruta_invalida`: `receipt_url` no es una ruta del bucket; queda amarillo «lectura fallida», sin OCR.
 */
export type AccionResellado = 'sellar' | 'compartido' | 'ruta_invalida';

/**
 * ¿Entra al re-sellado? Por validar, con comprobante y sin sello del servidor
 * (`receipt_image_sha256_source` distinto de 'server_verified' o NULL). Pura.
 */
export function necesitaResellado(f: Pick<FilaResellado, 'status' | 'receipt_url' | 'receipt_image_sha256_source'>): boolean {
    return f.status === 'awaiting_approval'
        && typeof f.receipt_url === 'string' && f.receipt_url.trim() !== ''
        && f.receipt_image_sha256_source !== 'server_verified';
}

/** Clave `escuela|ruta` de los archivos que usa otro cobro vivo (lo calcula el script). */
export const claveArchivo = (schoolId: string | null, receiptUrl: string) => `${schoolId ?? ''}|${receiptUrl}`;

/** Qué haría el sellado con la fila. `compartidos` = claves de archivos con otro cobro vivo. Pura. */
export function accionDeResellado(f: FilaResellado, compartidos: ReadonlySet<string>): AccionResellado {
    const ruta = rutaDelComprobante(f.receipt_url);
    if (!ruta) return 'ruta_invalida';
    if (compartidos.has(claveArchivo(f.school_id, ruta))) return 'compartido';
    return 'sellar';
}

export interface PlanResellado {
    fila: FilaResellado;
    accion: AccionResellado;
}

/**
 * Filtra la cola, clasifica cada fila y la ordena de la más vieja a la más
 * nueva (así un `--limite` corto sella primero lo que lleva más esperando). Pura.
 */
export function planDeResellado(filas: readonly FilaResellado[], compartidos: ReadonlySet<string>): PlanResellado[] {
    return filas
        .filter(necesitaResellado)
        .map((fila) => ({ fila, accion: accionDeResellado(fila, compartidos) }))
        .sort((a, b) => entrada(a.fila).localeCompare(entrada(b.fila)) || a.fila.id.localeCompare(b.fila.id));
}

const entrada = (f: FilaResellado) => f.receipt_submitted_at ?? f.created_at ?? '';

export interface ConteoEscuela {
    schoolId: string;
    total: number;
    /** Gastan una lectura OCR cada uno. */
    sellar: number;
    compartido: number;
    rutaInvalida: number;
    porVeredicto: Record<string, number>;
    porFuente: Record<string, number>;
}

/** Conteo por escuela, de más a menos cobros. Pura. */
export function conteoPorEscuela(plan: readonly PlanResellado[]): ConteoEscuela[] {
    const out = new Map<string, ConteoEscuela>();
    for (const { fila, accion } of plan) {
        const id = fila.school_id ?? '(sin escuela)';
        const c = out.get(id) ?? { schoolId: id, total: 0, sellar: 0, compartido: 0, rutaInvalida: 0, porVeredicto: {}, porFuente: {} };
        c.total++;
        if (accion === 'sellar') c.sellar++;
        else if (accion === 'compartido') c.compartido++;
        else c.rutaInvalida++;
        const v = fila.receipt_verdict ?? 'sin veredicto';
        c.porVeredicto[v] = (c.porVeredicto[v] ?? 0) + 1;
        const s = fila.receipt_image_sha256_source ?? 'sin fuente';
        c.porFuente[s] = (c.porFuente[s] ?? 0) + 1;
        out.set(id, c);
    }
    return [...out.values()].sort((a, b) => b.total - a.total || a.schoolId.localeCompare(b.schoolId));
}

/** Los que se sellarían en esta corrida: solo `sellar`, como máximo `limite`. Pura. */
export function loteDeEstaCorrida(plan: readonly PlanResellado[], limite: number): PlanResellado[] {
    const n = Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : 0;
    return plan.filter((p) => p.accion === 'sellar').slice(0, n);
}

/** `--limite` y `--pausa-ms` con sus valores por defecto (10 y 4000). Pura. */
export function opcionesResellado(argv: readonly string[]): { aplicar: boolean; escuela: string | null; limite: number; pausaMs: number } {
    const valor = (n: string) => {
        const i = argv.indexOf(n);
        return i >= 0 ? argv[i + 1] ?? null : null;
    };
    const entero = (s: string | null, porDefecto: number) => {
        const n = s == null ? NaN : Number(s);
        return Number.isInteger(n) && n >= 0 ? n : porDefecto;
    };
    return {
        aplicar: argv.includes('--aplicar'),
        escuela: valor('--escuela'),
        limite: entero(valor('--limite'), 10),
        pausaMs: entero(valor('--pausa-ms'), 4000),
    };
}
