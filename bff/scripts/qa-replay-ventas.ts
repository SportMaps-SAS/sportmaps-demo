/**
 * Reproducción de conversaciones REALES de venta de un servicio (clínica, torneo,
 * vacacional…) por el bot de HOY, en simulación, con las aserciones del plan
 * docs/specs/whatsapp-ventas-de-servicio-blindaje.md (frente F, §4.F y §5).
 *
 *   npm run qa:replay-ventas -- --escuela monsters-volley-club --desde 2026-11-03
 *   npm run qa:replay-ventas -- --escuela <uuid|slug> --desde 2026-11-03 --hasta 2026-11-08 \
 *       [--max 40] [--conversacion <uuid>] [--palabras torneo,copa] [--paralelo 4] \
 *       [--transcripcion replay.md] [--verbose]
 *
 * QUÉ HACE
 *   1. Lee de la base (SOLO lectura, consultas acotadas por integración + rango de
 *      fechas, columnas mínimas) las conversaciones donde se habló de un servicio:
 *      un texto con la palabra del evento o el nombre del ítem del catálogo
 *      («clínica», «armadores», «vacacional»…; `--palabras` agrega otras) o un
 *      saliente marcado con `servicio_id` / `venta_servicio_id` / destino de
 *      anuncio `servicio`.
 *   2. Re-ejecuta cada conversación con un contacto SINTÉTICO por `turnoSimulado`
 *      (el mismo camino del número de pruebas: el cortafuegos bloquea toda
 *      escritura, `deliver` anota en vez de enviar y nada sale a Meta), en el orden
 *      real y con el RELOJ de cada mensaje (precio del tramo de ese día):
 *        · cada entrante de texto (y cada botón: el «Sí» de la campaña corre por
 *          `atenderRespuestaDeCampana`, como en el webhook);
 *        · lo que escribió la ESCUELA y las plantillas de campaña se siembran en
 *          la memoria tal cual (son contexto; el bot no los genera);
 *        · lo que dijo el BOT entonces no se siembra: lo vuelve a decir el de hoy.
 *      Fotos, audios y formularios no se reproducen (se cuentan).
 *   3. Revisa TODO lo que el bot mandaría con las reglas prohibidas de la venta:
 *      menú de sedes, «clase de prueba» sin que la pidieran, las preguntas del
 *      embudo, otro servicio, pedir el correo, una fecha de tramo equivocada
 *      («9 de noviembre» en Monster) y montos fuera del catálogo/planes.
 *      Las reglas de la venta valen desde que la conversación entra en un
 *      servicio y hasta que la persona pide el club de forma explícita
 *      (`pideElClub`); fechas y montos, siempre. A una familia identificada el bot
 *      le cita sus cobros reales: ahí los montos se revisan solo en salientes
 *      marcados como venta.
 *   Salida: resumen por conversación (teléfono enmascarado a 4 dígitos) y total
 *   de violaciones. Código de salida 1 si hay alguna.
 *
 * SEGURIDAD: antes de leer una sola conversación, `verificarSimulacion` comprueba
 * que `deliver` está envuelto (simularEnvios), que el cortafuegos bloquea las
 * escrituras y los envíos y que la integración simulada no trae token. Si algo
 * falla, NO corre.
 *
 * Este archivo también exporta las utilidades que usa el bloque `ventas` de
 * qa-embudo (reloj fijo, alias de columnas en memoria, turno de campaña y las
 * aserciones): una sola definición de lo que está prohibido.
 *
 * LIMITACIONES
 *   · El seguimiento de 20 h y los recordatorios son jobs: no se reproducen.
 *   · Un número de familia registrada SIN cuenta se reproduce como desconocido.
 *   · El modelo puede contestar distinto en cada corrida (lo determinista no).
 */

import 'dotenv/config';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { supabase } from '../src/config/supabase';
import {
    ConsultaVirtual, conCortafuegos, valorDeColumna, type ContextoCortafuegos, type Fila,
} from '../src/config/cortafuegos-simulacion';
import {
    turnoSimulado, contactoSintetico, conversacionDePrueba, integracionParaSimular,
    type SesionPrueba, type ResultadoTurnoSimulado,
} from '../src/services/plataforma-wa-pruebas.service';
import { simularEnvios, enSimulacion, type SalidaSimulada } from '../src/services/whatsapp-bot.service';
import { sendTextMessage, type ParsedInboundMessage } from '../src/services/whatsapp.service';
import { atenderRespuestaDeCampana } from '../src/services/whatsapp-campana-respuesta.service';
import { serviciosDeAnuncio, eventosNombrados, type ItemConFicha } from '../src/services/whatsapp-anuncio-destino';
import { itemNombradoEn, pideElClub } from '../src/services/whatsapp-venta-contexto';
import { tokensDistintivos } from '../src/services/whatsapp-venta-servicios.service';
import { ajustesWhatsAppDeEscuela, ajustesClasePrueba } from '../src/services/whatsapp-ajustes-escuela.service';
import { normalizar } from '../src/services/whatsapp-clase-cortesia.service';

// ─── Reloj fijo (por conversación) ───────────────────────────────────────────
//
// El bot lee la fecha con `Date.now()` / `new Date()` en decenas de sitios (precio
// del tramo, vigencia del servicio, ventanas de 24 h…). Para fijar el día sin
// tocar el bot, se reemplaza `Date` global por una subclase cuyo «ahora» lleva el
// desfase del contexto asíncrono (AsyncLocalStorage, como el cortafuegos): cada
// conversación corre con su propio reloj, en paralelo con las demás, y el tiempo
// sigue avanzando dentro de ella (los turnos quedan ordenados). Fuera de
// `conReloj` el reloj es el real. Lo usan qa-embudo (bloque ventas) y el replay.

const DateReal = Date;
const relojLocal = new AsyncLocalStorage<{ desfase: number }>();

export function instalarReloj(): void {
    const g = globalThis as any;
    if (g.__relojQaVentas) return;
    class DateConReloj extends DateReal {
        constructor(...args: any[]) {
            if (args.length === 0) super(DateReal.now() + (relojLocal.getStore()?.desfase ?? 0));
            else super(...(args as [number]));
        }
        static now(): number { return DateReal.now() + (relojLocal.getStore()?.desfase ?? 0); }
        // Un Date creado antes del cambio (o por una librería) sigue siendo «instanceof Date».
        static [Symbol.hasInstance](x: unknown): boolean { return x instanceof DateReal; }
    }
    g.Date = DateConReloj;
    g.__relojQaVentas = true;
}

