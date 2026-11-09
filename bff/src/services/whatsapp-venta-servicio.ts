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
import { comoPagar, estadoDeSalientes, type CuentaDePagoEmbudo } from './whatsapp-embudo-prospecto';
import { cop, tokensDistintivos } from './whatsapp-venta-servicios.service';
import { hoyBogota, opcionesDelItem } from './wa-cobro-desde-comprobante.service';
import type { Motivo } from './motivos-de-cobro';
import type { PreguntaDeServicio, RespuestaDeServicio } from './whatsapp-servicio-ia';
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import type { TextosClase } from './textos-clase-prueba';

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

/** Las líneas del valor de hoy: afiliado, opciones o lista por tramo, y el abono. Pura. */
export function lineasDeValorDeVenta(p: PrecioDeServicio): string[] {
    const lineas: string[] = [];
    if (p.opciones.length) {
        lineas.push(`Valores${p.deAfiliado ? ' de afiliado' : ''}:`, ...p.opciones.map((o) => `• ${o.etiqueta}: *${cop(o.precio)}*`));
    } else if (p.hoy !== null) {
        if (p.deAfiliado) lineas.push(`Tu valor como afiliado del club: *${cop(p.hoy)}*.`);
        else lineas.push(`Valor hoy: *${cop(p.hoy)}*${p.siguiente ? ` (${textoDelTramo(p.siguiente)})` : ''}.`);
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
    o: { afiliado?: boolean; hoy?: string } = {},
): string {
    const p = precio ?? precioDelServicio(item, { afiliado: o.afiliado === true, hoy: o.hoy ?? hoyBogota(Date.now()) });
    const valor = lineasDeValorDeVenta(p);
    const como = cuentas.length ? comoPagar(cuentas).replace(/\n+$/, '') : null;
    const pagar = como
        ? `Transfiere ${como}${como.includes('\n') ? '' : '.'}`
        : SIN_CUENTAS_DE_PAGO;
    return [
        `Para separar tu cupo ${enElServicio(item)}:`,
        valor.join('\n'),
        pagar,
        como ? CIERRE_DE_PAGO : `Cuando pagues, ${CIERRE_DE_PAGO.charAt(0).toLowerCase()}${CIERRE_DE_PAGO.slice(1)}`,
    ].filter(Boolean).join('\n\n');
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
const PIDE_NOMBRE_DE_ASISTENTE = /nombre completo de quien asiste/i;
/** Palabras de cortesía que `nombreDeAsistente` deja pasar y que, solas, no son un nombre («Mucho gusto»). */
const NO_ES_NOMBRE_SUELTO = /\b(mucho|mucha|muchos|gusto|feliz|saludos|bendiciones|igualmente|amable|amables|tranquilo|tranquila|hecho|ahora|luego|despues|manana|hoy|ayer|claro|verdad|seguro|segura)\b/;

/**
 * ¿El mensaje son los DATOS DE QUIEN ASISTE al servicio? («Nicolás Cubides Ávila /
 * 18 de Diciembre del 2006 / Opuesto»: antes «Eso te lo confirma la escuela».) Un
 * nombre de dos palabras o más al comienzo (`nombreDeAsistente`: «Sede Suba»,
 * «Hombre», «Club y torneos» no lo son) y además: una fecha, un año, una edad o una
 * posición después del nombre; o el mensaje es SOLO el nombre y lo último que dijo
 * el bot pidió «el nombre completo de quien asiste». null = no lo es. Pura.
 */
export function datosDeAsistenteEnVenta(texto: string | null | undefined, recientes: FilaReciente[] = []): { nombre: string } | null {
    const crudo = String(texto ?? '').trim();
    if (!crudo || crudo.length > 200 || /[?¿]/.test(crudo)) return null;
    const nombre = nombreDeAsistente(crudo);
    if (!nombre) return null;
    const sinNombre = ` ${normalizarFrase(crudo)} `.replace(` ${normalizarFrase(nombre)} `, ' ');
    if (DATO_DE_ASISTENTE.test(sinNombre)) return { nombre };
    if (!nombreDeAsistente(crudo, { entero: true }) || NO_ES_NOMBRE_SUELTO.test(normalizarFrase(nombre))) return null;
    const ultimo = [...recientes].filter((f) => f.direction === 'outbound').sort((a, b) => momento(b) - momento(a))[0];
    return ultimo && PIDE_NOMBRE_DE_ASISTENTE.test(String(ultimo.text_body ?? '')) ? { nombre } : null;
}

/** «¡Gracias! 🙌 Anoté a *Nicolás Cubides Ávila* como asistente de la Clínica…» + el pago con una pregunta o la validación. Pura. */
export function textoAsistenteAnotado(item: ItemConFicha, nombre: string, o: { pagado: boolean }): string {
    const anotado = `¡Gracias! 🙌 Anoté a *${nombre}* como asistente ${deLaDelServicio(item)}.`;
    return o.pagado
        ? `${anotado} La escuela valida tu comprobante y te confirma el cupo por aquí.`
        : `${anotado} ¿Te paso los datos para separar el cupo?`;
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
    const conDatos = o.recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.PAGO);
    if (conDatos) {
        return `Hola 👋 ¿Pudiste hacer el pago ${deLaDelServicio(item)}? Cuando lo hagas, ${CIERRE_DE_PAGO.charAt(0).toLowerCase()}${CIERRE_DE_PAGO.slice(1)}`;
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

export type IntencionVenta = 'pago' | 'ya_pago' | 'otra_fecha' | 'saludo' | 'cierre' | 'detalle' | 'club';

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

/** «Buenas, tengo una pregunta» sin la pregunta: un saludo con algo por venir. */
const ANUNCIA_PREGUNTA = /^((hola|buenas|buenos dias|buenas tardes|buenas noches|buen dia) )*(tengo|tenemos|una) (una |unas )?(pregunta|preguntas|duda|dudas|consulta|consultas|inquietud|inquietudes)$/;

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
]);
const NUCLEO_CIERRE = new Set([
    'gracias', 'atento', 'atenta', 'atentos', 'atentas', 'pendiente', 'pendientes', 'listo', 'lista', 'perfecto',
    'perfecta', 'excelente', 'genial', 'entendido', 'entendida', 'entiendo', 'acuerdo', 'chao', 'bye', 'adios',
    'bendiciones', 'igualmente', 'super',
]);
const EMOJI_DE_CIERRE = /[🙏🙌❤💪👏😊🤗🥰💙💚💛]/u;

/**
 * La intención de un mensaje dentro de una venta. Pura.
 *  · club: pide el club de forma explícita (`pideElClub`) → sale de la venta.
 *  · ya_pago: «ya pagué», «te envío el comprobante», «ya consigné».
 *  · otra_fecha: «no puedo ese día», «¿hay otra fecha?», «tenemos torneo».
 *  · cierre: «gracias», «quedo atento», «listo», «🙏».
 *  · saludo: «hola», «ok», «.», «buenas», «👍».
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
    if (CONFIRMACION_CUPO.test(t)) return 'detalle';
    const palabras = t.split(' ');
    if (!crudo.includes('?') && palabras.every((w) => VOCABULARIO_CIERRE.has(w)) && palabras.some((w) => NUCLEO_CIERRE.has(w))) {
        return 'cierre';
    }
    if (palabras.every((w) => VOCABULARIO_SALUDO.has(w)) || ANUNCIA_PREGUNTA.test(t)) return 'saludo';
    if (AFIRMACION.test(t)) return 'pago';
    if (INCLUYE.test(t) && !DATOS_DE_PAGO_EXPLICITOS.test(t)) return 'detalle';
    if (PAGO.test(t)) return 'pago';
    return 'detalle';
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
const INTENCIONES_DE_LA_VENTA: ReadonlySet<IntencionVenta> = new Set(['pago', 'ya_pago', 'otra_fecha', 'saludo', 'cierre']);

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
     * simulación: no escribe. Nunca lanza.
     */
    anotarAsistente?: (nombre: string, item: ItemConFicha) => Promise<void>;
    ahora?: () => Date;
}

