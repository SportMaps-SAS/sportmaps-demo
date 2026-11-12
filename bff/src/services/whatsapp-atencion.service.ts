/**
 * whatsapp-atencion.service — ¿A quién atiende el asistente, y está prendido?
 *
 * Dos preguntas que antes se contestaban (o no) en cada camino por separado, y
 * por eso se contradecían. Medido en Dynasty el 2026-10-03, primer día con el
 * número conectado por Coexistence y el bot APAGADO (`ai_enabled=false`):
 *
 *   - El bot igual corría el modelo en cada mensaje y dejaba 316 borradores que
 *     nadie aprobó; 238 eran «escríbeme tu correo» a contactos PERSONALES.
 *   - El worker de comprobantes no miraba `ai_enabled` y SÍ le escribió a 17
 *     familias pidiéndoles el correo.
 *
 * Coexistence mete al sistema TODO el WhatsApp de la escuela, que en una
 * escuela chica es también el WhatsApp personal de quien la dirige. Sobre 55
 * conversaciones: 30 eran familias, 21 números desconocidos y 4 el propio
 * equipo (178 de los 375 mensajes). La dueña lo quiso así a propósito, y no
 * pierde nada: con Coexistence ella sigue viendo y contestando todo desde su
 * celular. Así que el asistente NO tiene que hacerse cargo de todo — solo de
 * las familias, y callarse con el resto.
 *
 * Este archivo es el único lugar donde se decide eso. El bot (texto), el
 * webhook (audio/video) y el worker (adjuntos) lo consultan; ninguno decide
 * por su cuenta.
 */

import { supabase } from '../config/supabase';
import type { WhatsAppIntegration } from './whatsapp.service';
import { conversacionTomada } from './whatsapp-tomada.service';
import { FILTRO_SIN_MARCA_MANUAL, esMarcaNoFamilia, leerConMarca, type TipoMarcado } from './whatsapp-tipo-contacto';
import { rolDePersonal } from './whatsapp-personal-escuela.service';

/**
 * - familia            → acudiente con cuenta de un atleta activo (por teléfono o por OTP)
 * - familia_sin_cuenta → el número está en la ficha de un atleta activo, sin cuenta
 * - ambiguo            → el número está en dos cuentas: lo resuelve un humano
 * - staff              → personal: administra la escuela (owner/admin), es profe de
 *                        la escuela o admin de la plataforma (whatsapp-personal-escuela)
 * - desconocido        → nada de lo anterior: amigos, proveedores, prospectos
 * - personal | negocio | otro_club | plataforma
 *                      → la escuela lo marcó a mano como no-familia (manda sobre todo;
 *                        ver whatsapp-tipo-contacto)
 */
export type TipoDeContacto =
    | 'familia' | 'familia_sin_cuenta' | 'ambiguo' | 'staff' | 'desconocido' | TipoMarcado;

export const TIPOS_QUE_SE_ATIENDEN: ReadonlySet<TipoDeContacto> =
    new Set(['familia', 'familia_sin_cuenta', 'ambiguo']);

interface AjustesDeAtencion {
    botEncendido: boolean;
    responderDesconocidos: boolean;
    /**
     * ¿Se le contesta al desconocido con intención CLARA de prospecto aunque
     * `responder_desconocidos=false`? Default true; sin la columna (migración
     * `whatsapp_responder_prospectos` aún no aplicada) también true.
     */
    responderProspectos: boolean;
}

/**
 * Lee `ai_enabled` y `responder_desconocidos` de la integración.
 *
 * Sin fila de ajustes → APAGADO. El alta del canal crea la integración con
 * `ai_enabled=false` (F4, `8b98f1be`); una integración sin ajustes es un estado
 * a medio hacer, y ante la duda el asistente no habla.
 *
 * `responder_desconocidos` llega con la migración de Fase A; mientras no exista
 * la columna la consulta falla y se reintenta sin ella (default false).
 */
export async function ajustesDeAtencion(integrationId: string): Promise<AjustesDeAtencion> {
    // De la consulta más completa a la más pobre: cada columna llegó con una
    // migración distinta, y una que falte no puede apagar al asistente entero.
    const intentos = [
        'ai_enabled, responder_desconocidos, responder_prospectos',
        'ai_enabled, responder_desconocidos',
        'ai_enabled',
    ];
    let fila: any = null;
    for (const columnas of intentos) {
        const r = await supabase
            .from('whatsapp_settings')
            .select(columnas)
            .eq('integration_id', integrationId)
            .maybeSingle();
        if (!r.error) { fila = r.data; break; }
    }

    return {
        botEncendido: fila?.ai_enabled === true,
        responderDesconocidos: fila?.responder_desconocidos === true,
        responderProspectos: fila?.responder_prospectos !== false,
    };
}

export async function botEncendido(integrationId: string): Promise<boolean> {
    return (await ajustesDeAtencion(integrationId)).botEncendido;
}

/**
 * Clasifica a quien escribe y deja el resultado en
 * `whatsapp_conversations.contact_kind` para que el buzón pueda filtrar.
 *
 * Corre aunque el bot esté apagado: el buzón necesita separar familias del
 * resto igual.
 *
 * Usa `wa_identify_by_phone`, que además VINCULA la conversación cuando
 * encuentra al acudiente. Es el mismo efecto que el bot ya tenía al
 * identificar; no es un efecto nuevo.
 */
export async function clasificarContacto(
    integration: WhatsAppIntegration,
    conversationId: string | null,
    contactWaId: string,
): Promise<TipoDeContacto> {
    return (await clasificarConMarca(integration, conversationId, contactWaId)).tipo;
}

/**
 * Como `clasificarContacto`, más la bandera `tambien_familia`.
 *
 * - Marca manual SIN bandera → la marca (personal, negocio…): no es familia.
 * - Marca manual CON bandera → se clasifica por teléfono SIN guardar (la marca
 *   no se pisa). Si resulta familia, se devuelve ese tipo con
 *   `tambienFamilia=true`: sus comprobantes se aplican en silencio. Si no,
 *   la marca.
 */