/** Corre `fn` con el reloj en `instante` (ms); dentro, el tiempo avanza normal desde ahí. */
export function conReloj<T>(instante: number, fn: () => Promise<T>): Promise<T> {
    instalarReloj();
    return relojLocal.run({ desfase: instante - DateReal.now() }, fn);
}

/** Dentro de `conReloj`: mueve el reloj de ESTA conversación a `instante`. */
export function moverReloj(instante: number): void {
    const s = relojLocal.getStore();
    if (s) s.desfase = instante - DateReal.now();
}

/** 'YYYY-MM-DD' + 'HH:MM' en Bogotá → ms. */
export const instanteBogota = (ymd: string, hhmm = '10:00') => DateReal.parse(`${ymd}T${hhmm}:00-05:00`);

// ─── Alias de columnas en las tablas virtuales ───────────────────────────────
//
// `ConsultaVirtual` (cortafuegos) ignora las columnas del select: con
// `select('step:payload->>step')` devuelve la fila completa SIN la clave `step`.
// La lectura de la venta activa (`whatsapp-venta-contexto.db`, `mensajesParaVenta`)
// arma el payload con esos alias: en simulación quedaba vacío y la venta por marca
// (`venta_servicio_id`, `servicio_id`, `campana_id`) no se veía. Este parche agrega
// a cada fila devuelta las claves con alias (sin quitar nada). Su lugar natural es
// `cortafuegos-simulacion.ts` (fuera del alcance del frente F): pendiente moverlo.

export function instalarAliasesVirtuales(): void {
    const proto = ConsultaVirtual.prototype as any;
    if (proto.__aliasesQa) return;
    const selectOriginal = proto.select;
    proto.select = function (this: any, cols?: string, opts?: any) {
        if (typeof cols === 'string') {
            this.__aliases = cols.split(',').map((s) => s.trim())
                .map((s) => /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(s))
                .filter((m): m is RegExpExecArray => !!m)
                .map((m) => ({ alias: m[1], col: m[2].trim() }));
        }
        return selectOriginal.call(this, cols, opts);
    };
    const thenOriginal = proto.then;
    proto.then = function (this: any, ok?: (v: any) => unknown, ko?: (e: any) => unknown) {
        const aliases: { alias: string; col: string }[] | undefined = this.__aliases;
        if (!aliases?.length) return thenOriginal.call(this, ok, ko);
        return thenOriginal.call(this, (r: any) => {
            const filas = Array.isArray(r?.data) ? r.data : r?.data && typeof r.data === 'object' ? [r.data] : [];
            for (const f of filas) for (const a of aliases) if (!(a.alias in f)) f[a.alias] = valorDeColumna(f, a.col) ?? null;
            return ok ? ok(r) : r;
        }, ko);
    };
    proto.__aliasesQa = true;
}

// ─── Fechas y montos (calculados APARTE, no con las funciones del bot) ───────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM-DD' → «10 de noviembre» (`menos` días antes). */
export function diaLegibleQa(ymd: string, menos = 0): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const f = new DateReal(DateReal.UTC(y, m - 1, d - menos));
    return `${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`;
}

/** El día (Bogotá) de un timestamp ISO → 'YYYY-MM-DD'. */
export const ymdBogota = (iso: string | number) =>
    new DateReal(new DateReal(iso).getTime() - 5 * 3600_000).toISOString().slice(0, 10);

export function tramosQa(it: Pick<ItemConFicha, 'precios_por_fecha'>): { desde: string; precio: number }[] {
    return (Array.isArray(it.precios_por_fecha) ? it.precios_por_fecha as any[] : [])
        .filter((t) => t && /^\d{4}-\d{2}-\d{2}/.test(String(t.desde)) && Number(t.precio) > 0)
        .map((t) => ({ desde: String(t.desde).slice(0, 10), precio: Number(t.precio) }))
        .sort((a, b) => a.desde.localeCompare(b.desde));
}

export function opcionesQa(it: Pick<ItemConFicha, 'opciones'>): { etiqueta: string; precio: number | null; precioAfiliado: number | null }[] {
    if (!Array.isArray(it.opciones)) return [];
    return (it.opciones as any[]).filter((o) => o && typeof o.clave === 'string')
        .map((o) => ({
            etiqueta: String(o.etiqueta ?? o.clave),
            precio: Number(o.precio) > 0 ? Number(o.precio) : null,
            precioAfiliado: Number(o.precio_afiliado) > 0 ? Number(o.precio_afiliado) : null,
        }));
}

/** El precio que le toca a esa persona ese día: afiliado si lo es y hay; si no, el último tramo ya llegado o el de lista. */
export function precioEsperadoQa(it: ItemConFicha, hoy: string, afiliado: boolean): number | null {
    if (afiliado && Number(it.precio_afiliado) > 0) return Number(it.precio_afiliado);
    let precio = Number(it.price) > 0 ? Number(it.price) : null;
    for (const t of tramosQa(it)) if (t.desde <= hoy) precio = t.precio;
    return precio;
}

/** Abono mínimo (redondeo hacia arriba) si el ítem lo admite y no tiene opciones. */
export function abonoEsperadoQa(it: ItemConFicha, precio: number | null): number | null {
    const pct = Number(it.abono_minimo_pct);
    if (precio === null || opcionesQa(it).length || it.allow_installments !== true || !(pct >= 1 && pct < 100)) return null;
    return Math.ceil((precio * pct) / 100);
}

/** El próximo tramo (solo sin precio de afiliado). */
export function siguienteTramoQa(it: ItemConFicha, hoy: string, afiliado: boolean): { desde: string; precio: number } | null {
    if (afiliado && Number(it.precio_afiliado) > 0) return null;
    return tramosQa(it).find((t) => t.desde > hoy) ?? null;
}

/**
 * Los montos que puede decir el bot: precios del catálogo (lista, tramos, afiliado,
 * opciones), abono y saldo de cada uno, y los extras (clase de prueba, planes).
 */
