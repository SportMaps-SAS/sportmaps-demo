/**
 * wa-cobro-desde-comprobante — crear el cobro que falta a partir del comprobante.
 *
 * Por qué existe (Monster 2026-10-30, plan B4 §3): la clase de prueba, la
 * matrícula, los uniformes o la clínica se pagan ANTES de que exista el cobro.
 * El comprobante llegaba, no había a qué aplicarlo y terminaba en la bandeja de
 * la escuela; para un prospecto (sin ficha) ni siquiera había dónde dejarlo.
 * Ahora, si el motivo tiene precio en la escuela, el asistente crea el cobro con
 * la RPC `wa_crear_cobro_desde_comprobante` y lo deja EN REVISIÓN con el
 * comprobante, como cualquier otro.
 *
 * Reglas:
 *   · El precio lo decide la BASE (la RPC lo toma de la fuente: trial_price,
 *     registration_fee del plan, artículo o servicio), nunca el BFF. Acá solo se
 *     PROPONE el motivo por el monto.
 *   · Todo detrás de `school_settings.wa_cobro_desde_comprobante` (nace false):
 *     apagado, la cola hace exactamente lo de hoy.
 *   · Nada lanza. Columna, tabla o RPC sin aplicar → como apagado.
 */
import { supabase } from '../config/supabase';
import { MOTIVO, type Motivo } from './motivos-de-cobro';
import { esMigracionPendiente } from './ventas-servicios.service';
import { categoriaDelCobro } from './tipo-de-cobro';
import { buildVerdictContext } from './receipt-context.service';
import { normalizeDestination, classifyDestinationMatch } from './receipt-verdict';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';
import type { ConceptoEsperado } from './wa-concepto-esperado.service';
import type { OpcionGuiada } from './whatsapp-comprobante-guiado.service';
import { esAfiliado } from './wa-afiliado.service';

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** De dónde sale el precio (= CHECK `wa_cobros_desde_comprobante.fuente`). */
export type FuenteDePrecio = 'trial_price' | 'registration_fee' | 'merchandise_item' | 'tournament_item';

export interface PrecioDeMotivo {
    motivo: Motivo;
    monto: number;
    fuente: FuenteDePrecio;
    /** offering_plans.id / school_merchandise_items.id / school_tournament_items.id; null para trial_price. */
    fuenteId: string | null;
    /** Cómo se nombra para la familia y en el concepto: «Inscripción», «Uniforme completo», «Clínica de armadores». */
    etiqueta: string;
    /** Clave de la opción del servicio (p. ej. las semanas del vacacional). */
    opcion?: string | null;
    /** El monto es el abono mínimo para separar el cupo, no el precio completo. */
    esAbono?: boolean;
}

/** Exactamente uno: el cobro va a un deportista con ficha o a un prospecto. */
export interface DuenoDelCobro {
    childId?: string | null;
    unregisteredId?: string | null;
    leadId?: string | null;
}

/** Valor de la opción guardada en la pregunta de concepto cuando el interruptor está prendido. */
export interface ValorMotivoElegido {
    motivo: Motivo;
    fuente: FuenteDePrecio;
    fuenteId: string | null;
    monto: number;
    etiqueta: string;
    opcion?: string | null;
    esAbono?: boolean;
}

/** Tolerancia de monto en todo el módulo: ±$1 (igual que la RPC). */
const TOLERANCIA = 1;
const igual = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA;

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const clave = (p: PrecioDeMotivo) =>
    `${p.motivo}|${p.fuente}|${p.fuenteId ?? ''}|${p.opcion ?? ''}|${p.esAbono ? 'a' : ''}|${p.monto}`;
const sinRepetir = (ps: PrecioDeMotivo[]) => {
    const vistos = new Set<string>();
    return ps.filter((p) => (vistos.has(clave(p)) ? false : (vistos.add(clave(p)), true)));
};

// ─── Interruptor ─────────────────────────────────────────────────────────────

/**
 * ¿La escuela crea cobros desde el comprobante? Lee SOLO
 * `school_settings.wa_cobro_desde_comprobante` (no toca
 * whatsapp-ajustes-escuela, que editan B2/B3/B6). Sin columna → false.
 */