export async function clasificarConMarca(
    integration: WhatsAppIntegration,
    conversationId: string | null,
    contactWaId: string,
): Promise<{ tipo: TipoDeContacto; tambienFamilia: boolean }> {
    // 1. Lo marcado a mano manda. Si la columna aún no existe, se ignora.
    if (conversationId) {
        const { data } = await leerConMarca((cols) => supabase
            .from('whatsapp_conversations')
            .select(cols)
            .eq('id', conversationId)
            .maybeSingle(), 'id');
        const marca = (data as any)?.contact_kind;
        if (esMarcaNoFamilia(marca)) {
            if ((data as any)?.tambien_familia !== true) return { tipo: marca, tambienFamilia: false };
            const real = await clasificarSinGuardar(integration, conversationId, contactWaId);
            return TIPOS_QUE_SE_ATIENDEN.has(real)
                ? { tipo: real, tambienFamilia: true }
                : { tipo: marca, tambienFamilia: false };
        }
    }

    const tipo = await clasificarSinGuardar(integration, conversationId, contactWaId);
    if (conversationId) await guardarTipo(conversationId, tipo);
    return { tipo, tambienFamilia: false };
}

async function clasificarSinGuardar(
    integration: WhatsAppIntegration,
    conversationId: string | null,
    contactWaId: string,
): Promise<TipoDeContacto> {
    const { data: porTelefono, error } = await supabase.rpc('wa_identify_by_phone', {
        p_integration_id: integration.id,
        p_contact_wa_id: contactWaId,
    });
    const estado = error ? null : (porTelefono as any)?.estado;
    if (estado === 'identificado') return 'familia';
    if (estado === 'debe_registrarse') return 'familia_sin_cuenta';
    if (estado === 'ambiguo') return 'ambiguo';
    // Número que pasó a otra cuenta: es familia, y el bot tiene que atenderlo
    // para pedirle el código por correo (wa-revinculacion.service).
    if (estado === 'revinculacion_pendiente') return 'familia';

    // Se identificó por OTP desde otro teléfono: el número no lo resuelve,
    // pero la persona ya probó quién es.
    if (conversationId) {
        const { data: conv } = await supabase
            .from('whatsapp_conversations')
            .select('identified, parent_id')
            .eq('id', conversationId)
            .maybeSingle();
        if ((conv as any)?.identified && (conv as any)?.parent_id) return 'familia';
    }

    const { data: staff } = await supabase.rpc('wa_identify_staff_admin_by_phone', {
        p_school_id: integration.school_id,
        p_wa_phone_number: contactWaId,
    });
    if ((staff as any)?.estado === 'identificado') return 'staff';

    // El resto del personal (profes) y los admins de la plataforma: tampoco son
    // prospectos (Monster 2026-11-08: un admin de SportMaps le escribió a Iván y Mapi le
    // contestó el guion de prospecto). Una consulta por escuela, cacheada.
    if (await rolDePersonal(integration.school_id, contactWaId)) return 'staff';

    return 'desconocido';
}

async function guardarTipo(conversationId: string, tipo: TipoDeContacto): Promise<void> {
    // No pisa una marca manual (personal, negocio…; carrera con el buzón).
    const { error } = await supabase
        .from('whatsapp_conversations')
        .update({ contact_kind: tipo })
        .eq('id', conversationId)
        .or(FILTRO_SIN_MARCA_MANUAL);
    if (error && !avisoDeColumnaDado) {
        avisoDeColumnaDado = true;
        console.warn('[wa-atencion] no se pudo guardar contact_kind (¿falta la migración de Fase A?)',
            { err: error.message });
    }
}
let avisoDeColumnaDado = false;

/**
 * La decisión completa: ¿el asistente le contesta a este contacto?
 *
 * - Bot apagado → nunca.
 * - Familias (con o sin cuenta, o ambiguas) → sí.
 * - Desconocidos → solo si la escuela lo pidió (`responder_desconocidos`).
 * - Staff y marcas manuales (personal, negocio…) → nunca: es el equipo o la
 *   vida privada de la dueña.
 * - Marca manual con «también es familia» → el texto tampoco (`atender=false`):
 *   es la vida privada de la dueña. Se devuelve el tipo de familia y
 *   `tambienFamilia=true` para que el worker aplique sus comprobantes en
 *   silencio, como con una conversación tomada.
 *
 * `atender=false` con `tipo='desconocido'` y el bot prendido NO es silencio
 * seguro: el webhook todavía le pasa el texto a `atenderDesconocido` (bot), que
 * contesta solo correo/código vigente o tema escolar (`temaEscolar`, abajo).
 * Staff y personal no tienen esa puerta. Con `tomada=true` tampoco.
 */
export async function debeAtender(
    integration: WhatsAppIntegration,
    conversationId: string | null,
    contactWaId: string,
): Promise<{ atender: boolean; tipo: TipoDeContacto; botEncendido: boolean; tomada: boolean; tambienFamilia: boolean }> {
    const [ajustes, { tipo, tambienFamilia }, tomada] = await Promise.all([
        ajustesDeAtencion(integration.id),
        clasificarConMarca(integration, conversationId, contactWaId),
        conversacionTomada(conversationId),
    ]);
    // Tomada por una persona desde el buzón (mejora 9): nada automático, sea
    // quien sea. `tipo` y `botEncendido` se devuelven igual: el worker de
    // comprobantes los usa para seguir APLICANDO el comprobante (sin escribirle
    // a la familia; ver whatsapp-tomada.service).
    const atender = !tomada && !tambienFamilia && ajustes.botEncendido && (
        TIPOS_QUE_SE_ATIENDEN.has(tipo) ||
        (tipo === 'desconocido' && ajustes.responderDesconocidos)
    );
    return { atender, tipo, botEncendido: ajustes.botEncendido, tomada, tambienFamilia };
}

// ─── El desconocido que SÍ es de la escuela ──────────────────────────────────
//
// «Solo familias» dejó afuera a dos que sí son de la escuela y el teléfono no
// reconoce:
//
//   - la familia que escribe desde OTRO número (antes se verificaba mandando
//     su correo y el código; con el filtro ya no le contestaba nadie), y
//   - el prospecto. En Dynasty, el 2026-10-02, llegaron «Quiero inscribir a mi
//     hija a volleyball» y «Me puedes compartir más información (Horarios,
//     cursos, lugar de práctica, valor…)» de números que no estaban en ninguna
//     ficha. Un prospecto es plata.
//
// La decisión (opción «1C», aprobada): con `responder_desconocidos=false` al
// desconocido se le contesta SOLO si el mensaje trae un correo o un código de
// verificación vigente, o si es de tema escolar — y lo escolar, una vez cada
// 30 días por conversación. El resto sigue en silencio.
//
// Esto lo decide `temaEscolar`, con REGLAS y no con el modelo: se evalúa sobre
// cada mensaje de cada amigo de la dueña, tiene que ser gratis y tiene que
// poder explicarse por qué disparó. Un LLM acá es caro e impredecible justo en
// el lado donde equivocarse le escribe a la vida privada de alguien.

