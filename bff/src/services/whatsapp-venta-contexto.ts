/**
 * whatsapp-venta-contexto — ¿esta conversación es la VENTA de un servicio?
 *
 * Por qué existe (Monster, clínica de armadores, 2026-11-08): ~130 interesados en
 * la clínica, 1 sola venta registrada. El bot trataba cada mensaje por separado:
 * un «Hola», un «Ok» o un «ese día tengo torneo» de alguien que estaba comprando
 * la clínica caía en el embudo de la CLASE DE PRUEBA («Elige la sede», 5
 * preguntas) y los seguimientos le ofrecían la clase de prueba. Un comprador
 * terminó pagando una clase de prueba que no pidió.
 *
 * La regla (decisión del usuario 2026-11-08): «si la clínica es de ventas no
 * podemos meter nada del club, solo es una venta». Mientras la conversación esté
 * en la venta de un servicio del catálogo (`school_tournament_items`: clínica,
 * torneo, vacacional, campamento, lo que la escuela tenga), todo lo que conteste
 * el bot es de ESE servicio. Solo sale de la venta si la persona pide el club de
 * forma explícita (clase de prueba, mensualidad, entrenar en el club…).
 *
 * Este módulo es PURO (se prueba sin base): recibe los mensajes de la
 * conversación (hasta `DIAS_CONTEXTO_VENTA` días) y el catálogo vigente. Lo usan
 * el bot (para no abrir embudos del club), la cola de comprobantes (para crear el
 * cobro del servicio y no buscar «¿de qué deportista?») y la lista de seguimiento
 * de conversaciones (para el tema de cada una).
 *
 * Señales de venta, de la más fuerte a la más débil:
 *   · un saliente marcado con el servicio (`payload.venta_servicio_id`,
 *     `payload.servicio_id`, o el destino de anuncio `servicio`);
 *   · un saliente de la ESCUELA o de una campaña con el texto del servicio (la
 *     escuela pega a mano la ficha de la clínica; la respuesta al «Sí» de la
 *     campaña es ese mismo texto);
 *   · un entrante que nombra el servicio («info de la clínica de armadores»);
 *   · el lead del teléfono guardado con ese servicio.
 */

import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import { tokensDistintivos } from './whatsapp-venta-servicios.service';
import { inferirServicio, type ItemConFicha } from './whatsapp-anuncio-destino';

/** Cuántos días hacia atrás cuenta una señal de venta. */
export const DIAS_CONTEXTO_VENTA = 7;

/** Marca que TODO saliente de la venta de un servicio lleva en el payload (id del ítem). */
export const MARCA_VENTA = 'venta_servicio_id';

export type OrigenVenta = 'marca' | 'texto_saliente' | 'nombrado' | 'lead';

export interface VentaActiva {
    item: ItemConFicha;
    origen: OrigenVenta;
    /** ISO del mensaje que la sostiene (null si viene del lead). */
    desde: string | null;
}

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
const textoDe = (f: FilaReciente): string =>
    String(f.text_body ?? f.payload?.caption ?? f.payload?.text?.body ?? '').trim();

/**
 * ¿El texto nombra UN ítem del catálogo? Primero por la palabra de evento
 * («clínica», «torneo», «vacacional», «campamento») + nombre; si el nombre del
 * ítem no tiene palabra de evento («Copa Relámpago»), por TODAS sus palabras
 * distintivas (mínimo 2) o el nombre completo. Pura.
 */
export function itemNombradoEn(texto: string | null | undefined, items: ItemConFicha[]): ItemConFicha | null {
    const t = normalizarFrase(texto);
    if (!t || !items.length) return null;
    const inf = inferirServicio([t], items);
    if (inf.tipo === 'uno') return inf.item;
    const palabras = new Set(t.split(' '));
    const porNombre = items.filter((it) => {
        const nombre = normalizarFrase(it.name);
        if (nombre.length >= 6 && ` ${t} `.includes(` ${nombre} `)) return true;
        const tokens = tokensDistintivos(it.name);
        return tokens.length >= 2 && tokens.every((k) => palabras.has(k));
    });
    if (porNombre.length === 1) return porNombre[0];
    // Varios por evento y uno solo por nombre completo: ese.
    if (inf.tipo === 'varios') {
        const exacto = inf.items.filter((it) => porNombre.includes(it));
        if (exacto.length === 1) return exacto[0];
    }
    return null;
}

