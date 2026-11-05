/**
 * Servicio del modal «Cobros y pagos» (spec cobros-multiples §7, §9, F2).
 *
 * - Llama las RPC de F1 (`preview_charge_batch`, `create_charge_batch`,
 *   `annul_charge_batch`, `revert_payment_adjustment`) con las firmas EXACTAS
 *   del spec (§7.2–7.5). Son solo de service_role y re-validan `p_actor`.
 * - Traduce los códigos de error de la RPC a HTTP + mensaje en español.
 * - Verifica que atletas, grupos, pendientes y excedentes sean de la escuela
 *   ANTES de llamar la RPC (§9.1: «el atleta/grupo debe ser de req.schoolId»).
 * - Lecturas: historial, detalle, destinos por grupo, cobros abiertos y
 *   sugerencias de un atleta, informe de ajustes.
 *
 * El BFF no calcula montos (§9.2): manda las decisiones; la RPC calcula.
 */
import { supabase } from '../config/supabase';
import { todayInZone, addDaysToDateString } from '../utils/businessDate';
import { etiquetaDeCobro } from './payment-accounts';
import { etiquetaDelCobro } from './tipo-de-cobro';
import type {
    ChargeBatchRequest, ChargeBatchCreate, AtletaInput,
} from './charge-batches.schemas';
import { esFuncionInexistente } from './athlete-duplicates.service';
import { conceptoHorasAdicionales, tarifaPorHora } from './hour-bank-extra.shared';

// ─── Errores ─────────────────────────────────────────────────────────────────

export class CobrosError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public extra: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

interface ErrorRpc { code?: string; message?: string; details?: string | null; hint?: string | null }

/** Código → (HTTP, mensaje en español). Los códigos son los de §7 / §15.4 / F2. */
export const ERRORES_RPC: Record<string, { status: number; mensaje: string }> = {
    PREVIEW_STALE: { status: 409, mensaje: 'Algo cambió desde la vista previa (otro usuario o un pago en línea). Revisa la vista previa de nuevo antes de confirmar.' },
    COBRO_CAMBIO: { status: 409, mensaje: 'Uno de los cobros marcados cambió mientras tanto (se pagó, se anuló o entró en revisión). Recarga los pendientes.' },
    EN_REVISION: { status: 409, mensaje: 'Ese cobro tiene un comprobante o un abono en revisión: apruébalo o recházalo antes de registrar el pago o descontar.' },
    PAGO_EN_CURSO: { status: 409, mensaje: 'La familia tiene un pago en línea en curso por ese cobro. Espera el resultado o anula el enlace de pago.' },
    COBRO_CERRADO: { status: 409, mensaje: 'Ese cobro ya está pagado, anulado o glosado: no se puede modificar.' },
    ATLETA_DUPLICADO: { status: 409, mensaje: 'Ya existe un atleta parecido en la escuela. Usa ese registro o confirma que es otra persona.' },
    ANNUL_STALE: { status: 409, mensaje: 'La cantidad de cobros que se pueden anular cambió. Revisa de nuevo antes de anular.' },
    LOTE_ANULADO: { status: 409, mensaje: 'Esa operación ya estaba anulada.' },
    YA_REVERTIDO: { status: 409, mensaje: 'Ese descuento ya se quitó antes.' },
    PERIODO_DUPLICADO: { status: 409, mensaje: 'Otro cobro ocupó ese mes mientras confirmabas. No se creó nada: revisa la vista previa de nuevo.' },
    EXCEDENTE_YA_FACTURADO: { status: 409, mensaje: 'Esas horas adicionales ya se facturaron o se descartaron.' },
    DESCUENTO_EXCEDE: { status: 422, mensaje: 'El descuento deja el cobro por debajo de lo ya pagado o toca el recargo. Baja el descuento (para el recargo usa «condonar»).' },
    SOBREPAGO: { status: 422, mensaje: 'Lo recibido supera el saldo del cobro. Registra solo lo que corresponde.' },
    MULTI_NO_PAGA: { status: 422, mensaje: 'En modo varios solo se generan cobros: los pagos se registran atleta por atleta.' },
    EXONERACION_CON_PAGO: { status: 422, mensaje: 'Ese cobro ya tiene abonos: no se puede marcar «No cobrar». Usa «cerrar con descuento».' },
    TOPE_EXCEDIDO: { status: 422, mensaje: 'El lote supera el máximo (200 atletas o 600 cobros). Divide por equipo o plan.' },
    VALIDACION: { status: 422, mensaje: 'Hay datos inválidos en la operación.' },
    ATLETA_AJENO: { status: 404, mensaje: 'Ese atleta no pertenece a esta escuela.' },
    LOTE_NO_ENCONTRADO: { status: 404, mensaje: 'No encontramos esa operación en esta escuela.' },
    AJUSTE_NO_ENCONTRADO: { status: 404, mensaje: 'No encontramos ese descuento en esta escuela.' },
    SIN_PERMISO: { status: 403, mensaje: 'Solo la administración de la escuela puede hacer esta operación.' },
    ESCUELA_NO_OPERATIVA: { status: 402, mensaje: 'La escuela está inhabilitada: no se pueden registrar operaciones.' },
};

const SINONIMOS: Record<string, string> = {
    FORBIDDEN: 'SIN_PERMISO',
    NO_AUTORIZADO: 'SIN_PERMISO',
    ACTOR_NO_ADMIN: 'SIN_PERMISO',
    SCHOOL_NOT_OPERATIONAL: 'ESCUELA_NO_OPERATIVA',
    ESCUELA_BLOQUEADA: 'ESCUELA_NO_OPERATIVA',
    ADJUSTMENT_ALREADY_REVERTED: 'YA_REVERTIDO',
    AJUSTE_YA_REVERTIDO: 'YA_REVERTIDO',
    BATCH_NOT_FOUND: 'LOTE_NO_ENCONTRADO',
    ADJUSTMENT_NOT_FOUND: 'AJUSTE_NO_ENCONTRADO',
    BATCH_ANNULLED: 'LOTE_ANULADO',
    LIMITE_LOTE: 'TOPE_EXCEDIDO',
    ATHLETE_NOT_IN_SCHOOL: 'ATLETA_AJENO',
};