export type TemaEscolar = 'inscripcion' | 'pagos';

/**
 * La normalización de `normalizar()` del bot (minúsculas, sin tildes, sin
 * puntuación), con UNA diferencia: la puntuación se vuelve espacio en vez de
 * borrarse. Allá se compara el mensaje entero («si», «no»); acá se buscan
 * palabras, y «información(Horarios,cursos» borrando la puntuación queda como
 * una sola palabra que no matchea nada. Copiada y no importada porque el bot
 * depende de este archivo y no al revés.
 */
function normalizarTexto(t: string): string {
    return t
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const MESES = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';

/**
 * PAGOS — términos que solo usa quien le paga a la escuela.
 *
 * Lo que NO está, a propósito, medido sobre los mensajes de contactos no-familia
 * de Dynasty del 2026-10-03:
 *   - «pago», «pagar», «pagarte» sueltos: «¿Dónde andas para pagarte lo de la
 *     rifa?». Pagar es de la vida diaria; pagar la MENSUALIDAD es de la escuela.
 *   - «plata», «mandar»: «Yo voy a hacer plata», «Te mando para que desayunes».
 *   - «saldo» suelto: en Colombia es el saldo del celular. Va «saldo pendiente».
 *   - «deuda», «cuota» sueltas: «2da cuota vuelos…» es un viaje.
 *   - «cuenta de cobro»: la manda un proveedor o un profesor, no una familia.
 *   - «cuánto TE debo»: es entre amigos. Va «cuánto debo».
 */
const PAGOS_FUERTES: RegExp[] = [
    /\bmensualidad(es)?\b/,
    /\bcomprobantes?\b/,
    /\bconsignacion(es)?\b/,
    /\bconsign(e|o|ar|amos|aste|ado)\b/,
    /\btransferencias?\b/,
    /\btransferi\b/,
    /\brecibo de (pago|caja)\b/,
    /\bsoportes? (de pago|del pago|de la mensualidad|del mes|de mes|mes)\b/,
    /\bpago (del|de la|de) (mes|mensualidad|matricula|inscripcion)\b/,
    new RegExp(`\\bpago (del mes de |de |mes de )${MESES}\\b`),
    /\b(valor|saldo) pendiente\b/,
    /\bcuanto debo\b/,
    /\bpaz y salvo\b/,
    /\bacudiente\b/,
];

/**
 * INSCRIPCIÓN — términos que por sí solos ya son de una escuela.
 *
 * «Matrícula» queda aunque en Colombia también sea la del carro: en el número
 * de una escuela la del carro no apareció ni una vez, y la de la escuela sí.
 */
const INSCRIPCION_FUERTES: RegExp[] = [
    /\binscrib\w*/,               // inscribir, inscribirla, inscribo, inscribimos
    /\binscripcion(es)?\b/,
    /\bmatricul\w*/,              // matricular, matricularla, matricula
    /\bclases? (de prueba|de cortesia|gratis|gratuitas?)\b/,
    /\bprogramas? de formacion\b/,
];

/**
 * INSCRIPCIÓN — palabras sueltas que solas no alcanzan.
 *
 * «Precio», «información» u «horario» los dice cualquiera («pásame la info del
 * restaurante y el precio»). Se exigen DOS conceptos distintos y que al menos
 * uno sea de deporte o escuela. Así «información (Horarios, cursos, lugar de
 * práctica, valor)» dispara y «info del restaurante y el precio» no.
 *
 * Cada grupo cuenta una vez: «valor» y «cuánto cuesta» son el mismo concepto.
 */
const CONCEPTOS_GENERICOS: Record<string, RegExp> = {
    precio: /\b(precios?|valor(es)?|costos?|tarifas?|cuanto (cuesta|vale|cobran))\b/,
    horario: /\bhorarios?\b/,
    informacion: /\b(informacion|info)\b/,
};
const CONCEPTOS_DE_ESCUELA: Record<string, RegExp> = {
    actividad: /\b(clases?|cursos?|entrenamientos?|entrenar|entrenan|practicas?|practias?)\b/,
    categoria: /\b(categorias?|cupos?)\b/,
    lugar: /\b(sedes?|donde entrenan|lugar de practica)\b/,
    deporte: /\b(voley|volley|voleibol|volleyball|futbol|baloncesto|basket|natacion|patinaje|deportes?|escuela|club|academia)\b/,
    interes: /\b(interesad[oa]s?|quiero entrar|quisiera entrar)\b/,
};

/**
 * «Soy familia» sin decir pagos: «mi hija no va a ir al entrenamiento». «Mi
 * hija» sola no alcanza —la mamá de la dueña también tiene hija—; tiene que
 * venir con algo de la escuela al lado.
 */
const MI_HIJO = /\b(mi|mis) hij[oa]s?\b/;
const CONTEXTO_FAMILIA = /\b(entren\w*|clases?|escuela|club|categorias?|equipo|voley|volley|voleibol|volleyball|uniformes?|partidos?|torneos?|profe|entrenador[a]?)\b/;

/**
 * ¿El mensaje de un desconocido es de tema escolar? Pura y determinista.
 *
 * Orden (si coinciden ambas intenciones, gana pagos — decisión 1C):
 *   1. término fuerte de pagos            → 'pagos'
 *   2. término fuerte de inscripción       → 'inscripcion'
 *   3. dos conceptos sueltos de inscripción (uno de escuela) → 'inscripcion'
 *   4. «mi hijo/hija» + contexto escolar   → 'pagos' (es familia: se le pide el correo)
 *   5. nada                                → null (silencio)
 *
 * El 3 va antes que el 4 para que «mi hija quiere info de horarios de vóley»
 * reciba el enlace y no un pedido de correo.
 */
export function temaEscolar(
    texto: string | null | undefined,
    opciones: { sinFamiliaImplicita?: boolean } = {},
): TemaEscolar | null {
    if (!texto) return null;
    const t = normalizarTexto(texto);
    if (!t) return null;

    if (PAGOS_FUERTES.some((re) => re.test(t))) return 'pagos';
    if (INSCRIPCION_FUERTES.some((re) => re.test(t))) return 'inscripcion';

    const genericos = Object.values(CONCEPTOS_GENERICOS).filter((re) => re.test(t)).length;
    const deEscuela = Object.values(CONCEPTOS_DE_ESCUELA).filter((re) => re.test(t)).length;
    if (deEscuela >= 1 && genericos + deEscuela >= 2) return 'inscripcion';

    // Regla 4. Con `sinFamiliaImplicita` (el DESCONOCIDO, 2026-10-24) no se
    // supone que «mi hija» + escuela sea una familia: «mi hija se quiere meter
    // en la academia de voleibol» es un prospecto y recibía «No reconozco este
    // número entre las familias… tus cobros son datos privados». Quien llega
    // sin señal propia de cliente pasa por la puerta única (whatsapp-puerta-desconocido).
    if (!opciones.sinFamiliaImplicita && mencionaFamiliaConEscuela(texto)) return 'pagos';

    return null;
}

/**
 * «Mi hijo/hija» + algo de la escuela («mi hija no va a ir al entrenamiento»):
 * habla de la escuela, aunque no diga si es familia. Sirve de señal para NO
 * callar un pedido real y, sin `sinFamiliaImplicita`, es la regla 4 de `temaEscolar`.
 */
export function mencionaFamiliaConEscuela(texto: string | null | undefined): boolean {
    const t = normalizarTexto(texto || '');
    return !!t && MI_HIJO.test(t) && CONTEXTO_FAMILIA.test(t);
}

/**
 * Señales de que ya le paga a la escuela: hay un cobro suyo de por medio.
 * Con alguna de estas, «valor» o «cuánto» es SU cobro, no la lista de precios.
 */
const YA_LE_PAGA: RegExp[] = [
    /\bcomprobantes?\b/,
    /\bconsign\w*/,
    /\btransfer\w*/,
    /\brecibo de (pago|caja)\b/,
    /\bsoportes?\b/,
    /\bpendientes?\b/,
    /\bcuanto debo\b/,
    /\bpaz y salvo\b/,
    /\bacudiente\b/,
    /\bdel mes\b/,
    new RegExp(`\\b${MESES}\\b`),
];

/**
 * Cuando `temaEscolar` dice 'pagos', ¿el mensaje TAMBIÉN puede ser de alguien
 * que todavía no está inscrito y pregunta el precio?
 *
 * «¿Qué precio tiene la mensualidad?» o «¿cuánto vale la mensualidad de 2
 * clases?» dicen «mensualidad» —término fuerte de pagos, por eso ganan pagos—
 * pero los escribe igual una familia desde otro celular que un prospecto. Con
 * solo pagos, al prospecto se le pedía el correo de una cuenta que no tiene y
 * se quedaba sin el enlace de inscripción. Con estas señales el bot manda UN
 * mensaje con las dos salidas.
 *
 * NO dispara si el mensaje trae señales de un cobro que ya existe
 * (`YA_LE_PAGA`): «me confirmas el valor para el pago del mes de septiembre» o
 * «el valor pendiente» son de familia, y mandarles el enlace de inscripción es
 * ruido. Pura y determinista, como `temaEscolar`.
 */
/**
 * «Quiero inscribir a mi hija»: intención de inscribirse, no de pagar algo que
 * ya debe. A esa persona no se le pide el correo de familia (auditoría
 * 2026-10-28, X-07). Pura.
 */
export function quiereInscribirse(texto: string | null | undefined): boolean {
    if (!texto) return false;
    const t = normalizarTexto(texto);
    if (!t || YA_LE_PAGA.some((re) => re.test(t))) return false;
    return INSCRIPCION_FUERTES.slice(0, 3).some((re) => re.test(t));
}

export function preguntaPrecioComoProspecto(texto: string | null | undefined): boolean {
    if (!texto) return false;
    const t = normalizarTexto(texto);
    if (!t) return false;
    if (YA_LE_PAGA.some((re) => re.test(t))) return false;
    return INSCRIPCION_FUERTES.some((re) => re.test(t))
        || CONCEPTOS_GENERICOS.precio.test(t)
        || /\bcuanto (es|son|sale)\b/.test(t);
}

// ─── El prospecto: «respóndeles a los que piden info, a los otros no» ────────
//
// Medido en Dynasty el 2026-10-05/06: con `responder_desconocidos=false` se
// quedaron sin respuesta «Estoy interesado en iniciar», «esoty interesada»,
// «deseo saber horarios… para pasar y mirar las instalaciones», «resiven
// menores en formación?», y el seguimiento «Mi hija tiene 14 años» de alguien
// que un mensaje antes había pedido información. `temaEscolar` exige vocabulario
// de escuela que el prospecto no siempre usa.
//
// `intencionDeProspecto` es la regla para ese caso: más ancha que `temaEscolar`
// en lo que es claramente de alguien que quiere ENTRAR a la escuela, y igual de
// estricta con todo lo demás. Un saludo, un «gracias», un audio o una imagen de
// un desconocido NUNCA abren la puerta. Ante la duda, silencio: dejar pasar un
// prospecto dudoso le cuesta una respuesta tardía (la dueña igual lo ve en su
// celular); hablarle a un contacto personal ya pasó dos veces y fue grave.

/** Contexto de escuela/deporte que acompaña a una palabra suelta. */
const CONTEXTO_PROSPECTO =
    /\b(club|academia|escuela|clases?|curso|cursos|grupos?|categorias?|entren\w*|practicar|jugar|voley|volley|voleibol|volleyball|deportes?|iniciar|iniciacion|empezar|comenzar|entrar|ingresar|inscrib\w*|conocer|instalaciones|formacion|ninos?|ninas?|adultos?|menores|hij[oa]s?)\b/;

const PROSPECTO_FUERTE: RegExp[] = [
    // Los botones de WhatsApp de la web del club precargan el mensaje y lo cierran con
    // «(ref: web)», «(ref: web-torneos)»… (Dynasty 2026-10-21). Quien llega por ahí
    // pidió hablar con el club: «quiero información» y «quiero saber el calendario
    // de torneos» no tienen ninguna palabra de escuela, y sin esto el bot callaba.
    /\bref web( agendar| inscripcion| torneos)?$/,
    /\binscrib\w*/,
    /\binscripcion(es)?\b/,
    /\bmatricul\w*/,
    /\bclases? (de |una )?(prueba|cortesia|gratis|gratuitas?)\b/,
    /\b(clase|dia) de cortesia\b/,
    // «a partir de qué edad», «desde qué edad», «qué edades reciben»
    /\b(a partir de|desde) (que|cual) edad\b/,
    /\b(que|cuales) edades\b/,
    /\brango de edad(es)?\b/,
    // «resiven menores en formación?», «aceptan adultos principiantes?»
    /\b(reciben|resiben|reciven|resiven|recibe|aceptan|admiten)\b(\s+\w+){0,4}\s+(ninos?|ninas?|menores|adultos?|principiantes|jovenes|chicos?|chicas?|mayores)\b/,
    // «entrenamiento para niñas de 8 años», «curso para adultos»
    /\b(entrenamientos?|entrenan|clases?|cursos?|grupos?|categorias?|escuela|voley|volley|voleibol|volleyball)\b(\s+\w+){0,3}\s+para\s+(ninos?|ninas?|menores|adultos?|principiantes|jovenes|mayores)\b/,
    /\betapa de iniciacion\b/,
    // «quiero empezar a entrenar», «me gustaría aprender a jugar voleibol»
    // «horarios… para poder pasar y mirar las instalaciones»
    /\b(mirar|conocer|visitar|ver) (las )?instalaciones\b/,
    // Dynasty 2026-10-06, 5 prospectos sin respuesta: «me gustaría conocer el
    // club», «¿la edad permitida?», «estoy averiguando un club de vóley»,
    // «¿puedo llevar a una niña con mi hija a una cortesía?».
    /\b(conocer|saber (mas )?(de|del|sobre)|informacion (de|del|sobre)) (el |la |los |las |su |sus )?(club|academia|escuela|programa|programas|equipo|equipos|grupos?|categorias?)\b/,
    /\bedad(es)? (permitidas?|minimas?|maximas?|requeridas?|para (entrar|entrenar|inscrib\w*|ingresar|jugar))\b/,
    /\b(hasta|desde) (que|cual) edad\b/,
    /\b(una|la|a la|a una) cortesia\b/,
    // Dynasty 2026-10-24 (informe de conversación v2): «mi hija se quiere meter en
    // la academia de voleibol» recibió «No reconozco este número entre las familias».
    /\b(quiere|quieren|quisiera|quisieran|queremos|quiero|desea|desean|deseo|gustaria)\s+(meter|meterse|meterla|meterlo|apuntar|apuntarse|apuntarla|apuntarlo|unir|unirse|unirla|unirlo|vincular|vincularse|vincularla|vincularlo|entrar|ingresar)\b(\s+\w+){0,4}\s+(academia|escuela|club|equipo|clases?|grupo|voley|volley|voleibol|volleyball|entrenamientos?)\b/,
    /\b(meter|meterla|meterlo|apuntar|apuntarla|apuntarlo|vincular|vincularla|vincularlo|unir|unirla|unirlo)\b(\s+\w+){0,3}\s+(a|en) (la |el )?(academia|escuela|club|equipo|clases?|grupo)\b/,
    // «Noo mi hija no es de la escuela»: aclara que NO es cliente; es prospecto (o ajeno), no familia.
    /\bno (es|esta|estudia|pertenece|hace parte)\b(\s+\w+){0,3}\s+(de |en |a )?(la |el )?(escuela|club|academia)\b/,
    // «papá de Sofía Gómez Uribe para información»
    /\b(papa|mama|madre|padre|abuel[oa]|tio|tia) de\b(\s+\w+){1,5}\s+(para )?(info|informacion|informes)\b/,
    // Verbos de querer/buscar + el acto de entrar o practicar (Monster 2026-11-12: ampliar sinónimos):
    // «necesito un lugar donde entrenar», «busco dónde jugar voleibol», «quiero formar parte del equipo»,
    // «me encantaría pertenecer al club», «quisiera participar en sus clases».
    // Sustantivos de ingreso: «¿hay cupo?», «cupos disponibles», «vacantes para niñas» (el cupo de un servicio lo
    // atiende la venta antes de llegar acá).
];

/**
 * Verbo/cupo + entrar o practicar: es ANCHO, por eso solo cuenta si NO_ES_ALUMNO no lo desmiente
 * (Monster 2026-11-12: la auditoría de 143 frases dejaba pasar otro club, alquiler de cancha, trabajo, torneos…).
 */
const PROSPECTO_VERBO: RegExp[] = [
    // Principiante: «nunca he jugado voleibol, me gustaría empezar».
    /\b(nunca|jamas) (he|hemos|ha|han) (jugado|entrenado|practicado)\b/,
    /\b(quiero|quisiera|queremos|deseo|deseamos|me gustaria|nos gustaria)\s+(empezar|iniciar|comenzar|entrar|ingresar|aprender|practicar)\b(\s+\w+){0,3}\s+(entrenar|jugar|voley|volley|voleibol|volleyball|club|academia|escuela|clases?)\b/,
    /\b(quiero|quisiera|queremos|deseo|me gustaria)\s+(entrenar|practicar (voley|volley|voleibol)\w*|jugar (voley|volley|voleibol)\w*)\b/,
    /\b(quiero|quisiera|queria|queremos|quisieramos|deseo|deseamos|necesito|necesitamos|busco|buscamos|buscando|me gustaria|nos gustaria|me encantaria|nos encantaria|ando buscando|estamos buscando)\b(\s+\w+){0,5}\s+(entrenar\w*|practicar|jugar|aprender|participar|formar parte|hacer parte|ser parte|pertenecer|unirme|unirnos|integrarme|integrarnos|matricular\w*)\b/,
    /\b(hay|tienen|tendran|quedan|manejan)\b(\s+\w+){0,2}\s+(cupos?|vacantes?|plazas?)\b/,
    /\b(cupos?|vacantes?|plazas?)\s+(disponibles?|libres?|abiertos?|para (ninos?|ninas?|adultos?|menores|jovenes|mi hij[oa]|nuevos?))\b/,
    // Tercera persona y «que mi hijo + subjuntivo»: «mi hijo quiere entrenar con ustedes», «quiero que mi hijo juegue».
    /\b(mi|mis|nuestr[oa]s?) (hij[oa]s?|nin[oa]s?|sobrin[oa]s?|niet[oa]s?)\b(\s+\w+){0,3}\s+(quiere|quieren|necesita|necesitan|desea|desean|se quiere|le gustaria|les gustaria)\s+(entrenar\w*|practicar|jugar|aprender|participar|unirse|ingresar|entrar|meterse)\b/,
    /\b(quiero|quisiera|queremos|quisieramos|necesito|necesitamos|me gustaria|nos gustaria|deseo)\s+que\s+(mi|nuestr[oa]) (hij[oa]|nin[oa]|sobrin[oa])\b(\s+\w+){0,2}\s+(juegue|entrene|practique|aprenda|participe|ingrese|entre|haga parte|hiciera parte|jugara|entrenara|practicara|aprendiera|pudiera)\b/,
    // «busco un club/academia/escuela para mi hija»
    /\b(busco|buscamos|buscando|necesito|necesitamos)\b(\s+\w+){0,3}\s+(club|academia|escuela|clases?|curso|grupo)\b(\s+\w+){0,6}\s+para (mi|mis|nuestr[oa]s?) (hij[oa]s?|nin[oa]s?|sobrin[oa]s?)\b/,
    /\b(equipo|club|academia|escuela|lugar|sitio|donde)\b(\s+\w+){0,3}\s+(mi|nuestr[oa]) (hij[oa]|nin[oa])\b(\s+\w+){0,2}\s+(pueda|puedan) (jugar|entrenar|practicar)\b/,
];

/** Quien dice esto NO quiere entrar como alumno: otro club, cancha, trabajo, torneo/evento, conocido, app. */
const NO_ES_ALUMNO = new RegExp([
    String.raw`\b(trabajo|empleo|hoja de vida|cuerpo tecnico|staff|ponente|voluntari\w*|practicante|cargo)\b`,
    String.raw`\b(como|de) (entrenador\w*|profe|profesor\w*|coach|arbitro)\b`,
    String.raw`\b(vacantes?|plazas?) (de|para) (el |la )?(entrenador\w*|profe\w*|coordinador\w*|trabajo|cargo)\b`,
    String.raw`\bequipo de (entrenadores|profes|profesores)\b|\bentrenar a (un|una|unos|unas|mi|mis|los|las)\b|\bnecesitan (un |una )?(profe|profesor|entrenador|coach)\b`,
    String.raw`\b(torneos?|campeonato|cuadrangular|triangular|clinica|rifa|festival|bus|viaje|parqueadero)\b`,
    String.raw`\b(cancha|canchas|coliseo|alquil\w*|prestan|prestas|prestar|pruebas|saque)\b`,
    String.raw`\b(mi|mis|nuestro|nuestros) (equipo|jugadores|amigos)\b|\b(con|de) (mis )?amigos\b|\bparche\b|\bcontigo\b|\ben privado\b|\bentrenador personal\b`,
    String.raw`\b(otro|otra) (club|equipo|escuela|academia)\b|\bcontra (ustedes|nosotros|su equipo|el equipo)\b|\b(rival|partido|amistoso)\b`,
    String.raw`\b(perro|ingles|parque|plataforma|aplicacion|app|grupo de (whatsapp|padres|papas)|montar una escuela)\b`,
    // juego puntual: «jugar con ustedes el domingo», «jugar hoy», «jugar el fin de semana»
    String.raw`\b(jugar|jugamos|juguemos)\b(\s+\w+){0,4}\s+(hoy|manana|(el |este )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)|(el |este )?fin de semana|esta (tarde|noche))\b`,
].join('|'));

/** Otro canal o proveedor: «este no es el canal para información…», «somos X, fabricamos/ofrecemos…». */
const AJENO = /\bno es el canal\b|\bcanal (no )?(oficial )?(para|de) informacion\b|\b(somos|soy de|hablas? con|le escribe de)\b[^.]{0,60}\b(fabricamos|fabricante|vendemos|ofrecemos|distribuimos|proveedor|agencia|empresa de)\b/;

/**
 * Negación o desistimiento (antónimos de «me interesa / quiero»): «no me interesa», «ya no quiero»,
 * «no estoy interesada», «no necesito». Gana sobre cualquier señal de interés: quien dice que no, no es prospecto.
 */
export const DESISTE =
    /\b(ya )?no (me |nos |les |le )?(interesa\w*|interesad\w*|quiero|queremos|quiere|quieren|quisiera|quisieramos|gustaria\w*|busco|buscamos|pienso|pensamos|deseo|deseamos|necesito|necesitamos|gracias)\b|\bno (estoy|estamos) (muy )?interesad\w*|\bya no (voy|vamos|va|estoy|estamos|quiero|queremos|quiere|quieren|busco|buscamos|me interesa\w*|necesito|necesitamos)\b|\b(desisto|desistimos|descarto|descartamos|dejo de|dejamos de|dejaron de)\b|\bnunca (quise|quiero|quisimos|quisiera|me intereso|me intereso\w*|vamos|voy)\b|\b(cancelar|retirar\w*|me retiro|nos retiramos|dar de baja|darla de baja|darlo de baja)\b/;

/** «Soy nuevo», «somos nuevos»: prospecto solo con contexto de escuela/deporte. */
const SOY_NUEVO = /\b(soy|somos) nuev[oa]s?\b/;

/** «averiguar / averiguando»: con contexto de escuela, o casi solo («quiero averiguar»). */
const AVERIGUAR = /\baverigu\w*/;

/**
 * Palabras que, junto al RELLENO, arman un pedido de información SIN tema
 * ajeno: «info», «más información», «me das info por favor», «información del
 * club». Si aparece cualquier otra palabra («info del restaurante») no cuenta.
 */
const PEDIDO_DE_INFO = /\b(info|informacion|informes)\b/;
const SOLO_PEDIDO_DE_INFO = new Set([
    'info', 'informacion', 'informes', 'quiero', 'quisiera', 'queria', 'mas', 'me', 'das', 'da', 'regalas', 'regala',
    'puedes', 'puede', 'podrias', 'podria', 'podrian', 'dar', 'enviar', 'envias', 'envia', 'pasar', 'pasas', 'pasa',
    'brindar', 'brindas', 'solicito', 'necesito', 'pido', 'sobre', 'del', 'el', 'la', 'los', 'las', 'su', 'club',
    'academia', 'escuela', 'porfa', 'porfavor', 'una', 'un', 'algo', 'deseo', 'desearia', 'gustaria', 'nos',
    'ustedes', 'saber', 'tener', 'recibir', 'para', 'con',
]);

/** «interesado/a» (y «esoty interesada») — se exige contexto o mensaje corto. */
// «interesado/a» y también el verbo: «me interesa entrenar con ustedes» (Monster 2026-11-11, @Andrey_0630: el bot calló 17 h).
const INTERES = /\binteresad[oa]s?\b|\b(me|nos) (interesan?|interesaria|interesarian?|atrae|atraen|motiva|motivan|animo|animamos|animaria|llama(n)? la atencion)\b|\bestoy (muy )?motivad[oa]\b/;
const INTERES_NEGADO = /\bno (estoy |estamos |me |nos )?(muy )?interes(ad|an?\b)/;

/** Palabras que, solas, hacen de un mensaje un saludo/cortesía sin contenido. */
const RELLENO = new Set([
    'hola', 'holi', 'ola', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tardes', 'noches', 'noche', 'tarde',
    'como', 'esta', 'estas', 'estss', 'estan', 'va', 'vas', 'que', 'tal', 'saludos', 'muy', 'feliz',
    'gracias', 'muchas', 'mil', 'ok', 'okay', 'oki', 'listo', 'vale', 'dale', 'bueno', 'perfecto',
    'si', 'no', 'claro', 'stop', 'pare', 'baja', 'senor', 'senora', 'sra', 'sr', 'disculpa', 'disculpe',
    'por', 'favor', 'te', 'le', 'lo', 'la', 'mismo', 'igual', 'bien', 'super', 'jaja', 'jajaja',
    // para contar palabras útiles de «Estoy interesado en iniciar»
    'estoy', 'esoty', 'estamos', 'soy', 'en', 'a', 'de', 'el', 'y', 'yo', 'muy', 'me',
]);

/**
 * ¿El mensaje de un desconocido muestra intención CLARA de entrar a la
 * escuela? Pura y determinista; ver los casos en whatsapp-prospecto.test.ts.
 */
export function intencionDeProspecto(texto: string | null | undefined): boolean {
    if (!texto) return false;
    const t = normalizarTexto(texto);
    if (!t) return false;
    // Un cobro que ya existe es de familia, no de prospecto.
    if (YA_LE_PAGA.some((re) => re.test(t))) return false;
    // «No me interesa», «ya no quiero»: dijo que no.
    if (DESISTE.test(t)) return false;
    // Autorrespuesta de otro canal («este no es el canal para información…») o proveedor que ofrece lo suyo.
    if (AJENO.test(t)) return false;

    if (PROSPECTO_FUERTE.some((re) => re.test(t))) return true;
    if (PROSPECTO_VERBO.some((re) => re.test(t)) && !NO_ES_ALUMNO.test(t)) return true;
    if (SOY_NUEVO.test(t) && CONTEXTO_PROSPECTO.test(t)) return true;

    if (INTERES.test(t) && !INTERES_NEGADO.test(t)) {
        // «esoty interesada», «Estoy interesado en iniciar»: corto o con contexto.
        const utiles = t.split(' ').filter((w) => !RELLENO.has(w));
        if (utiles.length <= 2 || CONTEXTO_PROSPECTO.test(t)) return true;
    }

    // «Info», «más información por favor», «información del club».
    // «Vale muchas gracias por la información» es un cierre, no un pedido.
    if (PEDIDO_DE_INFO.test(t) && !/\b(gracias|agradezco|agradecemos) por\b/.test(t) && t.split(' ').every((w) => RELLENO.has(w) || SOLO_PEDIDO_DE_INFO.has(w))) return true;

    // «Estoy averiguando un club de vóley», «quiero averiguar».
    //  Corto solo en primera persona: «averigua eso» es un encargo entre amigos.
    if (AVERIGUAR.test(t)) {
        if (CONTEXTO_PROSPECTO.test(t)) return true;
        const utiles = t.split(' ').filter((w) => !RELLENO.has(w));
        if (utiles.length <= 2 && /\b(quiero|quisiera|queremos|estoy|estamos|ando) averigu/.test(t)) return true;
    }

    // Precio/valor/costos de entrenar o del club (no de un cobro: YA_LE_PAGA arriba).
    if (CONCEPTOS_GENERICOS.precio.test(t) && CONTEXTO_PROSPECTO.test(t) && !NO_ES_ALUMNO.test(t)) return true;
    // «horarios … para pasar», «horarios para niñas»
    if (CONCEPTOS_GENERICOS.horario.test(t)
        && /\b(conocer|mirar|visitar|pasar|instalaciones|iniciar|empezar|inscrib\w*|edad(es)?|ninos?|ninas?|adultos?|principiantes)\b/.test(t)
        && !NO_ES_ALUMNO.test(t)) {
        return true;
    }

    // Lo que ya abría la puerta de siempre por inscripción («información de la academia»).
    return temaEscolar(texto) === 'inscripcion' && !NO_ES_ALUMNO.test(t);
}

/** ¿Dice que NO (o que ya no) quiere entrar? Para que el tema «inscripción» tampoco abra la puerta. */
export function desisteDeProspecto(texto: string | null | undefined): boolean {
    return !!texto && DESISTE.test(normalizarTexto(texto));
}

/** ¿El mensaje es solo saludo, agradecimiento o cortesía? («Hola buenas tardes», «Ok gracias»). */
export function soloSaludoOCortesia(texto: string | null | undefined): boolean {
    const crudo = (texto || '').trim();
    if (!crudo) return true;
    if (!/[\p{L}\p{N}]/u.test(crudo)) return true; // solo emojis o signos
    const t = normalizarTexto(crudo);
    if (!t) return true;
    return t.split(' ').every((w) => RELLENO.has(w));
}

export type PuertaDeProspecto = 'prospecto' | 'seguimiento';

/**
 * ¿Se le abre la puerta de prospecto a este mensaje?
 *
 * - `prospecto`: el mensaje mismo tiene intención clara.
 * - `seguimiento`: el mensaje no la tiene («Mi hija tiene 14 años», «Miércoles
 *   está bien»), pero un entrante ANTERIOR de la misma conversación en los
 *   últimos días sí (`entrantesPrevios`, solo textos). Un saludo o un
 *   agradecimiento sueltos no son seguimiento.
 * - null: silencio.
 */
export function puertaDeProspecto(
    texto: string | null | undefined,
    entrantesPrevios: (string | null | undefined)[] = [],
): PuertaDeProspecto | null {
    if (intencionDeProspecto(texto)) return 'prospecto';
    if (soloSaludoOCortesia(texto)) return null;
    if (entrantesPrevios.some((p) => intencionDeProspecto(p))) return 'seguimiento';
    return null;
}

/** Días hacia atrás que cuenta un entrante para marcar la conversación como de prospecto. */
export const DIAS_MARCA_PROSPECTO = 7;

export type InteresDeProspecto = 'visita' | 'cortesia' | 'precio' | 'horarios' | 'edades' | 'inscripcion' | 'informacion';

/**
 * Lo que pide el prospecto, para el lead y para elegir la respuesta. Puede
 * ser más de uno («precio, horarios y edad»).
 */
export function interesesDeProspecto(texto: string | null | undefined): InteresDeProspecto[] {
    const t = normalizarTexto(texto || '');
    if (!t) return [];
    const r: InteresDeProspecto[] = [];
    if (/\b(mirar|conocer|visitar|ver) (las )?instalaciones\b|\bpasar (a )?(mirar|conocer|ver)\b|\bvisita(r)?\b/.test(t)) r.push('visita');
    if (/\bcortesia\b|\bclases? (de )?(prueba|gratis)\b/.test(t)) r.push('cortesia');
    if (CONCEPTOS_GENERICOS.precio.test(t) || /\bmensualidad\b/.test(t)) r.push('precio');
    if (CONCEPTOS_GENERICOS.horario.test(t) || /\bdisponibilidad de dias\b|\bque dias\b/.test(t)) r.push('horarios');
    if (/\bedad(es)?\b|\b\d{1,2} anos\b/.test(t)) r.push('edades');
    if (/\binscrib\w*|\binscripcion(es)?\b|\bmatricul\w*/.test(t)) r.push('inscripcion');
    if (!r.length) r.push('informacion');
    return r;
}

/**
 * ¿Busca para un ADULTO (para sí mismo)? «curso para adultos», «quiero empezar
 * a entrenar… yo tengo algo de experiencia». Sirve para avisarle que la
 * escuela le confirma el grupo: los equipos no tienen edades cargadas y
 * deducir el grupo del nombre está prohibido (ver whatsapp-clase-cortesia).
 */
export function buscaParaAdulto(texto: string | null | undefined): boolean {
    if (!texto) return false;
    const t = normalizarTexto(texto);
    if (/\b(mi|mis|nuestr[oa]s?) (hij[oa]s?|nin[oa]s?|nen[ea]s?|sobrin[oa]s?|niet[oa]s?)\b/.test(t)) return false;
    const explicito = /\badultos?\b/.test(t);
    // «Para mi y tengo 15 años» es un MENOR que pide para sí mismo, no un adulto (Dynasty
    // 2026-11-08: el bot le contestó «como buscas clases para adultos»). Con una edad menor
    // de 18 dicha por la persona, ni «para mi» ni «quiero entrenar» la vuelven adulta: solo
    // la palabra «adultos» escrita lo hace.
    const edad = edadDeQuienEscribe(t);
    if (!explicito && edad !== null && edad < 18) return false;
    return explicito
        || /\b(para mi|conmigo|yo tengo|yo juego|yo jugaba|quiero (empezar a )?entrenar|quiero aprender)\b/.test(t);
}

/** Edad que dice el texto ya normalizado («15 anos», «tengo 15», «tiene 9»), o null. Pura. */
function edadDeQuienEscribe(t: string): number | null {
    const m = t.match(/\b(\d{1,2}) ?(?:anos|ano)\b/) ?? t.match(/\b(?:tengo|tiene|edad(?: de)?) (\d{1,2})\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 3 && n <= 90 ? n : null;
}

/**
 * ¿Pide que lo llamen o hablar con una persona? («regrésame la llamada», «me pueden llamar»,
 * «quiero hablar con la directora»). Pura. Dynasty 2026-11-04: a «te agradezco si me puedes
 * regresar la llamada» el bot contestó con la oferta de la clase de cortesía.
 */
export function pideLlamada(texto: string | null | undefined): boolean {
    const t = normalizarTexto(texto || '');
    if (!t) return false;
    return /\b(llamame|llamenme|llamarme|me llam(an|as|en|aran|arian)|me (pueden|puedes|podrian|podrias|podria|puede) llamar|(regresar|regresame|devolver|devuelveme|regresarme|devolverme) (me )?la llamada|una llamada|prefiero (una )?llamada|hablar por (telefono|llamada)|hablar contigo|comunicarme (con|a)|hablar con (alguien|una persona|la directora|el director|el profe|la escuela|un asesor|una asesora)|necesito hablar)\b/.test(t);
}

/**
 * ¿Pregunta dónde queda la escuela o cómo llegar? («¿dónde queda la cancha?», «¿cuál es la
 * dirección?»). Pura. Dynasty 2026-11-08: a «donde queda la cancha» el bot contestó con el
 * enlace de inscripción y la clase de cortesía, sin la dirección.
 */
export function pideUbicacion(texto: string | null | undefined): boolean {
    const t = normalizarTexto(texto || '');
    if (!t) return false;
    return /\b(donde (queda|quedan|entrenan|juegan|practican)|donde (es|son|esta|estan) (la |el |las |los )?(cancha|canchas|sede|sedes|escuela|club|coliseo|gimnasio|clase|clases|entrenamiento|entrenamientos|ubicad[oa]s?)|(cual es )?la (direccion|ubicacion)|(su|tu) (direccion|ubicacion)|como (llego|se llega|llegar)|ubicacion de la (cancha|sede|escuela|club))\b/.test(t);
}

/** Edad que dice el mensaje («mi hija tiene 14 años», «niñas de 8 años»), o null. */
export function edadMencionada(texto: string | null | undefined): number | null {
    const t = normalizarTexto(texto || '');
    const m = t.match(/\b(\d{1,2}) anos\b/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 3 && n <= 80 ? n : null;
}
