/**
 * acuerdos-de-pago.service — pago por plazos (F4 de
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md, §5 y D9).
 *
 * Un acuerdo es un compromiso de FECHAS Y MONTOS sobre cobros abiertos. No mueve
 * dinero ni crea cobros: el dinero entra por los abonos que ya existen. Este
 * servicio NUNCA escribe en `payments`; todo lo que cambia datos pasa por las RPC
 * de la migración 20261106160002 (que validan el alcance adentro).
 *
 * Lo puro (reparto, calendario, topes, estados, permisos) va arriba y está probado
 * en acuerdos-de-pago.service.test.ts. Las lecturas/escrituras van con el JWT del
 * usuario (RLS + RPC con alcance), salvo la lectura de topes de la escuela.
 *
 * Textos al usuario: español, tuteo, y NADA de mora/moroso (regla de Monster´s).
 */

import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/supabase';

// ─── Tipos ───────────────────────────────────────────────────────────────────

export const ESTADOS_ACUERDO = ['solicitado', 'activo', 'cumplido', 'incumplido', 'rechazado', 'cancelado'] as const;
export type EstadoAcuerdo = typeof ESTADOS_ACUERDO[number];
export type EstadoCuota = 'pendiente' | 'pagado' | 'vencido';

export interface TopesAcuerdo {
    habilitado: boolean;
    maxCuotas: number;
    maxDias: number;
    autoAprobar: boolean;
}

/** Topes por defecto de la migración (escuela sin fila = apagado). */
export const TOPES_POR_DEFECTO: TopesAcuerdo = { habilitado: false, maxCuotas: 3, maxDias: 60, autoAprobar: true };

/** Techos duros de la base (CHECK): ninguna escuela los supera. */
export const MAX_CUOTAS_ABSOLUTO = 12;
export const MAX_DIAS_ABSOLUTO = 365;

export interface Cuota { seq: number; fecha: string; monto: number }

export type CausaInvalida =
    | 'cuotas_fuera_de_rango' | 'monto_invalido' | 'fecha_invalida' | 'fecha_pasada'
    | 'fechas_desordenadas' | 'fecha_lejana' | 'suma_distinta_del_saldo' | 'saldo_invalido' | 'acuerdos_apagados';

export interface Calendario {
    cuotas: Cuota[];
    saldoTotal: number;
    primeraFecha: string;
    ultimaFecha: string;
    dias: number;
    /** true si no cabe en los topes o la escuela no auto-aprueba: pasa a la administración. */
    requiereAprobacion: boolean;
    motivos: ('mas_cuotas_del_tope' | 'mas_dias_del_tope' | 'sin_autoaprobacion' | 'incumplio_antes')[];
}

export type Resultado<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

// ─── Fechas (todo en día calendario de Colombia, 'YYYY-MM-DD') ───────────────

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Hoy en Bogotá (UTC-5 fijo). */
export function hoyBogota(ahora: number = Date.now()): string {
    return new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10);
}