export async function cobroDesdeComprobanteActivo(schoolId: string): Promise<boolean> {
    try {
        if (!schoolId) return false;
        const { data, error } = await supabase.from('school_settings')
            .select('wa_cobro_desde_comprobante').eq('school_id', schoolId).maybeSingle();
        if (error) return false;
        return (data as any)?.wa_cobro_desde_comprobante === true;
    } catch {
        return false;
    }
}

// ─── Decisiones puras ────────────────────────────────────────────────────────

export type MotivoPorMonto =
    /** Un solo precio de la escuela es ese monto. */
    | { tipo: 'uno'; precio: PrecioDeMotivo }
    /** El monto es la suma de 2–3 precios, de UNA sola forma (matrícula + uniformes). */
    | { tipo: 'varios'; precios: PrecioDeMotivo[] }
    /** Varios precios (o varias sumas) dan ese monto: se pregunta. */
    | { tipo: 'ambiguo'; precios: PrecioDeMotivo[] }
    /** El monto es una cuota de la familia: sigue el camino de hoy (la mensualidad). */
    | { tipo: 'es_cuota' }
    | { tipo: 'ninguno' };

/** Tope de precios para buscar sumas (con más, casi cualquier monto suma de varias formas). */
const MAX_PRECIOS_SUMA = 12;

/**
 * ¿Qué motivo dice el monto? Pura. Nunca propone si el monto es una cuota de la
 * familia (eso sigue por el camino de la mensualidad) y nunca suma abonos.
 */
export function motivoPorMonto(
    monto: number | null,
    precios: PrecioDeMotivo[],
    o: { cuotas?: (number | null | undefined)[] } = {},
): MotivoPorMonto {
    if (monto === null || !(monto > 0)) return { tipo: 'ninguno' };
    if ((o.cuotas ?? []).some((c) => typeof c === 'number' && c > 0 && igual(c, monto))) return { tipo: 'es_cuota' };
    const lista = sinRepetir(precios.filter((p) => p.monto > 0));
    const iguales = lista.filter((p) => igual(p.monto, monto));
    if (iguales.length === 1) return { tipo: 'uno', precio: iguales[0] };
    if (iguales.length > 1) return { tipo: 'ambiguo', precios: iguales };

    const completos = lista.filter((p) => !p.esAbono).slice(0, MAX_PRECIOS_SUMA);
    const sumas: PrecioDeMotivo[][] = [];
    const n = completos.length;
    for (let i = 0; i < n && sumas.length < 2; i++) {
        for (let j = i + 1; j < n && sumas.length < 2; j++) {
            const ij = completos[i].monto + completos[j].monto;
            if (igual(ij, monto)) sumas.push([completos[i], completos[j]]);
            for (let k = j + 1; k < n && sumas.length < 2; k++) {
                if (igual(ij + completos[k].monto, monto)) sumas.push([completos[i], completos[j], completos[k]]);
            }
        }
    }
    if (sumas.length === 1) return { tipo: 'varios', precios: sumas[0] };
    if (sumas.length > 1) return { tipo: 'ambiguo', precios: sinRepetir(sumas.flat()) };
    return { tipo: 'ninguno' };
}

/** Dónde cayó la plata, con la precisión que pide «agendar al recibir». */
export type DestinoExacto = 'exacta' | 'enmascarada' | 'restringida' | 'fuera' | 'ajena' | null;

export type DecisionEsperado =
    /** Ya hay un cobro pendiente de ese motivo por ese monto: se le aplica. */
    | { tipo: 'aplicar_existente'; pago: PagoPendiente }
    /** No hay cobro y todo coincide: se crea (RPC) y se le aplica. */
    | { tipo: 'crear' }
    /** No coincide (monto o destino): no se crea nada; a una persona con la propuesta. */
    | { tipo: 'a_la_escuela'; razon: 'monto' | 'destino' | 'cobro_distinto' }
    /** Familia: el esperado no calza, puede ser la mensualidad. Camino de hoy. */
    | { tipo: 'seguir' };

/**
 * Qué hacer con un comprobante cuando hay un motivo esperado. Pura.
 *  · Prospecto (lead): el monto tiene que ser el esperado (±$1) y el destino una
 *    cuenta general de la escuela con coincidencia EXACTA (nunca sin destino,
 *    sin cuentas ni enmascarado); si no, a la escuela. Con un cobro pendiente
 *    del motivo por ese monto, a ese; si no, se crea.
 *  · Familia (deportista): si calza, aplicar o crear; si no, seguir (puede ser
 *    la mensualidad).
 */
