/**
 * auditoria-saldos-a-favor — reglas puras de la retro-auditoría de los saldos a
 * favor automáticos (§8.3 y D7 de docs/specs/seguridad-veredicto-comprobante-plan.md).
 *
 * El trigger `fn_payments_saldo_a_favor_al_aprobar` acredita el sobrante a partir
 * de `payments.ocr_amount`, que hasta el 2026-11-25 podía escribir la familia.
 * Aquí se compara el `ocr_amount` guardado con lo que el servidor lee HOY del
 * mismo archivo. Solo informa: nunca se reversa en automático.
 *
 * El I/O vive en `scripts/auditar-saldos-a-favor.ts`.
 */

/** Diferencia relativa a partir de la cual se marca «revisar». */
export const TOLERANCIA_AUDITORIA = 0.01;

export interface FilaSaldoAFavor {
    ajusteId: string;
    pagoId: string;
    schoolId: string;
    escuela: string;
    /** Quién pagó / a quién es el cobro. Solo para el CSV del scratchpad (tiene nombres de familias). */
    familia: string;
    concepto: string;
    creadoEn: string;
    credito: number;
    montoCobro: number;
    ocrGuardado: number | null;
    fuenteHuella: string | null;
    origen: string;
    receiptUrl: string | null;
    /** Lo que leyó el servidor hoy (solo con --releer). */
    ocrHoy?: number | null;
    /** Por qué no se pudo releer (solo con --releer). */
    errorRelectura?: string | null;
}

export type EstadoAuditoria = 'ok' | 'revisar' | 'sin releer';

export interface Comparacion {
    estado: EstadoAuditoria;
    motivo: string;
    /** |hoy − guardado| / guardado, o null si no hay con qué comparar. */
    diferencia: number | null;
}

/**
 * Compara el monto guardado con el leído hoy. `releido=false` (corrida sin
 * --releer) no compara: solo marca lo que ya se ve raro sin abrir la imagen.
 * Pura.
 */
export function compararLectura(
    f: Pick<FilaSaldoAFavor, 'ocrGuardado' | 'ocrHoy' | 'errorRelectura' | 'fuenteHuella'>,
    releido: boolean,
): Comparacion {
    const guardado = f.ocrGuardado == null ? null : Number(f.ocrGuardado);
    if (guardado == null || !(guardado > 0)) {
        return { estado: 'revisar', motivo: 'hay saldo a favor pero no hay monto leído guardado', diferencia: null };
    }
    if (!releido) {
        return {
            estado: 'sin releer',
            motivo: f.fuenteHuella === 'server_verified' ? 'pendiente de releer' : 'pendiente de releer (la huella no es del servidor)',
            diferencia: null,
        };
    }
    if (f.errorRelectura) return { estado: 'revisar', motivo: `no se pudo leer la imagen: ${f.errorRelectura}`, diferencia: null };
    const hoy = f.ocrHoy == null ? null : Number(f.ocrHoy);
    if (hoy == null || !(hoy > 0)) return { estado: 'revisar', motivo: 'la lectura de hoy no trae monto', diferencia: null };
    const diferencia = Math.abs(hoy - guardado) / guardado;
    if (diferencia > TOLERANCIA_AUDITORIA) {
        return { estado: 'revisar', motivo: `el comprobante dice ${hoy} y se guardó ${guardado}`, diferencia };
    }
    return { estado: 'ok', motivo: 'coincide', diferencia };
}

export const COLUMNAS_CSV = [
    'estado', 'motivo', 'diferencia_pct', 'escuela', 'pago_id', 'familia', 'concepto', 'credito', 'monto_cobro',
    'ocr_guardado', 'ocr_hoy', 'fuente_huella', 'origen', 'creado_en', 'ajuste_id',
] as const;

