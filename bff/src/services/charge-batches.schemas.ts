/**
 * zod del modal «Cobros y pagos» (spec docs/specs/cobros-multiples.md §9.2).
 *
 * El BFF NO calcula montos: valida forma, topes y reglas que no dependen de la
 * base (Q10, §15.4 en lo que se puede decir sin leer la fila) y manda las
 * decisiones a la RPC, que calcula la vista previa y el create con la misma
 * función (§7.2). Todo lo que depende de datos vivos (duplicados, saldo,
 * recargo, piso de lo pagado) lo decide la RPC y vuelve como código de error.
 *
 * Las fechas «hoy» son de Bogotá (todayInZone), igual que la RPC (D7).
 */
import { z } from 'zod';
import { CATEGORIAS_COBRO } from './payment-accounts';
import { todayInZone, addDaysToDateString } from '../utils/businessDate';

// ─── Topes (Q10) ─────────────────────────────────────────────────────────────
export const MAX_ATLETAS_POR_LOTE = 200;
export const MAX_FILAS_POR_LOTE = 600;
export const MAX_LINEAS = 10;
export const MAX_PENDIENTES = 24;
export const MAX_MONTO = 20_000_000;
/** Mensualidad adelantada: hasta 3 meses (Q4). Mes pasado: hasta 12 (§7.3 paso 3). */
export const MESES_ADELANTE = 3;
export const MESES_ATRAS = 12;

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fecha = () => z.string().regex(FECHA, 'Fecha con formato AAAA-MM-DD');
const uuid = () => z.string().uuid('Identificador inválido');

/** Motivos que el personal puede elegir (el catálogo de la tabla menos `descuento_alta`, que es del sistema). */
export const MOTIVOS_DESCUENTO = [
    'pronto_pago', 'varios_meses', 'hermanos', 'beca', 'convenio', 'cortesia',
    'ajuste_de_precio', 'error_de_cobro', 'condonacion_mora', 'otro',
] as const;
export const Motivo = z.enum(MOTIVOS_DESCUENTO);

/** Índice de mes absoluto (año*12 + mes-1) para comparar períodos. */
const mesAbs = (y: number, m: number) => y * 12 + (m - 1);

export const Descuento = z.object({
    basis: z.enum(['porcentaje', 'valor']),
    value: z.number().positive('El descuento debe ser mayor que cero'),
    reason_code: Motivo,
    reason_text: z.string().trim().min(3, 'El motivo debe tener al menos 3 caracteres').max(300).optional(),
}).superRefine((d, ctx) => {
    if (d.basis === 'porcentaje' && d.value > 100) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'El porcentaje no puede ser mayor que 100' });
    }
    if (d.basis === 'valor' && d.value > MAX_MONTO) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'El descuento no puede superar $20.000.000' });
    }
    if (d.reason_code === 'otro' && !d.reason_text) {
        ctx.addIssue({ code: 'custom', path: ['reason_text'], message: 'Escribe el motivo cuando eliges «Otro»' });
    }
});
export type DescuentoInput = z.infer<typeof Descuento>;

const Exoneracion = z.object({
    reason_text: z.string().trim().min(3, 'Escribe por qué no se cobra (mínimo 3 caracteres)').max(300),
});

