/**
 * whatsapp-plan-pausa-retiro — pausar/congelar, retirar y reactivar el plan por
 * WhatsApp, más «¿cómo van mis solicitudes?» y «cancela mi solicitud»
 * (oleada 2, F5 del spec campanas-descuento-referidos-y-plazos-por-whatsapp.md §6).
 *
 * Determinista, SIN modelo. Una sola cosa se crea por confirmación, y la
 * confirmación (un «Sí» EXPLÍCITO) vence a los 30 minutos. Nada se crea sin
 * identificación y nunca sobre inscripciones ajenas: las candidatas salen de las
 * inscripciones de la persona identificada en ESTA escuela y el servicio
 * (`retiro-y-pausa.service`) vuelve a comprobar la titularidad.
 *
 * Reglas duras:
 *   · El retiro NUNCA lo decide el bot ni da de baja: solo deja la solicitud; la
 *     revisa la escuela y no se cancela nada hasta que la aprueben. (`dar_de_baja`
 *     solo lo decide la administración al resolver.)
 *   · «Ya no puedo ir esta semana» es una ausencia (whatsapp-ausencias), no un retiro:
 *     si `detectaAusencia` lo reconoce, esto no arranca.
 *   · Ante cualquier error del servicio: «lo revisará la escuela» + buzón.
 *   · Con la función apagada (escuela sin `pause_enabled`) nada de esto responde y
 *     sigue el comportamiento de siempre (p. ej. `esSolicitudDeRetiro` → buzón).
 */

import { normalizarFrase } from './whatsapp-reglas-turno';
import { esSolicitudDeRetiro } from './whatsapp-escalaciones.service';
import { detectaAusencia } from './whatsapp-ausencias.service';
import {
    BOTON_PLAN, TXT, fechaLarga, mesLargo, mesesNombrados, rangoDeMeses, fechaDeSalida, mesSiguiente, primerDiaDelMes,
    anioDeMes, esSiExplicito, esNoExplicito, type EstadoPlan, type PasoPlan,
} from './whatsapp-plan-comun';
import type { EnviarPlan, EscalarPlan } from './whatsapp-plazos';
import type { BotonInteractivo } from './whatsapp.service';

// ─── Puerto ──────────────────────────────────────────────────────────────────

export interface InscripcionPlan {
    id: string;
    nombre: string;
    equipo: string | null;
    estado: 'activa' | 'en_pausa' | 'retirada';
}

export interface SolicitudMia {
    id: string;
    tipo: 'pausa' | 'retiro' | 'reactivacion';
    school_id: string;
    estado: 'solicitado' | 'aprobado' | 'rechazado' | 'cancelado';
    atleta_nombre: string | null;
    desde: string;
    hasta: string | null;
    creada_at: string | null;
}

export type ResultadoServicio = { ok: true; data: any } | { ok: false; status: number; error: string; code?: string };

export interface PuertoPlan {
    /** `school_settings.pause_enabled`: la escuela tiene prendida la gestión del plan. */
    habilitada(schoolId: string): Promise<boolean>;
    /** TODAS las inscripciones de la persona en la escuela (activas, en pausa, retiradas), una por deportista. */
    inscripciones(schoolId: string, parentId: string): Promise<InscripcionPlan[]>;
    pedirPausa(parentId: string, i: { enrollment_id: string; reason: 'injury' | 'vacation' | 'other'; month_from: string; month_to: string }): Promise<ResultadoServicio>;
    pedirRetiro(parentId: string, i: { enrollment_id: string; exit_date: string }): Promise<ResultadoServicio>;
    pedirReactivacion(parentId: string, i: { enrollment_id: string; from_month: string }): Promise<ResultadoServicio>;
    cancelar(parentId: string, tipo: 'pausa' | 'retiro' | 'reactivacion', id: string): Promise<ResultadoServicio>;
    mias(parentId: string): Promise<SolicitudMia[]>;
    hoy(): string;
    ahora(): number;
}

export interface CtxPlan {
    schoolId: string;
    parentId: string;
    texto: string;
    botonId: string | null;
}
interface Deps { puerto: PuertoPlan; enviar: EnviarPlan; escalar: EscalarPlan }

// ─── Detección (pura) ────────────────────────────────────────────────────────

export type IntencionPlan = 'pausa' | 'retiro' | 'reactivacion' | 'mis_solicitudes' | 'cancelar_solicitud' | 'ambigua';