export function decidirConEsperado(
    esperado: Pick<ConceptoEsperado, 'motivo' | 'monto' | 'leadId' | 'childId'>,
    monto: number | null,
    destino: DestinoExacto,
    pendientes: PagoPendiente[],
): DecisionEsperado {
    const delMotivo = pendientes.filter((p) =>
        categoriaDelCobro({ payment_category: p.categoria ?? null, concept: p.concept }) === esperado.motivo);
    const existente = monto === null ? undefined : delMotivo.find((p) => igual(Number(p.amount), monto));
    const montoOk = monto !== null && esperado.monto !== null && igual(esperado.monto, monto);

    if (esperado.leadId) {
        if (monto === null) return { tipo: 'a_la_escuela', razon: 'monto' };
        if (destino !== 'exacta') return { tipo: 'a_la_escuela', razon: 'destino' };
        if (existente) return { tipo: 'aplicar_existente', pago: existente };
        if (delMotivo.length) return { tipo: 'a_la_escuela', razon: 'cobro_distinto' };
        return montoOk ? { tipo: 'crear' } : { tipo: 'a_la_escuela', razon: 'monto' };
    }
    if (existente) return { tipo: 'aplicar_existente', pago: existente };
    if (montoOk && delMotivo.length === 0) return { tipo: 'crear' };
    return { tipo: 'seguir' };
}

/**
 * Botones de la pregunta «¿de qué es?» con el interruptor prendido: los 2
 * motivos con precio más cercanos al monto + «Otro». Pura. [] si no hay precios
 * (quien llama usa [Mensualidad][Inscripción][Otro] de siempre).
 */
export function opcionesDeMotivo(precios: PrecioDeMotivo[], monto: number | null = null): OpcionGuiada[] {
    const porMotivo = new Map<Motivo, PrecioDeMotivo>();
    const ordenados = sinRepetir(precios.filter((p) => p.monto > 0 && !p.esAbono))
        .sort((a, b) => (monto === null ? 0 : Math.abs(a.monto - monto) - Math.abs(b.monto - monto)));
    for (const p of ordenados) if (!porMotivo.has(p.motivo)) porMotivo.set(p.motivo, p);
    const elegidos = [...porMotivo.values()].slice(0, 2);
    if (!elegidos.length) return [];
    return [
        ...elegidos.map((p, i): OpcionGuiada => ({ n: i + 1, etiqueta: p.etiqueta, valor: valorDePrecio(p) })),
        { n: elegidos.length + 1, etiqueta: 'Otro', valor: 'otro' },
    ];
}

export function valorDePrecio(p: PrecioDeMotivo): ValorMotivoElegido {
    return {
        motivo: p.motivo, fuente: p.fuente, fuenteId: p.fuenteId, monto: p.monto, etiqueta: p.etiqueta,
        ...(p.opcion ? { opcion: p.opcion } : {}), ...(p.esAbono ? { esAbono: true } : {}),
    };
}

/** ¿El valor guardado en una opción es un motivo con precio? Pura. */
export function esValorMotivoElegido(v: unknown): v is ValorMotivoElegido {
    const o = v as ValorMotivoElegido | null;
    return !!o && typeof o === 'object' && typeof o.motivo === 'string' && typeof o.fuente === 'string'
        && typeof o.monto === 'number' && o.monto > 0;
}

/** El concepto del cobro creado: «Clase de prueba — Mariana Ruiz». Pura. */
export function conceptoDelCobroCreado(p: Pick<PrecioDeMotivo, 'etiqueta' | 'motivo'>, nombre: string | null | undefined): string {
    const que = (p.etiqueta || MOTIVO[p.motivo].etiqueta).trim();
    const quien = String(nombre ?? '').trim();
    return (quien ? `${que} — ${quien}` : que).slice(0, 200);
}

// ─── Destino ─────────────────────────────────────────────────────────────────

/** Pura: el destino ya normalizado contra las cuentas de la escuela. */
export function clasificarDestino(
    destinoNorm: string | null,
    c: { generales: string[]; restringidas: string[]; fuera: string[] },
): DestinoExacto {
    if (!destinoNorm) return null;
    if (!c.generales.length && !c.restringidas.length && !c.fuera.length) return null;
    const g = classifyDestinationMatch(destinoNorm, c.generales);
    if (g === 'exact') return 'exacta';
    if (g === 'masked') return 'enmascarada';
    if (classifyDestinationMatch(destinoNorm, c.restringidas) !== 'none') return 'restringida';
    if (classifyDestinationMatch(destinoNorm, c.fuera) !== 'none') return 'fuera';
    return 'ajena';
}

