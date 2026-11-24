/**
 * whatsapp-venta-servicio — el bot en MODO VENTA de un servicio del catálogo
 * (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md, frente A).
 *
 * Por qué existe (Monster, Clínica de Armadores y Atacantes, 3–8 nov 2026): ~130
 * interesados y 1 sola venta registrada. Mientras alguien estaba comprando la
 * clínica, el bot le contestaba como a un interesado del CLUB: «Hola», «Ok» o
 * «ese día tenemos torneo» recibían «Elige la sede» y las 5 preguntas de la clase
 * de prueba; un comprador terminó pagando una clase de prueba que no pidió; las
 * dudas de antes de pagar («¿incluye grupo femenino?», «titular de la cuenta»)
 * quedaban sin respuesta o en silencio total.
 *
 * La regla (decisión del usuario 2026-11-08): una venta de servicio es SOLO una
 * venta. Con la venta activa (`ventaActiva`, whatsapp-venta-contexto) todo lo que
 * contesta el bot es de ESE servicio; solo sale de la venta si la persona pide el
 * club de forma explícita (`pideElClub`).
 *
 *   intención            respuesta
 *   ─────────────────    ──────────────────────────────────────────────────────
 *   pago                 el mensaje de pago APARTE, corto y determinista: precio de
 *                        HOY por tramo (con la fecha correcta del siguiente),
 *                        afiliado, abono, cuentas con titular y «envía aquí el
 *                        comprobante con el nombre completo de quien asiste».
 *   detalle              `responderPreguntaDeServicio` (IA anclada al ítem, frente B);
 *                        si no sabe → «Eso te lo confirma la escuela por aquí» y la
 *                        pregunta queda PENDIENTE para la escuela (buzón + payload).
 *   otra_fecha           acuse + buzón (la escuela decide si hay otra fecha).
 *   ya_pago              «envíalo aquí con el nombre completo de quien asiste».
 *   saludo («hola», «ok», «.») UNA línea del servicio (nunca el menú de sedes), una
 *                        vez cada 30 min.
 *   cierre («gracias»)   silencio.
 *   club                 null: no es de la venta, sigue el bot de siempre.
 *
 * Todo saliente lleva `payload[MARCA_VENTA] = item.id`: así la venta se reconoce
 * en el turno siguiente, en la cola de comprobantes y en la lista de seguimiento.
 *
 * Lo de la base entra por `CtxVentaServicio` (inyectable): este módulo se prueba
 * sin base ni Meta. No importa el bot (sería circular).
 */

import { normalizarFrase, type FilaReciente } from './whatsapp-reglas-turno';
import { MARCA_VENTA, itemNombradoEn, pideElClub, ventaActiva, type VentaActiva } from './whatsapp-venta-contexto';
import {
    diaLegible, motivoDeServicio, precioDelServicio, type ItemConFicha, type PrecioDeServicio,
} from './whatsapp-anuncio-destino';
import { comoPagar, estadoDeSalientes, numeroLegible, type CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import { cop, tokensDistintivos } from './whatsapp-venta-servicios.service';
import { hoyBogota, opcionesDelItem, type ItemDeServicio } from './wa-cobro-desde-comprobante.service';
import { cobroConAbono, lineasDeSaldoDelCobro, type CobroPrevioParaIa } from './whatsapp-catalogo-para-ia';
import type { Motivo } from './motivos-de-cobro';
import type { PreguntaDeServicio, RespuestaDeServicio } from './whatsapp-servicio-ia';
import { nombreDeAsistente, puedeSerPalabraDeNombre } from './whatsapp-comprobante-de-ficha.service';
import type { TextosClase } from './textos-clase-prueba';
import {
    elegirEntreNombres, leerDatosDeRegistro, nombreYAcudienteEnLineas, nombresDeAsistentesEn, textoVariosAsistentes, textoVariosCuposALaEscuela,
    unirDatosDeRegistro, type DatoFaltante, type DatosDeRegistro,
} from './whatsapp-datos-de-registro';
import {
    aportaAlgo, combinarConRespuesta, faltantesDe, mismaPersona, pedidoDeFaltantes, registroDeChatPrevio, tieneMarcaDeAsistente,
    traeOtroDato, MAX_MENSAJES_DE_LA_VENTA, HORAS_DE_LA_VENTA, MARGEN_ANTES_DE_LA_VENTA_MS,
} from './wa-registro-de-venta.service';

// ─── Pasos (payload.step) de los salientes de la venta ──────────────────────

export const PASO_VENTA = {
    PAGO: 'venta_servicio_pago',
    SIN_PRECIO: 'venta_servicio_sin_precio',
    RESPUESTA: 'venta_servicio_respuesta',
    A_LA_ESCUELA: 'venta_servicio_a_la_escuela',
    OTRA_FECHA: 'venta_servicio_otra_fecha',
    YA_PAGO: 'venta_servicio_ya_pago',
    SALUDO: 'venta_servicio_saludo',
    /** Tocó un botón viejo de un flujo del club en plena venta (una respuesta; los demás toques, nada). */
    BOTON_CLUB: 'venta_servicio_boton_club',
    /** Pidió el club por texto en plena venta: «va aparte y cuesta…» antes de agendar nada. */
    CLUB_APARTE: 'venta_servicio_club_aparte',
    /** Dio los datos de quien asiste («Nicolás Cubides Ávila / 18 de diciembre de 2006 / Opuesto»). */
    ASISTENTE: 'venta_servicio_asistente',
    /** Tocó [Ver detalles]: la ficha que escribió la escuela. */
    DETALLES: 'venta_servicio_detalles',
    /** Tocó [Hablar con alguien]: aviso a la escuela y la conversación en el buzón. */
    HUMANO: 'venta_servicio_humano',
    /** Tocó un botón de un servicio que ya no está vigente. */
    NO_VIGENTE: 'venta_servicio_no_vigente',
    /** (auditoría 8–16 nov 2026) Eligió una opción del servicio («2 semanas», «del 23 al 27 nov / del 30 al 04 dic»). */
    OPCION: 'venta_servicio_opcion',
    /** Llegaron dos o más nombres en un mensaje: se pregunta para quién es el pago (el cobro es por persona). */
    VARIOS_ASISTENTES: 'venta_servicio_varios_asistentes',
    /** «Profe una pregunta», «Me puedes confirmar», «Seria?»: «Claro, dime» y se espera. */
    DIME: 'venta_servicio_dime',
    /** «Estoy en otra ciudad», «no puedo», «no me queda»: cierre amable, sin derivar ni insistir. */
    DESISTE: 'venta_servicio_desiste',
    /** Preguntó por la llave / Bre-B con el mensaje de pago recién enviado: respuesta corta, sin repetir el bloque. */
    LLAVE: 'venta_servicio_llave',
} as const;

// ─── Botones de la venta (Monster 2026-11-09: «que todo sea más fácil y concreto, vender más rápido») ──
//
// [Separar mi cupo] [Ver detalles] [Hablar con alguien] en la entrada (respuesta al «Sí» de la
// campaña y saludo dentro de la venta) y [Ya pagué] en el mensaje de pago. El id lleva el servicio:
// `vs:<item_id>:<accion>`; así el toque funciona aunque la conversación no tenga otra señal de venta.
// Sin preguntas antes de pagar: el afiliado se reconoce por el número y la edad va en la ficha.

export interface BotonDeVenta { id: string; title: string }
export type AccionBotonVenta = 'separar' | 'detalles' | 'humano' | 'ya_pague';
export const PREFIJO_BOTON_VENTA = 'vs:';
/** Títulos de Meta: 20 caracteres como máximo. */
export const TITULO_BOTON_VENTA: Record<AccionBotonVenta, string> = {
    separar: 'Separar mi cupo',
    detalles: 'Ver detalles',
    humano: 'Hablar con alguien',
    ya_pague: 'Ya pagué',
};
export const BOTONES_DE_ENTRADA: AccionBotonVenta[] = ['separar', 'detalles', 'humano'];
/** Cuerpo de un mensaje con botones de respuesta (Meta: 1024). Más largo, la ficha sale sola y los botones aparte. */
export const MAX_CUERPO_CON_BOTONES = 1000;

export function idBotonDeVenta(itemId: string, accion: AccionBotonVenta): string {
    return `${PREFIJO_BOTON_VENTA}${itemId}:${accion}`;
}

/** `vs:<uuid>:<accion>` → servicio y acción; cualquier otro id → null. Pura. */
export function parsearBotonDeVenta(botonId: string | null | undefined): { itemId: string; accion: AccionBotonVenta } | null {
    const m = /^vs:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(separar|detalles|humano|ya_pague)$/i
        .exec(String(botonId ?? '').trim());
    return m ? { itemId: m[1].toLowerCase(), accion: m[2].toLowerCase() as AccionBotonVenta } : null;
}

export function botonesDeVenta(item: Pick<ItemConFicha, 'id'>, acciones: AccionBotonVenta[]): BotonDeVenta[] {
    return acciones.map((a) => ({ id: idBotonDeVenta(item.id, a), title: TITULO_BOTON_VENTA[a] }));
}

export const TEXTO_HUMANO = 'Listo 🙌 Le aviso a la escuela y te escribe por aquí.';
export const TEXTO_TRAS_DETALLES = '¿Separamos tu cupo?';
export const TEXTO_SERVICIO_NO_VIGENTE = 'Ese servicio ya no está disponible 🙌 Si quieres, escríbenos y te contamos lo que tenemos.';

/** Minutos entre dos líneas de saludo de la venta («¿Te ayudo con algo de la clínica?»). */
export const MIN_ENTRE_SALUDOS_DE_VENTA = 30;

// ─── Cómo se nombra el servicio ─────────────────────────────────────────────

const FEMENINOS = /^(clinica|clinicas|copa|liga|jornada|jornadas|semana|charla|capacitacion|convocatoria|valoracion|clase|clases|salida|travesia|olimpiada|olimpiadas|exhibicion)$/;
const MASCULINOS = /^(torneo|torneos|campamento|campamentos|vacacional|vacacionales|curso|cursos|campeonato|taller|talleres|seminario|festival|encuentro|plan|programa|evento|intercambio|entrenamiento|tecnificacion|camp)$/;

/** «la» / «el» / '' según la primera palabra del nombre del servicio. Pura. */
export function articuloDelServicio(item: Pick<ItemConFicha, 'name'>): 'la' | 'el' | '' {
    const primera = normalizarFrase(item.name).split(' ')[0] ?? '';
    if (FEMENINOS.test(primera)) return 'la';
    if (MASCULINOS.test(primera)) return 'el';
    return '';
}

/**
 * «de la Clínica…» / «del Torneo…» / «de Copa…». El nombre va SIN negrita salvo que
 * se pida: `*nombre*` es el título de la ficha, y el mensaje de pago o la línea del
 * saludo con ese título se leían como la ficha repetida (batería del frente F). Pura.
 */
export function deLaDelServicio(item: Pick<ItemConFicha, 'name'>, o: { negrita?: boolean } = {}): string {
    const a = articuloDelServicio(item);
    const n = o.negrita ? `*${item.name.trim()}*` : item.name.trim();
    return a === 'la' ? `de la ${n}` : a === 'el' ? `del ${n}` : `de ${n}`;
}

/** «en la Clínica…» / «en el Torneo…» / «en Copa…» (sin negrita salvo que se pida). Pura. */
export function enElServicio(item: Pick<ItemConFicha, 'name'>, o: { negrita?: boolean } = {}): string {
    const a = articuloDelServicio(item);
    const n = o.negrita ? `*${item.name.trim()}*` : item.name.trim();
    return a ? `en ${a} ${n}` : `en ${n}`;
}

// ─── Fechas de los tramos ───────────────────────────────────────────────────

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** 'YYYY-MM-DD' → «martes 10 de noviembre» (`menos` días antes). Pura. */
export function diaConSemana(ymd: string, menos = 0): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const f = new Date(Date.UTC(y, m - 1, d - menos));
    return `${DIAS_SEMANA[f.getUTCDay()]} ${diaLegible(ymd, menos)}`;
}

/**
 * El tramo siguiente con la fecha CORRECTA: desde '2026-11-11' ⇒ «hasta el martes
 * 10 de noviembre; desde el 11, *$350.000*» (Monster 2026-11-08: la ficha de
 * prospectos decía «hasta el 9» y la IA lo repitió en 12 conversaciones). Pura.
 */
export function textoDelTramo(siguiente: { desde: string; precio: number }): string {
    const hasta = diaConSemana(siguiente.desde, 1);
    const mismoMes = siguiente.desde.slice(5, 7) === fechaMenos(siguiente.desde, 1).slice(5, 7);
    const dia = Number(siguiente.desde.slice(8, 10));
    const desde = mismoMes ? `el ${dia}` : `el ${diaLegible(siguiente.desde)}`;
    return `hasta el ${hasta}; desde ${desde}, *${cop(siguiente.precio)}*`;
}

function fechaMenos(ymd: string, dias: number): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - dias)).toISOString().slice(0, 10);
}

// ─── El mensaje de pago (determinista) ──────────────────────────────────────

/** ¿El ítem (o alguna opción) tiene precio de afiliado? Solo entonces se pregunta a la base. Pura. */
export function tienePrecioDeAfiliado(item: ItemConFicha): boolean {
    return Number(item.precio_afiliado) > 0 || opcionesDelItem(item).some((o) => Number(o.precio_afiliado) > 0);
}

/** El precio sin el «(afiliados $X)» de cada opción: para quien pidió justo la tarifa de no afiliados. Pura. */
function sinNotaDeAfiliado(p: PrecioDeServicio): PrecioDeServicio {
    return { ...p, opciones: p.opciones.map(({ precioAfiliado: _pa, ...resto }) => resto) };
}

/** Las líneas del valor de hoy: afiliado, opciones o lista por tramo, y el abono. Pura. */
export function lineasDeValorDeVenta(p: PrecioDeServicio): string[] {
    const lineas: string[] = [];
    if (p.opciones.length) {
        lineas.push(`Valores${p.deAfiliado ? ' de afiliado' : ''}:`, ...p.opciones.map((o) => `• ${o.etiqueta}: *${cop(o.precio)}*${o.precioAfiliado ? ` (afiliados *${cop(o.precioAfiliado)}*)` : ''}`));
    } else if (p.hoy !== null) {
        // «antes $X»: solo con descuento temporal (`precioAntesDelTramo`); el dato sale del catálogo.
        const antes = p.antes ? `antes ${cop(p.antes)}` : '';
        if (p.deAfiliado) lineas.push(`Tu valor como afiliado del club: *${cop(p.hoy)}*${antes ? ` (${antes})` : ''}.`);
        else {
            const partes = [antes, p.siguiente ? textoDelTramo(p.siguiente) : ''].filter(Boolean);
            lineas.push(`Valor hoy: *${cop(p.hoy)}*${partes.length ? ` (${partes.join('; ')})` : ''}.`);
        }
    }
    if (p.abono !== null) {
        lineas.push(`Puedes separar el cupo con un abono mínimo de *${cop(p.abono)}*${p.abonoPct ? ` (${p.abonoPct} %)` : ''}.`);
    }
    return lineas;
}

export const CIERRE_DE_PAGO = 'Envía aquí la foto del comprobante con el nombre completo de quien asiste y te confirmamos el cupo.';
export const SIN_CUENTAS_DE_PAGO = 'La escuela te escribe por aquí con los datos de pago para separar tu cupo.';

/**
 * El mensaje de pago de un servicio, APARTE de la ficha y solo cuando lo piden:
 * precio de HOY por tramo (`precioDelServicio`; el de afiliado si lo es), el tramo
 * siguiente con la fecha correcta, el abono mínimo, las cuentas configuradas con
 * su titular y el cierre «envía aquí el comprobante con el nombre completo de
 * quien asiste». Sin cuentas: «la escuela te escribe con los datos» (quien llama
 * avisa a la escuela). Todo sale de la base. Pura.
 *
 * `precio`: el ya calculado, o null para calcularlo con `o.afiliado` y `o.hoy`.
 */
export function textoDePagoDeServicio(
    item: ItemConFicha,
    precio: PrecioDeServicio | null,
    cuentas: CuentaDePagoEmbudo[],
    o: { afiliado?: boolean; hoy?: string; cierre?: string; cobroPrevio?: CobroPrevioParaIa | null } = {},
): string {
    const cierre = o.cierre ?? CIERRE_DE_PAGO;
    const p = precio ?? precioDelServicio(item, { afiliado: o.afiliado === true, hoy: o.hoy ?? hoyBogota(Date.now()) });
    // Con un abono hecho, el valor es el SALDO de su cobro, nunca el precio de hoy ni un abono de otra fecha.
    const cobro = cobroConAbono(o.cobroPrevio);
    const valor = cobro ? lineasDeSaldoDelCobro(cobro) : lineasDeValorDeVenta(p);
    // Vacacional: se dan las dos tarifas y se pide que diga cuál es (no se asume externa).
    if (!cobro && !p.deAfiliado && p.opciones.some((x) => x.precioAfiliado)) valor.push('Si entrenas en el club (afiliada/o) aplica el valor de afiliados; cuéntame cuál es tu caso.');
    const como = cuentas.length ? comoPagar(cuentas).replace(/\n+$/, '') : null;
    const pagar = como
        ? `Transfiere ${como}${como.includes('\n') ? '' : '.'}`
        : SIN_CUENTAS_DE_PAGO;
    return [
        `Para separar tu cupo ${enElServicio(item)}:`,
        valor.join('\n'),
        pagar,
        como ? cierre : `Cuando pagues, ${cierre.charAt(0).toLowerCase()}${cierre.slice(1)}`,
    ].filter(Boolean).join('\n\n');
}

