/**
 * whatsapp-soportes-bot — soportes del deportista por WhatsApp (spec
 * docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6b; contrato en
 * docs/contratos-api-oleada-1-2026-11-06.md §4). SOLO escuelas con `require_athlete_documents` (hoy Monster):
 * apagado, nada de esto corre (una lectura de la configuración, en caché 60 s) y el adjunto sigue su camino
 * de siempre hacia la cola de comprobantes.
 *
 * Flujo (sin modelo, determinista; el estado viaja en el payload del último saliente, `flujo: 'soporte'`):
 *   1. Llega una foto o un PDF de una persona IDENTIFICADA (acudiente o adulto con cuenta) o de una ficha SIN
 *      cuenta reconocida por teléfono, y la escuela exige soportes que a esa persona le faltan.
 *   2. ¿Soporte o comprobante de pago? Palabras de pago (en el pie o en lo reciente de la charla) = comprobante:
 *      el adjunto sigue a la cola SIN que el bot diga nada. Palabras de soporte = soporte. Ante la duda, UNA
 *      pregunta con dos botones («¿es un soporte de la ficha o un comprobante de pago?»); si dice comprobante, el
 *      adjunto se encola como siempre.
 *   3. ¿De qué deportista? (solo si hay varios con faltantes) → ¿de cuál soporte? (solo entre los que faltan) →
 *      confirmación → `guardarSoporte`. Nunca guarda para un deportista que no sea de esa persona: la lista de
 *      candidatos se vuelve a derivar de la base al elegir y al guardar (`esFamiliaDelSujeto`, o el teléfono de la
 *      ficha sin cuenta); lo que viaja en el payload es solo una pista, nunca una autorización.
 *
 * No toca el flujo de comprobantes de pago. Textos en español, tuteando, sin lenguaje de cobro ni de mora.
 *
 * Recordatorios por WhatsApp a las fichas SIN cuenta (las que el job de notificaciones no alcanza): ver
 * `enviarRecordatoriosDeSoportes` más abajo (tope en la base: cada 4 días, máximo 6).
 */
import { supabase } from '../config/supabase';
import {
    configDeEscuela, estadoInterno, guardarSoporte, esFamiliaDelSujeto, ETIQUETAS_SOPORTE, MAX_BYTES_SOPORTE,
    MIMES_SOPORTE, AVISO_CADA_DIAS, AVISO_MAXIMO, esTipoSoporte,
    type FilaEstado, type Sujeto, type GuardarSoporteParams, type GuardarSoporteResultado, type TipoSoporte,
} from './soportes.service';
import { fichasPorTelefono, type LlavesDeFicha } from './whatsapp-comprobante-de-ficha.service';
import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import { downloadMedia, type BotonInteractivo, type WhatsAppIntegration } from './whatsapp.service';

// ─── Constantes ──────────────────────────────────────────────────────────────

export const FLUJO_SOPORTE = 'soporte';
export const PASO_SOPORTE = {
    AMBIGUO: 'soporte_aclarar',
    DEPORTISTA: 'soporte_deportista',
    TIPO: 'soporte_tipo',
    CONFIRMAR: 'soporte_confirmar',
    GUARDADO: 'soporte_guardado',
    CANCELADO: 'soporte_cancelado',
} as const;
export const BOTON_SOPORTE = {
    ES_SOPORTE: 'sm_sp_soporte',
    ES_PAGO: 'sm_sp_pago',
    OPCION: 'sm_sp_o_',
    SI: 'sm_sp_si',
    OTRO: 'sm_sp_otro',
    NO: 'sm_sp_no',
} as const;
/** El estado de una pregunta abierta caduca a las 3 h. */
export const SOPORTE_VIGENCIA_HORAS = 3;
const MAX_REINTENTOS = 2;

type Etapa = 'ambiguo' | 'deportista' | 'tipo' | 'confirmar';

export interface AdjuntoPendiente {
    waMessageId: string;
    mediaId: string;
    mime: string;
    type: 'image' | 'document';
    caption?: string | null;
}
interface OpcionGuardada { tipo?: Sujeto['tipo']; id?: string; nombre?: string; soporte?: TipoSoporte }
export interface EstadoSoporte {
    etapa: Etapa;
    adjunto: AdjuntoPendiente;
    sujeto?: { tipo: Sujeto['tipo']; id: string; nombre: string };
    soporte?: TipoSoporte;
    opciones?: OpcionGuardada[];
    intentos?: number;
}

// ─── Reglas puras ────────────────────────────────────────────────────────────

const PALABRAS_DE_PAGO = /\b(pago|pagos|pague|pagado|pagar|comprobante|consignacion|consigne|transferencia|transferi|nequi|daviplata|bancolombia|breb|mensualidad|abono|recibo|cuota|torneo|inscripcion)\b/;
const PALABRAS_DE_SOPORTE = /\b(soporte|soportes|eps|certificado|cedula|documento|tarjeta de identidad|registro civil|firma|paz y salvo|foto del|ficha)\b/;
/** Pasos del bot que indican que la charla viene de dinero (el adjunto casi seguro es un comprobante). */
const PASO_DE_DINERO = /(pago|cobro|comprobante|ask_deportista|medios|mensualidad|estado_de_cuenta|resumen|abono|saldo|cortesia_pago|embudo_esperando_pago)/;