/** ¿A qué cuenta fue el dinero, con coincidencia exacta o no? Nunca lanza (ante el error, null). */
export async function destinoExactoDelComprobante(
    schoolId: string, ocr: { destination?: string | null } | null | undefined,
): Promise<DestinoExacto> {
    try {
        const destino = normalizeDestination(ocr?.destination ?? null);
        if (!destino) return null;
        const ctx = await buildVerdictContext(schoolId, { referenceNorm: null, imageSha256: null });
        return clasificarDestino(destino, {
            generales: ctx.registeredAccounts ?? [],
            restringidas: (ctx.restrictedAccounts ?? []).map((r) => r.value),
            fuera: ctx.cuentasFueraDeSportmaps ?? [],
        });
    } catch {
        return null;
    }
}

// ─── Precios de la escuela ───────────────────────────────────────────────────

/** Hoy en Bogotá, 'YYYY-MM-DD'. */
export const hoyBogota = (ahora = Date.now()) => new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10);

/**
 * Inscripción: con deportista, la de su plan; si no (o el plan no la cobra), el
 * ÚNICO valor distinto entre los planes activos de la escuela. Nunca lanza.
 */
async function preciosDeInscripcion(schoolId: string, dueno: DuenoDelCobro): Promise<PrecioDeMotivo[]> {
    try {
        const { data: planes } = await supabase.from('offering_plans')
            .select('id, registration_fee').eq('school_id', schoolId).eq('is_active', true).limit(100);
        const conValor = ((planes ?? []) as any[]).filter((p) => (num(p.registration_fee) ?? 0) > 0);
        if (!conValor.length) return [];
        const etiqueta = MOTIVO.inscripcion.etiqueta;
        const deportista = dueno.childId ?? dueno.unregisteredId ?? null;
        if (deportista) {
            const { data: insc } = await supabase.from('enrollments')
                .select('offering_plan_id')
                .eq('school_id', schoolId).eq('status', 'active')
                .eq(dueno.childId ? 'child_id' : 'unregistered_athlete_id', deportista)
                .limit(5);
            const planesDelDeportista = new Set(((insc ?? []) as any[]).map((e) => e.offering_plan_id).filter(Boolean));
            const suyos = conValor.filter((p) => planesDelDeportista.has(p.id));
            if (suyos.length) {
                return sinRepetir(suyos.map((p) => ({
                    motivo: 'inscripcion' as const, monto: Number(p.registration_fee), fuente: 'registration_fee' as const,
                    fuenteId: p.id as string, etiqueta,
                })));
            }
        }
        const valores = [...new Set(conValor.map((p) => Number(p.registration_fee)))];
        if (valores.length !== 1) return [];
        const plan = conValor.find((p) => Number(p.registration_fee) === valores[0]);
        return [{ motivo: 'inscripcion', monto: valores[0], fuente: 'registration_fee', fuenteId: plan.id, etiqueta }];
    } catch {
        return [];
    }
}

/** Artículos activos (uniformes, kits): su precio y cada precio por talla. Nunca lanza. */
async function preciosDeArticulos(schoolId: string): Promise<PrecioDeMotivo[]> {
    try {
        const { data } = await supabase.from('school_merchandise_items')
            .select('id, name, price, price_by_size').eq('school_id', schoolId).eq('active', true).limit(50);
        const out: PrecioDeMotivo[] = [];
        for (const a of (data ?? []) as any[]) {
            const base = { motivo: 'articulos' as const, fuente: 'merchandise_item' as const, fuenteId: a.id as string, etiqueta: String(a.name ?? MOTIVO.articulos.etiqueta) };
            const precio = num(a.price);
            if (precio && precio > 0) out.push({ ...base, monto: precio });
            if (a.price_by_size && typeof a.price_by_size === 'object') {
                for (const v of Object.values(a.price_by_size as Record<string, unknown>)) {
                    const n = num(v);
                    if (n && n > 0) out.push({ ...base, monto: n });
                }
            }
        }
        return sinRepetir(out);
    } catch {
        return [];
    }
}