/**
 * El cierre del mensaje de pago según lo que YA se sabe de quien asiste (2026-11-16): pide de una vez, con el
 * comprobante, SOLO los datos de registro que faltan; lo que ya está en la ficha no se vuelve a pedir. Pura.
 */
export function cierreDePagoSegunRegistro(faltan: DatoFaltante[], d: Pick<DatosDeRegistro, 'nombre' | 'acudiente' | 'edad'>): string {
    const pide: string[] = [];
    if (faltan.includes('nombre')) pide.push('el nombre completo');
    if (faltan.includes('fecha_nacimiento')) pide.push('la fecha de nacimiento');
    if (!pide.length && !faltan.includes('acudiente')) {
        return `Envía aquí la foto del comprobante y te confirmamos el cupo${d.nombre ? ` de *${d.nombre}*` : ''}.`;
    }
    const deQuien = faltan.includes('nombre') || !d.nombre ? 'de quien asiste' : `de *${d.nombre}*`;
    // Todavía no se sabe si es menor: se avisa que, si lo es, también va la persona responsable.
    const siEsMenor = faltan.includes('fecha_nacimiento') && !faltan.includes('acudiente') && !d.acudiente && d.edad === null
        ? ' (si es menor de edad, también el nombre de la persona responsable)' : '';
    const datos = pide.length ? `${pide.join(' y ')} ${deQuien}${siEsMenor}` : '';
    const responsable = faltan.includes('acudiente')
        ? `${datos ? ' y ' : ''}el nombre de la persona responsable${datos ? '' : ` ${deQuien}`}` : '';
    return `Envía aquí la foto del comprobante con ${datos}${responsable} y te confirmamos el cupo.`;
}

/** El servicio no tiene precio cargado: no se inventa. Pura. */
export function textoSinPrecioDeServicio(item: ItemConFicha): string {
    return `El valor ${deLaDelServicio(item)} te lo confirma la escuela por aquí. Ya le pasé tu mensaje 🙌`;
}

/** La línea del saludo en una venta (nunca el menú de sedes ni la clase de prueba). Pura. */
export function lineaDeSaludoDeVenta(item: ItemConFicha): string {
    return `¿Te ayudo con algo ${deLaDelServicio(item)}? Si quieres separar tu cupo, te paso los datos.`;
}

export const TEXTO_A_LA_ESCUELA = 'Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta.';
export const TEXTO_A_LA_ESCUELA_REPETIDO = 'Anotado 🙌 También se lo paso a la escuela y te responde por aquí.';
/** Cierra una respuesta PARCIAL de la IA del servicio: lo que sí está ya se dijo; lo que falta lo confirma la escuela. */
export const TEXTO_LO_DEMAS_LA_ESCUELA = 'Lo demás te lo confirma la escuela por aquí 🙌';
export const TEXTO_OTRA_FECHA = 'Entiendo 🙌 Le paso tu mensaje a la escuela para que te cuente si hay otra opción; te responde por aquí.';
export const TEXTO_YA_PAGO = '¡Perfecto! Envía aquí la foto o el PDF del comprobante con el nombre completo de quien asiste y te confirmamos el cupo.';
export const TEXTO_COMPROBANTE_YA_RECIBIDO = 'Ya tenemos tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.';
export const TEXTO_CUPO_CON_PAGO =
    'Sí 🙌 Con el pago (o el abono mínimo) y el comprobante con el nombre completo de quien asiste, la escuela lo valida y te confirma el cupo por aquí.';

/** La salida a «entrar al club» que se le deja abierta a quien está en una venta (sin nombrar la clase de prueba). */
export const SALIDA_AL_CLUB = 'Si lo que buscas es entrar al club, escríbemelo y te cuento aparte.';

/**
 * La respuesta a un botón viejo de un flujo del CLUB tocado en plena venta (Monster
 * 2026-11-08, Nicolás: pagó la clínica, tocó «⚫ Sede Suba» de un mensaje anterior y
 * terminó con una clase de prueba de $15.000 que nunca pidió). El botón no avanza
 * nada: se sigue en la venta. `pagado`: ya mandó el comprobante. Pura.
 */
export function textoBotonDelClubEnVenta(item: ItemConFicha, o: { pagado: boolean }): string {
    const seguimos = `Ese botón era de un mensaje anterior 🙌 Seguimos con lo ${deLaDelServicio(item)}`;
    return o.pagado
        ? `${seguimos}: la escuela valida tu comprobante y te confirma el cupo por aquí. ${SALIDA_AL_CLUB}`
        : `${seguimos}. ¿Te paso los datos para separar tu cupo? ${SALIDA_AL_CLUB}`;
}

/**
 * Pidió el club por TEXTO en plena venta («quiero la clase de prueba», «entrar al
 * club»): antes de agendar nada se le dice que va aparte del servicio y cuánto cuesta
 * (Nicolás terminó pagando $15.000 creyendo que eran parte de la clínica). Pura.
 */
export function textoClubAparteDeLaVenta(item: ItemConFicha, t: Pick<TextosClase, 'nombre' | 'precio' | 'gratis'>): string {
    const valor = t.gratis || !t.precio ? 'que es gratis' : `que cuesta *${t.precio}*`;
    return `Claro 🙌 Lo del club va aparte ${deLaDelServicio(item)}: para empezar se agenda una *${t.nombre}*, ${valor}.`;
}

// ─── Los datos de quien asiste (pura) ───────────────────────────────────────

/** Año de nacimiento, fecha («18 de diciembre del 2006», «18/12/2006»), edad o posición de juego. */
const DATO_DE_ASISTENTE = new RegExp('\\b(' + [
    '(19|20)\\d{2}',
    '\\d{1,2} \\d{1,2}( \\d{2,4})?',
    '\\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)',
    'armador|armadora|opuesto|opuesta|atacante|atacantes|central|libero|punta|receptor|receptora|levantador|levantadora',
    '\\d{1,2} anos',
].join('|') + ')\\b');

/** «…el nombre completo de quien asiste»: el bot ya lo pidió (un nombre suelto es la respuesta). */
const PIDE_NOMBRE_DE_ASISTENTE = /nombre completo de quien asiste|datos de quien asiste|nombre completo y la fecha de nacimiento de quien asiste/i;
/** Palabras de cortesía que `nombreDeAsistente` deja pasar y que, solas, no son un nombre («Mucho gusto»). */
const NO_ES_NOMBRE_SUELTO = /\b(mucho|mucha|muchos|gusto|feliz|saludos|bendiciones|igualmente|amable|amables|tranquilo|tranquila|hecho|ahora|luego|despues|manana|hoy|ayer|claro|verdad|seguro|segura)\b/;

/** Los pasos de la cola con que se pregunta por quien asiste (whatsapp-comprobante-de-ficha). */
const PASOS_QUE_PREGUNTAN_POR_ASISTENTE: ReadonlySet<string> = new Set(['ask_asistente_servicio', 'ask_asistente_confirmar']);
/** Partículas de un nombre: no cuentan como palabra («María de los Ángeles» son dos). */
const PARTICULA_DE_NOMBRE = /^(de|del|la|las|los|y|da|do|dos|van|von|der|san|santa)$/;

/**
 * Qué fue lo ÚLTIMO que dijo el bot respecto de quien asiste (auditoría 8–16 nov 2026: el cierre del mensaje de pago
 * dice «…con el nombre completo de quien asiste», así que cualquier texto de dos palabras después del bloque de pago
 * se tomaba como nombre). Pura.
 *  · 'pregunta': una pregunta de datos de verdad — la de la cola (`ask_asistente_servicio`, `ask_asistente_confirmar`),
 *    «¿para quién es el pago?» de varios nombres, la respuesta a «ya pagué» que pide el nombre, o cualquier saliente
 *    que pida el nombre (`faltan_datos` con 'nombre') y NO sea el bloque de pago. También un texto sin paso que lo
 *    pide (lo escribió la escuela).
 *  · 'mencion': solo lo menciona (el bloque de pago, una respuesta libre): ahí un nombre suelto vale únicamente si es
 *    firme (tres palabras o más).
 *  · null: no pidió nada.
 */
export function ultimoSalienteSobreAsistente(recientes: FilaReciente[]): 'pregunta' | 'mencion' | null {
    const ultimo = [...recientes].filter((f) => f.direction === 'outbound').sort((a, b) => momento(b) - momento(a))[0];
    if (!ultimo) return null;
    const paso = String(ultimo.payload?.step ?? '');
    const loDice = PIDE_NOMBRE_DE_ASISTENTE.test(String(ultimo.text_body ?? ''));
    if (PASOS_QUE_PREGUNTAN_POR_ASISTENTE.has(paso) || paso === PASO_VENTA.VARIOS_ASISTENTES) return 'pregunta';
    if (paso !== PASO_VENTA.PAGO) {
        const faltan = ultimo.payload?.faltan_datos;
        // Solo si lo que falta es el NOMBRE: con la fecha o la persona responsable pendientes, un nombre suelto es el acudiente.
        if (Array.isArray(faltan) && faltan.includes('nombre')) return 'pregunta';
    }
    if ((paso === PASO_VENTA.YA_PAGO || !paso) && loDice) return 'pregunta';
    return loDice ? 'mencion' : null;
}

/**
 * ¿El mensaje son los DATOS DE QUIEN ASISTE al servicio? («Nicolás Cubides Ávila /
 * 18 de Diciembre del 2006 / Opuesto»: antes «Eso te lo confirma la escuela».) Un
 * nombre de dos palabras o más al comienzo (`nombreDeAsistente`: «Sede Suba»,
 * «Hombre», «Club y torneos» no lo son) y además: una fecha, un año, una edad o una
 * posición después del nombre; o el mensaje es SOLO el nombre y lo último que dijo
 * el bot fue de verdad una pregunta de datos (`ultimoSalienteSobreAsistente`). Tras
 * el bloque de pago, que solo lo menciona, el nombre suelto tiene que ser firme
 * (tres palabras o más). null = no lo es. Pura.
 */
export function datosDeAsistenteEnVenta(texto: string | null | undefined, recientes: FilaReciente[] = []): { nombre: string } | null {
    const crudo = String(texto ?? '').trim();
    if (!crudo || crudo.length > 200 || /[?¿]/.test(crudo)) return null;
    const nombre = nombreDeAsistente(crudo);
    if (!nombre) return null;
    const sinNombre = ` ${normalizarFrase(crudo)} `.replace(` ${normalizarFrase(nombre)} `, ' ');
    if (DATO_DE_ASISTENTE.test(sinNombre)) return { nombre };
    if (!nombreDeAsistente(crudo, { entero: true }) || NO_ES_NOMBRE_SUELTO.test(normalizarFrase(nombre))) return null;
    const pidio = ultimoSalienteSobreAsistente(recientes);
    if (pidio === 'pregunta') return { nombre };
    const palabras = nombre.split(' ').filter((w) => !PARTICULA_DE_NOMBRE.test(w.toLowerCase())).length;
    return pidio === 'mencion' && palabras >= 3 ? { nombre } : null;
}

/** «¡Gracias! 🙌 Anoté a *Nicolás Cubides Ávila* como asistente de la Clínica…» + el pago con una pregunta o la validación. Pura. */
export function textoAsistenteAnotado(
    item: ItemConFicha, nombre: string, o: { pagado: boolean; guardado?: boolean; capturaIncompleta?: boolean },
): string {
    // (R6) «Anoté» solo si de verdad quedó guardado en la ficha; si no, se agradece sin afirmarlo.
    const anotado = o.guardado === false
        ? `¡Gracias! 🙌 La escuela ve en este chat que asiste *${nombre}*.`
        : `¡Gracias! 🙌 Anoté a *${nombre}* como asistente ${deLaDelServicio(item)}.`;
    if (o.pagado && o.capturaIncompleta) return `${anotado} ${TEXTO_FALTA_PANTALLA_COMPLETA}`;
    return o.pagado
        ? `${anotado} La escuela valida tu comprobante y te confirma el cupo por aquí.`
        : `${anotado} ¿Te paso los datos para separar el cupo?`;
}

/** Mandó una captura sin fecha ni número de comprobante y todavía no llega la pantalla completa. */
export const TEXTO_FALTA_PANTALLA_COMPLETA = 'Me falta la pantalla completa del pago, con la fecha y el número del comprobante.';

// ─── Los datos de registro en la venta (2026-11-16) ─────────────────────────

/** El paso con que la cola pidió la pantalla completa (`PASO_VENTA_INCOMPLETO` de whatsapp-comprobante-de-ficha). */
const PASO_CAPTURA_INCOMPLETA = 'venta_comprobante_incompleto';

/**
 * ¿La cola pidió la pantalla completa del pago y todavía no llegó otro archivo? (captura «¡Transferencia exitosa!»
 * recortada: sin fecha ni número de comprobante). Pura.
 */
export function capturaIncompletaPendiente(recientes: FilaReciente[], ahora = Date.now()): boolean {
    const desde = ahora - 24 * 3600_000;
    const pedido = Math.max(0, ...recientes
        .filter((f) => f.direction === 'outbound' && f.payload?.step === PASO_CAPTURA_INCOMPLETA && momento(f) >= desde).map(momento));
    if (!pedido) return false;
    return !recientes.some((f) => f.direction === 'inbound' && (f.type === 'image' || f.type === 'document') && momento(f) > pedido);
}

/**
 * Lo que el bot le pidió y sigue pendiente: los datos de registro del último saliente que los pidió
 * (`payload.faltan_datos`), en las últimas 24 h. null = no hay nada pedido. Pura.
 */
export function datosPedidosPendientes(recientes: FilaReciente[], ahora = Date.now()): DatoFaltante[] | null {
    const desde = ahora - 24 * 3600_000;
    const ultimo = [...recientes]
        .filter((f) => f.direction === 'outbound' && Array.isArray(f.payload?.faltan_datos) && momento(f) >= desde)
        .sort((a, b) => momento(b) - momento(a))[0];
    const lista = (ultimo?.payload?.faltan_datos ?? []) as DatoFaltante[];
    return lista.length ? lista : null;
}

/**
 * ¿Ya se le repitió, después del último archivo, lo que falta? (`payload.pide_datos`): «Ya pagué» con la pregunta
 * abierta repregunta UNA sola vez. Pura.
 */
export function yaSeRepreguntoPorLosDatos(recientes: FilaReciente[], ahora = Date.now()): boolean {
    const desde = ahora - 24 * 3600_000;
    const archivo = Math.max(desde, ...recientes
        .filter((f) => f.direction === 'inbound' && (f.type === 'image' || f.type === 'document')).map(momento));
    return recientes.some((f) => f.direction === 'outbound' && f.payload?.pide_datos === true && momento(f) >= archivo);
}

/** «Ya tengo tu comprobante 📄 Para completar la inscripción a *X* solo me falta …» (o la captura incompleta). Pura. */
export function textoYaTengoTuComprobante(
    item: Pick<ItemConFicha, 'name'>, faltan: DatoFaltante[], registro: DatosDeRegistro | null, o: { capturaIncompleta?: boolean } = {},
): string {
    const pedido = pedidoDeFaltantes(faltan, registro, item.name);
    if (o.capturaIncompleta) {
        return `Ya tengo tu captura 📄 Le faltan la fecha y el número del comprobante: envíame la pantalla completa del pago, por favor.${pedido ? `\n\n${pedido}` : ''}`;
    }
    return pedido ? `Ya tengo tu comprobante 📄 ${pedido}` : TEXTO_COMPROBANTE_YA_RECIBIDO;
}

/** «anoté / registré / guardé…»: el bot de la venta no guarda nada con un texto libre. */
const DICE_QUE_GUARDO = new RegExp('(?<![a-záéíóúñ])(?:anot[ée]|registr[ée]|guard[ée]|tom[ée] nota|(?:he|hemos) (?:anotado|registrado|guardado)|'
    + '(?:qued[oó]|quedan|queda|quedaron) (?:anotad|registrad|guardad)[oa]s?)(?![a-záéíóúñ])', 'i');
/** «envía aquí la foto / el PDF / el comprobante…». */
const PIDE_EL_COMPROBANTE = new RegExp('(?<![a-záéíóúñ])(?:env[ií][ae](?:me|nos|lo|la)?|m[aá]nd[ae](?:me|nos|lo)?|adj[uú]nt[ae](?:me|lo)?|'
    + 'comp[aá]rt[ae](?:me|nos|lo)?|sube|necesito|falta)(?![a-záéíóúñ])[^.!?\\n]*(?<![a-záéíóúñ])(?:foto|pdf|comprobante|soporte|captura|pantallazo|recibo)(?![a-záéíóúñ])', 'i');

/**
 * La red de la respuesta LIBRE (la IA del servicio) en la venta (R6): fuera las frases que dicen que algo quedó
 * anotado/registrado/guardado (el modelo no guarda nada) y, si ya llegó un archivo en esta venta, las que piden el
 * comprobante otra vez. `quito`: se sacó algo. `texto` null: no quedó nada que decir. Pura.
 */
export function limpiarRespuestaDeVenta(texto: string, o: { pagado: boolean }): { texto: string | null; quito: boolean } {
    const frases = String(texto ?? '').split(/(?<=[.!?…])\s+|\n+/).map((f) => f.trim()).filter(Boolean);
    const buenas = frases.filter((f) => !DICE_QUE_GUARDO.test(f) && !(o.pagado && PIDE_EL_COMPROBANTE.test(f)));
    if (buenas.length === frases.length) return { texto: String(texto ?? '').trim() || null, quito: false };
    return { texto: buenas.join(' ').trim() || null, quito: true };
}