export function montosPermitidos(items: ItemConFicha[], extras: (number | string | null | undefined)[] = []): Set<number> {
    const s = new Set<number>();
    const agregar = (v: unknown) => { const n = Math.round(Number(v)); if (Number.isFinite(n) && n > 0) s.add(n); };
    for (const it of items) {
        const precios = [it.price, it.precio_afiliado, ...tramosQa(it).map((t) => t.precio),
            ...opcionesQa(it).flatMap((o) => [o.precio, o.precioAfiliado])]
            .map(Number).filter((n) => Number.isFinite(n) && n > 0);
        precios.forEach(agregar);
        const pct = Number(it.abono_minimo_pct);
        if (it.allow_installments === true && pct >= 1 && pct < 100) {
            for (const p of precios) { const a = Math.ceil((p * pct) / 100); agregar(a); agregar(p - a); }
        }
    }
    extras.forEach(agregar);
    return s;
}

/**
 * Los montos CONFIGURADOS de la escuela fuera del catálogo: planes (mensualidad e
 * inscripción) y artículos (precio y por talla). Dos lecturas acotadas. Lo que solo
 * está en un texto libre (la ficha de prospectos) NO cuenta: regla 4 del plan.
 */
export async function montosDeEscuela(schoolId: string): Promise<number[]> {
    const [planes, articulos] = await Promise.all([
        supabase.from('offering_plans').select('price, registration_fee').eq('school_id', schoolId).eq('is_active', true).limit(50),
        supabase.from('school_merchandise_items').select('price, price_by_size').eq('school_id', schoolId).eq('active', true).limit(50),
    ]);
    return [
        ...((planes.data ?? []) as any[]).flatMap((p) => [p.price, p.registration_fee]),
        ...((articulos.data ?? []) as any[]).flatMap((a) => [a.price, ...Object.values(a.price_by_size && typeof a.price_by_size === 'object' ? a.price_by_size : {})]),
    ].map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** Los montos en pesos de un texto: «$300.000», «300.000», «$ 57000», «300 mil». Solo ≥ $1.000. */
export function montosEn(texto: string | null | undefined): number[] {
    const t = String(texto ?? '');
    const salida: number[] = [];
    const tomados: [number, number][] = [];
    const libre = (i: number, j: number) => !tomados.some(([a, b]) => i < b && j > a);
    for (const m of t.matchAll(/\$\s?(\d{1,3}(?:[.,]\d{3})+|\d{4,})/g)) {
        salida.push(Number(m[1].replace(/\D/g, '')));
        tomados.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
    for (const m of t.matchAll(/(\d{1,3}(?:\.\d{3})+)(?![\d.,]*\d)/g)) {
        const i = m.index ?? 0;
        if (i > 0 && /[\d.,]/.test(t[i - 1])) continue;
        if (libre(i, i + m[0].length)) { salida.push(Number(m[1].replace(/\D/g, ''))); tomados.push([i, i + m[0].length]); }
    }
    for (const m of t.matchAll(/(?<![\d.,])(\d{1,3})\s?mil\b/gi)) {
        const i = m.index ?? 0;
        if (libre(i, i + m[0].length)) salida.push(Number(m[1]) * 1000);
    }
    return salida.filter((n) => n >= 1000);
}

/** ¿El texto menciona ese monto (en cualquier formato)? */
export const mencionaMonto = (texto: string | null | undefined, n: number | null | undefined) =>
    n != null && montosEn(texto).includes(Math.round(n));

// ─── Lo que NUNCA puede salir en una venta ───────────────────────────────────

/** «te lo confirma la escuela», «la escuela te confirma», «le pasé tu pregunta a la escuela»… */
export const CONFIRMA_ESCUELA = /escuela[^.\n]{0,40}\b(confirm|respond|valid|escrib|cuent|averig)\w*|\b(confirm|respond|valid)\w*[^.\n]{0,25}\bla escuela|pas[eé] tu (pregunta|mensaje|consulta) a la escuela|(pregunto|consulto) (a|con) la escuela|te confirmamos/i;

const RE_SEDES = /elige (la|una|tu) sede|escoge (la|una|tu) sede|qu[eé] sede te queda|en cu[aá]l (de nuestras )?sedes?\b/i;
const RE_CLASE_PRUEBA = /clases? de (prueba|cortes[ií]a)|clase gratis|primera clase (es|de)\b/i;
const RE_CORREO = /(escr[ií]be(me|nos)?|env[ií]a(me|nos)?|comp[aá]rte(me|nos)?|reg[aá]la(me|nos)?|d[eé]ja(me|nos)?|p[aá]sa(me|nos)?|ind[ií]ca(me|nos)?|confirma(me|nos)?|dime|cu[aá]l es|necesito) (tu|el|un|su) (correo|e-?mail|email)|tu correo electr[oó]nico/i;
const PREFIJO_BOTON_SEDE = 'sm_em_sede:';
/** Los pasos del embudo de la CLASE DE PRUEBA (preguntas, horarios, pago). No `embudo_pregunta_a_la_escuela` (buzón) ni `embudo_a_persona`. */
const PASOS_EMBUDO_CLASE = new Set(['embudo_pregunta', 'embudo_horarios', 'embudo_otra_sede', 'embudo_consentimiento', 'embudo_esperando_pago', 'embudo_agendada']);

export type CodigoViolacion = 'menu_sedes' | 'clase_prueba' | 'preguntas_embudo' | 'otro_servicio' | 'pide_correo'
    | 'fecha_tramo' | 'monto_fuera';

export interface Violacion { codigo: CodigoViolacion; detalle: string }

export interface ContextoVenta {
    /** El catálogo (para «otro servicio», fechas y montos). */
    items: ItemConFicha[];
    /** El servicio que se está vendiendo (null = no se sabe: no se revisa «otro servicio»). */
    item: ItemConFicha | null;
    permitidos: Set<number>;
    /** Última línea de cada pregunta del embudo de la escuela («las 5 preguntas»). */
    preguntasEmbudo: string[];
    /** false = solo fechas y montos (fuera de la venta). */
    enVenta: boolean;
    /** La persona pidió el club de forma explícita: la clase de prueba y las sedes son legítimas. */
    pidioClub: boolean;
    /** false = no se revisan montos (familia fuera de la venta: el bot cita sus cobros reales). */
    revisarMontos: boolean;
}

const corto = (t: string, n = 90) => t.replace(/\s+/g, ' ').trim().slice(0, n);

function otroServicioEn(texto: string, c: ContextoVenta): ItemConFicha | null {
    if (!c.item) return null;
    const propios = new Set(eventosNombrados([c.item.name, String(c.item.kind ?? '')]));
    const enTexto = new Set(eventosNombrados([texto]));
    const t = ` ${normalizar(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
    for (const o of c.items) {
        if (o.id === c.item.id) continue;
        if (eventosNombrados([o.name, String(o.kind ?? '')]).some((e) => enTexto.has(e) && !propios.has(e))) return o;
        const tokens = tokensDistintivos(o.name).filter((k) => !tokensDistintivos(c.item!.name).includes(k));
        if (tokens.length >= 2 && tokens.every((k) => t.includes(` ${k} `))) return o;
    }
    return null;
}

/** Fechas de precio: «hasta el D de M» junto a un precio debe ser el día antes de un tramo (o inicio/fin del servicio). */
function fechasDeTramoMal(texto: string, items: ItemConFicha[]): string[] {
    const t = normalizar(texto);
    const fallas: string[] = [];
    const permitidas = new Set<string>();
    const prohibidas = new Set<string>();
    for (const it of items) {
        for (const tr of tramosQa(it)) {
            permitidas.add(diaLegibleQa(tr.desde, 1));
            permitidas.add(diaLegibleQa(tr.desde));
            // El error real de Monster: la ficha libre decía «preventa hasta el 9» y el tramo cambia el 11.
            prohibidas.add(diaLegibleQa(tr.desde, 2));
        }
        for (const iso of [it.starts_at, it.ends_at]) if (iso) permitidas.add(diaLegibleQa(ymdBogota(iso)));
    }
    for (const p of prohibidas) if (!permitidas.has(p) && new RegExp(`\\b${p}\\b`).test(t)) fallas.push(`dice «${p}» (la fecha del tramo está mal)`);
    for (const m of t.matchAll(/hasta (?:el )?(\d{1,2}) de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/g)) {
        const cerca = t.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + 90);
        if (!/valor|precio|preventa|\$|pesos|inversion/.test(cerca)) continue;
        const fecha = `${Number(m[1])} de ${m[2]}`;
        if (!permitidas.has(fecha) && !fallas.some((f) => f.includes(fecha))) fallas.push(`precio «hasta el ${fecha}» que no es la fecha de ningún tramo`);
    }
    return fallas;
}

/** Lo prohibido en UN mensaje del bot. */
export function violacionesDeVenta(s: Pick<SalidaSimulada, 'texto' | 'step' | 'opciones' | 'payload'>, c: ContextoVenta): Violacion[] {
    const v: Violacion[] = [];
    const texto = String(s.texto ?? '');
    const ops = s.opciones ?? [];
    const step = String(s.step ?? '');
    if (c.enVenta && !c.pidioClub) {
        if (RE_SEDES.test(texto) || ops.some((o) => o.id.startsWith(PREFIJO_BOTON_SEDE)) || step === 'embudo_bienvenida') {
            v.push({ codigo: 'menu_sedes', detalle: `menú de sedes en una venta: «${corto(texto)}»` });
        }
        if (RE_CLASE_PRUEBA.test(texto)) v.push({ codigo: 'clase_prueba', detalle: `«clase de prueba» sin pedirla: «${corto(texto.slice(Math.max(0, texto.search(RE_CLASE_PRUEBA) - 40)))}»` });
        const pregunta = c.preguntasEmbudo.find((p) => p && texto.includes(p));
        if (pregunta || PASOS_EMBUDO_CLASE.has(step) || ops.some((o) => o.id.startsWith('sm_em_') && !o.id.startsWith(PREFIJO_BOTON_SEDE))) {
            v.push({ codigo: 'preguntas_embudo', detalle: `preguntas del embudo en una venta (${pregunta ? `«${corto(pregunta, 60)}»` : step || 'botones sm_em_'})` });
        }
        const otro = otroServicioEn(texto, c);
        if (otro) v.push({ codigo: 'otro_servicio', detalle: `metió «${otro.name}» en la venta de «${c.item!.name}»` });
        if (RE_CORREO.test(texto)) v.push({ codigo: 'pide_correo', detalle: `pide el correo en una venta: «${corto(texto.slice(Math.max(0, texto.search(RE_CORREO) - 30)))}»` });
    }
    for (const f of fechasDeTramoMal(texto, c.items)) v.push({ codigo: 'fecha_tramo', detalle: f });
    if (c.revisarMontos) {
        const fuera = [...new Set(montosEn(texto).filter((n) => !c.permitidos.has(n)))];
        if (fuera.length) {
            v.push({ codigo: 'monto_fuera', detalle: `monto(s) que no están en el catálogo ni en los planes: ${fuera.map((n) => `$${n.toLocaleString('es-CO')}`).join(', ')}` });
        }
    }
    return v;
}

// ─── El «Sí» (o «Más adelante») de una campaña, en simulación ────────────────
//
// En producción lo atiende el webhook ANTES del bot (`atenderRespuestaDeCampana`)
// y sale por `sendTextMessage` + `wa_record_outbound_message`, no por `deliver`:
// `turnoSimulado` no lo cubre. Esto corre ese mismo servicio dentro del
// cortafuegos y de `simularEnvios` (por si el frente A manda el pago por
// `deliver`), y captura lo que se habría registrado con un override de la RPC.
// `sendTextMessage` dentro del cortafuegos no sale (devuelve 'simulacion').

const copiaJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const MAX_MEMORIA = 40;

export async function turnoDeCampanaSimulado(
    sesion: SesionPrueba,
    msg: { waMessageId: string; textBody: string; botonId: string },
    ahora = Date.now(),
): Promise<(ResultadoTurnoSimulado & { resultado: string }) | null> {
    const schoolId = sesion.school_id!;
    const integ = await integracionParaSimular(schoolId);
    const contacto = contactoSintetico(sesion.contact_wa_id);
    const conversationId = conversacionDePrueba(sesion);
    const tablas: Record<string, Fila[]> = copiaJson(sesion.estado.tablas ?? {});
    const ahoraIso = new Date(ahora).toISOString();
    const conv: Fila = (tablas.whatsapp_conversations ?? [])[0] ?? {
        id: conversationId, integration_id: integ.id, school_id: schoolId, contact_wa_id: contacto,
        contact_name: 'Prueba SportMaps', parent_id: null, identified: false, status: 'open', contact_kind: null,
        unread_count: 0, tomada_por: null, tomada_hasta: null, bot_turno_hasta: null, created_at: ahoraIso,
    };
    conv.parent_id = sesion.rol === 'papa' ? sesion.parent_id : null;
    conv.identified = sesion.rol === 'papa' && Boolean(sesion.parent_id);
    conv.last_inbound_at = ahoraIso; conv.last_message_at = ahoraIso; conv.updated_at = ahoraIso;
    tablas.whatsapp_conversations = [conv];
    const ultimo = Math.max(0, ...(tablas.whatsapp_messages ?? []).map((m) => new Date(String(m.wa_timestamp ?? m.created_at ?? 0)).getTime() || 0));
    const entranteIso = new Date(Math.max(ahora, ultimo + 1)).toISOString();
    const raw = { type: 'button', button: { payload: msg.botonId, text: msg.textBody } };
    tablas.whatsapp_messages = [...(tablas.whatsapp_messages ?? []), {
        id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'inbound', type: 'button',
        text_body: msg.textBody, payload: raw, ai_generated: false, wa_message_id: msg.waMessageId, from_wa_id: contacto,
        to_wa_id: null, wa_timestamp: entranteIso, created_at: entranteIso, status: null,
    }];

    const registradas: SalidaSimulada[] = [];
    const ctx: ContextoCortafuegos = {
        memoria: tablas,
        bloqueadas: [],
        rpc: {
            wa_record_outbound_message: (a: any) => {
                const payload = (a?.p_payload ?? {}) as Record<string, unknown>;
                registradas.push({ texto: String(a?.p_text_body ?? ''), step: (payload.step as string) ?? null, botones: [], payload });
                const t = new Date().toISOString();
                (ctx.memoria.whatsapp_messages ??= []).push({
                    id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'outbound',
                    type: a?.p_type ?? 'text', text_body: a?.p_text_body ?? null, payload, ai_generated: a?.p_ai_generated === true,
                    wa_message_id: a?.p_wa_message_id ?? `sim-${randomUUID()}`, from_wa_id: null, to_wa_id: contacto,
                    wa_timestamp: t, created_at: t, status: 'sent',
                });
                return randomUUID();
            },
            wa_identify_by_phone: () => (sesion.rol === 'papa' && sesion.parent_id
                ? { estado: 'identificado', parent_id: sesion.parent_id } : { estado: 'desconocido' }),
            wa_identify_staff_admin_by_phone: () => ({ estado: 'desconocido' }),
            wa_is_blocked: () => false,
            wa_can_send_template: () => false,
        },
    };
    const parsed: ParsedInboundMessage = {
        phoneNumberId: integ.phone_number_id, contactWaId: contacto, contactName: 'Prueba SportMaps',
        waMessageId: msg.waMessageId, type: 'button', textBody: msg.textBody, waTimestamp: entranteIso,
        mediaId: null, mediaMimeType: null, mediaCaption: null, botonId: msg.botonId, raw,
    };
    const { resultado, salidas } = await conCortafuegos(ctx, () => simularEnvios(() =>
        atenderRespuestaDeCampana({ integration: integ, conversationId, msg: parsed })));
    if (resultado === 'no_aplica') return null; // el webhook seguiría con el bot: que lo haga turnoSimulado
    for (const s of salidas) {
        const t = new Date().toISOString();
        (ctx.memoria.whatsapp_messages ??= []).push({
            id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'outbound',
            type: s.opciones?.length ? 'interactive' : 'text', text_body: s.texto, payload: { ...(s.payload ?? {}), step: s.step },
            ai_generated: true, wa_message_id: `sim-${randomUUID()}`, from_wa_id: null, to_wa_id: contacto,
            wa_timestamp: t, created_at: t, status: 'sent',
        });
    }
    ctx.memoria.whatsapp_messages = (ctx.memoria.whatsapp_messages ?? []).slice(-MAX_MEMORIA);
    delete ctx.memoria.whatsapp_settings;
    sesion.estado = { conversationId, tablas: ctx.memoria, bloqueadas: ctx.bloqueadas.slice(0, 50) };
    return { salidas: [...registradas, ...salidas], bloqueadas: ctx.bloqueadas, nota: `campaña → ${String(resultado)}`, resultado: String(resultado) };
}

// ─── ¿Seguro que es simulación? ──────────────────────────────────────────────

/** Lista de problemas (vacía = se puede correr): deliver envuelto, escrituras y envíos bloqueados, sin token. */
export async function verificarSimulacion(schoolId: string): Promise<string[]> {
    const problemas: string[] = [];
    const { resultado: dentro } = await simularEnvios(async () => enSimulacion());
    if (dentro !== true) problemas.push('simularEnvios no envuelve deliver (enSimulacion() es false adentro)');
    if (enSimulacion()) problemas.push('enSimulacion() es true FUERA de simularEnvios');
    const integ = await integracionParaSimular(schoolId);
    if (integ.access_token_encrypted) problemas.push('la integración simulada trae token');
    const ctx: ContextoCortafuegos = { memoria: {}, bloqueadas: [], rpc: {} };
    const escritura: any = await conCortafuegos(ctx, async () =>
        supabase.from('schools').update({ updated_at: new Date().toISOString() }).eq('id', '00000000-0000-0000-0000-000000000000'));
    if (escritura?.error?.code !== 'SIM00') problemas.push('el cortafuegos NO bloqueó una escritura de prueba');
    const rpc: any = await conCortafuegos(ctx, async () => supabase.rpc('wa_record_outbound_message', {}));
    if (rpc?.error?.code !== 'SIM00') problemas.push('el cortafuegos NO bloqueó una RPC de escritura');
    const envio = await conCortafuegos(ctx, () => sendTextMessage(integ, '570000000000', 'qa'));
    if (envio.ok || envio.error !== 'simulacion') problemas.push('sendTextMessage dentro del cortafuegos no devolvió «simulacion»');
    return problemas;
}

// ─── Replay ──────────────────────────────────────────────────────────────────

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(`--${nombre}`);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const enmascarar = (tel: string | null | undefined) => `•••${String(tel ?? '').replace(/\D/g, '').slice(-4) || '????'}`;

/** Una fila mínima de whatsapp_messages (marcas del payload por alias, nunca el crudo). */
interface FilaReal {
    id: string; conversation_id: string; direction: 'inbound' | 'outbound'; type: string; text_body: string | null;
    ai_generated: boolean | null; wa_timestamp: string | null; created_at: string;
    step: string | null; automatico: string | null; campana_id: string | null; servicio_id: string | null;
    venta_servicio_id: string | null; destino_anuncio: string | null; boton_plantilla: string | null;
    boton_id: string | null; lista_id: string | null; boton_sim: string | null; referral: Record<string, unknown> | null;
    caption: string | null; interactivo: string | null;
}

const COLUMNAS_REALES = [
    'id', 'conversation_id', 'direction', 'type', 'text_body', 'ai_generated', 'wa_timestamp', 'created_at',
    'step:payload->>step', 'automatico:payload->>automatico', 'campana_id:payload->>campana_id',
    'servicio_id:payload->>servicio_id', 'venta_servicio_id:payload->>venta_servicio_id',
    'destino_anuncio:payload->>destino_anuncio', 'boton_plantilla:payload->button->>payload',
    'boton_id:payload->interactive->button_reply->>id', 'lista_id:payload->interactive->list_reply->>id',
    'boton_sim:payload->>boton_id', 'referral:payload->referral', 'caption:payload->>caption',
    'interactivo:payload->interactive->>type',
].join(', ');

/** Palabras de servicio de la escuela: las del evento de cada ítem y las distintivas de su nombre. */
function palabrasDeServicio(items: ItemConFicha[], extra: string[]): string[] {
    const raiz: Record<string, string[]> = {
        clinica: ['clinica', 'clínica'], campamento: ['campamento'], vacacional: ['vacacional'], torneo: ['torneo'],
    };
    const p = new Set<string>(extra.map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const it of items) {
        for (const e of eventosNombrados([it.name, String(it.kind ?? '')])) for (const w of raiz[e] ?? []) p.add(w);
        for (const k of tokensDistintivos(it.name)) if (k.length >= 6 && !/voleibol|futbol|baloncesto|sede|club/.test(k)) p.add(k);
    }
    return [...p].filter((w) => /^[\p{L}\d ]+$/u.test(w));
}

async function idsDeConversaciones(integraciones: string[], desde: string, hasta: string, palabras: string[]): Promise<string[]> {
    const filtros = [
        ...palabras.map((w) => `text_body.ilike.*${w}*`),
        'payload->>servicio_id.not.is.null', 'payload->>venta_servicio_id.not.is.null', 'payload->>destino_anuncio.eq.servicio',
    ].join(',');
    const ids = new Set<string>();
    for (let pagina = 0; pagina < 20; pagina++) {
        const { data, error } = await supabase.from('whatsapp_messages').select('conversation_id')
            .in('integration_id', integraciones).gte('created_at', desde).lte('created_at', hasta)
            .or(filtros).order('created_at', { ascending: true }).range(pagina * 1000, pagina * 1000 + 999);
        if (error) throw new Error(`No pude leer los mensajes: ${error.message}`);
        for (const f of (data ?? []) as any[]) ids.add(String(f.conversation_id));
        if ((data ?? []).length < 1000) break;
    }
    return [...ids];
}

async function mensajesDe(ids: string[], desde: string, hasta: string): Promise<FilaReal[]> {
    const filas: FilaReal[] = [];
    for (let i = 0; i < ids.length; i += 40) {
        const lote = ids.slice(i, i + 40);
        for (let pagina = 0; pagina < 10; pagina++) {
            const { data, error } = await supabase.from('whatsapp_messages').select(COLUMNAS_REALES)
                .in('conversation_id', lote).gte('created_at', desde).lte('created_at', hasta)
                .order('created_at', { ascending: true }).range(pagina * 1000, pagina * 1000 + 999);
            if (error) throw new Error(`No pude leer los mensajes: ${error.message}`);
            filas.push(...((data ?? []) as unknown as FilaReal[]));
            if ((data ?? []).length < 1000) break;
        }
    }
    return filas;
}

interface TurnoReplay { entrada: string; salidas: SalidaSimulada[]; violaciones: Violacion[]; nota: string | null; error?: string }

interface ResultadoReplay {
    conversacion: string; telefono: string; familia: boolean;
    entrantes: number; reproducidos: number; omitidos: number; sembrados: number;
    turnos: TurnoReplay[];
}

const TIPOS_ADJUNTO = new Set(['image', 'document', 'audio', 'video', 'sticker', 'location', 'unsupported', 'system']);
const PASOS_DE_CAMPANA = new Set(['campana_respuesta_si', 'campana_respuesta_luego', 'opt_out_confirmado', 'campana_no_interesa']);
const momentoDe = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
    new Date(String(f.wa_timestamp ?? f.created_at ?? 0)).getTime() || 0;
const MARCADO_VENTA = (p: any) => !!(p && (p.venta_servicio_id || p.servicio_id || p.destino_anuncio === 'servicio'));

async function reproducir(
    conv: { id: string; contact_wa_id: string; parent_id: string | null },
    filas: FilaReal[], schoolId: string, base: Omit<ContextoVenta, 'item' | 'enVenta' | 'pidioClub' | 'revisarMontos'>,
): Promise<ResultadoReplay> {
    const familia = Boolean(conv.parent_id);
    const r: ResultadoReplay = {
        conversacion: conv.id, telefono: enmascarar(conv.contact_wa_id), familia,
        entrantes: 0, reproducidos: 0, omitidos: 0, sembrados: 0, turnos: [],
    };
    const sesion: SesionPrueba = {
        contact_wa_id: `5731${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, school_id: schoolId,
        rol: familia ? 'papa' : 'prospecto', child_id: null, parent_id: conv.parent_id, estado: { tablas: {} },
    };
    const integ = await integracionParaSimular(schoolId);
    const conversationId = conversacionDePrueba(sesion);
    const rpc = familia ? { wa_es_afiliado: () => ({ afiliado: true }) } : undefined;
    let item: ItemConFicha | null = null;
    let enVenta = false;
    let pidioClub = false;
    const ultimoEnMemoria = () => Math.max(0, ...((sesion.estado.tablas?.whatsapp_messages ?? []) as Fila[]).map((m) => momentoDe(m)));
    const nombrado = (texto: string | null | undefined) => (texto ? itemNombradoEn(texto, base.items) : null);

    for (const f of [...filas].sort((a, b) => momentoDe(a) - momentoDe(b))) {
        const ts = momentoDe(f);
        if (f.direction === 'outbound') {
            // Lo del bot lo vuelve a decir el de hoy; lo de la campaña lo regenera su servicio.
            if (f.ai_generated === true || PASOS_DE_CAMPANA.has(String(f.step ?? ''))) continue;
            const payload: Record<string, unknown> = {};
            for (const k of ['step', 'campana_id', 'servicio_id', 'venta_servicio_id', 'destino_anuncio'] as const) if (f[k]) payload[k] = f[k];
            if (f.automatico === 'true') payload.automatico = true;
            const momento = new Date(Math.max(ts, ultimoEnMemoria() + 1)).toISOString();
            const tablas = (sesion.estado.tablas ??= {});
            (tablas.whatsapp_messages ??= []).push({
                id: randomUUID(), conversation_id: conversationId, integration_id: integ.id, direction: 'outbound',
                type: f.type, text_body: f.text_body, payload, ai_generated: false, wa_message_id: `replay-${f.id}`,
                from_wa_id: null, to_wa_id: contactoSintetico(sesion.contact_wa_id), wa_timestamp: momento, created_at: momento, status: 'sent',
            });
            tablas.whatsapp_messages = tablas.whatsapp_messages.slice(-MAX_MEMORIA);
            r.sembrados++;
            const it = MARCADO_VENTA(payload) ? base.items.find((x) => x.id === payload.servicio_id || x.id === payload.venta_servicio_id) ?? null
                : String(f.text_body ?? '').length >= 60 ? nombrado(f.text_body) : null;
            if (it) { item = it; enVenta = true; }
            continue;
        }
        r.entrantes++;
        const botonId = f.boton_plantilla ?? f.boton_id ?? f.lista_id ?? f.boton_sim ?? null;
        const texto = String(f.text_body ?? '').trim();
        if (TIPOS_ADJUNTO.has(f.type) || f.interactivo === 'nfm_reply' || (!texto && !botonId)) { r.omitidos++; continue; }
        // Estado de la venta según lo que escribió la persona.
        const referral = f.referral && typeof f.referral === 'object' ? f.referral : null;
        const itEntrada = nombrado(texto) ?? (referral ? nombrado(`${referral.headline ?? ''} ${referral.body ?? ''}`) : null);
        if (itEntrada) { item = itEntrada; enVenta = true; pidioClub = false; }
        // Un botón del embudo (`sm_em_*`) tocado por la persona cuenta como elegir el club: en el
        // replay ese botón lo puso el bot de ENTONCES y se reproduce tal cual; sin esto, ya arreglado
        // el bot, su respuesta al botón seguiría contando como «embudo en una venta».
        if (pideElClub(texto) || RE_CLASE_PRUEBA.test(texto) || botonId?.startsWith('sm_em_')) pidioClub = true;

        let t: ResultadoTurnoSimulado | null = null;
        const entrada = botonId ? `${texto || botonId} [${botonId.slice(0, 28)}]` : texto;
        try {
            // El reloj de ESTA conversación va a la hora real del mensaje (nunca antes de lo que ya está en memoria).
            moverReloj(Math.max(ts, ultimoEnMemoria() + 1000));
            const waMessageId = `replay-${randomUUID()}`;
            if (botonId?.startsWith('smc:')) t = await turnoDeCampanaSimulado(sesion, { waMessageId, textBody: texto || 'Sí', botonId });
            if (!t) {
                t = await turnoSimulado(sesion, { waMessageId, textBody: texto, botonId, ...(referral ? { referral } : {}) },
                    Date.now(), rpc ? { rpc } : {});
            }
        } catch (e: any) {
            r.turnos.push({ entrada, salidas: [], violaciones: [], nota: null, error: String(e?.message ?? e).slice(0, 200) });
            continue;
        }
        r.reproducidos++;
        const familiaYSalidas = t.salidas.filter((s) => !/^\[se abre en el buz[oó]n/.test(s.texto ?? ''));
        // Lo que dijo el bot también puede abrir la venta (la ficha marcada).
        for (const s of familiaYSalidas) {
            if (MARCADO_VENTA(s.payload)) {
                const p = s.payload as Record<string, unknown>;
                const it = base.items.find((x) => x.id === p.servicio_id || x.id === p.venta_servicio_id);
                if (it) { item = it; enVenta = true; }
            }
            if (s.step === 'campana_respuesta_si' && nombrado(s.texto)) { item = nombrado(s.texto); enVenta = true; }
        }
        const violaciones = familiaYSalidas.flatMap((s) => violacionesDeVenta(s, {
            ...base, item, enVenta, pidioClub, revisarMontos: !familia || MARCADO_VENTA(s.payload),
        }));
        r.turnos.push({ entrada, salidas: t.salidas, violaciones, nota: t.nota });
    }
    return r;
}

async function main(): Promise<void> {
    const ESCUELA = arg('escuela');
    const DESDE = arg('desde');
    const HASTA = arg('hasta');
    const MAX = Number(arg('max') ?? 0) || 0;
    const SOLO_CONV = arg('conversacion');
    const PALABRAS = (arg('palabras') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const PARALELO = Math.max(1, Math.min(8, Number(arg('paralelo') ?? 4) || 4));
    const TRANSCRIPCION = arg('transcripcion');
    const VERBOSE = process.argv.includes('--verbose');
    const log = console.log.bind(console);
    if (!ESCUELA || !DESDE || !/^\d{4}-\d{2}-\d{2}$/.test(DESDE) || (HASTA && !/^\d{4}-\d{2}-\d{2}$/.test(HASTA))) {
        log('Uso: npm run qa:replay-ventas -- --escuela <uuid|slug> --desde YYYY-MM-DD [--hasta YYYY-MM-DD] [--max N] '
            + '[--conversacion <uuid>] [--palabras a,b] [--paralelo N] [--transcripcion archivo.md] [--verbose]');
        process.exit(2);
    }
    if (!VERBOSE) {
        const nada = () => undefined;
        console.log = nada; console.info = nada; console.warn = nada; console.error = nada; console.debug = nada;
    }
    instalarReloj();
    instalarAliasesVirtuales();
    const inicio = DateReal.now();

    const esUuid = /^[0-9a-f-]{36}$/i.test(ESCUELA);
    const { data: escuela } = await supabase.from('schools').select('id, name').eq(esUuid ? 'id' : 'slug', ESCUELA).maybeSingle();
    if (!escuela) { log(`No encontré la escuela «${ESCUELA}»`); process.exit(2); }
    const schoolId = (escuela as any).id as string;

    const problemas = await verificarSimulacion(schoolId);
    if (problemas.length) {
        log('NO corro el replay: la simulación no está garantizada.');
        for (const p of problemas) log(`  · ${p}`);
        process.exit(2);
    }

    const desdeIso = new DateReal(instanteBogota(DESDE, '00:00')).toISOString();
    const hastaIso = HASTA ? new DateReal(instanteBogota(HASTA, '23:59')).toISOString() : new DateReal().toISOString();
    const [items, aj, clase, extrasDeEscuela, integraciones] = await Promise.all([
        serviciosDeAnuncio(schoolId, instanteBogota(DESDE, '00:00')),
        ajustesWhatsAppDeEscuela(schoolId),
        ajustesClasePrueba(schoolId),
        montosDeEscuela(schoolId),
        supabase.from('school_whatsapp_integrations').select('id').eq('school_id', schoolId).limit(5),
    ]);
    const idsInteg = ((integraciones.data ?? []) as any[]).map((x) => String(x.id));
    if (!idsInteg.length) { log('La escuela no tiene integración de WhatsApp.'); process.exit(2); }
    const extras = [clase?.precio, ...extrasDeEscuela];
    const base = {
        items,
        permitidos: montosPermitidos(items, extras),
        preguntasEmbudo: (aj.preguntasProspecto ?? []).map((p) => String(p.texto ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '')
            .filter((s) => s.length >= 12),
    };
    const palabras = palabrasDeServicio(items, PALABRAS);
    log(`${(escuela as any).name} · ${DESDE} → ${HASTA ?? 'hoy'} · servicios: ${items.map((i) => i.name).join(' · ') || '(ninguno vigente)'}`);
    log(`Palabras: ${palabras.join(', ')} · montos permitidos: ${[...base.permitidos].sort((a, b) => a - b).map((n) => `$${n.toLocaleString('es-CO')}`).join(' ')}`);

    let ids = SOLO_CONV ? [SOLO_CONV] : await idsDeConversaciones(idsInteg, desdeIso, hastaIso, palabras);
    if (MAX > 0) ids = ids.slice(0, MAX);
    if (!ids.length) { log('Ninguna conversación habla de un servicio en ese rango.'); process.exit(0); }
    const [filas, convs] = await Promise.all([
        mensajesDe(ids, desdeIso, hastaIso),
        (async () => {
            const out: any[] = [];
            for (let i = 0; i < ids.length; i += 100) {
                const { data } = await supabase.from('whatsapp_conversations').select('id, contact_wa_id, parent_id')
                    .in('id', ids.slice(i, i + 100));
                out.push(...((data ?? []) as any[]));
            }
            return out;
        })(),
    ]);
    const porConv = new Map<string, FilaReal[]>();
    for (const f of filas) (porConv.get(f.conversation_id) ?? porConv.set(f.conversation_id, []).get(f.conversation_id)!).push(f);
    log(`${ids.length} conversaciones · ${filas.length} mensajes leídos · ${PARALELO} a la vez\n`);

    const resultados: ResultadoReplay[] = new Array(convs.length);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(PARALELO, convs.length) }, async () => {
        while (k < convs.length) {
            const i = k++;
            const c = convs[i];
            const fs = porConv.get(c.id) ?? [];
            resultados[i] = await conReloj(momentoDe(fs[0] ?? { created_at: desdeIso }), () => reproducir(c, fs, schoolId, base));
            process.stdout.write(resultados[i].turnos.some((t) => t.violaciones.length) ? 'F' : '.');
        }
    }));
    process.stdout.write('\n\n');

    const porCodigo = new Map<string, number>();
    let total = 0;
    let turnos = 0;
    // Sin nada que reproducir (solo la plantilla de la campaña, o solo fotos): se cuentan aparte.
    const vacias = resultados.filter((r) => !r.reproducidos && !r.turnos.length);
    for (const r of resultados) {
        if (vacias.includes(r)) continue;
        const v = r.turnos.flatMap((t) => t.violaciones);
        total += v.length;
        turnos += r.reproducidos;
        for (const x of v) porCodigo.set(x.codigo, (porCodigo.get(x.codigo) ?? 0) + 1);
        const errores = r.turnos.filter((t) => t.error).length;
        log(`${v.length ? '❌' : '✅'} ${r.telefono} ${r.familia ? 'familia  ' : 'prospecto'} · ${r.entrantes} entrantes (${r.reproducidos} reproducidos`
            + `${r.omitidos ? `, ${r.omitidos} adjuntos/formularios omitidos` : ''}) · ${r.sembrados} de la escuela sembrados`
            + `${errores ? ` · ${errores} errores de simulación` : ''} · ${v.length} violaciones`);
        for (const t of r.turnos) for (const x of t.violaciones) log(`     [${x.codigo}] «${corto(t.entrada, 50)}» → ${x.detalle}`);
        for (const t of r.turnos.filter((x) => x.error)) log(`     [error] «${corto(t.entrada, 50)}» → ${t.error}`);
    }
    const conViolaciones = resultados.filter((r) => r.turnos.some((t) => t.violaciones.length)).length;
    log(`\n══ ${resultados.length} conversaciones (${vacias.length} sin entrantes que reproducir: solo plantilla o fotos) · ${turnos} turnos reproducidos · ${conViolaciones} con violaciones · ${total} violaciones`
        + `${porCodigo.size ? ` (${[...porCodigo].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ')})` : ''}`
        + ` · ${Math.round((DateReal.now() - inicio) / 1000)} s`);

    if (TRANSCRIPCION) {
        const md: string[] = [`# Replay de ventas — ${(escuela as any).name} — ${DESDE} → ${HASTA ?? 'hoy'}`, '',
            `**${resultados.length} conversaciones · ${conViolaciones} con violaciones · ${total} violaciones**`, ''];
        for (const r of [...resultados].sort((a, b) => b.turnos.flatMap((t) => t.violaciones).length - a.turnos.flatMap((t) => t.violaciones).length)) {
            const v = r.turnos.flatMap((t) => t.violaciones).length;
            md.push(`## ${v ? '❌' : '✅'} ${r.telefono} (${r.familia ? 'familia' : 'prospecto'}) — ${v} violaciones`, '');
            for (const t of r.turnos) {
                md.push(`> 👤 ${t.entrada}`);
                if (t.error) md.push(`> ⚠️ error de simulación: ${t.error}`);
                if (!t.salidas.length && !t.error) md.push(`> 🤖 _(nada${t.nota ? `: ${t.nota}` : ''})_`);
                for (const s of t.salidas) md.push(`> 🤖 ${String(s.texto ?? '').replace(/\n/g, '\n> ')}`);
                for (const x of t.violaciones) md.push(`> **[${x.codigo}]** ${x.detalle}`);
                md.push('>');
            }
            md.push('');
        }
        writeFileSync(TRANSCRIPCION, md.join('\n'));
        log(`Transcripción: ${TRANSCRIPCION}`);
    }
    process.exit(total ? 1 : 0);
}

if (require.main === module) {
    main().catch((e) => { process.stdout.write(`${String(e?.stack ?? e)}\n`); process.exit(1); });
}
