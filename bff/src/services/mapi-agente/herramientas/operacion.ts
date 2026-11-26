/**
 * Oleada 5 (plan §19.4, fila 5): tienda, reservas y contabilidad. Solo
 * administración: el entrenador nunca ve plata (plan §4).
 *
 * Cada herramienta va sobre lo MISMO que usa la pantalla (§19.2):
 *   · ventas_tienda   → pedidos de la tienda de la escuela (lo que lee Pedidos,
 *                       storeApi.fetchSellerOrders) y la cifra de ventas de
 *                       store-inventory.buildSalesInsights (panel de la tienda).
 *   · inventario      → products + product_variants con store-inventory.productStockView
 *                       (mismo cálculo que GET /api/v1/vendor/products).
 *   · reservas        → la agenda de Instalaciones › Reservas (facility_reservations
 *                       + cupos de clase en session_bookings) y lo libre según la
 *                       RPC disponibilidad_canchas (la del modal del admin).
 *   · ajustar_stock   → RPC inventory_adjust (SECURITY DEFINER, FOR UPDATE, kardex),
 *                       la misma de POST /api/v1/vendor/products/:id/inventory.
 *                       Nunca un UPDATE directo de stock (CLAUDE.md).
 *   · cancelar_reserva→ RPC cancelar_reserva, la misma de POST /api/v1/reservations/:id/cancel
 *                       que usa la pantalla para las reservas con starts_at.
 *
 * Módulo apagado = rechazo «tu escuela no tiene ese módulo». El estado del
 * módulo no está en `Alcance`, así que se revisa dentro de ejecutar/preparar:
 *   · tienda:   flag global store_enabled() + tienda de la escuela activa y
 *               verificada (mismo criterio que useSchoolStore.isOpen) + can_manage_store_as.
 *   · reservas: has_entitlement(escuela, 'reservations') y el módulo
 *               «sedes_instalaciones» sin apagar por el Super Admin.
 *
 * Las acciones nacen APAGADAS: se ofrecen solo con MAPI_OPERACION_ACCIONES=true.
 *
 * Texto de reservas (nombres, notas) que va al modelo: envuelto con
 * wrapUntrustedForLlm (docs/specs/reservas-agentes-ia-contrato-seguro.md §9).
 */

import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import { isStoreEnabled } from '../../store-flag.service';
import { canManageStoreAs, findSchoolStore, profileCanSellProducts, type SchoolStoreSummary } from '../../store-access';
import { buildSalesInsights, productStockView, type StockLevel } from '../../store-inventory';
import { normalizeOrderStatus, type StoreOrderStatus } from '../../store-order-status';
import { mapStoreRpcError } from '../../store-rpc-errors';
import { isRpcFailure, translateRpcError } from '../../../utils/reservations.shared';
import { sanitizeFreeText, wrapUntrustedForLlm } from '../../../utils/sanitize';
import { writeAudit } from '../../../utils/auditWrite';
import { normalizar } from '../deportistas';
import { esFechaIso, esMes, fechaCorta, fechaLarga, limitesDelMes, nombreDelMes, sumarDias } from '../fechas';
import {
    RechazoHerramienta, type Alcance, type Herramienta, type HerramientaAccion, type HerramientaConsulta,
} from '../tipos';

// ─── Comunes ────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mismo formato que estado-de-cuenta.fmtCop (sin importar ese servicio entero). */
const fmtCop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const hhmm = (t: unknown) => String(t ?? '').slice(0, 5);
const mayuscula = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Fecha de Bogotá (UTC−5, sin horario de verano) de un timestamptz. */
const diaBogota = (iso: string) => new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);

