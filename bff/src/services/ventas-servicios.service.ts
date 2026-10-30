/**
 * Ventas por WhatsApp, CARRIL B (cobros de servicio): catálogo, cobro suelto y
 * anulación de los que no se pagaron a tiempo.
 *
 * Envuelve las tres RPC de la migración 20261007095911 (spec
 * docs/specs/ventas-por-whatsapp.md §16; contrato con F1/F2 en §17):
 *   · wa_catalogo_servicios            — lo que el bot puede ofrecer.
 *   · wa_crear_cobro_suelto            — UN cobro en payments, idempotente, con cupos.
 *   · wa_anular_cobros_sueltos_vencidos — el job de la hora (maintenance.job.ts).
 *
 * Reglas:
 *   · Precio, monto, concepto, categoría y vencimiento salen de la base. El
 *     modelo de lenguaje nunca los pone.
 *   · Las RPC son solo de service_role: este servicio usa el cliente del BFF.
 *   · Nada lanza. Si la migración no está aplicada, cada función lo dice
 *     ('migracion_pendiente') y el bot sigue como hoy.
 */
import { supabase } from '../config/supabase';
import { MOTIVOS_DE_SERVICIO } from './motivos-de-cobro';

/** Subconjunto tipado del catálogo único de motivos (motivos-de-cobro.ts) = CHECK `school_tournament_items_kind_chk`. */
export type TipoServicio = (typeof MOTIVOS_DE_SERVICIO)[number];
/** Igual a payments.payment_category del cobro que se crea. */
export type CategoriaServicio = TipoServicio;

export const TIPOS_SERVICIO: readonly TipoServicio[] = MOTIVOS_DE_SERVICIO;

export interface ServicioEnVenta {
    id: string;
    nombre: string;
    descripcion: string | null;
    tipo: TipoServicio;
    /** Precio de lista de la base (COP). El total a pagar sale del link (incluye el recargo en línea). */
    precio: number;
    imagenUrl: string | null;
    /** ISO UTC o null. */
    iniciaEn: string | null;
    terminaEn: string | null;
    /** null = sin límite. */
    cupos: number | null;
    cuposRestantes: number | null;
    /** true = se cobra por atleta (preguntar a cuál hijo). */
    porAtleta: boolean;
}

export type CatalogoServicios =
    | { ok: true; habilitado: boolean; items: ServicioEnVenta[] }
    | { ok: false; code: 'migracion_pendiente' | 'error'; error: string };

export type CodigoCobroSuelto =
    | 'migracion_pendiente' | 'ventas_deshabilitadas' | 'escuela_no_operativa'
    | 'item_no_disponible' | 'item_vencido' | 'item_sin_precio'
    | 'familia_no_valida' | 'atleta_requerido' | 'atleta_no_valido'
    | 'ya_inscrito' | 'sin_cupos' | 'clave_invalida' | 'clave_reutilizada' | 'error';

export interface CrearCobroSueltoInput {
    schoolId: string;
    itemId: string;
    /** parent_id que devolvió wa_identify_by_phone EN ESTE TURNO. */
    parentId: string;
    /** Obligatorio si el ítem es porAtleta. */
    childId: string | null;
    /** La de data.idempotency_key del flujo (8–200 caracteres). */
    idempotencyKey: string;
    conversationId?: string | null;
    /** Vigencia del cobro en minutos (15–120, por defecto 60). */
    minutosVigencia?: number;
}

export interface CobroSueltoCreado {
    ok: true;
    paymentId: string;
    /** true = la clave ya existía y se devolvió el mismo cobro. */
    idempotente: boolean;
    /** Monto del cobro (precio del catálogo, sin recargo en línea). */
    monto: number;
    concepto: string;
    categoria: CategoriaServicio;
    /**
     * payments.status actual del cobro. En un cobro nuevo es 'pending'; en uno
     * idempotente puede ser otro ('paid', 'cancelled' si ya venció…): con
     * 'cancelled' hay que generar una clave nueva («retomar»).
     */
    estado: string;
    /** ISO UTC: desde cuándo (más el margen) lo anula el job si no se paga. */
    venceEn: string;
    cuposRestantes: number | null;
}

export interface CobroSueltoFallido {
    ok: false;
    code: CodigoCobroSuelto;
    error: string;
    /** Solo con 'ya_inscrito': el cobro vivo que ya existe (reenviar su link). */
    paymentId?: string;
}