export const Linea = z.object({
    category: z.enum(CATEGORIAS_COBRO),
    /** Ausente en mensualidad = el monto sugerido por atleta (D4). */
    amount: z.number().positive('El valor debe ser mayor que cero').max(MAX_MONTO, 'El valor no puede superar $20.000.000').optional(),
    due_date: fecha(),
    concept: z.string().trim().min(1, 'Escribe el concepto').max(120),
    notes: z.string().trim().max(500).optional(),
    period: z.object({
        year: z.number().int().min(2020).max(2100),
        month: z.number().int().min(1).max(12),
    }).optional(),
    enrollment_id: uuid().optional(),
    fee_id: uuid().optional(),
    overage_charge_id: uuid().optional(),
    /**
     * Horas adicionales VENDIDAS por adelantado (Dreamers, 2026-10-21): en vez de
     * facturar un excedente que el cron ya calculó, la familia compra N horas. Se
     * cobra como `clase_extra` y, ya pagado, el BFF las suma al banco del
     * `enrollment_id` (RPC grant_hour_bank_minutes). Múltiplos de 15 min.
     */
    extra_hours: z.number().positive('Las horas deben ser mayores que cero').max(24, 'Máximo 24 horas por venta').optional(),
    discount: Descuento.optional(),
    exonerate: Exoneracion.optional(),
    /**
     * Solo modo un atleta con «Ya lo pagaron»: cuánto se recibió de ESTA línea
     * nueva (§7.3 paso 9d, caso mixto T20 «torneo pagado + mensualidad sin
     * pagar»). Ausente o 0 = la línea nace pendiente. §9.2 no lo nombra en
     * `Linea`; ver «Contrato BFF ↔ RPC» en el informe de F2.
     */
    pay_amount: z.number().nonnegative().max(MAX_MONTO).optional(),
    close_mode: z.enum(['cerrar', 'abono']).optional(),
}).superRefine((l, ctx) => {
    const hoy = todayInZone();
    if (l.due_date < hoy) {
        ctx.addIssue({ code: 'custom', path: ['due_date'], message: 'Un cobro nuevo no puede nacer vencido: el vencimiento debe ser hoy o después' });
    }
    if (l.category === 'mensualidad') {
        if (!l.period) {
            ctx.addIssue({ code: 'custom', path: ['period'], message: 'La mensualidad necesita el mes que cobra' });
        } else {
            const ahora = mesAbs(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)));
            const pedido = mesAbs(l.period.year, l.period.month);
            if (pedido > ahora + MESES_ADELANTE) {
                ctx.addIssue({ code: 'custom', path: ['period'], message: 'Solo se puede adelantar la mensualidad hasta 3 meses' });
            }
            if (pedido < ahora - MESES_ATRAS) {
                ctx.addIssue({ code: 'custom', path: ['period'], message: 'No se puede cobrar una mensualidad de hace más de 12 meses' });
            }
        }
    } else if (l.period) {
        ctx.addIssue({ code: 'custom', path: ['period'], message: 'Solo la mensualidad lleva mes; los demás cobros toman el mes del vencimiento' });
    }
    if (l.category === 'excedente') {
        const fuentes = [l.overage_charge_id, l.extra_hours].filter((x) => x != null).length;
        if (fuentes !== 1) {
            ctx.addIssue({ code: 'custom', path: ['overage_charge_id'], message: 'Las horas adicionales se cobran desde un período del banco de horas o indicando cuántas horas se vendieron (una de las dos)' });
        }
        if (l.extra_hours != null) {
            if (!l.enrollment_id) {
                ctx.addIssue({ code: 'custom', path: ['enrollment_id'], message: 'Elige a cuál inscripción se le suman las horas' });
            }
            if (Math.abs(l.extra_hours * 4 - Math.round(l.extra_hours * 4)) > 1e-9) {
                ctx.addIssue({ code: 'custom', path: ['extra_hours'], message: 'Las horas se venden de a 15 minutos (0,25 h)' });
            }
            // Las horas se suman al banco SOLO con el cobro pagado: sin pago no hay horas.
            if (!((l.pay_amount ?? 0) > 0)) {
                ctx.addIssue({ code: 'custom', path: ['pay_amount'], message: 'Las horas se venden pagadas: registra el pago para sumarlas al banco' });
            }
        }
    }
    if (l.category !== 'excedente' && l.overage_charge_id) {
        ctx.addIssue({ code: 'custom', path: ['overage_charge_id'], message: 'Solo las horas adicionales llevan período del banco de horas' });
    }
    if (l.category !== 'excedente' && l.extra_hours != null) {
        ctx.addIssue({ code: 'custom', path: ['extra_hours'], message: 'Solo las horas adicionales llevan horas vendidas' });
    }
    if (l.category !== 'mensualidad' && l.amount === undefined) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Escribe el valor del cobro' });
    }
    if (l.close_mode === 'cerrar' && !l.discount) {
        ctx.addIssue({ code: 'custom', path: ['discount'], message: '¿Por qué se cierra por menos? Elige el motivo del descuento' });
    }
    if (l.exonerate && (l.pay_amount ?? 0) > 0) {
        ctx.addIssue({ code: 'custom', path: ['exonerate'], message: '«No cobrar» no se combina con un pago en la misma línea' });
    }
    if (l.discount && l.exonerate) {
        ctx.addIssue({ code: 'custom', path: ['exonerate'], message: 'Elige descuento o «No cobrar», no los dos' });
    }
});
export type LineaInput = z.infer<typeof Linea>;