/** Pie del adjunto o charla reciente: 'pago' | 'soporte' | 'duda'. Pura. */
export function clasificarAdjunto(
    caption: string | null | undefined,
    recientes: readonly FilaReciente[],
    ahora = Date.now(),
): 'pago' | 'soporte' | 'duda' {
    const c = normalizarFrase(caption);
    const hayPago = PALABRAS_DE_PAGO.test(c);
    const haySoporte = PALABRAS_DE_SOPORTE.test(c);
    if (hayPago && !haySoporte) return 'pago';
    if (haySoporte && !hayPago) return 'soporte';
    if (hayPago && haySoporte) return 'duda';
    // Sin pie: la charla de la última hora. Si venía de dinero (lo que dijo ella o lo que preguntó el bot), es pago.
    const desde = ahora - 60 * 60_000;
    const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
    for (const f of recientes) {
        if (momento(f) < desde) continue;
        if (f.direction === 'inbound' && PALABRAS_DE_PAGO.test(normalizarFrase(f.text_body))) return 'pago';
        if (f.direction === 'outbound' && PASO_DE_DINERO.test(String(f.payload?.step ?? ''))) return 'pago';
    }
    return 'duda';
}

const SINONIMOS: [TipoSoporte, RegExp][] = [
    ['good_standing_certificate', /\bpaz y salvo\b/],
    ['eps_certificate', /\beps\b|\bafiliacion\b|certificado (de )?(la )?(eps|salud)/],
    ['guardian_signature', /firma.*\b(acudiente|mama|papa|padre|madre)\b|\b(acudiente|mama|papa|padre|madre)\b.*firma/],
    ['athlete_signature', /firma.*\b(deportista|hij[oa]|atleta|nin[oa])\b|\b(deportista|hij[oa]|atleta)\b.*firma/],
    ['guardian_id_front', /\b(cedula|documento|cc)\b.*\b(acudiente|mama|papa|padre|madre)\b|\b(acudiente|mama|papa|padre|madre)\b.*\b(cedula|documento)\b/],
    ['athlete_id_front', /\b(tarjeta de identidad|registro civil|ti|cedula|documento)\b.*\b(deportista|hij[oa]|atleta|nin[oa])\b|\b(deportista|hij[oa]|atleta)\b.*\b(documento|cedula|tarjeta de identidad)\b/],
    ['athlete_photo', /\bfoto\b|\bfotografia\b|\bselfie\b/],
];

/** El soporte que dice el texto, SOLO entre los que faltan y solo si es uno. Pura. */
export function soporteDeTexto(texto: string | null | undefined, faltan: readonly string[]): TipoSoporte | null {
    const t = normalizarFrase(texto);
    if (!t) return null;
    const posibles = SINONIMOS.filter(([tipo, re]) => faltan.includes(tipo) && re.test(t)).map(([tipo]) => tipo);
    return posibles.length === 1 ? posibles[0] : null;
}

/** Elige UNA opción de una lista por número o nombre (único). Pura. */
export function elegirOpcion<T extends { nombre?: string; etiqueta?: string }>(
    texto: string | null | undefined,
    botonId: string | null | undefined,
    opciones: readonly T[],
): T | null {
    if (botonId && botonId.startsWith(BOTON_SOPORTE.OPCION)) {
        const i = Number(botonId.slice(BOTON_SOPORTE.OPCION.length));
        return Number.isInteger(i) && i >= 0 && i < opciones.length ? opciones[i] : null;
    }
    const t = normalizarFrase(texto);
    if (!t) return null;
    const n = t.match(/^(?:la |el |opcion |numero )?(\d{1,2})$/);
    if (n) {
        const i = Number(n[1]) - 1;
        return i >= 0 && i < opciones.length ? opciones[i] : null;
    }
    const nombre = (o: T) => normalizarFrase(o.nombre ?? o.etiqueta ?? '');
    const exactas = opciones.filter((o) => nombre(o) === t);
    if (exactas.length === 1) return exactas[0];
    const contiene = opciones.filter((o) => {
        const nm = nombre(o);
        if (!nm) return false;
        if (nm.includes(t) && t.length >= 3) return true;
        // «el de Sara»: alguna palabra del texto (≥ 3 letras) es el primer nombre.
        return t.split(' ').some((w) => w.length >= 3 && nm.split(' ').includes(w));
    });
    return contiene.length === 1 ? contiene[0] : null;
}

const esNegativa = (t: string) => /^(no|nop|cancelar|cancela|cancelalo|olvidalo|dejalo|ninguno|no gracias|despues)$/.test(t);
const esAfirmativa = (t: string) => /^(si|sii|sí|claro|ok|okey|dale|listo|confirmo|confirmar|guardar|guardalo|correcto|de una|si guardar)$/.test(t);

const lista = (items: string[]) => items.map((x) => `• ${x}`).join('\n');
const etiqueta = (t: string) => ETIQUETAS_SOPORTE[t as TipoSoporte] ?? t;

