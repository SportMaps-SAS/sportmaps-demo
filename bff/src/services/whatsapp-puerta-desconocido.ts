/**
 * whatsapp-puerta-desconocido — La puerta única del contacto que el teléfono NO
 * reconoce (conversación v2, Dynasty 2026-10-24; spec
 * docs/specs/whatsapp-conversacion-v2-dynasty.md §3.1 y §3.2).
 *
 * El bot decidía «¿es de la escuela?» con cientos de expresiones regulares y, si
 * no sabía, asumía que era familia: «Si eres familia de un atleta… escríbeme el
 * correo». Una persona nueva («papá de Sofía para información») recibía eso. Ahora
 * el comodín es UNA pregunta con tres botones:
 *
 *     Hola 👋 Soy el asistente de *Dynasty*. ¿Qué necesitas?
 *     [Ya soy del club] [Quiero información] [Otro tema]
 *
 *  - Ya soy del club → pide el NOMBRE del deportista (no el correo; el OTP por
 *    correo sigue como camino alterno) y deja la conversación en el buzón con ese
 *    dato. Nunca se muestra nada de la ficha antes de verificar.
 *  - Quiero información → mini-registro: máximo 4 respuestas, una por mensaje
 *    (deportista, edad, acudiente, qué quiere). Al final el lead queda COMPLETO
 *    y la persona recibe el grupo, los valores y el enlace de inscripción.
 *  - Otro tema → buzón con aviso a la escuela, sin más preguntas.
 *
 * El estado viaja en el payload del último saliente del bot (igual que la clase
 * de cortesía): `flujo` / `paso_puerta` / `datos_puerta`. Un mensaje terminal no
 * lleva `flujo`, y con eso el flujo queda cerrado.
 *
 * El motor no habla con la base ni con Meta: todo entra por `CtxPuerta`
 * (inyectable en pruebas). Las lecturas de texto son puras.
 *
 * Ofertas y clase de prueba por fecha (bot-ofertas, Monster 2026-11-25): si hoy
 * no hay clase de prueba, «¿Qué quieres hacer?» no muestra «Clase de cortesía»;
 * si hay ofertas vigentes (convocatorias…) muestra su botón, que responde con
 * `textoOfertasParaPersona` y pregunta a cuál fecha quiere ir; con la respuesta,
 * la escuela recibe el aviso y la conversación queda pendiente de ella. Con la
 * clase disponible, los botones de siempre.
 *
 * Convocatoria guiada (Monster 2026-11-25, flujo oficial de la escuela): si la
 * escuela configuró `preguntasOfertas`, el bot pregunta UNA cosa a la vez con
 * botones o lista (género, año, trayectoria, sede: `siguientePreguntaOferta`),
 * muestra SOLO la oferta que le aplica y ofrece [Quiero inscribirme] [Cómo es la
 * evaluación] [Hablar con alguien]; la inscripción pide el nombre y la fecha (lista)
 * y queda pendiente de la escuela (`iniciarConvocatoria`, paso 'oferta').
 * Sin preguntas configuradas, todo sigue como antes.
 */

import type { BotonInteractivo } from './whatsapp.service';
import { supabase } from '../config/supabase';
import { leerEdad, nombreValido, normalizar } from './whatsapp-clase-cortesia.service';
import {
    estadoDeOfertas, textoOfertasParaPersona, textoDeOfertas, filtrarPorGenero,
    introDeOfertas, siguientePreguntaOferta, aplicarRespuestaOferta, opcionesDeFechas, fechaLegible, rangoLegible,
    ID_OFERTA, DATOS_OFERTA_VACIOS, precioConPromo, lineaDeValor, finDePromoLegible,
    type EstadoOfertas, type TipoOferta, type OfertaBot, type DatosOferta, type PasoOferta, type OpcionOferta,
} from './bot-ofertas.service';
import { etiquetaDeOfertas } from './whatsapp-bienvenida';

export const FLUJO_PUERTA = 'puerta_desconocido';

/** Vigencia del flujo: pasado este tiempo la persona vuelve a empezar. */
export const VIGENCIA_FLUJO_PUERTA_MS = 24 * 60 * 60 * 1000;

/**
 * step de la pregunta con botones. Se conserva el nombre histórico del comodín
 * («ask_email») a propósito: lo leen la retoma, las métricas del buzón, el freno de
 * 24 h y las pruebas; la pregunta nueva ocupa el mismo lugar de la vieja.
 */
export const PASO_PUERTA_MENU = 'ask_email';

export const BOTON_PUERTA = {
    CLUB: 'sm_pd_club',
    INFO: 'sm_pd_info',
    OTRO: 'sm_pd_otro',
    SOY: 'sm_pd_soy',
    OTRO_NOMBRE: 'sm_pd_otro_nombre',
    CORTESIA: 'sm_pd_cortesia',
    INSCRIBIRME: 'sm_pd_inscribirme',
    PRECIOS: 'sm_pd_precios',
    /** Las ofertas vigentes (convocatorias…), en lugar de la clase cuando hoy no hay. */
    OFERTAS: 'sm_pd_ofertas',
} as const;

export function esBotonPuerta(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_pd_');
}

/** Botones y filas de la convocatoria guiada (bot-ofertas: todos empiezan con `of_`). */
export function esBotonOferta(id: string | null | undefined): boolean {
    return !!id && id.startsWith('of_');
}

/** Títulos ≤ 20 caracteres (límite de Meta). */
export const BOTONES_PUERTA: BotonInteractivo[] = [
    { id: BOTON_PUERTA.CLUB, title: 'Ya soy del club' },
    { id: BOTON_PUERTA.INFO, title: 'Quiero información' },
    { id: BOTON_PUERTA.OTRO, title: 'Otro tema' },
];
const BOTONES_QUIERE: BotonInteractivo[] = [
    { id: BOTON_PUERTA.CORTESIA, title: 'Clase de cortesía' },
    { id: BOTON_PUERTA.INSCRIBIRME, title: 'Inscribirme' },
    { id: BOTON_PUERTA.PRECIOS, title: 'Solo precios' },
];

export const ENTEXTO_PUERTA = 'Responde *Ya soy del club*, *Quiero información* u *Otro tema*.';
const ENTEXTO_QUIERE = 'Responde *Clase de cortesía*, *Inscribirme* o *Solo precios*.';

/** Lo que la puerta usa de bot-ofertas (`estadoDeOfertas`). */
export type OfertasDePuerta = EstadoOfertas;

/**
 * Los botones de «¿Qué quieres hacer?». Con la clase de prueba disponible (o sin
 * estado), los de siempre. Sin clase hoy: el botón de las ofertas vigentes (por su
 * tipo: «Convocatorias») si hay, «Inscribirme» y «Solo precios». Pura.
 */
export function botonesQueQuiere(ofertas?: OfertasDePuerta | null): { botones: BotonInteractivo[]; enTexto: string } {
    if (!ofertas || ofertas.claseDePrueba.disponible) return { botones: BOTONES_QUIERE, enTexto: ENTEXTO_QUIERE };
    const etiqueta = etiquetaDeOfertas(ofertas.ofertas);
    const botones: BotonInteractivo[] = [
        ...(etiqueta ? [{ id: BOTON_PUERTA.OFERTAS, title: etiqueta.boton.slice(0, 20) }] : []),
        { id: BOTON_PUERTA.INSCRIBIRME, title: 'Inscribirme' },
        { id: BOTON_PUERTA.PRECIOS, title: 'Solo precios' },
    ];
    const enTexto = `Responde ${botones.map((b) => `*${b.title}*`).join(', ').replace(/, ([^,]*)$/, ' o $1')}.`;
    return { botones, enTexto };
}

export type PasoPuerta = 'menu' | 'club_nombre' | 'info_nombre' | 'info_edad' | 'info_acudiente' | 'info_quiere'
    /** Ya vio las ofertas: falta a cuál fecha quiere ir. */
    | 'info_oferta'
    /** Convocatoria guiada: una pregunta a la vez con botones (`datos.ultimoPaso` dice cuál). */
    | 'oferta';
/** En qué va la convocatoria guiada: una pregunta de bot-ofertas, o los pasos de la inscripción. */
export type PasoConvocatoria = PasoOferta | 'accion' | 'elegir_oferta' | 'nombre' | 'fecha';
export type QueQuiere = 'cortesia' | 'inscribirme' | 'precios' | 'ofertas';

export interface DatosPuerta {
    deportista?: string;
    edad?: number;
    fechaNacimiento?: string | null;
    acudiente?: string;
    /** Nombre del perfil de WhatsApp: el botón «Soy {nombre}» lo usa. */
    nombrePerfil?: string | null;
    /** Pidió escribir otro nombre de acudiente. */
    otroAcudiente?: boolean;
    grupoSugerido?: string | null;
    quiere?: QueQuiere;
    intentos?: number;
    /** Convocatoria guiada: lo que va respondiendo (bot-ofertas). */
    oferta?: DatosOferta;
    /** La última pregunta que se le hizo en la convocatoria guiada. */
    ultimoPaso?: PasoConvocatoria;
    /** Cómo eligió su año («2013 a 2014»), para el aviso a la escuela. */
    anioTexto?: string | null;
    /** Las ofertas que se le mostraron (ids) y la que eligió para inscribirse. */
    mostradas?: string[];
    ofertaId?: string | null;
}

