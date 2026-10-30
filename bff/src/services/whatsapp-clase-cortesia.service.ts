/**
 * whatsapp-clase-cortesia.service — clase de cortesía (de prueba) por WhatsApp:
 * informar, AGENDAR y RESERVAR un cupo real, y cancelarlo. DETERMINISTA: el
 * modelo solo decide que la pregunta es de esto (tool `get_trial_class_info`);
 * los datos, las franjas y la reserva no pasan por el LLM.
 *
 * QUÉ MECÁNICA USA Y POR QUÉ (medido el 2026-10-06):
 * En el código conviven tres cosas que se llaman parecido:
 *   (a) `school_trial_slots` + `school_signup_leads` — cupos puntuales que la
 *       escuela carga y que el prospecto reserva desde /inscripcion/<slug> con
 *       `submit_school_lead` (FOR UPDATE sobre el cupo, dedupe 24 h por
 *       teléfono). Dynasty tiene 2 franjas cargadas y 4 prospectos ahí.
 *   (b) la agenda del owner MOD-28 (`trial_class_*`, cancha × entrenador) —
 *       Dynasty no tiene `school_trial_class_settings`, ni categorías, ni
 *       disponibilidad de canchas/entrenadores: 0 filas para reservar.
 *   (c) `school_courtesy_settings` — la «cortesía» de instalaciones por OTP;
 *       Dynasty no tiene fila.
 * La única con franjas reales de Dynasty es (a), y es la que ya conocen sus
 * prospectos por el formulario. Se reutilizan SUS RPC: `list_open_trial_slots_public`
 * para listar y `submit_school_lead` para reservar (la misma llamada del
 * formulario, con el mismo candado de cupo). No hay una reserva nueva. Lo único
 * que no existía es liberar un cupo: `wa_cancelar_clase_de_prueba`
 * (migración 20261006082002, solo service_role). Mientras no esté aplicada,
 * «cancelar mi clase» se le pide a la escuela y no se toca el contador.
 *
 * ESTADO DEL PASO A PASO: `whatsapp_conversation_flows` (de factura
 * electrónica, mig. 20261005133534) NO está aplicada, y además su CHECK solo
 * admite el flujo de factura. Sin migración nueva se guarda el estado en lo que
 * ya existe: el `payload` del ÚLTIMO saliente del bot (o `tool_context` del
 * borrador en modo asistido). Cada pregunta del flujo viaja con
 * `{flujo, paso_cortesia, datos_cortesia}`; la respuesta del papá se lee contra
 * esa pregunta. Ventaja: si después escribe la escuela o el bot contesta otra
 * cosa, el último saliente ya no es del flujo y el flujo queda cerrado solo —
 * nunca se lee un «12» como edad cuando la última pregunta fue otra.
 *
 * Flujo (rehecho tras la auditoría Dynasty 2026-10-06: 16 prospectos, 0 reservas):
 *   [perfil] «¿Para quién es la clase y qué edad tiene?» — SOLO si no se sabe y
 *     los grupos traen con qué filtrar (rango de edad cargado, o el nombre dice
 *     FEMENINO/MASCULINO o SENIORS/ADULTOS). Nunca se deduce la edad del nombre.
 *   oferta: ≤3 franjas → botones; más → LISTA interactiva de hasta 10 filas
 *     agrupadas por día (9 + «Ver más» si hay más). Nunca franjas que ya
 *     empezaron ni que empiezan en menos de 2 h. «el sábado» filtra el día;
 *     «la 2» elige.
 *     → nombre del deportista → edad o fecha de nacimiento
 *     → nombre del acudiente (solo si es menor y no lo conocemos)
 *     → resumen «Confirmar / Cambiar» → submit_school_lead → resumen + aviso a la escuela
 *   sin franjas: «¿dejas tus datos?» → mismos pasos → prospecto SIN cupo (igual
 *     que el formulario sin elegir horario) → la escuela lo contacta.
 *   «cancelar mi clase» (solo si ESE número tiene una reserva futura)
 *     → «¿Cancelo…?» → wa_cancelar_clase_de_prueba → aviso a la escuela.
 *
 * NOMBRE Y VALOR POR ESCUELA (Monster, 2026-10-30): «clase de cortesía» y
 * «gratis» salen de textos-clase-prueba (`school_trial_class_settings.nombre_clase`
 * y `trial_price`). Con trial_price > 0 el flujo NUNCA dice «gratis» ni
 * «cortesía»; sin ajustes, los textos de siempre letra por letra.
 * Las franjas traen además la sede, los profes, el enlace de Maps y las
 * indicaciones de la cancha (facilities, migración M1), y no se ofrece una
 * sesión que el profe canceló o movió en «Mi semana» (semana-equipo).
 */

import { supabase } from '../config/supabase';
import type { BotonInteractivo } from './whatsapp.service';
import { esSinLimite, diasSemanaValidos } from './franjas-cortesia.service';
import { liberarLeadParaReserva } from './whatsapp-prospecto-lead.service';
import { celular10 } from './factura-pagador.service';
import {
    rangosDeEscuela, elegirGrupo, textoGrupoParaEdad, textoDesdeQueEdad, preguntaGrupoPorEdad,
    lugaresDeEscuela, direccionDeLugar,
    type RangoGrupo, type FuenteEdad, type Genero, type LugarDeEscuela,
} from './grupos-por-edad.service';
import { leadSinCupoParaReserva, telefonoAlterno, fusionarReservaEnLead } from './whatsapp-prospecto-lead.service';
import { indicacionesCortesiaDeEscuela } from './whatsapp-ajustes-escuela.service';
import {
    textosClaseDeEscuela, TEXTOS_POR_DEFECTO, presentacionDeClase, ofertaDeReserva, fraseDeValor, type TextosClase,
} from './textos-clase-prueba';
import { excepcionesDeEscuela, ajusteDeSesion, diaDeLaSemana, type ExcepcionSemana } from './semana-equipo.service';

export const FLUJO_CORTESIA = 'clase_cortesia';
/** Misma ventana de atención de Meta: pasada, el papá ya no recuerda la pregunta. */
export const VIGENCIA_FLUJO_CORTESIA_MS = 24 * 60 * 60 * 1000;
const MAX_INTENTOS = 3;
/** Hasta 3 franjas van como botones; más, como lista. */
const MAX_BOTONES = 3;
/** Filas de una lista de WhatsApp (límite de Meta). Con «Ver más» van 9 franjas. */
const MAX_FILAS = 10;
/** Cuántas franjas se consideran en total (paginando de a 9). */
const MAX_FRANJAS_OFRECIDAS = 45;
/**
 * Anticipación mínima: no se ofrece una franja que empieza en menos de 2 h.
 * Nadie llega a tiempo a una clase que empieza en 40 minutos, y la escuela no
 * alcanza a enterarse de que va alguien nuevo.
 */
export const ANTICIPACION_MINIMA_MIN = 120;
const TZ = 'America/Bogota';

export type PasoCortesia =
    | 'perfil' | 'elegir_franja' | 'dejar_datos' | 'nombre' | 'edad' | 'acudiente'
    | 'confirmar' | 'confirmar_cancelacion'
    /** Último saliente = recordatorio de la clase (recordatorio-cortesia.service): «CANCELAR» libera el cupo. */
    | 'recordatorio';

export interface FranjaCortesia {
    id: string;
    /** Lo que la escuela escribió como etiqueta: «Sub-15», «Clase abierta». */
    grupo: string;
    fecha: string;          // YYYY-MM-DD
    horaInicio: string;     // HH:MM[:SS]
    horaFin: string | null;
    sede: string | null;
    cupos: number;
    /** Dirección de la sede, si coincide con una sede (school_branches) que la tenga. */
    direccion?: string | null;
    teamId?: string | null;
    /**
     * Rango de edad del grupo (grupos-por-edad.service: teams.age_min/age_max →
     * categoría → edades reales de sus atletas activos → año en el nombre).
     * null = no se sabe.
     */
    edadMin?: number | null;
    edadMax?: number | null;
    /** De dónde salió el rango (para decir «la escuela te confirma»). */
    edadFuente?: FuenteEdad | null;
    /** Género del grupo cuando el nombre no lo dice (categoría o atletas, ≥ 95 %). */
    generoGrupo?: Genero | null;
    // ── Enriquecido para el embudo (2026-10-30). Ningún texto de este flujo los
    //    imprime, salvo Maps e indicaciones de la cancha en la confirmación. ──
    /** Sede del equipo (`school_branches.id`). */
    branchId?: string | null;
    /** Entrenadores del equipo (team_coaches ∪ teams.coach_id) y sus nombres. */
    coachIds?: string[];
    coaches?: string[];
    /** Años de nacimiento que recibe el grupo (categoría). */
    anioMin?: number | null;
    anioMax?: number | null;
    /** Enlace de Google Maps de la cancha (`facilities.maps_url`). */
    mapsUrl?: string | null;
    /** Por dónde se entra, qué pasa si llueve (`facilities.indicaciones`). */
    indicacionesLugar?: string | null;
}

/** Para quién es la clase, según lo que escribió la familia. Nada se adivina. */
export interface PerfilAtleta {
    edad?: number | null;
    genero?: 'f' | 'm' | null;
    /** Es para un adulto («soy adulto», «para mí», edad ≥ 18). */
    adulto?: boolean;
    /** Es para un menor («mi hija», «mi hijo») aunque no dijo la edad. */
    menor?: boolean;
    /** Pidió ver todos los grupos sin filtro. */
    todos?: boolean;
}

export interface DatosCortesia {
    /** Franja elegida; ausente en el camino «dejar datos». */
    franja?: FranjaCortesia | null;
    /** true = no hay franjas: se dejan los datos para que la escuela llame. */
    sinFranja?: boolean;
    /** Ids de las franjas en el orden en que se numeraron («1», «2»…). */
    lista?: string[];
    desde?: number;
    nombre?: string;
    edad?: number;
    fechaNacimiento?: string | null;
    acudiente?: string | null;
    intentos?: number;
    /** Filtro de grupos (edad/género/adulto). */
    perfil?: PerfilAtleta | null;
    /** Día de la semana pedido («el sábado»): 0 = domingo … 6 = sábado. */
    dia?: number | null;
}

export interface EstadoCortesia {
    paso: PasoCortesia;
    datos: DatosCortesia;
}

export interface ReservaVigente {
    leadId: string;
    nombre: string;
    franja: FranjaCortesia;
}

export type ResultadoReserva =
    | { ok: true; leadId: string | null; duplicado: boolean; conCupo: boolean }
    | { ok: false; motivo: 'lleno' | 'no_disponible' | 'error' };

export type ResultadoCancelacion =
    | { ok: true; franja: FranjaCortesia | null }
    | { ok: false; motivo: 'sin_reserva' | 'sin_rpc' | 'error' };

export type TipoAvisoCortesia =
    | 'reservada' | 'datos' | 'cancelada' | 'cancelacion_pedida' | 'no_reservada'
    /** El prospecto escribió «llegué / llegamos» el día de su clase. */
    | 'llegada';

export interface AvisoCortesia {
    tipo: TipoAvisoCortesia;
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    leadId?: string | null;
    nombre?: string | null;
    edad?: number | null;
    acudiente?: string | null;
    franja?: FranjaCortesia | null;
}

export interface ParamsReserva {
    schoolId: string;
    conversationId: string;
    contactWaId: string;
    franjaId: string | null;
    nombre: string;
    edad: number;
    fechaNacimiento: string | null;
    acudiente: string | null;
}

export interface CtxCortesia {
    conversationId: string;
    schoolId: string;
    contactWaId: string;
    /**
     * Envía un mensaje del flujo. `estado` null = mensaje terminal (cierra el
     * flujo). `step` es el que queda en el payload (cuenta para frenos).
     */
    enviar: (texto: string, step: string, estado: EstadoCortesia | null,
        botones?: BotonInteractivo[], enTexto?: string) => Promise<void>;
    /** Nombre del acudiente ya identificado (familia con cuenta); null si no se sabe. */
    nombreAcudiente?: () => Promise<string | null>;
    /**
     * Todo lo que escribió desde la última respuesta (la ráfaga), si quien
     * llama agrupó varios mensajes en un turno. En la pregunta de perfil se lee
     * también esto: Dynasty 2026-10-07 (`…edc0e7`), «Tengo 23 años y soy mujer»
     * + «Qué horarios tiene. ?» corrieron como UN turno con el texto del último
     * y el perfil se perdió.
     */
    rafaga?: string | null;
    // Inyectables (pruebas). Por defecto, los de Supabase de abajo.
    leerEstado?: (conversationId: string) => Promise<EstadoCortesia | null>;
    franjas?: (schoolId: string) => Promise<FranjaCortesia[]>;
    reservaVigente?: (schoolId: string, contactWaId: string) => Promise<ReservaVigente | null>;
    reservar?: (p: ParamsReserva) => Promise<ResultadoReserva>;
    cancelar?: (schoolId: string, contactWaId: string) => Promise<ResultadoCancelacion>;
    avisarEscuela?: (aviso: AvisoCortesia) => Promise<void>;
    ahora?: () => Date;
    /**
     * Lo que dijo del deportista en los últimos 7 días (edad, género): no se le
     * vuelve a preguntar. El bot lo arma con sus mensajes entrantes.
     */
    perfilPrevio?: () => Promise<PerfilAtleta | null>;
    /** ¿Ya se le mandó la lista de horarios en las últimas 24 h? No se repite. */
    listadoReciente?: () => Promise<boolean>;
    /** Rangos de edad de los grupos (por defecto, grupos-por-edad.service). */
    rangos?: (schoolId: string) => Promise<RangoGrupo[]>;
    /** Qué llevar / a quién buscar, de la escuela (por defecto, school_settings). */
    indicaciones?: (schoolId: string) => Promise<string | null>;
    /**
     * Nombre de la clase y si se cobra (por defecto, `textosClaseDeEscuela`:
     * school_trial_class_settings, cacheado 10 min). Sin ajustes, «clase de
     * cortesía» gratis, como siempre.
     */
    textos?: (schoolId: string) => Promise<TextosClase>;
}