const validarCon = <T>(schema: z.ZodType<T>) => (args: unknown): T => {
    const r = schema.safeParse(args ?? {});
    if (!r.success) throw new RechazoHerramienta(`Datos inválidos para la herramienta: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    return r.data;
};

export const FLAG_ACCIONES = 'MAPI_OPERACION_ACCIONES';
const accionesPrendidas = () => process.env[FLAG_ACCIONES] === 'true';
const soloAdminHabilitada = (a: Alcance) => a.rol === 'admin';
const accionHabilitada = (a: Alcance) => a.rol === 'admin' && accionesPrendidas();

/** El registro ya filtra por rol; esto es la segunda puerta (al ejecutar y al confirmar). */
function soloAdmin(a: Alcance): void {
    if (a.rol !== 'admin') throw new RechazoHerramienta('Esto es solo para la administración de la escuela.');
}

// ─── Tienda: ¿la escuela la tiene? ──────────────────────────────────────────

export const SIN_TIENDA = 'Tu escuela no tiene la tienda activada. Se activa en «Tu tienda › Activar tienda».';

/** Mismo criterio que useSchoolStore.isOpen: activa, verificada y con permiso de vender productos. */
export function tiendaAbierta(t: Pick<SchoolStoreSummary, 'is_active' | 'verification_status' | 'capabilities'>): boolean {
    return profileCanSellProducts(t) && t.verification_status === 'verified';
}

async function tiendaDe(a: Alcance): Promise<SchoolStoreSummary> {
    soloAdmin(a);
    if (!(await isStoreEnabled())) throw new RechazoHerramienta('La tienda de SportMaps está apagada por ahora.');
    const t = await findSchoolStore(a.schoolId);
    if (!t || !tiendaAbierta(t)) throw new RechazoHerramienta(SIN_TIENDA);
    // La base decide quién gestiona la tienda (owner/admin de la escuela, no coach).
    if (!(await canManageStoreAs(t.id, a.userId, t.user_id))) {
        throw new RechazoHerramienta('No tienes permiso para gestionar la tienda de esta escuela.');
    }
    return t;
}

// ─── Reservas: ¿la escuela tiene el módulo? ─────────────────────────────────

export const SIN_RESERVAS = 'Tu escuela no tiene el módulo de reservas de instalaciones.';

async function moduloReservas(a: Alcance): Promise<void> {
    soloAdmin(a);
    const [ent, apagado] = await Promise.all([
        supabase.rpc('has_entitlement', { p_school_id: a.schoolId, p_key: 'reservations' }),
        supabase.from('school_module_overrides').select('module_key')
            .eq('school_id', a.schoolId).eq('module_key', 'sedes_instalaciones').eq('enabled', false).limit(1),
    ]);
    if (ent.error) throw new Error(`has_entitlement: ${ent.error.message}`);
    if (ent.data !== true || ((apagado.data as any[]) ?? []).length > 0) throw new RechazoHerramienta(SIN_RESERVAS);
}

interface Instalacion { id: string; nombre: string; reservable: boolean }

async function instalacionesDe(schoolId: string): Promise<Instalacion[]> {
    const { data, error } = await supabase.from('facilities').select('id, name, status, booking_enabled')
        .eq('school_id', schoolId).order('name').limit(200);
    if (error) throw new Error(`facilities: ${error.message}`);
    return ((data as any[]) ?? []).map((f) => ({
        id: String(f.id),
        nombre: sanitizeFreeText(f.name, { max: 80 }) || 'Instalación sin nombre',
        reservable: f.status === 'available' && f.booking_enabled !== false,
    }));
}

/** Por id o por nombre (sin tildes ni signos), solo entre las de la escuela. */
function resolverInstalacion(todas: Instalacion[], texto: string): Instalacion {
    if (UUID.test(texto)) {
        const f = todas.find((x) => x.id.toLowerCase() === texto.toLowerCase());
        if (!f) throw new RechazoHerramienta('No encontré esa instalación en esta escuela.');
        return f;
    }
    const buscado = clave(texto);
    if (!buscado) throw new RechazoHerramienta('Dime el nombre de la instalación.');
    const exactas = todas.filter((x) => clave(x.nombre) === buscado);
    const candidatas = exactas.length ? exactas : todas.filter((x) => clave(x.nombre).includes(buscado));
    if (candidatas.length === 1) return candidatas[0];
    if (!candidatas.length) {
        throw new RechazoHerramienta(`No encontré una instalación llamada «${sanitizeFreeText(texto, { max: 60 })}». Las de la escuela: ${todas.slice(0, 8).map((x) => x.nombre).join(', ') || 'ninguna'}.`);
    }
    throw new RechazoHerramienta(`Hay varias instalaciones que coinciden: ${candidatas.slice(0, 6).map((x) => x.nombre).join(', ')}. ¿Cuál?`);
}

const ESTADO_RESERVA: Record<string, string> = {
    hold: 'apartada (esperando pago)', pending_payment: 'pendiente de pago', pending: 'pendiente de aprobar',
    confirmed: 'confirmada', pending_reconciliation: 'pago por conciliar', completed: 'completada',
    no_show: 'no asistió', cancelled: 'cancelada', expired: 'vencida',
};
const PAGO_RESERVA: Record<string, string> = { unpaid: 'sin pagar', partial: 'abono', paid: 'pagada', waived: 'sin costo' };
/** Desde estos estados el staff puede cancelar (contrato F1 §4; mismo set que cancelar_reserva). */
const CANCELABLES = ['hold', 'pending', 'pending_payment', 'confirmed', 'pending_reconciliation'];

// ─── ventas_tienda ──────────────────────────────────────────────────────────

const ESTADO_PEDIDO: Record<StoreOrderStatus, string> = {
    pending_payment: 'pendiente de pago', awaiting_approval: 'comprobante por revisar', payment_review: 'en revisión',
    paid: 'pagado', preparing: 'en preparación', ready_for_pickup: 'listo para retirar', shipped: 'enviado',
    delivered: 'entregado', expired: 'vencido', cancelled: 'cancelado', refunded: 'reembolsado', partially_refunded: 'reembolso parcial',
};

/** Mismos grupos que la pantalla Pedidos (orderStatus.ORDER_STATUS_GROUPS). */
const GRUPOS_PEDIDO: { grupo: string; estados: StoreOrderStatus[] }[] = [
    { grupo: 'Por cobrar', estados: ['pending_payment', 'awaiting_approval', 'payment_review'] },
    { grupo: 'Pagados', estados: ['paid'] },
    { grupo: 'En curso', estados: ['preparing', 'ready_for_pickup', 'shipped'] },
    { grupo: 'Entregados', estados: ['delivered'] },
    { grupo: 'Cerrados', estados: ['expired', 'cancelled', 'refunded', 'partially_refunded'] },
];

export const TOPE_PEDIDOS = 2000;

export const ventasTienda: HerramientaConsulta<{ periodo: string | null }> = {
    tipo: 'consulta',
    nombre: 'ventas_tienda',
    descripcion: 'Pedidos y ventas de la tienda de la escuela en un mes: cuántos hay por estado, cuánto se vendió (solo pedidos pagados), lo más vendido y lo que falta atender. Solo administración.',
    esquema: {
        type: 'object',
        properties: { periodo: { type: ['string', 'null'], description: 'Mes AAAA-MM. null = el mes en curso.' } },
        required: ['periodo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: soloAdminHabilitada,
    validar(args) {
        const r = validarCon(z.object({ periodo: z.string().trim().nullable().optional() }))(args);
        if (r.periodo && !esMes(r.periodo)) throw new RechazoHerramienta('El mes tiene que venir como AAAA-MM (ej. 2026-11).');
        return { periodo: r.periodo || null };
    },
    async ejecutar(a, { periodo }) {
        const t = await tiendaDe(a);
        const mes = periodo ?? a.hoy.slice(0, 7);
        const { desde, hasta } = limitesDelMes(mes);
        // Mes calendario de Bogotá: 00:00 local = 05:00 UTC.
        const { data, error } = await supabase.from('orders')
            .select('id, reference, status, total_amount, created_at, customer_name, order_items(product_id, quantity, line_total, subtotal, unit_price)')
            .eq('vendor_profile_id', t.id)
            .gte('created_at', `${desde}T05:00:00.000Z`).lt('created_at', `${sumarDias(hasta, 1)}T05:00:00.000Z`)
            .order('created_at', { ascending: false }).limit(TOPE_PEDIDOS);
        if (error) throw new Error(`orders: ${error.message}`);
        const pedidos = (data as any[]) ?? [];

        const estadoDe = (o: any) => normalizeOrderStatus(o.status);
        const items = pedidos.flatMap((o) => ((o.order_items as any[]) ?? []).map((it) => ({ ...it, order_id: o.id })));
        const idsProducto = [...new Set(items.map((it) => it.product_id).filter(Boolean))] as string[];
        const nombres: Record<string, string> = {};
        if (idsProducto.length) {
            const { data: prods, error: errP } = await supabase.from('products').select('id, name')
                .eq('vendor_profile_id', t.id).in('id', idsProducto.slice(0, 500));
            if (errP) throw new Error(`products: ${errP.message}`);
            for (const p of (prods as any[]) ?? []) nombres[String(p.id)] = sanitizeFreeText(p.name, { max: 80 });
        }
        // Misma cifra que el panel de la tienda: solo pedidos en los que el dinero entró.
        const ventas = buildSalesInsights(pedidos.map((o) => ({ id: o.id, status: String(o.status), total_amount: o.total_amount })), items, nombres);

        const contar = (estados: StoreOrderStatus[]) => pedidos.filter((o) => estados.includes(estadoDe(o) as StoreOrderStatus)).length;
        const unidades = (o: any) => ((o.order_items as any[]) ?? []).reduce((s, i) => s + Math.max(0, num(i.quantity)), 0);
        return {
            tienda: sanitizeFreeText(t.display_name, { max: 80 }) || 'Tienda de la escuela',
            periodo: nombreDelMes(mes),
            pedidos: pedidos.length,
            por_estado: GRUPOS_PEDIDO.map((g) => {
                const de = pedidos.filter((o) => g.estados.includes(estadoDe(o) as StoreOrderStatus));
                return { grupo: g.grupo, pedidos: de.length, total: fmtCop(de.reduce((s, o) => s + num(o.total_amount), 0)) };
            }).filter((g) => g.pedidos > 0),
            vendido: {
                total: fmtCop(ventas.revenue), pedidos_pagados: ventas.orders,
                ticket_promedio: fmtCop(ventas.avg_ticket), unidades: ventas.units,
            },
            mas_vendidos: ventas.top_products.map((p) => ({ producto: p.name, unidades: p.units, total: fmtCop(p.revenue) })),
            por_atender: {
                comprobantes_por_revisar: contar(['awaiting_approval', 'payment_review']),
                pagados_por_preparar: contar(['paid']),
                en_preparacion: contar(['preparing']),
                listos_para_retirar: contar(['ready_for_pickup']),
            },
            // Sin teléfono, correo ni documento del comprador (plan §12.1).
            ultimos: pedidos.slice(0, 8).map((o) => ({
                ref: String(o.reference || `#${String(o.id).slice(0, 8)}`),
                dia: o.created_at ? fechaCorta(diaBogota(String(o.created_at))) : null,
                estado: ESTADO_PEDIDO[estadoDe(o) as StoreOrderStatus] ?? 'sin estado',
                total: fmtCop(num(o.total_amount)),
                articulos: unidades(o),
                cliente: o.customer_name ? wrapUntrustedForLlm('cliente', o.customer_name, 60) : null,
            })),
            ...(pedidos.length >= TOPE_PEDIDOS ? { nota: `Hay más de ${TOPE_PEDIDOS} pedidos en el mes: las cifras pueden quedar cortas; revísalas en Pedidos.` } : {}),
        };
    },
};