export const Atleta = z.object({
    type: z.enum(['child', 'adult', 'unregistered']),
    id: uuid(),
});
export type AtletaInput = z.infer<typeof Atleta>;

export const AtletaNuevo = z.object({
    kind: z.enum(['menor', 'adulto']),
    full_name: z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres').max(120),
    doc_type: z.string().trim().max(10).optional(),
    doc_number: z.string().trim().max(30).optional(),
    guardian_name: z.string().trim().max(120).optional(),
    /** Menor: el del acudiente; adulto: el suyo. */
    guardian_phone: z.string().trim().min(7, 'Escribe un teléfono válido').max(20),
    date_of_birth: fecha().optional(),
    allow_duplicate: z.boolean().default(false),
});
export type AtletaNuevoInput = z.infer<typeof AtletaNuevo>;

export const PendienteSel = z.object({
    payment_id: uuid(),
    /** Lo que mostró la vista previa: si la fila cambió, la RPC responde PREVIEW_STALE. */
    seen: z.object({ amount: z.number(), amount_paid: z.number() }),
    discount: Descuento.optional(),
    /** Sin `value` = todo el recargo. */
    waive_late_fee: z.object({
        value: z.number().positive().optional(),
        reason_text: z.string().trim().max(300).optional(),
    }).optional(),
    exonerate: Exoneracion.optional(),
    pay_amount: z.number().nonnegative().max(MAX_MONTO).default(0),
    /** Si lo recibido es menor que el saldo: 'abono' deja la deuda; 'cerrar' convierte la diferencia en descuento. */
    close_mode: z.enum(['cerrar', 'abono']).default('abono'),
}).superRefine((p, ctx) => {
    if (p.close_mode === 'cerrar' && !p.discount) {
        ctx.addIssue({ code: 'custom', path: ['discount'], message: '¿Por qué se cierra por menos? Elige el motivo del descuento' });
    }
    if (p.exonerate && (p.discount || p.pay_amount > 0 || p.waive_late_fee)) {
        ctx.addIssue({ code: 'custom', path: ['exonerate'], message: '«No cobrar» no se combina con pago, descuento ni condonación en el mismo cobro' });
    }
});
export type PendienteSelInput = z.infer<typeof PendienteSel>;

const LINE_REF = /^(new:\d+|pending:[0-9a-fA-F-]{36})$/;
export const DescuentoGlobal = z.object({
    basis: z.enum(['porcentaje', 'valor']),
    value: z.number().positive('El descuento debe ser mayor que cero'),
    reason_code: Motivo,
    reason_text: z.string().trim().min(3).max(300).optional(),
    line_refs: z.array(z.string().regex(LINE_REF, 'Referencia de línea inválida')).min(1, 'Elige a qué cobros aplica el descuento').max(MAX_LINEAS + MAX_PENDIENTES),
}).superRefine((d, ctx) => {
    if (d.basis === 'porcentaje' && d.value > 100) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'El porcentaje no puede ser mayor que 100' });
    }
    if (d.basis === 'valor' && d.value > MAX_MONTO) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'El descuento no puede superar $20.000.000' });
    }
    if (d.reason_code === 'otro' && !d.reason_text) {
        ctx.addIssue({ code: 'custom', path: ['reason_text'], message: 'Escribe el motivo cuando eliges «Otro»' });
    }
});

export const Pago = z.object({
    method: z.enum(['cash', 'transfer']),
    payment_date: fecha(),
    reference: z.string().trim().max(120).optional(),
    // El bucket `payment-receipts` es privado: el uploader devuelve la RUTA (`<uid>/<archivo>`),
    // no una URL. Se acepta ruta o URL http(s); nunca recorridos `..` ni otros esquemas.
    receipt_url: z.string().trim().min(1).max(500)
        .refine((v) => !v.includes('..') && !/^(?!https?:\/\/)[a-z][a-z0-9+.-]*:/i.test(v), 'Enlace del comprobante inválido')
        .optional(),
    receipt_sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Huella del comprobante inválida').optional(),
    ocr: z.record(z.string(), z.unknown()).optional(),
    // Quién del equipo recibió la plata. Obligatorio SOLO al crear sin comprobante
    // (lo exige la ruta, no el esquema, para no romper la vista previa).
    received_by: z.string().trim().max(80).optional(),
}).superRefine((p, ctx) => {
    if (p.payment_date > todayInZone()) {
        ctx.addIssue({ code: 'custom', path: ['payment_date'], message: 'La fecha del pago no puede ser futura' });
    }
});
export type PagoInput = z.infer<typeof Pago>;

