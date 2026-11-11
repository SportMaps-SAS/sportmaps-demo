/**
 * whatsapp-anuncio-destino — a dónde va el interesado que llega por un anuncio
 * de Meta con clic a WhatsApp (o que escribe «info de la clínica»).
 *
 * Por qué existe (Monster 2026-11-04, spec docs/specs/whatsapp-anuncios-atribucion.md
 * §2): Monster conectó su WhatsApp y tiene anuncios de la *Clínica de armadores y
 * atacantes*. Un interesado que tocaba el anuncio y escribía «quiero información»
 * caía en el embudo de la CLASE DE PRUEBA (sede + 5 preguntas). Ni el embudo ni la
 * puerta del desconocido reconocían «clínica».
 *
 * Cómo decide (`decidirDestino`, pura):
 *
 *   mensaje con `referral` (vino de un anuncio)
 *     ├─ la escuela mapeó ese anuncio (`whatsapp_anuncio_destino`, manda el mapeo)
 *     │    clase_prueba → el embudo de siempre · persona → buzón · servicio → ese ítem
 *     └─ sin mapeo: se infiere del título/texto del anuncio y del mensaje
 *          «clínica», «vacacional», «campamento», «torneo» → el servicio ACTIVO que calce
 *          palabra de evento sin servicio activo → una persona (nunca el embudo equivocado)
 *          sin palabra de evento → el embudo de siempre
 *   sin `referral`: «info / precio de la clínica», «quiero inscribirme a la clínica»
 *     → el servicio ACTIVO que calce; si no hay, sigue el bot de siempre.
 *
 * Destino servicio: la ficha (la descripción de la escuela, sin inventar), el precio
 * de HOY (`precios_por_fecha`; el de afiliado si el número es de una familia del
 * club), el abono mínimo, las cuentas de la escuela, el lead con el servicio y el
 * anuncio, y el MOTIVO ESPERADO (B4) para que el comprobante que llegue se aplique
 * solo. Nunca crea un cobro ni un link: lo crea la cola al llegar el comprobante,
 * con el precio de la base (igual que la clase de prueba del embudo). Por eso NO
 * depende de `wa_ventas_habilitadas` (carril B: cobro suelto + link, solo para
 * familias identificadas).
 *
 * El motor no habla con Meta ni con la base: todo entra por `CtxAnuncio`
 * (inyectable en pruebas). Lo de la base (mapeo, catálogo) vive abajo y nunca
 * lanza: si la tabla del mapeo no existe todavía, se sigue sin mapeo.
 */