/** Los textos del flujo, puros y verificables (ninguno habla de cobro ni de mora). */
export const TEXTOS_SOPORTE = {
    aclarar: '¡Gracias! 📎 ¿Es un *soporte de la ficha* (documento, foto, firma, certificado) o un *comprobante de pago*?',
    comprobanteSigue: 'Listo, lo reviso como comprobante de pago. 🙌',
    deportista: (opciones: string[]) => `Recibí tu archivo 📎 ¿De qué deportista es?\n\n${opciones.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nResponde con el número o el nombre.`,
    tipo: (nombre: string, faltan: string[]) =>
        `¿De cuál soporte de *${nombre}* es?\n\n${faltan.map((t, i) => `${i + 1}. ${etiqueta(t)}`).join('\n')}\n\nResponde con el número o el nombre.`,
    confirmar: (nombre: string, tipo: string) => `Voy a guardar *${etiqueta(tipo)}* en la ficha de *${nombre}*. ¿Confirmas?`,
    noEntendi: 'No te entendí del todo 🙏 Responde con el número de la lista, o escribe *cancelar* si no quieres guardarlo.',
    cancelado: 'Listo, no lo guardé. Cuando quieras me lo vuelves a enviar. 👍',
    expiro: 'Se me venció la conversación de ese archivo 🙏 ¿Me lo envías de nuevo para guardarlo?',
    guardado: (nombre: string, tipo: string, faltan: string[]) =>
        faltan.length === 0
            ? `¡Listo! ✅ Guardé *${etiqueta(tipo)}* en la ficha de *${nombre}*. Ya están completos todos los soportes de ${nombre}. 🙌`
            : `Listo ✅ Guardé *${etiqueta(tipo)}* en la ficha de *${nombre}*.\n\nAún le faltan ${faltan.length}:\n${lista(faltan.map(etiqueta))}\n\nPuedes seguir enviándolos por aquí.`,
    grande: 'Ese archivo pesa demasiado (máximo 4 MB) 🙏 ¿Me lo envías más liviano?',
    formato: 'Ese formato no me sirve para este soporte 🙏 Mándalo como *foto* (JPG o PNG) o *PDF*. Las fotos y las firmas van como imagen.',
    falla: 'No pude guardarlo en este momento 🙏 Inténtalo de nuevo en unos minutos o pásalo directamente a la escuela.',
    sinArchivo: 'No pude abrir ese archivo 🙏 ¿Me lo envías de nuevo?',
    ya: 'Ese deportista ya tiene todos sus soportes completos. ✅',
} as const;

// ─── Estado en el payload del último saliente ───────────────────────────────

/** Las filas recientes, ya cargadas o por cargar (solo se leen si hace falta). */
export type Recientes = readonly FilaReciente[] | (() => Promise<readonly FilaReciente[]>);
export const cargar = async (r: Recientes): Promise<readonly FilaReciente[]> => (typeof r === 'function' ? r() : r);

const momentoDe = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/**
 * La pregunta abierta: el ÚLTIMO saliente de la conversación (bot o persona) es de este flujo y es reciente.
 * Si el bot o una persona de la escuela habló después, ya no hay nada pendiente. Pura.
 */
export function estadoPendiente(recientes: readonly FilaReciente[], ahora = Date.now()): EstadoSoporte | null {
    const ultimo = [...recientes].filter((f) => f.direction === 'outbound')
        .sort((a, b) => momentoDe(b) - momentoDe(a))[0];
    if (!ultimo || ultimo.payload?.flujo !== FLUJO_SOPORTE || !ultimo.payload?.soporte) return null;
    if (ahora - momentoDe(ultimo) > SOPORTE_VIGENCIA_HORAS * 3600_000) return null;
    const s = ultimo.payload.soporte as EstadoSoporte;
    return s?.etapa && s?.adjunto?.mediaId ? s : null;
}

// ─── Dependencias (inyectables en pruebas) ───────────────────────────────────

export type ResultadoDescarga = { ok: true; buffer: Buffer; mimeType: string } | { ok: false; error: string };

export interface DepsSoportes {
    config: (schoolId: string) => Promise<{ activo: boolean; requeridos: string[] }>;
    estado: (schoolId: string) => Promise<FilaEstado[]>;
    fichas: (schoolId: string, waId: string) => Promise<LlavesDeFicha>;
    esFamilia: (userId: string, s: Sujeto) => Promise<boolean>;
    descargar: (integration: WhatsAppIntegration, mediaId: string) => Promise<ResultadoDescarga>;
    guardar: (p: GuardarSoporteParams) => Promise<GuardarSoporteResultado>;
    /** ¿Quién es? Perfil identificado de la conversación y si el bot puede atenderla. */
    contacto: (integration: WhatsAppIntegration, conversationId: string, waId: string) =>
        Promise<{ atiende: boolean; parentId: string | null }>;
    /** Vuelve a mandar el adjunto a la cola de comprobantes (cuando dijo que era un pago). */
    encolar: (integration: WhatsAppIntegration, a: AdjuntoPendiente, waId: string) => Promise<void>;
}

const cacheConfig = new Map<string, { hasta: number; activo: boolean }>();
/** Vacía el caché de configuración (pruebas). */
export function limpiarCacheSoportes(): void { cacheConfig.clear(); }