const ChargeBatchBase = z.object({
    mode: z.enum(['single', 'multi']),
    target: z.object({
        kind: z.enum(['athlete', 'team', 'category', 'plan', 'list']),
        ids: z.array(uuid()).max(50),
    }),
    athletes: z.array(Atleta).max(MAX_ATLETAS_POR_LOTE, `Máximo ${MAX_ATLETAS_POR_LOTE} atletas por lote: divide por equipo o plan`).default([]),
    lines: z.array(Linea).max(MAX_LINEAS, `Máximo ${MAX_LINEAS} cobros nuevos por operación`).default([]),
    pending: z.array(PendienteSel).max(MAX_PENDIENTES).default([]),
    global_discount: DescuentoGlobal.optional(),
    payment: Pago.optional(),
    new_athlete: AtletaNuevo.optional(),
});

type Base = z.infer<typeof ChargeBatchBase>;

/** Atletas efectivos de la operación (el nuevo cuenta como uno). */
export function atletasEfectivos(b: Pick<Base, 'athletes' | 'new_athlete'>): number {
    return b.athletes.length + (b.new_athlete ? 1 : 0);
}

/** Filas que puede crear la operación (tope Q10 y cupo por hora Q11). */
export function filasDeLaOperacion(b: Pick<Base, 'athletes' | 'new_athlete' | 'lines'>): number {
    return atletasEfectivos(b) * b.lines.length;
}

function reglasDelLote(b: Base, ctx: z.RefinementCtx) {
    const n = atletasEfectivos(b);
    if (n === 0) {
        ctx.addIssue({ code: 'custom', path: ['athletes'], message: 'Elige al menos un atleta: no se crean cobros sin atleta' });
    }
    if (b.new_athlete && b.athletes.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['new_athlete'], message: 'El atleta nuevo reemplaza la selección: no se combinan' });
    }
    if (filasDeLaOperacion(b) > MAX_FILAS_POR_LOTE) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: `Máximo ${MAX_FILAS_POR_LOTE} cobros por lote: divide por equipo o plan` });
    }
    if (b.lines.length + b.pending.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: 'No hay nada que hacer: agrega un cobro o marca un pendiente' });
    }
    const ventasDeHoras = b.lines.filter((l) => l.extra_hours != null).length;
    if (ventasDeHoras > 1) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Una venta de horas adicionales por operación: registra la otra por separado' });
    }
    if (ventasDeHoras > 0 && (b.mode !== 'single' || b.new_athlete)) {
        ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Las horas adicionales se venden a un atleta ya inscrito, en modo un atleta' });
    }
    if (b.mode === 'multi') {
        if (b.pending.length > 0 || b.payment) {
            ctx.addIssue({ code: 'custom', path: ['mode'], message: 'En modo varios solo se generan cobros: los pagos se registran atleta por atleta' });
        }
        if (b.new_athlete) {
            ctx.addIssue({ code: 'custom', path: ['new_athlete'], message: 'El atleta nuevo solo se crea en modo un atleta' });
        }
        if (b.lines.some((l) => (l.pay_amount ?? 0) > 0)) {
            ctx.addIssue({ code: 'custom', path: ['lines'], message: 'En modo varios solo se generan cobros: los pagos se registran atleta por atleta' });
        }
        if (b.lines.some((l) => l.exonerate)) {
            ctx.addIssue({ code: 'custom', path: ['lines'], message: 'En modo varios no se usa «No cobrar»: es una decisión por atleta' });
        }
    } else if (n > 1) {
        ctx.addIssue({ code: 'custom', path: ['athletes'], message: 'En modo un atleta se elige un solo atleta' });
    }
    const hayPagoEnLineas = b.lines.some((l) => (l.pay_amount ?? 0) > 0);
    const hayPagoEnPendientes = b.pending.some((p) => p.pay_amount > 0);
    if (b.payment && !hayPagoEnLineas && !hayPagoEnPendientes) {
        ctx.addIssue({ code: 'custom', path: ['payment'], message: 'Indica cuánto se recibió en algún cobro' });
    }
    if (!b.payment && (hayPagoEnPendientes || hayPagoEnLineas)) {
        ctx.addIssue({ code: 'custom', path: ['payment'], message: 'Falta el medio de pago de lo recibido' });
    }
    if (b.global_discount) {
        const pendientes = new Set(b.pending.map((p) => p.payment_id.toLowerCase()));
        for (const ref of b.global_discount.line_refs) {
            if (ref.startsWith('new:')) {
                const idx = Number(ref.slice(4));
                if (!(idx >= 0 && idx < b.lines.length)) {
                    ctx.addIssue({ code: 'custom', path: ['global_discount', 'line_refs'], message: `El descuento general apunta a un cobro nuevo que no existe (${ref})` });
                }
            } else if (!pendientes.has(ref.slice(8).toLowerCase())) {
                ctx.addIssue({ code: 'custom', path: ['global_discount', 'line_refs'], message: 'El descuento general apunta a un pendiente que no está marcado' });
            }
        }
    }
}