/** Valor de la clase de prueba de la escuela (`school_trial_class_settings.trial_price`). Nunca lanza. */
async function precioDeClasePrueba(schoolId: string): Promise<PrecioDeMotivo[]> {
    try {
        const { data } = await supabase.from('school_trial_class_settings')
            .select('trial_price').eq('school_id', schoolId).maybeSingle();
        const precio = num((data as any)?.trial_price);
        return precio && precio > 0
            ? [{ motivo: 'clase_prueba', monto: precio, fuente: 'trial_price', fuenteId: null, etiqueta: MOTIVO.clase_prueba.etiqueta }]
            : [];
    } catch {
        return [];
    }
}

/** Una opción de un servicio (p. ej. 1, 2, 3 o 4 semanas del vacacional), con su precio de afiliado. */
export interface OpcionDeServicio {
    clave: string;
    etiqueta: string;
    precio: number | null;
    precio_afiliado?: number | null;
}

/** Una fila de `school_tournament_items` (servicio: torneo, viaje, clínica, vacacional…). */
export interface ItemDeServicio {
    id: string;
    name: string;
    kind: string;
    price: number | null;
    active?: boolean | null;
    event_id?: string | null;
    starts_at?: string | null;
    ends_at?: string | null;
    /** Migración M2 (plan maestro §2): pueden no existir todavía. */
    precio_afiliado?: number | null;
    /** `[{desde: 'YYYY-MM-DD', precio}]`: desde esa fecha (Bogotá) el precio de lista es otro. */
    precios_por_fecha?: unknown;
    /** 1–100: con este % del precio se separa el cupo (abono; el resto queda pendiente). Exige `allow_installments`. */
    abono_minimo_pct?: number | null;
    allow_installments?: boolean | null;
    /** `[{clave, etiqueta, precio, precio_afiliado}]`. */
    opciones?: unknown;
}

/** Las opciones válidas del ítem (jsonb sin esquema garantizado). Pura. */
export function opcionesDelItem(item: Pick<ItemDeServicio, 'opciones'>): OpcionDeServicio[] {
    if (!Array.isArray(item.opciones)) return [];
    const out: OpcionDeServicio[] = [];
    for (const o of item.opciones as any[]) {
        if (!o || typeof o !== 'object' || typeof o.clave !== 'string' || !o.clave.trim()) continue;
        out.push({
            clave: o.clave,
            etiqueta: typeof o.etiqueta === 'string' && o.etiqueta.trim() ? o.etiqueta.trim() : o.clave,
            precio: num(o.precio),
            precio_afiliado: num(o.precio_afiliado),
        });
    }
    return out;
}

/** Los tramos de precio por fecha, ordenados (jsonb sin esquema garantizado). Pura. */
function tramosPorFecha(raw: unknown): { desde: string; precio: number }[] {
    if (!Array.isArray(raw)) return [];
    return (raw as any[])
        .filter((t) => t && typeof t.desde === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.desde) && (num(t.precio) ?? 0) > 0)
        .map((t) => ({ desde: String(t.desde).slice(0, 10), precio: Number(t.precio) }))
        .sort((a, b) => a.desde.localeCompare(b.desde));
}

/**
 * El precio que hoy le corresponde a esta persona. Pura.
 *  · Con opción: el de la opción (el de afiliado si es afiliado y lo tiene).
 *  · Afiliado con `precio_afiliado`: ese, sin importar la fecha (Monster: la
 *    clínica es $250.000 para afiliados antes y después de la preventa).
 *  · Si no: el último tramo de `precios_por_fecha` cuya fecha ya llegó (Bogotá);
 *    sin tramos vigentes, `price` (la preventa: $300.000; desde el 10-nov $350.000).
 */
export function precioVigente(
    item: Pick<ItemDeServicio, 'price' | 'precio_afiliado' | 'precios_por_fecha'>,
    o: { afiliado: boolean; hoy: string; opcion?: OpcionDeServicio | null },
): number | null {
    const positivo = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
    if (o.opcion) return (o.afiliado ? positivo(o.opcion.precio_afiliado) : null) ?? positivo(o.opcion.precio);
    if (o.afiliado) {
        const pa = positivo(item.precio_afiliado);
        if (pa !== null) return pa;
    }
    let precio = positivo(item.price);
    for (const t of tramosPorFecha(item.precios_por_fecha)) if (t.desde <= o.hoy) precio = t.precio;
    return precio;
}