export const DEPS_SOPORTES: DepsSoportes = {
    async config(schoolId) {
        const c = cacheConfig.get(schoolId);
        if (c && c.hasta > Date.now()) return { activo: c.activo, requeridos: [] };
        let activo = false;
        let requeridos: string[] = [];
        try {
            const r = await configDeEscuela(schoolId);
            activo = r.activo; requeridos = r.requeridos;
        } catch { /* sin dato: apagado, el adjunto sigue su camino */ }
        cacheConfig.set(schoolId, { hasta: Date.now() + 60_000, activo });
        return { activo, requeridos };
    },
    estado: (schoolId) => estadoInterno(schoolId),
    fichas: (schoolId, waId) => fichasPorTelefono(schoolId, waId),
    esFamilia: (userId, s) => esFamiliaDelSujeto(userId, s),
    async descargar(integration, mediaId) {
        const r = await downloadMedia(integration, mediaId, {
            mimes: new Set<string>(MIMES_SOPORTE), maxBytes: MAX_BYTES_SOPORTE,
        });
        return r.ok && r.buffer && r.mimeType
            ? { ok: true, buffer: r.buffer, mimeType: r.mimeType }
            : { ok: false, error: r.error ?? 'descarga_sin_archivo' };
    },
    guardar: (p) => guardarSoporte(p),
    async contacto(integration, conversationId, waId) {
        const { debeAtender } = await import('./whatsapp-atencion.service');
        const d = await debeAtender(integration, conversationId, waId);
        const familia = d.botEncendido && !d.tomada && (d.tipo === 'familia' || d.tipo === 'familia_sin_cuenta');
        if (!familia) return { atiende: false, parentId: null };
        const { data } = await supabase.from('whatsapp_conversations')
            .select('parent_id, identified').eq('id', conversationId).maybeSingle();
        const c = data as { parent_id?: string | null; identified?: boolean } | null;
        return { atiende: true, parentId: c?.identified && c?.parent_id ? c.parent_id : null };
    },
    async encolar(integration, a, waId) {
        const { encolarAdjunto } = await import('./whatsapp-queue.service');
        await encolarAdjunto(integration, {
            phoneNumberId: '', contactWaId: waId, contactName: null, waMessageId: a.waMessageId, type: a.type,
            textBody: null, waTimestamp: new Date().toISOString(), mediaId: a.mediaId, mediaMimeType: a.mime,
            mediaCaption: a.caption ?? null, raw: {},
        });
    },
};

// ─── Contexto de un turno ────────────────────────────────────────────────────

export interface CtxSoportes {
    integration: WhatsAppIntegration;
    conversationId: string;
    contactWaId: string;
    /** Envía por `deliver` (el bot). `context` va al payload del saliente. */
    enviar: (texto: string, context: Record<string, unknown>, botones?: BotonInteractivo[]) => Promise<void>;
}

/** Los deportistas de ESTA persona con soportes por cargar. Se deriva de la base cada vez. */
export async function candidatosDeLaPersona(
    ctx: Pick<CtxSoportes, 'integration' | 'contactWaId'>,
    parentId: string | null,
    deps: DepsSoportes,
): Promise<FilaEstado[]> {
    const filas = (await deps.estado(ctx.integration.school_id)).filter((f) => !f.complete && f.missing.length > 0);
    if (parentId) {
        const suyas = filas.filter((f) => f.notify_profile_id === parentId);
        const out: FilaEstado[] = [];
        for (const f of suyas) {
            // Doble candado: la fila dice que su cuenta es la que se notifica Y el vínculo familiar lo confirma.
            if (await deps.esFamilia(parentId, { tipo: f.subject_type, id: f.subject_id })) out.push(f);
        }
        return out;
    }
    const llaves = await deps.fichas(ctx.integration.school_id, ctx.contactWaId);
    const ids = new Set([...llaves.childIds, ...llaves.unregisteredIds]);
    return filas.filter((f) => f.subject_type !== 'profile' && ids.has(f.subject_id));
}

const botonesDeOpciones = (titulos: string[]): BotonInteractivo[] =>
    titulos.map((t, i) => ({ id: `${BOTON_SOPORTE.OPCION}${i}`, title: t.slice(0, 24) }));

function contextoDe(paso: string, soporte: EstadoSoporte): Record<string, unknown> {
    return { step: paso, flujo: FLUJO_SOPORTE, soporte };
}

// ─── Entrada 1: llega un adjunto ─────────────────────────────────────────────

export interface AdjuntoEntrante {
    type: string;
    waMessageId: string;
    mediaId: string | null;
    mediaMimeType: string | null;
    mediaCaption: string | null;
}

/**
 * Hook del webhook, ANTES de encolar el adjunto como comprobante. true = el bot se hizo cargo (el adjunto
 * NO se encola); false = sigue el camino de siempre (comprobante). Nunca lanza.
 */