export const ChargeBatchRequestSchema = ChargeBatchBase.superRefine(reglasDelLote);
export type ChargeBatchRequest = z.infer<typeof ChargeBatchRequestSchema>;

export const Override = z.object({
    athlete: z.string().min(1).max(80),
    line_idx: z.number().int().min(0).max(MAX_LINEAS - 1),
    action: z.enum(['force', 'skip']),
});

export const ChargeBatchCreateSchema = ChargeBatchBase.extend({
    client_request_id: uuid(),
    preview_hash: z.string().trim().min(1, 'Falta la vista previa: pídela antes de confirmar').max(200),
    overrides: z.array(Override).max(MAX_FILAS_POR_LOTE).default([]),
    notify_families: z.boolean().default(false),
    /** El usuario vio «este mismo cobro ya se registró hace X min» y confirma que es otro (cobro-duplicado-reciente.ts). */
    confirmar_duplicado: z.boolean().default(false),
}).superRefine((b, ctx) => reglasDelLote(b, ctx));
export type ChargeBatchCreate = z.infer<typeof ChargeBatchCreateSchema>;

export const AnnulSchema = z.object({
    reason: z.string().trim().min(3, 'Escribe el motivo (mínimo 3 caracteres)').max(300),
    expected_count: z.number().int().nonnegative(),
});

export const RevertSchema = z.object({
    reason: z.string().trim().min(3, 'Escribe el motivo (mínimo 3 caracteres)').max(300),
});

export const ListQuerySchema = z.object({
    cursor: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const TargetsQuerySchema = z.object({
    kind: z.enum(['team', 'category', 'plan']),
    id: uuid(),
    include_paused: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const AthleteSearchQuerySchema = z.object({
    q: z.string().trim().max(120).optional(),
    doc: z.string().trim().max(30).optional(),
    phone: z.string().trim().max(20).optional(),
}).superRefine((s, ctx) => {
    const tieneNombre = !!s.q && s.q.length >= 2;
    const tieneDoc = !!s.doc && s.doc.replace(/\D/g, '').length >= 4;
    const tieneTel = !!s.phone && s.phone.replace(/\D/g, '').length >= 7;
    if (!tieneNombre && !tieneDoc && !tieneTel) {
        ctx.addIssue({ code: 'custom', path: ['q'], message: 'Escribe al menos 2 letras del nombre, el documento o el teléfono' });
    }
});

export const AthleteParamsSchema = z.object({
    athleteType: z.enum(['child', 'adult', 'unregistered']),
    athleteId: uuid(),
});

export const AdjustmentsQuerySchema = z.object({
    from: fecha().optional(),
    to: fecha().optional(),
    reason: z.enum([...MOTIVOS_DESCUENTO, 'descuento_alta'] as const).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
}).transform((q) => ({
    ...q,
    from: q.from ?? addDaysToDateString(todayInZone(), -30),
    to: q.to ?? todayInZone(),
})).superRefine((q, ctx) => {
    if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'La fecha inicial es posterior a la final' });
});

/** Mensaje humano del primer error de zod (para el `error` de la respuesta 422). */
export function primerError(err: z.ZodError): string {
    return err.issues[0]?.message ?? 'Datos inválidos';
}

/** Reintento de la suma de horas de una operación ya creada y pagada (solo dueño). */
export const ReintentoHorasSchema = z.object({
    athlete: Atleta,
    enrollment_id: uuid(),
    extra_hours: z.number().positive().max(24)
        .refine((h) => Math.abs(h * 4 - Math.round(h * 4)) < 1e-9, 'Las horas se venden de a 15 minutos (0,25 h)'),
});