export interface EstadoPuerta { paso: PasoPuerta; datos: DatosPuerta }

/** Lo que queda en `school_signup_leads` al terminar el mini-registro. */
export interface LeadCompleto {
    deportista: string;
    fechaNacimiento: string | null;
    edad: number | null;
    acudiente: string | null;
    grupoSugerido: string | null;
    /** Con las ofertas, su tipo («convocatoria»; «oferta» si son de varios tipos). */
    quiere: Exclude<QueQuiere, 'ofertas'> | TipoOferta | 'oferta' | null;
}

export interface GrupoSugerido { linea: string | null; nombre: string | null }

export interface CtxPuerta {
    conversationId: string;
    schoolId: string;
    contactWaId: string;
    /** Envía un mensaje. `estado` null = terminal (cierra el flujo). */
    enviar: (texto: string, step: string, estado: EstadoPuerta | null,
        botones?: BotonInteractivo[], enTexto?: string, contexto?: Record<string, unknown>,
        /** `textoLista`: el botón que abre la lista (más de 3 opciones). */
        opciones?: { textoLista?: string }) => Promise<void>;
    /** Deja la conversación en el buzón y avisa a la escuela (push + correo con freno). */
    avisarEscuela: (motivo: 'club' | 'otro' | 'prospecto_sin_enlace', detalle: string | null) => Promise<void>;
    /** Nombre del perfil de WhatsApp (botón «Soy {nombre}»). */
    nombrePerfil?: () => Promise<string | null>;
    /** Edad dicha en mensajes anteriores (7 días): no se vuelve a preguntar. */
    edadPrevia?: () => Promise<number | null>;
    guardarLead: (lead: LeadCompleto) => Promise<void>;
    grupoPara: (edad: number) => Promise<GrupoSugerido>;
    precios: (edad: number | null) => Promise<string | null>;
    enlace: () => Promise<string | null>;
    /** Clase de cortesía: arranca el flujo existente con lo que ya se sabe. */
    cortesia: (datos: DatosPuerta, encabezado: string) => Promise<void>;
    /**
     * Qué se puede ofrecer hoy (bot-ofertas). Sin él se lee `estadoDeOfertas(schoolId)`
     * (caché de 60 s, falla cerrado para la clase de prueba). Pruebas: se inyecta.
     */
    ofertas?: () => Promise<OfertasDePuerta>;
    leerEstado?: (conversationId: string) => Promise<EstadoPuerta | null>;
    /**
     * Estado de la convocatoria guiada aunque el bot haya contestado otra cosa después
     * (una pregunta a mitad del flujo): con él, un botón `of_…` tocado más tarde sigue valiendo.
     */
    leerEstadoDeOferta?: (conversationId: string) => Promise<EstadoPuerta | null>;
    ahora?: () => Date;
}

/**
 * El estado de ofertas del turno. Nunca lanza: `estadoDeOfertas` falla cerrado (sin
 * clase de prueba) si no puede leer; null solo si la función inyectada lanza.
 */
async function ofertasDePuerta(ctx: CtxPuerta): Promise<OfertasDePuerta | null> {
    return seguro(() => (ctx.ofertas ? ctx.ofertas() : estadoDeOfertas(ctx.schoolId)));
}

// ─── Textos ─────────────────────────────────────────────────────────────────

/** La pregunta de la puerta. `saludo`: la presentación de 24 h (vacío si ya se presentó). */
export function mensajeDePuerta(saludo: string): { texto: string; botones: BotonInteractivo[]; enTexto: string } {
    return {
        texto: (saludo ? `${saludo}\n\n` : '') + '¿Qué necesitas?',
        botones: BOTONES_PUERTA,
        enTexto: ENTEXTO_PUERTA,
    };
}

const primerNombre = (n: string) => n.trim().split(/\s+/)[0] ?? n;
const titulo = (n: string) => n.toLocaleLowerCase('es-CO').replace(/(^|\s)\S/g, (c) => c.toLocaleUpperCase('es-CO'));

// ─── Lectura de respuestas (pura) ───────────────────────────────────────────

export type OpcionDePuerta = 'club' | 'info' | 'otro';

/**
 * ¿Eligió una opción de la puerta? Por id, o escribiendo el título tal cual (el
 * modo asistido manda el texto sin botones). Comparación contra el mensaje
 * COMPLETO: «quiero información sobre el torneo» no es el botón. Pura.
 */
export function leerOpcionDePuerta(texto: string | null | undefined, botonId: string | null = null): OpcionDePuerta | null {
    if (botonId === BOTON_PUERTA.CLUB) return 'club';
    if (botonId === BOTON_PUERTA.INFO) return 'info';
    if (botonId === BOTON_PUERTA.OTRO) return 'otro';
    const n = normalizar(texto);
    if (!n) return null;
    if (/^(ya )?soy (del |de la |parte del |parte de la )?(club|escuela|academia|familia)$|^ya (soy|estoy) (inscrit[oa]|del club|en el club)$/.test(n)) return 'club';
    if (/^(quiero )?(mas )?(informacion|info)$|^quiero (mas )?info(rmacion)?$/.test(n)) return 'info';
    if (/^otro( tema)?$|^otra cosa$/.test(n)) return 'otro';
    return null;
}

/**
 * ¿Qué quiere hacer? Por botón o por palabra. `o.etiqueta`: el título del botón de
 * ofertas (el modo asistido lo manda como texto); con `o.hayOfertas`, «convocatoria»
 * escrito también es 'ofertas'. Pura.
 */
