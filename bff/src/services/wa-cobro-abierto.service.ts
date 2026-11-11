/**
 * wa-cobro-abierto — el cobro que la ESCUELA ya abrió, y a quién se le aplica un comprobante.
 *
 * Por qué existe (Monster 2026-11-11, plan docs/specs/pago-manual-de-servicio.md §3): Carlos Martínez
 * pagó $175.000 de la clínica y el bot le creó OTRO cobro (externo, $300.000, «parcial») mientras su cobro
 * de la escuela ($175.000, categoría `otro`, dueño `user_id`) seguía pendiente. El bot solo buscaba el
 * cobro previo por `child_id` / ficha / lead, con categoría `clase_extra` y el nombre del ítem en el
 * concepto. Acá:
 *
 *   · `cobroAbiertoDelAtleta`: UNA lectura de los cobros abiertos del dueño (usuario, hijo, ficha o lead),
 *     sin filtro de categoría `clase_extra` (se aceptan `otro` y la del ítem), ligados al ítem por la tabla
 *     de enlace `cobros_servicio_item` (si existe) o por el concepto (nombre del ítem o su prefijo, p. ej.
 *     «Clínica»). Dos o más → ambiguo: a la escuela.
 *   · `reconocerAtletaDelClub`: un contacto con alias `wau-…` (sin teléfono) no es reconocible por el
 *     celular; se resuelve por el NOMBRE que dio en la venta, solo con coincidencia EXACTA y única
 *     (homónimos → a la escuela; precedente Ethann, 05-nov). Nunca por `is_active`.
 *   · `aplicarComprobanteACobroAbierto`: la RPC `aplicar_comprobante_a_cobro_abierto` (tolerante: sin
 *     migración, `migracion_pendiente`).
 *   · `corregirServicioPorMonto`: la «red de seguridad» de la venta (el monto no cuadra con el servicio
 *     elegido pero sí con UN solo otro), con UNA lectura en vez de una por servicio.
 *
 * Nada lanza. Ante un fallo de lectura se dice `error` y quien llama NO crea nada (a la escuela).
 */
import { supabase } from '../config/supabase';
import { esMigracionPendiente } from './ventas-servicios.service';
import { normalizarFrase } from './whatsapp-reglas-turno';
import {
    decidirMontoDeVenta, motivoDelItem, previoDesdeFila,
    type CobroPrevioDeServicio, type DuenoDelCobro, type ItemDeServicio, type MontoDeVenta,
} from './wa-cobro-desde-comprobante.service';

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Un cobro abierto (pendiente, vencido o con abono aprobado) con sus dueños y su ligadura al ítem. */
export interface CobroAbierto extends CobroPrevioDeServicio {
    categoria: string | null;
    userId: string | null;
    unregisteredId: string | null;
    leadId: string | null;
    /** El ítem al que lo liga `cobros_servicio_item` (null: sin enlace, o la tabla no existe todavía). */
    itemEnlazado: string | null;
}

export type CobroAbiertoDelAtleta =
    | { tipo: 'uno'; cobro: CobroAbierto }
    /** Dos o más cobros abiertos del mismo servicio: no se elige uno; a la escuela. */
    | { tipo: 'ambiguo'; cobros: CobroAbierto[] }
    | { tipo: 'ninguno' }
    /** La lectura falló: NO se crea nada (a la escuela). */
    | { tipo: 'error' };

export interface LlavesDeCobro {
    userIds?: string[];
    childIds?: string[];
    unregisteredIds?: string[];
    leadIds?: string[];
}

/** Estados de un cobro «abierto»: lo que se le puede aplicar un comprobante. */
export const ESTADOS_ABIERTOS = ['pending', 'overdue', 'partial'];

const RE_ID = /^[\w-]{1,64}$/;

const SELECT_COBRO = 'id, amount, amount_paid, status, ocr_amount, concept, child_id, user_id, unregistered_athlete_id, signup_lead_id, payment_category';

// ─── Ligadura al ítem ────────────────────────────────────────────────────────