export interface ResultadoAnulacion {
    ok: boolean;
    migracionPendiente: boolean;
    revisados: number;
    anulados: number;
    paymentIds: string[];
}

/** Minutos por defecto para pagar (decisión del usuario: 1 hora). */
export const MINUTOS_VIGENCIA_COBRO_SUELTO = 60;

/** Mensajes para logs y para quien llama; el bot redacta su propio texto. */
const MENSAJES: Record<CodigoCobroSuelto, string> = {
    migracion_pendiente: 'Las ventas por WhatsApp todavía no están disponibles (migración sin aplicar).',
    ventas_deshabilitadas: 'La escuela no tiene habilitadas las ventas por WhatsApp.',
    escuela_no_operativa: 'La escuela no está operativa.',
    item_no_disponible: 'Ese servicio no está disponible.',
    item_vencido: 'Ese servicio ya pasó.',
    item_sin_precio: 'Ese servicio no tiene precio.',
    familia_no_valida: 'El acudiente no tiene atletas activos en la escuela.',
    atleta_requerido: 'Hay que elegir a qué atleta es.',
    atleta_no_valido: 'Ese atleta no es del acudiente en esta escuela.',
    ya_inscrito: 'Ya hay un cobro de ese servicio para ese atleta.',
    sin_cupos: 'No quedan cupos.',
    clave_invalida: 'Clave de idempotencia inválida.',
    clave_reutilizada: 'La clave de idempotencia ya se usó para otra compra.',
    error: 'No pudimos crear el cobro.',
};

const CODIGOS = new Set(Object.keys(MENSAJES));

/** ¿El error dice que la función, tabla o columna todavía no existe? */
export function esMigracionPendiente(err: unknown): boolean {
    const e = err as { code?: string; message?: string } | null | undefined;
    if (!e) return false;
    if (e.code === 'PGRST202' || e.code === '42883' || e.code === '42P01' || e.code === '42703') return true;
    return /could not find the function|does not exist/i.test(String(e.message ?? ''));
}

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
};
const numONull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : num(v));
const strONull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const tipo = (v: unknown): TipoServicio =>
    (TIPOS_SERVICIO as readonly string[]).includes(String(v)) ? (v as TipoServicio) : 'otro';

/** Fila jsonb de wa_catalogo_servicios → ServicioEnVenta. null si viene rota. */
export function servicioDesdeFila(f: Record<string, unknown> | null | undefined): ServicioEnVenta | null {
    if (!f || typeof f.id !== 'string' || typeof f.nombre !== 'string') return null;
    return {
        id: f.id,
        nombre: f.nombre,
        descripcion: strONull(f.descripcion),
        tipo: tipo(f.tipo),
        precio: num(f.precio),
        imagenUrl: strONull(f.imagen_url),
        iniciaEn: strONull(f.inicia_en),
        terminaEn: strONull(f.termina_en),
        cupos: numONull(f.cupos),
        cuposRestantes: numONull(f.cupos_restantes),
        porAtleta: f.por_atleta !== false,
    };
}

/** Catálogo del carril B de una escuela: solo activos y no vencidos; `limite` 1–20 (por defecto 10). */
export async function catalogoServicios(
    schoolId: string,
    opts: { buscar?: string | null; limite?: number } = {},
): Promise<CatalogoServicios> {
    if (!schoolId) return { ok: true, habilitado: false, items: [] };
    const limite = Math.min(20, Math.max(1, Math.floor(opts.limite ?? 10)));
    const buscar = typeof opts.buscar === 'string' && opts.buscar.trim() ? opts.buscar.trim().slice(0, 200) : null;
    try {
        const { data, error } = await supabase.rpc('wa_catalogo_servicios', {
            p_school_id: schoolId,
            p_buscar: buscar,
            p_limite: limite,
        });
        if (error) {
            if (esMigracionPendiente(error)) {
                return { ok: false, code: 'migracion_pendiente', error: MENSAJES.migracion_pendiente };
            }
            console.warn('[ventas-servicios] catálogo falló', { schoolId, code: error.code, msg: error.message });
            return { ok: false, code: 'error', error: 'No pudimos leer el catálogo.' };
        }
        const r = (data ?? {}) as { habilitado?: unknown; items?: unknown };
        const filas = Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [];
        const items = filas.map(servicioDesdeFila).filter((x): x is ServicioEnVenta => x !== null);
        return { ok: true, habilitado: r.habilitado === true, items };
    } catch (e: any) {
        console.warn('[ventas-servicios] catálogo lanzó', { schoolId, error: e?.message });
        return { ok: false, code: 'error', error: 'No pudimos leer el catálogo.' };
    }
}