export async function atenderAdjuntoDeSoporte(
    ctx: CtxSoportes,
    msg: AdjuntoEntrante,
    recientes: Recientes,
    deps: DepsSoportes = DEPS_SOPORTES,
): Promise<boolean> {
    try {
        if ((msg.type !== 'image' && msg.type !== 'document') || !msg.mediaId) return false;
        const mime = (msg.mediaMimeType ?? '').split(';')[0].trim().toLowerCase();
        if (!(MIMES_SOPORTE as readonly string[]).includes(mime)) return false;
        const { activo } = await deps.config(ctx.integration.school_id);
        if (!activo) return false;

        const { atiende, parentId } = await deps.contacto(ctx.integration, ctx.conversationId, ctx.contactWaId);
        if (!atiende) return false;
        const candidatos = await candidatosDeLaPersona(ctx, parentId, deps);
        if (candidatos.length === 0) return false; // nada que cargar: es un comprobante, como siempre

        const clase = clasificarAdjunto(msg.mediaCaption, await cargar(recientes));
        if (clase === 'pago') return false;

        const adjunto: AdjuntoPendiente = {
            waMessageId: msg.waMessageId, mediaId: msg.mediaId, mime, type: msg.type as 'image' | 'document',
            caption: msg.mediaCaption,
        };
        if (clase === 'duda') {
            await ctx.enviar(TEXTOS_SOPORTE.aclarar,
                contextoDe(PASO_SOPORTE.AMBIGUO, { etapa: 'ambiguo', adjunto }),
                [{ id: BOTON_SOPORTE.ES_SOPORTE, title: 'Soporte de la ficha' }, { id: BOTON_SOPORTE.ES_PAGO, title: 'Comprobante de pago' }]);
            return true;
        }
        await preguntarDeportistaOTipo(ctx, adjunto, candidatos);
        return true;
    } catch (e: any) {
        console.warn('[whatsapp-soportes] el adjunto no se pudo atender como soporte; sigue como comprobante', { err: e?.message });
        return false;
    }
}

async function preguntarDeportistaOTipo(ctx: CtxSoportes, adjunto: AdjuntoPendiente, candidatos: FilaEstado[]): Promise<void> {
    if (candidatos.length > 1) {
        const opciones: OpcionGuardada[] = candidatos.map((c) => ({ tipo: c.subject_type, id: c.subject_id, nombre: c.full_name }));
        await ctx.enviar(TEXTOS_SOPORTE.deportista(opciones.map((o) => o.nombre!)),
            contextoDe(PASO_SOPORTE.DEPORTISTA, { etapa: 'deportista', adjunto, opciones }),
            botonesDeOpciones(opciones.map((o) => o.nombre!)));
        return;
    }
    await preguntarTipo(ctx, adjunto, candidatos[0]);
}

async function preguntarTipo(ctx: CtxSoportes, adjunto: AdjuntoPendiente, fila: FilaEstado): Promise<void> {
    const sujeto = { tipo: fila.subject_type, id: fila.subject_id, nombre: fila.full_name };
    // El pie del adjunto puede decir de cuál es; si no, y falta uno solo, se propone directo.
    const dePie = soporteDeTexto(adjunto.caption, fila.missing);
    const unico = fila.missing.length === 1 ? (fila.missing[0] as TipoSoporte) : null;
    const propuesto = dePie ?? unico;
    if (propuesto && esTipoSoporte(propuesto)) {
        await pedirConfirmacion(ctx, adjunto, sujeto, propuesto);
        return;
    }
    const opciones: OpcionGuardada[] = fila.missing.filter(esTipoSoporte).map((t) => ({ soporte: t }));
    await ctx.enviar(TEXTOS_SOPORTE.tipo(sujeto.nombre, opciones.map((o) => o.soporte!)),
        contextoDe(PASO_SOPORTE.TIPO, { etapa: 'tipo', adjunto, sujeto, opciones }),
        botonesDeOpciones(opciones.map((o) => etiqueta(o.soporte!))));
}

async function pedirConfirmacion(
    ctx: CtxSoportes, adjunto: AdjuntoPendiente, sujeto: NonNullable<EstadoSoporte['sujeto']>, soporte: TipoSoporte,
): Promise<void> {
    await ctx.enviar(TEXTOS_SOPORTE.confirmar(sujeto.nombre, soporte),
        contextoDe(PASO_SOPORTE.CONFIRMAR, { etapa: 'confirmar', adjunto, sujeto, soporte }),
        [{ id: BOTON_SOPORTE.SI, title: 'Sí, guardar' }, { id: BOTON_SOPORTE.OTRO, title: 'Es otro soporte' }, { id: BOTON_SOPORTE.NO, title: 'Cancelar' }]);
}

// ─── Entrada 2: contesta una pregunta del flujo ──────────────────────────────

/**
 * Hook del turno: si hay una pregunta de soportes abierta, la contesta. true = el turno terminó acá.
 * false = no hay flujo abierto o lo escrito es de otro tema (sigue lo de siempre). Nunca lanza.
 */