export function esFechaValida(s: unknown): s is string {
    if (typeof s !== 'string' || !FECHA.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function sumarDias(fecha: string, dias: number): string {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
    return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

// ─── Reparto y calendario ────────────────────────────────────────────────────

/**
 * Reparte `total` (pesos enteros) en `n` cuotas. Todas valen floor(total/n) y la
 * ÚLTIMA absorbe el redondeo, así la suma es exacta. Pura.
 */
export function repartirEnCuotas(total: number, n: number): number[] | null {
    if (!Number.isInteger(total) || total <= 0) return null;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CUOTAS_ABSOLUTO || n > total) return null;
    const base = Math.floor(total / n);
    const cuotas = Array.from({ length: n }, () => base);
    cuotas[n - 1] = total - base * (n - 1);
    return cuotas;
}

/**
 * Fechas por defecto cuando la persona solo dice cuántas cuotas: espaciadas a
 * min(30, maxDias/n) días, la primera ya a esa distancia de hoy. Pura.
 */
export function fechasPorDefecto(hoy: string, n: number, maxDias: number): string[] {
    const paso = Math.max(1, Math.min(30, Math.floor(maxDias / Math.max(n, 1))));
    return Array.from({ length: n }, (_, i) => sumarDias(hoy, paso * (i + 1)));
}

export interface EntradaCalendario {
    saldoTotal: number;
    cuotas?: number;
    /** Fechas elegidas (una por cuota). Si faltan, se proponen. */
    fechas?: string[];
    /** Montos elegidos (uno por cuota). Si faltan, se reparte parejo. */
    montos?: number[];
    hoy: string;
    topes: TopesAcuerdo;
    incumplioAntes?: boolean;
}

/**
 * Propone o valida un calendario. Con cuotas (y opcionalmente fechas/montos) arma
 * las cuotas; con fechas y/o montos sin `cuotas`, la cantidad sale de ellos.
 * Fuera de los topes NO es error: queda `requiereAprobacion` (D9). Sí es error lo
 * que la base también rechaza (techos duros, fechas pasadas, suma distinta). Pura.
 */
export function proponerCalendario(e: EntradaCalendario): Resultado<{ calendario: Calendario }> {
    const bad = (error: CausaInvalida): { ok: false; status: number; error: string } => ({ ok: false, status: 400, error });
    if (!e.topes.habilitado) return { ok: false, status: 409, error: 'acuerdos_apagados' };
    if (!Number.isInteger(e.saldoTotal) || e.saldoTotal <= 0) return bad('saldo_invalido');

    const n = e.cuotas ?? e.fechas?.length ?? e.montos?.length ?? 0;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CUOTAS_ABSOLUTO || n > e.saldoTotal) return bad('cuotas_fuera_de_rango');
    if ((e.fechas && e.fechas.length !== n) || (e.montos && e.montos.length !== n)) return bad('cuotas_fuera_de_rango');

    const fechas = e.fechas ?? fechasPorDefecto(e.hoy, n, e.topes.maxDias);
    if (!fechas.every(esFechaValida)) return bad('fecha_invalida');

    const montos = e.montos ?? repartirEnCuotas(e.saldoTotal, n);
    if (!montos || !montos.every((m) => Number.isInteger(m) && m > 0)) return bad('monto_invalido');
    if (montos.reduce((a, b) => a + b, 0) !== e.saldoTotal) return bad('suma_distinta_del_saldo');

    if (fechas[0] < e.hoy) return bad('fecha_pasada');
    for (let i = 1; i < fechas.length; i++) if (fechas[i] < fechas[i - 1]) return bad('fechas_desordenadas');
    const ultima = fechas[n - 1];
    const dias = diasEntre(e.hoy, ultima);
    if (dias > MAX_DIAS_ABSOLUTO) return bad('fecha_lejana');

    const motivos: Calendario['motivos'] = [];
    if (n > e.topes.maxCuotas) motivos.push('mas_cuotas_del_tope');
    if (dias > e.topes.maxDias) motivos.push('mas_dias_del_tope');
    if (!e.topes.autoAprobar) motivos.push('sin_autoaprobacion');
    if (e.incumplioAntes) motivos.push('incumplio_antes');

    return {
        ok: true,
        calendario: {
            cuotas: fechas.map((fecha, i) => ({ seq: i + 1, fecha, monto: montos[i] })),
            saldoTotal: e.saldoTotal,
            primeraFecha: fechas[0],
            ultimaFecha: ultima,
            dias,
            requiereAprobacion: motivos.length > 0,
            motivos,
        },
    };
}

/** Estado con el que nacería (espejo de la regla de la RPC; la RPC manda). Pura. */
export function estadoInicial(c: Pick<Calendario, 'requiereAprobacion'>, esAdmin = false): 'activo' | 'solicitado' {
    return esAdmin || !c.requiereAprobacion ? 'activo' : 'solicitado';
}

// ─── Estados y permisos ──────────────────────────────────────────────────────

const TRANSICIONES: Record<EstadoAcuerdo, EstadoAcuerdo[]> = {
    solicitado: ['activo', 'rechazado', 'cancelado'],
    activo: ['cumplido', 'incumplido', 'cancelado'],
    cumplido: [], incumplido: [], rechazado: [], cancelado: [],
};

export function puedeTransicionar(de: EstadoAcuerdo, a: EstadoAcuerdo): boolean {
    return TRANSICIONES[de]?.includes(a) ?? false;
}

export const esEstadoFinal = (e: EstadoAcuerdo) => TRANSICIONES[e].length === 0;
/** Mientras está vivo bloquea que sus cobros entren en otro acuerdo. */
export const esVivo = (e: EstadoAcuerdo) => e === 'solicitado' || e === 'activo';

export interface Actor { userId: string; esAdminDeLaEscuela: boolean; esStaffDeLaEscuela: boolean }
export interface AcuerdoMin { school_id: string; payer_profile_id: string | null; requested_by: string | null; status: EstadoAcuerdo }

/** Solo la administración resuelve, y solo lo solicitado. */
export function puedeResolver(a: AcuerdoMin, actor: Actor): boolean {
    return actor.esAdminDeLaEscuela && a.status === 'solicitado';
}
/** El pagador, quien lo pidió o la administración; solo mientras esté vivo. */
export function puedeCancelar(a: AcuerdoMin, actor: Actor): boolean {
    const suyo = a.payer_profile_id === actor.userId || a.requested_by === actor.userId;
    return (suyo || actor.esAdminDeLaEscuela) && esVivo(a.status);
}
/** Ve el acuerdo: el pagador, quien lo pidió o el staff de la escuela. */
export function puedeVer(a: AcuerdoMin, actor: Actor): boolean {
    return a.payer_profile_id === actor.userId || a.requested_by === actor.userId || actor.esStaffDeLaEscuela;
}

// ─── Errores de la base → HTTP ───────────────────────────────────────────────

export function mapearErrorRpc(e: { code?: string; message?: string } | null | undefined): { status: number; error: string } {
    const msg = String(e?.message ?? '');
    const code = String(e?.code ?? '');
    if (code === '42501' || /SIN_PERMISO/.test(msg)) return { status: 403, error: 'forbidden' };
    if (/ACUERDOS_APAGADO/.test(msg)) return { status: 409, error: 'acuerdos_apagados' };
    if (/COBRO_YA_EN_ACUERDO/.test(msg) || code === '23505') return { status: 409, error: 'cobro_ya_en_acuerdo' };
    if (/COBRO_NO_ELEGIBLE/.test(msg)) return { status: 422, error: 'cobro_no_elegible' };
    if (/ACUERDO_NO_ENCONTRADO/.test(msg) || code === 'P0002') return { status: 404, error: 'acuerdo_no_encontrado' };
    if (/ESTADO_INVALIDO/.test(msg)) return { status: 409, error: 'estado_invalido' };
    const m = /DATOS_INVALIDOS:([a-z_]+)/.exec(msg);
    if (m || code === '22023') return { status: 400, error: m?.[1] ?? 'datos_invalidos' };
    if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return { status: 503, error: 'migracion_pendiente' };
    return { status: 500, error: 'error_interno' };
}

// ─── Validación de entradas (sin Zod: las rutas usan Zod, esto es el espejo puro) ─

export interface CuotaEntrada { due_date: string; amount: number }

// ─── Acceso a datos ──────────────────────────────────────────────────────────

type Db = { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>; from: (t: string) => any };

/** Cliente con el JWT del usuario (RLS + RPC con alcance). `authorization` = header tal cual. */
export function clienteDeUsuario(authorization: string): Db {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authorization } },
        auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as Db;
}