// ─── inventario ─────────────────────────────────────────────────────────────

const ESTADO_PRODUCTO: Record<string, string> = {
    active: 'publicado', draft: 'borrador', pending_review: 'en revisión', rejected: 'rechazado',
};
const NIVEL: Record<StockLevel, string> = { ok: 'normal', low: 'bajo', out: 'agotado' };
const COLS_PRODUCTO = 'id, name, status, price, stock, reserved, min_stock_alert, product_variants(id, name, stock, reserved, is_active)';
export const TOPE_PRODUCTOS = 500;

const activas = (p: any) => ((p.product_variants as any[]) ?? []).filter((v) => v.is_active !== false);

function filaProducto(p: any, conVariantes: boolean) {
    const v = productStockView(p);
    return {
        id: String(p.id),
        nombre: sanitizeFreeText(p.name, { max: 80 }),
        estado: ESTADO_PRODUCTO[p.status] ?? String(p.status ?? ''),
        precio: fmtCop(num(p.price)),
        stock: v.stock_total,
        reservado: v.reserved_total,
        disponible: v.available_total,
        nivel: NIVEL[v.stock_level],
        ...(v.has_variants && !conVariantes ? { variantes_agotadas: v.out_of_stock_variants, variantes_bajas: v.low_stock_variants } : {}),
        ...(v.has_variants && conVariantes ? {
            variantes: activas(p).map((x) => ({
                id: String(x.id),
                nombre: sanitizeFreeText(x.name, { max: 60 }),
                stock: Math.max(0, num(x.stock)),
                reservado: Math.max(0, num(x.reserved)),
                disponible: Math.max(0, num(x.stock) - num(x.reserved)),
            })),
        } : {}),
    };
}

async function productosDeLaTienda(storeId: string): Promise<any[]> {
    const { data, error } = await supabase.from('products').select(COLS_PRODUCTO)
        .eq('vendor_profile_id', storeId).neq('status', 'archived').order('name').limit(TOPE_PRODUCTOS);
    if (error) throw new Error(`products: ${error.message}`);
    return (data as any[]) ?? [];
}