import { supabase } from '../config/supabase';
import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import { esMotivo, type Motivo } from './motivos-de-cobro';
import { esMigracionPendiente, type TipoServicio } from './ventas-servicios.service';
import {
    cop, cuandoEs, numeroElegido, pideOQuiereServicio, tokensDistintivos,
} from './whatsapp-venta-servicios.service';
import type { CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import {
    abonoMinimo, hoyBogota, opcionesDelItem, precioVigente, tramosPorFecha, type ItemDeServicio,
} from './wa-cobro-desde-comprobante.service';
// Ciclo a propósito (venta-servicio usa el precio de acá): solo se usan dentro de funciones.
import { MARCA_VENTA } from './whatsapp-venta-contexto';
import { PASO_VENTA, botonesDeVenta, pideDatosDePago, textoDePagoDeServicio, type BotonDeVenta } from './whatsapp-venta-servicio';
import { esConsultaDePatrocinio } from './whatsapp-patrocinio';

// ─── El anuncio (referral de Meta) ──────────────────────────────────────────

/** Lo que trae `messages[].referral` cuando el mensaje vino de un anuncio con clic a WhatsApp. */
export interface ReferralAnuncio {
    /** Id del anuncio (o de la publicación). */
    sourceId: string | null;
    /** 'ad' | 'post'. */
    sourceType: string | null;
    sourceUrl: string | null;
    headline: string | null;
    body: string | null;
    mediaType: string | null;
    /** Click id de Meta (para devolverle la conversión después). */
    ctwaClid: string | null;
}

const texto = (v: unknown, max = 500): string | null =>
    (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * El anuncio de un mensaje entrante: acepta el mensaje crudo de Meta (lo que el
 * webhook guarda en `whatsapp_messages.payload`, con `referral` adentro) o el
 * `referral` suelto. null si no vino de un anuncio. Pura.
 */
export function referralDePayload(payload: unknown): ReferralAnuncio | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const r = (p.referral && typeof p.referral === 'object' ? p.referral : ('source_id' in p || 'ctwa_clid' in p ? p : null)) as
        Record<string, unknown> | null;
    if (!r) return null;
    const ref: ReferralAnuncio = {
        sourceId: texto(r.source_id, 120),
        sourceType: texto(r.source_type, 40),
        sourceUrl: texto(r.source_url, 500),
        headline: texto(r.headline, 300),
        body: texto(r.body, 1000),
        mediaType: texto(r.media_type, 40),
        ctwaClid: texto(r.ctwa_clid, 300),
    };
    return ref.sourceId || ref.headline || ref.body || ref.ctwaClid ? ref : null;
}

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/**
 * El anuncio de la ráfaga SIN contestar: los entrantes posteriores al último
 * saliente (el turno corre con el último mensaje y el referral viene en el
 * primero). El más nuevo con anuncio. Un anuncio ya contestado no vuelve a
 * decidir nada. `recientes`: los de `mensajesRecientes` (cualquier orden). Pura.
 */
export function referralDeLaRafaga(recientes: FilaReciente[]): ReferralAnuncio | null {
    const orden = [...recientes].sort((a, b) => momento(b) - momento(a));
    for (const f of orden) {
        if (f.direction === 'outbound') return null;
        if (f.direction !== 'inbound') continue;
        const r = referralDePayload(f.payload);
        if (r) return r;
    }
    return null;
}

/** El anuncio tal como queda en el lead y en el payload del saliente. Pura. */
export function atribucionDe(r: ReferralAnuncio | null): Record<string, unknown> | null {
    if (!r) return null;
    return {
        source_id: r.sourceId, source_type: r.sourceType, source_url: r.sourceUrl,
        headline: r.headline, ctwa_clid: r.ctwaClid,
    };
}

// ─── El mapeo de la escuela (whatsapp_anuncio_destino) ──────────────────────

export type DestinoAnuncio = 'clase_prueba' | 'servicio' | 'persona';
const DESTINOS: readonly DestinoAnuncio[] = ['clase_prueba', 'servicio', 'persona'];

export interface MapeoAnuncio { destino: DestinoAnuncio; servicioId: string | null }

/** Fila de `whatsapp_anuncio_destino` → mapeo. null si viene rota. Pura. */
export function mapeoDesdeFila(f: Record<string, unknown> | null | undefined): MapeoAnuncio | null {
    if (!f || !(DESTINOS as readonly string[]).includes(String(f.destino))) return null;
    return {
        destino: f.destino as DestinoAnuncio,
        servicioId: typeof f.servicio_id === 'string' && f.servicio_id ? f.servicio_id : null,
    };
}

/** ¿El error dice que la tabla todavía no existe (migración sin aplicar)? */
function tablaPendiente(e: { code?: string; message?: string } | null | undefined): boolean {
    if (!e) return false;
    return esMigracionPendiente(e) || e.code === 'PGRST205' || /could not find the table/i.test(String(e.message ?? ''));
}

/**
 * El destino que la escuela le puso a ese anuncio. Sin la tabla (la migración la
 * aplica otra sesión), sin fila o ante cualquier error: null, y el bot infiere.
 * Nunca lanza.
 */
export async function mapeoDeAnuncio(schoolId: string, sourceId: string | null): Promise<MapeoAnuncio | null> {
    if (!schoolId || !sourceId) return null;
    try {
        const { data, error } = await supabase.from('whatsapp_anuncio_destino')
            .select('destino, servicio_id')
            .eq('school_id', schoolId).eq('source_id', sourceId)
            .limit(1);
        if (error) {
            if (!tablaPendiente(error)) console.warn('[wa-anuncio] no se pudo leer el mapeo', { schoolId, code: error.code });
            return null;
        }
        return mapeoDesdeFila(Array.isArray(data) ? (data[0] as Record<string, unknown>) : null);
    } catch {
        return null;
    }
}

// ─── El catálogo (school_tournament_items) ──────────────────────────────────

/** Un servicio con lo que necesita la ficha (descripción e imagen además de los precios). */
export interface ItemConFicha extends ItemDeServicio {
    description?: string | null;
    image_url?: string | null;
}

const COLUMNAS = 'id, name, kind, price, active, event_id, starts_at, ends_at, description, image_url';
const COLUMNAS_M2 = `${COLUMNAS}, allow_installments, precio_afiliado, precios_por_fecha, abono_minimo_pct, opciones`;
/** (2026-11-11) + el precio de afiliado por fecha. Migración nueva: sin ella se lee M2, y sin M2 las de siempre. */
const COLUMNAS_M3 = `${COLUMNAS_M2}, precios_afiliado_por_fecha`;

/** ¿Sigue vigente? Activo, sin evento, sin terminar. Pura. */
export function servicioVigente(it: Pick<ItemDeServicio, 'active' | 'event_id' | 'starts_at' | 'ends_at'>, ahora = Date.now()): boolean {
    if (it.active === false || it.event_id) return false;
    const fin = it.ends_at ?? it.starts_at;
    return !fin || new Date(fin).getTime() > ahora;
}

/**
 * Los servicios ACTIVOS de la escuela, con descripción y precios (M2; sin esas
 * columnas, los de siempre). UNA lectura, solo cuando hace falta. Nunca lanza.
 */
export async function serviciosDeAnuncio(schoolId: string, ahora = Date.now()): Promise<ItemConFicha[]> {
    const leer = (cols: string) => supabase.from('school_tournament_items')
        .select(cols).eq('school_id', schoolId).eq('active', true).is('event_id', null).limit(50);
    try {
        let { data, error } = await leer(COLUMNAS_M3);
        if (error && esMigracionPendiente(error)) ({ data, error } = await leer(COLUMNAS_M2));
        if (error && esMigracionPendiente(error)) ({ data, error } = await leer(COLUMNAS));
        if (error || !Array.isArray(data)) return [];
        return (data as unknown as ItemConFicha[]).filter((it) => servicioVigente(it, ahora));
    } catch {
        return [];
    }
}

/**
 * Un ítem del catálogo por id (activo o no; quien llama decide con
 * `servicioVigente`). Lo usa la respuesta del formulario para revalidar el
 * servicio y el precio. null si no existe o falla. Nunca lanza.
 */
export async function servicioDeAnuncioPorId(schoolId: string, id: string): Promise<ItemConFicha | null> {
    if (!schoolId || !/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) return null;
    const leer = (cols: string) => supabase.from('school_tournament_items')
        .select(cols).eq('school_id', schoolId).eq('id', id).limit(1);
    try {
        let { data, error } = await leer(COLUMNAS_M3);
        if (error && esMigracionPendiente(error)) ({ data, error } = await leer(COLUMNAS_M2));
        if (error && esMigracionPendiente(error)) ({ data, error } = await leer(COLUMNAS));
        if (error || !Array.isArray(data) || !data[0]) return null;
        return data[0] as unknown as ItemConFicha;
    } catch {
        return null;
    }
}

// ─── Inferencia (pura) ──────────────────────────────────────────────────────

export type ClaveEvento = 'clinica' | 'campamento' | 'vacacional' | 'torneo';

interface EventoDeServicio {
    clave: ClaveEvento;
    re: RegExp;
    /** Palabras que, en el NOMBRE del ítem, lo identifican como ese evento. */
    raices: string[];
    /** `school_tournament_items.kind` que le corresponde (la clínica es clase_extra, B4 §1). */
    tipos: TipoServicio[];
    /** Cómo se nombra en un mensaje («la clínica»). */
    nombre: string;
}

/**
 * Las palabras de evento. Clínica, campamento y vacacional cubren la regla de la
 * campaña (`EVENTO_DE_SERVICIO` de whatsapp-reglas-turno, la que usa
 * whatsapp-audiencias; una prueba fija que todo lo que ella cuenta, esto también),
 * partida para saber cuál nombró; el torneo se suma acá (un anuncio de torneo va
 * al torneo del catálogo).
 */
const EVENTOS: EventoDeServicio[] = [
    { clave: 'clinica', re: /\bclinicas?\b/, raices: ['clinica', 'clinicas'], tipos: ['clase_extra'], nombre: 'la clínica' },
    { clave: 'campamento', re: /\bcampamentos?\b/, raices: ['campamento', 'campamentos'], tipos: ['vacacional'], nombre: 'el campamento' },
    {
        clave: 'vacacional', re: /\b(vacacional(es)?|vacaciones recreativas|cursos? de vacaciones|plan(es)? (de )?vacaciones)\b/,
        raices: ['vacacional', 'vacacionales', 'vacaciones'], tipos: ['vacacional'], nombre: 'el vacacional',
    },
    { clave: 'torneo', re: /\b(torneos?|campeonatos?)\b/, raices: ['torneo', 'torneos', 'campeonato', 'campeonatos'], tipos: ['torneo'], nombre: 'el torneo' },
];

/** Los eventos que nombran los textos (anuncio + mensaje). Pura. */
export function eventosNombrados(textos: (string | null | undefined)[]): ClaveEvento[] {
    const t = normalizarFrase(textos.filter(Boolean).join(' \n '));
    return EVENTOS.filter((e) => e.re.test(t)).map((e) => e.clave);
}

// ─── Fechas y preguntas de detalle sobre un evento (Monster 2026-11-05) ─────

const MES_NUM: Record<string, number> = {
    ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
    jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, set: 9, septiembre: 9, oct: 10, octubre: 10,
    nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};
const FECHA_TEXTO = new RegExp(
    '\\b(\\d{1,2})(?: (?:y|al|a|e) (\\d{1,2}))? (?:de )?(' + Object.keys(MES_NUM).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');

/** «21 de nov», «el 21 y 22 de noviembre» → [{mes: 11, dia: 21}, {mes: 11, dia: 22}]. Pura. */
export function fechasDelTexto(texto: string | null | undefined): { mes: number; dia: number }[] {
    const t = normalizarFrase(texto);
    const fechas: { mes: number; dia: number }[] = [];
    for (const m of t.matchAll(FECHA_TEXTO)) {
        const mes = MES_NUM[m[3]];
        for (const d of [m[1], m[2]]) {
            const dia = Number(d);
            if (d && dia >= 1 && dia <= 31) fechas.push({ mes, dia });
        }
    }
    return fechas;
}

/** ¿Alguna de esas fechas cae dentro de los días del servicio (inicio–fin, hora de Bogotá)? Pura. */
export function servicioCubreFecha(it: Pick<ItemDeServicio, 'starts_at' | 'ends_at'>, fechas: { mes: number; dia: number }[]): boolean {
    if (!it.starts_at || !fechas.length) return false;
    const mmdd = (iso: string) => {
        const [, m, d] = hoyBogota(new Date(iso).getTime()).split('-').map(Number);
        return m * 100 + d;
    };
    const ini = mmdd(it.starts_at);
    const fin = it.ends_at ? mmdd(it.ends_at) : ini;
    return fechas.some((f) => {
        const v = f.mes * 100 + f.dia;
        return v >= Math.min(ini, fin) && v <= Math.max(ini, fin);
    });
}

/**
 * ¿Alguna de esas fechas es el día en que EMPIEZA o TERMINA el servicio? Sirve para elegir entre
 * un curso largo que solo «contiene» la fecha (el vacacional del 17 de nov al 10 de dic) y un
 * evento de esos días (la clínica del 21 y 22). Pura.
 */
export function servicioEmpiezaOTerminaEn(it: Pick<ItemDeServicio, 'starts_at' | 'ends_at'>, fechas: { mes: number; dia: number }[]): boolean {
    if (!it.starts_at || !fechas.length) return false;
    const mmdd = (iso: string) => {
        const [, m, d] = hoyBogota(new Date(iso).getTime()).split('-').map(Number);
        return m * 100 + d;
    };
    const bordes = [mmdd(it.starts_at), it.ends_at ? mmdd(it.ends_at) : mmdd(it.starts_at)];
    return fechas.some((f) => bordes.includes(f.mes * 100 + f.dia));
}

/** «del 21 y 22», «el 21 al 22»: días sueltos sin mes (ni «años», horas o plata detrás). Pura. */
function diasSinMes(t: string): number[] {
    const dias: number[] = [];
    for (const m of t.matchAll(/\b(?:del|el|dias?|los) (\d{1,2})(?: (?:y|al|a|e) (\d{1,2}))?(?! (?:anos|ano|am|pm|horas?|h|mil|de|semanas?|min|minutos)\b)(?!\d|:)/g)) {
        for (const d of [m[1], m[2]]) if (d && Number(d) >= 1 && Number(d) <= 31) dias.push(Number(d));
    }
    return dias;
}

function servicioEmpiezaOTerminaElDia(it: Pick<ItemDeServicio, 'starts_at' | 'ends_at'>, dias: number[]): boolean {
    if (!it.starts_at) return false;
    const dia = (iso: string) => Number(hoyBogota(new Date(iso).getTime()).split('-')[2]);
    const bordes = [dia(it.starts_at), it.ends_at ? dia(it.ends_at) : dia(it.starts_at)];
    return dias.some((d) => bordes.includes(d));
}

const DETALLE_DE_EVENTO =/\b(edad(es)?|anos|requisitos?|nivel(es)?|principiantes?|experiencia|que incluye|incluye|horarios?|a que hora|hora|donde|lugar|sede|direccion|fechas?|cuando|dias?|duracion|que (llevar|debo llevar|hay que llevar|traer)|aplica|aplican|dirigid[oa]|pueden (ir|participar|asistir)|puede (ir|participar|asistir)|cupos?)\b/;

/**
 * ¿Pregunta un DETALLE de un evento (edad, requisitos, nivel, fecha, lugar, horario)?
 * Sin avisar que ya pagó ni mandar el comprobante. Hace falta que además nombre el
 * evento (quien llama lo verifica con eventosNombrados). Pura.
 */
export function preguntaDetalleDeEvento(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    if (/\b(ya (pague|pagamos|transferi|consigne|cancele)|pague|transferi|consigne|comprobante|soporte|recibo)\b/.test(t)) return false;
    return DETALLE_DE_EVENTO.test(t);
}

/** ¿Es una consulta sobre un servicio: lo pide, lo quiere o pregunta un detalle? Pura. */
const consultaDeServicio = (texto: string | null | undefined) => pideOQuiereServicio(texto) || preguntaDetalleDeEvento(texto);

const SOBRE_EDAD_NIVEL = /\b(edad(es)?|anos|requisitos?|nivel(es)?|principiantes?|experiencia|aplica|aplican|dirigid[oa]|pueden|puede)\b/;
// Solo frases que hablan de edad / a quién va dirigido: «nivel» o «experiencia» sueltos están en todo texto de venta.
const FRASE_EDAD_NIVEL = /\b(anos|edad|edades|en adelante|principiantes?|requisitos?|dirigid[oa])\b/;
const SOBRE_CUANDO_DONDE = /\b(fechas?|cuando|dias?|horarios?|a que hora|hora|donde|lugar|sede|direccion|duracion)\b/;
const FRASE_CUANDO_DONDE = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a m|p m|h)|horarios?|hora|sede|lugar|direccion|coliseo|cancha|polideportivo|noviembre|diciembre|enero|sabado|domingo|viernes|de \d{1,2} a \d{1,2})\b/;