/** Topes de la escuela (service role; no es sensible). Sin fila o sin columnas = apagado. */
export async function topesDeEscuela(schoolId: string, db: Db = supabase as unknown as Db): Promise<TopesAcuerdo> {
    const { data, error } = await db.from('school_settings')
        .select('payment_agreements_enabled, agreement_max_installments, agreement_max_days, agreement_auto_approve')
        .eq('school_id', schoolId).maybeSingle();
    if (error) {
        if (['42703', 'PGRST204', '42P01'].includes(String(error.code))) return TOPES_POR_DEFECTO;
        throw new Error(`school_settings: ${error.message}`);
    }
    if (!data) return TOPES_POR_DEFECTO;
    return {
        habilitado: data.payment_agreements_enabled === true,
        maxCuotas: Number(data.agreement_max_installments ?? TOPES_POR_DEFECTO.maxCuotas),
        maxDias: Number(data.agreement_max_days ?? TOPES_POR_DEFECTO.maxDias),
        autoAprobar: data.agreement_auto_approve !== false,
    };
}

/**
 * Guarda los topes de la escuela (service role; la ruta ya verificó que quien llama administra ESA escuela).
 * Primero actualiza la fila existente; si la escuela aún no tiene fila de ajustes, la crea. Valida rangos
 * igual que el CHECK de la base (cuotas 1–12, días 1–365).
 */