/** El ítem que marca un saliente en su payload (bot o flujo con la marca). Pura. */
export function itemMarcadoEn(f: FilaReciente, items: ItemConFicha[]): ItemConFicha | null {
    const p = f.payload ?? {};
    const ids = [p[MARCA_VENTA], p.servicio_id, p.servicio?.id].filter((x) => typeof x === 'string' && x);
    for (const id of ids) {
        const it = items.find((x) => x.id === id);
        if (it) return it;
    }
    return null;
}

/**
 * Pedido EXPLÍCITO del club (no del servicio): con esto la persona sale de la venta
 * y el bot vuelve a sus flujos de siempre. Conservador a propósito: «entreno» o
 * «sede» sueltos aparecen en preguntas de la clínica («¿cuánto dura cada
 * entreno?», «¿en qué sede es?») y NO sacan de la venta. Pura.
 */
export function pideElClub(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    return /\b(clases? de (prueba|cortesia)|clase gratis|mensualidad(es)?|matricula(r|rme|rla|rlo)?|plan(es)? (mensual(es)?|del club)|inscribir(me|la|lo|los|las)? (al|en el) club|inscribir(me|la|lo|los|las)? (a|en) la escuela|(entrar|unirme|unirse|hacer parte) (al|del) club|entrenar (con ustedes|en el club|en la escuela|todo el ano|regularmente)|horarios? de (los )?entrenamientos? (del club|regulares)|categorias? del club)\b/.test(t);
}

/**
 * La venta activa de la conversación, o null. Pura.
 *
 * `mensajes`: los de la conversación (cualquier orden; idealmente hasta
 * `DIAS_CONTEXTO_VENTA` días). `items`: el catálogo VIGENTE (un servicio que ya
 * terminó no sostiene una venta). `leadServicioId`: el servicio guardado en el
 * lead del teléfono, si lo hay.
 *
 * Si después de la última señal de venta la persona pidió el club de forma
 * explícita, la venta se cierra (null): está preguntando otra cosa.
 */
export function ventaActiva(
    mensajes: FilaReciente[],
    items: ItemConFicha[],
    o: { ahora?: number; leadServicioId?: string | null; dias?: number } = {},
): VentaActiva | null {
    if (!items.length) return null;
    const ahora = o.ahora ?? Date.now();
    const desde = ahora - (o.dias ?? DIAS_CONTEXTO_VENTA) * 24 * 3600_000;
    const orden = mensajes
        .filter((f) => {
            const m = momento(f);
            return Number.isFinite(m) && m >= desde && m <= ahora + 60_000;
        })
        .sort((a, b) => momento(b) - momento(a));

    let senal: VentaActiva | null = null;
    let clubDespues = false;
    for (const f of orden) {
        const texto = textoDe(f);
        if (f.direction === 'inbound') {
            if (!senal && pideElClub(texto)) clubDespues = true;
            const it = itemNombradoEn(texto, items);
            if (it) { senal = { item: it, origen: 'nombrado', desde: iso(f) }; break; }
            continue;
        }
        if (f.direction !== 'outbound') continue;
        const marcado = itemMarcadoEn(f, items);
        if (marcado) { senal = { item: marcado, origen: 'marca', desde: iso(f) }; break; }
        // Salientes del bot SIN marca no cuentan por el texto: el bot nombra la clínica en
        // su presentación («tenemos la clínica y el vacacional») sin que sea una venta. Sí
        // cuentan la escuela (ficha pegada a mano), las plantillas y la respuesta de campaña.
        const deLaEscuelaOCampana = f.ai_generated !== true || f.type === 'template'
            || f.payload?.campana_id || f.payload?.step === 'campana_respuesta_si';
        if (deLaEscuelaOCampana && texto.length >= 60) {
            const it = itemNombradoEn(texto, items);
            if (it) { senal = { item: it, origen: 'texto_saliente', desde: iso(f) }; break; }
        }
    }
    if (senal) return clubDespues ? null : senal;
    if (clubDespues) return null;
    if (o.leadServicioId) {
        const it = items.find((x) => x.id === o.leadServicioId);
        if (it) return { item: it, origen: 'lead', desde: null };
    }
    return null;
}

function iso(f: FilaReciente): string | null {
    const m = momento(f);
    return Number.isFinite(m) && m > 0 ? new Date(m).toISOString() : null;
}