/**
 * El pedazo de la descripción de la escuela que contesta la pregunta (edad / nivel o
 * cuándo / dónde), o null si no hay. Sin inventar: solo frases que escribió la
 * escuela. Pura.
 */
export function fragmentoQueResponde(descripcionCompleta: string | null | undefined, pregunta: string | null | undefined): string | null {
    const desc = String(descripcionCompleta ?? '').trim();
    if (!desc) return null;
    const t = normalizarFrase(pregunta);
    const frase = SOBRE_EDAD_NIVEL.test(t) ? FRASE_EDAD_NIVEL : SOBRE_CUANDO_DONDE.test(t) ? FRASE_CUANDO_DONDE : null;
    if (!frase) return null;
    const frases = desc.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 3);
    const elegidas = frases.filter((x) => frase.test(normalizarFrase(x))).slice(0, 3);
    if (!elegidas.length) return null;
    const texto = elegidas.join('\n');
    return texto.length > 600 ? texto.slice(0, 600).replace(/\s+\S*$/, '') + '…' : texto;
}

export type Inferencia =
    | { tipo: 'uno'; item: ItemConFicha }
    | { tipo: 'varios'; items: ItemConFicha[] }
    /** Nombra un evento y la escuela no tiene uno activo que calce. */
    | { tipo: 'evento_sin_servicio'; evento: ClaveEvento }
    | { tipo: 'sin_evento' };