export function leerQueQuiere(
    texto: string | null | undefined, botonId: string | null = null,
    o: { hayOfertas?: boolean; etiqueta?: string | null } = {},
): QueQuiere | null {
    if (botonId === BOTON_PUERTA.CORTESIA) return 'cortesia';
    if (botonId === BOTON_PUERTA.INSCRIBIRME) return 'inscribirme';
    if (botonId === BOTON_PUERTA.PRECIOS) return 'precios';
    if (botonId === BOTON_PUERTA.OFERTAS) return 'ofertas';
    const n = normalizar(texto);
    if (!n) return null;
    if (/\bsolo (los )?(precios?|valores?)\b/.test(n)) return 'precios';
    if (o.hayOfertas && ((o.etiqueta && n === normalizar(o.etiqueta))
        || /\b(convocatorias?|pruebas? (para|de) (entrar|ingreso|ingresar|seleccion)|tryouts?|proximas fechas)\b/.test(n))) return 'ofertas';
    if (/\b(cortesia|prueba|probar|conocer|gratis)\b/.test(n)) return 'cortesia';
    if (/\b(inscrib\w*|matricul\w*|inscripcion)\b/.test(n)) return 'inscribirme';
    if (/\b(precios?|valores?|costos?|cuanto|tarifas?|solo precios)\b/.test(n)) return 'precios';
    return null;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const EVASIVA = /^(no|ni|ya|nada|luego|despues|ahora|mas tarde|ok|okey|gracias|mmm+|jaja+|aja|bueno|vale|dale)\b|\b(no se|ni idea|no recuerdo|ya le digo|ya te digo|no tengo)\b/;
const PREFIJOS_DE_NOMBRE = /^(?:(?:mi|el|la|su)\s+(?:hij[oa]|nin[oa]|sobrin[oa]|nieto|nieta|deportista|atleta)\s+)?(?:(?:se llama|se llaman|es|se chama)\s+)?/i;

/**
 * Nombre del deportista (y, si lo dijo en el mismo mensaje, su edad o fecha de
 * nacimiento): «Sofía Gómez Uribe», «mi hija se llama Sofía, tiene 9 años»,
 * «Sofía Gómez 15/03/2014». Máximo 5 palabras de nombre: una frase no es un
 * nombre. null si no hay un nombre válido. Pura.
 */
export function leerNombreDeDeportista(
    texto: string | null | undefined, ahora: Date = new Date(),
): { nombre: string; edad?: number; fechaNacimiento?: string | null } | null {
    let t = String(texto ?? '').replace(/\s+/g, ' ').trim();
    if (!t || EMAIL.test(t)) return null;
    let edad: number | undefined;
    let fechaNacimiento: string | null | undefined;
    const fecha = t.match(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{4}\b|\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b/);
    const anos = t.match(/\b(?:tiene |de |con )?(\d{1,2})\s*(?:años|anos|año|ano)\b/i);
    if (fecha) {
        const e = leerEdad(fecha[0], ahora);
        if (e) { edad = e.edad; fechaNacimiento = e.fechaNacimiento; }
        t = t.replace(fecha[0], ' ');
    } else if (anos) {
        const e = Number(anos[1]);
        if (e >= 3 && e <= 90) edad = e;
        t = t.replace(anos[0], ' ');
    }
    t = t.replace(/[,;]+/g, ' ').replace(/\b(y|con|de|tiene|tengo|edad)\s*$/i, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(PREFIJOS_DE_NOMBRE, '').trim();
    if (t.split(' ').length > 5) return null;
    // «no sé», «ya le digo», «mmm», «luego»: una evasiva no es un nombre.
    if (EVASIVA.test(normalizar(t))) return null;
    const nombre = nombreValido(t);
    return nombre ? { nombre, ...(edad != null ? { edad, fechaNacimiento: fechaNacimiento ?? null } : {}) } : null;
}

/**
 * Dos (o más) deportistas en UN mensaje: «Valeria Pardo Rojas y Camila Pardo Rojas».
 * Cada uno con nombre y apellido (2+ palabras): «Juan y Pedro Gómez» no cuenta, porque «Juan»
 * solo no es un nombre completo. null si no son varios. Pura. Monster 2026-11-09: el embudo
 * contestó «no alcancé a leer el nombre» y después tomó solo a la primera.
 */
export function leerVariosDeportistas(texto: string | null | undefined): string[] | null {
    const t = String(texto ?? '').replace(/\s+/g, ' ').trim();
    if (!t || EMAIL.test(t) || /[0-9?¿]/.test(t)) return null;
    const partes = t.split(/\s+(?:y|e)\s+|\s*[&+/;]\s*/i).map((s) => s.trim()).filter(Boolean);
    if (partes.length < 2 || partes.length > 4) return null;
    const nombres = partes.map((p) => leerNombreDeDeportista(p)?.nombre ?? null);
    if (nombres.some((n) => !n || n.split(' ').length < 2)) return null;
    return nombres as string[];
}

// ─── Motor ──────────────────────────────────────────────────────────────────

/** Máximo de veces que se repite una pregunta que no se entendió. */
const MAX_INTENTOS = 2;

/** Arranca la puerta: UNA pregunta con tres botones. `saludo`: presentación de 24 h o ''. */
export async function iniciarPuerta(ctx: CtxPuerta, saludo: string): Promise<void> {
    const m = mensajeDePuerta(saludo);
    await ctx.enviar(m.texto, PASO_PUERTA_MENU, { paso: 'menu', datos: {} }, m.botones, m.enTexto);
}

/**
 * Turno de la puerta. true = lo resolvió este módulo. false = no era para acá:
 * sin flujo abierto, o texto libre en la pregunta de los botones (se aplican las
 * reglas de siempre), o un correo (arranca el OTP, camino alterno).
 */
export async function atenderTurnoPuerta(ctx: CtxPuerta, textoCrudo: string, botonId: string | null): Promise<boolean> {
    const texto = (textoCrudo || '').trim();
    let estado = await (ctx.leerEstado ?? leerEstadoDePuertaDeSupabase)(ctx.conversationId);
    // Un botón de la convocatoria guiada tocado después de que el bot contestó otra cosa: el estado de la convocatoria.
    if (esBotonOferta(botonId) && estado?.paso !== 'oferta') {
        estado = await (ctx.leerEstadoDeOferta ?? leerEstadoDeOfertaDeSupabase)(ctx.conversationId) ?? estado;
    }
    if (estado?.paso === 'oferta') {
        // Con la convocatoria abierta, sus botones van a ella; los de otro flujo se sueltan.
        if (botonId && !esBotonOferta(botonId) && !esBotonPuerta(botonId)) return false;
        if (!esBotonOferta(botonId) && leerOpcionDePuerta(texto, botonId)) return elegirOpcion(ctx, leerOpcionDePuerta(texto, botonId)!);
        if (!botonId && /\b(asesor|una persona|hablar con (alguien|una persona|la escuela)|humano)\b/.test(normalizar(texto))) return false;
        if (!botonId && EMAIL.test(texto)) return false;
        return pasoConvocatoria(ctx, estado, texto, botonId);
    }
    const opcion = leerOpcionDePuerta(texto, botonId);

    // Botón de otro mensaje (la pregunta de arriba sigue en pantalla): vale igual.
    if (opcion && (botonId || estado?.paso === 'menu')) return elegirOpcion(ctx, opcion);
    if (!estado) {
        // Un botón viejo de «Quiero información» sin estado vigente: se atiende.
        if (esBotonPuerta(botonId)) return continuarSinEstado(ctx, botonId!);
        return false;
    }
    // Con flujo abierto, un botón de OTRA cosa es una elección explícita: se suelta.
    if (botonId && !esBotonPuerta(botonId)) return false;
    // «Necesito hablar con alguien»: lo atiende el bot general (escalación).
    if (!botonId && /\b(asesor|una persona|hablar con (alguien|una persona|la escuela)|humano)\b/.test(normalizar(texto))) return false;
    if (!botonId && EMAIL.test(texto)) return false;

    switch (estado.paso) {
        case 'menu': return false; // texto libre: reglas de siempre
        case 'club_nombre': return pasoClubNombre(ctx, estado, texto);
        case 'info_nombre': return pasoInfoNombre(ctx, estado, texto);
        case 'info_edad': return pasoInfoEdad(ctx, estado, texto);
        case 'info_acudiente': return pasoInfoAcudiente(ctx, estado, texto, botonId);
        case 'info_quiere': return pasoInfoQuiere(ctx, estado, texto, botonId);
        case 'info_oferta': return pasoInfoOferta(ctx, estado, texto, botonId);
        default: return false;
    }
}

async function continuarSinEstado(ctx: CtxPuerta, botonId: string): Promise<boolean> {
    if (botonId === BOTON_PUERTA.CLUB) return elegirOpcion(ctx, 'club');
    if (botonId === BOTON_PUERTA.INFO) return elegirOpcion(ctx, 'info');
    if (botonId === BOTON_PUERTA.OTRO) return elegirOpcion(ctx, 'otro');
    // El botón de ofertas de un mensaje viejo (flujo vencido): las ofertas de HOY, sin el registro.
    if (botonId === BOTON_PUERTA.OFERTAS) return mostrarOfertas(ctx, {}, await ofertasDePuerta(ctx), []);
    return false;
}

async function elegirOpcion(ctx: CtxPuerta, opcion: OpcionDePuerta): Promise<boolean> {
    if (opcion === 'club') {
        await ctx.enviar(
            'Perfecto 🙌 Para ubicarte: *¿cuál es el nombre completo del deportista?* (nombre y apellido)\n\n' +
            'Si prefieres verificarte ya, también puedes escribirme el *correo* con el que está registrado y te envío un código.',
            'puerta_club_pregunta', { paso: 'club_nombre', datos: {} });
        return true;
    }
    if (opcion === 'otro') {
        await ctx.enviar(
            'Entendido 🙌 Ya le avisé a la escuela. Cuéntanos por aquí qué necesitas y alguien te responde.',
            'puerta_otro_tema', null);
        await ctx.avisarEscuela('otro', null);
        return true;
    }
    // info: mini-registro. Si ya dijo la edad antes, no se le vuelve a preguntar.
    const perfil = await seguro(() => ctx.nombrePerfil?.());
    await ctx.enviar(
        '¡Con gusto! 🙌 Para decirte el grupo y los valores necesito unos datos cortos.\n\n' +
        '*¿Cómo se llama el deportista?* (nombre y apellido)',
        'puerta_info_nombre', { paso: 'info_nombre', datos: { nombrePerfil: perfil ?? null } });
    return true;
}

async function seguro<T>(f: () => Promise<T> | T | undefined): Promise<T | null> {
    try { return ((await f()) as T) ?? null; } catch { return null; }
}

// ── «Ya soy del club» ───────────────────────────────────────────────────────

async function pasoClubNombre(ctx: CtxPuerta, estado: EstadoPuerta, texto: string): Promise<boolean> {
    const leido = leerNombreDeDeportista(texto);
    if (!leido) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) {
            await ctx.enviar('Listo, ya pasé tu mensaje a la escuela y alguien te responde por aquí para ubicar tu ficha. 🙌',
                'puerta_club_recibido', null);
            await ctx.avisarEscuela('club', null);
            return true;
        }
        await ctx.enviar('No alcancé a leer el nombre. Escríbeme el *nombre y apellido* del deportista (por ejemplo: Sofía Gómez).',
            'puerta_club_pregunta', { paso: 'club_nombre', datos: { ...estado.datos, intentos } });
        return true;
    }
    await ctx.enviar(
        `¡Gracias! Le pasé a la escuela el nombre de *${leido.nombre}* y alguien te responde por aquí para ubicar tu ficha. 🙌\n\n` +
        'Por privacidad no te muestro datos hasta verificar que eres tú; si quieres hacerlo ya, escríbeme el *correo* ' +
        'con el que está registrado y te envío un código.',
        'puerta_club_recibido', null, undefined, undefined, { deportista_declarado: leido.nombre });
    await ctx.avisarEscuela('club', `Dice ser del club. Deportista: ${leido.nombre}.`);
    return true;
}

// ── «Quiero información»: mini-registro ─────────────────────────────────────

async function pasoInfoNombre(ctx: CtxPuerta, estado: EstadoPuerta, texto: string): Promise<boolean> {
    const ahora = (ctx.ahora ?? (() => new Date()))();
    const leido = leerNombreDeDeportista(texto, ahora);
    if (!leido) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) return cerrarSinDatos(ctx, estado.datos);
        await ctx.enviar('No alcancé a leer el nombre. Escríbeme el *nombre y apellido* del deportista (por ejemplo: Sofía Gómez).',
            'puerta_info_nombre', { paso: 'info_nombre', datos: { ...estado.datos, intentos } });
        return true;
    }
    const datos: DatosPuerta = { ...estado.datos, deportista: leido.nombre, intentos: 0 };
    // La edad pudo venir en el mismo mensaje o en uno anterior: no se repite.
    const edad = leido.edad ?? (await seguro(() => ctx.edadPrevia?.())) ?? undefined;
    if (edad != null) {
        datos.edad = edad;
        datos.fechaNacimiento = leido.fechaNacimiento ?? null;
        return pedirAcudiente(ctx, datos);
    }
    await ctx.enviar(`¿Qué *edad* tiene ${primerNombre(leido.nombre)}? (o su fecha de nacimiento, por ejemplo 15/03/2014)`,
        'puerta_info_edad', { paso: 'info_edad', datos });
    return true;
}