export async function atenderRespuestaDeSoporte(
    ctx: CtxSoportes,
    text: string,
    botonId: string | null,
    recientes: Recientes,
    deps: DepsSoportes = DEPS_SOPORTES,
    ahora = Date.now(),
): Promise<boolean> {
    try {
        const st = estadoPendiente(await cargar(recientes), ahora);
        if (!st) return false;
        if (botonId && !botonId.startsWith('sm_sp_')) return false; // tocó un botón de otra cosa
        const t = normalizarFrase(text);
        const { activo } = await deps.config(ctx.integration.school_id);
        if (!activo) return false;
        const { atiende, parentId } = await deps.contacto(ctx.integration, ctx.conversationId, ctx.contactWaId);
        if (!atiende) return false;

        if (botonId === BOTON_SOPORTE.NO || (!botonId && esNegativa(t))) {
            await ctx.enviar(TEXTOS_SOPORTE.cancelado, { step: PASO_SOPORTE.CANCELADO });
            return true;
        }

        const candidatos = await candidatosDeLaPersona(ctx, parentId, deps);
        const reintentar = async (): Promise<boolean> => {
            const n = (st.intentos ?? 0) + 1;
            const rapido = !botonId && (text.includes('?') || t.split(' ').length > 6);
            if (rapido) return false; // otra cosa: sigue el turno normal
            if (n > MAX_REINTENTOS) {
                await ctx.enviar(TEXTOS_SOPORTE.cancelado, { step: PASO_SOPORTE.CANCELADO });
                return true;
            }
            await ctx.enviar(TEXTOS_SOPORTE.noEntendi, contextoDe(st.etapa === 'ambiguo' ? PASO_SOPORTE.AMBIGUO : `soporte_${st.etapa}`, { ...st, intentos: n }));
            return true;
        };

        if (st.etapa === 'ambiguo') {
            if (botonId === BOTON_SOPORTE.ES_PAGO || (!botonId && /\b(pago|comprobante)\b/.test(t) && !/\bsoporte\b/.test(t))) {
                await deps.encolar(ctx.integration, st.adjunto, ctx.contactWaId);
                return true; // la cola responde una sola vez; el bot no agrega nada
            }
            if (botonId === BOTON_SOPORTE.ES_SOPORTE || (!botonId && /\bsoporte|ficha|documento|certificado|foto|firma\b/.test(t))) {
                if (candidatos.length === 0) return false;
                await preguntarDeportistaOTipo(ctx, st.adjunto, candidatos);
                return true;
            }
            return reintentar();
        }

        if (st.etapa === 'deportista') {
            const ops = (st.opciones ?? []).filter((o) => o.id && o.tipo);
            const elegida = elegirOpcion(text, botonId, ops.map((o) => ({ ...o, nombre: o.nombre })));
            if (!elegida) return reintentar();
            // La pista del payload NO autoriza: debe seguir siendo uno de SUS deportistas con faltantes.
            const fila = candidatos.find((c) => c.subject_id === elegida.id && c.subject_type === elegida.tipo);
            if (!fila) { await ctx.enviar(TEXTOS_SOPORTE.expiro, { step: PASO_SOPORTE.CANCELADO }); return true; }
            await preguntarTipo(ctx, st.adjunto, fila);
            return true;
        }

        if (st.etapa === 'tipo') {
            const sj = st.sujeto;
            const fila = sj && candidatos.find((c) => c.subject_id === sj.id && c.subject_type === sj.tipo);
            if (!sj || !fila) { await ctx.enviar(TEXTOS_SOPORTE.expiro, { step: PASO_SOPORTE.CANCELADO }); return true; }
            const ops = (st.opciones ?? []).filter((o) => o.soporte).map((o) => ({ ...o, etiqueta: etiqueta(o.soporte!) }));
            let elegido: TipoSoporte | null = elegirOpcion(text, botonId, ops)?.soporte ?? null;
            if (!elegido && !botonId) elegido = soporteDeTexto(text, fila.missing);
            if (!elegido || !fila.missing.includes(elegido)) return reintentar();
            await pedirConfirmacion(ctx, st.adjunto, sj, elegido);
            return true;
        }

        // confirmar
        if (botonId === BOTON_SOPORTE.OTRO || (!botonId && /\botro\b/.test(t) && !esAfirmativa(t))) {
            const sj = st.sujeto;
            const fila = sj && candidatos.find((c) => c.subject_id === sj.id && c.subject_type === sj.tipo);
            if (!sj || !fila) { await ctx.enviar(TEXTOS_SOPORTE.expiro, { step: PASO_SOPORTE.CANCELADO }); return true; }
            const opciones: OpcionGuardada[] = fila.missing.filter(esTipoSoporte).map((x) => ({ soporte: x }));
            await ctx.enviar(TEXTOS_SOPORTE.tipo(sj.nombre, opciones.map((o) => o.soporte!)),
                contextoDe(PASO_SOPORTE.TIPO, { etapa: 'tipo', adjunto: st.adjunto, sujeto: sj, opciones }),
                botonesDeOpciones(opciones.map((o) => etiqueta(o.soporte!))));
            return true;
        }
        if (botonId === BOTON_SOPORTE.SI || (!botonId && esAfirmativa(t))) {
            return confirmarYGuardar(ctx, st, candidatos, parentId, deps);
        }
        return reintentar();
    } catch (e: any) {
        console.warn('[whatsapp-soportes] la respuesta no se pudo atender', { conversationId: ctx.conversationId, err: e?.message });
        return false;
    }
}