/** El abono mínimo para separar el cupo, si el ítem lo admite (redondeo hacia arriba, igual que la RPC). Pura. */
export function abonoMinimo(precio: number | null, pct: unknown): number | null {
    const p = num(pct);
    if (precio === null || p === null || !(p >= 1 && p < 100)) return null;
    return Math.ceil((precio * p) / 100);
}

/** ¿Algún servicio tiene precio de afiliado? (Solo entonces se pregunta a la base.) Pura. */
export function hayPrecioDeAfiliado(items: ItemDeServicio[]): boolean {
    return items.some((it) => (num(it.precio_afiliado) ?? 0) > 0
        || opcionesDelItem(it).some((o) => (num(o.precio_afiliado) ?? 0) > 0));
}

/**
 * Los precios de los servicios vigentes para esta persona: uno por opción (o el
 * del ítem), con el de afiliado y el de la fecha, más el abono mínimo si el ítem
 * lo admite. Pura.
 */
export function preciosDeServicios(
    items: ItemDeServicio[],
    o: { ahora?: number; afiliado?: boolean } = {},
): PrecioDeMotivo[] {
    const ahora = o.ahora ?? Date.now();
    const hoy = hoyBogota(ahora);
    const afiliado = o.afiliado === true;
    const out: PrecioDeMotivo[] = [];
    for (const it of items) {
        if (it.active === false || it.event_id) continue;
        const fin = it.ends_at ?? it.starts_at;
        if (fin && new Date(fin).getTime() <= ahora) continue;
        const motivo = (['torneo', 'viaje', 'clase_extra', 'vacacional', 'otro'] as const).find((k) => k === it.kind) ?? 'otro';
        const nombre = String(it.name ?? MOTIVO[motivo].etiqueta);
        const base = { motivo, fuente: 'tournament_item' as const, fuenteId: it.id };
        const opciones = opcionesDelItem(it);
        if (opciones.length) {
            for (const op of opciones) {
                const precio = precioVigente(it, { afiliado, hoy, opcion: op });
                if (precio !== null) out.push({ ...base, monto: precio, etiqueta: `${nombre} — ${op.etiqueta}`, opcion: op.clave });
            }
            continue;
        }
        const precio = precioVigente(it, { afiliado, hoy });
        if (precio === null) continue;
        out.push({ ...base, monto: precio, etiqueta: nombre });
        // La base solo acepta el abono si el ítem admite cuotas (`allow_installments`).
        const abono = it.allow_installments === true ? abonoMinimo(precio, it.abono_minimo_pct) : null;
        if (abono !== null && abono < precio) out.push({ ...base, monto: abono, etiqueta: nombre, esAbono: true });
    }
    return out;
}

const COLUMNAS_SERVICIO = 'id, name, kind, price, active, event_id, starts_at, ends_at';
const COLUMNAS_SERVICIO_M2 = `${COLUMNAS_SERVICIO}, allow_installments, precio_afiliado, precios_por_fecha, abono_minimo_pct, opciones`;

/**
 * Servicios activos de la escuela. Con las columnas de precio de la migración
 * M2; si todavía no existen, las de siempre (precio de lista). Nunca lanza.
 */
export async function itemsDeServicio(schoolId: string): Promise<ItemDeServicio[]> {
    const leer = (cols: string) => supabase.from('school_tournament_items')
        .select(cols).eq('school_id', schoolId).eq('active', true).is('event_id', null).limit(50);
    try {
        let { data, error } = await leer(COLUMNAS_SERVICIO_M2);
        if (error && esMigracionPendiente(error)) ({ data, error } = await leer(COLUMNAS_SERVICIO));
        if (error || !Array.isArray(data)) return [];
        return data as unknown as ItemDeServicio[];
    } catch {
        return [];
    }
}

/**
 * Los precios con los que se puede reconocer un comprobante: clase de prueba
 * (solo para un prospecto), inscripción, artículos y servicios. Una lectura por
 * fuente y solo de los `motivos` pedidos. Nunca lanza.
 */