async function pasoInfoEdad(ctx: CtxPuerta, estado: EstadoPuerta, texto: string): Promise<boolean> {
    const ahora = (ctx.ahora ?? (() => new Date()))();
    const e = leerEdad(texto, ahora);
    if (!e) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        if (intentos >= MAX_INTENTOS) return cerrarSinDatos(ctx, estado.datos);
        await ctx.enviar('Necesito la *edad* en números (por ejemplo: 9) o la fecha de nacimiento (15/03/2014).',
            'puerta_info_edad', { paso: 'info_edad', datos: { ...estado.datos, intentos } });
        return true;
    }
    return pedirAcudiente(ctx, { ...estado.datos, edad: e.edad, fechaNacimiento: e.fechaNacimiento, intentos: 0 });
}

async function pedirAcudiente(ctx: CtxPuerta, datos: DatosPuerta): Promise<boolean> {
    const grupo = datos.edad != null ? await seguro(() => ctx.grupoPara(datos.edad!)) : null;
    const siguiente: DatosPuerta = { ...datos, grupoSugerido: grupo?.nombre ?? datos.grupoSugerido ?? null };
    const perfil = siguiente.nombrePerfil ?? (await seguro(() => ctx.nombrePerfil?.()));
    siguiente.nombrePerfil = perfil ?? null;
    if (perfil && nombreValido(perfil)) {
        await ctx.enviar('¿A nombre de quién dejo el registro?', 'puerta_info_acudiente',
            { paso: 'info_acudiente', datos: siguiente },
            [{ id: BOTON_PUERTA.SOY, title: `Soy ${primerNombre(perfil)}`.slice(0, 20) },
                { id: BOTON_PUERTA.OTRO_NOMBRE, title: 'Otro nombre' }],
            `Responde con el *nombre del acudiente* (por ejemplo: ${titulo(perfil)}).`);
        return true;
    }
    await ctx.enviar('¿A nombre de quién dejo el registro? Escríbeme el *nombre del acudiente*.',
        'puerta_info_acudiente', { paso: 'info_acudiente', datos: siguiente });
    return true;
}

async function pasoInfoAcudiente(ctx: CtxPuerta, estado: EstadoPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const d = estado.datos;
    if (botonId === BOTON_PUERTA.SOY && d.nombrePerfil) return pedirQueQuiere(ctx, { ...d, acudiente: titulo(d.nombrePerfil), intentos: 0 });
    if (botonId === BOTON_PUERTA.OTRO_NOMBRE) {
        await ctx.enviar('Escríbeme el *nombre del acudiente*.', 'puerta_info_acudiente',
            { paso: 'info_acudiente', datos: { ...d, otroAcudiente: true } });
        return true;
    }
    const nombre = nombreValido(texto);
    if (!nombre || nombre.split(' ').length > 6) {
        const intentos = (d.intentos ?? 0) + 1;
        // Sin nombre de acudiente el lead sirve igual: se sigue con lo que hay.
        if (intentos >= MAX_INTENTOS) return pedirQueQuiere(ctx, { ...d, intentos: 0 });
        await ctx.enviar('Escríbeme el *nombre del acudiente* (nombre y apellido).', 'puerta_info_acudiente',
            { paso: 'info_acudiente', datos: { ...d, intentos } });
        return true;
    }
    return pedirQueQuiere(ctx, { ...d, acudiente: nombre, intentos: 0 });
}

async function pedirQueQuiere(ctx: CtxPuerta, datos: DatosPuerta): Promise<boolean> {
    const para = datos.deportista ? ` para *${primerNombre(datos.deportista)}*` : '';
    const { botones, enTexto } = botonesQueQuiere(await ofertasDePuerta(ctx));
    await ctx.enviar(`¿Qué quieres hacer${para}?`, 'puerta_info_quiere',
        { paso: 'info_quiere', datos }, botones, enTexto);
    return true;
}

async function pasoInfoQuiere(ctx: CtxPuerta, estado: EstadoPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const ofertas = await ofertasDePuerta(ctx);
    const quiere = leerQueQuiere(texto, botonId, {
        hayOfertas: !!ofertas?.ofertas.length, etiqueta: ofertas ? etiquetaDeOfertas(ofertas.ofertas)?.boton : null,
    });
    if (!quiere) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        // No eligió: se cierra con lo que pidió por defecto (los valores) y la escuela lo ve.
        if (intentos >= MAX_INTENTOS) return cerrarMiniRegistro(ctx, { ...estado.datos, quiere: 'precios' }, ofertas);
        const { botones, enTexto } = botonesQueQuiere(ofertas);
        await ctx.enviar('Elige una opción para seguir:', 'puerta_info_quiere',
            { paso: 'info_quiere', datos: { ...estado.datos, intentos } }, botones, enTexto);
        return true;
    }
    return cerrarMiniRegistro(ctx, { ...estado.datos, quiere }, ofertas);
}

/** «convocatoria» si todas las ofertas son de un tipo; «oferta» si son de varios. Pura. */
function interesDe(ofertas: OfertasDePuerta): TipoOferta | 'oferta' {
    const tipos = [...new Set(ofertas.ofertas.map((o) => o.tipo))];
    return tipos.length === 1 ? tipos[0] : 'oferta';
}

/** Lo que se le dice a quien pide la clase de prueba un día sin clase. */
export const SIN_CLASE_DE_PRUEBA_HOY = 'Por ahora no estamos agendando clases de prueba.';

/**
 * Cierre con los datos completos: lead COMPLETO, el grupo, los valores y el
 * enlace de inscripción. Con «Clase de cortesía» sigue el flujo de cortesía ya
 * sabiendo nombre, edad y acudiente (va directo al resumen al elegir horario).
 * Sin clase de prueba hoy (`ofertas`), la clase nunca arranca: con ofertas
 * vigentes se muestran ellas; sin ofertas, los valores y el enlace.
 */
async function cerrarMiniRegistro(ctx: CtxPuerta, datos: DatosPuerta, ofertas?: OfertasDePuerta | null): Promise<boolean> {
    const sinClase = !!ofertas && !ofertas.claseDePrueba.disponible;
    const hayOfertas = !!ofertas?.ofertas.length;
    // «Clase de cortesía» (botón de un mensaje viejo o escrito) un día sin clase: no se arranca.
    const aviso = datos.quiere === 'cortesia' && sinClase ? SIN_CLASE_DE_PRUEBA_HOY : '';
    if (aviso) datos = { ...datos, quiere: hayOfertas ? 'ofertas' : 'precios' };
    if (datos.quiere === 'ofertas') {
        if (hayOfertas) return mostrarOfertas(ctx, datos, ofertas!, [aviso]);
        datos = { ...datos, quiere: 'precios' }; // las ofertas vencieron entre el botón y el toque
    }
    const deportista = datos.deportista ?? '';
    const edad = datos.edad ?? null;
    await seguro(() => ctx.guardarLead({
        deportista, fechaNacimiento: datos.fechaNacimiento ?? null, edad,
        acudiente: datos.acudiente ?? null, grupoSugerido: datos.grupoSugerido ?? null,
        quiere: (datos.quiere as LeadCompleto['quiere']) ?? null,
    }));
    const grupo = edad != null ? await seguro(() => ctx.grupoPara(edad)) : null;
    const precios = await seguro(() => ctx.precios(edad));
    const enlace = await seguro(() => ctx.enlace());
    const registrado = `Listo${datos.acudiente ? `, ${primerNombre(datos.acudiente)}` : ''}: registré a *${deportista}*` +
        (edad != null ? ` (${edad} años)` : '') + '. 🙌';
    const cuerpo = [
        registrado,
        aviso,
        grupo?.linea ?? '',
        precios ?? '',
        enlace && datos.quiere !== 'precios'
            ? `Aquí puedes ${datos.quiere === 'inscribirme' ? 'hacer la inscripción' : 'ver los grupos y los valores, e inscribirte'}: ${enlace}`
            : enlace ? `Si quieres inscribirte, este es el enlace: ${enlace}` : '',
    ].filter(Boolean).join('\n\n');

    if (datos.quiere === 'cortesia') {
        await ctx.cortesia(datos, cuerpo);
        return true;
    }
    if (!enlace) {
        await ctx.enviar(`${cuerpo}\n\nYa le avisé a la escuela con tus datos y alguien te responde por aquí con la información de inscripción.`,
            'puerta_info_listo', null);
        await ctx.avisarEscuela('prospecto_sin_enlace', null);
        return true;
    }
    await ctx.enviar(`${cuerpo}\n\nSi te queda alguna duda, escríbela por aquí y la escuela te responde.`, 'puerta_info_listo', null);
    return true;
}

// ── Ofertas vigentes (convocatorias…) ───────────────────────────────────────