/** Primeras palabras que no identifican un servicio («Clase…», «Torneo…»): no sirven de prefijo. */
const PALABRAS_GENERICAS = new Set(['clase', 'clases', 'curso', 'taller', 'sesion', 'entrenamiento', 'pago', 'cobro',
    'cuota', 'mensualidad', 'torneo', 'campamento', 'copa', 'inscripcion', 'servicio', 'evento', 'actividad']);

/**
 * Cómo se nombra el servicio en el concepto de un cobro de la escuela, normalizado: el nombre entero y su
 * prefijo («Clínica de armadores y atacantes» → «clinica»), más los alias que se pasen. Pura.
 */
export function aliasesDelServicio(item: { name?: string | null; alias?: string[] | null }): string[] {
    const nombre = normalizarFrase(item.name);
    const out = new Set<string>();
    if (nombre) out.add(nombre);
    const primera = nombre.split(' ')[0] ?? '';
    if (primera.length >= 5 && !PALABRAS_GENERICAS.has(primera)) out.add(primera);
    for (const a of item.alias ?? []) {
        const n = normalizarFrase(a);
        if (n) out.add(n);
    }
    return [...out];
}

/**
 * Los cobros que son de ESE servicio: ligados por el enlace al ítem (manda: si está ligado a otro, no es de
 * este) o, sin enlace, con el nombre del ítem o su prefijo en el concepto. Pura.
 */
export function cobrosDelServicio(
    cobros: CobroAbierto[], item: { id: string; name?: string | null; alias?: string[] | null },
): CobroAbierto[] {
    const aliases = aliasesDelServicio(item);
    return cobros.filter((c) => {
        if (c.itemEnlazado) return c.itemEnlazado === item.id;
        const concepto = normalizarFrase(c.concept);
        return !!concepto && aliases.some((a) => concepto.includes(a));
    });
}

const enlaceDe = (fila: any): string | null => {
    const e = fila?.cobros_servicio_item;
    const v = Array.isArray(e) ? e[0]?.item_id : e?.item_id;
    return typeof v === 'string' && v ? v : null;
};

const cobroDesdeFila = (f: any): CobroAbierto => ({
    ...previoDesdeFila(f),
    categoria: f.payment_category ?? null,
    userId: f.user_id ?? null,
    unregisteredId: f.unregistered_athlete_id ?? null,
    leadId: f.signup_lead_id ?? null,
    itemEnlazado: enlaceDe(f),
});

// ─── Lectura ─────────────────────────────────────────────────────────────────

/**
 * Los cobros abiertos de esas llaves, de categoría `otro` o la del ítem, ligados (o no) a ESE servicio.
 * UNA lectura (con el enlace embebido; si esa tabla no existe, la misma sin el enlace). null si falla.
 */
async function leerCobrosAbiertos(
    schoolId: string, k: LlavesDeCobro, item: Pick<ItemDeServicio, 'id' | 'name' | 'kind'>,
): Promise<CobroAbierto[] | null> {
    const columnas: [string, string[]][] = [
        ['user_id', k.userIds ?? []], ['child_id', k.childIds ?? []],
        ['unregistered_athlete_id', k.unregisteredIds ?? []], ['signup_lead_id', k.leadIds ?? []],
    ];
    const partes = columnas
        .map(([c, ids]) => [c, [...new Set(ids.filter((id) => typeof id === 'string' && RE_ID.test(id)))]] as [string, string[]])
        .filter(([, ids]) => ids.length > 0);
    if (!schoolId || !partes.length) return [];
    const categorias = [...new Set(['otro', motivoDelItem(item)])];
    const leer = (cols: string) => {
        let q: any = supabase.from('payments').select(cols)
            .eq('school_id', schoolId).in('status', ESTADOS_ABIERTOS).in('payment_category', categorias);
        q = partes.length === 1
            ? q.in(partes[0][0], partes[0][1])
            : q.or(partes.map(([c, ids]) => `${c}.in.(${ids.join(',')})`).join(','));
        return q.order('created_at', { ascending: false }).limit(30);
    };
    try {
        let { data, error } = await leer(`${SELECT_COBRO}, cobros_servicio_item(item_id)`);
        if (error) ({ data, error } = await leer(SELECT_COBRO));
        if (error || !Array.isArray(data)) return null;
        return (data as any[]).map(cobroDesdeFila);
    } catch {
        return null;
    }
}