/**
 * El seguimiento de ~20 h de una venta: DETERMINISTA (sin IA y sin la clase de
 * prueba), con el precio de hoy y la fecha correcta del tramo (Monster 2026-11-08:
 * la IA escribió «preventa hasta el 9» y ofreció la clase de prueba a interesados
 * de la clínica). Si ya recibió los datos de pago, le recuerda el comprobante; si
 * ya mandó el comprobante, null (no hay nada que recordar). Pura.
 */
export function textoSeguimientoDeVenta(
    item: ItemConFicha,
    o: { recientes: FilaReciente[]; afiliado: boolean; hoy: string; ahora?: number },
): string | null {
    if (comprobanteRecibido(o.recientes, 24 * 60, o.ahora ?? Date.now())) return null;
    // Dijo que no va («estoy en otra ciudad», «no puedo») y no volvió a pedir nada de la venta: no se le insiste.
    const ultimoDe = (pasos: string[]) => Math.max(0, ...o.recientes
        .filter((f) => f.direction === 'outbound' && pasos.includes(String(f.payload?.step ?? ''))).map(momento));
    const desistio = ultimoDe([PASO_VENTA.DESISTE]);
    if (desistio && desistio > ultimoDe([PASO_VENTA.PAGO, PASO_VENTA.OPCION, PASO_VENTA.ASISTENTE])) return null;
    const conDatos = o.recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.PAGO);
    if (conDatos) {
        // La fecha límite del precio SÍ es real (sale de los tramos del catálogo): el último día se dice (Monster 2026-11-09).
        const pd = precioDelServicio(item, { afiliado: o.afiliado, hoy: o.hoy });
        let urgencia = '';
        if (pd.hoy !== null && pd.siguiente && !pd.opciones.length && !pd.deAfiliado) {
            const dias = Math.round((Date.parse(`${pd.siguiente.desde.slice(0, 10)}T12:00:00Z`) - Date.parse(`${o.hoy.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
            if (dias === 1) {
                urgencia = ` ⏳ El valor de *${cop(pd.hoy)}* termina *hoy*: desde mañana, *${cop(pd.siguiente.precio)}*.`
                    + (pd.abono !== null ? ` Con el abono de *${cop(pd.abono)}* mantienes ese valor.` : '');
            } else if (dias >= 2 && dias <= 3) {
                urgencia = ` ⏳ El valor de *${cop(pd.hoy)}* va ${textoDelTramo(pd.siguiente)}.`;
            }
        }
        return `Hola 👋 ¿Pudiste hacer el pago ${deLaDelServicio(item)}?${urgencia} Cuando lo hagas, ${CIERRE_DE_PAGO.charAt(0).toLowerCase()}${CIERRE_DE_PAGO.slice(1)}`;
    }
    const p = precioDelServicio(item, { afiliado: o.afiliado, hoy: o.hoy });
    let valor = '';
    if (p.opciones.length) valor = ` Los valores van desde *${cop(Math.min(...p.opciones.map((x) => x.precio)))}*.`;
    else if (p.hoy !== null) {
        valor = p.deAfiliado
            ? ` Tu valor como afiliado es *${cop(p.hoy)}*.`
            : ` El valor hoy es *${cop(p.hoy)}*${p.siguiente ? ` ${textoDelTramo(p.siguiente)}` : ''}.`;
    }
    return `Hola 👋 ¿Pudiste revisar la información ${deLaDelServicio(item)}?${valor} ` +
        'Si quieres separar tu cupo, respóndeme y te paso los datos de pago.';
}

// ─── Intención del mensaje dentro de una venta (pura) ───────────────────────

export type IntencionVenta = 'pago' | 'ya_pago' | 'otra_fecha' | 'saludo' | 'cierre' | 'detalle' | 'club' | 'anuncio' | 'desiste';

const YA_PAGO = new RegExp('\\b(' + [
    'ya (le |les |te )?(pague|pagamos|transferi|transferimos|consigne|consignamos|cancele|cancelamos|abone|abonamos)',
    'ya (la|lo) (pague|pagamos|transferi|consigne|cancele)',
    'ya (hice|hicimos|realice|realizamos|envie|mande) (el )?(pago|abono|la transferencia)',
    'ya (esta|quedo) (pago|paga|pagada|pagado)',
    'acab(o|amos) de (pagar|transferir|consignar|abonar|hacer el pago|hacer la transferencia)',
    'acabad[oa] de pagar',
    '(te|les|le) (envio|mando|paso|adjunto|comparto) (el |la )?(comprobante|soporte|pago|recibo|transferencia|captura|pantallazo)',
    '(envio|adjunto|mando|comparto) (el |la )?(comprobante|soporte|recibo|captura|pantallazo)',
    '(aqui|aca) (esta|va|te va|le va|les va) (el |la )?(comprobante|soporte|pago|transferencia|abono)',
    'ya (te |les |le )?(envie|mande|pase) (el |la )?(comprobante|soporte|pago|recibo|captura)',
    // (auditoría 8–16 nov 2026) «Pero, ya lo mandé», «ya lo envié», «ya la pasé», «ya lo adjunté», «ya lo subí»,
    // «ya hice el pago», «Es que yo aboné antes del 10 de noviembre».
    'ya (lo|la|los|las|se lo|se la|te lo|te la) (mande|mandamos|envie|enviamos|pase|pasamos|adjunte|adjuntamos|subi|subimos|comparti|hice|hicimos|abone|realice|gire)',
    'ya (adjunte|subi|gire|deposite|depositamos)( (el |la |un |una )?(comprobante|soporte|recibo|captura|pantallazo|pago|abono|transferencia|consignacion))?',
    '(?<!(?:quiere|quieren|para|necesita|necesitan|toca|desea|desean|espera|esperan|pide|piden) que )yo (ya )?(abone|pague|consigne|transferi|cancele|gire|deposite)',
].join('|') + ')\\b');

const OTRA_FECHA = new RegExp('\\b(' + [
    'otra fecha', 'otras fechas', 'otro dia', 'otros dias', 'otra edicion', 'nueva fecha',
    'proxima (fecha|edicion|clinica|vez)', 'cambiar (la |de )?fecha',
    'no (puedo|podemos|puede|pueden|alcanzo|alcanzamos|voy a poder|vamos a poder) (ir |asistir |llegar )?(ese|esos|el|los|este|estos|esa|esas) (dia|dias|fin|sabado|domingo|fecha|fechas|semana)',
    '(tenemos|tengo|tiene|tienen) (un |una )?(torneo|partido|campeonato|viaje|compromiso|evento|juego)',
    'se (me |nos |le )?cruza', 'cruza con',
    '(van a|vuelven a|piensan) (hacer|repetir|abrir) otra', 'hay otra (fecha|clinica|edicion)',
].join('|') + ')\\b');

/** «¿Con el pago ya tengo el cupo?»: una duda del proceso, no un pedido de datos. */
const CONFIRMACION_CUPO = /\b(con (el|ese|este) (pago|abono)|ya (tengo|tendria|tendriamos|queda|quedaria|quedo) (el |mi |su |nuestro )?cupo|queda (separado|reservado|confirmado|apartado)|(me|nos) (confirman|confirmas|confirma) (el )?cupo|cupo (queda )?(confirmado|asegurado))\b/;
const INCLUYE = /\b(incluye|incluyen|incluido|incluida|incluidos|incluidas|viene con)\b/;
const DATOS_DE_PAGO_EXPLICITOS = /\b(titular|cuenta|nequi|daviplata|llave|bre b|breb|datos|transferir|transferencia|consignar)\b/;

const PAGO = new RegExp('\\b(' + [
    'cuanto (vale|valen|cuesta|cuestan|es|son|sale|salen|seria|serian|queda|cobran|hay que pagar)',
    'costo', 'costos', 'cuesta', 'cuestan', 'valor', 'valores', 'precio', 'precios', 'inversion', 'tarifa', 'tarifas',
    'apart(ar|o|arlo|arla|amos|e)', 'separ(ar|o|arlo|arla|amos|e)', 'reserv(ar|o|arlo|arla|amos|a|e)',
    'pag(ar|arlo|arla|amos|aria)', 'abono', 'abonar', 'cuotas',
    'como (pago|se paga|puedo pagar|hago el pago|hago para pagar|cancelo)',
    'donde (pago|se paga|puedo pagar|consigno|transfiero)', 'medios? de pago',
    'datos', 'numero de (cuenta|nequi|daviplata)', 'cuenta (bancaria|de ahorros|corriente|nequi|daviplata)',
    '(la|una|su|tu|que|cual|a que) cuenta', 'titular', 'a nombre de quien', 'nombre de quien',
    'llave', 'llaves', 'bre b', 'breb', 'nequi', 'daviplata', 'bancolombia', 'transferencia', 'transferir',
    'consignar', 'consignacion', 'me interesa', 'nos interesa',
    'quiero (ir|asistir|participar|inscribir|inscribirme|inscribirla|inscribirlo|inscribirlos|reservar|apartar|separar|el cupo|un cupo|cupo|pagar)',
    'queremos (ir|asistir|participar|inscribir|inscribirnos|reservar|apartar|separar)',
    'inscribirme', 'inscribirla', 'inscribirlo', 'inscribir a',
    'como (me |la |lo |nos )?inscribo', 'como (me |la |lo |nos )?inscribimos',
    'como hago para (inscribirme|inscribirla|inscribirlo|ir|participar|reservar|apartar|separar|pagar)',
].join('|') + ')\\b');

/** «Sí», «claro», «dale», «de una» sueltos: sí quiere (la ficha o la campaña preguntaron si separa el cupo). */
const AFIRMACION = /^(si|si senor|si senora|si claro|claro|claro que si|dale|de una|si porfa|si por favor|porfa|por favor|obvio|sip|sisas|listo si|si quiero|si me interesa|si envíame|si enviame|si la info|si quiero la info|si mandame|si enviame la info)$/;

/** Tratos y muletillas que acompañan un saludo o un anuncio: «Profe», «disculpa», «por favor». */
const VOCATIVO = '(?:profe|profesor|profesora|senor|senora|senorita|sr|sra|don|dona|amigo|amiga|estimados?|disculpa|disculpe|disculpen|perdon|que pena|oye|oiga|mira|mire|por favor|porfa|porfis)';
const SALUDO_PREVIO = '(?:hola|ola|holi|holis|buenas|buenos dias|buenas tardes|buenas noches|buen dia|hey)';

/**
 * Un ANUNCIO de pregunta sin la pregunta (auditoría 8–16 nov 2026: «Profe una pregunta», «Me puedes confirmar»,
 * «Seria?» terminaban en «Ya le pasé tu pregunta» a la escuela): «Buenas, tengo una pregunta», «una consulta»,
 * «me puedes ayudar», «disculpa». El mensaje ENTERO es el anuncio.
 */
const ANUNCIA_PREGUNTA = new RegExp(`^(?:(?:${SALUDO_PREVIO}|${VOCATIVO}) )*(?:` + [
    '(?:tengo|tenemos|una|otra|con una|para una|te hago|le hago|les hago|(?:quiero|quisiera|queria|puedo) hacer(?:te|le|les)?) (?:una |unas |otra |la )?(?:pregunta|preguntas|preguntica|preguntita|duda|dudas|consulta|consultas|inquietud|inquietudes)',
    '(?:me|nos) (?:puedes|puede|pueden|podrias|podria|podrian) (?:confirmar|ayudar|colaborar|informar|decir|contar|explicar|orientar|dar informacion|regalar informacion)(?: algo| una cosa| con algo)?',
    'seria|sera|o sea|osea|una cosa|una cosita',
].join('|') + `)(?: ${VOCATIVO})*$`);
/** Solo llama («Profe», «Disculpa», «Oye»): también se le contesta «Claro, dime». «Hola profe» es un saludo. */
const SOLO_LLAMA = /^(?:profe|profesor|profesora|disculpa|disculpe|disculpen|perdon|que pena|oye|oiga|mira|mire)(?: (?:profe|profesor|profesora))?$/;

/**
 * DESISTE (auditoría 8–16 nov 2026: «Estoy en otra ciudad», «Lo siento es que yo estoy ubicada en cartagena», «no
 * puedo», «no me queda»): no va a comprar. Cierre amable, sin derivar a la escuela y sin insistir.
 */
const DESISTE = new RegExp('\\b(?:' + [
    '(?:estoy|estamos|vivo|vivimos|resido|me encuentro|nos encontramos|soy|somos) (?:ubicad[oa]s? |radicad[oa]s? |viviendo |actualmente |ahora )*(?:en|de|fuera de) (?:otra|otro) (?:ciudad|pais|departamento|municipio)',
    '(?:estoy|estamos|me encuentro|nos encontramos) (?:ubicad[oa]s?|radicad[oa]s?|viviendo) (?:en|fuera)',
    '(?:vivo|vivimos|resido) (?:fuera|lejos|muy lejos)',
    'fuera de (?:la ciudad|el pais|del pais|bogota|colombia)',
    '(?:me|nos) queda (?:muy |super |re |demasiado |bastante )?(?:lejos|retirado|dificil)',
    'no (?:me|nos) queda(?: bien| cerca| facil| posible)?$',
    'no (?:puedo|podemos|podre|podremos|voy a poder|vamos a poder|alcanzo|alcanzamos)(?: ir| asistir| participar| llegar)?(?: gracias| muchas gracias| lo siento| que pena| disculpa)*$',
    'ya no (?:me interesa|nos interesa|quiero|queremos|voy|vamos|puedo|podemos)',
    'no (?:me|nos) interesa', 'no estoy interesad[oa]', 'no estamos interesad[oa]s', 'no gracias', 'no por ahora', 'por ahora no',
    'en otra ocasion', 'sera en otra (?:ocasion|oportunidad)', 'para la proxima', 'lo dejamos (?:asi|para despues)',
].join('|') + ')');

/** «Bueno» (o «Hueno», el dedo al lado): un acuse, no una pregunta. */
const BUENO_SUELTO = /^(?:bueno|hueno|buemo|vueno|weno|bno|bn)(?: (?:senor|senora|profe|gracias|listo|pues|entonces))*$/;

const VOCABULARIO_SALUDO = new Set([
    'hola', 'ola', 'holi', 'holis', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches',
    'ok', 'okey', 'okay', 'oki', 'k', 'vale', 'hey', 'ey', 'hi', 'hello', 'saludos', 'que', 'tal', 'como', 'estas',
    'esta', 'estan', 'bien', 'y', 'usted', 'ustedes',
]);
const VOCABULARIO_CIERRE = new Set([
    ...VOCABULARIO_SALUDO, 'gracias', 'muchas', 'mil', 'muchisimas', 'quedo', 'quedamos', 'atento', 'atenta', 'atentos',
    'atentas', 'pendiente', 'pendientes', 'listo', 'lista', 'listos', 'perfecto', 'perfecta', 'excelente', 'genial',
    'super', 'entendido', 'entendida', 'entiendo', 'de', 'acuerdo', 'dale', 'bueno', 'buena', 'muy', 'amable',
    'amables', 'este', 'estes', 'feliz', 'bendiciones', 'igualmente', 'a', 'ti', 'por', 'la', 'el', 'info',
    'informacion', 'todo', 'eso', 'era', 'chao', 'bye', 'adios', 'gusto', 'mucho', 'un', 'abrazo', 'si', 'va',
    'senor', 'senora', 'profe',
    // (auditoría 8–16 nov 2026) «Gracias de todas formas», «Listo profe yo les digo», «Hueno».
    'todas', 'formas', 'todos', 'modos', 'maneras', 'igual', 'yo', 'les', 'le', 'te', 'nos', 'digo', 'aviso', 'cuento',
    'escribo', 'comento', 'luego', 'despues', 'mas', 'rato', 'entonces', 'cualquier', 'cosa', 'pues', 'ahi', 'hueno',
    'buemo', 'vueno', 'weno',
]);
const NUCLEO_CIERRE = new Set([
    'gracias', 'atento', 'atenta', 'atentos', 'atentas', 'pendiente', 'pendientes', 'listo', 'lista', 'perfecto',
    'perfecta', 'excelente', 'genial', 'entendido', 'entendida', 'entiendo', 'acuerdo', 'chao', 'bye', 'adios',
    'bendiciones', 'igualmente', 'super',
    // «yo les digo», «ya les aviso», «luego les cuento»: se despide, no pregunta.
    'digo', 'aviso', 'cuento', 'escribo', 'comento',
]);
const EMOJI_DE_CIERRE = /[🙏🙌❤💪👏😊🤗🥰💙💚💛]/u;

/** Con qué abre un saludo con vocativo («Hola Felipe buenos días»). */
const ABRE_SALUDO = new Set(['hola', 'ola', 'holi', 'holis', 'buenas', 'buenos', 'buen', 'hey', 'ey', 'hi', 'hello', 'saludos']);
const TRATO = new Set(['profe', 'profesor', 'profesora', 'senor', 'senora', 'senorita', 'sr', 'sra', 'don', 'dona', 'amigo', 'amiga']);

/**
 * «Hola Felipe buenos días», «Buenas tardes profe», «Hola señora Milena»: un saludo con el nombre o el trato de
 * quien atiende, sin nada más (antes: «Ya le pasé tu pregunta»). Abre con un saludo y lo que no es saludo ni trato
 * son, como mucho, dos palabras que pueden ser de un nombre («Hola horarios», «Buenas, precio» NO lo son). Pura.
 */
function saludoConVocativo(palabras: string[]): boolean {
    if (palabras.length < 2 || palabras.length > 7 || !ABRE_SALUDO.has(palabras[0])) return false;
    const resto = palabras.filter((w) => !VOCABULARIO_SALUDO.has(w) && !TRATO.has(w));
    return resto.length <= 2 && resto.every((w) => puedeSerPalabraDeNombre(w));
}

/**
 * La intención de un mensaje dentro de una venta. Pura.
 *  · club: pide el club de forma explícita (`pideElClub`) → sale de la venta.
 *  · ya_pago: «ya pagué», «te envío el comprobante», «ya consigné», «ya lo mandé», «yo aboné antes del 10».
 *  · otra_fecha: «no puedo ese día», «¿hay otra fecha?», «tenemos torneo».
 *  · desiste: «estoy en otra ciudad», «no puedo», «no me queda», «no me interesa».
 *  · cierre: «gracias», «quedo atento», «listo», «🙏», «gracias de todas formas», «listo profe yo les digo».
 *  · saludo: «hola», «ok», «.», «buenas», «👍», «Hola Felipe buenos días».
 *  · anuncio: anuncia una pregunta sin hacerla («tengo una pregunta», «profe una pregunta», «me puedes confirmar»).
 *  · pago: cuánto / costo / valor / precio / apartar / separar / reservar / pagar /
 *    datos / cuenta / titular / llave / Nequi / Daviplata / transferir / «sí» /
 *    «me interesa» / «quiero ir (inscribirme, reservar)».
 *  · detalle: cualquier otra pregunta («¿incluye grupo femenino?», «¿con el pago
 *    ya tengo el cupo?», «¿desde qué edad?»).
 */
export function intencionEnVenta(texto: string | null | undefined): IntencionVenta {
    const crudo = String(texto ?? '').trim();
    if (pideElClub(crudo)) return 'club';
    const t = normalizarFrase(crudo).replace(/([a-z])\1{2,}/g, '$1');
    if (!t) {
        // Solo signos o emojis: «.», «?», «👍» saludan; «🙏», «🙌» agradecen.
        return EMOJI_DE_CIERRE.test(crudo) ? 'cierre' : 'saludo';
    }
    if (YA_PAGO.test(t)) return 'ya_pago';
    if (OTRA_FECHA.test(t)) return 'otra_fecha';
    const conPregunta = crudo.includes('?');
    if (!conPregunta && t.length <= 140 && DESISTE.test(t)) return 'desiste';
    if (CONFIRMACION_CUPO.test(t)) return 'detalle';
    const palabras = t.split(' ');
    if (!conPregunta && (BUENO_SUELTO.test(t)
        || (palabras.every((w) => VOCABULARIO_CIERRE.has(w)) && palabras.some((w) => NUCLEO_CIERRE.has(w))))) {
        return 'cierre';
    }
    if (palabras.every((w) => VOCABULARIO_SALUDO.has(w))) return 'saludo';
    if (ANUNCIA_PREGUNTA.test(t) || SOLO_LLAMA.test(t)) return 'anuncio';
    if (AFIRMACION.test(t)) return 'pago';
    if (INCLUYE.test(t) && !DATOS_DE_PAGO_EXPLICITOS.test(t)) return 'detalle';
    if (NO_AFILIADO.test(t)) return 'pago';
    if (PAGO.test(t)) return 'pago';
    if (!conPregunta && saludoConVocativo(palabras)) return 'saludo';
    return 'detalle';
}

/**
 * (Monster 2026-11-20, un proveedor) Un mensaje que COBRA a la escuela: «me colaboras con un pago pendiente que tenemos
 * de $245.000», «puedes pagar en este enlace», factura, cuenta de cobro. No es un cliente que quiere pagar: no inicia
 * venta ni recibe datos de pago; pasa a la escuela. Con el nombre o el tema del servicio («pago de la clínica») es de un
 * cliente y NO entra aquí. Pura.
 */
export function reclamaPagoALaEscuela(texto: string | null | undefined, item?: Pick<ItemDeServicio, 'name'> | null): boolean {
    const t = normalizarFrase(texto);
    if (!t) return false;
    const url = /:\/\/|www\.|\b[a-z0-9-]+\.(?:com|co|net|org|io|app|link|me|ly|info|biz|site|online|page|pay|cc|ws)\b/.test(String(texto ?? '').toLowerCase());
    const fuerte = /\b(factura|facturas|cuenta de cobro|cuentas de cobro|orden de compra|remision|pago pendiente|saldo pendiente|deuda pendiente)\b/.test(t);
    const reclama = fuerte
        || /\b(me|nos) (deben|adeudan)\b|\b(pendiente|pendientes) (de )?(pago|pagarme|pagarnos)\b|\b(que|para que) (la escuela|el club|ustedes) (me |nos )?(pague|paguen|cancele|cancelen|consigne|consignen|gire|giren)\b|\b(pagarme|pagarnos|cancelarme|cancelarnos|girarme|girarnos)\b|\bpagar(me|nos)? en (este|el siguiente|ese) (enlace|link)\b|\b(me|nos) (colabora|colaboras|colaboran|ayuda|ayudas|ayudan|puede|puedes|pueden) (con|a) (el|un|su|ese|este) pago\b/.test(t);
    if (!reclama) return false;
    if (url || fuerte) return true;
    if (/\b(clinica|torneo|vacacional|campamento|inscripcion|inscribir|inscribirme|cupo|mensualidad|abono|apartar|separar|mi hij[oa])\b/.test(t)) return false;
    const nombre = normalizarFrase(item?.name);
    return !(nombre && nombre.length > 4 && t.includes(nombre));
}

/** ¿Pide los datos para pagar? (la ficha del anuncio manda el pago aparte solo si los pidió). Pura. */
export function pideDatosDePago(texto: string | null | undefined): boolean {
    return intencionEnVenta(texto) === 'pago';
}

/** «la cc», «cédula del titular», «NIT»: un dato que la escuela no configura (queda pendiente). */
const PIDE_DOCUMENTO_DEL_TITULAR = /\b(cc|c c|cedula|nit|documento|identificacion)\b/;
/** «¿A nombre de quién?», «titular». */
const PIDE_TITULAR = /\b(titular|a nombre de quien|nombre de quien)\b/;
/** «¿Por llave?», «Bre-B». */
const PIDE_LLAVE = /\b(llave|llaves|bre b|breb)\b/;

/** (auditoría Monster 14–16 nov 2026) El bloque de pago completo sale UNA vez; después, la línea con lo que pidió. */
export const MIN_BLOQUE_DE_PAGO_ENVIADO = 48 * 60;
/** «¿Puedo pagar hasta mañana?», «Puedo pagar mañana?», «¿hay plazo?»: pregunta por el plazo, no pide el bloque. */
const PIDE_PLAZO = /\b(hasta (manana|hoy|cuando|que (dia|fecha|hora)|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}))|plazo|fecha limite|ultimo dia|a mas tardar|(puedo|podemos|podria|podriamos|puede|pueden) (pagar|abonar|consignar|transferir) (manana|despues|luego|mas tarde|otro dia|la proxima semana)|pagar (manana|despues|luego|mas tarde)|(manana|pasado manana|hoy|esta semana|la proxima semana|el (lunes|martes|miercoles|jueves|viernes|sabado|domingo))\b[a-z0-9 ]{0,30}\b(puedo|podemos|podria|podriamos|puede|pueden) (pagar|abonar|consignar|transferir)|(puedo|podemos|podria|podriamos|puede|pueden) (pagar|abonar|consignar|transferir) (el (lunes|martes|miercoles|jueves|viernes|sabado|domingo)|hoy|pasado manana|esta semana))\b/;
/** «Ya me sale en la aplicación que estoy al día»: avisa que está al día; solo merece un acuse corto. */
const DICE_ESTAR_AL_DIA = /\b(estoy|estamos|quede|quedo|aparece|sale|figura)\b[a-z0-9 ]{0,40}\bal dia\b/;
const TEXTO_ACUSE_AL_DIA = '¡Qué bueno! 🙌 Gracias por avisarme. Si necesitas algo más, me escribes por aquí.';
/** «¿Me pasas el número de Nequi?», «¿a dónde consigno?», «los datos»: pide el dato de la cuenta. */
const PIDE_DATO_DE_CUENTA = /\b(nequi|daviplata|bancolombia|numero|cuenta|cuentas|titular|a nombre|nombre de quien|donde (pago|consigno|transfiero|se paga|puedo pagar)|a donde|datos)\b/;
/** «¿Y para NO afiliados?», «el vacacional para no afiliados»: pide la tarifa de quien no es del club. */
const NO_AFILIADO = /\b(no afiliad[oa]s?|no son afiliad[oa]s?|sin ser afiliad[oa]s?|no (soy|somos|estoy|estamos) afiliad[oa]s?|no (soy|somos) (del|parte del) club)\b/;

/**
 * ¿Pide EXPLÍCITAMENTE la tarifa de quien NO es afiliado? Solo ese sentido: decir «soy afiliado» no da el precio de
 * afiliado (eso lo decide el número, no el mensaje). Pura.
 */
export function pideTarifaDeNoAfiliado(texto: string | null | undefined): boolean {
    return NO_AFILIADO.test(normalizarFrase(texto));
}

// ─── Auditoría del vacacional (Monster 2026-11-22, antes de prender anuncios) ───────────────

const NUMERO_DE_CUPOS = '(?:dos|tres|cuatro|cinco|2|3|4|5)';
const QUIENES = '(?:ninos|ninas|hijos|hijas|hermanos|hermanas|hermanitos|hermanitas|cupos|personas|inscripciones|jovenes|chicos|chicas|sobrinos|sobrinas|primos|primas)';
const VARIOS_CUPOS = new RegExp(
    `\\b${NUMERO_DE_CUPOS} ${QUIENES}\\b|\\bson ${NUMERO_DE_CUPOS}\\b(?! (?:semanas?|dias?|horas?|meses|mil))|\\b(?:para|a|de) (?:los|las|mis) ${NUMERO_DE_CUPOS}\\b(?! (?:semanas?|dias?))`
    + `|\\bmis (?:hijos|hijas|ninos|ninas|sobrinos|sobrinas)\\b|\\bpara una y\\b|\\bpara uno y\\b|\\bl[oa]s hermanit?[oa]s\\b`);

/**
 * ¿Habla de inscribir a MÁS de una persona? («para dos hermanos cuánto es», «son dos niñas, 3 semanas cada una»,
 * «2 cupos», «mis hijos»). El cobro es por persona y lo arma la escuela: el bot cotizaba el valor de UNO
 * («Listo 🙌 3 semanas: $170.000») y el pago de los dos no cuadraba con nada. Pura.
 */
export function pideVariosCupos(texto: string | null | undefined): boolean {
    return VARIOS_CUPOS.test(normalizarFrase(texto));
}
export const TEXTO_VARIOS_CUPOS = 'Con gusto 🙌 El cupo es por persona. Escríbeme el nombre completo y la fecha de nacimiento de cada uno, y qué va a tomar cada quien; '
    + 'la escuela te confirma por aquí el valor total y te pasa los datos de pago.';

const PIDE_ABONAR = /\b(abonar|abono|abonando|abonamos|la mitad|mitad y mitad|en cuotas|a cuotas|por cuotas|por partes|en dos pagos|en 2 pagos|pagar una parte|una parte ahora|(guardan|guardar|guarden|apartan|apartar|aparten|reservan|reservar|reserven) (el|un|mi) cupo sin pagar|el resto (despues|luego|mas adelante))\b/;

/**
 * ¿Pide ABONAR o pagar por partes? En un servicio que no admite abonos el bot respondía con los datos de pago
 * («Ya te envié los datos de pago arriba») y el abono llegaba sin cuadrar con ningún valor. Pura.
 */
export function pideAbonar(texto: string | null | undefined): boolean {
    return PIDE_ABONAR.test(normalizarFrase(texto));
}
export function textoSinAbonos(item: ItemConFicha): string {
    return `El cupo ${deLaDelServicio(item)} se separa con el pago total de lo que vayas a tomar: no manejamos abonos ni se guarda el cupo sin el pago. `
        + 'Cuando quieras, te paso los datos de pago 🙌';
}

const DICE_SER_AFILIADO = /\b((soy|somos|es|son|esta|estan|estoy|estamos) (ya )?(afiliad[oa]s?|del club|parte del club|de la escuela|alumn[oa]s?|deportistas? del club)|(ya )?(entren[ao]|entrenan|entrenamos|juega|juego|juegan) (en|con) (el club|ustedes|la escuela|monster\w*)|(mi|mis) (hij[oa]s?|nin[oa]s?) (ya )?(es|son|esta|estan|entrena|entrenan|juega|juegan)\b[a-z ]{0,20}\b(afiliad[oa]s?|club|ustedes|escuela))\b/;

/**
 * «Soy afiliado», «mi hija entrena en el club»: la respuesta a «cuéntame cuál es tu caso». El precio NO cambia por
 * decirlo (eso lo decide el número y lo valida la escuela), pero tampoco se manda a la escuela una pregunta que el
 * bot mismo hizo. Solo cuando NO es la negación («no soy afiliado»). Pura.
 */
export function diceSerAfiliado(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    return DICE_SER_AFILIADO.test(t) && !NO_AFILIADO.test(t) && !/\bno (es|son|esta|estan|entrena|entrenan|juega|juegan)\b/.test(t);
}
export const TEXTO_DICE_SER_AFILIADO = 'Perfecto 🙌 Lo anoto. La escuela confirma que ya entrenas en el club cuando valide tu comprobante y, si es así, aplica el valor de afiliados. '
    + '¿Te paso los datos de pago?';

/** «¿los entrenos serían normales?»: pregunta por los entrenamientos de siempre del club, que el servicio no trae. */
const ENTRENOS = '(?:entreno|entrenos|entrenamiento|entrenamientos)';
const NORMALES = '(?:normal|normales|regular|regulares|convencional|convencionales|de siempre|habitual|habituales|ordinario|ordinarios)';
const ENTRENOS_REGULARES = new RegExp(`\\b${ENTRENOS}\\b(?: \\w+){0,4} ${NORMALES}\\b|\\b${NORMALES} (?:\\w+ ){0,3}${ENTRENOS}\\b`);
export function preguntaPorEntrenosRegulares(texto: string | null | undefined): boolean {
    return ENTRENOS_REGULARES.test(normalizarFrase(texto));
}
export const TEXTO_ENTRENOS_SIN_DATO = 'De los entrenamientos de siempre no tengo el dato 🙌 Ya le pasé tu pregunta a la escuela y te responde por aquí.';
/** Minutos en los que una segunda pregunta ya no recibe otro «Ya le pasé tu pregunta»: la escuela igual se entera. */
export const MIN_ENTRE_AVISOS_A_LA_ESCUELA = 3;

// ─── Elegir una opción del servicio (auditoría 8–16 nov 2026) ───────────────
//
// Seis conversaciones del vacacional terminaron en «Eso te lo confirma la escuela»: «3 semanas», «Pago 2 semanas»,
// «Dos semanas la inscribiré», «2 semanas: del 23al 27 de noviembre y del 30 de noviembre al 04 de diciembre»,
// «Del 23 al 27 nov / Del 30 al 04 dic». Con opciones en el servicio, eso es ELEGIR una.

const NUMERO_EN_LETRAS: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 };
const CANTIDAD_Y_UNIDAD = /(?<![a-z0-9])(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho) (semanas?|dias?|mes|meses|clases?|jornadas?|horas?|sesion|sesiones|quincenas?)(?![a-z0-9])/g;
/** «en 2 semanas», «hace 2 semanas», «faltan 2 semanas»: un plazo, no una elección. */
const ES_UN_PLAZO = /(?:^| )(?:en|hace|dentro de|faltan|falta|cada|como en|en unas|en unos)$/;
/** «del 23 al 27», «23al 27», «30 al 04»: un rango de días (una semana del vacacional). */
const RANGO_DE_DIAS = /(?<![a-z0-9])(\d{1,2})(?: de [a-z]+)? ?al ?(\d{1,2})(?![0-9])/g;
const TRAE_FECHAS = /(?<![a-z0-9])(?:\d{1,2}(?: de [a-z]+)? ?al ?\d{1,2}|\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|(?:ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)(?![a-z])|primera semana|segunda semana|tercera semana|cuarta semana|ultima semana)/;

const unidadBase = (u: string) => (u === 'meses' ? 'mes' : u === 'sesiones' ? 'sesion' : u.replace(/s$/, ''));

function cantidadesEn(t: string, o: { sinPlazos?: boolean } = {}): { n: number; unidad: string }[] {
    const out: { n: number; unidad: string }[] = [];
    CANTIDAD_Y_UNIDAD.lastIndex = 0;
    for (let m = CANTIDAD_Y_UNIDAD.exec(t); m; m = CANTIDAD_Y_UNIDAD.exec(t)) {
        if (o.sinPlazos && ES_UN_PLAZO.test(t.slice(0, m.index).trimEnd())) continue;
        out.push({ n: NUMERO_EN_LETRAS[m[1]] ?? Number(m[1]), unidad: unidadBase(m[2]) });
    }
    return out;
}

export interface OpcionElegida {
    clave: string;
    etiqueta: string;
    /** Las fechas que escribió, tal cual (nota para la escuela). null si no dijo fechas. */
    fechas: string | null;
}

/**
 * La opción del servicio que el mensaje ELIGE, o null. Solo si el servicio tiene `opciones` y el mensaje apunta a UNA:
 *  · por cantidad + unidad («3 semanas», «Dos semanas la inscribiré», «Pago 2 semanas») contra la etiqueta de la
 *    opción («2 semanas»); un plazo («en 2 semanas le pago») no cuenta;
 *  · por la cantidad de rangos «del N al N» («Del 23 al 27 nov / Del 30 al 04 dic» = 2 semanas);
 *  · o porque nombra la etiqueta entera de una opción que no trae cantidad («Jornada completa»).
 * Una pregunta («¿las 2 semanas pueden ser separadas?») no es una elección. Pura.
 */
export function opcionElegidaEnVenta(texto: string | null | undefined, item: Pick<ItemConFicha, 'opciones'>): OpcionElegida | null {
    const crudo = String(texto ?? '').trim();
    if (!crudo || crudo.length > 300 || /[?¿]/.test(crudo)) return null;
    const opciones = opcionesDelItem(item);
    if (opciones.length < 2) return null;
    const t = normalizarFrase(crudo);
    const fechas = TRAE_FECHAS.test(t) ? crudo.replace(/\s+/g, ' ').slice(0, 300) : null;
    const deOpcion = opciones.map((o) => ({ o, q: cantidadesEn(normalizarFrase(`${o.etiqueta} ${o.clave.replace(/[_-]+/g, ' ')}`))[0] ?? null }));
    const elegir = (lista: typeof deOpcion): OpcionElegida | null =>
        (lista.length === 1 ? { clave: lista[0].o.clave, etiqueta: lista[0].o.etiqueta, fechas } : null);

    const dichas = cantidadesEn(t, { sinPlazos: true });
    if (dichas.length) {
        // Todas las cantidades dichas tienen que apuntar a la misma opción («2 semanas… 1 semana» no decide).
        const claves = new Set<string>();
        for (const d of dichas) {
            const c = deOpcion.filter((x) => x.q && x.q.n === d.n && x.q.unidad === d.unidad);
            if (c.length > 1) return null;
            // «13 años 6 meses» junto a «2 semanas»: lo que no es de ninguna opción no estorba.
            if (c.length === 1) claves.add(c[0].o.clave);
        }
        return claves.size === 1 ? elegir(deOpcion.filter((x) => claves.has(x.o.clave))) : null;
    }
    RANGO_DE_DIAS.lastIndex = 0;
    const rangos = t.match(RANGO_DE_DIAS)?.length ?? 0;
    if (rangos) return elegir(deOpcion.filter((x) => x.q && x.q.unidad === 'semana' && x.q.n === rangos));
    return elegir(deOpcion.filter((x) => {
        const e = normalizarFrase(x.o.etiqueta);
        return !x.q && e.length >= 4 && ` ${t} `.includes(` ${e} `);
    }));
}

/**
 * La confirmación de la opción elegida: la opción y su valor y, según el estado de la venta, qué sigue. Con el
 * comprobante ya recibido NO se repiten los datos de pago. No dice «anoté» (las fechas van como nota a la escuela,
 * y solo se dice eso). Pura.
 */
export function textoOpcionElegida(
    item: Pick<ItemConFicha, 'name'>,
    o: { etiqueta: string; precio: number | null; conFechas: boolean; pagado: boolean; conDatosDePago: boolean },
): string {
    const valor = o.precio ? `: *${cop(o.precio)}*` : '';
    const fechas = o.conFechas ? ' Le paso a la escuela las fechas que escribiste.' : '';
    const sigue = o.pagado ? ' Ya tengo tu comprobante 📄 La escuela lo valida y te confirma el cupo por aquí.'
        : o.conDatosDePago ? ' Cuando hagas el pago, envíame aquí el comprobante.'
            : ' ¿Te paso los datos de pago?';
    return `Listo 🙌 *${o.etiqueta}* ${deLaDelServicio(item)}${valor}.${fechas}${sigue}`;
}

// ─── Textos cortos de la venta (auditoría 8–16 nov 2026) ────────────────────

/** Un saludo cuando ya llegó el comprobante: no se le vuelve a ofrecer separar el cupo. */
export const TEXTO_HOLA_CUENTAME = '¡Hola! 👋 Cuéntame.';
/** Anunció una pregunta sin hacerla («Profe una pregunta», «Me puedes confirmar», «Seria?»). */
export const TEXTO_DIME = 'Claro, dime 🙌';
/** Minutos entre dos «Claro, dime». */
export const MIN_ENTRE_DIME = 10;
/** Desiste («Estoy en otra ciudad», «no puedo», «no me queda»): sin derivar y sin insistir. */
export const TEXTO_DESISTE = 'Entiendo, gracias por avisarme 🙌 Si más adelante te animas, aquí estamos.';
/** Desiste DESPUÉS de haber enviado un comprobante: eso sí lo resuelve la escuela. */
export const TEXTO_DESISTE_CON_PAGO = 'Entiendo 🙌 Como ya enviaste un comprobante, le paso tu mensaje a la escuela y te responde por aquí.';
/** Cuánto dura «el bloque de pago salió hace poco» para la pregunta por la llave. */
export const MIN_BLOQUE_DE_PAGO_RECIENTE = 120;
export const TEXTO_LLAVE_SIN_DATO = 'No tengo ese dato 🙌 Ya le pasé tu pregunta a la escuela y te responde por aquí.';

/** Pregunta por el valor o por cómo inscribirse: ahí sí va el bloque de pago completo. */
const PIDE_VALOR = /\b(cuanto|cuesta|cuestan|vale|valen|valor|valores|precio|precios|costo|costos|tarifa|abono|cuotas)\b/;

/**
 * «¿Es una llave? ¿Puedo pagar por Bre-B?», «Disculpa ese tiene llave ?», «Para transferir por bre b» con el
 * bloque de pago recién enviado (se repitió entero tres veces): la respuesta corta con lo que SÍ está en los datos
 * de pago de la escuela. `confirmaLaEscuela`: no hay una llave cargada (no se inventa: se deriva). Pura.
 */
export function textoDeLlave(cuentas: CuentaDePagoEmbudo[]): { texto: string; confirmaLaEscuela: boolean } {
    if (!cuentas.length) return { texto: TEXTO_LLAVE_SIN_DATO, confirmaLaEscuela: true };
    const llave = cuentas.find((c) => /llave|bre ?-?b/i.test(c.tipo));
    if (llave) {
        return {
            texto: `Sí 🙌 Puedes pagar por llave (Bre-B): *${numeroLegible(llave.numero)}*${llave.titular ? `, a nombre de ${llave.titular}` : ''}.`,
            confirmaLaEscuela: false,
        };
    }
    const como = comoPagar(cuentas);
    const datos = como.includes('\n') ? 'Los datos de pago que tengo son los que te envié arriba.'
        : `Los datos de pago que tengo son los que te envié: ${como}.`;
    return { texto: `${datos} Si reciben por llave (Bre-B) te lo confirma la escuela por aquí 🙌`, confirmaLaEscuela: true };
}

/** «…y tengo 14 años nací en 2012»: un dato de registro dicho sin que nadie lo pidiera (con marca de nacimiento). */
const DICE_SU_NACIMIENTO = /\b(naci|nacio|nacida|nacido|nacimiento|cumple|cumplo)\b/;
/** Con estas palabras, una edad suelta es una consulta («tiene 12, ¿puede ir?»), no un dato de registro. */
const PARECE_CONSULTA = /\b(puede|pueden|puedo|podria|podrian|sirve|aplica|aplican|reciben|aceptan|permiten|hay|sera que|es posible|se puede|cuanto|cuanta|cual|como|donde|cuando|incluye|precio|valor|costo|horario|horarios)\b/;

// ─── Lectura de los mensajes (pura) ─────────────────────────────────────────

const momento = (f: FilaReciente) => new Date(f.wa_timestamp || f.created_at || 0).getTime();

/** ¿Salió este paso de la venta en los últimos `minutos`? Pura. */
export function pasoDeVentaReciente(recientes: FilaReciente[], paso: string, minutos: number, ahora = Date.now()): boolean {
    const desde = ahora - minutos * 60_000;
    return recientes.some((f) => f.direction === 'outbound' && f.payload?.step === paso && momento(f) >= desde);
}

/** ¿Llegó un comprobante (foto o PDF) en los últimos `minutos`? Pura. */
export function comprobanteRecibido(recientes: FilaReciente[], minutos: number, ahora = Date.now()): boolean {
    const desde = ahora - minutos * 60_000;
    return recientes.some((f) => f.direction === 'inbound' && (f.type === 'image' || f.type === 'document')
        && momento(f) >= desde && momento(f) <= ahora + 60_000);
}

/**
 * ¿Lo último que salió de la conversación es de ESTA venta (el bot con la marca,
 * la ficha, la campaña o el texto pegado por la escuela)? Con esto una familia
 * del club que está comprando la clínica sigue en la venta aunque no la nombre
 * («¿incluye grupo femenino?»), y lo demás de su cuenta sigue como siempre. Pura.
 */
export function ventaEnCurso(recientes: FilaReciente[], item: ItemConFicha, ahora = Date.now()): boolean {
    const ultimo = [...recientes].filter((f) => f.direction === 'outbound').sort((a, b) => momento(b) - momento(a))[0];
    return Boolean(ultimo && ventaActiva([ultimo], [item], { ahora })?.item.id === item.id);
}

/**
 * ¿El embudo del CLUB (clase de prueba) está en curso, con una pregunta suya
 * pendiente? Mismo criterio que `leerEstadoDeEmbudoDeSupabase` (el estado del
 * último saliente del embudo, 24 h, cortado por un saliente humano o de otro
 * flujo), sobre los mensajes que el turno ya leyó. Con la clase ya agendada no
 * hay pregunta pendiente. Pura.
 */
export function embudoDelClubEnCurso(recientes: FilaReciente[], ahora = Date.now()): boolean {
    const desde = ahora - 24 * 3600_000;
    const salientes = [...recientes]
        .filter((f) => f.direction === 'outbound' && momento(f) >= desde)
        .sort((a, b) => momento(b) - momento(a))
        .map((f) => ({ payload: f.payload ?? null, humano: f.ai_generated === false }));
    const estado = estadoDeSalientes(salientes);
    if (!estado || estado.paso === 'agendada' || estado.paso === 'sede') return false;
    // La persona LO ABRIÓ: ya contestó algo del embudo. El primer mensaje del embudo lo
    // manda el bot a un saludo (con el paso de quien lo arrancó, o `embudo_bienvenida`
    // si repite las sedes); sin respuesta suya, la venta no le cede nada (Monster 11-08:
    // «Hola» → sedes, y después de la ficha de la clínica «Ok» o «Armadores» repetían
    // «Elige la sede»).
    const fila = salientes.find((s) => s.payload?.flujo === 'embudo' && s.payload?.paso_embudo);
    const step = String(fila?.payload?.step ?? '');
    return step.startsWith('embudo_') && step !== 'embudo_bienvenida';
}

/** Lo que dice el mensaje del servicio, aunque sea a medias («Armadores»). Pura. */
function nombraElServicio(texto: string, item: ItemConFicha): boolean {
    if (itemNombradoEn(texto, [item])) return true;
    const palabras = new Set(normalizarFrase(texto).split(' '));
    return tokensDistintivos(item.name).some((k) => palabras.has(k));
}

/** Lo que se contesta a la venta aunque no la nombre, si lo último que salió fue de ella. */
const INTENCIONES_DE_LA_VENTA: ReadonlySet<IntencionVenta> = new Set(['pago', 'ya_pago', 'otra_fecha', 'saludo', 'anuncio', 'cierre']);

/**
 * Con el embudo del club EN CURSO (la persona lo abrió y tiene una pregunta
 * pendiente), la venta solo atiende lo que es de ella: un mensaje que nombra el
 * servicio, o —justo después de un mensaje de la venta— pagar, «ya pagué», otra
 * fecha, un saludo o un cierre. Lo demás («Mariana Gómez Ruiz», una fecha, un
 * botón) se lo ofrece primero al embudo (Monster, batería del 2026-11-08: la
 * venta se comía el nombre del deportista). true = primero el embudo. Pura.
 */
export function ventaCedeAlEmbudo(recientes: FilaReciente[], item: ItemConFicha, texto: string, ahora = Date.now()): boolean {
    if (!embudoDelClubEnCurso(recientes, ahora)) return false;
    if (nombraElServicio(texto, item)) return false;
    if (INTENCIONES_DE_LA_VENTA.has(intencionEnVenta(texto)) && ventaEnCurso(recientes, item, ahora)) return false;
    return true;
}

/**
 * ¿Ya salió algún mensaje de esta venta (ficha, campaña, texto de la escuela o un
 * saliente marcado)? Si no, el primer contacto lo atiende la ficha del destino
 * por anuncio. Pura.
 */
export function fichaDeVentaEnviada(mensajes: FilaReciente[], item: ItemConFicha, ahora = Date.now()): boolean {
    return ventaActiva(mensajes.filter((f) => f.direction === 'outbound'), [item], { ahora }) !== null;
}

/**
 * Lo de la CUENTA de una familia (su mensualidad, su saldo, su factura) no es de la
 * venta aunque la conversación esté en ella: sigue como siempre. Pura.
 */
export function temaDeCuentaDeFamilia(texto: string | null | undefined): boolean {
    const t = normalizarFrase(texto);
    return /\b(debo|debemos|deuda|deudas|saldo|saldos|estado de cuenta|mensualidad|mensualidades|mora|recargo|recargos|paz y salvo|factura|facturas|facturacion|mis pagos|mis cobros|cobro del mes|plan mensual)\b/.test(t);
}

const PALABRA_DE_SERVICIO = /\b(clinicas?|torneos?|campeonatos?|vacacional(es)?|vacaciones|campamentos?|copa)\b/;

/**
 * Filtro gratis antes de leer el catálogo en el turno de una FAMILIA (regla de Disk
 * IO: las familias escriben mucho): ¿hay en las 24 h un saliente de venta (marca,
 * ficha, campaña, texto largo de la escuela) o el mensaje nombra un evento? Pura.
 */
export function posibleVentaEnRecientes(recientes: FilaReciente[], texto: string | null | undefined): boolean {
    if (PALABRA_DE_SERVICIO.test(normalizarFrase(texto))) return true;
    return recientes.some((f) => {
        if (f.direction !== 'outbound') return false;
        const p = f.payload ?? {};
        return Boolean(p[MARCA_VENTA] || p.servicio_id || p.destino_anuncio || p.campana_id)
            || (f.ai_generated === false && String(f.text_body ?? '').length >= 60);
    });
}

/**
 * La venta de una FAMILIA del club (el afiliado que compra la clínica), o null. Pura.
 * Solo cuando la conversación está EN la venta (lo último que salió es de ella) o el
 * mensaje nombra el servicio. Lo de su cuenta sigue como hoy: pedir el club, su
 * mensualidad o saldo, y «ya pagué» sin nombrar el servicio (sus comprobantes).
 * `recientes`: las 24 h del turno; `rafaga`: lo que escribió desde la última respuesta.
 */
export function ventaDeFamilia(
    recientes: FilaReciente[], items: ItemConFicha[], texto: string, rafaga: string, ahora = Date.now(),
): VentaActiva | null {
    if (!items.length || !texto.trim()) return null;
    if (pideElClub(texto) || pideElClub(rafaga) || temaDeCuentaDeFamilia(rafaga)) return null;
    const venta = ventaActiva(recientes, items, { ahora });
    if (!venta) return null;
    const nombra = itemNombradoEn(rafaga || texto, [venta.item]) !== null;
    if (!nombra && !ventaEnCurso(recientes, venta.item, ahora)) return null;
    if (intencionEnVenta(texto) === 'ya_pago' && !nombra) return null;
    return venta;
}

// ─── El motor ───────────────────────────────────────────────────────────────

export interface CtxVentaServicio {
    schoolId: string;
    conversationId: string;
    /** Mensajes recientes de la conversación (los frenos y la IA salen de acá). */
    recientes: FilaReciente[];
    /** ¿El número es de una familia del club? (precio de afiliado). Solo se pregunta si el ítem lo tiene. */
    afiliado: () => Promise<boolean>;
    /** Cuentas de la escuela para ese motivo, con titular. */
    cuentas: (motivo: Motivo) => Promise<CuentaDePagoEmbudo[]>;
    /** Crea o actualiza el lead con el servicio. Devuelve el id (null para familias o en simulación). */
    guardarLead: (servicio: { id: string; nombre: string; tipo: string }) => Promise<string | null>;
    /** B4: el motivo del próximo comprobante, vigente hasta el fin del servicio. */
    registrarEsperado: (e: { motivo: Motivo; leadId: string | null; venceEn: string | null }) => Promise<boolean>;
    /**
     * (2026-11-19) El cobro que esta persona YA tiene de este servicio (`payments.amount` / `amount_paid`, p. ej. con
     * `cobroPrevioDelServicio`). Con abono, su saldo y su mínimo salen de ahí, no del precio de hoy. null = no tiene.
     */
    cobroPrevio?: (item: ItemConFicha) => Promise<CobroPrevioParaIa | null>;
    /** IA anclada al ítem (frente B). */
    responderPregunta: (p: PreguntaDeServicio) => Promise<RespuestaDeServicio>;
    /** UN mensaje; `contexto` va al payload del saliente. Con `botones`, botones de respuesta (si no salen, el texto solo). */
    enviar: (texto: string, contexto: Record<string, unknown>, botones?: BotonDeVenta[]) => Promise<void>;
    /** Buzón con aviso a la escuela (la pregunta queda pendiente y visible). */
    avisarEscuela: (detalle: string) => Promise<void>;
    /** ¿La cola tiene (o va a procesar) un comprobante de este número? Lo contesta ella. */
    comprobanteEnCurso?: () => Promise<boolean>;
    /**
     * Deja el nombre de quien asiste donde lo toma la cola de comprobantes de la venta
     * (`atenderComprobanteDeVenta`: el prospecto con `asistente_servicio`). Familias y
     * simulación: no escribe. Nunca lanza. `datos` (2026-11-16): la fecha de nacimiento, el acudiente y la
     * posición que vinieron en el mismo mensaje. Devuelve `false` si NO quedó guardado (no se dice «anoté»).
     */
    anotarAsistente?: (nombre: string, item: ItemConFicha, datos?: DatosDeRegistro) => Promise<boolean | void>;
    /**
     * (2026-11-16) Lo que la ficha del prospecto ya sabe de quien asiste. null = no aplica (familia del club,
     * simulación): la venta sigue como antes, sin pedir datos de registro. Sin esta función, igual.
     */
    registro?: () => Promise<DatosDeRegistro | null>;
    /** Guarda en la ficha datos de registro que llegan sueltos (fecha, acudiente, edad, posición). true = guardado. */
    anotarDatos?: (datos: DatosDeRegistro, item: ItemConFicha) => Promise<boolean>;
    /**
     * (auditoría 8–16 nov 2026) Deja la opción elegida («2 semanas») con su valor y las fechas dichas donde la tome la
     * cola al crear el cobro. Opcional: sin ella, la opción viaja en el payload del saliente (`opcion_elegida`,
     * `fechas_dichas`) y en el aviso a la escuela. Nunca lanza.
     */
    anotarOpcion?: (opcion: OpcionElegida & { precio: number | null }, item: ItemConFicha) => Promise<boolean | void>;
    ahora?: () => Date;
}

/**
 * (R3) La memoria de quien asiste en este turno: la ficha del prospecto y lo que ya escribió en la venta (los
 * mensajes del turno, sin lecturas nuevas; de un mensaje anterior el nombre solo vale con otro dato o una marca).
 * null = no aplica (familia, simulación, o el contexto no la da).
 */
async function registroDelTurno(
    ctx: CtxVentaServicio, desde: string | null | undefined, ahora: number, textoActual?: string,
): Promise<DatosDeRegistro | null> {
    if (!ctx.registro) return null;
    const ficha = await seguro(() => ctx.registro!(), null);
    if (!ficha) return null;
    const hoy = hoyBogota(ahora);
    const inicio = desde ? new Date(desde).getTime() : NaN;
    const corte = Math.max((Number.isFinite(inicio) ? inicio : ahora) - MARGEN_ANTES_DE_LA_VENTA_MS, ahora - HORAS_DE_LA_VENTA * 3600_000);
    const actual = String(textoActual ?? '').trim();
    const previos = [...ctx.recientes]
        .filter((f) => f.direction === 'inbound' && momento(f) >= corte && String(f.text_body ?? '').trim()
            && String(f.text_body ?? '').trim() !== actual)
        .sort((a, b) => momento(b) - momento(a))
        .slice(0, MAX_MENSAJES_DE_LA_VENTA)
        .map((f) => String(f.text_body));
    const chat = registroDeChatPrevio(previos, { hoy });
    // La ficha manda (ahí queda lo último que se guardó); el chat llena lo que falte si habla de la misma persona.
    if (ficha.nombre && chat.nombre && !mismaPersona(ficha.nombre, chat.nombre)) return ficha;
    return unirDatosDeRegistro(ficha, chat);
}

/** «Ya pagué» (texto o botón): con el archivo ya recibido NUNCA se pide de nuevo; se dice lo que falta, una vez. */
async function responderYaPago(
    ctx: CtxVentaServicio, item: ItemConFicha, marca: Record<string, unknown>, desde: string | null | undefined, ahora: number,
): Promise<ResultadoVenta> {
    const yaLlego = comprobanteRecibido(ctx.recientes, 24 * 60, ahora);
    const registro = await registroDelTurno(ctx, desde, ahora);
    if (!registro) {
        await ctx.enviar(yaLlego ? TEXTO_COMPROBANTE_YA_RECIBIDO : TEXTO_YA_PAGO, { ...marca, step: PASO_VENTA.YA_PAGO, repetible: true });
        return 'venta_ya_pago';
    }
    const faltan = faltantesDe(registro, hoyBogota(ahora));
    if (!yaLlego) {
        await ctx.enviar(`¡Perfecto! ${cierreDePagoSegunRegistro(faltan, registro).replace('la foto del comprobante', 'la foto o el PDF del comprobante')}`,
            { ...marca, step: PASO_VENTA.YA_PAGO, repetible: true, ...(faltan.length ? { faltan_datos: faltan } : {}) });
        return 'venta_ya_pago';
    }
    const capturaIncompleta = capturaIncompletaPendiente(ctx.recientes, ahora);
    if (!faltan.length && !capturaIncompleta) {
        await ctx.enviar(TEXTO_COMPROBANTE_YA_RECIBIDO, { ...marca, step: PASO_VENTA.YA_PAGO, repetible: true });
        return 'venta_ya_pago';
    }
    // Lo que falta ya se le dijo después de ese archivo (la pregunta de la cola no cuenta: es la primera vez): una sola repregunta.
    if (yaSeRepreguntoPorLosDatos(ctx.recientes, ahora)) return 'venta_silencio';
    await ctx.enviar(textoYaTengoTuComprobante(item, faltan, registro, { capturaIncompleta }),
        { ...marca, step: PASO_VENTA.YA_PAGO, pide_datos: true, ...(faltan.length ? { faltan_datos: faltan } : {}) });
    return 'venta_ya_pago';
}

/** Lo que viaja en el payload del saliente cuando el mensaje eligió una opción (la cola y la bandeja lo leen de ahí). */
function payloadDeOpcion(e: OpcionElegida | null): Record<string, unknown> {
    if (!e) return {};
    return { opcion_elegida: e.clave, opcion_etiqueta: e.etiqueta, ...(e.fechas ? { fechas_dichas: e.fechas } : {}) };
}

/** El valor de la opción para ESTA persona (afiliado o no, hoy) y, si el contexto sabe guardarla, la deja anotada. */
async function valorDeLaOpcion(ctx: CtxVentaServicio, item: ItemConFicha, e: OpcionElegida, ahora: number): Promise<number | null> {
    const afiliado = await afiliadoSiHaceFalta(ctx, item);
    const etiqueta = normalizarFrase(e.etiqueta);
    const precio = precioDelServicio(item, { afiliado, hoy: hoyBogota(ahora) }).opciones
        .find((p) => normalizarFrase(p.etiqueta) === etiqueta)?.precio ?? null;
    if (ctx.anotarOpcion) await seguro<boolean | void>(() => ctx.anotarOpcion!({ ...e, precio }, item), false);
    return precio;
}

/**
 * Eligió una opción del servicio («3 semanas», «Del 23 al 27 nov / Del 30 al 04 dic»): se confirma la opción con su
 * valor, las fechas dichas quedan como nota para la escuela (payload + aviso) y, si ya hay un comprobante en la venta,
 * NO se vuelven a mandar los datos de pago. La misma opción otra vez en 30 min: solo se acusan las fechas nuevas.
 */
async function responderOpcionElegida(
    ctx: CtxVentaServicio, venta: VentaActiva, e: OpcionElegida, marca: Record<string, unknown>, ahora: number,
): Promise<ResultadoVenta> {
    const item = venta.item;
    const pagado = pagoRecibidoEnVenta(ctx.recientes, venta, ahora);
    const previa = ctx.recientes.find((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.OPCION
        && f.payload?.opcion_elegida === e.clave && momento(f) >= ahora - 30 * 60_000);
    if (previa && (!e.fechas || previa.payload?.fechas_dichas === e.fechas)) return 'venta_silencio';
    const precio = await valorDeLaOpcion(ctx, item, e, ahora);
    const texto = previa
        ? 'Listo 🙌 Le paso a la escuela las fechas que escribiste.'
        : textoOpcionElegida(item, {
            etiqueta: e.etiqueta, precio, conFechas: !!e.fechas, pagado,
            conDatosDePago: pasoDeVentaReciente(ctx.recientes, PASO_VENTA.PAGO, 24 * 60, ahora),
        });
    await ctx.enviar(texto, {
        ...marca, intencion_venta: 'opcion', step: PASO_VENTA.OPCION, ...payloadDeOpcion(e),
        ...(precio !== null ? { opcion_precio: precio } : {}),
    }, pagado || previa ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
    // La escuela se entera cuando hay algo que hacer: fechas que agendar o un comprobante que validar contra la opción.
    if (e.fechas || pagado) {
        await seguro(() => ctx.avisarEscuela(
            `Eligió «${e.etiqueta}» de «${item.name}»${precio !== null ? ` (${cop(precio)})` : ''}`
            + `${e.fechas ? `. Fechas que escribió: «${e.fechas}»` : ''}${pagado ? '. Ya envió un comprobante.' : '.'}`), undefined);
    }
    return 'venta_respuesta';
}

export type ResultadoVenta =
    | 'venta_pago' | 'venta_sin_precio' | 'venta_respuesta' | 'venta_a_la_escuela' | 'venta_otra_fecha'
    | 'venta_ya_pago' | 'venta_saludo' | 'venta_silencio' | 'venta_boton_club' | 'venta_asistente'
    | 'venta_detalles' | 'venta_humano';

async function seguro<T>(fn: () => Promise<T>, siFalla: T): Promise<T> {
    try { return await fn(); } catch { return siFalla; }
}

async function afiliadoSiHaceFalta(ctx: CtxVentaServicio, item: ItemConFicha, texto?: string | null): Promise<boolean> {
    if (!tienePrecioDeAfiliado(item)) return false;
    // «Y para NO afiliados»: pidió la otra tarifa, aunque su número sea de una familia del club.
    if (pideTarifaDeNoAfiliado(texto)) return false;
    return seguro(() => ctx.afiliado(), false);
}

/** El cobro con abono que la persona ya tiene del servicio (null si no tiene o no se pudo leer). Nunca lanza. */
async function cobroPrevioDe(ctx: CtxVentaServicio, item: ItemConFicha): Promise<CobroPrevioParaIa | null> {
    if (!ctx.cobroPrevio) return null;
    return cobroConAbono(await seguro(() => ctx.cobroPrevio!(item), null));
}

/**
 * El hook `ctx.cobroPrevio` del bot: el cobro con abono que el PROSPECTO ya tiene de este servicio (el dueño es su
 * lead, el que el bot ya resuelve con `leadDeVenta`). Una lectura del lead y una del cobro por ítem, memorizadas en
 * el turno. Familias del club y simulación: null (siguen con el precio vigente). Nunca lanza. Inyectable para probar.
 */
export function crearCobroPrevioDelTurno(d: {
    omitir: boolean;
    leadId: () => Promise<string | null | undefined>;
    cobro: (dueno: { leadId: string }, item: ItemConFicha) => Promise<{ amount: number; amountPaid: number } | null>;
}): (item: ItemConFicha) => Promise<CobroPrevioParaIa | null> {
    const memo = new Map<string, Promise<CobroPrevioParaIa | null>>();
    return (item) => {
        if (d.omitir) return Promise.resolve(null);
        let p = memo.get(item.id);
        if (!p) {
            p = (async () => {
                try {
                    const leadId = await d.leadId();
                    if (!leadId) return null;
                    return cobroConAbono(await d.cobro({ leadId }, item));
                } catch {
                    return null;
                }
            })();
            memo.set(item.id, p);
        }
        return p;
    };
}

/**
 * El mensaje de pago aparte: precio de hoy, cuentas, lead con el servicio y el
 * esperado B4 (para que el comprobante cree el cobro del servicio). Lo usan la
 * venta y la respuesta al «Sí» de una campaña. `extra` va al payload. Nunca lanza
 * por la base (lo que falla queda en el payload).
 */
export async function enviarPagoDeServicio(
    ctx: CtxVentaServicio, item: ItemConFicha, o: { pregunta?: string; extra?: Record<string, unknown> } = {},
): Promise<'venta_pago' | 'venta_sin_precio'> {
    const marca = { [MARCA_VENTA]: item.id, ...(o.extra ?? {}) };
    const hoy = hoyBogota((ctx.ahora ?? (() => new Date()))().getTime());
    const afiliado = await afiliadoSiHaceFalta(ctx, item, o.pregunta);
    const precioCompleto = precioDelServicio(item, { afiliado, hoy });
    const precio = pideTarifaDeNoAfiliado(o.pregunta) ? sinNotaDeAfiliado(precioCompleto) : precioCompleto;
    if (precio.hoy === null && !precio.opciones.length) {
        await ctx.enviar(textoSinPrecioDeServicio(item), { ...marca, step: PASO_VENTA.SIN_PRECIO, pendiente_escuela: 'valor del servicio' });
        await seguro(() => ctx.avisarEscuela(`Pregunta por «${item.name}», que no tiene precio cargado: escríbele con el valor.`), undefined);
        return 'venta_sin_precio';
    }
    const motivo = motivoDeServicio(item);
    const cuentas = await seguro(() => ctx.cuentas(motivo), [] as CuentaDePagoEmbudo[]);
    const leadId = await seguro(() => ctx.guardarLead({ id: item.id, nombre: item.name, tipo: String(item.kind) }), null);
    const registrado = await seguro(
        () => ctx.registrarEsperado({ motivo, leadId, venceEn: item.ends_at ?? item.starts_at ?? null }), false);
    const pregunta = normalizarFrase(o.pregunta);
    // Lo que la escuela no configura (la cédula del titular) o lo que falta (el titular, la llave) queda pendiente.
    const faltantes: string[] = [];
    if (cuentas.length && PIDE_DOCUMENTO_DEL_TITULAR.test(pregunta)) faltantes.push('el documento del titular de la cuenta');
    if (cuentas.length && PIDE_TITULAR.test(pregunta) && !cuentas.some((c) => c.titular)) faltantes.push('el titular de la cuenta');
    if (cuentas.length && PIDE_LLAVE.test(pregunta) && !cuentas.some((c) => /llave|bre ?b/i.test(c.tipo))) faltantes.push('si reciben por llave (Bre-B)');
    const nota = faltantes.length ? `\n\n${capital(faltantes.join(' y '))} te lo confirma la escuela por aquí.` : '';
    // (R2/R3) Con el comprobante se piden de una vez los datos de registro que FALTAN (lo que ya está en la ficha, no).
    const ahoraMs = (ctx.ahora ?? (() => new Date()))().getTime();
    const registro = await registroDelTurno(ctx, null, ahoraMs);
    const faltanDatos = registro ? faltantesDe(registro, hoy) : null;
    const cobroPrevio = await cobroPrevioDe(ctx, item);
    await ctx.enviar(textoDePagoDeServicio(item, precio, cuentas,
        { ...(registro && faltanDatos ? { cierre: cierreDePagoSegunRegistro(faltanDatos, registro) } : {}), cobroPrevio }) + nota, {
        ...marca,
        step: PASO_VENTA.PAGO,
        ...(faltanDatos?.length ? { faltan_datos: faltanDatos } : {}),
        repetible: true,
        datos_de_pago: cuentas.length > 0,
        precio_hoy: precio.hoy,
        ...(cobroPrevio ? { saldo_cobro_previo: cobroPrevio.amount - cobroPrevio.amountPaid } : precio.abono !== null ? { abono: precio.abono } : {}),
        ...(precio.deAfiliado ? { afiliado: true } : {}),
        motivo_esperado: { motivo, monto: null, registrado },
        ...(cuentas.length ? {} : { sin_cuentas: true }),
        ...(faltantes.length ? { pendiente_escuela: o.pregunta?.slice(0, 300) ?? faltantes.join(' y ') } : {}),
    }, cuentas.length ? botonesDeVenta(item, ['ya_pague']) : undefined);
    if (!cuentas.length) {
        await seguro(() => ctx.avisarEscuela(
            `Pidió los datos de pago de «${item.name}» y la escuela no tiene cuentas de pago cargadas: escríbele con los datos.`), undefined);
    } else if (faltantes.length) {
        await seguro(() => ctx.avisarEscuela(`Antes de pagar «${item.name}» pregunta ${faltantes.join(' y ')}: «${String(o.pregunta ?? '').slice(0, 300)}».`), undefined);
    }
    return 'venta_pago';
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * ¿Ya pagó en esta venta? Llegó un comprobante (foto o PDF) desde que empezó la venta
 * (o en las últimas 24 h), o la cola ya le contestó un comprobante de ESTE servicio. Pura.
 */
export function pagoRecibidoEnVenta(recientes: FilaReciente[], venta: VentaActiva, ahora = Date.now()): boolean {
    const desde = Math.min(venta.desde ? new Date(venta.desde).getTime() : ahora, ahora - 24 * 3600_000);
    return recientes.some((f) => {
        const m = momento(f);
        if (!(m >= desde && m <= ahora + 60_000)) return false;
        if (f.direction === 'inbound') return f.type === 'image' || f.type === 'document';
        return f.payload?.[MARCA_VENTA] === venta.item.id && /^venta_comprobante_(recibido|repetido)$/.test(String(f.payload?.step ?? ''));
    });
}

/**
 * UN mensaje a la persona y la pregunta pendiente a la escuela. La primera vez: «Eso te lo confirma la escuela… Ya le
 * pasé tu pregunta» (o `textoPropio`); una segunda pregunta en los siguientes minutos NO recibe otro mensaje (antes
 * salían juntos «Ya le pasé tu pregunta» + «Anotado 🙌 También se lo paso…»): la escuela igual se entera. Más tarde,
 * el «Anotado» corto. Nunca lanza por la base.
 */
async function aLaEscuela(
    ctx: CtxVentaServicio, item: ItemConFicha, marca: Record<string, unknown>, texto: string, ahora: number,
    textoPropio: string | null, extra: Record<string, unknown>,
): Promise<ResultadoVenta> {
    const detalle = textoPropio
        ? `Pregunta sobre «${item.name}» que el asistente no puede contestar (no es del servicio): «${texto.slice(0, 300)}».`
        : `Pregunta sobre «${item.name}» que el asistente no tiene en los datos: «${texto.slice(0, 300)}».`;
    if (pasoDeVentaReciente(ctx.recientes, PASO_VENTA.A_LA_ESCUELA, MIN_ENTRE_AVISOS_A_LA_ESCUELA, ahora)) {
        await seguro(() => ctx.avisarEscuela(detalle), undefined);
        return 'venta_a_la_escuela';
    }
    const repetido = pasoDeVentaReciente(ctx.recientes, PASO_VENTA.A_LA_ESCUELA, 30, ahora);
    await ctx.enviar(textoPropio ?? (repetido ? TEXTO_A_LA_ESCUELA_REPETIDO : TEXTO_A_LA_ESCUELA), {
        ...marca, ...extra, step: PASO_VENTA.A_LA_ESCUELA, pendiente_escuela: texto.slice(0, 300),
    }, textoPropio || repetido ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
    await seguro(() => ctx.avisarEscuela(detalle), undefined);
    return 'venta_a_la_escuela';
}

/**
 * Con el bloque de pago YA enviado (48 h), lo que la persona pide después recibe UNA línea, no el bloque otra vez
 * (Monster 14–16 nov: «¿Puedo pagar hasta mañana?» ×2, «¿tiene llave?» ×3, «pásame el Nequi» → el bloque entero cada vez):
 *  · llave / Bre-B → la llave o lo que sí hay;
 *  · valor o «para NO afiliados» → solo las líneas del valor (la tarifa pedida);
 *  · plazo → el valor de hoy y el tramo que sigue; sin dato del plazo, lo confirma la escuela (y se le avisa);
 *  · el número / la cuenta / el titular → la cuenta, en una línea;
 *  · cualquier otro «sí»/«separar» → «ya te los envié».
 * Devuelve null cuando no hay una línea honesta (sin cuentas, ya pagó): va el bloque de siempre. La misma respuesta
 * corta dos veces en 2 minutos: silencio. Nunca lanza por la base.
 */
async function respuestaCortaDePago(
    ctx: CtxVentaServicio, venta: VentaActiva, texto: string, ahora: number,
): Promise<ResultadoVenta | null> {
    const item = venta.item;
    const pregunta = normalizarFrase(texto);
    const marca = { [MARCA_VENTA]: item.id, intencion_venta: 'pago' };
    const hoy = hoyBogota(ahora);
    const pideValor = PIDE_VALOR.test(pregunta) || NO_AFILIADO.test(pregunta);
    const pagado = pagoRecibidoEnVenta(ctx.recientes, venta, ahora);
    const yaSalio = (tipo: string) => ctx.recientes.some((f) => f.direction === 'outbound' && f.payload?.corta_de_pago === tipo
        && momento(f) >= ahora - 2 * 60_000);
    const responder = async (tipo: string, textoCorto: string, extra: Record<string, unknown> = {}): Promise<ResultadoVenta> => {
        if (yaSalio(tipo)) return 'venta_silencio';
        await ctx.enviar(textoCorto, { ...marca, step: PASO_VENTA.RESPUESTA, repetible: true, corta_de_pago: tipo, ...extra });
        return 'venta_respuesta';
    };
    const cuentas = await seguro(() => ctx.cuentas(motivoDeServicio(item)), [] as CuentaDePagoEmbudo[]);

    if (PIDE_LLAVE.test(pregunta) && !pideValor) {
        if (yaSalio('llave')) return 'venta_silencio';
        const llave = textoDeLlave(cuentas);
        await ctx.enviar(llave.texto, {
            ...marca, step: PASO_VENTA.LLAVE, repetible: true, corta_de_pago: 'llave',
            ...(llave.confirmaLaEscuela ? { pendiente_escuela: texto.slice(0, 300) } : {}),
        });
        if (llave.confirmaLaEscuela) {
            await seguro(() => ctx.avisarEscuela(`Antes de pagar «${item.name}» pregunta si reciben por llave (Bre-B): «${texto.slice(0, 300)}».`), undefined);
        }
        return 'venta_respuesta';
    }

    if (pideValor) {
        const afiliado = await afiliadoSiHaceFalta(ctx, item, texto);
        // «Y para NO afiliados»: solo la tabla de lista, sin la nota de afiliados (pidió justo esa).
        const precioHoy = precioDelServicio(item, { afiliado, hoy });
        const lineas = lineasDeValorDeVenta(pideTarifaDeNoAfiliado(texto) ? sinNotaDeAfiliado(precioHoy) : precioHoy);
        if (!lineas.length) return null;
        const cierre = cuentas.length ? 'Los datos de pago son los mismos que te envié arriba 🙌' : SIN_CUENTAS_DE_PAGO;
        return responder(pideTarifaDeNoAfiliado(texto) ? 'valor_no_afiliado' : 'valor', `${lineas.join('\n')}\n\n${cierre}`, { afiliado });
    }

    if (PIDE_PLAZO.test(pregunta)) {
        const afiliado = await afiliadoSiHaceFalta(ctx, item, texto);
        const precio = precioDelServicio(item, { afiliado, hoy });
        if (precio.hoy !== null && precio.siguiente) {
            return responder('plazo',
                `Hoy el valor es *${cop(precio.hoy)}* y desde el ${diaLegible(precio.siguiente.desde)} pasa a *${cop(precio.siguiente.precio)}*. `
                + 'Cuando pagues, envíame aquí el comprobante 🙌');
        }
        // Sin dato del plazo: se dice y se le avisa a la escuela (no se repite el bloque ni se inventa una fecha).
        if (yaSalio('plazo')) return 'venta_silencio';
        await ctx.enviar('El plazo para pagar te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta.', {
            ...marca, step: PASO_VENTA.RESPUESTA, repetible: true, corta_de_pago: 'plazo', pendiente_escuela: texto.slice(0, 300),
        });
        await seguro(() => ctx.avisarEscuela(`Antes de pagar «${item.name}» pregunta por el plazo: «${texto.slice(0, 300)}».`), undefined);
        return 'venta_respuesta';
    }

    if (PIDE_DATO_DE_CUENTA.test(pregunta) && cuentas.length) {
        const como = comoPagar(cuentas).replace(/\n+$/, '');
        const varias = como.includes('\n');
        const linea = varias ? `Estos son los datos de pago:\n${como.replace(/^a una de estas cuentas:\n/, '')}` : `Claro 🙌 Transfiere ${como}.`;
        return responder('cuenta', `${linea}${varias ? '\n\n' : ' '}Cuando pagues, envíame aquí el comprobante.`);
    }

    // «Sí», «dale», «separar mi cupo» otra vez: ya los tiene. Con un comprobante ya enviado puede ser otro cupo: bloque de siempre.
    if (!pagado && cuentas.length) {
        return responder('ya_enviados', 'Ya te envié los datos de pago arriba 🙌 Cuando pagues, envíame aquí el comprobante con el nombre completo de quien asiste.');
    }
    return null;
}

/**
 * ¿La persona habló DEL SERVICIO en esta conversación (lo nombró, o el bot le mandó el pago, los datos o la opción
 * porque los pidió)? Una pregunta cualquiera que el bot derivó («Ya le pasé tu pregunta») NO cuenta. Para que la
 * cola de comprobantes no tome por del servicio un pago que no lo nombra (Marco 15-nov: $10.000 de su mensualidad
 * → «No coincide con el valor de la Clínica»). Pura.
 */
export function hablaDelServicio(recientes: FilaReciente[], item: ItemConFicha, ahora = Date.now(), horas = 72): boolean {
    const desde = ahora - horas * 3600_000;
    const PASOS = new Set<string>([
        PASO_VENTA.PAGO, PASO_VENTA.YA_PAGO, PASO_VENTA.ASISTENTE, PASO_VENTA.VARIOS_ASISTENTES,
        PASO_VENTA.LLAVE, PASO_VENTA.OPCION, PASO_VENTA.DETALLES,
    ]);
    return recientes.some((f) => {
        if (momento(f) < desde) return false;
        if (f.direction === 'inbound') return f.type === 'text' && nombraElServicio(String(f.text_body ?? ''), item);
        return f.payload?.[MARCA_VENTA] === item.id && PASOS.has(String(f.payload?.step ?? ''));
    });
}

/**
 * Un botón viejo de un flujo del CLUB (sede, franja, opciones del embudo, recordatorio,
 * cortesía, puerta) tocado en plena venta: no avanza NADA. La primera vez en la venta,
 * una respuesta dentro de la venta (`textoBotonDelClubEnVenta`); los demás toques,
 * silencio (Nicolás tocó cinco seguidos). Quien llama ya comprobó que la persona no
 * pidió el club con un texto suyo.
 */
export async function atenderBotonDelClubEnVenta(ctx: CtxVentaServicio, venta: VentaActiva): Promise<ResultadoVenta> {
    const ahora = (ctx.ahora ?? (() => new Date()))().getTime();
    const desde = Math.min(venta.desde ? new Date(venta.desde).getTime() : ahora, ahora - 24 * 3600_000);
    const yaRespondido = ctx.recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.BOTON_CLUB
        && momento(f) >= desde);
    if (yaRespondido) return 'venta_silencio';
    await ctx.enviar(textoBotonDelClubEnVenta(venta.item, { pagado: pagoRecibidoEnVenta(ctx.recientes, venta, ahora) }),
        { [MARCA_VENTA]: venta.item.id, step: PASO_VENTA.BOTON_CLUB });
    return 'venta_boton_club';
}

/**
 * Atiende un mensaje dentro de la venta de un servicio. null = no es de la venta
 * (pidió el club de forma explícita): sigue el bot de siempre. Cada camino manda a
 * lo sumo UN mensaje (el pago puede llevar una nota de lo que queda pendiente).
 */
export async function atenderVentaDeServicio(
    ctx: CtxVentaServicio, venta: VentaActiva, textoCrudo: string,
): Promise<ResultadoVenta | null> {
    const texto = String(textoCrudo ?? '').trim();
    const item = venta.item;
    const intencion = intencionEnVenta(texto);
    if (intencion === 'club') return null;
    const ahora = (ctx.ahora ?? (() => new Date()))().getTime();
    const marca = { [MARCA_VENTA]: item.id, intencion_venta: intencion };
    // Un proveedor que le cobra a la escuela no es un cliente: ni datos de pago ni nombre de asistente; pasa a la escuela.
    if (reclamaPagoALaEscuela(texto, item)) {
        await seguro(() => ctx.avisarEscuela(`Mensaje que parece COBRARLE a la escuela (no es una compra de «${item.name}»): «${texto.slice(0, 300)}».`), undefined);
        return 'venta_a_la_escuela';
    }
    // Un comprobante en la ráfaga (o en la cola): lo contesta la cola, una sola vez.
    const colaContesta = async () => (ctx.comprobanteEnCurso ? seguro(() => ctx.comprobanteEnCurso!(), false) : false);
    // «Comparto soporte de pago… / Gabriela Covaleda García / 13 años»: dice que pagó Y da los datos de quien asiste.
    // Los datos no se pierden por la intención: se atienden como datos (salvo que el archivo lo esté contestando la cola).
    const datosEnElMensaje = intencion === 'ya_pago'
        ? leerDatosDeRegistro(texto, { hoy: hoyBogota(ahora), fuente: 'chat' }) : null as unknown as DatosDeRegistro;
    const conDatosDeAsistente = intencion === 'ya_pago' && !!datosEnElMensaje.nombre && !/[?¿]/.test(texto)
        && (traeOtroDato(datosEnElMensaje) || tieneMarcaDeAsistente(texto));
    const colaEnYaPago = intencion === 'ya_pago' ? await colaContesta() : false;
    const ruta: IntencionVenta = conDatosDeAsistente && !colaEnYaPago ? 'detalle' : intencion;
    // «3 semanas», «Pago 2 semanas», «Del 23 al 27 nov / Del 30 al 04 dic»: eligió una opción del servicio.
    const eleccion = intencion === 'detalle' || intencion === 'pago' || intencion === 'ya_pago' ? opcionElegidaEnVenta(texto, item) : null;

    // (2026-11-22) Tres respuestas fijas ANTES de cotizar o de pasar a la IA, solo sin comprobante en curso.
    if ((intencion === 'detalle' || intencion === 'pago') && !(await colaContesta())) {
        const dichoHace = (clave: string, minutos: number) => ctx.recientes.some((f) => f.direction === 'outbound'
            && f.payload?.fija_de_venta === clave && momento(f) >= ahora - minutos * 60_000);
        // «Para dos hermanos», «son dos niñas, 3 semanas cada una»: el cobro por persona lo arma la escuela.
        // Salvo que el bot acabe de preguntar «¿dos cupos o uno solo?»: esa respuesta la lee la rama de `detalle` (elegirEntreNombres).
        const ultimoSalienteDeVenta = [...ctx.recientes]
            .filter((f) => f.direction === 'outbound' && momento(f) >= ahora - 24 * 3600_000).sort((a, b) => momento(b) - momento(a))[0];
        const respondeAPreguntaDeNombres = Array.isArray(ultimoSalienteDeVenta?.payload?.asistentes_dichos)
            && ultimoSalienteDeVenta!.payload.asistentes_dichos.length >= 2;
        if (!respondeAPreguntaDeNombres && pideVariosCupos(texto) && !dichoHace('varios_cupos', 30)) {
            await ctx.enviar(TEXTO_VARIOS_CUPOS, {
                ...marca, step: PASO_VENTA.A_LA_ESCUELA, fija_de_venta: 'varios_cupos', repetible: true,
                pendiente_escuela: `varios cupos: ${texto}`.slice(0, 300), ...payloadDeOpcion(eleccion),
            });
            await seguro(() => ctx.avisarEscuela(
                `En «${item.name}» quiere inscribir a más de una persona: «${texto.slice(0, 300)}». El cobro es por persona: confírmale el valor total y los datos de pago.`), undefined);
            return 'venta_a_la_escuela';
        }
        // «¿Puedo abonar la mitad?» en un servicio sin abonos: se dice que no, no se mandan los datos de pago.
        if (item.allow_installments !== true && pideAbonar(texto) && !pagoRecibidoEnVenta(ctx.recientes, venta, ahora)) {
            if (dichoHace('sin_abonos', 5)) return 'venta_silencio';
            await ctx.enviar(textoSinAbonos(item), { ...marca, step: PASO_VENTA.RESPUESTA, fija_de_venta: 'sin_abonos', repetible: true },
                botonesDeVenta(item, ['separar', 'humano']));
            return 'venta_respuesta';
        }
        // «Soy afiliado», «mi hija entrena en el club»: lo que el propio bot preguntó («cuéntame cuál es tu caso»).
        // Solo si es una afirmación: «soy afiliado, ¿cuánto cuesta?» es una pregunta de precio y la contesta la cotización.
        if (!eleccion && !/[?¿]/.test(texto) && diceSerAfiliado(texto) && tienePrecioDeAfiliado(item)) {
            if (dichoHace('dice_ser_afiliado', 5)) return 'venta_silencio';
            await ctx.enviar(TEXTO_DICE_SER_AFILIADO, { ...marca, step: PASO_VENTA.RESPUESTA, fija_de_venta: 'dice_ser_afiliado', repetible: true },
                botonesDeVenta(item, ['separar', 'humano']));
            return 'venta_respuesta';
        }
    }

    // «Ya me sale en la aplicación que estoy al día»: un acuse corto (antes caía en «detalle» y no recibía nada).
    if (intencion === 'detalle' && !/[?¿]/.test(texto) && DICE_ESTAR_AL_DIA.test(normalizarFrase(texto))) {
        if (await colaContesta()) return 'venta_silencio';
        if (ctx.recientes.some((f) => f.direction === 'outbound' && f.payload?.corta_de_pago === 'al_dia'
            && momento(f) >= ahora - 2 * 60_000)) return 'venta_silencio';
        await ctx.enviar(TEXTO_ACUSE_AL_DIA, { ...marca, step: PASO_VENTA.RESPUESTA, repetible: true, corta_de_pago: 'al_dia' });
        return 'venta_respuesta';
    }

    switch (ruta) {
        case 'cierre':
            return 'venta_silencio';

        case 'saludo': {
            if (await colaContesta()) return 'venta_silencio';
            if (pasoDeVentaReciente(ctx.recientes, PASO_VENTA.SALUDO, MIN_ENTRE_SALUDOS_DE_VENTA, ahora)) return 'venta_silencio';
            // Ya mandó el comprobante: no se le ofrece «separar tu cupo» otra vez.
            if (pagoRecibidoEnVenta(ctx.recientes, venta, ahora)) {
                await ctx.enviar(TEXTO_HOLA_CUENTAME, { ...marca, step: PASO_VENTA.SALUDO });
                return 'venta_saludo';
            }
            await ctx.enviar(lineaDeSaludoDeVenta(item), { ...marca, step: PASO_VENTA.SALUDO }, botonesDeVenta(item, BOTONES_DE_ENTRADA));
            return 'venta_saludo';
        }

        // «Profe una pregunta», «Me puedes confirmar», «Seria?»: todavía no preguntó nada. No se deriva: se espera.
        case 'anuncio': {
            if (await colaContesta()) return 'venta_silencio';
            if (pasoDeVentaReciente(ctx.recientes, PASO_VENTA.DIME, MIN_ENTRE_DIME, ahora)) return 'venta_silencio';
            await ctx.enviar(TEXTO_DIME, { ...marca, step: PASO_VENTA.DIME });
            return 'venta_saludo';
        }

        // «Estoy en otra ciudad», «no puedo», «no me queda»: cierre amable, sin derivar ni insistir.
        case 'desiste': {
            if (pagoRecibidoEnVenta(ctx.recientes, venta, ahora)) {
                // Con un comprobante ya enviado no es un simple «no voy»: lo resuelve la escuela.
                await ctx.enviar(TEXTO_DESISTE_CON_PAGO, { ...marca, step: PASO_VENTA.DESISTE, pendiente_escuela: texto.slice(0, 300) });
                await seguro(() => ctx.avisarEscuela(`Envió un comprobante de «${item.name}» y ahora dice que no puede: «${texto.slice(0, 300)}».`), undefined);
                return 'venta_a_la_escuela';
            }
            if (pasoDeVentaReciente(ctx.recientes, PASO_VENTA.DESISTE, 30, ahora)) return 'venta_silencio';
            await ctx.enviar(TEXTO_DESISTE, { ...marca, step: PASO_VENTA.DESISTE, desiste: true });
            return 'venta_respuesta';
        }

        case 'ya_pago': {
            if (colaEnYaPago) {
                // El archivo lo contesta la cola; si este mismo texto trae los datos de quien asiste, quedan en la
                // ficha para que la cola no los pregunte («Comparto soporte… / Gabriela Covaleda García / 13 años»).
                if (conDatosDeAsistente && ctx.anotarAsistente) {
                    await seguro<boolean | void>(() => ctx.anotarAsistente!(datosEnElMensaje.nombre as string, item, datosEnElMensaje), undefined);
                }
                return 'venta_silencio';
            }
            return responderYaPago(ctx, item, { ...marca, ...payloadDeOpcion(eleccion) }, venta.desde, ahora);
        }

        case 'otra_fecha': {
            await ctx.enviar(TEXTO_OTRA_FECHA, { ...marca, step: PASO_VENTA.OTRA_FECHA, pendiente_escuela: texto.slice(0, 300) });
            await seguro(() => ctx.avisarEscuela(`Interesado en «${item.name}» pregunta por otra fecha: «${texto.slice(0, 300)}».`), undefined);
            return 'venta_otra_fecha';
        }

        case 'pago': {
            // Eligió una opción y ya hay un comprobante: se confirma la opción, sin repetir los datos de pago.
            if (eleccion && pagoRecibidoEnVenta(ctx.recientes, venta, ahora)) return responderOpcionElegida(ctx, venta, eleccion, marca, ahora);
            // El bloque de pago completo sale UNA vez: después, solo la línea con lo que pidió (llave, número, valor, plazo).
            if (!eleccion && pasoDeVentaReciente(ctx.recientes, PASO_VENTA.PAGO, MIN_BLOQUE_DE_PAGO_ENVIADO, ahora)) {
                const corta = await respuestaCortaDePago(ctx, venta, texto, ahora);
                if (corta) return corta;
            }
            return enviarPagoDeServicio(ctx, item, { pregunta: texto, extra: { intencion_venta: intencion, ...payloadDeOpcion(eleccion) } });
        }

        case 'detalle':
        default: {
            // Los datos de quien asiste: se agradecen y se anotan (la cola los usa para el
            // cobro). Sin pago todavía, el pago se OFRECE con una pregunta; los datos, cuando los pida.
            const hoy = hoyBogota(ahora);
            const pagado = pagoRecibidoEnVenta(ctx.recientes, venta, ahora);
            const sinPregunta = !/[?¿]/.test(texto);
            const pedidos = datosPedidosPendientes(ctx.recientes, ahora);
            // Con los datos pedidos, dos nombres sin marca en dos líneas son quien asiste y su persona responsable.
            const par = pedidos && sinPregunta ? nombreYAcudienteEnLineas(texto) : null;
            const leidoDelTexto = leerDatosDeRegistro(texto, { hoy, fuente: 'chat' });
            const leido: DatosDeRegistro = par
                ? { ...leidoDelTexto, nombre: par.nombre, acudiente: leidoDelTexto.acudiente ?? par.acudiente } : leidoDelTexto;
            // El nombre de un mensaje del chat vale si el bot lo acaba de pedir (`datosDeAsistenteEnVenta`), o si el
            // mismo mensaje trae otro dato de registro o una marca («la niña…», «a nombre de…»).
            // «¿de una sola persona (dime de quién) o de los dos cupos?»: la respuesta a los nombres que ya dio.
            const ultimoSaliente = [...ctx.recientes]
                .filter((f) => f.direction === 'outbound' && momento(f) >= ahora - 24 * 3600_000).sort((a, b) => momento(b) - momento(a))[0];
            const ofrecidos = (Array.isArray(ultimoSaliente?.payload?.asistentes_dichos) ? ultimoSaliente!.payload.asistentes_dichos : [])
                .filter((n: unknown): n is string => typeof n === 'string' && !!n.trim());
            const elegido = sinPregunta && ofrecidos.length >= 2 ? elegirEntreNombres(texto, ofrecidos) : null;
            if (elegido === 'todos') {
                // Varios cupos con un pago: el cobro es por persona y lo arma la escuela (no se anota a nadie en silencio).
                await ctx.enviar(textoVariosCuposALaEscuela(ofrecidos), {
                    ...marca, intencion_venta: 'asistente', step: PASO_VENTA.A_LA_ESCUELA, asistentes: ofrecidos,
                    pendiente_escuela: `${ofrecidos.length} cupos: ${ofrecidos.join(', ')}`.slice(0, 300),
                });
                await seguro(() => ctx.avisarEscuela(
                    `En «${item.name}» dice que son ${ofrecidos.length} cupos: ${ofrecidos.join(', ')}. El cobro es por persona: revisa el pago y regístralos.`), undefined);
                return 'venta_a_la_escuela';
            }
            // «Jugador 1: VALENTINA… / Jugador 2: MARIA ALEJANDRA…»: dos personas. No se elige una en silencio.
            const varios = sinPregunta && !elegido ? nombresDeAsistentesEn(texto, { sinLineasSueltas: !!pedidos }) : [];
            if (varios.length >= 2) {
                await ctx.enviar(textoVariosAsistentes(varios, { pagado }), {
                    ...marca, intencion_venta: 'asistente', step: PASO_VENTA.VARIOS_ASISTENTES, asistentes_dichos: varios,
                    ...payloadDeOpcion(eleccion),
                });
                return 'venta_asistente';
            }
            const nombreDicho = elegido ?? par?.nombre
                ?? datosDeAsistenteEnVenta(texto, ctx.recientes)?.nombre
                ?? (leido.nombre && sinPregunta && (traeOtroDato(leido) || tieneMarcaDeAsistente(texto)) ? leido.nombre : null);
            // «…y tengo 14 años nací en 2012»: nadie lo pidió, pero es un dato de registro (se guarda y se pide el nombre).
            const frase = normalizarFrase(texto);
            const datoSinPedir = !pedidos && !PARECE_CONSULTA.test(frase)
                && (!!leido.fechaNacimiento || (leido.edad !== null && (DICE_SU_NACIMIENTO.test(frase) || !!leido.posicion)));
            const traeDatoSuelto = !nombreDicho && sinPregunta && (datoSinPedir || (!!pedidos
                && (!!leido.fechaNacimiento || leido.edad !== null || !!leido.acudiente || (!!leido.nombre && pedidos.includes('acudiente')))));
            // La memoria (ficha + chat) se lee solo si el mensaje trae algo de quien asiste.
            const conocido = nombreDicho || traeDatoSuelto ? await registroDelTurno(ctx, venta.desde, ahora, texto) : null;
            if (nombreDicho) {
                const yaAnotado = ctx.recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.ASISTENTE
                    && f.payload?.asistente === nombreDicho && momento(f) >= ahora - 30 * 60_000);
                if (yaAnotado) return 'venta_silencio';
                const dicho: DatosDeRegistro = { ...leido, nombre: nombreDicho };
                // Lo que ya se sabía se suma solo si es de la misma persona.
                const total = conocido && (!conocido.nombre || mismaPersona(conocido.nombre, nombreDicho))
                    ? unirDatosDeRegistro(dicho, { ...conocido, nombre: null }) : dicho;
                const guardado = ctx.anotarAsistente
                    ? await seguro<boolean | void>(() => ctx.anotarAsistente!(nombreDicho, item, total), false) : undefined;
                // Con el pago ya recibido, lo que falta para la inscripción se pide en el MISMO mensaje (prospectos).
                const faltan = conocido && pagado ? faltantesDe(total, hoy) : [];
                const pedido = pedidoDeFaltantes(faltan, total, item.name);
                await ctx.enviar(
                    textoAsistenteAnotado(item, nombreDicho, {
                        pagado, guardado: guardado !== false, capturaIncompleta: pagado && capturaIncompletaPendiente(ctx.recientes, ahora),
                    }) + (pedido ? `\n\n${pedido}` : ''),
                    {
                        ...marca, intencion_venta: 'asistente', step: PASO_VENTA.ASISTENTE, asistente: nombreDicho,
                        ...payloadDeOpcion(eleccion),
                        ...(faltan.length ? { faltan_datos: faltan } : {}),
                    },
                    pagado ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
                return 'venta_asistente';
            }
            // La fecha de nacimiento, la edad o la persona responsable que el bot pidió y llegan sueltas.
            if (traeDatoSuelto && conocido && ctx.anotarDatos) {
                const total = combinarConRespuesta(conocido, leido);
                if (aportaAlgo(conocido, total) && await seguro(() => ctx.anotarDatos!(total, item), false)) {
                    const faltan = faltantesDe(total, hoy);
                    const capturaIncompleta = pagado && capturaIncompletaPendiente(ctx.recientes, ahora);
                    const pedido = pedidoDeFaltantes(faltan, total, item.name);
                    const cierre = pedido || (capturaIncompleta ? TEXTO_FALTA_PANTALLA_COMPLETA
                        : pagado ? 'La escuela valida tu comprobante y te confirma el cupo por aquí.'
                            : '¿Te paso los datos para separar el cupo?');
                    const deQuien = total.nombre ? ` de *${total.nombre}*` : '';
                    await ctx.enviar(
                        `${faltan.length ? `¡Gracias! 🙌 Guardé ese dato${deQuien}.` : `¡Gracias! 🙌 Con eso quedan completos los datos${deQuien}.`} ${cierre}`
                        + (pedido && capturaIncompleta ? `\n\n${TEXTO_FALTA_PANTALLA_COMPLETA}` : ''),
                        {
                            ...marca, intencion_venta: 'asistente', step: PASO_VENTA.ASISTENTE, datos_de_registro: true,
                            ...(faltan.length ? { faltan_datos: faltan } : {}),
                        },
                        pagado || faltan.length ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
                    return 'venta_asistente';
                }
            }
            // Eligió una opción («3 semanas», «Del 23 al 27 nov / Del 30 al 04 dic»): se confirma con su valor.
            if (eleccion) return responderOpcionElegida(ctx, venta, eleccion, marca, ahora);
            // «¿los entrenos serían normales?»: el servicio no trae los entrenamientos de siempre; no se contesta con
            // los datos de otra pregunta (el horario del vacacional).
            if (!eleccion && preguntaPorEntrenosRegulares(texto)) {
                return aLaEscuela(ctx, item, marca, texto, ahora, TEXTO_ENTRENOS_SIN_DATO, { servicio_ia_motivo: 'entrenos_de_siempre' });
            }
            const afiliado = await afiliadoSiHaceFalta(ctx, item, texto);
            const cuentas = await seguro(() => ctx.cuentas(motivoDeServicio(item)), [] as CuentaDePagoEmbudo[]);
            const cobroPrevio = await cobroPrevioDe(ctx, item);
            const r = await seguro<RespuestaDeServicio>(() => ctx.responderPregunta({
                schoolId: ctx.schoolId, conversationId: ctx.conversationId, item, pregunta: texto,
                recientes: ctx.recientes, afiliado, cuentas, hoy, comprobanteRecibido: pagado, cobroPrevio,
            }), { tipo: 'no_se', motivo: 'error' });
            let descartada = false;
            if (r.tipo === 'respuesta' && r.texto.trim()) {
                // (R6) La red: el texto libre nunca dice que anotó algo ni pide un comprobante que ya llegó.
                const limpia = limpiarRespuestaDeVenta(r.texto.trim(), { pagado });
                let salida = limpia.texto;
                if (limpia.quito && pagado) {
                    const registro = await registroDelTurno(ctx, venta.desde, ahora);
                    const yaTengo = registro
                        ? textoYaTengoTuComprobante(item, faltantesDe(registro, hoy), registro, { capturaIncompleta: capturaIncompletaPendiente(ctx.recientes, ahora) })
                        : TEXTO_COMPROBANTE_YA_RECIBIDO;
                    salida = [limpia.texto, yaTengo].filter(Boolean).join(' ');
                }
                if (salida) {
                    // Respuesta PARCIAL: lo que sí está en los datos sale ya; lo que falta lo confirma la escuela (y se le avisa).
                    const pendiente = r.pendiente?.trim() || null;
                    await ctx.enviar(pendiente ? `${salida}\n\n${TEXTO_LO_DEMAS_LA_ESCUELA}` : salida, {
                        ...marca, step: PASO_VENTA.RESPUESTA, repetible: true, ...(limpia.quito ? { red_de_respuesta: true } : {}),
                        ...(pendiente ? { respuesta_parcial: true, falta_en_los_datos: pendiente, pendiente_escuela: texto.slice(0, 300) } : {}),
                    }, botonesDeCierre(item, ctx.recientes, ahora));
                    if (pendiente) {
                        await seguro(() => ctx.avisarEscuela(
                            `Pregunta sobre «${item.name}» que el asistente contestó a medias. Falta en los datos: ${pendiente}. Preguntó: «${texto.slice(0, 300)}».`), undefined);
                    }
                    return 'venta_respuesta';
                }
                descartada = true;
            }
            // Por qué no contestó la IA del servicio (auditable en el payload del saliente).
            const motivoIa = r.tipo === 'no_se' ? { servicio_ia_motivo: r.motivo }
                : { servicio_ia_motivo: descartada ? 'respuesta_descartada_por_la_red' : 'respuesta_vacia' };
            // «¿Con el pago ya tengo el cupo?»: así funciona el sistema (la escuela valida el comprobante).
            if (CONFIRMACION_CUPO.test(normalizarFrase(texto))) {
                await ctx.enviar(TEXTO_CUPO_CON_PAGO, { ...marca, ...motivoIa, step: PASO_VENTA.RESPUESTA, repetible: true });
                return 'venta_respuesta';
            }
            return aLaEscuela(ctx, item, marca, texto, ahora, null, motivoIa);
        }
    }
}

/**
 * Un botón de la venta ([Separar mi cupo] [Ver detalles] [Hablar con alguien] [Ya pagué]).
 * Cada toque manda a lo sumo la respuesta de ESE botón (los detalles largos: la ficha y
 * los botones aparte). Monster 2026-11-09: «que todo sea más fácil y concreto, la idea es
 * vender más rápido». Nunca lanza por la base.
 */
export async function atenderBotonDeVenta(
    ctx: CtxVentaServicio, item: ItemConFicha, accion: AccionBotonVenta,
): Promise<ResultadoVenta> {
    const ahora = (ctx.ahora ?? (() => new Date()))().getTime();
    const marca = { [MARCA_VENTA]: item.id, boton_venta: accion };
    switch (accion) {
        case 'separar':
            return enviarPagoDeServicio(ctx, item, { extra: { boton_venta: accion } });

        case 'ya_pague': {
            // Un comprobante en la ráfaga (o en la cola): lo contesta la cola, una sola vez.
            if (ctx.comprobanteEnCurso && await seguro(() => ctx.comprobanteEnCurso!(), false)) return 'venta_silencio';
            return responderYaPago(ctx, item, marca, null, ahora);
        }

        case 'humano': {
            // Dos toques seguidos: un solo aviso a la escuela.
            const repetido = pasoDeVentaReciente(ctx.recientes, PASO_VENTA.HUMANO, 30, ahora);
            await ctx.enviar(repetido ? TEXTO_A_LA_ESCUELA_REPETIDO : TEXTO_HUMANO, {
                ...marca, step: PASO_VENTA.HUMANO, pendiente_escuela: `pidió hablar con alguien sobre ${item.name}`,
            });
            if (!repetido) {
                await seguro(() => ctx.avisarEscuela(`Pidió hablar con alguien de la escuela sobre «${item.name}». Escríbele por aquí.`), undefined);
            }
            return 'venta_humano';
        }

        case 'detalles':
        default: {
            const ficha = String(item.description ?? '').trim();
            const botones = botonesDeVenta(item, ['separar', 'humano']);
            const deLaEscuela = { ...marca, step: PASO_VENTA.DETALLES, texto_de_la_escuela: true, repetible: true };
            if (ficha && ficha.length <= MAX_CUERPO_CON_BOTONES) {
                await ctx.enviar(ficha, deLaEscuela, botones);
            } else {
                // Meta no deja botones bajo un texto tan largo: la ficha sola y los botones en uno corto.
                if (ficha) await ctx.enviar(ficha, deLaEscuela);
                await ctx.enviar(ficha ? TEXTO_TRAS_DETALLES : lineaDeSaludoDeVenta(item),
                    { ...marca, step: PASO_VENTA.DETALLES, repetible: true }, botones);
            }
            return 'venta_detalles';
        }
    }
}

/**
 * Los botones con que cierra cada respuesta de la venta (Monster 2026-11-09, «ajusta todo con botones,
 * debemos vender más»): sin pago todavía → [Separar mi cupo] [Hablar con alguien]; con los datos de pago
 * ya enviados → [Ya pagué] [Hablar con alguien]; con el comprobante recibido → ninguno (ya compró). Pura.
 */
export function accionesDeCierre(recientes: FilaReciente[], ahora = Date.now()): AccionBotonVenta[] | null {
    if (comprobanteRecibido(recientes, 24 * 60, ahora)) return null;
    const conDatos = recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.PAGO);
    return conDatos ? ['ya_pague', 'humano'] : ['separar', 'humano'];
}

export function botonesDeCierre(item: Pick<ItemConFicha, 'id'>, recientes: FilaReciente[], ahora = Date.now()): BotonDeVenta[] | undefined {
    const a = accionesDeCierre(recientes, ahora);
    return a ? botonesDeVenta(item, a) : undefined;
}