export async function preciosDeMotivos(
    schoolId: string,
    dueno: DuenoDelCobro,
    o: { motivos?: Motivo[]; telefono?: string | null; ahora?: number } = {},
): Promise<PrecioDeMotivo[]> {
    const quiere = (m: Motivo) => !o.motivos || o.motivos.includes(m);
    const serviciosPedidos = (['torneo', 'viaje', 'clase_extra', 'vacacional', 'otro'] as const).some(quiere);
    /** El precio de afiliado solo si algún servicio lo tiene (una lectura más, la RPC wa_es_afiliado). */
    const servicios = async () => {
        const items = await itemsDeServicio(schoolId);
        const afiliado = hayPrecioDeAfiliado(items) && o.telefono
            ? (await esAfiliado(schoolId, o.telefono)).afiliado
            : false;
        return preciosDeServicios(items, { ahora: o.ahora, afiliado });
    };
    const [prueba, inscripcion, articulos, deServicio] = await Promise.all([
        dueno.leadId && quiere('clase_prueba') ? precioDeClasePrueba(schoolId) : Promise.resolve([]),
        quiere('inscripcion') ? preciosDeInscripcion(schoolId, dueno) : Promise.resolve([]),
        quiere('articulos') ? preciosDeArticulos(schoolId) : Promise.resolve([]),
        serviciosPedidos ? servicios() : Promise.resolve([]),
    ]);
    return sinRepetir([...prueba, ...inscripcion, ...articulos, ...deServicio].filter((p) => quiere(p.motivo)));
}

// ─── Crear y anular ──────────────────────────────────────────────────────────

export interface CrearCobroDesdeComprobanteInput extends DuenoDelCobro {
    schoolId: string;
    queueId: string;
    categoria: Motivo;
    monto: number;
    fuente: FuenteDePrecio;
    fuenteId: string | null;
    /** null = lo arma la base con el nombre del deportista o del prospecto («Inscripción — Mariana Ruiz»). */
    concepto: string | null;
    conceptoEsperadoId?: string | null;
    opcion?: string | null;
    /** Para el precio de afiliado (la base lo reconoce por el celular). */
    telefono?: string | null;
}

export type CobroDesdeComprobante =
    /** `concepto`: el que quedó en el cobro (null si la base no lo devolvió, p. ej. `ya_existia`). */
    | { ok: true; paymentId: string; precio: number; esAbono: boolean; yaExistia: boolean; concepto: string | null }
    | { ok: false; codigo: string; paymentId?: string };

/**
 * Crea el cobro con la RPC (idempotente por fila de la cola + fuente). El
 * precio del cobro es el de la base: si no coincide con el comprobante (±$1),
 * la RPC no crea nada (`monto_no_coincide`). Nunca lanza.
 */
export async function crearCobroDesdeComprobante(i: CrearCobroDesdeComprobanteInput): Promise<CobroDesdeComprobante> {
    const duenos = [i.childId, i.unregisteredId, i.leadId].filter(Boolean).length;
    if (!i.schoolId || !i.queueId || duenos !== 1 || !(i.monto > 0)) return { ok: false, codigo: 'datos_invalidos' };
    try {
        const { data, error } = await supabase.rpc('wa_crear_cobro_desde_comprobante', {
            p_school_id: i.schoolId,
            p_queue_id: i.queueId,
            p_categoria: i.categoria,
            p_monto: i.monto,
            p_fuente: i.fuente,
            p_fuente_id: i.fuenteId,
            p_child_id: i.childId ?? null,
            p_unregistered_id: i.unregisteredId ?? null,
            p_signup_lead_id: i.leadId ?? null,
            p_concepto: i.concepto && i.concepto.trim() ? i.concepto : null,
            p_concepto_esperado_id: i.conceptoEsperadoId ?? null,
            p_opcion: i.opcion ?? null,
            p_telefono: i.telefono ?? null,
        });
        if (error) {
            if (esMigracionPendiente(error)) return { ok: false, codigo: 'migracion_pendiente' };
            console.warn('[wa-cobro-comprobante] la RPC falló', { schoolId: i.schoolId, code: error.code, msg: error.message });
            return { ok: false, codigo: 'error' };
        }
        const r = (data ?? {}) as Record<string, unknown>;
        if (r.ok !== true || typeof r.payment_id !== 'string') {
            return {
                ok: false, codigo: String(r.codigo ?? 'error'),
                ...(typeof r.payment_id === 'string' ? { paymentId: r.payment_id } : {}),
            };
        }
        return {
            ok: true, paymentId: r.payment_id, precio: num(r.precio) ?? i.monto,
            esAbono: r.es_abono === true, yaExistia: r.ya_existia === true,
            concepto: typeof r.concepto === 'string' && r.concepto.trim() ? r.concepto : null,
        };
    } catch (e: any) {
        console.warn('[wa-cobro-comprobante] la RPC lanzó', { schoolId: i.schoolId, error: e?.message });
        return { ok: false, codigo: 'error' };
    }
}