/**
 * ¿Qué servicio del catálogo nombran los textos? Pura.
 *  · Hace falta una palabra de evento («clínica», «vacacional», «campamento», «torneo»).
 *  · Calzan los ítems cuyo NOMBRE la contiene; si ninguno, los de su `kind`.
 *  · Entre los que calzan gana el que más palabras de su nombre aparecen
 *    («armadores», «atacantes»); empate = varios.
 */
/** Raíz de una palabra para comparar género y número («armadoras» = «armadores»). Pura. */
const raizDe = (w: string): string => w.replace(/(es|as|os|a|o|s)$/, '');

/** Palabras que no identifican un servicio aunque el nombre del ítem las tenga. */
const NO_IDENTIFICAN = new Set(['atacantes', 'categoria', 'grupo', 'equipo', 'entrenamiento', 'entrenamientos']);

/**
 * Raíces de las palabras DISTINTIVAS del nombre de un ítem que el texto nombra
 * («Clínica de armadores y atacantes» ← «evento para armadoras» → armador). Pura.
 */
function raicesNombradas(texto: string, it: Pick<ItemDeServicio, 'name'>): string[] {
    const raices = new Set(texto.split(' ').filter((w) => w.length >= 5).map(raizDe));
    return tokensDistintivos(it.name)
        .filter((k) => k.length >= 6 && !EVENTOS.some((e) => e.raices.includes(k)) && !NO_IDENTIFICAN.has(k))
        .map(raizDe)
        .filter((k) => raices.has(k));
}

/**
 * Sin palabra de evento («evento para armadoras el 21 de noviembre»): el servicio que
 * el texto nombra por su NOMBRE (una palabra distintiva suya aparece). Conservador:
 * solo con una coincidencia clara; si dos servicios empatan, quedan los dos. Pura.
 */
function inferirPorNombre(t: string, items: ItemConFicha[]): Inferencia {
    const puntaje = items.map((it) => ({ it, hits: raicesNombradas(t, it).length })).filter((p) => p.hits > 0);
    if (!puntaje.length) return { tipo: 'sin_evento' };
    const max = Math.max(...puntaje.map((p) => p.hits));
    const mejores = puntaje.filter((p) => p.hits === max).map((p) => p.it);
    return mejores.length === 1 ? { tipo: 'uno', item: mejores[0] } : { tipo: 'varios', items: mejores.slice(0, 5) };
}

/**
 * ¿El texto SUENA a un servicio sin decir «clínica»? Barato, sin catálogo: dice «evento»
 * (o similar) o trae una fecha. Solo abre la lectura del catálogo; quien decide es
 * inferirServicio. Pura.
 */
export function suenaAServicio(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    return /\b(evento|jornada|taller|encuentro|actividad)\b/.test(t) || fechasDelTexto(t).length > 0;
}

export function inferirServicio(textos: (string | null | undefined)[], items: ItemConFicha[]): Inferencia {
    const t = normalizarFrase(textos.filter(Boolean).join(' \n '));
    const eventos = EVENTOS.filter((e) => e.re.test(t));
    if (!eventos.length || !eventos.some((e) => e.clave === 'clinica')) { const pn = inferirPorNombre(t, items); if (pn.tipo !== 'sin_evento' || !eventos.length) return pn; }
    // Un evento SIN servicio activo («el 22 estará en un torneo», nombrado de pasada) no cuenta si
    // hay otro evento que sí calza (Monster 2026-11-11). Si ninguno calza, se dejan todos.
    const nombrePalabras = (it: ItemConFicha) => new Set(normalizarFrase(it.name).split(' '));
    // «Campamento» lo dicen las familias de la clínica y del vacacional: sirven las dos.
    const calza = (e: EventoDeServicio, it: ItemConFicha) => e.clave === 'campamento'
        ? String(it.kind) === 'vacacional' || ['clinica', 'clinicas'].some((r) => nombrePalabras(it).has(r))
        : e.raices.some((r) => nombrePalabras(it).has(r)) || (e.tipos as string[]).includes(String(it.kind));
    const sirven = eventos.filter((e) => items.some((it) => calza(e, it)));
    const eventosUsados = sirven.length ? sirven : eventos;
    // «El campamento del 21 de nov»: la escuela llama clínica a lo que la familia llama campamento
    // (Monster 2026-11-05). Con una fecha que cae en un servicio activo, ese servicio manda; SOLO
    // cuando la palabra es «campamento»: quien dijo «vacacional» explícito recibe el Vacacional
    // (clínica y torneo se reconocen por nombre).
    if (eventosUsados.every((e) => e.clave === 'campamento')) {
        const fechas = fechasDelTexto(t);
        const porFecha = fechas.length ? items.filter((it) => servicioCubreFecha(it, fechas)) : [];
        if (porFecha.length === 1) return { tipo: 'uno', item: porFecha[0] };
        if (porFecha.length > 1) {
            // Un curso largo que solo contiene la fecha no compite con el evento que empieza ese día.
            const exactos = porFecha.filter((it) => servicioEmpiezaOTerminaEn(it, fechas));
            if (exactos.length === 1) return { tipo: 'uno', item: exactos[0] };
            return { tipo: 'varios', items: (exactos.length ? exactos : porFecha).slice(0, 5) };
        }
        // «El campamento del 21 y 22» (sin mes): los días solo valen contra el día en que EMPIEZA o TERMINA un servicio.
        if (!fechas.length) {
            const dias = diasSinMes(t);
            const porDia = dias.length ? items.filter((it) => calza(eventosUsados[0], it) && servicioEmpiezaOTerminaElDia(it, dias)) : [];
            if (porDia.length === 1) return { tipo: 'uno', item: porDia[0] };
        }
        // «Campamento» solo, sin fecha ni nombre: puede ser la clínica o el vacacional; no se asume
        // ninguno (el bot pregunta cuál). Con uno solo activo, ese.
        const posibles = items.filter((it) => calza(eventosUsados[0], it));
        if (!posibles.length) return { tipo: 'evento_sin_servicio', evento: 'campamento' };
        return posibles.length === 1 ? { tipo: 'uno', item: posibles[0] } : { tipo: 'varios', items: posibles.slice(0, 5) };
    }
    const eventosFinal = eventosUsados;
    const palabras = new Set(t.split(' '));
    const candidatos = items.map((it) => {
        const nombre = new Set(normalizarFrase(it.name).split(' '));
        return {
            it,
            porNombre: eventosFinal.some((e) => e.raices.some((r) => nombre.has(r))),
            porTipo: eventosFinal.some((e) => (e.tipos as string[]).includes(String(it.kind))),
            hits: tokensDistintivos(it.name).filter((k) => palabras.has(k)).length,
        };
    }).filter((c) => c.porNombre || c.porTipo);
    if (!candidatos.length) return { tipo: 'evento_sin_servicio', evento: eventosFinal[0].clave };
    const conNombre = candidatos.filter((c) => c.porNombre);
    const pool = conNombre.length ? conNombre : candidatos;
    const max = Math.max(...pool.map((c) => c.hits));
    const mejores = pool.filter((c) => c.hits === max).map((c) => c.it);
    return mejores.length === 1 ? { tipo: 'uno', item: mejores[0] } : { tipo: 'varios', items: mejores.slice(0, 5) };
}