/** Los textos de la clase de esta escuela. Nunca lanza: ante cualquier falla, los de siempre. */
async function textosDe(ctx: CtxCortesia): Promise<TextosClase> {
    try {
        return (await (ctx.textos ?? textosClaseDeEscuela)(ctx.schoolId)) ?? TEXTOS_POR_DEFECTO;
    } catch {
        return TEXTOS_POR_DEFECTO;
    }
}

// ─── Botones (ids = contrato con el webhook; títulos ≤ 20) ─────────────────

export const BOTON_CC = {
    FRANJA: 'sm_cc_f:',            // + id de la franja
    VER_MAS: 'sm_cc_mas',
    DATOS_SI: 'sm_cc_datos_si',
    DATOS_NO: 'sm_cc_datos_no',
    CONFIRMAR: 'sm_cc_confirmar',
    CAMBIAR: 'sm_cc_cambiar',
    CANCELAR: 'sm_cc_cancelar',
    CANCELAR_SI: 'sm_cc_cancelar_si',
    CANCELAR_NO: 'sm_cc_cancelar_no',
} as const;

const BOTONES_DATOS: BotonInteractivo[] = [
    { id: BOTON_CC.DATOS_SI, title: 'Sí, dejar mis datos' },
    { id: BOTON_CC.DATOS_NO, title: 'No, gracias' },
];
const BOTONES_CONFIRMAR: BotonInteractivo[] = [
    { id: BOTON_CC.CONFIRMAR, title: 'Confirmar' },
    { id: BOTON_CC.CAMBIAR, title: 'Cambiar' },
];
const BOTONES_CANCELAR: BotonInteractivo[] = [
    { id: BOTON_CC.CANCELAR_SI, title: 'Sí, cancelar' },
    { id: BOTON_CC.CANCELAR_NO, title: 'No, la mantengo' },
];
export const BOTON_CANCELAR_MI_CLASE: BotonInteractivo[] = [
    { id: BOTON_CC.CANCELAR, title: 'Cancelar mi clase' },
];

export function esBotonCortesia(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_cc_');
}

// ─── Texto (puro) ──────────────────────────────────────────────────────────

