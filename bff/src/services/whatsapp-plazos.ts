/**
 * whatsapp-plazos — «quiero pagar por plazos» por WhatsApp (oleada 2, F4 del spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §5).
 *
 * Determinista, SIN modelo. Solo escuelas con `payment_agreements_enabled`; con la
 * función apagada NADA de esto responde (el turno sigue exactamente como antes).
 *
 *   «quiero pagar en cuotas» ─► (cobros abiertos de ESTA persona)
 *        │ varios: «¿cuáles?» → plazos_cobros          │ ninguno: se le dice y cierra
 *        ▼
 *   «¿en cuántas cuotas / qué fechas?» → plazos_cuotas  (dentro de los topes; fuera de
 *        │                                               ellos no se bloquea: lo revisa la escuela)
 *        ▼
 *   calendario propuesto + «¿Confirmas?» → plazos_confirmar  (sí EXPLÍCITO, 30 min)
 *        │ sí → `solicitar()` con `p_payer_profile_id` = la persona identificada
 *        ▼
 *   activo  → «quedó activo»      solicitado → «lo revisa la escuela y te avisa por aquí»
 *
 * Seguridad: solo actúa sobre la persona IDENTIFICADA (`parentId` del turno) y sobre
 * cobros suyos (la consulta los filtra por pagador y la RPC los vuelve a comprobar).
 * Ante cualquier error del servicio: «lo revisará la escuela» + buzón.
 * Lenguaje: nada de mora, deuda, atraso, multa ni recargo (regla de Monster).
 */

import { normalizarFrase } from './whatsapp-reglas-turno';
import {
    BOTON_PLAN, TXT, pesos, fechaLarga, numeroEscrito, sumarDias, MESES, esSiExplicito, esNoExplicito,
    PALABRAS_PROHIBIDAS, anioDeMes, type EstadoPlan, type PasoPlan,
} from './whatsapp-plan-comun';
import type {
    TopesAcuerdo, CobroAbierto, Calendario, Resultado, EstadoAcuerdo, CuotaEntrada,
} from './acuerdos-de-pago.service';
import type { BotonInteractivo } from './whatsapp.service';

// ─── Puerto (se conecta a la base en `whatsapp-plan-y-plazos.ts`) ────────────

export interface PuertoPlazos {
    topes(schoolId: string): Promise<TopesAcuerdo>;
    /** Cobros abiertos de la persona identificada en esta escuela (filtrados por pagador). */
    cobrosAbiertos(schoolId: string, parentId: string): Promise<CobroAbierto[]>;
    /** Calendario propuesto sobre esos cobros (relee saldos y topes). */
    proponer(p: { schoolId: string; paymentIds: string[]; cuotas?: number; fechas?: string[] }):
        Promise<Resultado<{ cobros: CobroAbierto[]; calendario: Calendario; topes: TopesAcuerdo }>>;
    solicitar(p: { schoolId: string; paymentIds: string[]; items: CuotaEntrada[]; payerProfileId: string }):
        Promise<Resultado<{ acuerdo: { agreement_id: string; status: EstadoAcuerdo; auto_approved: boolean; total_amount: number; installments: number } }>>;
    hoy(): string;
    ahora(): number;
}

export type EnviarPlan = (texto: string, paso: string, estado: EstadoPlan | null, botones?: BotonInteractivo[]) => Promise<void>;
export type EscalarPlan = (motivo: string, mensaje: string) => Promise<void>;

export interface CtxPlazos {
    schoolId: string;
    parentId: string;
    texto: string;
    botonId: string | null;
}

// ─── Detección (pura) ────────────────────────────────────────────────────────

const PAGO_PASADO = /\b(pague|pagamos|pagaron|pago ya|ya pago|ya pagu\w*|consigne|consignamos|transferi|transferimos|envie|enviamos|hice el pago)\b/;
const UNIDAD = '(cuotas?|pagos?|partes|abonos?|quincenas?|veces)';
const PLAZOS: RegExp[] = [
    /\b(pagar|pagarlo|pagarla|pagarle|cancelar|abonar|dividir|partir|fraccionar|financiar|separar)\b.{0,45}\b(plazos?|cuotas?|partes|abonos|quincenas?)\b/,
    /\b(a|por|en|con) plazos?\b/,
    /\bplan de pagos?\b|\bacuerdo de pago\b|\bfacilidades? de pago\b|\bpago fraccionado\b|\bpago a plazos\b/,
    new RegExp(`\\ben (dos|tres|cuatro|cinco|seis|2|3|4|5|6) ${UNIDAD}\\b`),
    /\b(la mitad|el 50) (ahora|hoy|ya)\b.{0,30}\b(la otra|el resto|lo demas)\b/,
    /\bpagar\b.{0,25}\b(el|los) \d{1,2} y (el )?\d{1,2}\b/,
    /\b(pagar|pago|abonar|mensualidad)\b.{0,30}\b(el|los) \d{1,2} y (el )?\d{1,2}\b/,
    /\b(puedo|podemos|podria|podriamos|se puede|es posible|quiero|queremos|quisiera|necesito|necesitamos)\b.{0,30}\bpagar\b.{0,30}\b(despues|luego|mas adelante)\b.{0,15}\ben (partes|cuotas|abonos)\b/,
];