async function confirmarYGuardar(
    ctx: CtxSoportes, st: EstadoSoporte, candidatos: FilaEstado[], parentId: string | null, deps: DepsSoportes,
): Promise<boolean> {
    const sj = st.sujeto;
    const tipo = st.soporte;
    // Re-derivación completa: solo se guarda para un deportista de esta persona, que aún tenga ese faltante.
    const fila = sj && candidatos.find((c) => c.subject_id === sj.id && c.subject_type === sj.tipo);
    if (!sj || !tipo || !fila) { await ctx.enviar(TEXTOS_SOPORTE.expiro, { step: PASO_SOPORTE.CANCELADO }); return true; }
    if (parentId && !(await deps.esFamilia(parentId, { tipo: sj.tipo, id: sj.id }))) {
        await ctx.enviar(TEXTOS_SOPORTE.expiro, { step: PASO_SOPORTE.CANCELADO });
        return true;
    }
    if (!fila.missing.includes(tipo)) { await ctx.enviar(TEXTOS_SOPORTE.ya, { step: PASO_SOPORTE.GUARDADO }); return true; }

    const bajada = await deps.descargar(ctx.integration, st.adjunto.mediaId);
    if (!bajada.ok) {
        const grande = /archivo_muy_grande/.test(bajada.error);
        await ctx.enviar(grande ? TEXTOS_SOPORTE.grande : TEXTOS_SOPORTE.sinArchivo, { step: PASO_SOPORTE.CANCELADO });
        return true;
    }
    const r = await deps.guardar({
        schoolId: ctx.integration.school_id,
        sujeto: { tipo: sj.tipo, id: sj.id },
        tipo,
        archivo: { buffer: bajada.buffer, nombre: null },
        subidoPor: parentId,
    });
    if (!r.ok) {
        const texto = r.status === 413 ? TEXTOS_SOPORTE.grande
            : r.status === 400 ? TEXTOS_SOPORTE.formato : TEXTOS_SOPORTE.falla;
        await ctx.enviar(texto, { step: PASO_SOPORTE.CANCELADO });
        return true;
    }
    await ctx.enviar(TEXTOS_SOPORTE.guardado(sj.nombre, tipo, r.faltan), { step: PASO_SOPORTE.GUARDADO, flujo_fin: FLUJO_SOPORTE });
    return true;
}

// ─── Recordatorios por WhatsApp a las fichas SIN cuenta ──────────────────────

const tel10 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-10);
/** Celular colombiano → id de WhatsApp (57 + 10 dígitos). null si no parece celular. */
export function waIdDeCelular(s: string | null | undefined): string | null {
    const t = tel10(s);
    return /^3\d{9}$/.test(t) ? `57${t}` : null;
}

/** Texto del recordatorio a una ficha sin cuenta. Sin cobro ni mora. Puro. */
export function textoRecordatorioSoportes(
    escuela: string, deportistas: { nombre: string; faltan: string[] }[],
): string {
    const cuerpo = deportistas.map((d) => `*${d.nombre}*:\n${lista(d.faltan.map(etiqueta))}`).join('\n\n');
    return `Hola 👋 Te escribe el equipo de ${escuela}. A la ficha de ${deportistas.length === 1 ? 'tu deportista' : 'tus deportistas'} le${deportistas.length === 1 ? '' : 's'} faltan estos soportes:\n\n${cuerpo}\n\n` +
        'Puedes enviarlos por aquí mismo (foto o PDF): yo te pregunto de cuál es cada uno y lo guardo en la ficha. 🙌';
}

export interface DepsRecordatorios {
    escuelasConSoportes: () => Promise<string[]>;
    estado: (schoolId: string) => Promise<FilaEstado[]>;
    /** celular por sujeto (lote, sin N+1). */
    celulares: (filas: FilaEstado[]) => Promise<Map<string, string>>;
    integracion: (schoolId: string) => Promise<WhatsAppIntegration | null>;
    nombreEscuela: (schoolId: string) => Promise<string>;
    /** Conversaciones con ventana de 24 h abierta, por celular (lote). */
    conVentanaAbierta: (integration: WhatsAppIntegration, waIds: string[]) => Promise<Map<string, string>>;
    dadoDeBaja: (integration: WhatsAppIntegration, waId: string) => Promise<boolean>;
    reclamar: (schoolId: string, sujetos: FilaEstado[], cadaDias: number, maximo: number) => Promise<Set<string>>;
    enviar: (integration: WhatsAppIntegration, conversationId: string, waId: string, texto: string) => Promise<void>;
}

export interface ResultadoRecordatorios {
    escuelas: number; candidatos: number; sinTelefono: number; fueraDeVentana: number; dadosDeBaja: number;
    reclamados: number; enviados: number; errores: number;
}

const llave = (f: Pick<FilaEstado, 'subject_type' | 'subject_id'>) => `${f.subject_type}:${f.subject_id}`;

/**
 * Recordatorio por WhatsApp a las fichas SIN cuenta con soportes pendientes. Lotes por escuela (sin N+1). Solo
 * manda dentro de la ventana de 24 h de WhatsApp (el texto libre fuera de ella lo rechaza Meta): a quien no
 * escribió en las últimas 24 h NO se le reclama el aviso (el cupo no se gasta) y queda contado en
 * `fueraDeVentana`. Un mensaje por celular aunque tenga varios hijos. Tope en la base (4 días, máximo 6).
 */