const CODIGOS = [...Object.keys(ERRORES_RPC), ...Object.keys(SINONIMOS)].sort((a, b) => b.length - a.length);

/** Intenta leer un JSON de `details`/`hint` (la RPC puede adjuntar la coincidencia, los conteos…). */
function jsonDe(txt: string | null | undefined): Record<string, unknown> | null {
    if (!txt) return null;
    try {
        const v = JSON.parse(txt);
        return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * Error de una RPC → CobrosError. `contexto` afina el 23505 (en `revert` es
 * «ya revertido», en `create` es una carrera contra el índice de período).
 */
export function traducirErrorRpc(err: ErrorRpc, contexto: 'preview' | 'create' | 'annul' | 'revert' = 'create'): CobrosError {
    if (esFuncionInexistente(err)) {
        return new CobrosError(503, 'COBROS_NO_DISPONIBLE',
            'El módulo de cobros y pagos todavía no está activo en este ambiente.');
    }
    const texto = [err.message, err.details, err.hint].filter(Boolean).join(' ');
    let codigo: string | null = null;
    for (const c of CODIGOS) {
        if (new RegExp(`\\b${c}\\b`).test(texto)) { codigo = c; break; }
    }
    if (!codigo && err.code === '23505') codigo = contexto === 'revert' ? 'YA_REVERTIDO' : 'PERIODO_DUPLICADO';
    if (!codigo && err.code === '42501') codigo = 'SIN_PERMISO';
    if (!codigo && (err.code === '23514' || err.code === '22023' || err.code === '22P02')) codigo = 'VALIDACION';
    if (codigo && SINONIMOS[codigo]) codigo = SINONIMOS[codigo];
    if (!codigo) {
        return new CobrosError(500, 'ERROR_INTERNO', 'No se pudo completar la operación. Intenta de nuevo; si sigue fallando, avísanos.');
    }
    const def = ERRORES_RPC[codigo];
    const extra: Record<string, unknown> = {};
    const detalle = jsonDe(err.details) ?? jsonDe(err.hint);
    if (detalle) extra.detalle = detalle;
    return new CobrosError(def.status, codigo, def.mensaje, extra);
}

// ─── Pertenencia a la escuela (antes de la RPC) ─────────────────────────────

export const COLUMNA_ATLETA: Record<AtletaInput['type'], 'child_id' | 'user_id' | 'unregistered_athlete_id'> = {
    child: 'child_id',
    adult: 'user_id',
    unregistered: 'unregistered_athlete_id',
};

async function idsDe(tabla: string, col: string, ids: string[], schoolId: string, extra?: (q: any) => any): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    let q = supabase.from(tabla).select(col).in(col, ids).eq('school_id', schoolId);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    return new Set(((data ?? []) as unknown as Record<string, string>[]).map((r) => r[col]));
}

/** Atletas de la escuela: menor por `children.school_id` o inscripción; adulto por inscripción; ficha sin cuenta por `school_id`. */
export async function atletasAjenos(schoolId: string, atletas: AtletaInput[]): Promise<AtletaInput[]> {
    const por = (t: AtletaInput['type']) => [...new Set(atletas.filter((a) => a.type === t).map((a) => a.id))];
    const ninos = por('child');
    const adultos = por('adult');
    const fichas = por('unregistered');

    const [ninosFicha, ninosInsc, adultosInsc, adultosMiembro, fichasOk] = await Promise.all([
        idsDe('children', 'id', ninos, schoolId),
        idsDe('enrollments', 'child_id', ninos, schoolId),
        idsDe('enrollments', 'user_id', adultos, schoolId),
        adultos.length
            ? supabase.from('school_members').select('profile_id').in('profile_id', adultos).eq('school_id', schoolId).eq('role', 'athlete')
                .then(({ data, error }) => {
                    if (error) throw new Error(`school_members: ${error.message}`);
                    return new Set(((data ?? []) as { profile_id: string }[]).map((r) => r.profile_id));
                })
            : Promise.resolve(new Set<string>()),
        idsDe('unregistered_athletes', 'id', fichas, schoolId),
    ]);
    return atletas.filter((a) => {
        if (a.type === 'child') return !ninosFicha.has(a.id) && !ninosInsc.has(a.id);
        if (a.type === 'adult') return !adultosInsc.has(a.id) && !adultosMiembro.has(a.id);
        return !fichasOk.has(a.id);
    });
}

/** Verifica destino, atletas, pendientes y excedentes contra req.schoolId. Lanza 404 si algo es ajeno. */
export async function verificarPertenencia(schoolId: string, body: ChargeBatchRequest): Promise<void> {
    const ajenos = await atletasAjenos(schoolId, body.athletes);
    if (ajenos.length > 0) {
        throw new CobrosError(404, 'ATLETA_AJENO', ERRORES_RPC.ATLETA_AJENO.mensaje, { atletas: ajenos.length });
    }

    const tablaDestino: Record<string, string | null> = {
        team: 'teams', category: 'school_categories', plan: 'offering_plans', athlete: null, list: null,
    };
    const tabla = tablaDestino[body.target.kind];
    if (tabla && body.target.ids.length > 0) {
        const ok = await idsDe(tabla, 'id', body.target.ids, schoolId);
        if (ok.size !== new Set(body.target.ids).size) {
            throw new CobrosError(404, 'DESTINO_AJENO', 'Ese grupo no pertenece a esta escuela.');
        }
    }

    if (body.pending.length > 0) {
        const ids = body.pending.map((p) => p.payment_id);
        const { data, error } = await supabase.from('payments')
            .select('id, child_id, user_id, unregistered_athlete_id')
            .in('id', ids).eq('school_id', schoolId);
        if (error) throw new Error(`payments: ${error.message}`);
        const filas = (data ?? []) as Record<string, string | null>[];
        const atleta = body.athletes[0];
        const delAtleta = filas.filter((f) => !atleta || f[COLUMNA_ATLETA[atleta.type]] === atleta.id);
        if (delAtleta.length !== new Set(ids).size) {
            throw new CobrosError(404, 'COBRO_AJENO', 'Uno de los cobros marcados no es de este atleta o de esta escuela.');
        }
    }

    const excedentes = body.lines.map((l) => l.overage_charge_id).filter((x): x is string => !!x);
    if (excedentes.length > 0) {
        const ok = await idsDe('hour_bank_overage_charges', 'id', excedentes, schoolId);
        if (ok.size !== new Set(excedentes).size) {
            throw new CobrosError(404, 'EXCEDENTE_AJENO', 'Ese período del banco de horas no pertenece a esta escuela.');
        }
    }
}

// ─── Argumentos de las RPC (firmas exactas de §7.2 / §7.3) ──────────────────

/**
 * Líneas tal como las valida zod. Claves = las de §9.2 (category, amount,
 * due_date, concept, notes, period{year,month}, enrollment_id, fee_id,
 * overage_charge_id, discount, exonerate) + pay_amount/close_mode por línea.
 */
export function lineasParaRpc(b: Pick<ChargeBatchRequest, 'lines'>) {
    // Contrato del BFF (Linea.pay_amount): «ausente o 0 = la línea nace
    // pendiente». La RPC (§17.2) entiende lo contrario: con p_payment, una
    // línea SIN pay_amount se paga completa. Sin esta normalización, un
    // cliente del BFF que omite pay_amount registraba plata que no recibió
    // (hallado en QA sobre el gemelo, 2026-10-10: mensualidad de $280.000
    // quedó `paid`). El modal ya manda pay_amount explícito en modo un atleta.
    return b.lines.map((l, idx) => {
        const { extra_hours, ...resto } = l;
        // Venta de horas por adelantado: el lote la ve como una «Clase extra» con un
        // concepto fijo (con el que `sumarHorasAdicionales` encuentra el pago). La
        // misma transformación corre en la vista previa y en la creación, así que el
        // preview_hash coincide.
        const linea = extra_hours != null
            ? { ...resto, category: 'clase_extra' as const, concept: conceptoHorasAdicionales(extra_hours) }
            : resto;
        return { idx, ...linea, pay_amount: l.pay_amount ?? 0 };
    });
}

function argsComunes(schoolId: string, actor: string, b: ChargeBatchRequest) {
    const args: Record<string, unknown> = {
        p_school_id: schoolId,
        p_actor: actor,
        p_athletes: b.athletes,
        p_lines: lineasParaRpc(b),
        p_pending: b.pending,
        p_global_discount: b.global_discount ?? null,
        p_payment: b.payment ?? null,
    };
    // §7.2/§7.3 usan `p_new_athlete` en el texto pero no lo listan en la firma:
    // solo se manda cuando hay atleta nuevo, para no romper la llamada si F1
    // no lo agrega (ver «Contrato» del informe de F2).
    if (b.new_athlete) args.p_new_athlete = b.new_athlete;
    return args;
}

export function argsPreview(schoolId: string, actor: string, b: ChargeBatchRequest) {
    return argsComunes(schoolId, actor, b);
}

export function argsCreate(schoolId: string, actor: string, b: ChargeBatchCreate) {
    return {
        ...argsComunes(schoolId, actor, b),
        p_client_request_id: b.client_request_id,
        p_mode: b.mode,
        p_target: b.target,
        p_overrides: b.overrides,
        p_notify: b.notify_families,
        p_preview_hash: b.preview_hash,
    };
}

export async function previewChargeBatch(schoolId: string, actor: string, b: ChargeBatchRequest) {
    const { data, error } = await supabase.rpc('preview_charge_batch', argsPreview(schoolId, actor, b));
    if (error) throw traducirErrorRpc(error, 'preview');
    return data as Record<string, unknown>;
}

export async function createChargeBatch(schoolId: string, actor: string, b: ChargeBatchCreate) {
    const { data, error } = await supabase.rpc('create_charge_batch', argsCreate(schoolId, actor, b));
    if (error) throw traducirErrorRpc(error, 'create');
    return (data ?? {}) as Record<string, unknown>;
}

export async function annulChargeBatch(schoolId: string, actor: string, batchId: string, reason: string, expectedCount: number) {
    const { data, error } = await supabase.rpc('annul_charge_batch', {
        p_school_id: schoolId,
        p_actor: actor,
        p_batch_id: batchId,
        p_reason: reason,
        p_expected_count: expectedCount,
    });
    if (error) throw traducirErrorRpc(error, 'annul');
    return (data ?? {}) as Record<string, unknown>;
}

export async function revertPaymentAdjustment(schoolId: string, actor: string, adjustmentId: string, reason: string) {
    const { data, error } = await supabase.rpc('revert_payment_adjustment', {
        p_school_id: schoolId,
        p_actor: actor,
        p_adjustment_id: adjustmentId,
        p_reason: reason,
    });
    if (error) throw traducirErrorRpc(error, 'revert');
    return (data ?? {}) as Record<string, unknown>;
}

// ─── Lecturas ────────────────────────────────────────────────────────────────

/** ¿La tabla/columna aún no existe (F1 sin aplicar)? */
function esEsquemaFaltante(err: { code?: string; message?: string } | null | undefined): boolean {
    if (!err) return false;
    return err.code === '42P01' || err.code === 'PGRST205' || err.code === '42703' || err.code === 'PGRST204'
        || /does not exist|could not find the table|schema cache/i.test(err.message ?? '');
}

function noDisponible(): CobrosError {
    return new CobrosError(503, 'COBROS_NO_DISPONIBLE', 'El módulo de cobros y pagos todavía no está activo en este ambiente.');
}

export async function listarLotes(schoolId: string, cursor: string | undefined, limit: number) {
    let q = supabase.from('charge_batches')
        .select('id, mode, target, status, rows_created, rows_skipped, total_amount, payments_registered, paid_total, discount_total, late_fee_waived_total, notify_families, created_by, created_at, annulled_at, annulled_by, annul_reason')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false })
        .limit(limit + 1);
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q;
    if (error) {
        if (esEsquemaFaltante(error)) throw noDisponible();
        throw new Error(`charge_batches: ${error.message}`);
    }
    const filas = (data ?? []) as Record<string, any>[];
    const pagina = filas.slice(0, limit);
    const nombres = await nombresDePerfiles(pagina.map((f) => f.created_by));
    const destinos = await etiquetasDeDestino(schoolId, pagina);
    return {
        items: pagina.map((f) => ({
            ...f,
            created_by_name: nombres.get(f.created_by) ?? null,
            target_label: destinos.get(f.id) ?? null,
        })),
        next_cursor: filas.length > limit ? pagina[pagina.length - 1]?.created_at ?? null : null,
    };
}