/**
 * El cobro abierto del atleta por ESE servicio. UNA lectura. Un cobro → `uno`; dos o más → `ambiguo`
 * (a la escuela); ninguno → `ninguno`; fallo → `error`. Nunca lanza.
 */
export async function cobroAbiertoDelAtleta(
    schoolId: string, dueno: DuenoDelCobro, item: Pick<ItemDeServicio, 'id' | 'name' | 'kind'> & { alias?: string[] | null },
): Promise<CobroAbiertoDelAtleta> {
    const filas = await leerCobrosAbiertos(schoolId, {
        userIds: dueno.userId ? [dueno.userId] : [], childIds: dueno.childId ? [dueno.childId] : [],
        unregisteredIds: dueno.unregisteredId ? [dueno.unregisteredId] : [], leadIds: dueno.leadId ? [dueno.leadId] : [],
    }, item);
    if (filas === null) return { tipo: 'error' };
    const mios = cobrosDelServicio(filas, item);
    if (mios.length === 1) return { tipo: 'uno', cobro: mios[0] };
    return mios.length ? { tipo: 'ambiguo', cobros: mios } : { tipo: 'ninguno' };
}

/** El dueño de un cobro (para aplicarle el comprobante): el que el cobro dice, no el del contacto. */
export function duenoDelCobro(c: CobroAbierto): DuenoDelCobro {
    if (c.userId) return { userId: c.userId };
    if (c.childId) return { childId: c.childId };
    if (c.unregisteredId) return { unregisteredId: c.unregisteredId };
    return { leadId: c.leadId };
}

// ─── Contacto sin teléfono (alias wau-) ──────────────────────────────────────

export interface PersonaDelClub {
    key: string;
    nombre: string;
    userId: string | null;
    unregisteredIds: string[];
}

export type ReconocimientoDeAtleta =
    | { tipo: 'ninguno' }
    /** Dos o más personas del club con ese nombre: NO se aplica nada por nombre. */
    | { tipo: 'homonimos'; n: number }
    | { tipo: 'uno'; persona: PersonaDelClub; cobros: CobroAbierto[] }
    | { tipo: 'error' };