export async function guardarTopes(
    schoolId: string,
    t: TopesAcuerdo,
    db: Db = supabase as unknown as Db,
): Promise<Resultado<{ topes: TopesAcuerdo }>> {
    if (!Number.isInteger(t.maxCuotas) || t.maxCuotas < 1 || t.maxCuotas > MAX_CUOTAS_ABSOLUTO) {
        return { ok: false, status: 400, error: 'max_cuotas_fuera_de_rango' };
    }
    if (!Number.isInteger(t.maxDias) || t.maxDias < 1 || t.maxDias > MAX_DIAS_ABSOLUTO) {
        return { ok: false, status: 400, error: 'max_dias_fuera_de_rango' };
    }
    const fila = {
        payment_agreements_enabled: t.habilitado === true,
        agreement_max_installments: t.maxCuotas,
        agreement_max_days: t.maxDias,
        agreement_auto_approve: t.autoAprobar !== false,
    };
    const upd = await db.from('school_settings').update(fila).eq('school_id', schoolId).select('school_id');
    if (upd.error) {
        if (['42703', 'PGRST204', '42P01'].includes(String(upd.error.code))) return { ok: false, status: 503, error: 'migracion_pendiente' };
        throw new Error(`school_settings: ${upd.error.message}`);
    }
    if (!Array.isArray(upd.data) || upd.data.length === 0) {
        const ins = await db.from('school_settings').insert({ school_id: schoolId, ...fila });
        if (ins.error) throw new Error(`school_settings: ${ins.error.message}`);
    }
    return { ok: true, topes: { ...t, habilitado: fila.payment_agreements_enabled, autoAprobar: fila.agreement_auto_approve } };
}

export interface CobroAbierto { id: string; concept: string | null; due_date: string; saldo: number; status: string }

/**
 * Cobros que se pueden plazar (con el JWT del usuario: RLS decide qué ve). Devuelve
 * solo los pedidos, de esa escuela, abiertos y con saldo. Si falta alguno → `faltan`.
 */
export async function cobrosParaAcuerdo(db: Db, schoolId: string, ids: string[]):
    Promise<{ cobros: CobroAbierto[]; faltan: string[] }> {
    const { data, error } = await db.from('payments')
        .select('id, concept, due_date, amount, amount_paid, status')
        .eq('school_id', schoolId).in('id', ids).in('status', ['pending', 'overdue', 'partial']);
    if (error) throw new Error(`payments: ${error.message}`);
    const cobros: CobroAbierto[] = ((data as any[]) ?? [])
        .map((p) => ({
            id: String(p.id), concept: p.concept ?? null, due_date: String(p.due_date),
            saldo: Math.max(Number(p.amount) - Number(p.amount_paid ?? 0), 0), status: String(p.status),
        }))
        .filter((p) => p.saldo > 0);
    const vistos = new Set(cobros.map((c) => c.id));
    return { cobros, faltan: ids.filter((id) => !vistos.has(id)) };
}

/** ¿Alguno de estos cobros tuvo un acuerdo incumplido? (no se auto-aprueba otro). */
export async function incumplioAntes(db: Db, ids: string[]): Promise<boolean> {
    const { data, error } = await db.from('payment_agreement_payments')
        .select('agreement_id, payment_agreements!inner(status)')
        .in('payment_id', ids).eq('payment_agreements.status', 'incumplido').limit(1);
    if (error) return false; // sin la migración o sin permiso: la RPC es la que manda
    return ((data as any[]) ?? []).length > 0;
}

export async function previsualizar(db: Db, p: {
    schoolId: string; paymentIds: string[]; cuotas?: number; fechas?: string[]; montos?: number[]; ahora?: number;
}): Promise<Resultado<{ cobros: CobroAbierto[]; calendario: Calendario; topes: TopesAcuerdo }>> {
    const topes = await topesDeEscuela(p.schoolId);
    if (!topes.habilitado) return { ok: false, status: 409, error: 'acuerdos_apagados' };
    const { cobros, faltan } = await cobrosParaAcuerdo(db, p.schoolId, p.paymentIds);
    if (faltan.length > 0) return { ok: false, status: 422, error: 'cobro_no_elegible' };
    const saldoTotal = cobros.reduce((a, c) => a + c.saldo, 0);
    const r = proponerCalendario({
        saldoTotal, cuotas: p.cuotas, fechas: p.fechas, montos: p.montos,
        hoy: hoyBogota(p.ahora), topes, incumplioAntes: await incumplioAntes(db, p.paymentIds),
    });
    if (!r.ok) return r;
    return { ok: true, cobros, calendario: r.calendario, topes };
}