/** El motivo de cobro del servicio (= su kind; la clínica es clase_extra). Pura. */
export function motivoDeServicio(it: Pick<ItemDeServicio, 'kind'>): Motivo {
    return esMotivo(it.kind) ? it.kind : 'otro';
}

export type DecisionAnuncio =
    | { destino: 'servicio'; item: ItemConFicha; origen: 'mapeo' | 'anuncio' | 'texto' | 'eleccion' }
    | { destino: 'varios'; items: ItemConFicha[]; origen: 'anuncio' | 'texto' }
    | {
        destino: 'persona';
        motivo: 'mapeo' | 'servicio_no_disponible' | 'evento_sin_servicio' | 'sin_precio';
        evento?: ClaveEvento;
        item?: ItemConFicha;
    }
    | { destino: 'clase_prueba'; origen: 'mapeo' | 'anuncio' };

/** ¿Hay que leer el catálogo para decidir? (barato primero: sin evento ni mapeo a servicio, no se lee). Pura. */
export function necesitaCatalogo(p: {
    referral: ReferralAnuncio | null; mapeo: MapeoAnuncio | null; texto: string; eleccion: string[] | null;
}): boolean {
    if (p.eleccion?.length) return true;
    if (p.referral) {
        if (p.mapeo?.destino === 'persona' || p.mapeo?.destino === 'clase_prueba') return false;
        if (p.mapeo?.destino === 'servicio') return true;
        return eventosNombrados([p.referral.headline, p.referral.body, p.texto]).length > 0;
    }
    return consultaDeServicio(p.texto) && (eventosNombrados([p.texto]).length > 0 || suenaAServicio(p.texto));
}

/**
 * El destino del mensaje. null = no es para este módulo (sigue el bot de siempre).
 * `eleccion`: ids de la lista que se le ofreció en el turno anterior (varios
 * servicios calzaban); `items`: el catálogo vigente (vacío si no se leyó). Pura.
 */
export function decidirDestino(p: {
    referral: ReferralAnuncio | null;
    mapeo: MapeoAnuncio | null;
    texto: string;
    items: ItemConFicha[];
    eleccion?: string[] | null;
}): DecisionAnuncio | null {
    const { referral, mapeo, texto: msg, items } = p;
    // Una empresa que quiere patrocinar («quiero patrocinar la clínica», «mi marca») no es un participante: sin ficha ni precio.
    if (!referral && esConsultaDePatrocinio(msg)) return null;

    // Contesta la lista de la vez pasada («2», «la de armadores»).
    if (!referral && p.eleccion?.length) {
        const ofrecidos = p.eleccion.map((id) => items.find((it) => it.id === id)).filter((x): x is ItemConFicha => !!x);
        const n = numeroElegido(msg, ofrecidos.length);
        if (n) return { destino: 'servicio', item: ofrecidos[n - 1], origen: 'eleccion' };
        const palabras = new Set(normalizarFrase(msg).split(' '));
        const porNombre = ofrecidos.filter((it) => tokensDistintivos(it.name).some((k) => palabras.has(k)));
        if (porNombre.length === 1) return { destino: 'servicio', item: porNombre[0], origen: 'eleccion' };
    }

    if (referral) {
        if (mapeo?.destino === 'persona') return { destino: 'persona', motivo: 'mapeo' };
        if (mapeo?.destino === 'clase_prueba') return { destino: 'clase_prueba', origen: 'mapeo' };
        if (mapeo?.destino === 'servicio' && mapeo.servicioId) {
            const it = items.find((x) => x.id === mapeo.servicioId);
            return it ? { destino: 'servicio', item: it, origen: 'mapeo' } : { destino: 'persona', motivo: 'servicio_no_disponible' };
        }
        const inf = inferirServicio([referral.headline, referral.body, msg], items);
        if (inf.tipo === 'uno') return { destino: 'servicio', item: inf.item, origen: 'anuncio' };
        if (inf.tipo === 'varios') return { destino: 'varios', items: inf.items, origen: 'anuncio' };
        // El anuncio habla de una clínica / un vacacional que ya no está activo: nunca el embudo de la clase.
        if (inf.tipo === 'evento_sin_servicio') return { destino: 'persona', motivo: 'evento_sin_servicio', evento: inf.evento };
        // Mapeado a «servicio» sin decir cuál y el anuncio no lo nombra: si la escuela tiene uno solo, ese.
        if (mapeo?.destino === 'servicio') {
            return items.length === 1
                ? { destino: 'servicio', item: items[0], origen: 'mapeo' }
                : { destino: 'persona', motivo: 'servicio_no_disponible' };
        }
        return { destino: 'clase_prueba', origen: 'anuncio' };
    }

    if (!consultaDeServicio(msg)) return null;
    const inf = inferirServicio([msg], items);
    if (inf.tipo === 'uno') return { destino: 'servicio', item: inf.item, origen: 'texto' };
    if (inf.tipo === 'varios') return { destino: 'varios', items: inf.items, origen: 'texto' };
    return null;
}

// ─── Precio de hoy (puro) ───────────────────────────────────────────────────

export interface PrecioDeServicio {
    /** El que le corresponde HOY a esta persona (lista por fecha o afiliado). null = sin precio. */
    hoy: number | null;
    /** `hoy` es el precio de afiliado. */
    deAfiliado: boolean;
    /** El próximo tramo de `precios_por_fecha` (solo sin precio de afiliado). */
    siguiente: { desde: string; precio: number } | null;
    abono: number | null;
    abonoPct: number | null;
    /** Con opciones (1, 2, 3 o 4 semanas): una línea por opción. */
    opciones: { etiqueta: string; precio: number }[];
}

/** El precio de hoy, el tramo que sigue, el abono y las opciones. `hoy` = 'YYYY-MM-DD' (Bogotá). Pura. */
export function precioDelServicio(item: ItemDeServicio, o: { afiliado: boolean; hoy: string }): PrecioDeServicio {
    const opciones = opcionesDelItem(item)
        .map((op) => ({ etiqueta: op.etiqueta, precio: precioVigente(item, { afiliado: o.afiliado, hoy: o.hoy, opcion: op }) }))
        .filter((x): x is { etiqueta: string; precio: number } => x.precio !== null);
    const hoy = precioVigente(item, { afiliado: o.afiliado, hoy: o.hoy });
    // Con precio de afiliado (del ítem o de sus opciones) el afiliado paga ese, sin importar la fecha.
    const deAfiliado = o.afiliado && (Number(item.precio_afiliado) > 0
        || opcionesDelItem(item).some((op) => Number(op.precio_afiliado) > 0));
    const siguiente = deAfiliado ? null : tramosPorFecha(item.precios_por_fecha).find((t) => t.desde > o.hoy) ?? null;
    const pct = Number(item.abono_minimo_pct);
    const abono = !opciones.length && item.allow_installments === true ? abonoMinimo(hoy, item.abono_minimo_pct) : null;
    return {
        hoy, deAfiliado, siguiente: siguiente && siguiente.precio !== hoy ? siguiente : null,
        abono: abono !== null && hoy !== null && abono < hoy ? abono : null,
        abonoPct: abono !== null && Number.isFinite(pct) ? pct : null,
        opciones,
    };
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM-DD' → «10 de noviembre» (`menos` días antes). Pura. */
export function diaLegible(ymd: string, menos = 0): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const f = new Date(Date.UTC(y, m - 1, d - menos));
    return `${f.getUTCDate()} de ${MESES[f.getUTCMonth()]}`;
}