/** Palabras de un nombre («M / Azul» → ['m', 'azul']), sin tildes ni signos. */
const palabrasDe = (s: string) => normalizar(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Coincidencias por nombre: exactas; si no, por palabra completa; si no, las que
 * lo contienen. La palabra completa va antes que la subcadena: «L» como talla no
 * debe coincidir con la «l» de «Azul» (evals 2026-11-24).
 */
function porNombre<T>(todos: T[], texto: string, nombre: (x: T) => string): T[] {
    const buscado = clave(texto);
    if (!buscado) return [];
    const exactos = todos.filter((x) => clave(nombre(x)) === buscado);
    if (exactos.length) return exactos;
    const buscadas = palabrasDe(texto);
    const porPalabra = todos.filter((x) => {
        const p = palabrasDe(nombre(x));
        return buscadas.every((b) => p.includes(b));
    });
    if (porPalabra.length) return porPalabra;
    return todos.filter((x) => clave(nombre(x)).includes(buscado));
}

export const inventario: HerramientaConsulta<{ producto: string | null }> = {
    tipo: 'consulta',
    nombre: 'inventario',
    descripcion: 'Inventario de la tienda de la escuela: stock, reservado en pedidos y disponible de cada producto (y de cada talla o color), con los agotados y los de stock bajo. Opcional: un producto por nombre. Solo administración.',
    esquema: {
        type: 'object',
        properties: { producto: { type: ['string', 'null'], description: 'Opcional: nombre o parte del nombre del producto' } },
        required: ['producto'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: soloAdminHabilitada,
    validar(args) {
        const r = validarCon(z.object({ producto: z.string().trim().max(80).nullable().optional() }))(args);
        return { producto: r.producto || null };
    },
    async ejecutar(a, { producto }) {
        const t = await tiendaDe(a);
        const todos = await productosDeLaTienda(t.id);
        if (!todos.length) return { productos: 0, nota: 'La tienda todavía no tiene productos.' };
        const vistas = todos.map((p) => ({ p, v: productStockView(p) }));
        const agotados = vistas.filter((x) => x.v.stock_level === 'out').length;
        const bajos = vistas.filter((x) => x.v.stock_level === 'low').length;

        if (producto) {
            const hallados = porNombre(todos, producto, (p) => String(p.name ?? ''));
            if (!hallados.length) return { productos: todos.length, nota: `No hay un producto llamado «${sanitizeFreeText(producto, { max: 60 })}» en la tienda.` };
            return {
                productos: todos.length,
                encontrados: hallados.length,
                lista: hallados.slice(0, 10).map((p) => filaProducto(p, true)),
                ...(hallados.length > 10 ? { nota: `Hay ${hallados.length} coincidencias: pide un nombre más preciso.` } : {}),
            };
        }

        const orden: Record<StockLevel, number> = { out: 0, low: 1, ok: 2 };
        const atencion = vistas.filter((x) => x.v.stock_level !== 'ok')
            .sort((x, y) => orden[x.v.stock_level] - orden[y.v.stock_level] || String(x.p.name).localeCompare(String(y.p.name), 'es'));
        return {
            productos: todos.length,
            agotados,
            stock_bajo: bajos,
            // Primero lo que necesita atención; el resto solo se cuenta.
            lista: atencion.slice(0, 30).map((x) => filaProducto(x.p, false)),
            con_stock_normal: todos.length - agotados - bajos,
            ...(todos.length >= TOPE_PRODUCTOS ? { nota: `Leí los primeros ${TOPE_PRODUCTOS} productos.` } : {}),
        };
    },
};

// ─── reservas ───────────────────────────────────────────────────────────────

const COLS_RESERVA = 'id, facility_id, status, payment_status, reservation_date, start_time, end_time, starts_at, ends_at, price, amount_paid, participants, notes, user_id, guest_booker_id, external_org_name, requester:profiles!facility_reservations_user_id_fkey(full_name)';
const TOPE_INSTALACIONES = 15;

const unoDe = (x: any) => (Array.isArray(x) ? x[0] : x) ?? null;

/** Nombres de invitados (guest_bookers): solo full_name, nunca teléfono ni correo. */
async function nombresDeInvitados(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const { data, error } = await supabase.from('guest_bookers').select('id, full_name').in('id', ids.slice(0, 500));
    if (error) throw new Error(`guest_bookers: ${error.message}`);
    for (const g of (data as any[]) ?? []) out.set(String(g.id), String(g.full_name ?? ''));
    return out;
}

function aNombreDe(r: any, invitados: Map<string, string>): string {
    return String(unoDe(r.requester)?.full_name || (r.guest_booker_id && invitados.get(r.guest_booker_id)) || r.external_org_name || 'Sin nombre');
}

/** Franjas libres seguidas → «08:00–12:00». Pura. */
export function franjasLibres(slots: { start_local: string; end_local: string }[], paso: number): string[] {
    const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const orden = [...slots].sort((x, y) => min(x.start_local) - min(y.start_local));
    const out: string[] = [];
    let ini: string | null = null;
    let fin = '';
    let ultimo = -1;
    for (const s of orden) {
        const m = min(s.start_local);
        if (ini !== null && m - ultimo === paso) {
            fin = s.end_local;
        } else {
            if (ini !== null) out.push(`${ini}–${fin}`);
            ini = s.start_local;
            fin = s.end_local;
        }
        ultimo = m;
    }
    if (ini !== null) out.push(`${ini}–${fin}`);
    return out;
}

export const reservas: HerramientaConsulta<{ fecha: string; instalacion: string | null }> = {
    tipo: 'consulta',
    nombre: 'reservas',
    descripcion: 'Agenda de reservas de las instalaciones de la escuela en un día: a nombre de quién, a qué hora, estado y pago, cupos de clase y las franjas que siguen libres. Opcional: una instalación. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            fecha: { type: 'string', description: 'Día, AAAA-MM-DD' },
            instalacion: { type: ['string', 'null'], description: 'Opcional: id o nombre de la cancha, salón o espacio' },
        },
        required: ['fecha', 'instalacion'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: soloAdminHabilitada,
    validar(args) {
        const r = validarCon(z.object({ fecha: z.string().trim(), instalacion: z.string().trim().max(80).nullable().optional() }))(args);
        if (!esFechaIso(r.fecha)) throw new RechazoHerramienta('La fecha tiene que venir como AAAA-MM-DD.');
        return { fecha: r.fecha, instalacion: r.instalacion || null };
    },
    async ejecutar(a, { fecha, instalacion }) {
        await moduloReservas(a);
        const todas = await instalacionesDe(a.schoolId);
        if (!todas.length) return { fecha: fechaLarga(fecha), nota: 'La escuela no tiene instalaciones registradas.' };
        const unica = instalacion ? resolverInstalacion(todas, instalacion) : null;
        const elegidas = unica ? [unica] : todas.slice(0, TOPE_INSTALACIONES);
        const ids = elegidas.map((f) => f.id);

        const [resv, clases, disp] = await Promise.all([
            supabase.from('facility_reservations').select(COLS_RESERVA)
                .in('facility_id', ids).eq('reservation_date', fecha).order('start_time').limit(500),
            // Cupos de clase (socios con plan y clases de cortesía): la pantalla los mezcla en la misma agenda.
            supabase.from('session_bookings').select('id, status, attendance_sessions!inner(session_date, start_time, end_time, facility_id)')
                .eq('school_id', a.schoolId).eq('attendance_sessions.session_date', fecha)
                .in('attendance_sessions.facility_id', ids).limit(1000),
            // Lo libre solo tiene sentido de hoy en adelante.
            fecha >= a.hoy
                ? supabase.rpc('disponibilidad_canchas', {
                    p_school_id: a.schoolId, p_from: fecha, p_to: fecha, p_actor_profile_id: a.userId,
                    ...(unica ? { p_facility_id: unica.id } : {}),
                })
                : Promise.resolve({ data: null, error: null }),
        ]);
        if (resv.error) throw new Error(`facility_reservations: ${resv.error.message}`);
        const filas = (resv.data as any[]) ?? [];
        const invitados = await nombresDeInvitados([...new Set(filas.map((r) => r.guest_booker_id).filter(Boolean))] as string[]);

        const libres = new Map<string, string[]>();
        const dispOk = !disp.error && disp.data && !isRpcFailure(disp.data);
        if (dispOk) {
            for (const f of ((disp.data as any).facilities as any[]) ?? []) {
                const slots = ((f.days as any[]) ?? []).flatMap((d) => (d.slots as any[]) ?? []);
                libres.set(String(f.facility_id), franjasLibres(slots, num(f.slot_step_min) || 60));
            }
        }

        const vivas = filas.filter((r) => r.status !== 'cancelled' && r.status !== 'expired');
        const cupos = clases.error ? null : ((clases.data as any[]) ?? []).filter((b) => b.status !== 'cancelled');

        return {
            fecha: fechaLarga(fecha),
            instalaciones: elegidas.map((f) => {
                const deAqui = vivas.filter((r) => String(r.facility_id) === f.id);
                const porHora = new Map<string, number>();
                for (const b of cupos ?? []) {
                    const s = unoDe(b.attendance_sessions);
                    if (String(s?.facility_id) !== f.id) continue;
                    const k = `${hhmm(s.start_time)}–${hhmm(s.end_time)}`;
                    porHora.set(k, (porHora.get(k) ?? 0) + 1);
                }
                return {
                    id: f.id,
                    nombre: f.nombre,
                    reservas: deAqui.slice(0, 30).map((r) => ({
                        id: String(r.id),
                        hora: `${hhmm(r.start_time)}–${hhmm(r.end_time)}`,
                        estado: ESTADO_RESERVA[r.status] ?? String(r.status),
                        pago: PAGO_RESERVA[r.payment_status] ?? (r.payment_status ? String(r.payment_status) : null),
                        precio: fmtCop(num(r.price)),
                        pagado: fmtCop(num(r.amount_paid)),
                        participantes: num(r.participants) || 1,
                        a_nombre_de: wrapUntrustedForLlm('a_nombre_de', aNombreDe(r, invitados), 80),
                        ...(r.notes ? { notas: wrapUntrustedForLlm('notas', r.notes, 200) } : {}),
                        // Sin starts_at = reserva del sistema anterior: se maneja en la pantalla.
                        ...(r.starts_at ? {} : { sistema_anterior: true }),
                    })),
                    ...(deAqui.length > 30 ? { otras_reservas: deAqui.length - 30 } : {}),
                    ...(porHora.size ? { cupos_de_clase: [...porHora.entries()].sort().map(([hora, personas]) => ({ hora, personas })) } : {}),
                    libre: !f.reservable ? 'no recibe reservas'
                        : fecha < a.hoy ? 'día pasado'
                            : dispOk ? (libres.get(f.id)?.length ? libres.get(f.id) : 'sin franjas libres') : 'no se pudo consultar',
                };
            }),
            ...(filas.length - vivas.length ? { canceladas_o_vencidas: filas.length - vivas.length } : {}),
            ...(cupos === null ? { nota_clases: 'No se pudieron leer los cupos de clase.' } : {}),
            ...(!unica && todas.length > TOPE_INSTALACIONES ? { nota: `Muestro ${TOPE_INSTALACIONES} de ${todas.length} instalaciones; pide una por nombre.` } : {}),
        };
    },
};

// ─── ajustar_stock ──────────────────────────────────────────────────────────

/** Mismos motivos que el diálogo «Ajustar stock» (frontend lib/store/inventory.ADJUST_MOTIVES). */
export const MOTIVOS_STOCK = {
    llego_mercancia: { label: 'Llegó mercancía', reason: 'manual_restock' },
    conteo_fisico: { label: 'Conteo físico', reason: 'manual_adjust' },
    dano_perdida: { label: 'Daño o pérdida', reason: 'manual_adjust' },
    devolucion: { label: 'Devolución de un cliente', reason: 'manual_restock' },
    venta_fuera: { label: 'Venta por fuera de la app', reason: 'manual_adjust' },
    error_carga: { label: 'Corrección de un error', reason: 'manual_adjust' },
} as const;
export type MotivoStock = keyof typeof MOTIVOS_STOCK;
const IDS_MOTIVO = Object.keys(MOTIVOS_STOCK) as [MotivoStock, ...MotivoStock[]];

/** Nota del kardex, igual que buildAdjustNote de la pantalla. */
export function notaDeAjuste(motivo: MotivoStock, detalle: string | null): string {
    const label = MOTIVOS_STOCK[motivo].label;
    const d = (detalle ?? '').trim();
    return (d ? `${label}: ${d}` : label).slice(0, 500);
}

export interface ArgsAjustarStock {
    /** Id del producto (la vista previa lo deja resuelto) o su nombre. */
    producto: string;
    variante: string | null;
    modo: 'sumar' | 'fijar';
    cantidad: number;
    motivo: MotivoStock;
    detalle: string | null;
}

async function resolverProducto(storeId: string, texto: string): Promise<any> {
    if (UUID.test(texto)) {
        const { data, error } = await supabase.from('products').select(COLS_PRODUCTO)
            .eq('vendor_profile_id', storeId).eq('id', texto.toLowerCase()).neq('status', 'archived').maybeSingle();
        if (error) throw new Error(`products: ${error.message}`);
        if (!data) throw new RechazoHerramienta('No encontré ese producto en la tienda de la escuela.');
        return data;
    }
    const todos = await productosDeLaTienda(storeId);
    const hallados = porNombre(todos, texto, (p) => String(p.name ?? ''));
    if (hallados.length === 1) return hallados[0];
    if (!hallados.length) throw new RechazoHerramienta(`No encontré un producto llamado «${sanitizeFreeText(texto, { max: 60 })}» en la tienda.`);
    throw new RechazoHerramienta(`Hay varios productos que coinciden: ${hallados.slice(0, 6).map((p) => sanitizeFreeText(p.name, { max: 60 })).join(', ')}. ¿Cuál?`);
}

const listaVariantes = (vs: any[]) => vs.slice(0, 12).map((v) => `${sanitizeFreeText(v.name, { max: 40 })} (${Math.max(0, num(v.stock))})`).join(', ');

interface Ajuste {
    producto: { id: string; nombre: string };
    variante: { id: string; nombre: string } | null;
    antes: number;
    reservado: number;
    despues: number;
}

async function armarAjuste(a: Alcance, args: ArgsAjustarStock): Promise<{ ok: true; x: Ajuste } | { ok: false; motivo: string }> {
    const t = await tiendaDe(a);
    const p = await resolverProducto(t.id, args.producto);
    const nombre = sanitizeFreeText(p.name, { max: 80 }) || 'Producto';
    const todas = (p.product_variants as any[]) ?? [];
    let variante: Ajuste['variante'] = null;
    let antes: number;
    let reservado: number;
    // Con variantes, inventory_adjust exige la variante (PRODUCT_HAS_VARIANTS).
    if (todas.length) {
        const vivas = activas(p);
        if (!vivas.length) return { ok: false, motivo: `Las tallas o colores de ${nombre} están desactivados; actívalos en el producto.` };
        if (!args.variante) return { ok: false, motivo: `${nombre} tiene tallas o colores: dime cuál. ${listaVariantes(vivas)}.` };
        const v = UUID.test(args.variante)
            ? vivas.filter((x) => String(x.id).toLowerCase() === args.variante!.toLowerCase())
            : porNombre(vivas, args.variante, (x) => String(x.name ?? ''));
        if (v.length !== 1) {
            return { ok: false, motivo: v.length
                ? `Hay varias variantes que coinciden: ${listaVariantes(v)}. ¿Cuál?`
                : `${nombre} no tiene la variante «${sanitizeFreeText(args.variante, { max: 40 })}». Tiene: ${listaVariantes(vivas)}.` };
        }
        variante = { id: String(v[0].id), nombre: sanitizeFreeText(v[0].name, { max: 40 }) };
        antes = Math.max(0, num(v[0].stock));
        reservado = Math.max(0, num(v[0].reserved));
    } else {
        if (args.variante) return { ok: false, motivo: `${nombre} no tiene tallas ni colores: el stock es uno solo.` };
        antes = Math.max(0, num(p.stock));
        reservado = Math.max(0, num(p.reserved));
    }
    const despues = args.modo === 'sumar' ? antes + args.cantidad : args.cantidad;
    const quien = `${nombre}${variante ? ` (${variante.nombre})` : ''}`;
    if (despues < 0) return { ok: false, motivo: `El stock de ${quien} no puede quedar negativo: hoy hay ${antes}.` };
    if (despues < reservado) return { ok: false, motivo: `El stock de ${quien} no puede quedar por debajo de lo reservado en pedidos abiertos (${reservado}).` };
    if (despues === antes) return { ok: false, motivo: `${quien} ya tiene ${antes} unidades.` };
    return { ok: true, x: { producto: { id: String(p.id), nombre }, variante, antes, reservado, despues } };
}

const esquemaAjuste = z.object({
    producto: z.string().trim().min(2).max(80),
    variante: z.string().trim().max(60).nullable().optional(),
    modo: z.enum(['sumar', 'fijar']),
    cantidad: z.number().int().min(-100_000).max(100_000),
    motivo: z.enum(IDS_MOTIVO),
    detalle: z.string().trim().max(300).nullable().optional(),
});

export const ajustarStock: HerramientaAccion<ArgsAjustarStock> = {
    tipo: 'accion',
    nombre: 'ajustar_stock',
    plata: true,
    descripcion: 'PREPARA un ajuste de stock de un producto de la tienda, o de una talla o color (no lo ejecuta: la persona confirma en la tarjeta). «sumar» suma o resta unidades (negativo para restar); «fijar» deja el stock en esa cantidad. Queda en el kardex. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            producto: { type: 'string', description: 'id o nombre del producto' },
            variante: { type: ['string', 'null'], description: 'Talla o color (ej. "M / Azul") si el producto tiene variantes' },
            modo: { type: 'string', enum: ['sumar', 'fijar'] },
            cantidad: { type: 'integer', description: 'Unidades a sumar (negativo resta) o el stock final si es «fijar»' },
            motivo: { type: 'string', enum: [...IDS_MOTIVO] },
            detalle: { type: ['string', 'null'], description: 'Opcional, corto (ej. "factura 1234")' },
        },
        required: ['producto', 'variante', 'modo', 'cantidad', 'motivo', 'detalle'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: accionHabilitada,
    validar(args) {
        const r = esquemaAjuste.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos para el ajuste: producto, modo (sumar o fijar), cantidad entera y motivo.');
        if (r.data.modo === 'fijar' && r.data.cantidad < 0) throw new RechazoHerramienta('Para «fijar», la cantidad es el stock final: no puede ser negativa.');
        if (r.data.modo === 'sumar' && r.data.cantidad === 0) throw new RechazoHerramienta('Sumar 0 unidades no cambia nada.');
        return { ...r.data, variante: r.data.variante || null, detalle: r.data.detalle || null };
    },
    async preparar(a, args) {
        const r = await armarAjuste(a, args);
        if (!r.ok) return r;
        const { x } = r;
        const delta = x.despues - x.antes;
        return {
            ok: true,
            // Producto y variante ya resueltos a su id: el Confirmar no vuelve a buscar por nombre.
            // El modo y la cantidad se conservan: si hubo una venta en el medio, «sumar 10» sigue siendo +10.
            args: { ...args, producto: x.producto.id, variante: x.variante?.id ?? null },
            targetKey: `stock:${x.producto.id}:${x.variante?.id ?? 'producto'}`,
            vista: {
                titulo: `Ajustar stock · ${x.producto.nombre}${x.variante ? ` (${x.variante.nombre})` : ''}`,
                lineas: [
                    `Stock: ${x.antes} → ${x.despues} (${delta > 0 ? '+' : ''}${delta})`,
                    `Motivo: ${MOTIVOS_STOCK[args.motivo].label}${args.detalle ? ` · «${args.detalle}»` : ''}`,
                    x.reservado > 0
                        ? `${plural(x.reservado, 'unidad está reservada', 'unidades están reservadas')} en pedidos abiertos: quedan ${x.despues - x.reservado} para vender.`
                        : `Quedan ${x.despues} para vender.`,
                    'Queda en el historial de inventario (kardex) a tu nombre.',
                ],
                aviso: 'Se corrige con otro ajuste.',
                botonConfirmar: 'Guardar ajuste',
            },
            huella: {
                producto: x.producto.id, variante: x.variante?.id ?? null,
                antes: x.antes, despues: x.despues, reservado: x.reservado,
                motivo: args.motivo, detalle: args.detalle,
            },
        };
    },
    async ejecutar(a, args) {
        const r = await armarAjuste(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const reason = MOTIVOS_STOCK[args.motivo].reason;
        // inventory_adjust: SECURITY DEFINER, bloquea la fila (FOR UPDATE), valida
        // can_manage_store_as(actor) y lo reservado, y deja el kardex.
        const { data, error } = await supabase.rpc('inventory_adjust', {
            p_variant_id: x.variante?.id ?? null,
            p_product_id: x.variante ? null : x.producto.id,
            p_new_stock: x.despues,
            p_reason_code: reason,
            p_note: notaDeAjuste(args.motivo, args.detalle),
            p_actor: a.userId,
        });
        if (error) return { estado: 'failed', resultado: { motivo: mapStoreRpcError(error).message } };
        if ((data as any)?.noop) return { estado: 'failed', resultado: { motivo: 'El stock ya estaba en ese valor.' } };
        await writeAudit({ userId: a.userId, schoolId: a.schoolId }, 'inventory_adjust',
            x.variante ? 'product_variants' : 'products', x.variante?.id ?? x.producto.id,
            null, { new_stock: x.despues, reason_code: reason }, { metadata: { via: 'mapi_agente' } });
        return {
            estado: 'executed',
            resultado: {
                producto: x.producto.nombre, variante: x.variante?.nombre ?? null,
                antes: num((data as any)?.stock_before ?? x.antes), despues: num((data as any)?.stock_after ?? x.despues),
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado !== 'executed') return `No se ajustó el stock. ${x.motivo || 'Intenta de nuevo o hazlo desde Inventario.'}`.trim();
        return `Quedó el stock de ${x.producto}${x.variante ? ` (${x.variante})` : ''} en ${x.despues} (antes ${x.antes}).`;
    },
};

// ─── cancelar_reserva ───────────────────────────────────────────────────────

export interface ArgsCancelarReserva { reserva: string; motivo: string }

interface ReservaLeida {
    fila: any;
    instalacion: Instalacion;
    quien: string;
}

/** La reserva SOLO si es de una instalación de esta escuela. */
async function reservaDeLaEscuela(a: Alcance, id: string): Promise<ReservaLeida> {
    const insts = await instalacionesDe(a.schoolId);
    if (!insts.length) throw new RechazoHerramienta('No encontré esa reserva en esta escuela.');
    const { data, error } = await supabase.from('facility_reservations').select(COLS_RESERVA)
        .eq('id', id.toLowerCase()).in('facility_id', insts.map((f) => f.id)).maybeSingle();
    if (error) throw new Error(`facility_reservations: ${error.message}`);
    if (!data) throw new RechazoHerramienta('No encontré esa reserva en esta escuela.');
    const fila = data as any;
    const invitados = await nombresDeInvitados(fila.guest_booker_id ? [String(fila.guest_booker_id)] : []);
    return {
        fila,
        instalacion: insts.find((f) => f.id === String(fila.facility_id))!,
        quien: sanitizeFreeText(aNombreDe(fila, invitados), { max: 60 }),
    };
}

const cuandoDe = (f: any) => `${fechaLarga(String(f.reservation_date).slice(0, 10))}, ${hhmm(f.start_time)}–${hhmm(f.end_time)}`;

/** ¿Se puede cancelar desde Mapi? null = sí; si no, el motivo. */
function noCancelable(f: any): string | null {
    // Sin starts_at = reserva anterior al sistema nuevo: la pantalla la cancela por otra ruta (con correo).
    if (!f.starts_at) return 'Esa reserva es del sistema anterior: cancélala desde Instalaciones › Reservas.';
    if (f.status === 'cancelled') return 'Esa reserva ya está cancelada.';
    if (!CANCELABLES.includes(String(f.status))) return `Esa reserva ya no se puede cancelar: está ${ESTADO_RESERVA[f.status] ?? f.status}.`;
    return null;
}

export const cancelarReserva: HerramientaAccion<ArgsCancelarReserva> = {
    tipo: 'accion',
    nombre: 'cancelar_reserva',
    plata: true,
    descripcion: 'PREPARA la cancelación de una reserva de instalación (no la ejecuta: la persona confirma en la tarjeta). La vista previa dice si hay devolución. Usa el id que devolvió la herramienta reservas. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            reserva: { type: 'string', description: 'id de la reserva (de la herramienta reservas)' },
            motivo: { type: 'string', description: 'Motivo corto de la cancelación' },
        },
        required: ['reserva', 'motivo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    habilitada: accionHabilitada,
    validar(args) {
        const r = z.object({ reserva: z.string().trim(), motivo: z.string().trim().min(3).max(300) }).safeParse(args ?? {});
        if (!r.success || !UUID.test(r.data.reserva)) throw new RechazoHerramienta('Faltan datos: el id de la reserva (de la herramienta reservas) y un motivo corto.');
        return { reserva: r.data.reserva.toLowerCase(), motivo: sanitizeFreeText(r.data.motivo, { max: 300 }) };
    },
    async preparar(a, args) {
        await moduloReservas(a);
        const { fila: f, instalacion, quien } = await reservaDeLaEscuela(a, args.reserva);
        const no = noCancelable(f);
        if (no) return { ok: false, motivo: no };
        const pagado = num(f.amount_paid);
        return {
            ok: true,
            args,
            targetKey: `reserva:${f.id}`,
            vista: {
                titulo: `Cancelar reserva · ${instalacion.nombre}`,
                lineas: [
                    mayuscula(cuandoDe(f)),
                    `A nombre de ${quien}`,
                    `Estado: ${ESTADO_RESERVA[f.status] ?? f.status} · precio ${fmtCop(num(f.price))}`,
                    // Cancelada por la administración, cancelar_reserva devuelve el 100 % de lo pagado
                    // (contrato F1 §4). No mueve plata: queda «por devolver» para que la escuela lo registre.
                    pagado > 0
                        ? `Se devuelve el 100 % de lo pagado (${fmtCop(pagado)}). La devolución no sale sola: queda por devolver y la registra la escuela.`
                        : 'No hay pagos registrados: no hay devolución.',
                    `Motivo: «${args.motivo}»`,
                    'La franja queda libre para otras reservas. A quien reservó no le llega aviso automático.',
                ],
                aviso: 'Esto no se puede deshacer.',
                botonConfirmar: 'Cancelar la reserva',
            },
            huella: {
                reserva: f.id, estado: f.status, pagado, precio: num(f.price),
                inicio: f.starts_at, fin: f.ends_at, instalacion: f.facility_id, motivo: args.motivo,
            },
        };
    },
    async ejecutar(a, args) {
        await moduloReservas(a);
        const { fila: f, instalacion } = await reservaDeLaEscuela(a, args.reserva);
        const no = noCancelable(f);
        if (no) return { estado: 'failed', resultado: { motivo: no } };
        const { data, error } = await supabase.rpc('cancelar_reserva', {
            p_reservation_id: f.id, p_reason: args.motivo, p_actor_profile_id: a.userId,
        });
        if (error) return { estado: 'failed', resultado: { motivo: 'No se pudo cancelar por un error del sistema. Intenta desde Instalaciones › Reservas.' } };
        if (isRpcFailure(data)) return { estado: 'failed', resultado: { motivo: String(translateRpcError(data).body.error) } };
        const d = data as any;
        if (d?.already_cancelled) return { estado: 'failed', resultado: { motivo: 'Ya estaba cancelada: no se hizo nada.' } };
        // Mismo rastro que la ruta (auditStaffChange): solo si la reserva era de otra persona.
        const dueno = d?.reservation?.user_id ?? f.user_id;
        if (dueno && dueno !== a.userId) {
            await writeAudit({ userId: a.userId, schoolId: a.schoolId }, 'facility_reservation_cancel_staff', 'facility_reservations', String(f.id),
                { status: f.status }, { reason: args.motivo, new_status: d?.reservation?.status ?? 'cancelled' }, { metadata: { via: 'mapi_agente' } });
        }
        const dev = d?.refund ?? {};
        return {
            estado: 'executed',
            resultado: {
                instalacion: instalacion.nombre,
                cuando: cuandoDe(f),
                devolucion: { pct: num(dev.pct), monto: num(dev.amount), estado: dev.status ?? null },
            },
        };
    },
    mensajeResultado(r) {
        const x = r.resultado as any;
        if (r.estado !== 'executed') return `No se canceló la reserva. ${x.motivo || ''}`.trim();
        const dev = x.devolucion?.monto > 0
            ? `Devolución: ${x.devolucion.pct} % (${fmtCop(x.devolucion.monto)}), queda por registrar por la escuela.`
            : 'Sin devolución.';
        return `Quedó cancelada la reserva de ${x.instalacion} del ${x.cuando}. ${dev}`;
    },
};

// ─── Catálogo del módulo ────────────────────────────────────────────────────

/**
 * NO construidas (ver informe de la oleada 5): reservar (choca con el contrato
 * de reservas por IA: canal 'ai' sin efectivo ni uso interno), crear_producto
 * (el asistente exige foto, descripción y atributos; la creación no es
 * transaccional), cierre_de_caja (spec sin construir) y resumen_contable (sin
 * servicio en el BFF).
 */
export const HERRAMIENTAS_OPERACION: Herramienta[] = [
    ventasTienda,
    inventario,
    reservas,
    ajustarStock,
    cancelarReserva,
];