export async function solicitar(db: Db, p: {
    schoolId: string; paymentIds: string[]; items: CuotaEntrada[]; payerProfileId?: string | null;
}): Promise<Resultado<{ acuerdo: { agreement_id: string; status: EstadoAcuerdo; auto_approved: boolean; total_amount: number; installments: number } }>> {
    const { data, error } = await db.rpc('request_payment_agreement', {
        p_school_id: p.schoolId, p_payment_ids: p.paymentIds, p_items: p.items,
        p_payer_profile_id: p.payerProfileId ?? null, p_source: null,
    });
    if (error) return { ok: false, ...mapearErrorRpc(error) };
    return { ok: true, acuerdo: data };
}

export async function resolver(db: Db, id: string, decision: 'aprobar' | 'rechazar', nota: string | null):
    Promise<Resultado<{ agreement_id: string; status: EstadoAcuerdo }>> {
    const { data, error } = await db.rpc('resolve_payment_agreement', { p_agreement_id: id, p_decision: decision, p_note: nota });
    if (error) return { ok: false, ...mapearErrorRpc(error) };
    return { ok: true, agreement_id: data.agreement_id, status: data.status };
}

export async function cancelar(db: Db, id: string, nota: string | null):
    Promise<Resultado<{ agreement_id: string; status: EstadoAcuerdo }>> {
    const { data, error } = await db.rpc('cancel_payment_agreement', { p_agreement_id: id, p_note: nota });
    if (error) return { ok: false, ...mapearErrorRpc(error) };
    return { ok: true, agreement_id: data.agreement_id, status: data.status };
}

const COLUMNAS = `id, school_id, payer_profile_id, requested_by, status, source, installments, total_amount,
  first_due_date, last_due_date, auto_approved, approved_at, resolution_note, created_at,
  items:payment_agreement_items(id, seq, due_date, amount, status, paid_at),
  cobros:payment_agreement_payments(payment_id, balance_at_request)`;

/** Los acuerdos del propio usuario (RLS ya filtra; el filtro explícito deja la intención clara). */
export async function misAcuerdos(db: Db, userId: string, estados?: EstadoAcuerdo[]) {
    let q = db.from('payment_agreements').select(COLUMNAS).eq('payer_profile_id', userId)
        .order('created_at', { ascending: false }).limit(100);
    if (estados?.length) q = q.in('status', estados);
    const { data, error } = await q;
    if (error) return { ok: false as const, ...mapearErrorRpc(error) };
    return { ok: true as const, acuerdos: ordenarCuotas((data as any[]) ?? []) };
}

/** Los de una escuela (RLS: staff de esa escuela; otra escuela = 0 filas). */
export async function acuerdosDeEscuela(db: Db, schoolId: string, estados?: EstadoAcuerdo[]) {
    let q = db.from('payment_agreements').select(COLUMNAS).eq('school_id', schoolId)
        .order('created_at', { ascending: false }).limit(300);
    if (estados?.length) q = q.in('status', estados);
    const { data, error } = await q;
    if (error) return { ok: false as const, ...mapearErrorRpc(error) };
    return { ok: true as const, acuerdos: ordenarCuotas((data as any[]) ?? []) };
}

function ordenarCuotas(rows: any[]): any[] {
    return rows.map((a) => ({ ...a, items: [...(a.items ?? [])].sort((x, y) => x.seq - y.seq) }));
}

/** ¿Es admin (owner/admin) o staff de esa escuela? Se pregunta con las funciones de la base. */
export async function alcanceEnEscuela(db: Db, schoolId: string): Promise<{ admin: boolean; staff: boolean }> {
    const [a, s] = await Promise.all([db.rpc('user_admin_school_ids'), db.rpc('user_staff_school_ids')]);
    const ids = (r: { data: any }) => (Array.isArray(r.data) ? (r.data as string[]) : []);
    return { admin: ids(a).includes(schoolId), staff: ids(s).includes(schoolId) };
}