export async function enviarRecordatoriosDeSoportes(
    deps: DepsRecordatorios = DEPS_RECORDATORIOS,
    opts: { dryRun?: boolean; cadaDias?: number; maximo?: number } = {},
): Promise<ResultadoRecordatorios> {
    const r: ResultadoRecordatorios = { escuelas: 0, candidatos: 0, sinTelefono: 0, fueraDeVentana: 0, dadosDeBaja: 0, reclamados: 0, enviados: 0, errores: 0 };
    for (const schoolId of await deps.escuelasConSoportes()) {
        r.escuelas++;
        try {
            const sinCuenta = (await deps.estado(schoolId))
                .filter((f) => !f.complete && f.missing.length > 0 && !f.notify_profile_id && f.subject_type !== 'profile');
            r.candidatos += sinCuenta.length;
            if (sinCuenta.length === 0) continue;
            const integ = await deps.integracion(schoolId);
            if (!integ) continue;

            const tels = await deps.celulares(sinCuenta);
            const porCelular = new Map<string, FilaEstado[]>();
            for (const f of sinCuenta) {
                const wa = waIdDeCelular(tels.get(llave(f)));
                if (!wa) { r.sinTelefono++; continue; }
                porCelular.set(wa, [...(porCelular.get(wa) ?? []), f]);
            }
            const ventanas = await deps.conVentanaAbierta(integ, [...porCelular.keys()]);
            const enviables: { wa: string; conv: string; filas: FilaEstado[] }[] = [];
            for (const [wa, filas] of porCelular) {
                const conv = ventanas.get(wa);
                if (!conv) { r.fueraDeVentana += filas.length; continue; }
                if (await deps.dadoDeBaja(integ, wa)) { r.dadosDeBaja += filas.length; continue; }
                enviables.push({ wa, conv, filas });
            }
            if (enviables.length === 0) continue;
            if (opts.dryRun) { r.reclamados += enviables.reduce((n, e) => n + e.filas.length, 0); continue; }

            const reclamados = await deps.reclamar(schoolId, enviables.flatMap((e) => e.filas),
                opts.cadaDias ?? AVISO_CADA_DIAS, opts.maximo ?? AVISO_MAXIMO);
            const escuela = await deps.nombreEscuela(schoolId);
            for (const e of enviables) {
                const dePila = e.filas.filter((f) => reclamados.has(llave(f)));
                if (dePila.length === 0) continue;
                r.reclamados += dePila.length;
                try {
                    await deps.enviar(integ, e.conv, e.wa, textoRecordatorioSoportes(escuela,
                        dePila.map((f) => ({ nombre: f.full_name, faltan: f.missing }))));
                    r.enviados++;
                } catch { r.errores++; }
            }
        } catch (err: any) {
            r.errores++;
            console.error('[soportes-whatsapp] falló una escuela', schoolId, err?.message || err);
        }
    }
    return r;
}

export const DEPS_RECORDATORIOS: DepsRecordatorios = {
    async escuelasConSoportes() {
        const { data, error } = await supabase.from('school_settings').select('school_id').eq('require_athlete_documents', true);
        if (error) return []; // columna sin migrar o error: nada
        return ((data ?? []) as { school_id: string }[]).map((s) => s.school_id);
    },
    estado: (schoolId) => estadoInterno(schoolId),
    async celulares(filas) {
        const out = new Map<string, string>();
        const ids = (t: string) => filas.filter((f) => f.subject_type === t).map((f) => f.subject_id);
        const [hijos, sinReg] = await Promise.all([
            ids('child').length ? supabase.from('children').select('id, parent_phone_temp').in('id', ids('child')) : { data: [] },
            ids('unregistered').length ? supabase.from('unregistered_athletes').select('id, guardian_phone, phone').in('id', ids('unregistered')) : { data: [] },
        ]);
        for (const h of ((hijos as any).data ?? []) as any[]) if (h.parent_phone_temp) out.set(`child:${h.id}`, h.parent_phone_temp);
        for (const u of ((sinReg as any).data ?? []) as any[]) {
            const tel = u.guardian_phone || u.phone;
            if (tel) out.set(`unregistered:${u.id}`, tel);
        }
        return out;
    },
    async integracion(schoolId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status')
            .eq('school_id', schoolId).eq('status', 'active').limit(1).maybeSingle();
        return (data as WhatsAppIntegration | null) ?? null;
    },
    async nombreEscuela(schoolId) {
        const { data } = await supabase.from('schools').select('name').eq('id', schoolId).maybeSingle();
        return String((data as any)?.name ?? 'la escuela');
    },
    async conVentanaAbierta(integration, waIds) {
        const out = new Map<string, string>();
        if (waIds.length === 0) return out;
        const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
        const { data } = await supabase.from('whatsapp_conversations')
            .select('id, contact_wa_id, last_inbound_at')
            .eq('integration_id', integration.id).in('contact_wa_id', waIds).gte('last_inbound_at', desde);
        for (const c of (data ?? []) as any[]) out.set(String(c.contact_wa_id), String(c.id));
        return out;
    },
    async dadoDeBaja(integration, waId) {
        const { estaDadoDeBaja } = await import('./whatsapp-optin.service');
        return estaDadoDeBaja(integration.id, waId);
    },
    async reclamar(schoolId, sujetos, cadaDias, maximo) {
        const { data, error } = await supabase.rpc('soportes_reclamar_avisos', {
            p_school_id: schoolId,
            p_sujetos: sujetos.map((f) => ({ subject_type: f.subject_type, subject_id: f.subject_id })),
            p_cada_dias: cadaDias,
            p_maximo: maximo,
        });
        if (error) throw new Error(`soportes_reclamar_avisos: ${error.code ?? ''} ${error.message}`);
        return new Set(((data as any[]) ?? []).map((x) => `${x.subject_type}:${x.subject_id}`));
    },
    async enviar(integration, conversationId, waId, texto) {
        const { deliver } = await import('./whatsapp-bot.service');
        await deliver(integration, conversationId, waId, texto, { step: 'soportes_recordatorio' });
    },
};