/** `%mart_nez%carlos%`: cada palabra con los caracteres no ASCII como comodín (la base guarda tildes). Pura. */
export function patronDeNombre(nombre: string): string {
    const palabras = String(nombre ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        .map((w) => w.replace(/[^a-z0-9]/g, '_').replace(/%/g, ''));
    return `%${palabras.join('%')}%`;
}

/**
 * ¿Quién del club se llama EXACTAMENTE así? Fichas (`unregistered_athletes`, con o sin vínculo y aunque estén
 * inactivas: una ficha consolidada con su perfil sigue siendo la persona) y perfiles con membresía en la
 * escuela. Con UNA persona, sus cobros abiertos de ese servicio. Tres lecturas pequeñas, solo para un contacto
 * sin teléfono con nombre completo. Nunca lanza.
 */
export async function reconocerAtletaDelClub(
    schoolId: string, nombre: string, item: Pick<ItemDeServicio, 'id' | 'name' | 'kind'> & { alias?: string[] | null },
): Promise<ReconocimientoDeAtleta> {
    const norm = normalizarFrase(nombre);
    if (!schoolId || norm.split(' ').length < 2) return { tipo: 'ninguno' };
    const patron = patronDeNombre(nombre);
    try {
        const [fichas, perfiles] = await Promise.all([
            supabase.from('unregistered_athletes').select('id, full_name, linked_profile_id')
                .eq('school_id', schoolId).ilike('full_name', patron).limit(50),
            supabase.from('profiles').select('id, full_name').ilike('full_name', patron).limit(50),
        ]);
        if (fichas.error || perfiles.error) return { tipo: 'error' };
        const personas = new Map<string, PersonaDelClub>();
        const agregar = (key: string, p: Partial<PersonaDelClub> & { nombre: string }) => {
            const actual = personas.get(key) ?? { key, nombre: p.nombre, userId: null, unregisteredIds: [] };
            if (p.userId) actual.userId = p.userId;
            for (const u of p.unregisteredIds ?? []) if (!actual.unregisteredIds.includes(u)) actual.unregisteredIds.push(u);
            personas.set(key, actual);
        };
        for (const f of (fichas.data ?? []) as any[]) {
            if (normalizarFrase(f.full_name) !== norm) continue;
            const link = f.linked_profile_id ? String(f.linked_profile_id) : null;
            agregar(link ?? `u:${f.id}`, { nombre: String(f.full_name), userId: link, unregisteredIds: [String(f.id)] });
        }
        const delNombre = ((perfiles.data ?? []) as any[]).filter((p) => normalizarFrase(p.full_name) === norm);
        if (delNombre.length) {
            const { data: miembros, error } = await supabase.from('school_members').select('profile_id')
                .eq('school_id', schoolId).in('profile_id', delNombre.map((p) => p.id));
            if (error) return { tipo: 'error' };
            const dentro = new Set(((miembros ?? []) as any[]).map((m) => String(m.profile_id)));
            for (const p of delNombre) if (dentro.has(String(p.id))) agregar(String(p.id), { nombre: String(p.full_name), userId: String(p.id) });
        }
        if (personas.size === 0) return { tipo: 'ninguno' };
        if (personas.size > 1) return { tipo: 'homonimos', n: personas.size };
        const persona = [...personas.values()][0];
        const filas = await leerCobrosAbiertos(schoolId, {
            userIds: persona.userId ? [persona.userId] : [], unregisteredIds: persona.unregisteredIds,
        }, item);
        if (filas === null) return { tipo: 'error' };
        return { tipo: 'uno', persona, cobros: cobrosDelServicio(filas, item) };
    } catch {
        return { tipo: 'error' };
    }
}

// ─── RPC aplicar_comprobante_a_cobro_abierto ─────────────────────────────────

export type ResultadoAplicarAbierto =
    | { ok: true; paymentId: string; estado: 'paid' | 'partial' | string }
    /** `codigo`: ambiguo | en_revision | sobrepago | sin_cobro_abierto | migracion_pendiente | error. */
    | { ok: false; codigo: string; paymentId?: string; candidatos?: string[] };

/**
 * La RPC que aplica el comprobante al cobro abierto (solo service_role; idempotente por `queue_id`). Sin la
 * migración → `migracion_pendiente` y quien llama sigue por la lectura directa. Nunca lanza.
 */
export async function aplicarComprobanteACobroAbierto(i: {
    schoolId: string; queueId: string; monto: number; itemId: string | null; dueno: DuenoDelCobro;
    paymentId?: string | null; origen?: string;
}): Promise<ResultadoAplicarAbierto> {
    try {
        const { data, error } = await supabase.rpc('aplicar_comprobante_a_cobro_abierto', {
            p_school_id: i.schoolId, p_queue_id: i.queueId, p_monto: i.monto, p_item_id: i.itemId,
            p_child_id: i.dueno.childId ?? null, p_user_id: i.dueno.userId ?? null,
            p_unregistered_id: i.dueno.unregisteredId ?? null, p_signup_lead_id: i.dueno.leadId ?? null,
            p_payment_id: i.paymentId ?? null, p_origen: i.origen ?? 'comprobante_bot',
        });
        if (error) {
            if (esMigracionPendiente(error)) return { ok: false, codigo: 'migracion_pendiente' };
            console.warn('[wa-cobro-abierto] la RPC falló', { schoolId: i.schoolId, code: error.code, msg: error.message });
            return { ok: false, codigo: 'error' };
        }
        const r = (data ?? {}) as Record<string, unknown>;
        if (r.ok === true && typeof r.payment_id === 'string') {
            return { ok: true, paymentId: r.payment_id, estado: typeof r.estado === 'string' ? r.estado : 'partial' };
        }
        return {
            ok: false, codigo: String(r.codigo ?? 'error'),
            ...(typeof r.payment_id === 'string' ? { paymentId: r.payment_id } : {}),
            ...(Array.isArray(r.candidatos) ? { candidatos: (r.candidatos as unknown[]).map(String) } : {}),
        };
    } catch {
        return { ok: false, codigo: 'error' };
    }
}

// ─── Red de seguridad de la venta ────────────────────────────────────────────

/**
 * Los cobros vivos del dueño por cada servicio, en UNA lectura (categoría del ítem y concepto con su nombre,
 * como `cobroPrevioDelServicio`). null si falla o no hay dueño que mirar sin leer.
 */
export async function cobrosPreviosPorServicio(
    schoolId: string, dueno: DuenoDelCobro | null, items: Pick<ItemDeServicio, 'id' | 'name' | 'kind'>[],
): Promise<Map<string, CobroPrevioDeServicio | null> | null> {
    const out = new Map<string, CobroPrevioDeServicio | null>();
    for (const it of items) out.set(it.id, null);
    if (!dueno || !items.length) return out;
    try {
        let q: any = supabase.from('payments')
            .select('id, amount, amount_paid, status, ocr_amount, concept, child_id, payment_category')
            .eq('school_id', schoolId)
            .in('payment_category', [...new Set(items.map((it) => motivoDelItem(it)))])
            .in('status', ['pending', 'overdue', 'awaiting_approval', 'partial', 'paid']);
        if (dueno.childId) q = q.eq('child_id', dueno.childId);
        else if (dueno.unregisteredId) q = q.eq('unregistered_athlete_id', dueno.unregisteredId);
        else if (dueno.userId) q = q.eq('user_id', dueno.userId);
        else if (dueno.leadId) q = q.eq('signup_lead_id', dueno.leadId);
        else return out;
        const { data, error } = await q.order('created_at', { ascending: false }).limit(40);
        if (error || !Array.isArray(data)) return null;
        for (const it of items) {
            const nombre = normalizarFrase(it.name);
            const fila = (data as any[]).find((p) => p.payment_category === motivoDelItem(it)
                && !!nombre && normalizarFrase(p.concept).includes(nombre));
            out.set(it.id, fila ? previoDesdeFila(fila) : null);
        }
        return out;
    } catch {
        return null;
    }
}

export interface ServicioCorregido<T extends ItemDeServicio> {
    item: T;
    decision: MontoDeVenta;
    previo: CobroPrevioDeServicio | null;
}

/**
 * Red de seguridad (Monster 2026-11-10, Gabriela: el abono de $150.000 de la clínica se comparó con el
 * Vacacional): si el monto no cuadra con el servicio elegido pero cuadra con UN solo otro servicio vigente
 * (con el precio de afiliado si lo es y el del día del pago), el comprobante es de ese. Con dos o más
 * coincidencias, ninguna, o si la lectura del cobro previo falla, no se corrige (a la escuela como siempre).
 * UNA lectura de cobros (no una por servicio). Nunca lanza.
 */
export async function corregirServicioPorMonto<T extends ItemDeServicio>(i: {
    schoolId: string; monto: number; otros: T[]; dueno: DuenoDelCobro | null; afiliado: boolean; fechaPago?: string | null;
}): Promise<ServicioCorregido<T> | null> {
    try {
        if (!i.otros.length) return null;
        const previos = await cobrosPreviosPorServicio(i.schoolId, i.dueno, i.otros);
        if (!previos) return null;
        const cuadran: ServicioCorregido<T>[] = [];
        for (const it of i.otros) {
            const previo = previos.get(it.id) ?? null;
            const decision = decidirMontoDeVenta(i.monto, it, { afiliado: i.afiliado, fechaPago: i.fechaPago ?? null, previo });
            if (decision.tipo !== 'no_cuadra' && decision.tipo !== 'ambiguo') cuadran.push({ item: it, decision, previo });
        }
        return cuadran.length === 1 ? cuadran[0] : null;
    } catch {
        return null;
    }
}