/**
 * El estampado del comprobante falló después de crear el cobro: el cobro se
 * anula (pending → cancelled), SOLO si lo creó el asistente (está en
 * `wa_cobros_desde_comprobante`) y nadie lo tocó. Nunca lanza.
 */
export async function anularCobroCreado(paymentId: string): Promise<boolean> {
    try {
        const { data: marca } = await supabase.from('wa_cobros_desde_comprobante')
            .select('payment_id').eq('payment_id', paymentId).maybeSingle();
        if (!(marca as any)?.payment_id) return false;
        const { data, error } = await supabase.from('payments')
            .update({ status: 'cancelled', updated_at: new Date().toISOString() })
            .eq('id', paymentId).eq('status', 'pending')
            .select('id');
        return !error && Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}

/** Días hacia atrás en los que una inscripción ya cobrada bloquea crear otra (la renovación anual sí pasa). */
const DIAS_COBRO_PREVIO = 330;

/**
 * ¿El deportista (o el prospecto) ya tiene un cobro vivo o pagado de ese
 * motivo en los últimos 330 días? Antes de crear otra inscripción: la
 * matrícula pagada como prospecto pasa al deportista al inscribirse y no se
 * vuelve a cobrar. Nunca lanza; ante la duda, sí (no se crea).
 */
export async function yaTieneCobroDelMotivo(schoolId: string, dueno: DuenoDelCobro, motivo: Motivo): Promise<boolean> {
    try {
        let q = supabase.from('payments').select('id')
            .eq('school_id', schoolId).eq('payment_category', motivo)
            .in('status', ['pending', 'overdue', 'awaiting_approval', 'partial', 'paid'])
            .gte('created_at', new Date(Date.now() - DIAS_COBRO_PREVIO * 86_400_000).toISOString());
        if (dueno.childId) q = q.eq('child_id', dueno.childId);
        else if (dueno.unregisteredId) q = q.eq('unregistered_athlete_id', dueno.unregisteredId);
        else if (dueno.leadId) q = q.eq('signup_lead_id', dueno.leadId);
        else return true;
        const { data, error } = await q.limit(1);
        if (error) return true;
        return Array.isArray(data) && data.length > 0;
    } catch {
        return true;
    }
}

// ─── Prospecto ───────────────────────────────────────────────────────────────

/** Los cobros pendientes de un prospecto (`payments.signup_lead_id`). Nunca lanza. */
export async function pendientesDelLead(schoolId: string, leadId: string): Promise<PagoPendiente[]> {
    try {
        const { data, error } = await supabase.from('payments')
            .select('id, amount, concept, due_date, child_id, payment_category, payment_type')
            .eq('school_id', schoolId).eq('signup_lead_id', leadId)
            .in('status', ['pending', 'overdue'])
            .order('due_date', { ascending: true })
            .limit(20);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map((p) => ({
            id: p.id, amount: Number(p.amount), concept: p.concept ?? null, due_date: p.due_date ?? null,
            child_id: p.child_id ?? null, atleta: null, categoria: categoriaDelCobro(p),
        }));
    } catch {
        return [];
    }
}

export interface LeadDelTelefono { id: string; nombre: string | null; status: string }

/**
 * El prospecto de la escuela con ese celular (el más reciente, no descartado).
 * Mismas variantes de teléfono que el registro del lead. Nunca lanza.
 */
export async function leadPorTelefono(schoolId: string, telefono: string): Promise<LeadDelTelefono | null> {
    try {
        const { variantesTelefonoLead } = await import('./whatsapp-prospecto-lead.service');
        const variantes = variantesTelefonoLead(telefono);
        if (!schoolId || !variantes.length) return null;
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, full_name, status')
            .eq('school_id', schoolId).in('phone', variantes)
            .neq('status', 'discarded')
            .order('created_at', { ascending: false })
            .limit(1);
        const l = Array.isArray(data) ? (data[0] as any) : null;
        if (error || !l?.id) return null;
        return { id: l.id, nombre: l.full_name ?? null, status: String(l.status ?? '') };
    } catch {
        return null;
    }
}