export type ResultadoVenta =
    | 'venta_pago' | 'venta_sin_precio' | 'venta_respuesta' | 'venta_a_la_escuela' | 'venta_otra_fecha'
    | 'venta_ya_pago' | 'venta_saludo' | 'venta_silencio' | 'venta_boton_club' | 'venta_asistente'
    | 'venta_detalles' | 'venta_humano';

async function seguro<T>(fn: () => Promise<T>, siFalla: T): Promise<T> {
    try { return await fn(); } catch { return siFalla; }
}

async function afiliadoSiHaceFalta(ctx: CtxVentaServicio, item: ItemConFicha): Promise<boolean> {
    return tienePrecioDeAfiliado(item) ? seguro(() => ctx.afiliado(), false) : false;
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
    const afiliado = await afiliadoSiHaceFalta(ctx, item);
    const precio = precioDelServicio(item, { afiliado, hoy });
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
    await ctx.enviar(textoDePagoDeServicio(item, precio, cuentas) + nota, {
        ...marca,
        step: PASO_VENTA.PAGO,
        repetible: true,
        datos_de_pago: cuentas.length > 0,
        precio_hoy: precio.hoy,
        ...(precio.abono !== null ? { abono: precio.abono } : {}),
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
    // Un comprobante en la ráfaga (o en la cola): lo contesta la cola, una sola vez.
    const colaContesta = async () => (ctx.comprobanteEnCurso ? seguro(() => ctx.comprobanteEnCurso!(), false) : false);

    switch (intencion) {
        case 'cierre':
            return 'venta_silencio';

        case 'saludo': {
            if (await colaContesta()) return 'venta_silencio';
            if (pasoDeVentaReciente(ctx.recientes, PASO_VENTA.SALUDO, MIN_ENTRE_SALUDOS_DE_VENTA, ahora)) return 'venta_silencio';
            await ctx.enviar(lineaDeSaludoDeVenta(item), { ...marca, step: PASO_VENTA.SALUDO }, botonesDeVenta(item, BOTONES_DE_ENTRADA));
            return 'venta_saludo';
        }

        case 'ya_pago': {
            if (await colaContesta()) return 'venta_silencio';
            const yaLlego = comprobanteRecibido(ctx.recientes, 24 * 60, ahora);
            await ctx.enviar(yaLlego ? TEXTO_COMPROBANTE_YA_RECIBIDO : TEXTO_YA_PAGO, { ...marca, step: PASO_VENTA.YA_PAGO, repetible: true });
            return 'venta_ya_pago';
        }

        case 'otra_fecha': {
            await ctx.enviar(TEXTO_OTRA_FECHA, { ...marca, step: PASO_VENTA.OTRA_FECHA, pendiente_escuela: texto.slice(0, 300) });
            await seguro(() => ctx.avisarEscuela(`Interesado en «${item.name}» pregunta por otra fecha: «${texto.slice(0, 300)}».`), undefined);
            return 'venta_otra_fecha';
        }

        case 'pago':
            return enviarPagoDeServicio(ctx, item, { pregunta: texto, extra: { intencion_venta: intencion } });

        case 'detalle':
        default: {
            // Los datos de quien asiste: se agradecen y se anotan (la cola los usa para el
            // cobro). Sin pago todavía, el pago se OFRECE con una pregunta; los datos, cuando los pida.
            const asistente = datosDeAsistenteEnVenta(texto, ctx.recientes);
            if (asistente) {
                const yaAnotado = ctx.recientes.some((f) => f.direction === 'outbound' && f.payload?.step === PASO_VENTA.ASISTENTE
                    && f.payload?.asistente === asistente.nombre && momento(f) >= ahora - 30 * 60_000);
                if (yaAnotado) return 'venta_silencio';
                if (ctx.anotarAsistente) await seguro(() => ctx.anotarAsistente!(asistente.nombre, item), undefined);
                const pagado = pagoRecibidoEnVenta(ctx.recientes, venta, ahora);
                await ctx.enviar(textoAsistenteAnotado(item, asistente.nombre, { pagado }),
                    { ...marca, intencion_venta: 'asistente', step: PASO_VENTA.ASISTENTE, asistente: asistente.nombre },
                    pagado ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
                return 'venta_asistente';
            }
            const hoy = hoyBogota(ahora);
            const afiliado = await afiliadoSiHaceFalta(ctx, item);
            const cuentas = await seguro(() => ctx.cuentas(motivoDeServicio(item)), [] as CuentaDePagoEmbudo[]);
            const r = await seguro<RespuestaDeServicio>(() => ctx.responderPregunta({
                schoolId: ctx.schoolId, conversationId: ctx.conversationId, item, pregunta: texto,
                recientes: ctx.recientes, afiliado, cuentas, hoy,
            }), { tipo: 'no_se', motivo: 'error' });
            if (r.tipo === 'respuesta' && r.texto.trim()) {
                await ctx.enviar(r.texto.trim(), { ...marca, step: PASO_VENTA.RESPUESTA, repetible: true }, botonesDeCierre(item, ctx.recientes, ahora));
                return 'venta_respuesta';
            }
            // Por qué no contestó la IA del servicio (auditable en el payload del saliente).
            const motivoIa = r.tipo === 'no_se' ? { servicio_ia_motivo: r.motivo } : { servicio_ia_motivo: 'respuesta_vacia' };
            // «¿Con el pago ya tengo el cupo?»: así funciona el sistema (la escuela valida el comprobante).
            if (CONFIRMACION_CUPO.test(normalizarFrase(texto))) {
                await ctx.enviar(TEXTO_CUPO_CON_PAGO, { ...marca, ...motivoIa, step: PASO_VENTA.RESPUESTA, repetible: true });
                return 'venta_respuesta';
            }
            const repetido = pasoDeVentaReciente(ctx.recientes, PASO_VENTA.A_LA_ESCUELA, 30, ahora);
            await ctx.enviar(repetido ? TEXTO_A_LA_ESCUELA_REPETIDO : TEXTO_A_LA_ESCUELA, {
                ...marca, ...motivoIa, step: PASO_VENTA.A_LA_ESCUELA, pendiente_escuela: texto.slice(0, 300),
            }, repetido ? undefined : botonesDeCierre(item, ctx.recientes, ahora));
            await seguro(() => ctx.avisarEscuela(
                `Pregunta sobre «${item.name}» que el asistente no tiene en los datos: «${texto.slice(0, 300)}».`), undefined);
            return 'venta_a_la_escuela';
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
            const yaLlego = comprobanteRecibido(ctx.recientes, 24 * 60, ahora);
            await ctx.enviar(yaLlego ? TEXTO_COMPROBANTE_YA_RECIBIDO : TEXTO_YA_PAGO, { ...marca, step: PASO_VENTA.YA_PAGO, repetible: true });
            return 'venta_ya_pago';
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