/**
 * Nombre legible del destino de cada lote («Equipo Sub-12», «Sofía Ensayo +2»).
 * El lote solo guarda `target: { kind, ids }`; sin esto «Operaciones» mostraba
 * «Un atleta» sin nombre. Una consulta por tabla para toda la página (sin N+1) y
 * siempre acotada a la escuela.
 */
async function etiquetasDeDestino(schoolId: string, lotes: Record<string, any>[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const idsDe = (l: Record<string, any>): string[] => (Array.isArray(l.target?.ids) ? l.target.ids.filter((x: unknown): x is string => typeof x === 'string') : []);
    const equipos = [...new Set(lotes.filter((l) => l.target?.kind === 'team').flatMap(idsDe))];
    const atletas = [...new Set(lotes.filter((l) => l.target?.kind === 'athlete').flatMap(idsDe))];
    const nombreEquipo = new Map<string, string>();
    const nombreAtleta = new Map<string, string>();
    if (equipos.length) {
        const { data } = await supabase.from('teams').select('id, name').eq('school_id', schoolId).in('id', equipos);
        for (const t of (data ?? []) as { id: string; name: string | null }[]) if (t.name) nombreEquipo.set(t.id, t.name);
    }
    if (atletas.length) {
        const [hijos, perfiles] = await Promise.all([
            supabase.from('children').select('id, full_name').in('id', atletas),
            supabase.from('profiles').select('id, full_name').in('id', atletas),
        ]);
        for (const c of (hijos.data ?? []) as { id: string; full_name: string | null }[]) if (c.full_name) nombreAtleta.set(c.id, c.full_name);
        for (const p of (perfiles.data ?? []) as { id: string; full_name: string | null }[]) if (p.full_name && !nombreAtleta.has(p.id)) nombreAtleta.set(p.id, p.full_name);
    }
    for (const l of lotes) {
        const ids = idsDe(l);
        if (!ids.length) continue;
        const nombres = (l.target.kind === 'team' ? nombreEquipo : l.target.kind === 'athlete' ? nombreAtleta : null);
        const primero = nombres?.get(ids[0]);
        if (!primero) continue;
        if (l.target.kind === 'team') out.set(l.id, ids.length > 1 ? `Equipo ${primero} +${ids.length - 1}` : `Equipo ${primero}`);
        else out.set(l.id, ids.length > 1 ? `${primero} +${ids.length - 1}` : primero);
    }
    return out;
}

async function nombresDePerfiles(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (unicos.length === 0) return out;
    const { data } = await supabase.from('profiles').select('id, full_name').in('id', unicos);
    for (const p of (data ?? []) as { id: string; full_name: string | null }[]) out.set(p.id, p.full_name ?? '');
    return out;
}

export async function detalleLote(schoolId: string, batchId: string) {
    const { data: lote, error } = await supabase.from('charge_batches')
        .select('*').eq('id', batchId).eq('school_id', schoolId).maybeSingle();
    if (error) {
        if (esEsquemaFaltante(error)) throw noDisponible();
        throw new Error(`charge_batches: ${error.message}`);
    }
    if (!lote) throw new CobrosError(404, 'LOTE_NO_ENCONTRADO', ERRORES_RPC.LOTE_NO_ENCONTRADO.mensaje);

    const { data: pagos, error: errPagos } = await supabase.from('payments')
        .select('*')
        .eq('school_id', schoolId)
        .eq('charge_batch_id', batchId)
        .order('created_at', { ascending: true });
    if (errPagos) throw new Error(`payments: ${errPagos.message}`);

    const filas = (pagos ?? []) as Record<string, any>[];
    const ANULABLES = new Set(['pending', 'overdue', 'rejected', 'failed']);
    const nombres = await nombresDePerfiles([(lote as any).created_by, (lote as any).annulled_by]);
    return {
        batch: {
            ...lote,
            created_by_name: nombres.get((lote as any).created_by) ?? null,
            annulled_by_name: nombres.get((lote as any).annulled_by) ?? null,
        },
        payments: filas.map((p) => ({
            id: p.id,
            concept: p.concept,
            label: etiquetaDelCobro(p),
            payment_category: p.payment_category,
            amount: Number(p.amount),
            amount_paid: Number(p.amount_paid ?? 0),
            status: p.status,
            due_date: p.due_date,
            child_id: p.child_id, user_id: p.user_id, unregistered_athlete_id: p.unregistered_athlete_id,
            anulable: ANULABLES.has(p.status),
        })),
        // Lo que mostraría la confirmación de «Anular lote» (Q12): conteo exacto.
        annul_preview: {
            annullable_count: filas.filter((p) => ANULABLES.has(p.status)).length,
            annullable_total: filas.filter((p) => ANULABLES.has(p.status)).reduce((s, p) => s + Number(p.amount || 0), 0),
            kept_count: filas.filter((p) => !ANULABLES.has(p.status)).length,
        },
    };
}

/** Atletas activos de un equipo / categoría / plan (Q16: pausados fuera salvo que se pidan). */
export async function atletasDelGrupo(schoolId: string, kind: 'team' | 'category' | 'plan', id: string, incluirPausados: boolean) {
    const tabla = kind === 'team' ? 'teams' : kind === 'category' ? 'school_categories' : 'offering_plans';
    const { data: grupo, error: errG } = await supabase.from(tabla).select('id, name').eq('id', id).eq('school_id', schoolId).maybeSingle();
    if (errG) throw new Error(`${tabla}: ${errG.message}`);
    if (!grupo) throw new CobrosError(404, 'DESTINO_AJENO', 'Ese grupo no pertenece a esta escuela.');

    let enrollmentIds: string[] | null = null;
    if (kind === 'category') {
        const { data: cats, error } = await supabase.from('enrollment_categories')
            .select('enrollment_id').eq('school_id', schoolId).eq('category_id', id).eq('status', 'active');
        if (error) throw new Error(`enrollment_categories: ${error.message}`);
        enrollmentIds = [...new Set(((cats ?? []) as { enrollment_id: string }[]).map((c) => c.enrollment_id))];
        if (enrollmentIds.length === 0) return { group: grupo, athletes: [], paused_excluded: 0 };
    }

    let q = supabase.from('enrollments')
        .select('id, child_id, user_id, unregistered_athlete_id, team_id, offering_plan_id, paused_at, paused_until, status')
        .eq('school_id', schoolId)
        .eq('status', 'active');
    if (kind === 'team') q = q.eq('team_id', id);
    if (kind === 'plan') q = q.eq('offering_plan_id', id);
    if (enrollmentIds) q = q.in('id', enrollmentIds);
    const { data, error } = await q;
    if (error) throw new Error(`enrollments: ${error.message}`);

    const hoy = todayInZone();
    const pausado = (e: Record<string, any>) => !!e.paused_at && (!e.paused_until || String(e.paused_until).slice(0, 10) >= hoy);
    const vistos = new Set<string>();
    const athletes: { type: AtletaInput['type']; id: string; enrollment_id: string; paused: boolean }[] = [];
    let pausadosFuera = 0;
    for (const e of (data ?? []) as Record<string, any>[]) {
        const tipo: AtletaInput['type'] | null = e.child_id ? 'child' : e.user_id ? 'adult' : e.unregistered_athlete_id ? 'unregistered' : null;
        if (!tipo) continue;
        const atletaId = e.child_id ?? e.user_id ?? e.unregistered_athlete_id;
        const k = `${tipo}:${atletaId}`;
        if (vistos.has(k)) continue;
        const p = pausado(e);
        if (p && !incluirPausados) { pausadosFuera++; continue; }
        vistos.add(k);
        athletes.push({ type: tipo, id: atletaId, enrollment_id: e.id, paused: p });
    }
    await ponerNombres(athletes);
    return { group: grupo, athletes, paused_excluded: pausadosFuera };
}

async function ponerNombres(lista: { type: AtletaInput['type']; id: string; name?: string | null; has_guardian?: boolean }[]) {
    const ids = (t: AtletaInput['type']) => lista.filter((a) => a.type === t).map((a) => a.id);
    const [k, a, u] = await Promise.all([
        ids('child').length ? supabase.from('children').select('id, full_name, parent_id').in('id', ids('child')) : Promise.resolve({ data: [] as any[] }),
        ids('adult').length ? supabase.from('profiles').select('id, full_name').in('id', ids('adult')) : Promise.resolve({ data: [] as any[] }),
        ids('unregistered').length ? supabase.from('unregistered_athletes').select('id, full_name').in('id', ids('unregistered')) : Promise.resolve({ data: [] as any[] }),
    ]);
    const m = new Map<string, Record<string, any>>();
    for (const r of [...((k as any).data ?? []), ...((a as any).data ?? []), ...((u as any).data ?? [])]) m.set(r.id, r);
    for (const x of lista) {
        const r = m.get(x.id);
        x.name = r?.full_name ?? null;
        // Q15: menor sin acudiente vinculado = no podrá pagar en línea.
        x.has_guardian = x.type === 'child' ? !!r?.parent_id : true;
    }
}

/** ¿El atleta es de la escuela? (para las rutas /athletes/:type/:id/...). */
export async function verificarAtleta(schoolId: string, atleta: AtletaInput): Promise<void> {
    const ajenos = await atletasAjenos(schoolId, [atleta]);
    if (ajenos.length > 0) throw new CobrosError(404, 'ATLETA_AJENO', ERRORES_RPC.ATLETA_AJENO.mensaje);
}

const ESTADOS_ABIERTOS = ['pending', 'overdue', 'partial', 'rejected', 'failed', 'awaiting_approval'];

const ETIQUETA_ORIGEN: Record<string, string> = {
    militar: 'Militar', hermanos: 'Hermanos', alta_solo_este_mes: 'Solo este mes', pronto_pago: 'Pronto pago', modal: 'Descuento',
};
const ETIQUETA_MOTIVO: Record<string, string> = {
    pronto_pago: 'Pronto pago', varios_meses: 'Varios meses', hermanos: 'Hermanos', beca: 'Beca', convenio: 'Convenio',
    cortesia: 'Cortesía', ajuste_de_precio: 'Ajuste de precio', error_de_cobro: 'Ajuste', condonacion_mora: 'Mora condonada',
    descuento_alta: 'Solo este mes', otro: 'Descuento',
};

const fmtCop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** Etiqueta de un ajuste para el desglose («Hermanos −10 %», «Convenio −$20.000», «Mora condonada −$36.150»). */
export function etiquetaDeAjuste(a: { kind?: string; origin?: string; reason_code?: string; basis?: string | null; pct?: number | null; amount?: number }): string {
    const base = a.kind === 'condonacion_recargo'
        ? 'Mora condonada'
        : a.kind === 'exoneracion'
            ? 'Exonerado'
            : a.origin && a.origin !== 'modal'
                ? ETIQUETA_ORIGEN[a.origin] ?? 'Descuento'
                : ETIQUETA_MOTIVO[a.reason_code ?? ''] ?? 'Descuento';
    if (a.kind === 'exoneracion') return base;
    const valor = a.basis === 'porcentaje' && a.pct ? `−${Number(a.pct)} %` : `−${fmtCop(Number(a.amount ?? 0))}`;
    return `${base} ${valor}`;
}

/** Aviso del 50 % (D16): descuentos + pronto pago sobre el valor de lista. La condonación no cuenta. */
export function superaMitad(p: { list_amount?: number | null; discount_amount?: number | null; early_payment_discount_applied?: number | null }): boolean {
    const lista = Number(p.list_amount ?? 0);
    if (!(lista > 0)) return false;
    return (Number(p.discount_amount ?? 0) + Number(p.early_payment_discount_applied ?? 0)) / lista > 0.5;
}

/**
 * Cobros abiertos del atleta para la sección «Cobros pendientes» del modal
 * (rev. 2). `select('*')` a propósito: las columnas de F1 (discount_amount,
 * late_fee_waived_amount) aún pueden no existir y nombrarlas rompería la lectura.
 */
export async function cobrosAbiertos(schoolId: string, atleta: AtletaInput) {
    const col = COLUMNA_ATLETA[atleta.type];
    const { data, error } = await supabase.from('payments')
        .select('*')
        .eq('school_id', schoolId)
        .eq(col, atleta.id)
        .in('status', ESTADOS_ABIERTOS)
        .order('due_date', { ascending: true });
    if (error) throw new Error(`payments: ${error.message}`);
    const filas = (data ?? []) as Record<string, any>[];
    const ids = filas.map((p) => p.id);

    const [ajustes, enlaces, abonos, ajustesEscuela] = await Promise.all([
        leerAjustes(ids),
        ids.length
            ? supabase.from('payment_links').select('payment_id, base_amount, expires_at, status').in('payment_id', ids).eq('status', 'pending')
                .then(({ data: d }) => (d ?? []) as Record<string, any>[])
            : Promise.resolve([] as Record<string, any>[]),
        ids.length
            ? supabase.from('payment_installments').select('payment_id, status').in('payment_id', ids).eq('status', 'pending')
                .then(({ data: d, error: e }) => (e ? [] : (d ?? []) as Record<string, any>[]))
            : Promise.resolve([] as Record<string, any>[]),
        supabase.from('school_settings')
            .select('early_payment_discount_enabled, early_payment_discount_days, early_payment_discount_percentage, early_payment_discount_mode')
            .eq('school_id', schoolId).maybeSingle()
            .then(({ data: d }) => (d ?? null) as Record<string, any> | null),
    ]);

    const ahora = new Date().toISOString();
    const hoy = todayInZone();
    const conEnlace = new Map<string, number>();
    for (const l of enlaces) {
        if (!l.expires_at || String(l.expires_at) > ahora) conEnlace.set(l.payment_id, Number(l.base_amount ?? 0));
    }
    const conAbonoEnRevision = new Set(abonos.map((a) => a.payment_id));

    const items = filas.map((p) => {
        const amount = Number(p.amount ?? 0);
        const pagado = Number(p.amount_paid ?? 0);
        const pronto = Number(p.early_payment_discount_applied ?? 0);
        const enRevision = p.status === 'awaiting_approval' || conAbonoEnRevision.has(p.id);
        const pagoEnCurso = conEnlace.has(p.id);
        const listAmount = p.list_amount != null ? Number(p.list_amount) : null;
        const discountAmount = Number(p.discount_amount ?? 0);
        const etiquetas = (ajustes.get(p.id) ?? []).map(etiquetaDeAjuste);
        if (etiquetas.length === 0) {
            // Sin tabla de ajustes (F1 sin aplicar): lo que dicen las columnas viejas.
            if (Number(p.sibling_discount_applied ?? 0) > 0) etiquetas.push(`Hermanos −${fmtCop(Number(p.sibling_discount_applied))}`);
            if (p.discount_pct) etiquetas.push(`Solo este mes −${Number(p.discount_pct)} %`);
        }
        const warnings: string[] = [];
        if (superaMitad({ list_amount: listAmount, discount_amount: discountAmount, early_payment_discount_applied: pronto })) {
            warnings.push('descuento_total_mayor_50');
        }
        if (atleta.type === 'child' && !p.parent_id) warnings.push('sin_acudiente');

        // Pronto pago sugerido (§15.5.1): escuela con pronto pago, cobro en ventana y sin pronto pago ya aplicado.
        let sugerencia: Record<string, unknown> | null = null;
        const s = ajustesEscuela;
        if (s?.early_payment_discount_enabled && Number(s.early_payment_discount_percentage) > 0 && !(pronto > 0)) {
            const dias = Number(s.early_payment_discount_days ?? 0);
            const creado = String(p.created_at ?? '').slice(0, 10);
            const limite = (s as any).early_payment_discount_mode === 'day_of_month'
                ? `${creado.slice(0, 8)}${String(Math.min(Math.max(dias, 1), 28)).padStart(2, '0')}`
                : addDaysToDateString(creado, dias);
            if (creado && limite >= hoy) {
                sugerencia = { basis: 'porcentaje', value: Number(s.early_payment_discount_percentage), reason_code: 'pronto_pago' };
            }
        }

        return {
            id: p.id,
            concept: p.concept,
            label: etiquetaDelCobro(p),
            short_label: etiquetaDeCobro(p),
            payment_category: p.payment_category ?? null,
            period_year: p.period_year ?? null,
            period_month: p.period_month ?? null,
            due_date: p.due_date,
            status: p.status,
            amount,
            list_amount: listAmount,
            discount_amount: discountAmount,
            late_fee_amount: Number(p.late_fee_amount ?? 0),
            late_fee_waived_amount: Number(p.late_fee_waived_amount ?? 0),
            amount_paid: pagado,
            early_payment_discount_applied: pronto,
            sibling_discount_applied: Number(p.sibling_discount_applied ?? 0),
            saldo: Math.max(0, amount - pagado - pronto),
            en_revision: enRevision,
            pago_en_curso: pagoEnCurso,
            pago_en_curso_monto: pagoEnCurso ? conEnlace.get(p.id) ?? null : null,
            seleccionable: !enRevision && !pagoEnCurso,
            discount_tags: etiquetas,
            warnings,
            suggested_discount: sugerencia,
        };
    });

    const mensualidadesAbiertas = items.filter((i) => (i.payment_category ?? 'mensualidad') === 'mensualidad' && !i.en_revision).length;
    return {
        items,
        totals: {
            count: items.length,
            saldo: items.reduce((s2, i) => s2 + i.saldo, 0),
        },
        // Q-D3: sugerencia «varios meses» (sin %) cuando se marcan ≥ 3 mensualidades.
        suggestions: {
            varios_meses: { min_mensualidades: 3, disponible: mensualidadesAbiertas >= 3 },
        },
    };
}

async function leerAjustes(paymentIds: string[]): Promise<Map<string, Record<string, any>[]>> {
    const out = new Map<string, Record<string, any>[]>();
    if (paymentIds.length === 0) return out;
    const { data, error } = await supabase.from('payment_adjustments')
        .select('id, payment_id, kind, origin, reason_code, basis, pct, amount, sequence, reverts_id')
        .in('payment_id', paymentIds)
        .order('sequence', { ascending: true });
    if (error) return out; // F1 sin aplicar: sin desglose
    const filas = (data ?? []) as Record<string, any>[];
    const revertidos = new Set(filas.filter((f) => f.kind === 'reversion' && f.reverts_id).map((f) => f.reverts_id));
    for (const f of filas) {
        if (f.kind === 'reversion' || revertidos.has(f.id)) continue;
        const l = out.get(f.payment_id) ?? [];
        l.push(f);
        out.set(f.payment_id, l);
    }
    return out;
}

const ESTADOS_QUE_OCUPAN_PERIODO = ['pending', 'awaiting_approval', 'paid', 'partial', 'overdue', 'glosado'];

/**
 * Sugerencias para «+ Nuevo cobro» de un atleta: inscripciones con su plan y
 * monto sugerido de mensualidad (D4: monthly_fee → plan.price → team.price_monthly),
 * próximo mes sin mensualidad (hasta 3 adelante, Q4), y excedentes `suggested`.
 * `plan_one_time_fees` no existe todavía (F4): `one_time_fees: []`.
 */
export async function sugerenciasDeCobro(schoolId: string, atleta: AtletaInput) {
    const col = COLUMNA_ATLETA[atleta.type];
    const { data: insc, error } = await supabase.from('enrollments')
        .select('id, team_id, offering_plan_id, monthly_fee, fee_is_manual, status, paused_at, paused_until')
        .eq('school_id', schoolId)
        .eq(col, atleta.id)
        .in('status', ['active', 'pending']);
    if (error) throw new Error(`enrollments: ${error.message}`);
    const inscripciones = (insc ?? []) as Record<string, any>[];

    const planIds = [...new Set(inscripciones.map((e) => e.offering_plan_id).filter(Boolean))] as string[];
    const teamIds = [...new Set(inscripciones.map((e) => e.team_id).filter(Boolean))] as string[];
    const enrollmentIds = inscripciones.map((e) => e.id);
    const hoyBanco = todayInZone();
    const [planes, equipos, primarias, ocupados, excedentes, periodosBanco] = await Promise.all([
        planIds.length ? supabase.from('offering_plans').select('id, name, price, included_minutes_per_period').in('id', planIds).then(({ data }) => (data ?? []) as Record<string, any>[]) : Promise.resolve([]),
        teamIds.length ? supabase.from('teams').select('id, name, price_monthly').in('id', teamIds).then(({ data }) => (data ?? []) as Record<string, any>[]) : Promise.resolve([]),
        enrollmentIds.length ? supabase.from('enrollment_categories').select('enrollment_id, is_primary').in('enrollment_id', enrollmentIds).eq('is_primary', true).then(({ data, error: e }) => (e ? [] : (data ?? []) as Record<string, any>[])) : Promise.resolve([]),
        supabase.from('payments')
            .select('period_year, period_month, period_uniqueness_exempt, status')
            .eq('school_id', schoolId).eq(col, atleta.id)
            .in('status', ESTADOS_QUE_OCUPAN_PERIODO)
            .then(({ data }) => (data ?? []) as Record<string, any>[]),
        enrollmentIds.length
            ? supabase.from('hour_bank_overage_charges').select('id, enrollment_id, period_id, amount, billable_hours, overage_minutes, status, payment_id')
                .eq('school_id', schoolId).in('enrollment_id', enrollmentIds).eq('status', 'suggested')
                .then(({ data, error: e }) => (e ? [] : (data ?? []) as Record<string, any>[]))
            : Promise.resolve([]),
        // Saldo del banco del periodo vigente: «Ya las usó» lo muestra para no cobrar
        // horas que todavía caben en el plan (Airi, Dreamers, 2026-10-23: se cobraron
        // 2 h «consumidas» con 8 h de 8 sin usar).
        enrollmentIds.length
            ? supabase.from('hour_bank_periods').select('enrollment_id, included_minutes, consumed_minutes, reserved_minutes')
                .in('enrollment_id', enrollmentIds).lte('period_start', hoyBanco).gte('period_end', hoyBanco)
                .then(({ data, error: e }) => (e ? [] : (data ?? []) as Record<string, any>[]))
            : Promise.resolve([]),
    ]);
    const planPor = new Map(planes.map((p) => [p.id, p]));
    const saldoPor = new Map(periodosBanco.map((p) => [p.enrollment_id,
        Number(p.included_minutes) - Number(p.consumed_minutes) - Number(p.reserved_minutes)]));
    const equipoPor = new Map(equipos.map((t) => [t.id, t]));
    const primariaSet = new Set(primarias.map((p) => p.enrollment_id));

    const hoy = todayInZone();
    const pausado = (e: Record<string, any>) => !!e.paused_at && (!e.paused_until || String(e.paused_until).slice(0, 10) >= hoy);
    const enrollments = inscripciones.map((e) => {
        const plan = e.offering_plan_id ? planPor.get(e.offering_plan_id) : null;
        const team = e.team_id ? equipoPor.get(e.team_id) : null;
        const sugerido = Number(e.monthly_fee) > 0 ? Number(e.monthly_fee)
            : Number(plan?.price) > 0 ? Number(plan?.price)
                : Number(team?.price_monthly) > 0 ? Number(team?.price_monthly) : null;
        return {
            enrollment_id: e.id,
            status: e.status,
            paused: pausado(e),
            is_primary: primariaSet.has(e.id),
            plan: plan ? {
                id: plan.id, name: plan.name, hours_plan: Number(plan.included_minutes_per_period) > 0,
                // Para vender horas adicionales: la misma tarifa que usa el cobro de excedentes.
                included_minutes: Number(plan.included_minutes_per_period) > 0 ? Number(plan.included_minutes_per_period) : null,
                hourly_rate: tarifaPorHora(Number(plan.price), Number(plan.included_minutes_per_period)),
                available_minutes: saldoPor.get(e.id) ?? null,
            } : null,
            team: team ? { id: team.id, name: team.name } : null,
            suggested_monthly_amount: sugerido,
            amount_source: Number(e.monthly_fee) > 0 ? 'tarifa_del_atleta' : Number(plan?.price) > 0 ? 'plan' : Number(team?.price_monthly) > 0 ? 'equipo' : null,
        };
    });

    const ocupado = new Set(ocupados.filter((p) => !p.period_uniqueness_exempt && p.period_year && p.period_month)
        .map((p) => `${p.period_year}-${p.period_month}`));
    let y = Number(hoy.slice(0, 4));
    let m = Number(hoy.slice(5, 7));
    let proximo: { year: number; month: number } | null = null;
    for (let i = 0; i <= 3; i++) {
        if (!ocupado.has(`${y}-${m}`)) { proximo = { year: y, month: m }; break; }
        m += 1; if (m > 12) { m = 1; y += 1; }
    }

    return {
        enrollments,
        has_active_enrollment: enrollments.some((e) => e.status === 'active'),
        next_free_period: proximo,
        overage_charges: excedentes.map((x) => ({
            id: x.id, enrollment_id: x.enrollment_id, period_id: x.period_id, amount: Number(x.amount),
            billable_hours: x.billable_hours, overage_minutes: x.overage_minutes,
        })),
        one_time_fees: [] as unknown[],
    };
}

/** Informe de descuentos (§9.1 `GET /payment-adjustments`). */
export async function informeDeAjustes(schoolId: string, q: { from: string; to: string; reason?: string; limit: number }) {
    let consulta = supabase.from('payment_adjustments')
        .select('id, payment_id, charge_batch_id, kind, origin, applies_to, sequence, basis, pct, amount, scope, context, reason_code, reason_text, amount_before, amount_after, reverts_id, created_by, created_at')
        .eq('school_id', schoolId)
        .gte('created_at', `${q.from}T00:00:00-05:00`)
        .lt('created_at', `${addDaysToDateString(q.to, 1)}T00:00:00-05:00`)
        .order('created_at', { ascending: false })
        .limit(q.limit);
    if (q.reason) consulta = consulta.eq('reason_code', q.reason);
    const { data, error } = await consulta;
    if (error) {
        if (esEsquemaFaltante(error)) throw noDisponible();
        throw new Error(`payment_adjustments: ${error.message}`);
    }
    const filas = (data ?? []) as Record<string, any>[];
    const pagoIds = [...new Set(filas.map((f) => f.payment_id))];
    const { data: pagos } = pagoIds.length
        ? await supabase.from('payments').select('*').in('id', pagoIds).eq('school_id', schoolId)
        : { data: [] as any[] };
    const pagoPor = new Map(((pagos ?? []) as Record<string, any>[]).map((p) => [p.id, p]));
    const atletas = [...pagoPor.values()].map((p) => (p.child_id ? { type: 'child' as const, id: p.child_id }
        : p.user_id ? { type: 'adult' as const, id: p.user_id }
            : p.unregistered_athlete_id ? { type: 'unregistered' as const, id: p.unregistered_athlete_id } : null))
        .filter((x): x is { type: AtletaInput['type']; id: string } => !!x);
    const conNombre: { type: AtletaInput['type']; id: string; name?: string | null }[] = atletas.map((a) => ({ ...a }));
    await ponerNombres(conNombre);
    const nombreAtleta = new Map(conNombre.map((a) => [a.id, a.name ?? null]));
    const quien = await nombresDePerfiles(filas.map((f) => f.created_by));

    const revertidos = new Set(filas.filter((f) => f.kind === 'reversion').map((f) => f.reverts_id));
    const items: Record<string, any>[] = filas.map((f) => {
        const p = pagoPor.get(f.payment_id) ?? {};
        const atletaId = p.child_id ?? p.user_id ?? p.unregistered_athlete_id ?? null;
        return {
            ...f,
            amount: Number(f.amount),
            label: etiquetaDeAjuste(f),
            reverted: revertidos.has(f.id),
            created_by_name: f.created_by ? quien.get(f.created_by) ?? null : 'Sistema',
            payment: { concept: p.concept ?? null, label: p.id ? etiquetaDelCobro(p) : null, status: p.status ?? null, amount: p.amount != null ? Number(p.amount) : null },
            athlete_name: atletaId ? nombreAtleta.get(atletaId) ?? null : null,
            over_50: superaMitad(p),
        };
    });

    const vigentes = items.filter((i) => i.kind !== 'reversion' && !i.reverted);
    const porMotivo: Record<string, { n: number; total: number }> = {};
    for (const i of vigentes) {
        const k = i.kind === 'condonacion_recargo' ? 'condonacion_mora' : i.kind === 'exoneracion' ? 'exoneracion' : i.reason_code;
        porMotivo[k] ??= { n: 0, total: 0 };
        porMotivo[k].n += 1;
        porMotivo[k].total += i.amount;
    }
    return {
        from: q.from,
        to: q.to,
        items,
        totals: {
            descuentos: vigentes.filter((i) => i.kind === 'descuento').reduce((s, i) => s + i.amount, 0),
            recargo_condonado: vigentes.filter((i) => i.kind === 'condonacion_recargo').reduce((s, i) => s + i.amount, 0),
            exonerado: vigentes.filter((i) => i.kind === 'exoneracion').reduce((s, i) => s + i.amount, 0),
            by_reason: porMotivo,
        },
        // Q-D1: el informe resalta descuentos > 50 % y exoneraciones.
        highlights: items.filter((i) => !i.reverted && (i.over_50 || i.kind === 'exoneracion')).map((i) => i.id),
    };
}