const fallo = (code: CodigoCobroSuelto, paymentId?: string): CobroSueltoFallido =>
    paymentId ? { ok: false, code, error: MENSAJES[code], paymentId } : { ok: false, code, error: MENSAJES[code] };

/**
 * Crea (o devuelve, si la clave ya existe) el cobro suelto de un servicio para
 * una familia identificada. El link de pago lo arma quien llama con
 * `crearLinkWompiConMonto(paymentId, { minutos })`.
 */
export async function crearCobroSuelto(input: CrearCobroSueltoInput): Promise<CobroSueltoCreado | CobroSueltoFallido> {
    const clave = String(input?.idempotencyKey ?? '').trim();
    if (clave.length < 8 || clave.length > 200) return fallo('clave_invalida');
    if (!input.schoolId || !input.itemId) return fallo('item_no_disponible');
    if (!input.parentId) return fallo('familia_no_valida');

    const minutos = Math.min(120, Math.max(15, Math.floor(input.minutosVigencia ?? MINUTOS_VIGENCIA_COBRO_SUELTO)));
    try {
        const { data, error } = await supabase.rpc('wa_crear_cobro_suelto', {
            p_school_id: input.schoolId,
            p_item_id: input.itemId,
            p_parent_id: input.parentId,
            p_child_id: input.childId ?? null,
            p_idempotency_key: clave,
            p_conversation_id: input.conversationId ?? null,
            p_minutos_vigencia: minutos,
        });
        if (error) {
            if (esMigracionPendiente(error)) return fallo('migracion_pendiente');
            console.warn('[ventas-servicios] crear cobro falló', {
                schoolId: input.schoolId, itemId: input.itemId, code: error.code, msg: error.message,
            });
            return fallo('error');
        }
        const r = (data ?? {}) as Record<string, unknown>;
        if (r.ok !== true) {
            const codigo = String(r.codigo ?? 'error');
            const code = (CODIGOS.has(codigo) ? codigo : 'error') as CodigoCobroSuelto;
            return fallo(code, typeof r.payment_id === 'string' ? r.payment_id : undefined);
        }
        if (typeof r.payment_id !== 'string') return fallo('error');
        return {
            ok: true,
            paymentId: r.payment_id,
            idempotente: r.idempotente === true,
            monto: num(r.monto),
            concepto: String(r.concepto ?? ''),
            categoria: tipo(r.categoria),
            estado: String(r.estado ?? 'pending'),
            venceEn: String(r.vence_at ?? ''),
            cuposRestantes: numONull(r.cupos_restantes),
        };
    } catch (e: any) {
        console.warn('[ventas-servicios] crear cobro lanzó', { schoolId: input.schoolId, error: e?.message });
        return fallo('error');
    }
}

/** Lo corre maintenance.job.ts cada 5 min (kill-switch DISABLE_VENTAS_ANULAR_VENCIDOS=true). */
export async function anularCobrosSueltosVencidos(
    opts: { limite?: number; margenMinutos?: number } = {},
): Promise<ResultadoAnulacion> {
    const vacio = (extra: Partial<ResultadoAnulacion>): ResultadoAnulacion => ({
        ok: false, migracionPendiente: false, revisados: 0, anulados: 0, paymentIds: [], ...extra,
    });
    try {
        const { data, error } = await supabase.rpc('wa_anular_cobros_sueltos_vencidos', {
            p_limite: Math.min(1000, Math.max(1, Math.floor(opts.limite ?? 200))),
            p_margen_minutos: Math.min(240, Math.max(0, Math.floor(opts.margenMinutos ?? 15))),
        });
        if (error) {
            if (esMigracionPendiente(error)) return vacio({ migracionPendiente: true });
            console.warn('[ventas-servicios] anular vencidos falló', { code: error.code, msg: error.message });
            return vacio({});
        }
        const r = (data ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(r.payment_ids) ? (r.payment_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        return {
            ok: true,
            migracionPendiente: false,
            revisados: num(r.revisados),
            anulados: num(r.anulados),
            paymentIds: ids,
        };
    } catch (e: any) {
        console.warn('[ventas-servicios] anular vencidos lanzó', { error: e?.message });
        return vacio({});
    }
}