/**
 * Las ofertas de hoy (`textoOfertasParaPersona`: títulos, fechas, lugares y «cómo
 * inscribirse» salen de la base) y la pregunta de a cuál fecha quiere ir. El lead
 * queda con `quiere` = el tipo de la oferta. false si no hay ofertas (sigue lo de siempre).
 * Si la escuela tiene preguntas antes de las ofertas (`preguntasOfertas`), la
 * convocatoria guiada (una pregunta a la vez; lo que el registro ya sabe no se pregunta).
 */
async function mostrarOfertas(ctx: CtxPuerta, datos: DatosPuerta, ofertas: OfertasDePuerta | null, previos: string[]): Promise<boolean> {
    const texto = ofertas ? textoOfertasParaPersona(ofertas) : null;
    if (!ofertas || !texto) return false;
    const edad = datos.edad ?? null;
    if (datos.deportista) {
        await seguro(() => ctx.guardarLead({
            deportista: datos.deportista!, fechaNacimiento: datos.fechaNacimiento ?? null, edad,
            acudiente: datos.acudiente ?? null, grupoSugerido: datos.grupoSugerido ?? null, quiere: interesDe(ofertas),
        }));
    }
    const registrado = datos.deportista
        ? `Listo${datos.acudiente ? `, ${primerNombre(datos.acudiente)}` : ''}: registré a *${datos.deportista}*`
            + (edad != null ? ` (${edad} años)` : '') + '. 🙌'
        : '';
    if (ofertas.preguntasOfertas) {
        const encabezado = [registrado, ...previos].filter(Boolean).join('\n\n');
        const anio = anioDelRegistro(datos, ofertas.hoy);
        return iniciarConvocatoria(ctx, { ...(anio != null ? { anio } : {}), ...(datos.deportista ? { nombre: datos.deportista } : {}) },
            { encabezado, ofertas, datos });
    }
    const pregunta = datos.deportista
        ? `¿A cuál fecha quieres inscribir a *${primerNombre(datos.deportista)}*? Escríbeme el día y la hora y se lo paso a la escuela 🙌`
        : '¿A cuál fecha quieres ir? Escríbeme el día y la hora y se lo paso a la escuela 🙌';
    await ctx.enviar([registrado, ...previos, texto, pregunta].filter(Boolean).join('\n\n'), 'puerta_info_ofertas',
        { paso: 'info_oferta', datos: { ...datos, quiere: 'ofertas', intentos: 0 } });
    return true;
}

const SOLO_CORTESIA = /^(ok|okey|okay|oki|gracias|muchas gracias|mil gracias|listo|dale|vale|bueno|perfecto|genial|super|si|claro|de acuerdo|entendido|ya)( (gracias|muchas gracias))?$/;

/**
 * La fecha que eligió (como la escriba: «la del sábado 5 a las 7»): la escuela recibe el
 * aviso con los datos del registro y la conversación queda pendiente de ella. Sin cobros.
 * Una pregunta o un «gracias» no es la elección: lo atiende el bot de siempre.
 */
async function pasoInfoOferta(ctx: CtxPuerta, estado: EstadoPuerta, texto: string, botonId: string | null): Promise<boolean> {
    if (botonId === BOTON_PUERTA.OFERTAS) return mostrarOfertas(ctx, estado.datos, await ofertasDePuerta(ctx), []);
    if (botonId) return false;
    const n = normalizar(texto);
    if (!n || texto.includes('?') || SOLO_CORTESIA.test(n) || n.split(' ').length > 40) return false;
    const d = estado.datos;
    const eleccion = texto.replace(/\s+/g, ' ').trim().slice(0, 200);
    const quien = d.deportista ? ` a *${primerNombre(d.deportista)}*` : '';
    await ctx.enviar(`¡Listo! 🙌 Le pasé a la escuela que quieres inscribir${quien} en: «${eleccion}». La escuela te confirma el cupo por aquí.`,
        'puerta_info_listo', null, undefined, undefined, { pendiente_escuela: `inscripción: ${eleccion}`.slice(0, 300) });
    const ofertas = await ofertasDePuerta(ctx);
    const que = (ofertas ? etiquetaDeOfertas(ofertas.ofertas)?.boton : null) ?? 'Oferta';
    await ctx.avisarEscuela('otro', [
        `Inscripción (${que.toLocaleLowerCase('es-CO')}): «${eleccion}».`,
        d.deportista ? `Deportista: ${d.deportista}${d.edad != null ? ` (${d.edad} años)` : ''}.` : '',
        d.fechaNacimiento ? `Nacimiento: ${d.fechaNacimiento}.` : '',
        d.acudiente ? `Acudiente: ${d.acudiente}.` : '',
    ].filter(Boolean).join(' '));
    return true;
}

// ── Convocatoria guiada: una pregunta a la vez (Monster 2026-11-25) ─────────
//
// QUÉ preguntar y con qué opciones lo decide bot-ofertas (`siguientePreguntaOferta`,
// `aplicarRespuestaOferta`); aquí solo la conversación: botones (2–3 opciones) o
// lista (más de 3, botón «Elegir»), el estado en el payload y la inscripción.

/** step de las preguntas de la convocatoria guiada cuando quien llama no da otro. */
export const PASO_PUERTA_OFERTA = 'puerta_oferta';
/** step de los mensajes con las ofertas elegidas y la promo (sin estado: el estado va en los botones de después). */
export const PASO_PUERTA_OFERTA_LISTA = 'puerta_oferta_lista';

/** Tope por mensaje: WhatsApp admite 4096 caracteres; el margen es para la coletilla de baja. */
export const LARGO_MAX_MENSAJE_OFERTAS = 3900;
/** Cuerpo máximo de un mensaje con botones (límite de Meta). */
const LARGO_MAX_CUERPO_BOTONES = 1024;
const TEXTO_LISTA = 'Elegir';
const PREGUNTA_ACCION = '¿Qué quieres hacer? 👇';
const A_LA_ESCUELA = 'Listo, la escuela te escribe por aquí 🙌';

/** Opciones de bot-ofertas como botones (≤ 3) o filas de lista (más). */
function botonesDe(opciones: OpcionOferta[], seccion?: string): BotonInteractivo[] {
    return opciones.map((o) => ({
        id: o.id, title: o.titulo, ...(o.descripcion ? { descripcion: o.descripcion } : {}), ...(seccion ? { seccion } : {}),
    }));
}

/** Respaldo en texto de las opciones (modo asistido o si Meta rechaza los botones). */
function enTextoDe(botones: BotonInteractivo[]): string | undefined {
    if (!botones.length) return undefined;
    return `Responde ${botones.map((b) => `*${b.title}*`).join(', ').replace(/, ([^,]*)$/, ' o $1')}.`;
}

/** Envía una pregunta del flujo con su estado (botones o lista según cuántas opciones). */
async function preguntarConvocatoria(
    ctx: CtxPuerta, texto: string, datos: DatosPuerta, paso: PasoConvocatoria, botones: BotonInteractivo[],
    op: { step?: string; contexto?: Record<string, unknown>; intentos?: number } = {},
): Promise<void> {
    await ctx.enviar(texto, op.step ?? PASO_PUERTA_OFERTA,
        { paso: 'oferta', datos: { ...datos, quiere: 'ofertas', ultimoPaso: paso, intentos: op.intentos ?? 0 } },
        botones.length ? botones : undefined, enTextoDe(botones), op.contexto,
        botones.length > 3 || botones.some((b) => b.seccion) ? { textoLista: TEXTO_LISTA } : undefined);
}

/**
 * Arranca la convocatoria guiada: la presentación de la escuela (`introDeOfertas`) y
 * la primera pregunta (lo que ya se sabe en `prefill` no se pregunta). false si la
 * escuela no tiene preguntas configuradas o no hay ofertas vigentes: quien llama
 * sigue con lo de siempre.
 *   - `encabezado`: va antes (saludo, «no tenemos clases de prueba…»).
 *   - `ofertas`: el estado ya leído en el turno (sin él, se lee).
 *   - `step` / `contexto`: los del primer mensaje (el bot pasa el de su freno).
 *   - `datos`: lo que la puerta ya sabe (mini-registro).
 */
export async function iniciarConvocatoria(
    ctx: CtxPuerta, prefill: Partial<DatosOferta> = {},
    opciones: {
        encabezado?: string; ofertas?: OfertasDePuerta | null; step?: string; contexto?: Record<string, unknown>; datos?: DatosPuerta;
    } = {},
): Promise<boolean> {
    const ofertas = opciones.ofertas !== undefined ? opciones.ofertas : await ofertasDePuerta(ctx);
    if (!ofertas?.ofertas.length || !ofertas.preguntasOfertas) return false;
    const datos: DatosPuerta = {
        ...(opciones.datos ?? {}),
        oferta: { ...DATOS_OFERTA_VACIOS, ...prefill },
        mostradas: undefined, ofertaId: null,
    };
    const previos = [opciones.encabezado, introDeOfertas(ofertas)];
    return siguientePaso(ctx, ofertas, datos, previos, { step: opciones.step, contexto: opciones.contexto });
}