/** ¿Pide pagar un cobro por plazos / en cuotas? Pura. */
export function pideAcuerdoDePago(texto: string | null | undefined): boolean {
    const n = normalizarFrase(texto);
    if (!n || n.length > 400) return false;
    if (PAGO_PASADO.test(n)) return false;
    return PLAZOS.some((re) => re.test(n));
}

export interface PlazosLeidos { cuotas?: number; fechas?: string[] }

function diaDelMesDesde(hoy: string, dia: number, despuesDe: string): string {
    // Próxima ocurrencia del día `dia` que sea > despuesDe (o ≥ hoy si despuesDe < hoy).
    let y = Number(hoy.slice(0, 4));
    let m = Number(hoy.slice(5, 7));
    for (let i = 0; i < 14; i++) {
        const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const d = Math.min(dia, ultimo);
        const f = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (f >= hoy && f > despuesDe) return f;
        m += 1;
        if (m > 12) { m = 1; y += 1; }
    }
    return despuesDe;
}

/**
 * Cuotas y/o fechas que dice la persona: «en 3 cuotas», «dos pagos», «el 15 y el
 * 30», «15 de diciembre y 15 de enero», «tres». Pura; `hoy` se inyecta.
 */
export function leerPlazos(texto: string | null | undefined, hoy: string): PlazosLeidos {
    const n = normalizarFrase(texto);
    const out: PlazosLeidos = {};
    if (!n) return out;

    // Fechas con mes: «15 de diciembre y 15 de enero».
    const conMes: string[] = [];
    const reMes = new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = reMes.exec(n))) {
        const d = Number(m[1]);
        const mes = MESES.indexOf(m[2]) + 1;
        const y = anioDeMes(mes, hoy);
        const ultimo = new Date(Date.UTC(y, mes, 0)).getUTCDate();
        if (d >= 1 && d <= ultimo) conMes.push(`${y}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    if (conMes.length) {
        out.fechas = [...conMes].sort();
        out.cuotas = out.fechas.length;
        return out;
    }

    // Solo días del mes: «el 15 y el 30», «los días 5, 15 y 25».
    const dias = /\b(?:el|los|dias?|dia) (\d{1,2})((?:(?:,| y | e | el | y el )+\d{1,2})*)\b/.exec(n);
    if (dias) {
        const lista = [Number(dias[1]), ...[...(dias[2] ?? '').matchAll(/\d{1,2}/g)].map((x) => Number(x[0]))]
            .filter((d) => d >= 1 && d <= 31);
        if (lista.length >= 1 && !/\b(cuotas?|pagos?)\b.*\b\d{1,2}\b.*\b(cuotas?|pagos?)\b/.test(n)) {
            let previa = '';
            const fechas: string[] = [];
            for (const d of lista) { previa = diaDelMesDesde(hoy, d, previa); fechas.push(previa); }
            out.fechas = fechas;
            out.cuotas = fechas.length;
            return out;
        }
    }

    // Cantidad de cuotas.
    const q = new RegExp(`\\b(?:en|por|a|de)? ?(un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|\\d{1,2}) ${UNIDAD}\\b`).exec(n);
    if (q) {
        const k = numeroEscrito(q[1]);
        if (k) out.cuotas = k;
    } else if (/\bquincenas?\b|\bla mitad\b|\bmitad y mitad\b/.test(n)) {
        out.cuotas = 2;
    } else {
        const solo = /^(?:en |por )?(un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|\d{1,2})$/.exec(n);
        if (solo) {
            const k = numeroEscrito(solo[1]);
            if (k) out.cuotas = k;
        }
    }
    return out;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

function limpiarConcepto(c: string | null): string {
    const t = (c ?? '').trim();
    return !t || PALABRAS_PROHIBIDAS.test(t) ? 'Cobro' : t.slice(0, 60);
}

function listaDeCobros(cobros: CobroAbierto[]): string {
    return cobros.map((c, i) => `${i + 1}. ${limpiarConcepto(c.concept)} — ${pesos(c.saldo)}`).join('\n');
}

function fraseTopes(t: TopesAcuerdo): string {
    return t.autoAprobar
        ? `La escuela aprueba directo hasta ${t.maxCuotas} cuotas y ${t.maxDias} días; si pides más, la escuela lo revisa y te avisa por aquí.`
        : 'La escuela revisa cada solicitud de plazos y te avisa por aquí.';
}

export function textoPedirCuotas(total: number, t: TopesAcuerdo): string {
    return `Claro, te ayudo a organizarlo 🙌\n\nEl total a repartir es *${pesos(total)}*. ¿En cuántas cuotas lo quieres pagar? ` +
        `Dime el número (por ejemplo *2*) o las fechas (por ejemplo *el 15 y el 30*).\n\n${fraseTopes(t)}`;
}

export function textoCalendario(cobros: CobroAbierto[], c: Calendario, hoy: string): string {
    const filas = c.cuotas.map((q) => `${q.seq}. ${fechaLarga(q.fecha, hoy)} — ${pesos(q.monto)}`).join('\n');
    const quien = cobros.length === 1 ? limpiarConcepto(cobros[0].concept) : `${cobros.length} cobros`;
    const cierre = c.requiereAprobacion
        ? 'Como esto queda fuera de lo que la escuela aprueba directo, ella lo revisa y te avisa por aquí.'
        : 'Si lo confirmas, queda activo y te recordamos cada fecha.';
    return `Esta sería tu propuesta de pago por plazos (${quien}):\n\n${filas}\n\nTotal: *${pesos(c.saldoTotal)}* en ${c.cuotas.length} ${c.cuotas.length === 1 ? 'pago' : 'cuotas'}.\n${cierre}\n\n` +
        '¿Confirmas que lo cree? Responde *Sí* o *No*.';
}

const BOTONES_CONFIRMAR: BotonInteractivo[] = [
    { id: BOTON_PLAN.SI, title: 'Sí, confirmo' },
    { id: BOTON_PLAN.NO, title: 'No' },
];

function mensajeDeError(causa: string): string {
    switch (causa) {
        case 'fecha_pasada': return 'Esa fecha ya pasó. Dime fechas desde hoy en adelante, por ejemplo *el 15 y el 30*.';
        case 'fechas_desordenadas': return 'Las fechas deben ir en orden, de la más cercana a la más lejana.';
        case 'fecha_lejana': return 'Esa fecha queda muy lejos (el máximo es un año). Dime fechas más cercanas.';
        case 'cuotas_fuera_de_rango': return 'No puedo armar ese número de cuotas (entre 1 y 12, y cada cuota debe tener valor). Dime otro número.';
        default: return 'No pude armar ese calendario. Dime en cuántas cuotas o qué fechas prefieres.';
    }
}

// ─── Motor ───────────────────────────────────────────────────────────────────

const unaFrase = (t: string) => normalizarFrase(t).split(' ').filter(Boolean).length;

interface Deps { puerto: PuertoPlazos; enviar: EnviarPlan; escalar: EscalarPlan }

async function pedirCuotas(ctx: CtxPlazos, d: Deps, datos: Record<string, any>, ids: string[], total: number, topes: TopesAcuerdo): Promise<true> {
    await d.enviar(textoPedirCuotas(total, topes), 'plazos_cuotas',
        { paso: 'plazos_cuotas', datos: { ...datos, ids, intentos: 0 } });
    return true;
}

/** Arma y muestra el calendario; pide el sí. true = ya contestó. */
async function mostrarCalendario(
    ctx: CtxPlazos, d: Deps, datos: Record<string, any>, ids: string[], leidos: PlazosLeidos,
): Promise<boolean> {
    const hoy = d.puerto.hoy();
    const r = await d.puerto.proponer({ schoolId: ctx.schoolId, paymentIds: ids, cuotas: leidos.cuotas, fechas: leidos.fechas });
    if (!r.ok) {
        if (r.error === 'acuerdos_apagados') return false;
        if (r.error === 'cobro_no_elegible') {
            await d.enviar('Tus cobros cambiaron mientras hablábamos. Escríbeme de nuevo *quiero pagar por plazos* y lo armamos con lo que está abierto hoy.', 'plazos_cambio', null);
            return true;
        }
        if (r.status === 400) {
            const intentos = Number(datos.intentos ?? 0) + 1;
            if (intentos >= 3) { await d.escalar('plazos_calendario_invalido', TXT.revisaEscuela); return true; }
            await d.enviar(mensajeDeError(r.error), 'plazos_cuotas', { paso: 'plazos_cuotas', datos: { ...datos, ids, intentos } });
            return true;
        }
        await d.escalar(`plazos_error:${r.error}`, TXT.revisaEscuela);
        return true;
    }
    const total = r.calendario.saldoTotal;
    await d.enviar(textoCalendario(r.cobros, r.calendario, hoy), 'plazos_confirmar',
        {
            paso: 'plazos_confirmar',
            datos: {
                ...datos, ids, total,
                cuotas: r.calendario.cuotas.length,
                fechas: r.calendario.cuotas.map((c) => c.fecha),
                montos: r.calendario.cuotas.map((c) => c.monto),
                t0: datos.t0 ?? d.puerto.ahora(), intentos: 0,
            },
        },
        BOTONES_CONFIRMAR);
    return true;
}

/** Arranca el flujo (el texto ya pidió plazos). false = no es para acá (función apagada, etc.). */
export async function iniciarPlazos(ctx: CtxPlazos, d: Deps): Promise<boolean> {
    const topes = await d.puerto.topes(ctx.schoolId);
    if (!topes.habilitado) return false; // Escuela sin la función: el turno sigue como antes.
    const cobros = (await d.puerto.cobrosAbiertos(ctx.schoolId, ctx.parentId))
        .sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 8);
    if (!cobros.length) {
        await d.enviar('No veo cobros abiertos a tu nombre en este momento, así que no hay nada para repartir en cuotas 🙌 Si crees que falta alguno, te paso con la escuela: solo dime.', 'plazos_sin_cobros', null);
        return true;
    }
    const leidos = leerPlazos(ctx.texto, d.puerto.hoy());
    const datos = { t0: d.puerto.ahora() };
    if (cobros.length === 1) {
        const ids = [cobros[0].id];
        if (leidos.cuotas || leidos.fechas) return mostrarCalendario(ctx, d, datos, ids, leidos);
        return pedirCuotas(ctx, d, datos, ids, cobros[0].saldo, topes);
    }
    await d.enviar(
        `Claro, lo organizamos 🙌 Tienes estos cobros abiertos:\n\n${listaDeCobros(cobros)}\n\n` +
        `¿Cuáles quieres repartir en cuotas? Responde *todos* o el número (por ejemplo *1* o *1 y 2*).`,
        'plazos_cobros',
        { paso: 'plazos_cobros', datos: { ...datos, opciones: cobros.map((c) => ({ id: c.id, saldo: c.saldo })), leidos, intentos: 0 } });
    return true;
}

function elegidos(texto: string, opciones: { id: string; saldo: number }[]): string[] | null {
    const n = normalizarFrase(texto);
    if (/^(todos|todas|todo|los dos|las dos|ambos|ambas|los tres|todos los cobros)$/.test(n)) return opciones.map((o) => o.id);
    if (!/^[\d ,y]+$/.test(n.replace(/\be\b/g, 'y'))) return null;
    const nums = [...n.matchAll(/\d{1,2}/g)].map((x) => Number(x[0]));
    if (!nums.length || nums.some((k) => k < 1 || k > opciones.length)) return null;
    return [...new Set(nums)].map((k) => opciones[k - 1].id);
}

/** Continúa el flujo abierto. false = el mensaje no es respuesta (se suelta el flujo). */
export async function continuarPlazos(ctx: CtxPlazos, d: Deps, estado: EstadoPlan, vencido: boolean): Promise<boolean> {
    const paso: PasoPlan = estado.paso;
    const datos = estado.datos;
    const texto = ctx.texto;

    if (vencido) {
        // Solo si contestó algo que parece respuesta; lo demás sigue su camino normal.
        if (esSiExplicito(texto, ctx.botonId) || esNoExplicito(texto, ctx.botonId)) {
            await d.enviar(TXT.vencida, 'plazos_vencida', null);
            return true;
        }
        return false;
    }
    if (ctx.botonId && ctx.botonId !== BOTON_PLAN.SI && ctx.botonId !== BOTON_PLAN.NO) return false;

    if (esNoExplicito(texto, ctx.botonId) || /^(cancelar|cancela|ya no|mejor no|olvidalo)\b/.test(normalizarFrase(texto))) {
        await d.enviar(TXT.cancelado, 'plazos_cancelado', null);
        return true;
    }

    const reintentar = async (): Promise<boolean> => {
        const intentos = Number(datos.intentos ?? 0) + 1;
        if (texto.includes('?') || unaFrase(texto) > 12) return false; // otra cosa: que la atienda el bot
        if (intentos >= 3) { await d.escalar('plazos_no_entendido', TXT.revisaEscuela); return true; }
        const base = paso === 'plazos_confirmar' ? 'Para crearlo necesito un *Sí* claro, o un *No* si prefieres no hacerlo.'
            : paso === 'plazos_cobros' ? 'Responde *todos* o el número del cobro (por ejemplo *1*).'
                : 'Dime cuántas cuotas (por ejemplo *2*) o las fechas (por ejemplo *el 15 y el 30*).';
        await d.enviar(`${TXT.noEntendi} ${base}`, paso, { paso, datos: { ...datos, intentos } },
            paso === 'plazos_confirmar' ? BOTONES_CONFIRMAR : undefined);
        return true;
    };

    if (paso === 'plazos_cobros') {
        const ops = (datos.opciones ?? []) as { id: string; saldo: number }[];
        const ids = elegidos(texto, ops);
        if (!ids) return reintentar();
        const topes = await d.puerto.topes(ctx.schoolId);
        if (!topes.habilitado) return false;
        const total = ops.filter((o) => ids.includes(o.id)).reduce((a, o) => a + o.saldo, 0);
        const leidos = (datos.leidos ?? {}) as PlazosLeidos;
        const base = { t0: datos.t0 };
        if (leidos.cuotas || leidos.fechas) return mostrarCalendario(ctx, d, base, ids, leidos);
        return pedirCuotas(ctx, d, base, ids, total, topes);
    }

    if (paso === 'plazos_cuotas') {
        const leidos = leerPlazos(texto, d.puerto.hoy());
        if (!leidos.cuotas && !leidos.fechas) return reintentar();
        return mostrarCalendario(ctx, d, datos, datos.ids as string[], leidos);
    }

    if (paso === 'plazos_confirmar') {
        if (!esSiExplicito(texto, ctx.botonId)) return reintentar();
        const ids = datos.ids as string[];
        const fechas = datos.fechas as string[];
        // Se vuelve a calcular con lo que hay AHORA: si el total cambió, se muestra de nuevo y se pide otro sí.
        const r = await d.puerto.proponer({ schoolId: ctx.schoolId, paymentIds: ids, cuotas: fechas.length, fechas });
        if (!r.ok) {
            if (r.error === 'cobro_no_elegible' || r.status === 400) {
                await d.enviar('Algo cambió en tus cobros o en las fechas mientras hablábamos, así que no creé nada. Escríbeme de nuevo *quiero pagar por plazos* y lo armamos otra vez.', 'plazos_cambio', null);
                return true;
            }
            await d.escalar(`plazos_error:${r.error}`, TXT.revisaEscuela);
            return true;
        }
        if (r.calendario.saldoTotal !== Number(datos.total)
            || r.calendario.cuotas.map((c) => c.monto).join(',') !== (datos.montos as number[]).join(',')) {
            return mostrarCalendario(ctx, d, { t0: datos.t0 }, ids, { cuotas: fechas.length, fechas });
        }
        let creado: Awaited<ReturnType<PuertoPlazos['solicitar']>>;
        try {
            creado = await d.puerto.solicitar({
                schoolId: ctx.schoolId, paymentIds: ids, payerProfileId: ctx.parentId,
                items: r.calendario.cuotas.map((c) => ({ due_date: c.fecha, amount: c.monto })),
            });
        } catch (e: any) {
            console.warn('[whatsapp-plazos] solicitar lanzó', { err: e?.message });
            await d.escalar('plazos_error:excepcion', TXT.revisaEscuela);
            return true;
        }
        if (!creado.ok) {
            await d.escalar(`plazos_error:${creado.error}`, TXT.revisaEscuela);
            return true;
        }
        const hoy = d.puerto.hoy();
        const a = creado.acuerdo;
        if (a.status === 'activo') {
            await d.enviar(
                `Listo ✅ Quedó activo tu pago por plazos: ${r.calendario.cuotas.length} ${r.calendario.cuotas.length === 1 ? 'pago' : 'cuotas'} por *${pesos(r.calendario.saldoTotal)}*, ` +
                `la primera el ${fechaLarga(r.calendario.primeraFecha, hoy)}. Te recordamos cada fecha y, cuando pagues, me envías el comprobante por aquí como siempre.`,
                'plazos_creado', null);
        } else {
            await d.enviar(
                'Listo, dejé tu solicitud de pago por plazos ✅ Como queda fuera de lo que la escuela aprueba directo, ella la revisa y te avisa por aquí. ' +
                'Mientras tanto, no cambia nada en tus cobros.',
                'plazos_solicitado', null);
        }
        return true;
    }
    return false;
}