const DE_PLATA = /\b(pago|pagos|pagar|pague|comprobante|transferencia|consignacion|factura|cobro|mensualidad|abono|nequi|daviplata)\b/;
/** «¿Cuánto cuesta el torneo de diciembre?» no es una pausa aunque nombre un mes y un viaje. */
const PREGUNTA_DE_PRECIO = /\b(cuanto|cuesta|cuestan|vale|valen|precio|precios|valor|costo|costos|tarifa)\b/;
const PAUSA: RegExp[] = [
    /\b(congelar|congelarlo|congelarla|congelarlos|congelamos|congelen|congele|congelemos|congelacion|congelamiento)\b/,
    /\b(pausar|pausarlo|pausarla|pausarlos|pausamos|pausen|pause|pausemos)\b (el|la|los|las|mi|mis|su|sus|a|al|nuestro|nuestra|plan|inscripcion|mensualidad|clases|entrenamientos)\b/,
    /\b(quiero|queremos|necesito|necesitamos|quisiera|quisieramos|podemos|puedo|vamos a|voy a) (pausar|congelar)\b/,
    /\bdejar (en pausa|congelad[oa]s?)\b/,
    /\b(hacer|hagamos|una|la) pausa (en|del|de|al) (plan|inscripcion|mensualidad|entrenamientos?|clases?)\b/,
    /\b(suspender|suspenderlo|suspenderla|suspendan|suspenda|suspendamos)\b.{0,30}\b(plan|inscripcion|mensualidad|clases|entrenamientos|cupo)\b/,
];
const VIAJE_O_NO_ASISTE = /\b(viaj\w*|vacaciones|fuera de (la ciudad|el pais|bogota|colombia)|de paseo|no (va|vamos|voy|van|estara|estaremos|estare) a (entrenar|asistir|ir|estar)|no (entrena|entrenara|asiste|asistira)|sin entrenar|no vamos a poder (entrenar|asistir|ir))\b/;
const REACTIVA: RegExp[] = [
    /\b(volver|regresar|retomar|reintegrar\w*|reincorporar\w*|reactivar\w*|reanudar)\b.{0,30}\b(entrenar|entrenamientos?|entreno|club|escuela|clases?|equipo|plan|inscripcion|matricula|cupo|practicar|jugar|grupo)\b/,
    /\b(quiero|queremos|quisiera|quisieramos|podemos|puedo|nos gustaria|me gustaria) (volver|regresar)\b/,
];
const MIS_SOLICITUDES: RegExp[] = [
    /\bmis solicitudes\b/,
    /\b(como va|en que va|que paso con|ya (aprobaron|aprobo|respondieron|revisaron|vieron|resolvieron)|estado de)\b.{0,30}\b(solicitud|pausa|retiro|congelamiento|reactivacion)\b/,
    /\b(aprobaron|aprobada|aprobado|rechazaron|respondieron)\b.{0,20}\b(la|mi|el) (pausa|solicitud|retiro)\b/,
    /\bmi solicitud\b.{0,40}\b(pausa|retiro|congel\w*|reactivacion|estado|aprob\w*|revis\w*)\b/,
];
const CANCELAR: RegExp[] = [
    /\b(cancel\w+|anul\w+|deshac\w+|retir\w+) (mi |la |esa |esta |el )?(solicitud|pedido)\b/,
    /\bya no (quiero|queremos) (retirar\w*|pausar\w*|congelar\w*)\b/,
    /\bmejor no (lo |la |los |las )?(retiro|retiramos|pausen|pausemos|pausar|congelen|congelemos|congelar|retirar)\b/,
    /\b(no|ya no) (quiero|queremos) que (lo|la|los|las) (retiren|pausen|congelen)\b/,
];

/**
 * ¿Qué quiere hacer con su plan? null si nada de esto. `hoy` se inyecta (ausencias).
 * No arranca si el mensaje es el aviso de una ausencia («ya no puedo ir esta semana»).
 */