// ─── Textos (puros) ─────────────────────────────────────────────────────────

const MAX_DESCRIPCION = 900;
/** Descripción que es el texto completo del anuncio de la escuela: se manda tal cual. */
const TEXTO_COMPLETO_MIN = 700;
const TEXTO_COMPLETO_MAX = 3400; // WhatsApp admite 4096; deja sitio al bloque de pago

function descripcion(t: string | null | undefined): string | null {
    const s = String(t ?? '').trim();
    if (!s) return null;
    return s.length > MAX_DESCRIPCION ? `${s.slice(0, MAX_DESCRIPCION).replace(/\s+\S*$/, '')}…` : s;
}

/** Las líneas del valor: hoy (con el tramo que sigue), afiliado u opciones, y el abono. Pura. */
export function lineasDeValor(p: PrecioDeServicio): string[] {
    const lineas: string[] = [];
    if (p.opciones.length) {
        lineas.push(`Valores${p.deAfiliado ? ' de afiliado' : ''}:`, ...p.opciones.map((o) => `• ${o.etiqueta}: *${cop(o.precio)}*`));
    } else if (p.hoy !== null) {
        if (p.deAfiliado) lineas.push(`Tu valor como afiliado: *${cop(p.hoy)}*`);
        else {
            const tramo = p.siguiente
                ? ` (hasta el ${diaLegible(p.siguiente.desde, 1)}; desde el ${diaLegible(p.siguiente.desde)}, *${cop(p.siguiente.precio)}*)`
                : '';
            lineas.push(`Valor hoy: *${cop(p.hoy)}*${tramo}`);
        }
    }
    if (p.abono !== null) {
        lineas.push(`Separas el cupo con un abono mínimo de *${cop(p.abono)}*${p.abonoPct ? ` (${p.abonoPct} %)` : ''}.`);
    }
    return lineas;
}

/** El cierre de la ficha cuando NO pidió el pago: el próximo paso, sin la cuenta pegada. */
export const CTA_FICHA_DE_SERVICIO = 'Si quieres separar tu cupo, respóndeme y te paso los datos de pago 🙌';
export const SIN_CUENTAS_FICHA = 'La escuela te escribe por aquí con los datos de pago para separar tu cupo.';

/**
 * La ficha del servicio: nombre, la descripción que escribió la escuela, cuándo y
 * el valor de hoy. Todo sale de la base; nunca dice «gratis». Pura.
 *
 * SIN el bloque de pago pegado (decisión del usuario 2026-11-08, Monster: quien
 * preguntaba «¿cuánto y cómo aparto?» recibía 2.581 caracteres con la cuenta al
 * final y no la veía): las cuentas van en un mensaje APARTE y solo si las pide
 * (`textoDePagoDeServicio`). Sin pedirlas, la ficha cierra con el próximo paso
 * («respóndeme y te paso los datos de pago»); `o.pidePago` = el pago sale
 * después, así que no lleva ese cierre.
 */
export function textoFichaDeServicio(
    item: ItemConFicha, precio: PrecioDeServicio, cuentas: CuentaDePagoEmbudo[], o: { pidePago?: boolean } = {},
): string {
    const cuando = cuandoEs({ iniciaEn: item.starts_at ?? null, terminaEn: item.ends_at ?? null });
    const cierre = o.pidePago ? null : cuentas.length ? CTA_FICHA_DE_SERVICIO : SIN_CUENTAS_FICHA;
    // Si la escuela pegó en la descripción el TEXTO COMPLETO de su anuncio (≥ 700
    // caracteres: Monster, clínica 11-05) se manda tal cual, sin título ni líneas
    // de valor repetidas. Su texto ya trae fecha, precio y qué incluye; la versión
    // recortada fue lo que la escuela rechazó.
    const completo = String(item.description ?? '').trim();
    if (completo.length >= TEXTO_COMPLETO_MIN) {
        const cuerpo = completo.length > TEXTO_COMPLETO_MAX
            ? `${completo.slice(0, TEXTO_COMPLETO_MAX).replace(/\s+\S*$/, '')}…`
            : completo;
        // El precio de afiliado no está en el texto público: solo lo ve quien es de una
        // familia del club (el bot lo sabe por el número).
        const lineaAfiliado = precio.deAfiliado && precio.hoy !== null
            ? `Como afiliado del club, tu valor es *${cop(precio.hoy)}*.` : null;
        return [cuerpo, lineaAfiliado, cierre].filter(Boolean).join('\n\n');
    }
    return [
        [`*${item.name}*`, descripcion(item.description)].filter(Boolean).join('\n'),
        [cuando ? `Cuándo: ${cuando}` : null, ...lineasDeValor(precio)].filter(Boolean).join('\n'),
        cierre,
    ].filter(Boolean).join('\n\n');
}

/** La lista cuando varios servicios calzan: nombre y valor de hoy de cada uno. Pura. */
export function textoVariosServicios(items: { item: ItemConFicha; precio: PrecioDeServicio }[]): string {
    const lineas = items.map(({ item, precio }, i) => {
        const valor = precio.hoy !== null ? ` — ${cop(precio.hoy)}`
            : precio.opciones.length ? ` — desde ${cop(Math.min(...precio.opciones.map((o) => o.precio)))}` : '';
        return `${i + 1}. *${item.name}*${valor}`;
    });
    return `Tenemos estas opciones:\n\n${lineas.join('\n')}\n\n¿Cuál te interesa? Escríbeme el número o el nombre.`;
}

/** A una persona, con la razón dicha con claridad (nunca silencio). Pura. */
export function textoAPersona(d: Extract<DecisionAnuncio, { destino: 'persona' }>): string {
    const cierre = 'Ya le pasé tu mensaje a la escuela y alguien te responde por aquí 🙌';
    if (d.motivo === 'evento_sin_servicio' && d.evento) {
        const nombre = EVENTOS.find((e) => e.clave === d.evento)?.nombre ?? 'eso';
        const deEso = nombre.startsWith('el ') ? `del ${nombre.slice(3)}` : `de ${nombre}`;
        return `¡Gracias por escribirnos! Por ahora no tengo los datos ${deEso} por aquí. ${cierre}`;
    }
    if (d.motivo === 'sin_precio' && d.item) {
        return `¡Gracias por escribirnos! El valor de *${d.item.name}* te lo confirma la escuela. ${cierre}`;
    }
    if (d.motivo === 'servicio_no_disponible') {
        return `¡Gracias por escribirnos! Eso que viste en el anuncio ya no está abierto por aquí. ${cierre}`;
    }
    return `¡Gracias por escribirnos! ${cierre}`;
}