/** Minúsculas, sin tildes; conserva / y - para leer fechas. */
export function normalizar(t: string | null | undefined): string {
    return String(t ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9/ -]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * ¿Pregunta por la clase de cortesía / prueba? Reglas, no modelo: corre sobre
 * cada mensaje de familias Y de desconocidos, y tiene que poder explicarse por
 * qué disparó. «Clase de cortesía tienen» (Dynasty, 2026-10-06) es el caso que
 * el bot contestó con «no tengo esa información».
 */
const PIDE_CORTESIA: RegExp[] = [
    /\bclases? (de )?(prueba|pruebas|cortesias?|gratis|gratuitas?|muestra|ensayo)\b/,
    /\b(probar|conocer) (una |la )?clase\b/,
    /\b(ir|venir|pasar) a probar\b/,
    /\bpuedo (ir a )?probar\b/,
    /\b(agendar|reservar|separar) (una )?clase\b/,
    /\bcortesias?\b/,
];
export function pideClaseDeCortesia(texto: string | null | undefined): boolean {
    const n = normalizar(texto);
    return !!n && PIDE_CORTESIA.some((re) => re.test(n));
}

/**
 * «Cancelar mi clase», «ya no puedo ir a la clase de prueba». OJO: para una
 * familia inscrita «cancelar la clase» también es avisar que no va a entrenar;
 * por eso quien llama SOLO lo toma como cancelación si ese número tiene una
 * reserva de cortesía futura.
 */
export function quiereCancelarClase(texto: string | null | undefined): boolean {
    const n = normalizar(texto);
    return /\b(cancelar|cancela|cancelo|cancelen|anular|anula)\b.*\b(clase|reserva|cortesia|prueba|cupo)\b/.test(n)
        || /\bya no (puedo|podemos|voy|vamos) (a ir )?(a )?(la )?(clase|prueba)\b/.test(n);
}

/**
 * Respuesta al RECORDATORIO de la clase («Si no puedes ir, responde CANCELAR»):
 * «cancelar», «CANCELAR.», «cancelo», «no puedo ir», o lo que ya valía
 * («cancelar mi clase»). Solo se lee contra el recordatorio: ahí la palabra
 * sola es inequívoca, porque es lo que se le pidió escribir.
 */
export function cancelaTrasRecordatorio(texto: string | null | undefined): boolean {
    const n = normalizar(texto);
    if (!n) return false;
    return /^(cancelar|cancela|cancelo|cancelamos|cancelen|cancelada|cancelado|anular|anulo)\b/.test(n)
        || quiereCancelarClase(texto)
        || /\bno (puedo|podemos|voy a poder|vamos a poder|podre|podremos) (ir|asistir)\b/.test(n);
}

/**
 * ¿Quiere salirse del agendamiento? Antes solo valía el mensaje EXACTO
 * («cancelar»); en la prueba en vivo del 2026-10-06 escribieron «Cancelar
 * prueba» y el bot respondió «Toca la franja que prefieras». Ahora basta con
 * que EMPIECE por una de estas frases.
 */
function abandona(texto: string): boolean {
    return /^(cancelar|cancela|cancelo|salir|ya no|no gracias|dejalo|olvidalo|no quiero|no me interesa|mejor no|despues|luego|voy a (consultar|pensar|mirar|revisar|averiguar|preguntar|confirmar)|lo (pienso|consulto|reviso)|(ya )?te (confirmo|aviso|cuento))\b/
        .test(normalizar(texto));
}

/** Un mensaje largo o con pregunta no es una respuesta: es otra conversación. */
function pareceOtraConversacion(texto: string): boolean {
    const t = (texto || '').trim();
    return t.includes('?') || t.split(/\s+/).filter(Boolean).length > 7;
}

/**
 * ¿Quiere hablar con una persona, o salirse del agendamiento hacia otra cosa?
 * Vale en CUALQUIER paso. Caso real (Dynasty, 2026-10-06): a «Necesito hablar
 * con un asesor» el flujo respondió «Toca la franja que prefieras». Quien
 * llama devuelve false y el turno lo atiende el bot general (que escala).
 * «Milena» es quien atiende el WhatsApp de Dynasty: la gente la nombra.
 */
const SALIR_DEL_FLUJO: RegExp[] = [
    /\b(asesor|asesora|asesores|asesoria|agente|operador|operadora|humano|humana)\b/,
    /\bhablar con\b/,
    /\b(comunicarme|contactarme|atiende|atienda|atiendan)\b/,
    /\b(una persona|alguien|persona real)\b/,
    /^(persona|personas|con persona|humano)$/,
    /\b(llamen|llamenme|me llaman|me pueden llamar|me puede llamar|llamada|llamar)\b/,
    /\bmilena\b/,
    /\b(administrador|administradora|coordinador|coordinadora|encargado|encargada|la duena|el dueno)\b/,
];
export function quiereSalirDelFlujo(texto: string | null | undefined): boolean {
    const n = normalizar(texto);
    return !!n && SALIR_DEL_FLUJO.some((re) => re.test(n));
}

/**
 * Pregunta de otro tema escrita sin «?» («cuanto vale la mensualidad»,
 * «donde queda»): no es elegir franja. Solo se usa en `elegir_franja`.
 */
function esPreguntaDeOtroTema(texto: string): boolean {
    // «Y cuáles son los valores», «En dónde se encuentran», «pero cuánto vale»
    // (auditoría 2026-10-28, X-03): el conector de adelante no cambia la pregunta.
    const n = normalizar(texto)
        .replace(/^(y|e|en|pero|ok|okay|hola|buenas|buenos dias|buenas tardes|disculpa|perdon)\b[\s,]*/, '');
    return /^(cuanto|cuanta|cuantos|cuantas|donde|como|quien|cuando|por que|porque|cual|cuales|precio|precios|valor|valores|costo|costos|cuesta|mensualidad|tienen|hay|me pueden|me puede|necesito|quiero saber|informacion|info|direccion|ubicacion|requisitos|uniforme|parqueadero)\b/
        .test(n)
        || /\b(valores|precios|cuanto (vale|cuesta)|direccion|donde (queda|quedan|estan|se encuentran)|requisitos|parqueadero)\b/.test(n);
}

/** «¿Qué horarios tiene?», «a qué hora entrenan», «qué días son». */
export function preguntaPorHorarios(texto: string | null | undefined): boolean {
    return /\b(horarios?|a que hora|que dias|cuando (entrenan|son|es|practican)|dias de entrenamiento)\b/
        .test(normalizar(texto));
}

const DIAS_SEMANA: Record<string, number> = {
    domingo: 0, domingos: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5,
    sabado: 6, sabados: 6,
};

/** «el sábado», «los martes», «mejor el miércoles» → día (0–6). null si no nombra uno. */
export function leerDia(texto: string | null | undefined): number | null {
    const m = normalizar(texto).match(/\b(domingos?|lunes|martes|miercoles|jueves|viernes|sabados?)\b/);
    return m ? DIAS_SEMANA[m[1]] : null;
}

const ORDINALES: Record<string, number> = {
    primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, cuarto: 4,
    quinta: 5, quinto: 5, sexta: 6, sexto: 6, septima: 7, septimo: 7, octava: 8, octavo: 8,
    novena: 9, noveno: 9, decima: 10, decimo: 10,
};

/** «2», «la 2», «opción 2», «#2», «2.», «la segunda» → 2. null si no es eso. */
export function leerNumeroOpcion(texto: string | null | undefined): number | null {
    const n = normalizar(String(texto ?? '').trim().replace(/^#/, '').replace(/\.$/, ''));
    const m = n.match(/^(?:(?:la|el) )?(?:(?:opcion|numero|franja) )?(\d{1,2})$/);
    if (m) return Number(m[1]);
    const o = n.match(/^(?:(?:la|el) )?(?:opcion )?([a-z]+)(?: opcion)?$/);
    return o && ORDINALES[o[1]] ? ORDINALES[o[1]] : null;
}

const GENERO_F = /\b(hija|hijas|nina|nena|hijita|chica|muchacha|sobrina|nieta|mujer|femenino|femenina|senora)\b/;
const GENERO_M = /\b(hijo|nino|nene|hijito|chico|muchacho|sobrino|nieto|hombre|masculino|varon|senor)\b/;
const ES_MENOR = /\b(hija|hijas|hijo|hijos|nina|nino|nena|nene|ninos|ninas|hijita|hijito|sobrina|sobrino|nieta|nieto|menor|menores|chiquito|chiquita|pequeno|pequena)\b/;
const ES_ADULTO = /\b(adulto|adulta|adultos|adultas|mayor de edad|yo mismo|yo misma|soy yo)\b|\bpara mi( mismo| misma)?$|\bsoy (mujer|hombre|senora|senor)\b/;

/**
 * Para quién es la clase: «para mi hija de 8 años», «soy adulto», «mi hijo
 * tiene 12». Solo lo que la persona DIJO; null si no dijo nada de eso.
 * `soloNumero`: en la pregunta de perfil, un «8» suelto es la edad.
 */
export function leerPerfil(texto: string | null | undefined, opciones: { soloNumero?: boolean } = {}): PerfilAtleta | null {
    const n = normalizar(texto);
    if (!n) return null;
    if (/^(todos|todas|ver todos|ver todas|cualquiera|cualquier grupo|no se|da igual|todos los grupos|ver todos los grupos)$/.test(n)) {
        return { todos: true };
    }
    const p: PerfilAtleta = {};
    const edadM = n.match(/\b(\d{1,2}) ?(anos|ano|anitos|anito)\b/)
        ?? n.match(/\b(?:tiene|tengo|edad) (\d{1,2})\b/)
        ?? n.match(/\b(?:hija|hijo|nina|nino|nena|nene|hijita|hijito|sobrina|sobrino|nieta|nieto|chico|chica) de (\d{1,2})\b/)
        ?? (opciones.soloNumero ? n.match(/^(\d{1,2})$/) : null);
    if (edadM) {
        const e = Number(edadM[1]);
        if (e >= 3 && e <= 90) p.edad = e;
    } else if (opciones.soloNumero && n.split(' ').length <= 8) {
        // Respuesta a «¿qué edad tiene?» con DOS personas: «Yo 16 y ella 12»
        // (Dynasty 2026-10-07): se muestran todos los grupos en vez de volver
        // a preguntar lo que ya dijo.
        const edades = [...n.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1])).filter((e) => e >= 3 && e <= 90);
        if (edades.length > 1) return { todos: true };
    }
    if (GENERO_F.test(n)) p.genero = 'f';
    else if (GENERO_M.test(n)) p.genero = 'm';
    if (ES_ADULTO.test(n) || (typeof p.edad === 'number' && p.edad >= 18)) p.adulto = true;
    else if (ES_MENOR.test(n) || (typeof p.edad === 'number' && p.edad < 18)) p.menor = true;
    return (p.edad != null || p.genero || p.adulto || p.menor) ? p : null;
}

/**
 * Perfil de VARIOS mensajes (uno por línea, del más viejo al más nuevo): gana
 * lo más reciente. «para mi hija de 12 años» … «mi hija tiene 14» → 14.
 * `leerPerfil` sobre el texto pegado tomaba la PRIMERA edad (la vieja).
 */
export function perfilReciente(texto: string | null | undefined): PerfilAtleta | null {
    const lineas = String(texto ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    let r: PerfilAtleta | null = null;
    for (const l of lineas) r = combinarPerfiles(leerPerfil(l), r);
    return r;
}

/** `nuevo` manda; lo que no dice se toma de `previo`. */
export function combinarPerfiles(
    nuevo: PerfilAtleta | null | undefined, previo: PerfilAtleta | null | undefined,
): PerfilAtleta | null {
    if (!nuevo) return previo ?? null;
    if (!previo || nuevo.todos) return nuevo;
    const edad = nuevo.edad ?? previo.edad ?? null;
    const r: PerfilAtleta = {};
    if (edad != null) r.edad = edad;
    const genero = nuevo.genero ?? previo.genero ?? null;
    if (genero) r.genero = genero;
    if (edad != null) {
        if (edad >= 18) r.adulto = true; else r.menor = true;
    } else if (nuevo.adulto || nuevo.menor) {
        if (nuevo.adulto) r.adulto = true; else r.menor = true;
    } else if (previo.adulto) r.adulto = true;
    else if (previo.menor) r.menor = true;
    return r;
}

const baseGrupo = (g: string) => g.split('·')[0].trim();

/** Género que el NOMBRE del grupo declara («MENORES FEMENINO»). null = mixto o no lo dice. */
export function generoDeGrupo(grupo: string): 'f' | 'm' | null {
    const n = normalizar(baseGrupo(grupo));
    if (/\b(femenino|femenina|femeninas|damas|mujeres)\b/.test(n)) return 'f';
    if (/\b(masculino|masculina|masculinos|varones|hombres|caballeros)\b/.test(n)) return 'm';
    return null;
}

/** ¿El nombre del grupo dice que es de adultos? («SENIORS», «Adultos», «Máster»). */
export function esGrupoDeAdultos(grupo: string): boolean {
    return /\b(senior|seniors|adulto|adultos|adultas|master|masters|veteranos|veteranas)\b/
        .test(normalizar(baseGrupo(grupo)));
}

const tieneRango = (f: FranjaCortesia) => f.edadMin != null || f.edadMax != null;
/** Género del grupo: el nombre manda; si no lo dice, el inferido (categoría o atletas). */
const generoDeFranja = (f: FranjaCortesia): 'f' | 'm' | null => generoDeGrupo(f.grupo)
    ?? (f.generoGrupo === 'f' || f.generoGrupo === 'm' ? f.generoGrupo : null);

/** ¿Hay con qué filtrar? (rango de edad cargado, o género/adultos en el nombre) */
export function gruposFiltrables(franjas: FranjaCortesia[]): boolean {
    return franjas.some((f) => tieneRango(f) || generoDeGrupo(f.grupo) !== null || esGrupoDeAdultos(f.grupo));
}

export interface FiltroPerfil {
    franjas: FranjaCortesia[];
    /** Frase para el papá: qué NO se pudo filtrar. Vacía si nada que decir. */
    nota: string;
    /**
     * Ningún grupo recibe a un menor de esa edad (o de ese género). Antes se
     * mostraban TODOS los horarios, los de adultos incluidos: a una niña de 4
     * años le salieron los de Seniors (Dynasty 2026-10-28). Ahora no se ofrece
     * nada y lo confirma la escuela.
     */
    sinGrupoParaEdad?: number;
}

/**
 * Filtra las franjas por lo que se sabe del deportista, SIN inventar:
 *   · edad + rango cargado en el equipo → dentro del rango;
 *   · género → fuera los grupos cuyo NOMBRE dice el otro género;
 *   · menor → fuera los grupos de adultos; adulto → solo los de adultos (o los
 *     de rango que lo incluyan), si existen;
 *   · sin rangos cargados → se dice que la escuela confirma el grupo por edad.
 * Si el filtro deja todo vacío, se muestran todas y se dice.
 * Medido 2026-10-06: ningún equipo de Dynasty tiene age_min/age_max; el nombre
 * sí dice FEMENINO/MASCULINO y hay un grupo SENIORS.
 */
export function filtrarPorPerfil(franjas: FranjaCortesia[], perfil: PerfilAtleta | null | undefined): FiltroPerfil {
    if (!perfil || perfil.todos || !franjas.length) return { franjas, nota: '' };
    const edad = typeof perfil.edad === 'number' ? perfil.edad : null;
    const adulto = !!perfil.adulto || (edad != null && edad >= 18);
    const menor = !adulto && (!!perfil.menor || (edad != null && edad < 18));
    const enRango = (f: FranjaCortesia) => edad != null && tieneRango(f)
        && (f.edadMin == null || edad >= f.edadMin) && (f.edadMax == null || edad <= f.edadMax);

    let r = franjas;
    if (perfil.genero) r = r.filter((f) => { const g = generoDeFranja(f); return !g || g === perfil.genero; });
    if (edad != null) r = r.filter((f) => !tieneRango(f) || enRango(f));
    if (menor) r = r.filter((f) => !esGrupoDeAdultos(f.grupo));
    let sinGrupoAdultos = false;
    if (adulto) {
        const deAdultos = r.filter((f) => esGrupoDeAdultos(f.grupo) || enRango(f));
        if (deAdultos.length) r = deAdultos;
        else sinGrupoAdultos = true;
    }
    if (!r.length) {
        if (menor && edad != null) return { franjas: [], nota: '', sinGrupoParaEdad: edad };
        return { franjas, nota: 'No encontré un grupo que coincida con lo que me contaste, así que te muestro *todos*; la escuela te confirma cuál le corresponde.' };
    }
    let nota = '';
    if (sinGrupoAdultos) {
        nota = 'La escuela no tiene marcado un grupo de adultos, así que te muestro los grupos con horario y ella te confirma cuál te sirve.';
    } else if (edad != null && !adulto && !r.some(tieneRango)) {
        nota = `Los grupos no tienen edades cargadas: la escuela te confirma en la clase cuál le corresponde a ${edad} años.`;
    } else if (!adulto && edad == null && menor) {
        nota = 'Si me dices la edad, la escuela te confirma el grupo exacto.';
    }
    return { franjas: r, nota };
}

/** Criterio que se le muestra al papá: «para 8 años (femenino o mixto)». */
function describirPerfil(p: PerfilAtleta | null | undefined): string {
    if (!p || p.todos) return '';
    const partes: string[] = [];
    if (p.adulto) partes.push('para adultos');
    else if (typeof p.edad === 'number') partes.push(`para ${p.edad} años`);
    else if (p.menor) partes.push('para menores');
    if (p.genero === 'f') partes.push('(femenino o mixto)');
    if (p.genero === 'm') partes.push('(masculino o mixto)');
    return partes.join(' ');
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

function partesFecha(fecha: string): { y: number; m: number; d: number; dow: number } {
    const [y, m, d] = fecha.slice(0, 10).split('-').map(Number);
    // Mediodía UTC: el día de la semana no se corre por zona horaria.
    const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
    return { y, m, d, dow };
}

export function fechaLegible(fecha: string): string {
    const { m, d, dow } = partesFecha(fecha);
    return `${DIAS[dow]} ${d} de ${MESES[m - 1]}`;
}

export function horaLegible(hora: string): string {
    const [hh, mm] = hora.split(':').map(Number);
    const sufijo = hh >= 12 ? 'p. m.' : 'a. m.';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm || 0).padStart(2, '0')} ${sufijo}`;
}

function minutos(hora: string): number {
    const [hh, mm] = hora.split(':').map(Number);
    return hh * 60 + (mm || 0);
}

export function duracionLegible(inicio: string, fin: string | null): string | null {
    if (!fin) return null;
    const total = minutos(fin) - minutos(inicio);
    if (total <= 0) return null;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** Título de botón ≤ 20: «1. Sáb 10/10 5:00pm». El número evita títulos repetidos. */
export function tituloBoton(f: FranjaCortesia, n: number): string {
    const { m, d, dow } = partesFecha(f.fecha);
    const [hh, mm] = f.horaInicio.split(':').map(Number);
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const t = `${n}. ${DIAS_CORTOS[dow]} ${d}/${m} ${h12}:${String(mm || 0).padStart(2, '0')}${hh >= 12 ? 'pm' : 'am'}`;
    return Array.from(t).slice(0, 20).join('');
}

/**
 * Las franjas generadas desde los entrenamientos no tienen límite real
 * (max_capacity = CUPOS_SIN_LIMITE = 999): decir «998 cupos» suena a error y
 * además invita a preguntar «¿998?». Ahí va «cupos disponibles», sin número.
 * Las franjas cargadas a mano (5, 10…) siguen mostrando la cifra.
 */
export function textoCupos(cupos: number): string {
    if (esSinLimite(cupos)) return 'cupos disponibles';
    return cupos === 1 ? '1 cupo' : `${cupos} cupos`;
}

/**
 * Reordena para que la primera página muestre grupos DISTINTOS: la próxima
 * franja de cada grupo (en orden cronológico de su primera franja), después la
 * segunda de cada uno, etc.
 *
 * Por qué: con franjas generadas de los entrenamientos Dynasty tiene ~40 por
 * semana y `list_open_trial_slots_public` devuelve las 20 más cercanas; en
 * orden puro de fecha, las dos primeras con botón serían de los dos grupos que
 * entrenan hoy a las 4 p. m. y el papá de un niño de otra categoría tendría
 * que tocar «Ver más» varias veces. Lo ideal sería ofrecer primero el grupo de
 * la EDAD del deportista, pero (a) el flujo pregunta la edad DESPUÉS de elegir
 * la franja y (b) ningún equipo tiene edades cargadas (age_min/birth_year_min
 * NULL en todas las escuelas, medido 2026-09-22) y deducirla del nombre
 * («U15») está prohibido en whatsapp-info-escuela.service.ts. Intercalar por
 * grupo es lo que se puede hacer sin inventar.
 */
/**
 * ¿El mensaje nombra un grupo? («clase de cortesía para menores masculinos»,
 * prueba en vivo 2026-10-06). Compara contra los nombres REALES de los grupos
 * que tienen franjas (la parte antes de «·»), tolerando plural y tildes. Nunca
 * deduce el grupo por la edad. Devuelve el nombre base o null.
 */
export function grupoMencionado(texto: string | null | undefined, franjas: FranjaCortesia[]): string | null {
    const n = ` ${normalizar(texto)} `;
    if (!n.trim()) return null;
    const base = (g: string) => g.split('·')[0].trim();
    let mejor: { nombre: string; palabras: number } | null = null;
    for (const nombre of new Set(franjas.map((f) => base(f.grupo)))) {
        const palabras = normalizar(nombre).split(' ').filter((w) => w.length >= 4);
        if (!palabras.length) continue;
        const todas = palabras.every((w) => {
            const raiz = w.replace(/(es|s)$/, '');
            return new RegExp(`(^|\\s)${raiz}(s|es)?(\\s|$)`).test(n);
        });
        if (todas && (!mejor || palabras.length > mejor.palabras)) mejor = { nombre, palabras: palabras.length };
    }
    return mejor?.nombre ?? null;
}

export function intercalarPorGrupo(franjas: FranjaCortesia[]): FranjaCortesia[] {
    const colas = new Map<string, FranjaCortesia[]>();
    for (const f of franjas) {
        if (!colas.has(f.grupo)) colas.set(f.grupo, []);
        colas.get(f.grupo)!.push(f);
    }
    const salida: FranjaCortesia[] = [];
    for (let ronda = 0; salida.length < franjas.length; ronda++) {
        for (const cola of colas.values()) if (cola[ronda]) salida.push(cola[ronda]);
    }
    return salida;
}

function lineaFranja(f: FranjaCortesia, n: number): string {
    const fin = f.horaFin ? ` a ${horaLegible(f.horaFin)}` : '';
    const dur = duracionLegible(f.horaInicio, f.horaFin);
    const sede = f.sede ? ` · 📍 ${f.sede}` : '';
    const cupos = textoCupos(f.cupos);
    return `${n}. *${f.grupo}* — ${fechaLegible(f.fecha)}, ${horaLegible(f.horaInicio)}${fin}` +
        `${dur ? ` (${dur})` : ''}${sede} · ${cupos}`;
}

/** Línea de una franja dentro de su día (lista agrupada): sin repetir la fecha. */
function lineaFranjaEnDia(f: FranjaCortesia, n: number): string {
    const fin = f.horaFin ? ` a ${horaLegible(f.horaFin)}` : '';
    const sede = f.sede ? ` · 📍 ${f.sede}` : '';
    const cupos = esSinLimite(f.cupos) ? '' : ` · ${textoCupos(f.cupos)}`;
    return `${n}. ${horaLegible(f.horaInicio)}${fin} — *${f.grupo}*${sede}${cupos}`;
}

/** «Sáb 10 oct»: título de sección de la lista (≤ 24). */
function tituloDia(fecha: string): string {
    const { m, d, dow } = partesFecha(fecha);
    return `${DIAS[dow][0].toUpperCase()}${DIAS[dow].slice(1)} ${d} ${MESES[m - 1].slice(0, 3)}`;
}

/** Sede con dirección si la conocemos: «Coliseo Dynasty DC (Cl. 12 Bis #71g-09)». */
export function sedeConDireccion(f: FranjaCortesia): string | null {
    if (!f.sede) return null;
    return f.direccion && !normalizar(f.sede).includes(normalizar(f.direccion))
        ? `${f.sede} (${f.direccion})` : f.sede;
}

/**
 * Qué llevar. No hay un campo por escuela para esto (medido 2026-10-06: ni en
 * school_settings ni en las franjas): va lo que sirve para cualquier
 * entrenamiento, sin prometer implementos de la escuela.
 */
export const QUE_LLEVAR = 'ropa deportiva cómoda, tenis, una botella de agua y una toalla pequeña';

/**
 * Las líneas de «qué llevar / al llegar» de la confirmación y del recordatorio.
 * Si la escuela escribió sus indicaciones (school_settings.wa_cortesia_indicaciones,
 * mig. 20261007183601) van tal cual en lugar del texto genérico. Dynasty
 * 2026-10-07: «Ropa de entrenamiento. Al llegar, la administración está en el
 * ingreso por la parte derecha del coliseo, segundo piso.» Pura.
 * Con `textos` de una escuela que cobra la clase, el cierre dice su valor y
 * nunca «gratis» (Monster 2026-10-30: «La clase es *gratis*» salía igual).
 */
export function lineasQueLlevar(indicaciones: string | null | undefined, textos: TextosClase = TEXTOS_POR_DEFECTO): string {
    const propias = String(indicaciones ?? '').trim();
    if (propias) return `🎒 ${propias}\n⏰ Llega 10 minutos antes. ${fraseDeValor(textos, 'la_clase')}\n\n`;
    return `🎒 Qué llevar: ${QUE_LLEVAR}.\n` +
        `⏰ Llega 10 minutos antes y dile al entrenador que vienes a la ${textos.nombre}. ${fraseDeValor(textos, 'es')}\n\n`;
}

/**
 * Cómo llegar a la cancha, si la escuela lo cargó (facilities.maps_url e
 * indicaciones, migración M1): «🗺️ Cómo llegar: …» y «ℹ️ Entrada por…». Vacío
 * sin esos datos, así que la confirmación de siempre no cambia. Pura.
 */
export function lineasDeCancha(f: FranjaCortesia | null | undefined): string {
    if (!f) return '';
    const l: string[] = [];
    const maps = String(f.mapsUrl ?? '').trim();
    const indicaciones = String(f.indicacionesLugar ?? '').trim();
    if (maps) l.push(`🗺️ Cómo llegar: ${maps}`);
    if (indicaciones) l.push(`ℹ️ ${indicaciones}`);
    return l.length ? `${l.join('\n')}\n\n` : '';
}

export function bloqueFranja(f: FranjaCortesia): string {
    const fin = f.horaFin ? ` a ${horaLegible(f.horaFin)}` : '';
    const sede = sedeConDireccion(f);
    return `📅 ${fechaLegible(f.fecha)}\n🕔 ${horaLegible(f.horaInicio)}${fin}` +
        (sede ? `\n📍 ${sede}` : '') + `\n👥 Grupo: ${f.grupo}`;
}

function textoResumen(d: DatosCortesia, t: TextosClase = TEXTOS_POR_DEFECTO): string {
    const lineas = ['Revisa que esté todo bien:', ''];
    if (d.franja) {
        lineas.push(`• Clase: *${d.franja.grupo}* — ${fechaLegible(d.franja.fecha)}, ${horaLegible(d.franja.horaInicio)}`);
        const sede = sedeConDireccion(d.franja);
        if (sede) lineas.push(`• Sede: ${sede}`);
    } else {
        lineas.push(`• ${t.nombreInicial}: *la escuela te contacta para agendarla*`);
    }
    if (!t.gratis) lineas.push(`• Valor de la clase: *${t.precio}*`);
    lineas.push(`• Deportista: *${d.nombre ?? ''}* (${d.edad ?? '?'} años)`);
    if (d.acudiente) lineas.push(`• Acudiente: *${d.acudiente}*`);
    lineas.push('• Teléfono: este WhatsApp');
    lineas.push('', d.franja ? '¿Confirmo la reserva?' : '¿Paso estos datos a la escuela?');
    return lineas.join('\n');
}

// ─── Lectura de respuestas ─────────────────────────────────────────────────

const NO_ES_NOMBRE = /^(hola+|holi|buenas|buenos dias|buen dia|buenas tardes|buenas noches|gracias|muchas gracias|ok|okey|listo|dale|vale|si|no|bueno|perfecto|claro|hello|alo)( (gracias|mile|milena|profe))?$/;

/** Frases sobre la persona, no su nombre: «Soy la mamá de…», «Es para mi hija», «Mi nombre es…». */
const FRASE_NO_NOMBRE = /^((yo )?soy|es para|son para|para mi|mi (hija|hijo|nombre|nina|nino)|(el|la) (mama|papa|abuela|abuelo|tia|tio|hermana|hermano) de)\b/;

/** Nombre de persona: 3–80 caracteres, con letras, sin números ni @. */
export function nombreValido(texto: string): string | null {
    const t = (texto || '').replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 80) return null;
    if (/[0-9@?¿]/.test(t)) return null;
    if ((t.match(/\p{L}/gu) ?? []).length < 3) return null;
    // «Hola» 15 min después de «¿nombre completo?» no es un nombre: el bot
    // preguntó «¿Qué edad tiene Hola?» (Dynasty 2026-10-07).
    if (NO_ES_NOMBRE.test(normalizar(t))) return null;
    // «Soy la mamá de Josue» tampoco: el bot preguntó «¿Qué edad tiene Soy?» y la
    // dueña escribió «Esa IA me va a volver loca» (Dynasty 2026-10-29).
    if (FRASE_NO_NOMBRE.test(normalizar(t))) return null;
    // «Juan pérez» → «Juan Pérez»: así llega a la escuela y al resumen.
    return t.split(' ').map((p) => p ? p[0].toLocaleUpperCase('es-CO') + p.slice(1) : p).join(' ');
}

function hoyBogota(ahora: Date): { y: number; m: number; d: number; iso: string; minutos: number } {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ahora);
    const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
    const y = v('year'); const m = v('month'); const d = v('day');
    return { y, m, d, iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, minutos: v('hour') * 60 + v('minute') };
}

/**
 * Edad o fecha de nacimiento: «12», «12 años», «tiene 9», «15/03/2014»,
 * «2014-03-15». Edad válida 3–90. La fecha manda: con ella la escuela calcula
 * la categoría (lo hace `submit_school_lead`).
 */
export function leerEdad(texto: string, ahora: Date): { edad: number; fechaNacimiento: string | null } | null {
    const n = normalizar(texto);
    const hoy = hoyBogota(ahora);
    let y: number | null = null; let m: number | null = null; let d: number | null = null;
    const dmy = n.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
    const ymd = n.match(/\b(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
    if (dmy) { d = Number(dmy[1]); m = Number(dmy[2]); y = Number(dmy[3]); }
    else if (ymd) { y = Number(ymd[1]); m = Number(ymd[2]); d = Number(ymd[3]); }
    if (y && m && d) {
        const fecha = new Date(Date.UTC(y, m - 1, d));
        if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;
        let edad = hoy.y - y;
        if (hoy.m < m || (hoy.m === m && hoy.d < d)) edad--;
        if (edad < 3 || edad > 90) return null;
        return { edad, fechaNacimiento: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
    }
    // «11años» (sin espacio, Dynasty 2026-10-07) también.
    const solo = n.match(/^(?:tiene |tengo |de )?(\d{1,2}) ?(?:anos|ano|anitos)?$/);
    if (solo) {
        const edad = Number(solo[1]);
        if (edad >= 3 && edad <= 90) return { edad, fechaNacimiento: null };
    }
    return null;
}

const SI = new Set(['si', 's', 'dale', 'ok', 'listo', 'claro', 'confirmar', 'confirmo', 'correcto', 'si confirmar',
    'si confirmo', 'esta bien', 'de una', 'si dejar mis datos', 'si cancelar', 'si por favor']);
const NO = new Set(['no', 'n', 'no gracias', 'cambiar', 'corregir', 'no la mantengo', 'mantener', 'no cancelar']);

/**
 * «Si señora», «sí, gracias», «dale profe», «perfecto»: un sí con cortesía
 * detrás (auditoría 2026-10-28, X-03: a «Si señora» el bot contestó «Responde
 * Confirmar» y el prospecto tuvo que escribir «Asesor»). Corto (≤ 4 palabras) y
 * sin nada que lo contradiga.
 */
const SI_CON_CORTESIA = /^(si|dale|ok|okay|okey|listo|claro|perfecto|correcto|vale|bueno|de una|confirm\w*)\b/;
const CONTRADICE = /\b(no|cambiar|cambio|corregir|otro|otra|pero|mejor)\b/;

function siNo(texto: string, botonId: string | null, si: string, no: string): 'si' | 'no' | null {
    if (botonId === si) return 'si';
    if (botonId === no) return 'no';
    const n = normalizar(texto).replace(/[.,!¡]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (SI.has(n)) return 'si';
    if (NO.has(n)) return 'no';
    if (n.split(' ').length <= 4 && SI_CON_CORTESIA.test(n) && !CONTRADICE.test(n)) return 'si';
    return null;
}

// ─── Motor del flujo ───────────────────────────────────────────────────────

function deps(ctx: CtxCortesia) {
    return {
        leerEstado: ctx.leerEstado ?? leerEstadoDeSupabase,
        franjas: ctx.franjas ?? franjasDeSupabase,
        reservaVigente: ctx.reservaVigente ?? reservaVigenteDeSupabase,
        reservar: ctx.reservar ?? reservarEnSupabase,
        cancelar: ctx.cancelar ?? cancelarEnSupabase,
        avisar: ctx.avisarEscuela ?? avisarEscuelaCortesia,
        indicaciones: ctx.indicaciones ?? indicacionesCortesiaDeEscuela,
        ahora: (ctx.ahora ?? (() => new Date()))(),
    };
}

/** Minutos absolutos (día × 1440 + hora) de una fecha/hora de Bogotá. */
function minutosAbsolutos(fecha: string, hora: string): number {
    const { y, m, d } = partesFecha(fecha);
    return Math.round(Date.UTC(y, m - 1, d) / 60_000) + minutos(hora);
}

/**
 * Franjas con cupo que empiezan dentro de 2 h o más (Bogotá), ordenadas.
 * Antes solo se sacaban las de hoy que YA habían empezado: a las 3:50 p. m.
 * se ofrecía la de las 4:00 p. m. (auditoría Dynasty 2026-10-06).
 */
export function filtrarVigentes(franjas: FranjaCortesia[], ahora: Date): FranjaCortesia[] {
    const hoy = hoyBogota(ahora);
    const limite = minutosAbsolutos(hoy.iso, '00:00') + hoy.minutos + ANTICIPACION_MINIMA_MIN;
    return franjas
        .filter((f) => f.cupos > 0)
        .filter((f) => minutosAbsolutos(f.fecha, f.horaInicio) >= limite)
        .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio));
}

/** step del mensaje «no tengo un grupo para X años» (deja el caso para la escuela). */
export const PASO_SIN_GRUPO_PARA_EDAD = 'cortesia_sin_grupo_para_edad';

/** Franjas que se ofrecen según el perfil y el día pedidos (ya vigentes). */
function candidatas(franjas: FranjaCortesia[], datos: DatosCortesia): FiltroPerfil {
    const porPerfil = filtrarPorPerfil(franjas, datos.perfil);
    if (datos.dia == null) return porPerfil;
    const delDia = porPerfil.franjas.filter((f) => partesFecha(f.fecha).dow === datos.dia);
    return delDia.length ? { franjas: delDia, nota: porPerfil.nota } : porPerfil;
}

/**
 * Turno del flujo. true = lo resolvió este módulo. false = no era para acá
 * (el bot sigue con lo suyo).
 *
 * `iniciar=false`: solo atiende lo que ya está en curso (flujo abierto, botón
 * del flujo, cancelación con reserva). Lo usa el desconocido, que antes de
 * EMPEZAR algo tiene que pasar por el filtro de tema escolar y su freno.
 */
export async function atenderTurnoCortesia(
    ctx: CtxCortesia,
    textoCrudo: string,
    botonId: string | null,
    opciones: { iniciar?: boolean; encabezado?: string; step?: string; intro?: string } = {},
): Promise<boolean> {
    const d = deps(ctx);
    const texto = (textoCrudo || '').trim();
    const iniciar = opciones.iniciar ?? true;

    const estado = await d.leerEstado(ctx.conversationId);

    // Botón «Cancelar mi clase», o lo pide escrito: SOLO si hay reserva.
    if (botonId === BOTON_CC.CANCELAR || (!estado && quiereCancelarClase(texto))) {
        const reserva = await d.reservaVigente(ctx.schoolId, ctx.contactWaId);
        const t = await textosDe(ctx);
        if (!reserva) {
            if (botonId !== BOTON_CC.CANCELAR) return false;
            await ctx.enviar(`No encuentro una ${t.nombre} reservada desde este número. 🤔`,
                'cortesia_sin_reserva', null);
            return true;
        }
        await ctx.enviar(
            `¿Cancelo la ${t.nombre} de *${reserva.nombre}*?\n\n${bloqueFranja(reserva.franja)}`,
            'cortesia_confirmar_cancelacion',
            { paso: 'confirmar_cancelacion', datos: { franja: reserva.franja, nombre: reserva.nombre } },
            BOTONES_CANCELAR, 'Responde *Sí, cancelar* o *No, la mantengo*.');
        return true;
    }

    if (estado) {
        // Con flujo abierto, un botón de OTRA cosa («Ver mis pagos») es una
        // elección explícita: el flujo se suelta y lo atiende quien sabe.
        if (botonId && !esBotonCortesia(botonId)) return false;
        // «Necesito hablar con un asesor», «¿Milena?»: en cualquier paso se
        // suelta el flujo y lo atiende el bot general (escalación).
        if (!botonId && quiereSalirDelFlujo(texto)) return false;
        return continuar(ctx, d, estado, texto, botonId);
    }

    // Sin flujo abierto: un botón viejo del flujo (de un mensaje anterior) se
    // atiende igual, revalidando contra las franjas de AHORA.
    if (esBotonCortesia(botonId)) {
        return continuar(ctx, d, { paso: 'elegir_franja', datos: {} }, texto, botonId);
    }

    if (iniciar && pideClaseDeCortesia(texto)) {
        await iniciarCortesia(ctx, { ...opciones, texto });
        return true;
    }
    return false;
}

/**
 * Arranca: informa y ofrece franjas, o (sin franjas) ofrece dejar los datos.
 * Es lo que hace la tool `get_trial_class_info` y la puerta del desconocido.
 */
export async function iniciarCortesia(
    ctx: CtxCortesia,
    opciones: {
        encabezado?: string; step?: string; intro?: string; texto?: string | null;
        /**
         * Lo que ya se sabe de quien va a la clase (el mini-registro de la puerta
         * del desconocido): al elegir horario va directo al resumen, sin volver a
         * preguntar nombre, edad ni acudiente.
         */
        datos?: Pick<DatosCortesia, 'nombre' | 'edad' | 'fechaNacimiento' | 'acudiente'>;
    } = {},
): Promise<void> {
    const d = deps(ctx);
    const cabeza = opciones.encabezado ? `${opciones.encabezado}\n\n` : '';
    const t = await textosDe(ctx);

    // Ya tiene una reservada: se le recuerda en vez de reservarle otra.
    const reserva = await d.reservaVigente(ctx.schoolId, ctx.contactWaId);
    if (reserva) {
        await ctx.enviar(
            cabeza + `Ya tienes una ${t.nombre} reservada para *${reserva.nombre}*:\n\n${bloqueFranja(reserva.franja)}\n\n` +
            'Si no puedes ir, toca *Cancelar mi clase* para liberar el cupo.',
            opciones.step ?? 'cortesia_ya_reservada', null,
            BOTON_CANCELAR_MI_CLASE, 'Si no puedes ir, escríbeme *cancelar mi clase*.');
        return;
    }

    const franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
    if (!franjas.length) {
        await ctx.enviar(
            cabeza + `Por ahora no tengo horarios de *${t.nombre}* publicados para agendarla por aquí. 🙏\n\n` +
            '¿Quieres dejarme tus datos para que la escuela te contacte y te agende una?',
            opciones.step ?? 'cortesia_sin_franjas',
            { paso: 'dejar_datos', datos: { sinFranja: true } },
            BOTONES_DATOS, 'Responde *Sí* para dejar tus datos o *No, gracias*.');
        return;
    }

    // ¿Para quién es? Lo que ya dijo («para mi hija de 8 años») filtra. Solo se
    // PREGUNTA si no dijo nada, no nombró un grupo y los grupos traen con qué
    // filtrar: una pregunta de más también pierde prospectos.
    const grupo = grupoMencionado(opciones.texto, franjas);
    // Lo que dijo ahora y, si no, lo que dijo en los últimos 7 días: la edad
    // no se vuelve a preguntar. Gana lo más reciente («mi hija tiene 14»).
    const perfil = combinarPerfiles(perfilReciente(opciones.texto), await perfilPrevioSeguro(ctx));
    const dia = leerDia(opciones.texto);
    // La lista completa ya salió en las últimas 24 h: no se repite.
    const yaListado = !grupo && await listadoRecienteSeguro(ctx);
    const base = presentacionDeClase(t);
    if (!grupo && !perfil && (gruposFiltrables(franjas) || yaListado)) {
        // El intro de quien llama dice «estos son los horarios:»; aquí todavía no
        // se muestran, así que va el texto base.
        await ctx.enviar(
            cabeza + (yaListado
                ? 'Los horarios te los compartí arriba 👆. Si me dices *para quién es* y *qué edad tiene*, ' +
                  'te digo su grupo y te reservo el cupo.'
                : `${base}\n\nPara mostrarte los horarios del grupo indicado: *¿para quién es la clase y qué edad tiene?* ` +
                  '(por ejemplo: «para mi hija de 8 años» o «soy adulto»)'),
            opciones.step ?? 'cortesia_perfil',
            { paso: 'perfil', datos: { dia, intentos: 0 } });
        return;
    }
    if (grupo) {
        const delGrupo = franjas.filter((f) => baseGrupo(f.grupo) === grupo);
        const intro = opciones.intro
            ?? `${base} Estos son los horarios de *${grupo.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())}*:`;
        await ofrecerFranjas(ctx, delGrupo.length ? delGrupo : franjas, 0, { dia, ...opciones.datos }, cabeza + intro,
            opciones.step ?? 'cortesia_ofrecer', { yaFiltradas: true });
        return;
    }
    await ofrecerFranjas(ctx, franjas, 0, { perfil, dia, ...edadDelPerfil(perfil), ...opciones.datos },
        cabeza + (opciones.intro ?? `${base} Estos son los próximos horarios:`),
        opciones.step ?? 'cortesia_ofrecer', { maximo: yaListado ? MAX_BOTONES : undefined });
}

async function perfilPrevioSeguro(ctx: CtxCortesia): Promise<PerfilAtleta | null> {
    try { return (await ctx.perfilPrevio?.()) ?? null; } catch { return null; }
}

async function listadoRecienteSeguro(ctx: CtxCortesia): Promise<boolean> {
    try { return (await ctx.listadoReciente?.()) ?? false; } catch { return false; }
}

async function rangosSeguros(ctx: CtxCortesia): Promise<RangoGrupo[]> {
    try { return await (ctx.rangos ?? rangosDeEscuela)(ctx.schoolId); } catch { return []; }
}

/**
 * Rangos de los grupos que TIENEN franjas: los del servicio de grupos si
 * están, y si no, armados con lo que traen las propias franjas.
 */
function rangosDeFranjas(franjas: FranjaCortesia[], rangos: RangoGrupo[]): RangoGrupo[] {
    const porTeam = new Map(rangos.map((r) => [r.teamId, r]));
    const salida = new Map<string, RangoGrupo>();
    for (const f of franjas) {
        const clave = f.teamId ?? baseGrupo(f.grupo);
        if (salida.has(clave)) continue;
        const r = f.teamId ? porTeam.get(f.teamId) : undefined;
        if (r) { salida.set(clave, r); continue; }
        const generoNombre = generoDeGrupo(f.grupo);
        salida.set(clave, {
            teamId: clave, nombre: baseGrupo(f.grupo), edadMin: f.edadMin ?? null, edadMax: f.edadMax ?? null,
            mediana: null, fuenteEdad: f.edadFuente ?? (tieneRango(f) ? 'equipo' : null),
            genero: generoNombre ?? f.generoGrupo ?? null, generoExplicito: generoNombre !== null,
            adultos: esGrupoDeAdultos(f.grupo), nivel: null, horario: null, admiteNuevos: true,
            muestra: 0, confianza: 'baja',
        });
    }
    return [...salida.values()];
}

/** Franjas del grupo elegido (por equipo, o por nombre si la franja no trae equipo). */
function franjasDelGrupo(franjas: FranjaCortesia[], r: RangoGrupo): FranjaCortesia[] {
    return franjas.filter((f) => (f.teamId ? f.teamId === r.teamId : baseGrupo(f.grupo) === r.nombre));
}

/**
 * «¿Qué grupo le corresponde a mi hija de 12?» / «¿Desde qué edad reciben?»:
 * respuesta corta y UNA vez, sin modelo. Con la edad (la de ahora o la que
 * dijo en los últimos 7 días) → «Para 12 años le corresponde *Infantil
 * Femenino* (…)» y, si ese grupo tiene clase de cortesía, «¿Te reservo?» con
 * hasta 3 horarios en botones (no la lista completa). Sin edad → la pregunta.
 * false = no era esta pregunta o no hay con qué contestarla (sigue el bot).
 */
export async function responderGrupoPorEdad(
    ctx: CtxCortesia, texto: string, opciones: { step: string; encabezado?: string },
): Promise<boolean> {
    const tipo = preguntaGrupoPorEdad(texto);
    if (!tipo) return false;
    const d = deps(ctx);
    const rangos = await rangosSeguros(ctx);
    const cabeza = opciones.encabezado ? `${opciones.encabezado}\n\n` : '';
    if (tipo === 'desde') {
        const t = textoDesdeQueEdad(rangos);
        if (!t) return false;
        await ctx.enviar(cabeza + t, opciones.step, null);
        return true;
    }
    const perfil = combinarPerfiles(perfilReciente(texto), await perfilPrevioSeguro(ctx));
    let franjas: FranjaCortesia[] = [];
    try { franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora); } catch { franjas = []; }
    if (!perfil || (perfil.edad == null && !perfil.adulto)) {
        if (!rangos.length) return false;
        await ctx.enviar(cabeza + '¿Qué *edad* tiene? Con eso te digo qué grupo le corresponde.', opciones.step,
            franjas.length ? { paso: 'perfil', datos: { intentos: 0 } } : null);
        return true;
    }
    const eleccion = elegirGrupo(rangos, perfil);
    const linea = textoGrupoParaEdad(eleccion, perfil);
    if (!linea || !eleccion.principal) return false;
    const delGrupo = eleccion.porGenero ? [] : franjasDelGrupo(franjas, eleccion.principal);
    if (delGrupo.length) {
        const t = await textosDe(ctx);
        await ofrecerFranjas(ctx, delGrupo, 0, { perfil, ...edadDelPerfil(perfil) },
            cabeza + `${linea}\n\n${ofertaDeReserva(t)} Estos son los próximos horarios:`,
            opciones.step, { yaFiltradas: true, maximo: MAX_BOTONES });
        return true;
    }
    await ctx.enviar(cabeza + linea, opciones.step, null);
    return true;
}

/**
 * Los horarios de cortesía para quien YA recibió la primera respuesta y
 * pregunta de nuevo (seguimiento de prospecto): filtra con lo que dijo en
 * `texto` (edad, género, adulto, grupo) y NUNCA vuelve a preguntar el perfil.
 * false = no hay franjas vigentes (quien llama responde con otra cosa).
 * El día solo se toma de `textoDelDia` (el mensaje actual): un «sábado» de
 * hace cuatro días no es lo que pide hoy.
 */
export async function ofrecerHorariosDeCortesia(
    ctx: CtxCortesia,
    opciones: { texto: string; textoDelDia?: string | null; intro: string; step: string },
): Promise<boolean> {
    const d = deps(ctx);
    const franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
    if (!franjas.length) return false;
    const dia = leerDia(opciones.textoDelDia ?? null);
    const grupo = grupoMencionado(opciones.texto, franjas);
    if (grupo) {
        const delGrupo = franjas.filter((f) => baseGrupo(f.grupo) === grupo);
        await ofrecerFranjas(ctx, delGrupo.length ? delGrupo : franjas, 0, { dia }, opciones.intro, opciones.step,
            { yaFiltradas: true });
        return true;
    }
    // `texto` trae varios mensajes (uno por línea): gana lo más reciente, y si
    // no dice nada, lo que dijo en los últimos 7 días.
    const perfil = combinarPerfiles(perfilReciente(opciones.texto), await perfilPrevioSeguro(ctx));
    await ofrecerFranjas(ctx, franjas, 0, { perfil, dia, ...edadDelPerfil(perfil) }, opciones.intro, opciones.step);
    return true;
}

/**
 * Ofrece las franjas. ≤ 3 → botones; más → lista de WhatsApp (≤ 10 filas,
 * secciones por día; 9 + «Ver más» si hay más). El texto lleva las mismas
 * opciones numeradas y agrupadas por día: es lo que sale si la lista no sale
 * (modo asistido, o Meta la rechaza) y lo que permite responder «la 2».
 *
 * `datosPrevios.perfil`/`dia` filtran, y quedan en el estado para «ver más».
 */
async function ofrecerFranjas(
    ctx: CtxCortesia,
    vigentes: FranjaCortesia[],
    desde: number,
    datosPrevios: DatosCortesia,
    intro: string,
    step: string,
    op: { yaFiltradas?: boolean; maximo?: number } = {},
): Promise<void> {
    const filtro: FiltroPerfil = op.yaFiltradas ? { franjas: vigentes, nota: '' } : candidatas(vigentes, datosPrevios);
    let { franjas, nota } = filtro;
    // Ningún grupo recibe esa edad: no se ofrecen los horarios de otros (ni los
    // de adultos). Mensaje terminal; queda para la escuela (aviso de pendientes).
    if (filtro.sinGrupoParaEdad != null && !franjas.length) {
        await ctx.enviar(
            `Por ahora no tengo un grupo para *${filtro.sinGrupoParaEdad} años* 🙏 ` +
            'Le paso tu mensaje a la escuela para que te confirme desde qué edad reciben.',
            PASO_SIN_GRUPO_PARA_EDAD, null);
        return;
    }
    // Con la edad (o «soy adulto») se dice UNA vez qué grupo le corresponde y
    // se ofrecen solo sus horarios: «Para 12 años le corresponde *Infantil
    // Femenino* (…)». El rango sale de grupos-por-edad.service.
    let lineaGrupo = '';
    const perfil = datosPrevios.perfil;
    if (!op.yaFiltradas && perfil && !perfil.todos && (perfil.edad != null || perfil.adulto)) {
        const eleccion = elegirGrupo(rangosDeFranjas(franjas, await rangosSeguros(ctx)), perfil);
        const grupos = eleccion.porGenero ? [eleccion.porGenero.f, eleccion.porGenero.m]
            : eleccion.principal ? [eleccion.principal] : [];
        const delGrupo = franjas.filter((f) => grupos.some((g) => franjasDelGrupo([f], g).length));
        if (delGrupo.length) {
            franjas = delGrupo;
            lineaGrupo = textoGrupoParaEdad(eleccion, perfil) ?? '';
            nota = '';
        }
    }
    const lista = paginar(intercalarPorGrupo(franjas).slice(0, op.maximo ?? MAX_FRANJAS_OFRECIDAS));
    const porPagina = lista.length > MAX_FILAS ? MAX_FILAS - 1 : MAX_FILAS;
    const inicio = desde >= lista.length ? 0 : desde;
    const visibles = lista.slice(inicio, inicio + porPagina);
    const hayMas = lista.length > porPagina;
    const comoBotones = lista.length <= MAX_BOTONES;

    const criterio = describirPerfil(datosPrevios.perfil);
    const soloDelDia = datosPrevios.dia != null && visibles.every((f) => partesFecha(f.fecha).dow === datosPrevios.dia);
    const delDia = soloDelDia ? ` del *${DIAS[datosPrevios.dia!]}*` : '';
    const encabezado = [
        intro,
        lineaGrupo || (criterio || delDia ? `Te muestro los horarios${criterio ? ` ${criterio}` : ''}${delDia}.` : ''),
        datosPrevios.dia != null && !soloDelDia ? `No tengo horarios el *${DIAS[datosPrevios.dia]}*; estos son los que hay.` : '',
        nota,
    ].filter(Boolean).join(' ');

    let cuerpo: string;
    let opcionesUI: BotonInteractivo[];
    if (comoBotones) {
        cuerpo = visibles.map((f, i) => lineaFranja(f, inicio + i + 1)).join('\n');
        opcionesUI = visibles.map((f, i) => ({ id: `${BOTON_CC.FRANJA}${f.id}`, title: tituloBoton(f, inicio + i + 1) }));
    } else {
        const lineas: string[] = [];
        let diaActual = '';
        visibles.forEach((f, i) => {
            if (f.fecha !== diaActual) {
                diaActual = f.fecha;
                const fl = fechaLegible(f.fecha);
                if (lineas.length) lineas.push('');
                lineas.push(`*${fl[0].toUpperCase()}${fl.slice(1)}*`);
            }
            lineas.push(lineaFranjaEnDia(f, inicio + i + 1));
        });
        cuerpo = lineas.join('\n');
        opcionesUI = visibles.map((f, i) => filaDeLista(f, inicio + i + 1));
        if (hayMas) {
            const quedan = inicio + porPagina < lista.length;
            opcionesUI.push({ id: BOTON_CC.VER_MAS, title: quedan ? 'Ver más horarios' : 'Volver al inicio',
                descripcion: quedan ? 'Otros días y grupos' : 'Los primeros horarios otra vez', seccion: 'Más' });
        }
    }

    const comoResponder = `Responde con el número (${visibles.map((_, i) => inicio + i + 1).join(', ')})` +
        (hayMas ? ', *ver más*' : '') + ', un día (*el sábado*) o *asesor* para hablar con una persona.';
    // Lista (> 3 franjas): el cuerpo NO repite las franjas —van en las filas de
    // la lista, con día, hora y sede—. Auditoría 2026-10-07: cuerpos de
    // 860–1026 caracteres con un 📍 por línea, y los de más de 1024 Meta los
    // rechaza como interactivo y salían como texto de 1394–1647. El listado
    // numerado completo queda en `enTexto`: es lo que sale si la lista no sale
    // (modo asistido o Meta la rechaza), y «la 2» se sigue entendiendo.
    const cuerpoMensaje = comoBotones
        ? `${encabezado}\n\n${cuerpo}\n\n¿Cuál te reservo?`
        : `${encabezado}\n\n${resumenDeLista(visibles)} Toca *Ver opciones* y elige el tuyo.`;
    await ctx.enviar(
        cuerpoMensaje,
        step,
        { paso: 'elegir_franja', datos: { ...datosPrevios, franja: null, sinFranja: false,
            lista: lista.map((f) => f.id), desde: inicio, intentos: 0 } },
        opcionesUI,
        comoBotones ? comoResponder : `${cuerpo}\n\n¿Cuál te reservo? ${comoResponder}`);
}

/** «Tengo 9 horarios entre el miércoles 7 y el viernes 9 de octubre.» Pura. */
export function resumenDeLista(franjas: FranjaCortesia[]): string {
    if (!franjas.length) return '';
    const fechas = franjas.map((f) => f.fecha).sort();
    const primero = fechaLegible(fechas[0]);
    const ultimo = fechaLegible(fechas[fechas.length - 1]);
    const cuantos = `Tengo ${franjas.length} horario${franjas.length === 1 ? '' : 's'}`;
    return fechas[0] === fechas[fechas.length - 1]
        ? `${cuantos} el ${primero}.`
        : `${cuantos} entre el ${primero} y el ${ultimo}.`;
}

/**
 * Orden de la lista: páginas de 9 (o 10 si caben todas) tomadas de la lista
 * intercalada por grupo, y DENTRO de cada página en orden cronológico — así
 * cada mensaje se lee agrupado por día y la numeración es estable entre
 * páginas («la 12» es la 12 de la lista guardada en el estado).
 */
function paginar(franjas: FranjaCortesia[]): FranjaCortesia[] {
    const porPagina = franjas.length > MAX_FILAS ? MAX_FILAS - 1 : MAX_FILAS;
    const salida: FranjaCortesia[] = [];
    for (let i = 0; i < franjas.length; i += porPagina) {
        salida.push(...franjas.slice(i, i + porPagina)
            .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio)));
    }
    return salida;
}

/**
 * Fila de la lista: título = n + grupo (≤ 24: «7. MINIVOLLEY BENJAMINES» cabe
 * justo), descripción = hora · subgrupo · sede (≤ 72), sección = día.
 */
export function filaDeLista(f: FranjaCortesia, n: number): BotonInteractivo {
    const titulo = Array.from(`${n}. ${baseGrupo(f.grupo)}`).slice(0, 24).join('');
    const sub = f.grupo.includes('·') ? f.grupo.split('·').slice(1).join('·').trim() : '';
    const hora = horaLegible(f.horaInicio) + (f.horaFin ? ` a ${horaLegible(f.horaFin)}` : '');
    const desc = [hora, sub, f.sede ?? ''].filter(Boolean).join(' · ');
    return {
        id: `${BOTON_CC.FRANJA}${f.id}`,
        title: titulo,
        descripcion: Array.from(desc).slice(0, 72).join('') || undefined,
        seccion: tituloDia(f.fecha),
    };
}

type Deps = ReturnType<typeof deps>;

async function continuar(
    ctx: CtxCortesia, d: Deps, estado: EstadoCortesia, texto: string, botonId: string | null,
): Promise<boolean> {
    const datos = estado.datos ?? {};

    // Respuesta al recordatorio: «CANCELAR» libera el cupo ya (el recordatorio
    // pidió esa palabra: es la confirmación). Cualquier otra cosa —«gracias»,
    // «allá estaremos», una pregunta— la atiende el bot general.
    if (estado.paso === 'recordatorio') {
        if (!botonId && cancelaTrasRecordatorio(texto)) return cancelarReserva(ctx, d, datos);
        return false;
    }

    if (!botonId && abandona(texto) && estado.paso !== 'confirmar_cancelacion') {
        const t = await textosDe(ctx);
        await ctx.enviar(`Listo, lo dejamos así. Si quieres agendar después, escríbeme *${t.nombre}*. 🙌`,
            'cortesia_abandonada', null);
        return true;
    }

    switch (estado.paso) {
        case 'perfil': return responderPerfil(ctx, d, estado, texto, botonId);
        case 'elegir_franja': return elegirFranja(ctx, d, datos, texto, botonId);
        case 'dejar_datos': {
            const r = siNo(texto, botonId, BOTON_CC.DATOS_SI, BOTON_CC.DATOS_NO);
            if (r === 'no') {
                const t = await textosDe(ctx);
                await ctx.enviar(`Sin problema. Si después quieres agendar, escríbeme *${t.nombre}*. 🙌`,
                    'cortesia_no_deja_datos', null);
                return true;
            }
            if (r === 'si') return pedirNombre(ctx, { ...datos, sinFranja: true, franja: null });
            if (pareceOtraConversacion(texto)) return false;
            return reintentar(ctx, estado, '¿Me dejas tus datos? Responde *Sí* o *No, gracias*.',
                BOTONES_DATOS);
        }
        case 'nombre': {
            // El turno corre con el ÚLTIMO mensaje de la ráfaga: «Karol Saenz» +
            // «Soy la mamá de Josue» llegaba solo con el segundo. Si ese no es un
            // nombre, sirve uno de los mensajes anteriores sin responder.
            const nombre = nombreValido(texto)
                ?? (ctx.rafaga ? ctx.rafaga.split('\n').map((l) => nombreValido(l)).find(Boolean) ?? null : null);
            if (!nombre) {
                if (pareceOtraConversacion(texto)) return false;
                return reintentar(ctx, estado,
                    'Escríbeme el *nombre completo* de quien va a tomar la clase (solo el nombre, sin números).');
            }
            // La edad ya la dijo al principio («para mi hija de 8 años»): no se repite.
            if (typeof datos.edad === 'number') return trasEdad(ctx, { ...datos, nombre, intentos: 0 });
            await ctx.enviar(
                `Gracias. ¿Qué *edad* tiene ${nombre.split(' ')[0]}? También me sirve la *fecha de nacimiento* (por ejemplo 15/03/2014).`,
                'cortesia_edad', { paso: 'edad', datos: { ...datos, nombre, intentos: 0 } });
            return true;
        }
        case 'edad': {
            const e = leerEdad(texto, d.ahora);
            if (!e) {
                if (pareceOtraConversacion(texto)) return false;
                return reintentar(ctx, estado,
                    'No te entendí la edad. Escríbeme solo el número de años (por ejemplo *12*) o la fecha de nacimiento (*15/03/2014*).');
            }
            return trasEdad(ctx, { ...datos, edad: e.edad, fechaNacimiento: e.fechaNacimiento, intentos: 0 });
        }
        case 'acudiente': {
            const acudiente = nombreValido(texto);
            if (!acudiente) {
                if (pareceOtraConversacion(texto)) return false;
                return reintentar(ctx, estado, 'Escríbeme el *nombre completo del acudiente*.');
            }
            return confirmar(ctx, { ...datos, acudiente });
        }
        case 'confirmar': {
            const r = siNo(texto, botonId, BOTON_CC.CONFIRMAR, BOTON_CC.CAMBIAR);
            if (r === 'si') return reservar(ctx, d, datos);
            if (r === 'no') {
                // «Cambiar» arranca de cero: es más claro que preguntar qué dato
                // cambiar, y son solo tres preguntas.
                if (datos.sinFranja) return pedirNombre(ctx, { sinFranja: true, franja: null });
                const franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
                if (!franjas.length) {
                    await ctx.enviar('Ya no quedan franjas disponibles. ¿Quieres dejarme tus datos para que la escuela te contacte?',
                        'cortesia_sin_franjas', { paso: 'dejar_datos', datos: { sinFranja: true } }, BOTONES_DATOS);
                    return true;
                }
                // La edad que dijo en el perfil se conserva: sin ella, tras elegir
                // de nuevo se le volvía a preguntar (Dynasty 2026-10-07, …5566).
                await ofrecerFranjas(ctx, franjas, 0, { perfil: datos.perfil ?? null, ...edadDelPerfil(datos.perfil) },
                    'Listo, empecemos de nuevo. Elige la franja:', 'cortesia_ofrecer');
                return true;
            }
            if (pareceOtraConversacion(texto)) return false;
            return reintentar(ctx, estado, 'Responde *Confirmar* para reservar o *Cambiar* para empezar de nuevo.',
                BOTONES_CONFIRMAR);
        }
        case 'confirmar_cancelacion': {
            const r = siNo(texto, botonId, BOTON_CC.CANCELAR_SI, BOTON_CC.CANCELAR_NO);
            if (r === 'no') {
                await ctx.enviar('Perfecto, tu clase sigue reservada. ¡Te esperamos! 💪', 'cortesia_cancelacion_desistida', null);
                return true;
            }
            if (r === 'si') return cancelarReserva(ctx, d, datos);
            if (pareceOtraConversacion(texto)) return false;
            return reintentar(ctx, estado, 'Responde *Sí, cancelar* o *No, la mantengo*.', BOTONES_CANCELAR);
        }
    }
    return false;
}

/** Con la edad conocida: acudiente si es menor (y no lo conocemos), o resumen. */
async function trasEdad(ctx: CtxCortesia, nuevos: DatosCortesia): Promise<boolean> {
    if ((nuevos.edad ?? 0) < 18) {
        if (nuevos.acudiente) return confirmar(ctx, nuevos);
        const conocido = ctx.nombreAcudiente ? await ctx.nombreAcudiente().catch(() => null) : null;
        if (conocido) return confirmar(ctx, { ...nuevos, acudiente: conocido });
        await ctx.enviar('Como es menor de edad, ¿cuál es el *nombre completo del acudiente*?',
            'cortesia_acudiente', { paso: 'acudiente', datos: nuevos });
        return true;
    }
    return confirmar(ctx, { ...nuevos, acudiente: null });
}

/** Respuesta a «¿para quién es la clase y qué edad tiene?». */
async function responderPerfil(
    ctx: CtxCortesia, d: Deps, estado: EstadoCortesia, texto: string, botonId: string | null,
): Promise<boolean> {
    const datos = estado.datos ?? {};
    const franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
    if (!franjas.length) return sinFranjasDisponibles(ctx);
    const dia = leerDia(texto) ?? datos.dia ?? null;

    const grupo = grupoMencionado(texto, franjas);
    if (grupo) {
        const delGrupo = franjas.filter((f) => baseGrupo(f.grupo) === grupo);
        await ofrecerFranjas(ctx, delGrupo, 0, { dia }, `Listo. Horarios de *${grupo}*:`, 'cortesia_ofrecer',
            { yaFiltradas: true });
        return true;
    }
    // El perfil sale del mensaje o, si el turno agrupó varios, de la ráfaga
    // entera («Tengo 23 años y soy mujer» + «Qué horarios tiene?»).
    const perfil = botonId === BOTON_CC.VER_MAS ? { todos: true }
        : leerPerfil(texto, { soloNumero: true }) ?? (ctx.rafaga ? leerPerfil(ctx.rafaga) : null);
    const diaPedido = dia ?? (ctx.rafaga ? leerDia(ctx.rafaga) : null);
    if (perfil) {
        await ofrecerFranjas(ctx, franjas, 0, { perfil, dia: diaPedido, ...edadDelPerfil(perfil) },
            perfil.todos ? 'Listo, estos son los horarios de *todos los grupos*:' : 'Perfecto. 👍',
            'cortesia_ofrecer');
        return true;
    }
    // «¿Qué horarios tiene?» sin decir para quién: se muestran todos en vez de
    // soltar el flujo (que dejaba al prospecto sin respuesta) o repetir la pregunta.
    if (!botonId && preguntaPorHorarios(texto)) {
        await ofrecerFranjas(ctx, franjas, 0, { dia: diaPedido },
            'Estos son los próximos horarios. Si me dices *para quién es* y *qué edad tiene*, te muestro solo los de su grupo.',
            'cortesia_ofrecer');
        return true;
    }
    if (pareceOtraConversacion(texto) || esPreguntaDeOtroTema(texto)) return false;
    return reintentar(ctx, estado,
        'Cuéntame *para quién es* y *qué edad tiene* (por ejemplo «mi hijo de 10 años» o «soy adulta»), ' +
        'o escríbeme *todos* para ver todos los horarios.');
}

/** La edad que dijo en el perfil se guarda para no volver a preguntarla. */
function edadDelPerfil(p: PerfilAtleta | null | undefined): Pick<DatosCortesia, 'edad'> {
    return typeof p?.edad === 'number' ? { edad: p.edad } : {};
}

async function reintentar(
    ctx: CtxCortesia, estado: EstadoCortesia, pregunta: string, botones?: BotonInteractivo[],
): Promise<boolean> {
    const intentos = (estado.datos?.intentos ?? 0) + 1;
    if (intentos >= MAX_INTENTOS) {
        const t = await textosDe(ctx);
        await ctx.enviar(`Dejémoslo acá por ahora. Cuando quieras retomarlo, escríbeme *${t.nombre}*. 🙌`,
            'cortesia_demasiados_intentos', null);
        return true;
    }
    await ctx.enviar(pregunta, `cortesia_${estado.paso}`,
        { paso: estado.paso, datos: { ...estado.datos, intentos } }, botones);
    return true;
}

async function pedirNombre(ctx: CtxCortesia, datos: DatosCortesia): Promise<boolean> {
    await ctx.enviar('¿Cuál es el *nombre completo* de quien va a tomar la clase?',
        'cortesia_nombre', { paso: 'nombre', datos: { ...datos, intentos: 0 } });
    return true;
}

async function confirmar(ctx: CtxCortesia, datos: DatosCortesia): Promise<boolean> {
    await ctx.enviar(textoResumen(datos, await textosDe(ctx)), 'cortesia_confirmar',
        { paso: 'confirmar', datos: { ...datos, intentos: 0 } },
        BOTONES_CONFIRMAR, 'Responde *Confirmar* o *Cambiar*.');
    return true;
}

function datosCompletos(d: DatosCortesia): boolean {
    return !!d.nombre && typeof d.edad === 'number' && (d.edad >= 18 || !!d.acudiente);
}

const PIDE_VER_MAS = new Set(['ver mas', 'mas', 'ver mas horarios', 'ver otros horarios', 'otros horarios',
    'otro horario', 'mas horarios', 'siguiente', 'otras', 'otros', 'volver al inicio']);

async function elegirFranja(
    ctx: CtxCortesia, d: Deps, datos: DatosCortesia, texto: string, botonId: string | null,
): Promise<boolean> {
    const franjas = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
    const n = normalizar(texto);

    if (botonId === BOTON_CC.VER_MAS || (!botonId && PIDE_VER_MAS.has(n))) {
        if (!franjas.length) return sinFranjasDisponibles(ctx);
        const total = datos.lista?.length ?? 0;
        const porPagina = total > MAX_FILAS ? MAX_FILAS - 1 : MAX_FILAS;
        await ofrecerFranjas(ctx, franjas, (datos.desde ?? 0) + porPagina, datos,
            'Estas son otras franjas:', 'cortesia_ofrecer');
        return true;
    }

    let elegidaId: string | null = null;
    if (botonId?.startsWith(BOTON_CC.FRANJA)) elegidaId = botonId.slice(BOTON_CC.FRANJA.length);
    else if (!botonId) {
        const num = leerNumeroOpcion(texto);
        if (num != null) elegidaId = datos.lista?.[num - 1] ?? null;
    }

    if (!elegidaId && !botonId) {
        if (!franjas.length) return sinFranjasDisponibles(ctx);
        // «ver todos»: sin filtro de perfil ni de día.
        const perfil = leerPerfil(texto);
        if (perfil?.todos) {
            await ofrecerFranjas(ctx, franjas, 0, { ...datos, perfil, dia: null },
                'Listo, estos son los horarios de *todos los grupos*:', 'cortesia_ofrecer');
            return true;
        }
        // «el sábado», «mejor los martes»: filtra por día (con el perfil que ya había).
        const dia = leerDia(texto);
        // «para mi hija de 8 años» dicho a mitad de la elección: se re-filtra.
        if (perfil || dia != null) {
            const nuevoPerfil = perfil ? { ...(datos.perfil ?? {}), ...perfil, todos: false } : datos.perfil ?? null;
            await ofrecerFranjas(ctx, franjas, 0,
                { ...datos, perfil: nuevoPerfil, dia: dia ?? datos.dia ?? null,
                    ...(datos.edad == null ? edadDelPerfil(nuevoPerfil) : {}) },
                'Listo. 👍', 'cortesia_ofrecer');
            return true;
        }
    }

    if (!elegidaId) {
        if (pareceOtraConversacion(texto) || esPreguntaDeOtroTema(texto) || !datos.lista?.length) return false;
        return reintentar(ctx, { paso: 'elegir_franja', datos },
            'Elige un horario de la lista o escríbeme su número (por ejemplo *2*). También puedes escribirme un día ' +
            '(*el sábado*) o *asesor* si prefieres hablar con una persona.');
    }

    const franja = franjas.find((f) => f.id === elegidaId);
    if (!franja) {
        // Se llenó, la cerraron o ya empieza en menos de 2 h entre la oferta y
        // el toque: se dice y se vuelve a ofrecer lo que haya de verdad AHORA.
        if (!franjas.length) return sinFranjasDisponibles(ctx);
        await ofrecerFranjas(ctx, franjas, 0, datos,
            'Uy, esa franja ya no está disponible. 😕 Estas siguen abiertas:', 'cortesia_ofrecer');
        return true;
    }

    const nuevos: DatosCortesia = { ...datos, franja, sinFranja: false, intentos: 0 };
    // Volvió a elegir tras un «se llenó»: ya tenemos sus datos, directo al resumen.
    if (datosCompletos(nuevos)) return confirmar(ctx, nuevos);
    await ctx.enviar(
        `Elegiste *${franja.grupo}* — ${fechaLegible(franja.fecha)}, ${horaLegible(franja.horaInicio)}. 👍\n\n` +
        '¿Cuál es el *nombre completo* de quien va a tomar la clase?',
        'cortesia_nombre', { paso: 'nombre', datos: nuevos });
    return true;
}

async function sinFranjasDisponibles(ctx: CtxCortesia): Promise<boolean> {
    const t = await textosDe(ctx);
    await ctx.enviar(
        `En este momento no quedan franjas de ${t.nombre} con cupo. 😕\n\n` +
        '¿Quieres dejarme tus datos para que la escuela te contacte y te agende?',
        'cortesia_sin_franjas', { paso: 'dejar_datos', datos: { sinFranja: true } },
        BOTONES_DATOS, 'Responde *Sí* para dejar tus datos o *No, gracias*.');
    return true;
}

async function reservar(ctx: CtxCortesia, d: Deps, datos: DatosCortesia): Promise<boolean> {
    if (!datos.nombre || typeof datos.edad !== 'number') {
        return pedirNombre(ctx, { franja: datos.franja, sinFranja: datos.sinFranja });
    }
    const franja = datos.sinFranja ? null : datos.franja ?? null;
    // La franja se eligió hace rato: si ya empezó (o empieza en menos de 2 h)
    // no se reserva. Dynasty 2026-10-07 (…4680): eligió la de las 4:00 p. m. a
    // las 9:23 a. m., confirmó a las 4:53 p. m. y quedó «reservada».
    // Solo la HORA: el cupo lo resuelve `submit_school_lead` con FOR UPDATE.
    if (franja && !filtrarVigentes([{ ...franja, cupos: 1 }], d.ahora).length) {
        const vigentes = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora);
        if (!vigentes.length) return sinFranjasDisponibles(ctx);
        await ofrecerFranjas(ctx, vigentes, 0, { ...datos, franja: null },
            'Uy, ese horario ya pasó o empieza muy pronto. 😕 Estas franjas siguen abiertas:', 'cortesia_franja_vencida');
        return true;
    }
    const r = await d.reservar({
        schoolId: ctx.schoolId,
        conversationId: ctx.conversationId,
        contactWaId: ctx.contactWaId,
        franjaId: franja?.id ?? null,
        nombre: datos.nombre,
        edad: datos.edad,
        fechaNacimiento: datos.fechaNacimiento ?? null,
        acudiente: datos.acudiente ?? null,
    });
    const base: Omit<AvisoCortesia, 'tipo'> = {
        schoolId: ctx.schoolId, conversationId: ctx.conversationId, contactWaId: ctx.contactWaId,
        nombre: datos.nombre, edad: datos.edad, acudiente: datos.acudiente ?? null, franja,
    };

    if (!r.ok) {
        if (r.motivo === 'lleno' || r.motivo === 'no_disponible') {
            // La carrera: dos familias por el último cupo. `submit_school_lead`
            // lo resolvió con FOR UPDATE; a quien perdió se le ofrece lo que
            // queda, conservando sus datos para no volver a preguntarlos.
            const quedan = filtrarVigentes(await d.franjas(ctx.schoolId), d.ahora)
                .filter((f) => f.id !== franja?.id);
            if (!quedan.length) return sinFranjasDisponibles(ctx);
            await ofrecerFranjas(ctx, quedan, 0, { ...datos, franja: null },
                'Uy, ese horario se acaba de llenar. 😕 Estas franjas siguen con cupo:', 'cortesia_cupo_lleno');
            return true;
        }
        await ctx.enviar(
            'No pude completar la reserva en este momento. 🙏 Ya le avisé a la escuela con tus datos para que te ' +
            'confirme el horario por aquí.', 'cortesia_error_reserva', null);
        void d.avisar({ ...base, tipo: 'no_reservada' }).catch(() => {});
        return true;
    }

    if (franja && r.duplicado && !r.conCupo) {
        // `submit_school_lead` deduplica por teléfono 24 h y en ese caso NO
        // toma el cupo. No se le dice «reservado» a quien no lo quedó.
        await ctx.enviar(
            'Ya tenía tus datos de hoy, así que le pedí a la escuela que te confirme el horario de la clase ' +
            `(${fechaLegible(franja.fecha)}, ${horaLegible(franja.horaInicio)}). Te responden por aquí. 🙌`,
            'cortesia_duplicado', null);
        void d.avisar({ ...base, leadId: r.leadId, tipo: 'no_reservada' }).catch(() => {});
        return true;
    }

    const t = await textosDe(ctx);
    if (!franja) {
        await ctx.enviar(
            `¡Listo! ✅ Pasé los datos de *${datos.nombre}* a la escuela. Te van a contactar por aquí para ` +
            `agendar la ${t.nombre}.`, 'cortesia_datos_dejados', null);
        void d.avisar({ ...base, leadId: r.leadId, tipo: 'datos' }).catch(() => {});
        return true;
    }

    const indicaciones = await d.indicaciones(ctx.schoolId).catch(() => null);
    await ctx.enviar(
        `✅ ¡Listo! Quedó reservada la ${t.nombre} de *${datos.nombre}*:\n\n${bloqueFranja(franja)}\n\n` +
        lineasDeCancha(franja) +
        lineasQueLlevar(indicaciones, t) +
        'Si no puedes ir, escríbeme *cancelar mi clase* para liberar el cupo.',
        'cortesia_reservada', null);
    void d.avisar({ ...base, leadId: r.leadId, tipo: 'reservada' }).catch(() => {});
    return true;
}

async function cancelarReserva(ctx: CtxCortesia, d: Deps, datos: DatosCortesia): Promise<boolean> {
    const r = await d.cancelar(ctx.schoolId, ctx.contactWaId);
    const base: Omit<AvisoCortesia, 'tipo'> = {
        schoolId: ctx.schoolId, conversationId: ctx.conversationId, contactWaId: ctx.contactWaId,
        nombre: datos.nombre ?? null, franja: datos.franja ?? null,
    };
    if (r.ok) {
        const f = r.franja ?? datos.franja ?? null;
        const t = await textosDe(ctx);
        await ctx.enviar(
            `Listo, cancelé tu ${t.nombre}` +
            (f ? ` del ${fechaLegible(f.fecha)} a las ${horaLegible(f.horaInicio)}` : '') +
            ` y el cupo quedó libre. Si quieres otra fecha, escríbeme *${t.nombre}*. 🙌`,
            'cortesia_cancelada', null);
        void d.avisar({ ...base, franja: f, tipo: 'cancelada' }).catch(() => {});
        return true;
    }
    if (r.motivo === 'sin_reserva') {
        await ctx.enviar('Ya no encuentro una clase reservada desde este número; puede que ya estuviera cancelada. 🤔',
            'cortesia_sin_reserva', null);
        return true;
    }
    // Sin la RPC (migración pendiente) o con error: lo cancela una persona.
    // NUNCA se toca el contador del cupo desde aquí.
    await ctx.enviar('Le pedí a la escuela que cancele tu clase y libere el cupo. Te confirman por aquí. 🙏',
        'cortesia_cancelacion_pedida', null);
    void d.avisar({ ...base, tipo: 'cancelacion_pedida' }).catch(() => {});
    return true;
}

// ─── Implementaciones con Supabase (por defecto) ───────────────────────────
// Todas atrapan sus errores: una falla de este módulo no puede dejar a la
// familia sin respuesta ni tumbar el turno del bot.

/** Estado = el payload del último saliente del bot (o del borrador pendiente). */
export async function leerEstadoDeSupabase(conversationId: string): Promise<EstadoCortesia | null> {
    try {
        const desde = new Date(Date.now() - VIGENCIA_FLUJO_CORTESIA_MS).toISOString();
        const [msg, borrador] = await Promise.all([
            supabase.from('whatsapp_messages')
                .select('payload, created_at')
                .eq('conversation_id', conversationId)
                .eq('direction', 'outbound')
                .gte('created_at', desde)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
            supabase.from('whatsapp_message_drafts')
                .select('tool_context, created_at')
                .eq('conversation_id', conversationId)
                .eq('status', 'pending')
                .gte('created_at', desde)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
        ]);
        const m = (msg as any)?.data;
        const b = (borrador as any)?.data;
        const ultimo = !m ? b?.tool_context
            : !b ? m.payload
            : (new Date(b.created_at) > new Date(m.created_at) ? b.tool_context : m.payload);
        if (!ultimo || ultimo.flujo !== FLUJO_CORTESIA || !ultimo.paso_cortesia) return null;
        return { paso: ultimo.paso_cortesia, datos: ultimo.datos_cortesia ?? {} };
    } catch {
        return null;
    }
}

/**
 * ¿Ya salió una lista de horarios de cortesía (paso `elegir_franja`) en las
 * últimas 24 h? Entonces no se repite: se ofrece reservar. Nunca lanza.
 */
export async function listadoDeHorariosReciente(conversationId: string, horas = 24): Promise<boolean> {
    try {
        const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();
        const { count } = await supabase.from('whatsapp_messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conversationId)
            .eq('direction', 'outbound')
            .eq('payload->>paso_cortesia', 'elegir_franja')
            .gte('created_at', desde);
        return (count ?? 0) > 0;
    } catch {
        return false;
    }
}

async function slugDeEscuela(schoolId: string): Promise<string | null> {
    const { data } = await supabase.from('schools').select('slug').eq('id', schoolId).maybeSingle();
    return (data as any)?.slug ?? null;
}

function aFranja(r: any): FranjaCortesia {
    return {
        id: String(r.id),
        grupo: String(r.label ?? 'Clase de cortesía'),
        fecha: String(r.slot_date).slice(0, 10),
        horaInicio: String(r.start_time).slice(0, 5),
        horaFin: r.end_time ? String(r.end_time).slice(0, 5) : null,
        sede: r.location ?? null,
        cupos: Number(r.spots_left ?? 0),
    };
}

/**
 * Dirección de la sede: la de la sede registrada (school_branches) cuyo nombre
 * coincide con el lugar de la franja («Coliseo Dynasty» ↔ «Coliseo Dynasty DC»).
 * Sin coincidencia → null: no se inventa una dirección.
 * Compara por «contiene»: sirve para la SEDE, no para las canchas («Pinar» ↔
 * «Pinar 2»). La cancha se busca antes con `direccionDeLugar` (exacta).
 */
export function direccionDeSede(sede: string | null, sedes: { name: string | null; address: string | null }[]): string | null {
    const s = normalizar(sede);
    if (!s) return null;
    for (const b of sedes) {
        const n = normalizar(b.name);
        const dir = String(b.address ?? '').trim();
        if (n.length >= 4 && dir && (s.includes(n) || n.includes(s))) return dir;
    }
    return null;
}

/**
 * Las mismas franjas que ve el formulario /inscripcion/<slug> (mismos filtros
 * que `list_open_trial_slots_public`: abiertas, desde hoy, con cupo), pero
 * SIN su tope de 20: con franjas generadas de los entrenamientos (~40 por
 * semana en Dynasty) las 20 más cercanas son 2–3 días, y al filtrar por grupo
 * quedaban 1 o 2 opciones. Suma el rango de edad del equipo y la dirección de
 * la sede. Si la lectura directa falla, cae a la RPC pública de siempre.
 *
 * Desde la migración M1 (2026-10-30), y sin cambiar nada donde no hay datos:
 *   · solo los días de `dias_semana` (si la escuela los puso);
 *   · sin las sesiones que el profe canceló o movió en «Mi semana»
 *     (`team_schedule_exceptions`; la movida al mismo horario cambia el lugar).
 *     Red de seguridad: el generador ya no las crea, pero corre una vez al día;
 *   · sin los equipos con `recibe_clase_prueba = false`;
 *   · sede, profes, años, y dirección/Maps/indicaciones de la cancha
 *     (`facilities`, coincidencia exacta con `direccionDeLugar`; si el horario
 *     no dice el lugar, la cancha del equipo; si no, la sede como antes).
 */
export async function franjasDeSupabase(schoolId: string): Promise<FranjaCortesia[]> {
    // Configuración única de clases de prueba (mig. 20261026155701): con el
    // interruptor general o el de WhatsApp apagado, el bot no ofrece cupos
    // (el prospecto se sigue guardando). Sin fila = prendido, como siempre.
    // `dias_semana` llega con M1: si la columna no existe se lee como antes.
    let diasSemana: number[] | null = null;
    try {
        let r: any = await supabase.from('school_trial_class_settings')
            .select('enabled, whatsapp_enabled, dias_semana').eq('school_id', schoolId).maybeSingle();
        if (r?.error) {
            r = await supabase.from('school_trial_class_settings')
                .select('enabled, whatsapp_enabled').eq('school_id', schoolId).maybeSingle();
        }
        const cfg = r?.data;
        if (cfg && (cfg.enabled === false || cfg.whatsapp_enabled === false)) return [];
        diasSemana = diasSemanaValidos(cfg?.dias_semana);
    } catch { /* sin config legible: se comporta como antes */ }
    try {
        const hoy = hoyBogota(new Date()).iso;
        const { data, error } = await supabase.from('school_trial_slots')
            .select('id, label, slot_date, start_time, end_time, location, max_capacity, reserved_count, team_id')
            .eq('school_id', schoolId)
            .eq('is_open', true)
            .gte('slot_date', hoy)
            .order('slot_date', { ascending: true })
            .order('start_time', { ascending: true })
            .limit(300);
        if (!error && Array.isArray(data) && data.length) {
            const filas = (data as any[]).filter((r) => Number(r.reserved_count ?? 0) < Number(r.max_capacity ?? 0));
            const ultima = filas.reduce((m, r) => (String(r.slot_date).slice(0, 10) > m ? String(r.slot_date).slice(0, 10) : m), hoy);
            // Rango de edad y género de cada grupo: equipo → categoría → edades
            // reales de sus atletas activos → año en el nombre (cacheado 1 h).
            const [rangos, sedes, lugares, excepciones] = await Promise.all([
                rangosDeEscuela(schoolId).catch(() => [] as RangoGrupo[]),
                supabase.from('school_branches').select('name, address').eq('school_id', schoolId).limit(50),
                lugaresDeEscuela(schoolId).catch(() => [] as LugarDeEscuela[]),
                excepcionesDeEscuela(schoolId, hoy, ultima).catch(() => [] as ExcepcionSemana[]),
            ]);
            const edades = new Map<string, RangoGrupo>(rangos.map((t) => [t.teamId, t]));
            const listaSedes = (((sedes as any)?.data ?? []) as any[]);
            const salida: FranjaCortesia[] = [];
            for (const r of filas) {
                const fecha = String(r.slot_date).slice(0, 10);
                if (diasSemana && !diasSemana.includes(diaDeLaSemana(fecha))) continue;
                const t = r.team_id ? edades.get(r.team_id) : null;
                if (t?.recibeClasePrueba === false) continue;
                const ajuste = r.team_id
                    ? ajusteDeSesion(excepciones.filter((e) => e.team_id === r.team_id), fecha, String(r.start_time))
                    : null;
                const f = aFranja({ ...r, spots_left: Number(r.max_capacity) - Number(r.reserved_count ?? 0) });
                if (ajuste?.tipo === 'cancelada') continue;
                if (ajuste?.tipo === 'movida' && ajuste.inicio !== f.horaInicio) continue;
                salida.push(enriquecerFranja(f, {
                    teamId: r.team_id ?? null, rango: t ?? null, lugares, sedes: listaSedes,
                    lugarMovido: ajuste?.tipo === 'movida' ? ajuste.lugar : null,
                }));
            }
            return salida;
        }
    } catch { /* cae a la RPC */ }
    try {
        const slug = await slugDeEscuela(schoolId);
        if (!slug) return [];
        const { data, error } = await supabase.rpc('list_open_trial_slots_public', { p_slug: slug });
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map(aFranja);
    } catch {
        return [];
    }
}

/**
 * La franja con lo que se sabe de su grupo y de su cancha. Pura.
 *   · lugar: el de «Mi semana» si la sesión se movió de cancha; si no, el de la franja.
 *   · cancha: `direccionDeLugar` (exacta). Si la franja no dice lugar, la cancha
 *     del equipo (`teams.facility_id`) cuando tiene dirección o Maps.
 *   · dirección: la de la cancha; si no tiene, la de la sede como siempre.
 */
export function enriquecerFranja(f: FranjaCortesia, c: {
    teamId: string | null;
    rango: RangoGrupo | null;
    lugares: LugarDeEscuela[];
    sedes: { name: string | null; address: string | null }[];
    lugarMovido?: string | null;
}): FranjaCortesia {
    let sede = c.lugarMovido || f.sede;
    let cancha = direccionDeLugar(sede, c.lugares);
    if (!sede && c.rango?.facilityId) {
        const delEquipo = c.lugares.find((l) => l.id === c.rango!.facilityId);
        if (delEquipo && (delEquipo.direccion || delEquipo.mapsUrl)) {
            sede = delEquipo.nombre;
            cancha = direccionDeLugar(delEquipo.nombre, [delEquipo]);
        }
    }
    const t = c.rango;
    return {
        ...f,
        sede,
        teamId: c.teamId,
        edadMin: t?.edadMin ?? null,
        edadMax: t?.edadMax ?? null,
        edadFuente: t?.fuenteEdad ?? null,
        generoGrupo: t?.genero ?? null,
        direccion: cancha?.direccion ?? direccionDeSede(sede, c.sedes),
        branchId: t?.branchId ?? null,
        coachIds: t?.coachIds ?? [],
        coaches: t?.coachNombres ?? [],
        anioMin: t?.anioMin ?? null,
        anioMax: t?.anioMax ?? null,
        mapsUrl: cancha?.mapsUrl ?? null,
        indicacionesLugar: cancha?.indicaciones ?? null,
    };
}

/**
 * El teléfono con que se guarda el prospecto: el celular colombiano de 10
 * dígitos, igual que lo escribe la gente en el formulario. Así el dedupe de
 * 24 h de `submit_school_lead` y la búsqueda de la escuela cruzan. Un número
 * extranjero va completo (`+<dígitos>`): sus últimos 10 pueden ser el celular
 * de otra persona (auditoría de privacidad 2026-10-08).
 */
function telefonoDelLead(waId: string): string {
    const d = String(waId ?? '').replace(/\D/g, '');
    return celular10(d) ?? `+${d}`;
}

export async function reservaVigenteDeSupabase(schoolId: string, contactWaId: string): Promise<ReservaVigente | null> {
    try {
        const digitos = String(contactWaId ?? '').replace(/\D/g, '');
        if (digitos.length < 10) return null;
        const t10 = celular10(digitos);
        const variantes = t10
            ? [...new Set([t10, `57${t10}`, `+57${t10}`, digitos, `+${digitos}`])]
            : [digitos, `+${digitos}`];
        const { data, error } = await supabase.from('school_signup_leads')
            .select('id, full_name, created_at, school_trial_slots(id, label, slot_date, start_time, end_time, location)')
            .eq('school_id', schoolId)
            .in('phone', variantes)
            .in('status', ['new', 'contacted', 'converted'])
            .not('trial_slot_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(5);
        if (error || !Array.isArray(data)) return null;
        const hoy = hoyBogota(new Date()).iso;
        for (const l of data as any[]) {
            const s = Array.isArray(l.school_trial_slots) ? l.school_trial_slots[0] : l.school_trial_slots;
            if (s && String(s.slot_date).slice(0, 10) >= hoy) {
                return { leadId: l.id, nombre: l.full_name, franja: aFranja({ ...s, spots_left: 0 }) };
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** Reserva con `submit_school_lead`: la misma RPC (y el mismo candado) del formulario. */
export async function reservarEnSupabase(p: ParamsReserva): Promise<ResultadoReserva> {
    try {
        const slug = await slugDeEscuela(p.schoolId);
        if (!slug) return { ok: false, motivo: 'error' };
        // El lead SIN cupo de este número (el que dejó la puerta de prospecto o
        // el formulario) es el que se agenda: una fila por escuela + teléfono.
        // La RPC toma el cupo con otro formato del mismo número (su dedupe de
        // 24 h compara el texto exacto y devolvería «duplicado» SIN reservar) y
        // después el cupo pasa a esa fila (`fusionarReservaEnLead`). Antes se
        // BORRABA el lead del bot y, pasadas 24 h, quedaban dos (embudo 10-08).
        const previo = await leadSinCupoParaReserva(p.schoolId, p.contactWaId);
        if (!previo) await liberarLeadParaReserva(p.schoolId, p.contactWaId);
        const { data, error } = await supabase.rpc('submit_school_lead', {
            p_slug: slug,
            p_full_name: p.nombre,
            p_phone: previo ? telefonoAlterno(previo.phone) : telefonoDelLead(p.contactWaId),
            p_email: null,
            p_gender: null,
            p_birth_date: p.fechaNacimiento,
            p_guardian_name: p.acudiente,
            p_how_heard: 'whatsapp',
            p_notes: `Agendada por el asistente de WhatsApp. Edad informada: ${p.edad} años.`,
            p_source_detail: { canal: 'whatsapp', conversation_id: p.conversationId },
            p_website: null,
            p_trial_slot_id: p.franjaId,
        });
        if (error) {
            const msg = normalizar(error.message);
            if (/llen/.test(msg)) return { ok: false, motivo: 'lleno' };
            if (/no esta disponible|no existe/.test(msg)) return { ok: false, motivo: 'no_disponible' };
            console.error('[wa-cortesia] submit_school_lead falló', { err: error.message });
            return { ok: false, motivo: 'error' };
        }
        const r = (data ?? {}) as any;
        let leadId = r.lead_id ?? null;
        if (previo && leadId && !r.duplicate) leadId = await fusionarReservaEnLead(previo.id, leadId);
        let conCupo = !r.duplicate;
        if (r.duplicate && p.franjaId && leadId) {
            const { data: lead } = await supabase.from('school_signup_leads')
                .select('trial_slot_id').eq('id', leadId).maybeSingle();
            conCupo = (lead as any)?.trial_slot_id === p.franjaId;
        }
        return { ok: true, leadId, duplicado: !!r.duplicate, conCupo };
    } catch (e: any) {
        console.error('[wa-cortesia] reservar explotó', { err: e?.message });
        return { ok: false, motivo: 'error' };
    }
}

export async function cancelarEnSupabase(schoolId: string, contactWaId: string): Promise<ResultadoCancelacion> {
    try {
        const { data, error } = await supabase.rpc('wa_cancelar_clase_de_prueba', {
            p_school_id: schoolId, p_phone: contactWaId,
        });
        if (error) {
            // PGRST202 / 42883: la migración 20261006082002 todavía no está aplicada.
            const sinRpc = (error as any).code === 'PGRST202' || (error as any).code === '42883'
                || /could not find the function/i.test(error.message);
            if (!sinRpc) console.error('[wa-cortesia] wa_cancelar_clase_de_prueba falló', { err: error.message });
            return { ok: false, motivo: sinRpc ? 'sin_rpc' : 'error' };
        }
        const r = (data ?? {}) as any;
        if (!r.ok) return { ok: false, motivo: r.reason === 'sin_reserva' ? 'sin_reserva' : 'error' };
        return { ok: true, franja: r.slot_date ? aFranja({ ...r, id: r.lead_id, spots_left: 0 }) : null };
    } catch {
        return { ok: false, motivo: 'error' };
    }
}

/**
 * Aviso a owner/admins por reserva, datos dejados o cancelación: in-app +
 * push + correo, idempotente en la base entre los tres BFF. Vive en
 * cortesia-reservas.service (que además lista las reservas para la pestaña
 * «Clases de cortesía» y el resumen de las 7). Import dinámico: ese módulo
 * importa los tipos de este y así no hay ciclo al cargar. Nunca lanza.
 */
export async function avisarEscuelaCortesia(a: AvisoCortesia): Promise<void> {
    try {
        const { avisarCortesia } = await import('./cortesia-reservas.service');
        await avisarCortesia(a);
    } catch (e: any) {
        console.warn('[wa-cortesia] no se pudo avisar a la escuela', { err: e?.message });
    }
}