/** La pregunta que sigue, o las ofertas si ya se sabe lo necesario. */
async function siguientePaso(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, datos: DatosPuerta, previos: (string | null | undefined)[],
    op: { step?: string; contexto?: Record<string, unknown>; intentos?: number } = {},
): Promise<boolean> {
    const p = siguientePreguntaOferta(ofertas, datos.oferta ?? DATOS_OFERTA_VACIOS);
    if (p.paso === 'lista') return mostrarElegidas(ctx, ofertas, datos, p.ofertas, previos, op);
    const texto = [...previos, p.texto].map((x) => (x ?? '').trim()).filter(Boolean).join('\n\n');
    await preguntarConvocatoria(ctx, texto, datos, p.paso, botonesDe(p.opciones), op);
    return true;
}

/** Las ofertas en mensajes: todas en uno si caben; si no, una por mensaje. Pura. */
export function mensajesDeOfertas(
    ofertas: OfertaBot[], estado: Pick<EstadoOfertas, 'hoy' | 'notaOfertas' | 'descuentoPromo'>, encabezado = '',
    largoMax = LARGO_MAX_MENSAJE_OFERTAS,
    /** El momento para la promo de la escuela (por defecto, ahora). */
    ahora?: Date | number,
): string[] {
    const junta = (...xs: (string | null | undefined)[]) => xs.map((x) => (x ?? '').trim()).filter(Boolean).join('\n\n');
    if (!ofertas.length) return [];
    const todo = junta(encabezado, textoDeOfertas(ofertas, estado, { ahora }));
    if (todo.length <= largoMax) return [todo];
    return ofertas.map((o, i) => junta(i === 0 ? encabezado : '', textoDeOfertas([o], estado, { ahora })).slice(0, largoMax));
}

/** Botones del final: inscribirse, la evaluación (si la escuela tiene la nota) y una persona. */
function botonesDeAccion(ofertas: OfertasDePuerta, conEvaluacion = true): BotonInteractivo[] {
    return [
        { id: ID_OFERTA.INSCRIBIRME, title: 'Quiero inscribirme' },
        ...(conEvaluacion && ofertas.notaOfertas ? [{ id: ID_OFERTA.EVALUACION, title: 'Cómo es la evaluación' }] : []),
        { id: ID_OFERTA.PERSONA, title: 'Hablar con alguien' },
    ];
}

/**
 * La(s) oferta(s) que le aplican con el texto de la escuela (sin la nota), la promo
 * vigente si hay, y aparte «¿Qué quieres hacer? 👇» con los botones del final (el
 * texto largo va solo: un mensaje con botones admite 1024 caracteres).
 */
async function mostrarElegidas(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, datos: DatosPuerta, elegidas: OfertaBot[], previos: (string | null | undefined)[],
    op: { step?: string; contexto?: Record<string, unknown> } = {},
): Promise<boolean> {
    let lista = elegidas.length ? elegidas : filtrarPorGenero(ofertas.ofertas, datos.oferta?.genero ?? null);
    if (!lista.length) lista = [];
    const encabezado = previos.map((x) => (x ?? '').trim()).filter(Boolean).join('\n\n');
    if (!lista.length) {
        // Nada de su perfil: no se le manda lo que no le sirve; la escuela le escribe.
        await ctx.enviar([encabezado, A_LA_ESCUELA].filter(Boolean).join('\n\n'), 'puerta_info_listo', null, undefined, undefined,
            { pendiente_escuela: 'convocatoria: sin oferta para su perfil', ...(op.contexto ?? {}) });
        await ctx.avisarEscuela('otro', `${resumenDeConvocatoria(datos)} Ninguna oferta vigente le aplica.`);
        return true;
    }
    // Con el género elegido, una nota de sesión que solo reparte por género («Una cancha femenino y otra masculino») sobra.
    if (datos.oferta?.genero) lista = lista.map((o) => ({ ...o, sesiones: o.sesiones.map((x) => (notaDeGenero(x.notas) ? { ...x, notas: null } : x)) }));
    const mensajes = mensajesDeOfertas(lista, ofertas, encabezado, undefined, ctx.ahora?.());
    for (let i = 0; i < mensajes.length; i++) {
        await ctx.enviar(mensajes[i], i === 0 && op.step ? op.step : PASO_PUERTA_OFERTA_LISTA, null, undefined, undefined,
            i === 0 ? op.contexto : undefined);
    }
    const promo = (ofertas.promoOfertas ?? '').trim();
    if (promo) await ctx.enviar(promo, PASO_PUERTA_OFERTA_LISTA, null);
    await preguntarConvocatoria(ctx, PREGUNTA_ACCION, { ...datos, mostradas: lista.map((o) => o.id) }, 'accion',
        botonesDeAccion(ofertas));
    return true;
}

/** ¿La nota de la sesión solo reparte por género (nombra femenino y masculino)? Pura. */
function notaDeGenero(nota: string | null | undefined): boolean {
    const n = normalizar(nota);
    return !!n && /femenin/.test(n) && /masculin/.test(n);
}

/** «¿Y cuánto cuesta?», «dónde queda»: una pregunta, no la respuesta. */
const PREGUNTA_SUELTA = /^(cuant[oa]s?|cuando|donde|como|cual(es)?|que|quien|hay|tienen|puedo|se puede|me pueden?|necesito|quisiera|y)\b/;

/** ¿Lo escrito es otra cosa (una pregunta, un «gracias», una frase larga) y no la respuesta? */
function noEsRespuesta(texto: string): boolean {
    const n = normalizar(texto);
    return !n || texto.includes('?') || SOLO_CORTESIA.test(n);
}

/**
 * Turno de la convocatoria guiada. false (lo contesta el bot de siempre) con una
 * pregunta, un «gracias» o un texto que no tiene que ver; el estado queda en el
 * último mensaje del flujo, así que un botón tocado después sigue valiendo.
 */
async function pasoConvocatoria(ctx: CtxPuerta, estado: EstadoPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const d = estado.datos;
    const paso = d.ultimoPaso ?? 'genero';
    const ofertas = await ofertasDePuerta(ctx);
    if (!ofertas?.ofertas.length) {
        if (!botonId && noEsRespuesta(texto)) return false;
        // Las ofertas vencieron a mitad del flujo: la escuela le escribe.
        await ctx.enviar(`¡Gracias! 🙌 ${A_LA_ESCUELA}`, 'puerta_info_listo', null, undefined, undefined,
            { pendiente_escuela: 'convocatoria: ya no hay ofertas vigentes' });
        await ctx.avisarEscuela('otro', `${resumenDeConvocatoria(d)} Ya no hay ofertas vigentes.`);
        return true;
    }
    switch (paso) {
        case 'accion': return pasoAccion(ctx, ofertas, d, texto, botonId);
        case 'elegir_oferta': return pasoElegirOferta(ctx, ofertas, d, texto, botonId);
        case 'nombre': return pasoNombreConvocatoria(ctx, ofertas, d, texto, botonId);
        case 'fecha': return pasoFecha(ctx, ofertas, d, texto, botonId);
        default: return pasoPregunta(ctx, ofertas, d, texto, botonId);
    }
}

/** Respuesta a una pregunta de bot-ofertas (género, año, trayectoria, detalle, sede). */
async function pasoPregunta(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, texto: string, botonId: string | null,
): Promise<boolean> {
    const datosOferta = d.oferta ?? DATOS_OFERTA_VACIOS;
    const pregunta = siguientePreguntaOferta(ofertas, datosOferta);
    if (!botonId && noEsRespuesta(texto)) return false;
    if (pregunta.paso === 'lista') return mostrarElegidas(ctx, ofertas, d, pregunta.ofertas, []);
    const nuevo = aplicarRespuestaOferta(pregunta, datosOferta, { botonId, texto }, ofertas.hoy);
    if (!nuevo) {
        // Un texto que no tiene que ver (frase larga o una pregunta suelta): lo contesta el bot de siempre.
        if (!botonId && (PREGUNTA_SUELTA.test(normalizar(texto)) || texto.split(/\s+/).length > 8)) return false;
        return noEntendio(ctx, ofertas, d, pregunta.paso, botonesDe(pregunta.opciones), pregunta.texto);
    }
    const anioTexto = pregunta.paso === 'anio'
        ? (pregunta.opciones.find((o) => o.id === botonId)?.titulo ?? (nuevo.anio != null ? String(nuevo.anio) : null))
        : d.anioTexto;
    return siguientePaso(ctx, ofertas, { ...d, oferta: nuevo, anioTexto }, []);
}

/** No se entendió: se repite UNA vez; a la segunda, la conversación pasa a la escuela. */
async function noEntendio(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, paso: PasoConvocatoria, botones: BotonInteractivo[], pregunta: string,
): Promise<boolean> {
    const intentos = (d.intentos ?? 0) + 1;
    if (intentos >= MAX_INTENTOS) {
        await ctx.enviar(A_LA_ESCUELA, 'puerta_info_listo', null, undefined, undefined,
            { pendiente_escuela: 'convocatoria: no se entendió su respuesta' });
        await ctx.avisarEscuela('otro', `${resumenDeConvocatoria(d)} No se entendió su respuesta: sigue la escuela.`);
        return true;
    }
    const ayuda = botones.length ? 'Elige una opción 👇' : 'No alcancé a entenderte.';
    await preguntarConvocatoria(ctx, `${ayuda}\n\n${pregunta}`, d, paso, botones, { intentos });
    void ofertas;
    return true;
}