// ─── Motor ──────────────────────────────────────────────────────────────────

/** Lo que el lead guarda del destino (whatsapp-prospecto-lead `servicio` / `anuncio`). */
export interface LeadDeAnuncio {
    estado: 'nuevo' | 'respondido';
    servicio: { id: string; nombre: string; tipo: string } | null;
    anuncio: Record<string, unknown> | null;
}

export interface CtxAnuncio {
    schoolId: string;
    /** Los mensajes de las últimas 24 h (con payload): el anuncio y los frenos salen de acá. */
    recientes: () => Promise<FilaReciente[]>;
    mapeo: (sourceId: string | null) => Promise<MapeoAnuncio | null>;
    servicios: () => Promise<ItemConFicha[]>;
    /** ¿El número es de una familia del club? (precio de afiliado). Solo se pregunta si el ítem lo tiene. */
    afiliado: () => Promise<boolean>;
    /** Cuentas de la escuela para ese motivo (las restringidas a otra cosa no salen). */
    cuentas: (motivo: Motivo) => Promise<CuentaDePagoEmbudo[]>;
    /**
     * La presentación (una vez cada 24 h) o ''. Con `servicio` (la ficha de una
     * venta), sin la clase de prueba: «te ayudo con la información y el cupo de…».
     */
    saludo: (servicio?: ItemConFicha) => Promise<string>;
    /** ¿Ya se le contestó lo escolar (freno de 30 días)? */
    yaContestado: () => Promise<boolean>;
    /** Crea o actualiza el lead. Devuelve el id (null en simulación o si falla). */
    guardarLead: (l: LeadDeAnuncio) => Promise<string | null>;
    /** B4: el motivo del próximo comprobante (sin monto = cualquier precio vigente de ese servicio). */
    registrarEsperado: (e: { motivo: Motivo; leadId: string | null }) => Promise<boolean>;
    /** UN mensaje; `contexto` va al payload del saliente. Con `botones`, botones de respuesta (si no salen, el texto solo). */
    enviar: (texto: string, contexto: Record<string, unknown>, botones?: BotonDeVenta[]) => Promise<void>;
    /** Buzón con aviso a la escuela. */
    avisarEscuela: (detalle: string) => Promise<void>;
    /** El embudo de la clase de prueba (false = la escuela no lo tiene). */
    iniciarEmbudo: () => Promise<boolean>;
    /**
     * Fase F-a (whatsapp-formulario-servicio): después de la ficha, el formulario de
     * inscripción si la escuela lo tiene PUBLICADO, prendido y sano. true = salió (o
     * se intentó: si no abre, el respaldo sigue por chat). Sin esto, el chat de hoy.
     */
    ofrecerFormulario?: (p: {
        item: ItemConFicha; sinCuentas: boolean; leadId: string | null;
        /** Las cuentas ya salieron (pidió el pago): el respaldo del formulario puede decir «con los datos que te envié». */
        datosDePagoEnviados?: boolean;
    }) => Promise<boolean>;
    ahora?: () => Date;
}

export type ResultadoAnuncio = 'anuncio_servicio' | 'anuncio_varios' | 'anuncio_persona' | 'anuncio_embudo';

/** Marca del saliente: con esto el seguimiento y los frenos lo reconocen. */
export const MARCA_DESTINO = 'destino_anuncio';

/** ¿Ya se le mandó la ficha de ESTE servicio en las últimas 24 h? Pura. */
export function fichaReciente(recientes: FilaReciente[], servicioId: string): boolean {
    return recientes.some((f) => f.direction === 'outbound' && f.payload?.[MARCA_DESTINO] === 'servicio'
        && f.payload?.servicio_id === servicioId);
}

/** Los servicios que se le ofrecieron en el último saliente (la lista de «varios»), o null. Pura. */
export function eleccionPendiente(recientes: FilaReciente[]): string[] | null {
    const ultimo = [...recientes].filter((f) => f.direction === 'outbound').sort((a, b) => momento(b) - momento(a))[0];
    const ids = ultimo?.payload?.[MARCA_DESTINO] === 'varios' ? ultimo.payload?.servicios_ofrecidos : null;
    return Array.isArray(ids) && ids.length ? ids.map(String) : null;
}

/**
 * Atiende el destino del mensaje de un interesado. null = no era para acá (sigue
 * el bot de siempre). Cada camino manda UN mensaje (o arranca el embudo).
 *
 * `fase` (el bot lo llama dos veces): 'anuncio' = solo si el mensaje vino de un
 * anuncio, ANTES de que el embudo abierto lea el mensaje como respuesta (tocar
 * el anuncio de la clínica es una elección explícita); 'texto' = solo sin
 * anuncio («info de la clínica», la lista de «varios»), DESPUÉS del embudo y de
 * los flujos abiertos, que contestan primero lo suyo.
 */