/** Celda CSV con comillas cuando hace falta (y sin inyección de fórmulas en Excel). Pura. */
export function celdaCsv(v: unknown): string {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV completo (BOM para que Excel respete las tildes). Pura. */
export function aCsv(filas: readonly { fila: FilaSaldoAFavor; cmp: Comparacion }[]): string {
    const lineas = [COLUMNAS_CSV.join(',')];
    for (const { fila: f, cmp } of filas) {
        lineas.push([
            cmp.estado, cmp.motivo, cmp.diferencia == null ? '' : (cmp.diferencia * 100).toFixed(2), f.escuela, f.pagoId,
            f.familia, f.concepto, f.credito, f.montoCobro, f.ocrGuardado ?? '', f.ocrHoy ?? '', f.fuenteHuella ?? 'sin fuente',
            f.origen, f.creadoEn, f.ajusteId,
        ].map(celdaCsv).join(','));
    }
    return '﻿' + lineas.join('\r\n') + '\r\n';
}

export interface ResumenAuditoria {
    creditos: number;
    total: number;
    porEstado: Record<EstadoAuditoria, { n: number; monto: number }>;
    porFuente: Record<string, { n: number; monto: number }>;
    porEscuela: { escuela: string; n: number; monto: number; revisar: number }[];
}

/** Totales por estado, fuente de la huella y escuela. Pura. */
export function resumir(filas: readonly { fila: FilaSaldoAFavor; cmp: Comparacion }[]): ResumenAuditoria {
    const porEstado: ResumenAuditoria['porEstado'] = { ok: { n: 0, monto: 0 }, revisar: { n: 0, monto: 0 }, 'sin releer': { n: 0, monto: 0 } };
    const porFuente: ResumenAuditoria['porFuente'] = {};
    const esc = new Map<string, { escuela: string; n: number; monto: number; revisar: number }>();
    let total = 0;
    for (const { fila: f, cmp } of filas) {
        total += f.credito;
        porEstado[cmp.estado].n++;
        porEstado[cmp.estado].monto += f.credito;
        const fu = f.fuenteHuella ?? 'sin fuente';
        porFuente[fu] ??= { n: 0, monto: 0 };
        porFuente[fu].n++;
        porFuente[fu].monto += f.credito;
        const e = esc.get(f.escuela) ?? { escuela: f.escuela, n: 0, monto: 0, revisar: 0 };
        e.n++;
        e.monto += f.credito;
        if (cmp.estado === 'revisar') e.revisar++;
        esc.set(f.escuela, e);
    }
    return {
        creditos: filas.length, total, porEstado, porFuente,
        porEscuela: [...esc.values()].sort((a, b) => b.monto - a.monto || a.escuela.localeCompare(b.escuela)),
    };
}

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** Resumen en markdown (sin nombres de familias: esos van solo en el CSV). Pura. */
export function resumenMarkdown(r: ResumenAuditoria, releido: boolean, fecha: string): string {
    const l: string[] = [];
    l.push(`# Auditoría de saldos a favor automáticos — ${fecha}`, '');
    l.push(releido
        ? `Modo: **con relectura** (el servidor volvió a leer cada imagen; tolerancia ${TOLERANCIA_AUDITORIA * 100} %).`
        : 'Modo: **sin relectura** (solo datos guardados; la comparación con la imagen requiere `--releer`).', '');
    l.push(`- Créditos: **${r.creditos}** · total **${cop(r.total)}**`);
    for (const [k, v] of Object.entries(r.porEstado)) if (v.n) l.push(`- ${k}: ${v.n} (${cop(v.monto)})`);
    l.push('', '## Por fuente de la huella', '', '| Fuente | Créditos | Monto |', '|---|---|---|');
    for (const [k, v] of Object.entries(r.porFuente).sort((a, b) => b[1].monto - a[1].monto)) l.push(`| ${k} | ${v.n} | ${cop(v.monto)} |`);
    l.push('', '## Por escuela', '', '| Escuela | Créditos | Monto | Revisar |', '|---|---|---|---|');
    for (const e of r.porEscuela) l.push(`| ${e.escuela} | ${e.n} | ${cop(e.monto)} | ${e.revisar} |`);
    l.push('', 'Nada se reversa en automático (D7): los casos «revisar» se ven con cada escuela.', '');
    return l.join('\n');
}