/** Las ofertas que se le mostraron (con las sesiones filtradas por lo que respondió). */
function ofertasMostradas(ofertas: OfertasDePuerta, d: DatosPuerta): OfertaBot[] {
    const filtradas = siguientePreguntaOferta(ofertas, d.oferta ?? DATOS_OFERTA_VACIOS).ofertas;
    const ids = d.mostradas ?? filtradas.map((o) => o.id);
    return ids.map((id) => filtradas.find((o) => o.id === id) ?? ofertas.ofertas.find((o) => o.id === id))
        .filter((o): o is OfertaBot => Boolean(o));
}

const QUIERE_INSCRIBIRSE = /\b(inscrib\w*|inscripcion|matricul\w*|quiero ir|me apunto|reservar?)\b/;
const QUIERE_EVALUACION = /\b(evaluacion|evaluan|como (es|son|funciona))\b/;

/** [Quiero inscribirme] [Cómo es la evaluación] [Hablar con alguien], tocados o escritos. */
async function pasoAccion(ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const n = normalizar(texto);
    const accion = botonId === ID_OFERTA.INSCRIBIRME || (!botonId && QUIERE_INSCRIBIRSE.test(n)) ? 'inscribirme'
        : botonId === ID_OFERTA.EVALUACION || (!botonId && QUIERE_EVALUACION.test(n) && !!ofertas.notaOfertas) ? 'evaluacion'
            : botonId === ID_OFERTA.PERSONA ? 'persona' : null;
    if (!accion) {
        if (!botonId) return false;   // otra cosa escrita: el bot de siempre (el estado sigue para un botón después)
        return pasoPregunta(ctx, ofertas, d, texto, botonId);   // un botón de una pregunta anterior
    }
    if (accion === 'evaluacion') {
        const nota = (ofertas.notaOfertas ?? '').trim();
        const botones = botonesDeAccion(ofertas, false);
        const junto = `${nota}\n\n${PREGUNTA_ACCION}`;
        if (junto.length <= LARGO_MAX_CUERPO_BOTONES) {
            await preguntarConvocatoria(ctx, junto, d, 'accion', botones);
        } else {
            await ctx.enviar(nota, PASO_PUERTA_OFERTA_LISTA, null);
            await preguntarConvocatoria(ctx, PREGUNTA_ACCION, d, 'accion', botones);
        }
        return true;
    }
    if (accion === 'persona') {
        await ctx.enviar(A_LA_ESCUELA, 'puerta_info_listo', null, undefined, undefined,
            { pendiente_escuela: `convocatoria: pidió hablar con alguien (${tituloDeMostradas(ofertas, d)})`.slice(0, 300) });
        await ctx.avisarEscuela('otro', `${resumenDeConvocatoria(d, ofertas)} Pidió hablar con alguien.`);
        return true;
    }
    const mostradas = ofertasMostradas(ofertas, d);
    if (mostradas.length > 1) {
        const sedes = mostradas.map((o) => (o.sede ?? '').trim());
        const unicas = sedes.every((s, i) => s && sedes.indexOf(s) === i);
        const botones: BotonInteractivo[] = mostradas.map((o) => ({
            id: `of_o_${o.id}`, title: (unicas ? o.sede! : o.titulo),
            ...(unicas || mostradas.length > 3 ? { descripcion: o.titulo.slice(0, 72) } : {}),
        }));
        await preguntarConvocatoria(ctx, '¿A cuál convocatoria quieres inscribirte?', d, 'elegir_oferta', botones);
        return true;
    }
    return pedirNombreOFecha(ctx, ofertas, { ...d, ofertaId: mostradas[0]?.id ?? null });
}

function tituloDeMostradas(ofertas: OfertasDePuerta, d: DatosPuerta): string {
    const o = d.ofertaId ? ofertas.ofertas.find((x) => x.id === d.ofertaId) : null;
    return o ? o.titulo : ofertasMostradas(ofertas, d).map((x) => x.titulo).join(' · ');
}

/** ¿A cuál convocatoria? (si se le mostró más de una). */
async function pasoElegirOferta(ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const mostradas = ofertasMostradas(ofertas, d);
    let elegida = botonId?.startsWith('of_o_') ? mostradas.find((o) => `of_o_${o.id}` === botonId) : undefined;
    if (!elegida && !botonId) {
        if (noEsRespuesta(texto)) return false;
        const n = normalizar(texto);
        elegida = mostradas.find((o) => [o.sede, o.titulo].some((x) => x && (n.includes(normalizar(x)) || normalizar(x).includes(n))));
    }
    if (!elegida) {
        if (botonId && !botonId.startsWith('of_o_')) return pasoAccion(ctx, ofertas, d, texto, botonId);
        if (!botonId && texto.split(/\s+/).length > 8) return false;
        const botones = mostradas.map((o) => ({ id: `of_o_${o.id}`, title: o.sede ?? o.titulo }));
        return noEntendio(ctx, ofertas, d, 'elegir_oferta', botones, '¿A cuál convocatoria quieres inscribirte?');
    }
    return pedirNombreOFecha(ctx, ofertas, { ...d, ofertaId: elegida.id, intentos: 0 });
}

/** El nombre del deportista (si no se sabe) y luego la fecha. */
async function pedirNombreOFecha(ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta): Promise<boolean> {
    if (!(d.oferta?.nombre ?? d.deportista)) {
        await preguntarConvocatoria(ctx, '¡Súper! 🙌 ¿Cuál es el *nombre completo* del deportista?', d, 'nombre', []);
        return true;
    }
    return pedirFecha(ctx, ofertas, d);
}

async function pasoNombreConvocatoria(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, texto: string, botonId: string | null,
): Promise<boolean> {
    if (botonId) return pasoAccion(ctx, ofertas, d, texto, botonId);
    if (noEsRespuesta(texto)) return false;
    const leido = leerNombreDeDeportista(texto, (ctx.ahora ?? (() => new Date()))());
    if (!leido) {
        if (PREGUNTA_SUELTA.test(normalizar(texto))) return false;
        const intentos = (d.intentos ?? 0) + 1;
        // Sin nombre la inscripción sigue igual: la escuela lo pide al confirmar.
        if (intentos >= MAX_INTENTOS) return pedirFecha(ctx, ofertas, { ...d, intentos: 0 });
        await preguntarConvocatoria(ctx, 'Escríbeme el *nombre y apellido* del deportista (por ejemplo: Sofía Gómez).', d, 'nombre', [], { intentos });
        return true;
    }
    return pedirFecha(ctx, ofertas, { ...d, oferta: { ...(d.oferta ?? DATOS_OFERTA_VACIOS), nombre: leido.nombre }, intentos: 0 });
}

function ofertaElegida(ofertas: OfertasDePuerta, d: DatosPuerta): OfertaBot | null {
    const mostradas = ofertasMostradas(ofertas, d);
    return mostradas.find((o) => o.id === d.ofertaId) ?? mostradas[0] ?? null;
}

/** «¿A cuál fecha vas a ir?» como lista (`opcionesDeFechas`). Sin fechas, se confirma sin fecha. */
async function pedirFecha(ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, intentos = 0): Promise<boolean> {
    const oferta = ofertaElegida(ofertas, d);
    if (!oferta) return confirmarInscripcion(ctx, ofertas, d, null, null);
    const filas = botonesDe(opcionesDeFechas(oferta, ofertas.hoy), 'Fechas');
    if (!filas.length) return confirmarInscripcion(ctx, ofertas, d, oferta, null);
    const quien = d.oferta?.nombre ?? d.deportista;
    await preguntarConvocatoria(ctx,
        `¿A cuál fecha vas a ir${quien ? ` con *${primerNombre(quien)}*` : ''}? 👇`, { ...d, ofertaId: oferta.id }, 'fecha', filas, { intentos });
    return true;
}

async function pasoFecha(ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const oferta = ofertaElegida(ofertas, d);
    if (!oferta) return confirmarInscripcion(ctx, ofertas, d, null, null);
    let sesion = botonId?.startsWith('of_f_') ? oferta.sesiones.find((s) => `of_f_${s.id}` === botonId) : undefined;
    if (!sesion && botonId?.startsWith('of_f_')) {
        // Una fecha de otra oferta (o ya pasada): se busca entre todas las vigentes.
        sesion = ofertas.ofertas.flatMap((o) => o.sesiones).find((s) => `of_f_${s.id}` === botonId);
    }
    if (!sesion && !botonId) {
        if (noEsRespuesta(texto)) return false;
        const n = normalizar(texto);
        const fila = opcionesDeFechas(oferta, ofertas.hoy).find((f) => normalizar(f.titulo) === n);
        sesion = fila ? oferta.sesiones.find((s) => `of_f_${s.id}` === fila.id) : undefined;
        if (!sesion) {
            if (PREGUNTA_SUELTA.test(n) || texto.split(/\s+/).length > 12) return false;
            const intentos = (d.intentos ?? 0) + 1;
            // A la segunda, lo que escribió («el sábado temprano») va tal cual: la escuela confirma.
            if (intentos >= MAX_INTENTOS) return confirmarInscripcion(ctx, ofertas, d, oferta, null, texto.slice(0, 200));
            await ctx.enviar('Elige la fecha en la lista 👇', PASO_PUERTA_OFERTA, null);
            return pedirFecha(ctx, ofertas, d, intentos);
        }
    }
    if (!sesion) return pasoAccion(ctx, ofertas, d, texto, botonId);
    return confirmarInscripcion(ctx, ofertas, d, oferta, sesion);
}