export async function atenderDestinoDeAnuncio(
    ctx: CtxAnuncio, textoCrudo: string, fase: 'anuncio' | 'texto' | 'todo' = 'todo',
): Promise<ResultadoAnuncio | null> {
    const msg = (textoCrudo || '').trim();
    const recientes = await ctx.recientes();
    const referral = referralDeLaRafaga(recientes);
    if ((fase === 'anuncio' && !referral) || (fase === 'texto' && referral)) return null;
    const eleccion = referral ? null : eleccionPendiente(recientes);
    if (!referral && !eleccion && !(consultaDeServicio(msg) && (eventosNombrados([msg]).length || suenaAServicio(msg)))) return null;

    const mapeo = referral?.sourceId ? await ctx.mapeo(referral.sourceId) : null;
    const items = necesitaCatalogo({ referral, mapeo, texto: msg, eleccion }) ? await ctx.servicios() : [];
    const decision = decidirDestino({ referral, mapeo, texto: msg, items, eleccion });
    if (!decision) return null;
    const anuncio = atribucionDe(referral);
    const base = {
        [MARCA_DESTINO]: decision.destino,
        ...('origen' in decision ? { origen_destino: decision.origen } : {}),
        ...(anuncio ? { anuncio } : {}),
    };

    if (decision.destino === 'clase_prueba') {
        // Solo el primer contacto: lo que siga lo atiende el embudo (o su seguimiento).
        if (!referral || await ctx.yaContestado()) return null;
        if (!(await ctx.iniciarEmbudo())) return null;
        // El embudo actualiza este mismo lead (uno por teléfono) con lo que conteste.
        await ctx.guardarLead({ estado: 'nuevo', servicio: null, anuncio });
        return 'anuncio_embudo';
    }

    const hoy = hoyBogota((ctx.ahora ?? (() => new Date()))().getTime());

    if (decision.destino === 'persona') {
        await ctx.guardarLead({ estado: 'nuevo', servicio: null, anuncio });
        const saludo = await ctx.saludo();
        await ctx.enviar(`${saludo ? `${saludo}\n\n` : ''}${textoAPersona(decision)}`, { ...base, motivo_destino: decision.motivo });
        await ctx.avisarEscuela(detalleParaLaEscuela(referral, msg,
            decision.motivo === 'evento_sin_servicio' ? 'nombra un servicio que no está activo en el catálogo'
                : decision.motivo === 'servicio_no_disponible' ? 'el servicio del anuncio ya no está activo'
                    : 'la escuela pidió atender este anuncio en persona'));
        return 'anuncio_persona';
    }

    // La misma ficha no se repite en 24 h: lo que pregunte después lo atiende el seguimiento.
    // Si pregunta un detalle (edad, nivel, fecha, lugar) se le contesta con el pedazo del texto
    // de la escuela que lo dice; si no lo hay, lo atiende el seguimiento.
    if (decision.destino === 'servicio' && fichaReciente(recientes, decision.item.id)) {
        const pedazo = preguntaDetalleDeEvento(msg) ? fragmentoQueResponde(decision.item.description, msg) : null;
        if (!pedazo) return null;
        await ctx.enviar('Sobre *' + decision.item.name + '*:\n' + pedazo,
            { ...base, servicio_id: decision.item.id, [MARCA_VENTA]: decision.item.id, respuesta_de_detalle: true });
        return 'anuncio_servicio';
    }
    const afiliado = await afiliadoSiHaceFalta(ctx, decision.destino === 'servicio' ? [decision.item] : decision.items);

    if (decision.destino === 'varios') {
        const conPrecio = decision.items.map((item) => ({ item, precio: precioDelServicio(item, { afiliado, hoy }) }));
        await ctx.guardarLead({ estado: 'respondido', servicio: null, anuncio });
        const saludo = await ctx.saludo();
        await ctx.enviar(`${saludo ? `${saludo}\n\n` : ''}${textoVariosServicios(conPrecio)}`,
            { ...base, servicios_ofrecidos: decision.items.map((i) => i.id) });
        return 'anuncio_varios';
    }

    const item = decision.item;
    const precio = precioDelServicio(item, { afiliado, hoy });
    if (precio.hoy === null && !precio.opciones.length) {
        const persona = { destino: 'persona' as const, motivo: 'sin_precio' as const, item };
        await ctx.guardarLead({ estado: 'nuevo', servicio: servicioDelLead(item), anuncio });
        const saludo = await ctx.saludo(item);
        await ctx.enviar(`${saludo ? `${saludo}\n\n` : ''}${textoAPersona(persona)}`,
            { ...base, [MARCA_DESTINO]: 'persona', motivo_destino: 'sin_precio', servicio_id: item.id, [MARCA_VENTA]: item.id });
        await ctx.avisarEscuela(detalleParaLaEscuela(referral, msg, `pregunta por «${item.name}», que no tiene precio cargado`));
        return 'anuncio_persona';
    }
    const motivo = motivoDeServicio(item);
    const cuentas = await ctx.cuentas(motivo).catch(() => [] as CuentaDePagoEmbudo[]);
    // El lead primero: el esperado queda a su nombre y la cola lo encuentra por él.
    const leadId = await ctx.guardarLead({ estado: 'respondido', servicio: servicioDelLead(item), anuncio });
    const registrado = await ctx.registrarEsperado({ motivo, leadId }).catch(() => false);
    const saludo = await ctx.saludo(item);
    // «¿Cuánto cuesta la clínica? ¿Cómo aparto mi cupo?» (el texto prellenado del
    // anuncio): la ficha y DESPUÉS el pago en un mensaje aparte, corto y claro.
    const pidePago = pideDatosDePago(msg);
    await ctx.enviar(`${saludo ? `${saludo}\n\n` : ''}${textoFichaDeServicio(item, precio, cuentas, { pidePago })}`, {
        ...base,
        servicio_id: item.id,
        [MARCA_VENTA]: item.id,
        precio_hoy: precio.hoy,
        ...(precio.abono !== null ? { abono: precio.abono } : {}),
        ...(precio.deAfiliado ? { afiliado: true } : {}),
        motivo_esperado: { motivo, monto: null, registrado },
        ...(cuentas.length ? {} : { sin_cuentas: true }),
    });
    if (pidePago) {
        await ctx.enviar(textoDePagoDeServicio(item, precio, cuentas), {
            [MARCA_VENTA]: item.id,
            ...(anuncio ? { anuncio } : {}),
            step: PASO_VENTA.PAGO,
            repetible: true,
            datos_de_pago: cuentas.length > 0,
            precio_hoy: precio.hoy,
            ...(precio.abono !== null ? { abono: precio.abono } : {}),
            ...(precio.deAfiliado ? { afiliado: true } : {}),
            ...(cuentas.length ? {} : { sin_cuentas: true }),
        }, cuentas.length ? botonesDeVenta(item, ['ya_pague']) : undefined);
    }
    if (!cuentas.length) {
        await ctx.avisarEscuela(detalleParaLaEscuela(referral, msg,
            `pidió «${item.name}» y la escuela no tiene cuentas de pago cargadas: escríbele con los datos de pago`));
    }
    // El formulario va DESPUÉS de la ficha (y del pago, si lo pidió): si no abre o lo
    // cierran, la ficha ya dice el valor y cómo seguir (nunca un callejón). Solo un
    // precio (sin opciones).
    let formularioSalio = false;
    if (ctx.ofrecerFormulario && !precio.opciones.length && precio.hoy !== null) {
        formularioSalio = await ctx.ofrecerFormulario({ item, sinCuentas: !cuentas.length, leadId, datosDePagoEnviados: pidePago && cuentas.length > 0 })
            .catch(() => false);
    }
    // Sin pago pedido ni formulario: la ficha cierra con [Separar mi cupo] [Hablar con alguien] (Monster 2026-11-09).
    if (!pidePago && !formularioSalio && cuentas.length) {
        await ctx.enviar('¿Qué quieres hacer? 👇', { [MARCA_VENTA]: item.id, step: PASO_VENTA.DETALLES, repetible: true },
            botonesDeVenta(item, ['separar', 'humano']));
    }
    return 'anuncio_servicio';
}

function servicioDelLead(item: ItemConFicha): LeadDeAnuncio['servicio'] {
    return { id: item.id, nombre: item.name, tipo: String(item.kind) };
}

/** El precio de afiliado solo se pregunta si algún ítem lo tiene (una RPC menos). */
async function afiliadoSiHaceFalta(ctx: CtxAnuncio, items: ItemConFicha[]): Promise<boolean> {
    const tiene = items.some((it) => Number(it.precio_afiliado) > 0
        || opcionesDelItem(it).some((o) => Number(o.precio_afiliado) > 0));
    if (!tiene) return false;
    return ctx.afiliado().catch(() => false);
}

/** El detalle del aviso a la escuela: de qué anuncio vino y qué escribió. Pura. */
export function detalleParaLaEscuela(r: ReferralAnuncio | null, msg: string, razon: string): string {
    return [
        r ? `Llegó por el anuncio${r.headline ? ` «${r.headline.slice(0, 120)}»` : ''}${r.sourceId ? ` (id ${r.sourceId})` : ''}:` : 'Interesado por WhatsApp:',
        `${razon}.`,
        msg ? `Escribió: «${msg.slice(0, 300)}».` : '',
    ].filter(Boolean).join(' ');
}