export function intencionDePlan(texto: string | null | undefined, hoy: string): IntencionPlan | null {
    const n = normalizarFrase(texto);
    if (!n || n.length > 400) return null;
    if (CANCELAR.some((re) => re.test(n))) return 'cancelar_solicitud';
    if (MIS_SOLICITUDES.some((re) => re.test(n))) return 'mis_solicitudes';
    if (detectaAusencia(texto, hoy)) return null;
    if (REACTIVA.some((re) => re.test(n))) return 'reactivacion';

    const retiro = esSolicitudDeRetiro(texto);
    const pausaDirecta = PAUSA.some((re) => re.test(n));
    const pausaPorMes = !pausaDirecta && !DE_PLATA.test(n) && !PREGUNTA_DE_PRECIO.test(n) && VIAJE_O_NO_ASISTE.test(n)
        && mesesNombrados(n).length > 0 && !/\b(hoy|manana)\b/.test(n);
    const pausa = pausaDirecta || pausaPorMes;
    if (retiro && pausa) return 'ambigua';
    if (retiro) return 'retiro';
    if (pausa) return 'pausa';
    return null;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

const BOTONES_CONFIRMAR: BotonInteractivo[] = [
    { id: BOTON_PLAN.SI, title: 'Sí, confirmo' },
    { id: BOTON_PLAN.NO, title: 'No' },
];

const nombreDe = (i: { nombre: string; equipo: string | null }) => `${i.nombre || 'tu deportista'}${i.equipo ? ` (${i.equipo})` : ''}`;
const unaFrase = (t: string) => normalizarFrase(t).split(' ').filter(Boolean).length;

const ETIQUETA_TIPO = { pausa: 'pausa', retiro: 'retiro', reactivacion: 'reactivación' } as const;
const ESTADO_TXT: Record<SolicitudMia['estado'], string> = {
    solicitado: 'en revisión de la escuela',
    aprobado: 'aprobada',
    rechazado: 'no fue aprobada (si quieres, te paso con la escuela para que te explique)',
    cancelado: 'cancelada',
};

export function describirSolicitud(s: SolicitudMia, hoy: string): string {
    const quien = s.atleta_nombre ? ` de ${s.atleta_nombre}` : '';
    const cuando = s.tipo === 'pausa' && s.hasta
        ? (s.desde.slice(0, 7) === s.hasta.slice(0, 7) ? ` (${mesLargo(s.desde)})` : ` (de ${mesLargo(s.desde)} a ${mesLargo(s.hasta)})`)
        : s.tipo === 'retiro' ? ` (salida el ${fechaLarga(s.desde.slice(0, 10), hoy)})`
            : s.tipo === 'reactivacion' ? ` (desde ${mesLargo(s.desde)})` : '';
    return `${ETIQUETA_TIPO[s.tipo][0].toUpperCase()}${ETIQUETA_TIPO[s.tipo].slice(1)}${quien}${cuando}`;
}

/** Quién se nombra en el texto: coincide con un nombre de pila o apellido (≥ 3 letras). */
export function nombrados(texto: string, cands: InscripcionPlan[]): InscripcionPlan[] {
    const palabras = new Set(normalizarFrase(texto).split(' ').filter((w) => w.length >= 3));
    return cands.filter((c) => normalizarFrase(c.nombre).split(' ').some((w) => w.length >= 3 && palabras.has(w)));
}

function motivoDePausa(texto: string): 'injury' | 'vacation' | 'other' {
    const n = normalizarFrase(texto);
    if (/\b(lesion\w*|fractur\w*|esguince|cirugia|operacion|operar\w*|incapacidad|enferm\w*|recuper\w*)\b/.test(n)) return 'injury';
    if (/\b(viaj\w*|vacaciones|paseo|fuera de)\b/.test(n)) return 'vacation';
    return 'other';
}

// ─── Motor ───────────────────────────────────────────────────────────────────

type Tipo = 'pausa' | 'retiro' | 'reactivacion';

async function escalarError(d: Deps, motivo: string): Promise<true> {
    await d.escalar(motivo, TXT.revisaEscuela);
    return true;
}

function candidatasPara(tipo: Tipo, todas: InscripcionPlan[]): InscripcionPlan[] {
    return tipo === 'reactivacion'
        ? todas.filter((i) => i.estado === 'retirada' || i.estado === 'en_pausa')
        : todas.filter((i) => i.estado === 'activa');
}

async function preguntarInscripcion(d: Deps, tipo: Tipo, cands: InscripcionPlan[], datos: Record<string, any>): Promise<true> {
    const accion = tipo === 'pausa' ? 'pausar' : tipo === 'retiro' ? 'retirar' : 'reactivar';
    const lista = cands.map((c, i) => `${i + 1}. ${nombreDe(c)}`).join('\n');
    await d.enviar(
        `Te ayudo con eso 🙌 ¿A cuál inscripción quieres ${accion}?\n\n${lista}\n\nResponde con el número o el nombre. Una solicitud a la vez.`,
        'plan_inscripcion',
        { paso: 'plan_inscripcion', datos: { ...datos, tipo, opciones: cands.map((c) => ({ id: c.id, nombre: c.nombre, equipo: c.equipo })), intentos: 0 } });
    return true;
}

/** Con la inscripción ya elegida: lo que falta (meses / fecha) o el resumen para confirmar. */
async function conInscripcion(
    ctx: CtxPlan, d: Deps, tipo: Tipo, ins: { id: string; nombre: string; equipo: string | null }, datos: Record<string, any>, textoExtra: string,
): Promise<true> {
    const hoy = d.puerto.hoy();
    const base = { ...datos, tipo, enrollment_id: ins.id, nombre: ins.nombre, equipo: ins.equipo, intentos: 0 };
    const fuente = `${datos.texto0 ?? ''} ${textoExtra}`;

    if (tipo === 'pausa') {
        const r = rangoDeMeses(fuente, hoy);
        if (r.ok) return confirmarPausa(d, base, r.desde, r.hasta, r.meses, fuente);
        const aclara = r.motivo === 'no_contiguos'
            ? 'Veo meses que no van seguidos. Dime desde qué mes y hasta cuál (por ejemplo *de diciembre a febrero*).'
            : '¿Por cuántos meses y cuáles? Dime desde qué mes y hasta cuál (por ejemplo *diciembre y enero* o *de diciembre a febrero*). La pausa es por meses completos.';
        await d.enviar(aclara, 'plan_meses', { paso: 'plan_meses', datos: base });
        return true;
    }
    if (tipo === 'retiro') {
        const f = fechaDeSalida(fuente, hoy);
        if (f.ok) return confirmarRetiro(d, base, f.fecha, hoy);
        await d.enviar(
            `¿Desde qué fecha sería la salida de ${nombreDe(ins)}? Por ejemplo *30 de noviembre*, *fin de mes* o *1 de diciembre*.`,
            'plan_fecha', { paso: 'plan_fecha', datos: base });
        return true;
    }
    const desde = mesDeRegreso(fuente, hoy);
    if (desde) return confirmarReactivacion(d, base, desde);
    await d.enviar(`¿Desde qué mes quieres que ${ins.nombre || 'tu deportista'} vuelva? Por ejemplo *este mes*, *el próximo mes* o *enero*.`,
        'plan_meses', { paso: 'plan_meses', datos: base });
    return true;
}

function mesDeRegreso(texto: string, hoy: string): string | null {
    const n = normalizarFrase(texto);
    const nombres = mesesNombrados(n);
    if (nombres.length) return `${anioDeMes(nombres[0], hoy)}-${String(nombres[0]).padStart(2, '0')}-01`;
    if (/\b(proximo mes|mes que viene|mes siguiente)\b/.test(n)) return mesSiguiente(hoy);
    if (/\b(este mes|ya|ahora|de una|cuanto antes)\b/.test(n)) return primerDiaDelMes(hoy);
    return null;
}

async function confirmarPausa(d: Deps, base: Record<string, any>, desde: string, hasta: string, meses: number, fuente: string): Promise<true> {
    if (desde < primerDiaDelMes(d.puerto.hoy()) || meses > 12) {
        await d.enviar(
            desde < primerDiaDelMes(d.puerto.hoy())
                ? 'Ese mes ya pasó. La pausa puede empezar este mes o en uno de los próximos: dime los meses otra vez (por ejemplo *diciembre y enero*).'
                : 'La pausa puede ser de máximo 12 meses. Dime los meses otra vez.',
            'plan_meses', { paso: 'plan_meses', datos: { ...base, intentos: Number(base.intentos ?? 0) + 1 } });
        return true;
    }
    const cuando = meses === 1 ? mesLargo(desde) : `de ${mesLargo(desde)} a ${mesLargo(hasta)} (${meses} meses completos)`;
    await d.enviar(
        `Voy a pedir la *pausa* del plan de ${nombreDe(base as any)}: ${cuando}.\n\n` +
        'Si queda dentro de lo que la escuela aprueba directo, se aprueba al instante y esos meses no generan cobro; si no, la revisa la escuela y te avisa por aquí.\n\n' +
        '¿Confirmas que la cree? Responde *Sí* o *No*.',
        'plan_confirmar',
        { paso: 'plan_confirmar', datos: { ...base, desde, hasta, meses, motivo: motivoDePausa(fuente), t0: base.t0 ?? d.puerto.ahora(), intentos: 0 } },
        BOTONES_CONFIRMAR);
    return true;
}

async function confirmarRetiro(d: Deps, base: Record<string, any>, fecha: string, hoy: string): Promise<true> {
    await d.enviar(
        `Voy a dejar *solicitado* el retiro de ${nombreDe(base as any)} con fecha de salida el ${fechaLarga(fecha, hoy)}.\n\n` +
        'Ojo: esto es solo una *solicitud*. La revisa la escuela y no se cancela nada hasta que la aprueben; yo no doy de baja a nadie. ' +
        'Si prefieres pausar unos meses en vez de retirarte, dímelo.\n\n' +
        '¿Confirmas que deje la solicitud? Responde *Sí* o *No*.',
        'plan_confirmar',
        { paso: 'plan_confirmar', datos: { ...base, fecha, t0: base.t0 ?? d.puerto.ahora(), intentos: 0 } },
        BOTONES_CONFIRMAR);
    return true;
}

async function confirmarReactivacion(d: Deps, base: Record<string, any>, desde: string): Promise<true> {
    if (desde < primerDiaDelMes(d.puerto.hoy())) {
        await d.enviar('Ese mes ya pasó. Dime desde qué mes quieres volver: este mes, el próximo o uno de los siguientes.',
            'plan_meses', { paso: 'plan_meses', datos: { ...base, intentos: Number(base.intentos ?? 0) + 1 } });
        return true;
    }
    await d.enviar(
        `Voy a pedir la *reactivación* del plan de ${nombreDe(base as any)} desde ${mesLargo(desde)}.\n\n` +
        'La revisa la escuela y te avisa por aquí; los cobros de ese mes en adelante los genera la escuela cuando la apruebe.\n\n' +
        '¿Confirmas que la cree? Responde *Sí* o *No*.',
        'plan_confirmar',
        { paso: 'plan_confirmar', datos: { ...base, desde, t0: base.t0 ?? d.puerto.ahora(), intentos: 0 } },
        BOTONES_CONFIRMAR);
    return true;
}

/** Arranca el flujo. false = no es para acá (función apagada, sin inscripciones, etc.). */
export async function iniciarPlan(ctx: CtxPlan, d: Deps, intencion: IntencionPlan): Promise<boolean> {
    if (!(await d.puerto.habilitada(ctx.schoolId))) return false; // sin la función: comportamiento de siempre
    const hoy = d.puerto.hoy();
    const datos0 = { t0: d.puerto.ahora(), texto0: ctx.texto.slice(0, 300) };

    if (intencion === 'mis_solicitudes') {
        const mias = (await d.puerto.mias(ctx.parentId)).filter((s) => s.school_id === ctx.schoolId);
        const lista = mias.filter((s) => s.estado !== 'cancelado' || mias.length <= 3).slice(0, 5);
        if (!lista.length) {
            await d.enviar('No encuentro solicitudes de pausa, retiro ni reactivación a tu nombre en esta escuela.', 'plan_sin_solicitudes', null);
            return true;
        }
        const filas = lista.map((s) => `• ${describirSolicitud(s, hoy)}: ${ESTADO_TXT[s.estado]}.`).join('\n');
        await d.enviar(`Así van tus solicitudes:\n\n${filas}`, 'plan_mis_solicitudes', null);
        return true;
    }

    if (intencion === 'cancelar_solicitud') {
        let abiertas = (await d.puerto.mias(ctx.parentId)).filter((s) => s.school_id === ctx.schoolId && s.estado === 'solicitado');
        const n = normalizarFrase(ctx.texto);
        const tipoPedido: Tipo | null = /\b(retiro|retirar\w*)\b/.test(n) ? 'retiro' : /\b(pausa|pausar|congel\w*)\b/.test(n) ? 'pausa' : /\breactiv\w*\b/.test(n) ? 'reactivacion' : null;
        if (tipoPedido && abiertas.some((s) => s.tipo === tipoPedido)) abiertas = abiertas.filter((s) => s.tipo === tipoPedido);
        if (!abiertas.length) {
            await d.enviar('No veo solicitudes abiertas a tu nombre para cancelar. Las que ya aprobó la escuela las maneja ella: si quieres, te paso con alguien del equipo.', 'plan_sin_abiertas', null);
            return true;
        }
        if (abiertas.length === 1) return confirmarCancelacion(d, abiertas[0], hoy, datos0);
        const lista = abiertas.slice(0, 5).map((s, i) => `${i + 1}. ${describirSolicitud(s, hoy)}`).join('\n');
        await d.enviar(`Tienes estas solicitudes abiertas:\n\n${lista}\n\n¿Cuál quieres cancelar? Responde con el número.`,
            'plan_cancelar_elegir',
            { paso: 'plan_cancelar_confirmar', datos: { ...datos0, elegir: true, opciones: abiertas.slice(0, 5).map((s) => ({ id: s.id, tipo: s.tipo, desc: describirSolicitud(s, hoy) })), intentos: 0 } });
        return true;
    }

    const todas = await d.puerto.inscripciones(ctx.schoolId, ctx.parentId);

    if (intencion === 'ambigua') {
        await d.enviar('¿Quieres *congelar* el plan por unos meses (se retoma después) o *retirarte* del club? Escríbeme *congelar* o *retirar*.',
            'plan_tipo', { paso: 'plan_tipo', datos: { ...datos0, intentos: 0 } });
        return true;
    }

    const tipo = intencion as Tipo;
    const cands = candidatasPara(tipo, todas);
    if (!cands.length) return false; // nada que pausar/retirar/reactivar a su nombre: sigue el camino de siempre

    const nom = nombrados(ctx.texto, cands);
    if (nom.length > 1) {
        await d.enviar('Te ayudo con uno a la vez 🙌 ¿Con cuál empezamos?\n\n' + cands.map((c, i) => `${i + 1}. ${nombreDe(c)}`).join('\n') + '\n\nResponde con el número o el nombre.',
            'plan_inscripcion',
            { paso: 'plan_inscripcion', datos: { ...datos0, tipo, opciones: cands.map((c) => ({ id: c.id, nombre: c.nombre, equipo: c.equipo })), intentos: 0 } });
        return true;
    }
    if (nom.length === 1) return conInscripcion(ctx, d, tipo, nom[0], datos0, '');
    if (cands.length === 1) return conInscripcion(ctx, d, tipo, cands[0], datos0, '');
    return preguntarInscripcion(d, tipo, cands, datos0);
}

async function confirmarCancelacion(d: Deps, s: Pick<SolicitudMia, 'id' | 'tipo'> & { atleta_nombre?: string | null; desde?: string; hasta?: string | null; school_id?: string; estado?: any; creada_at?: any }, hoy: string, datos0: Record<string, any>): Promise<true> {
    const desc = describirSolicitud(s as SolicitudMia, hoy);
    await d.enviar(`¿Cancelo tu solicitud de ${desc}? Responde *Sí* o *No*.`, 'plan_cancelar_confirmar',
        { paso: 'plan_cancelar_confirmar', datos: { ...datos0, id: s.id, tipo: s.tipo, desc, t0: datos0.t0 ?? d.puerto.ahora(), intentos: 0 } },
        BOTONES_CONFIRMAR);
    return true;
}

function eligeNumero(texto: string, max: number): number | null {
    const n = normalizarFrase(texto);
    const m = /^(?:el |la |opcion |numero )?(\d{1,2})$/.exec(n);
    if (!m) return null;
    const k = Number(m[1]);
    return k >= 1 && k <= max ? k : null;
}

/** Continúa el flujo abierto. false = el mensaje no es respuesta (se suelta el flujo). */
export async function continuarPlan(ctx: CtxPlan, d: Deps, estado: EstadoPlan, vencido: boolean): Promise<boolean> {
    const paso: PasoPlan = estado.paso;
    const datos = estado.datos;
    const texto = ctx.texto;
    const hoy = d.puerto.hoy();

    if (vencido) {
        if (esSiExplicito(texto, ctx.botonId) || esNoExplicito(texto, ctx.botonId)) {
            await d.enviar(TXT.vencida, 'plan_vencida', null);
            return true;
        }
        return false;
    }
    if (ctx.botonId && ctx.botonId !== BOTON_PLAN.SI && ctx.botonId !== BOTON_PLAN.NO) return false;
    if (!(await d.puerto.habilitada(ctx.schoolId))) return false;

    if (esNoExplicito(texto, ctx.botonId) || /^(cancelar|cancela|mejor no|olvidalo)\b/.test(normalizarFrase(texto))) {
        await d.enviar(TXT.cancelado, 'plan_cancelado', null);
        return true;
    }

    const reintentar = async (pista: string): Promise<boolean> => {
        const intentos = Number(datos.intentos ?? 0) + 1;
        if (texto.includes('?') || unaFrase(texto) > 12) return false;
        if (intentos >= 3) return escalarError(d, 'plan_no_entendido');
        await d.enviar(`${TXT.noEntendi} ${pista}`, paso, { paso, datos: { ...datos, intentos } },
            paso === 'plan_confirmar' || (paso === 'plan_cancelar_confirmar' && !datos.elegir) ? BOTONES_CONFIRMAR : undefined);
        return true;
    };

    if (paso === 'plan_tipo') {
        const n = normalizarFrase(texto);
        const tipo: Tipo | null = /\b(congel\w*|paus\w*)\b/.test(n) ? 'pausa' : /\b(retir\w*)\b/.test(n) ? 'retiro' : null;
        if (!tipo) return reintentar('Escríbeme *congelar* o *retirar*.');
        const cands = candidatasPara(tipo, await d.puerto.inscripciones(ctx.schoolId, ctx.parentId));
        if (!cands.length) return false;
        const nom = nombrados(`${datos.texto0 ?? ''} ${texto}`, cands);
        if (nom.length === 1) return conInscripcion(ctx, d, tipo, nom[0], datos, texto);
        if (cands.length === 1 && nom.length === 0) return conInscripcion(ctx, d, tipo, cands[0], datos, texto);
        return preguntarInscripcion(d, tipo, cands, datos);
    }

    if (paso === 'plan_inscripcion') {
        const ops = (datos.opciones ?? []) as { id: string; nombre: string; equipo: string | null }[];
        const k = eligeNumero(texto, ops.length);
        let elegida = k ? ops[k - 1] : undefined;
        if (!elegida) {
            const por = nombrados(texto, ops.map((o) => ({ ...o, estado: 'activa' as const })));
            if (por.length === 1) elegida = ops.find((o) => o.id === por[0].id);
            else if (por.length > 1) return reintentar('Una solicitud a la vez: dime cuál primero, con el número o el nombre.');
        }
        if (!elegida) return reintentar('Responde con el número o el nombre de la inscripción.');
        // Se vuelve a comprobar que sigue siendo suya (y de esta escuela) antes de seguir.
        const vigentes = candidatasPara(datos.tipo as Tipo, await d.puerto.inscripciones(ctx.schoolId, ctx.parentId));
        if (!vigentes.some((v) => v.id === elegida!.id)) {
            await d.enviar('Esa inscripción ya no aparece disponible para esto. Escríbeme de nuevo qué necesitas y lo revisamos.', 'plan_cambio', null);
            return true;
        }
        return conInscripcion(ctx, d, datos.tipo as Tipo, elegida, datos, '');
    }

    if (paso === 'plan_meses') {
        const tipo = datos.tipo as Tipo;
        const ins = { id: datos.enrollment_id as string, nombre: String(datos.nombre ?? ''), equipo: (datos.equipo ?? null) as string | null };
        if (tipo === 'pausa') {
            const n = normalizarFrase(texto);
            const unico = /\beste mes\b/.test(n) ? primerDiaDelMes(hoy) : /\b(proximo mes|mes que viene)\b/.test(n) ? mesSiguiente(hoy) : null;
            if (unico) return confirmarPausa(d, { ...datos, intentos: 0 }, unico, unico, 1, `${datos.texto0 ?? ''} ${texto}`);
            const r = rangoDeMeses(texto, hoy);
            if (!r.ok) return reintentar(r.motivo === 'no_contiguos'
                ? 'Los meses deben ir seguidos: dime desde cuál y hasta cuál (por ejemplo *de diciembre a febrero*).'
                : 'Dime los meses, por ejemplo *diciembre y enero* o *de diciembre a febrero*.');
            return confirmarPausa(d, { ...datos, intentos: 0 }, r.desde, r.hasta, r.meses, `${datos.texto0 ?? ''} ${texto}`);
        }
        if (tipo === 'reactivacion') {
            const desde = mesDeRegreso(texto, hoy);
            if (!desde) return reintentar('Dime el mes, por ejemplo *este mes*, *el próximo mes* o *enero*.');
            return confirmarReactivacion(d, { ...datos, enrollment_id: ins.id, intentos: 0 }, desde);
        }
        return false;
    }

    if (paso === 'plan_fecha') {
        const f = fechaDeSalida(texto, hoy);
        if (!f.ok) return reintentar(f.motivo === 'pasada'
            ? 'Esa fecha ya pasó. Dime una fecha desde hoy, por ejemplo *30 de noviembre* o *fin de mes*.'
            : 'Dime la fecha de salida, por ejemplo *30 de noviembre*, *fin de mes* o *1 de diciembre*.');
        return confirmarRetiro(d, { ...datos, intentos: 0 }, f.fecha, hoy);
    }

    if (paso === 'plan_cancelar_confirmar' && datos.elegir) {
        const ops = (datos.opciones ?? []) as { id: string; tipo: Tipo; desc: string }[];
        const k = eligeNumero(texto, ops.length);
        if (!k) return reintentar('Responde con el número de la solicitud.');
        const s = ops[k - 1];
        await d.enviar(`¿Cancelo tu solicitud de ${s.desc}? Responde *Sí* o *No*.`, 'plan_cancelar_confirmar',
            { paso: 'plan_cancelar_confirmar', datos: { t0: datos.t0, id: s.id, tipo: s.tipo, desc: s.desc, intentos: 0 } }, BOTONES_CONFIRMAR);
        return true;
    }

    if (paso === 'plan_cancelar_confirmar') {
        if (!esSiExplicito(texto, ctx.botonId)) return reintentar('Para cancelarla necesito un *Sí* claro, o un *No* si la dejas como está.');
        // Solo se puede cancelar lo que sigue abierto y es suyo.
        const abiertas = (await d.puerto.mias(ctx.parentId)).filter((s) => s.school_id === ctx.schoolId && s.estado === 'solicitado');
        if (!abiertas.some((s) => s.id === datos.id && s.tipo === datos.tipo)) {
            await d.enviar('Esa solicitud ya no está abierta, así que no hice nada.', 'plan_cambio', null);
            return true;
        }
        let r: ResultadoServicio;
        try { r = await d.puerto.cancelar(ctx.parentId, datos.tipo as Tipo, datos.id as string); }
        catch (e: any) { console.warn('[whatsapp-plan] cancelar lanzó', { err: e?.message }); return escalarError(d, 'plan_cancelar_error:excepcion'); }
        if (!r.ok) return escalarError(d, `plan_cancelar_error:${r.code ?? r.status}`);
        await d.enviar('Listo, cancelé tu solicitud ✅ Si más adelante quieres retomarla, me escribes por aquí.', 'plan_cancelada', null);
        return true;
    }

    if (paso === 'plan_confirmar') {
        if (!esSiExplicito(texto, ctx.botonId)) return reintentar('Para crearla necesito un *Sí* claro, o un *No* si prefieres no hacerlo.');
        const tipo = datos.tipo as Tipo;
        // Vuelve a comprobar que la inscripción sigue siendo suya y del estado que toca.
        const vigentes = candidatasPara(tipo, await d.puerto.inscripciones(ctx.schoolId, ctx.parentId));
        if (!vigentes.some((v) => v.id === datos.enrollment_id)) {
            await d.enviar('Esa inscripción cambió mientras hablábamos, así que no creé nada. Escríbeme de nuevo qué necesitas y lo revisamos.', 'plan_cambio', null);
            return true;
        }
        let r: ResultadoServicio;
        try {
            r = tipo === 'pausa'
                ? await d.puerto.pedirPausa(ctx.parentId, { enrollment_id: datos.enrollment_id, reason: datos.motivo ?? 'other', month_from: datos.desde, month_to: datos.hasta })
                : tipo === 'retiro'
                    ? await d.puerto.pedirRetiro(ctx.parentId, { enrollment_id: datos.enrollment_id, exit_date: datos.fecha })
                    : await d.puerto.pedirReactivacion(ctx.parentId, { enrollment_id: datos.enrollment_id, from_month: datos.desde });
        } catch (e: any) {
            console.warn('[whatsapp-plan] crear lanzó', { tipo, err: e?.message });
            return escalarError(d, `plan_${tipo}_error:excepcion`);
        }
        if (!r.ok) return escalarError(d, `plan_${tipo}_error:${r.code ?? r.status}`);

        const quien = nombreDe({ nombre: String(datos.nombre ?? ''), equipo: (datos.equipo ?? null) as string | null });
        if (tipo === 'pausa') {
            const cuando = Number(datos.meses) === 1 ? mesLargo(datos.desde) : `de ${mesLargo(datos.desde)} a ${mesLargo(datos.hasta)}`;
            if (r.data?.status === 'approved') {
                await d.enviar(`Listo ✅ La pausa de ${quien} quedó *aprobada* (${cuando}). Esos meses no generan cobro. Cuando quiera volver, me avisas por aquí.`, 'plan_pausa_aprobada', null);
            } else {
                const porque = r.data?.fuera_de_tope
                    ? 'supera los meses de pausa que la escuela aprueba directo'
                    : 'la escuela revisa cada pausa';
                await d.enviar(`Listo, dejé tu solicitud de pausa de ${quien} (${cuando}) ✅ Queda *en revisión*: ${porque}. Te avisa por aquí cuando la resuelva; mientras tanto no cambia nada.`, 'plan_pausa_pendiente', null);
            }
        } else if (tipo === 'retiro') {
            await d.enviar(`Listo, dejé tu *solicitud* de retiro de ${quien} con salida el ${fechaLarga(datos.fecha, hoy)} ✅ La revisa la escuela y te avisa por aquí. No se cancela nada hasta que la aprueben: mientras tanto el plan sigue como está.`, 'plan_retiro_solicitado', null);
        } else {
            await d.enviar(`Listo, dejé tu solicitud de reactivación de ${quien} desde ${mesLargo(datos.desde)} ✅ La revisa la escuela y te avisa por aquí.`, 'plan_reactivacion_solicitada', null);
        }
        return true;
    }
    return false;
}