/** «sábado 12 de diciembre, 7:00 a 9:00 a. m. · Locos por Pádel». */
function fechaDeSesion(s: OfertaBot['sesiones'][number], hoy: string): string {
    return `${fechaLegible(s.fecha, hoy)}, ${rangoLegible(s.horaInicio, s.horaFin)}${s.lugar ? ` · ${s.lugar}` : ''}`;
}

/**
 * Cierre: la inscripción queda pendiente de la escuela (ella confirma el cupo y,
 * si la oferta tiene valor, cómo pagar). La escuela recibe TODO lo que contó.
 *
 * Descuento de la promoción (bot_ofertas_ajustes.promo_descuento_pct, Monster's Black
 * Friday 2026-11-25): si «ahora» está en la ventana de pago, el valor va con el descuento
 * calculado por el bot (nadie hace la cuenta a mano) y el aviso dice «Promo aplicada».
 * Fuera de la ventana o sin promo, igual que siempre.
 */
async function confirmarInscripcion(
    ctx: CtxPuerta, ofertas: OfertasDePuerta, d: DatosPuerta, oferta: OfertaBot | null,
    sesion: OfertaBot['sesiones'][number] | null, fechaEscrita: string | null = null,
): Promise<boolean> {
    const nombre = d.oferta?.nombre ?? d.deportista ?? null;
    const cuando = sesion ? fechaDeSesion(sesion, ofertas.hoy) : fechaEscrita ? `«${fechaEscrita}»` : null;
    const valor = oferta?.requierePago && oferta.valor != null ? `$${oferta.valor.toLocaleString('es-CO')}` : null;
    const ahora = ctx.ahora?.() ?? new Date();
    const promo = oferta?.requierePago && oferta.valor != null ? precioConPromo(oferta.valor, ofertas, ahora) : null;
    const conDescuento = promo?.conDescuento != null && ofertas.descuentoPromo ? promo.conDescuento : null;
    const lineaValor = conDescuento != null
        ? `${lineaDeValor(oferta!.valor!, ofertas, ahora)}. La escuela te indica cómo pagar.`
        : valor ? `Valor: *${valor}*. La escuela te indica cómo pagar.` : '';
    const texto = [
        `¡Listo! ✅ Le pasé a la escuela tu inscripción${nombre ? ` de *${nombre}*` : ''}`
            + `${oferta ? ` a *${oferta.titulo}*` : ''}${cuando ? `: ${cuando}` : ''}.`,
        lineaValor,
        'La escuela te confirma el cupo por aquí 🙌',
    ].filter(Boolean).join('\n\n');
    await ctx.enviar(texto, 'puerta_info_listo', null, undefined, undefined, {
        pendiente_escuela: `inscripción: ${[oferta?.titulo, cuando].filter(Boolean).join(' · ')}`.slice(0, 300),
    });
    if (nombre) {
        await seguro(() => ctx.guardarLead({
            deportista: nombre, fechaNacimiento: d.fechaNacimiento ?? null, edad: d.edad ?? null,
            acudiente: d.acudiente ?? null, grupoSugerido: oferta?.titulo ?? null, quiere: oferta?.tipo ?? 'oferta',
        }));
    }
    await ctx.avisarEscuela('otro', [
        `Inscripción (${(etiquetaDeOfertas(ofertas.ofertas)?.boton ?? 'Oferta').toLocaleLowerCase('es-CO')}):`
            + ` ${oferta?.titulo ?? 'sin oferta elegida'}${cuando ? ` — ${cuando}` : ''}.`,
        nombre ? `Deportista: ${nombre}.` : 'Sin nombre del deportista.',
        resumenDeConvocatoria(d),
        conDescuento != null
            ? `Valor: ${valor}. Promo aplicada: ${promo!.pct} % → $${conDescuento.toLocaleString('es-CO')}`
                + ` (si paga hasta el ${finDePromoLegible(ofertas.descuentoPromo!, ofertas.hoy)}; indicarle cómo pagar).`
            : valor ? `Valor: ${valor} (indicarle cómo pagar).` : '',
    ].filter(Boolean).join(' '));
    return true;
}

/** Lo que contó en la convocatoria guiada, para el aviso a la escuela. Pura. */
function resumenDeConvocatoria(d: DatosPuerta, ofertas?: OfertasDePuerta): string {
    const o = d.oferta ?? DATOS_OFERTA_VACIOS;
    return [
        o.genero ? `Género: ${o.genero}.` : '',
        d.anioTexto || o.anio != null ? `Año de nacimiento: ${d.anioTexto ?? o.anio}.` : '',
        o.trayectoria === true ? `Trayectoria: sí${o.detalle ? ` (${o.detalle})` : ''}.` : o.trayectoria === false ? 'Trayectoria: no.' : '',
        o.sede ? `Sede: ${o.sede}.` : '',
        ofertas ? `Ofertas que vio: ${tituloDeMostradas(ofertas, d)}.` : '',
        d.acudiente ? `Acudiente: ${d.acudiente}.` : '',
    ].filter(Boolean).join(' ') || 'Convocatorias.';
}

/** Año de nacimiento que ya dio en el mini-registro (su fecha, o la edad contra el año de `hoy`). Pura. */
function anioDelRegistro(d: DatosPuerta, hoy: string): number | null {
    const deFecha = d.fechaNacimiento ? Number(String(d.fechaNacimiento).slice(0, 4)) : NaN;
    if (Number.isFinite(deFecha) && deFecha > 1900) return deFecha;
    return d.edad != null ? Number(hoy.slice(0, 4)) - d.edad : null;
}

/** No entendió el nombre/edad dos veces: lo que haya queda en el buzón y la escuela lo ve. */
async function cerrarSinDatos(ctx: CtxPuerta, datos: DatosPuerta): Promise<boolean> {
    if (datos.deportista) {
        await seguro(() => ctx.guardarLead({
            deportista: datos.deportista!, fechaNacimiento: null, edad: datos.edad ?? null,
            acudiente: datos.acudiente ?? null, grupoSugerido: null, quiere: null,
        }));
    }
    await ctx.enviar('Listo, ya pasé tu consulta a la escuela y alguien te responde por aquí con la información. 🙌',
        'puerta_info_listo', null);
    await ctx.avisarEscuela('prospecto_sin_enlace', datos.deportista ? `Prospecto: ${datos.deportista}.` : null);
    return true;
}

// ─── Estado en Supabase (payload del último saliente) ────────────────────────

/** Estado = el payload del último saliente del bot (o del borrador pendiente). Nunca lanza. */
export async function leerEstadoDePuertaDeSupabase(conversationId: string): Promise<EstadoPuerta | null> {
    try {
        const desde = new Date(Date.now() - VIGENCIA_FLUJO_PUERTA_MS).toISOString();
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
        if (!ultimo || ultimo.flujo !== FLUJO_PUERTA || !ultimo.paso_puerta) return null;
        return { paso: ultimo.paso_puerta, datos: ultimo.datos_puerta ?? {} };
    } catch {
        return null;
    }
}

/** Cuántos salientes hacia atrás se busca el estado de la convocatoria guiada. */
const SALIENTES_PARA_OFERTA = 8;

/**
 * El estado de la convocatoria guiada aunque el bot haya contestado otra cosa
 * después (una pregunta a mitad del flujo): el saliente más reciente del bot con
 * paso 'oferta' en la vigencia. Si una persona de la escuela escribió después, ya
 * no (la conversación es suya). Nunca lanza.
 */
export async function leerEstadoDeOfertaDeSupabase(conversationId: string): Promise<EstadoPuerta | null> {
    try {
        const desde = new Date(Date.now() - VIGENCIA_FLUJO_PUERTA_MS).toISOString();
        const [msgs, borradores] = await Promise.all([
            supabase.from('whatsapp_messages')
                .select('payload, created_at, ai_generated')
                .eq('conversation_id', conversationId)
                .eq('direction', 'outbound')
                .gte('created_at', desde)
                .order('created_at', { ascending: false })
                .limit(SALIENTES_PARA_OFERTA),
            supabase.from('whatsapp_message_drafts')
                .select('tool_context, created_at')
                .eq('conversation_id', conversationId)
                .eq('status', 'pending')
                .gte('created_at', desde)
                .order('created_at', { ascending: false })
                .limit(SALIENTES_PARA_OFERTA),
        ]);
        const comoLista = (d: any) => (Array.isArray(d) ? d : d ? [d] : []) as any[];
        const filas = [
            ...comoLista((msgs as any)?.data).map((m) => ({ p: m.payload, humano: m.ai_generated === false, en: m.created_at })),
            ...comoLista((borradores as any)?.data).map((b) => ({ p: b.tool_context, humano: false, en: b.created_at })),
        ].sort((a, b) => new Date(b.en).getTime() - new Date(a.en).getTime());
        for (const f of filas) {
            if (f.humano) return null;
            if (f.p?.flujo === FLUJO_PUERTA && f.p?.paso_puerta === 'oferta') return { paso: 'oferta', datos: f.p.datos_puerta ?? {} };
        }
        return null;
    } catch {
        return null;
    }
}
