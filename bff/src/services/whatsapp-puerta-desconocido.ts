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
 */

import type { BotonInteractivo } from './whatsapp.service';
import { supabase } from '../config/supabase';
import { leerEdad, nombreValido, normalizar } from './whatsapp-clase-cortesia.service';

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
} as const;

export function esBotonPuerta(id: string | null | undefined): boolean {
    return !!id && id.startsWith('sm_pd_');
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

export type PasoPuerta = 'menu' | 'club_nombre' | 'info_nombre' | 'info_edad' | 'info_acudiente' | 'info_quiere';
export type QueQuiere = 'cortesia' | 'inscribirme' | 'precios';

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
}

export interface EstadoPuerta { paso: PasoPuerta; datos: DatosPuerta }

/** Lo que queda en `school_signup_leads` al terminar el mini-registro. */
export interface LeadCompleto {
    deportista: string;
    fechaNacimiento: string | null;
    edad: number | null;
    acudiente: string | null;
    grupoSugerido: string | null;
    quiere: QueQuiere | null;
}

export interface GrupoSugerido { linea: string | null; nombre: string | null }

export interface CtxPuerta {
    conversationId: string;
    schoolId: string;
    contactWaId: string;
    /** Envía un mensaje. `estado` null = terminal (cierra el flujo). */
    enviar: (texto: string, step: string, estado: EstadoPuerta | null,
        botones?: BotonInteractivo[], enTexto?: string, contexto?: Record<string, unknown>) => Promise<void>;
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
    leerEstado?: (conversationId: string) => Promise<EstadoPuerta | null>;
    ahora?: () => Date;
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

/** ¿Qué quiere hacer? Por botón o por palabra. Pura. */
export function leerQueQuiere(texto: string | null | undefined, botonId: string | null = null): QueQuiere | null {
    if (botonId === BOTON_PUERTA.CORTESIA) return 'cortesia';
    if (botonId === BOTON_PUERTA.INSCRIBIRME) return 'inscribirme';
    if (botonId === BOTON_PUERTA.PRECIOS) return 'precios';
    const n = normalizar(texto);
    if (!n) return null;
    if (/\bsolo (los )?(precios?|valores?)\b/.test(n)) return 'precios';
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
    const estado = await (ctx.leerEstado ?? leerEstadoDePuertaDeSupabase)(ctx.conversationId);
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
        default: return false;
    }
}

async function continuarSinEstado(ctx: CtxPuerta, botonId: string): Promise<boolean> {
    if (botonId === BOTON_PUERTA.CLUB) return elegirOpcion(ctx, 'club');
    if (botonId === BOTON_PUERTA.INFO) return elegirOpcion(ctx, 'info');
    if (botonId === BOTON_PUERTA.OTRO) return elegirOpcion(ctx, 'otro');
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
    await ctx.enviar(`¿Qué quieres hacer${para}?`, 'puerta_info_quiere',
        { paso: 'info_quiere', datos }, BOTONES_QUIERE, ENTEXTO_QUIERE);
    return true;
}

async function pasoInfoQuiere(ctx: CtxPuerta, estado: EstadoPuerta, texto: string, botonId: string | null): Promise<boolean> {
    const quiere = leerQueQuiere(texto, botonId);
    if (!quiere) {
        const intentos = (estado.datos.intentos ?? 0) + 1;
        // No eligió: se cierra con lo que pidió por defecto (los valores) y la escuela lo ve.
        if (intentos >= MAX_INTENTOS) return cerrarMiniRegistro(ctx, { ...estado.datos, quiere: 'precios' });
        await ctx.enviar('Elige una opción para seguir:', 'puerta_info_quiere',
            { paso: 'info_quiere', datos: { ...estado.datos, intentos } }, BOTONES_QUIERE, ENTEXTO_QUIERE);
        return true;
    }
    return cerrarMiniRegistro(ctx, { ...estado.datos, quiere });
}

/**
 * Cierre con los datos completos: lead COMPLETO, el grupo, los valores y el
 * enlace de inscripción. Con «Clase de cortesía» sigue el flujo de cortesía ya
 * sabiendo nombre, edad y acudiente (va directo al resumen al elegir horario).
 */
async function cerrarMiniRegistro(ctx: CtxPuerta, datos: DatosPuerta): Promise<boolean> {
    const deportista = datos.deportista ?? '';
    const edad = datos.edad ?? null;
    await seguro(() => ctx.guardarLead({
        deportista, fechaNacimiento: datos.fechaNacimiento ?? null, edad,
        acudiente: datos.acudiente ?? null, grupoSugerido: datos.grupoSugerido ?? null, quiere: datos.quiere ?? null,
    }));
    const grupo = edad != null ? await seguro(() => ctx.grupoPara(edad)) : null;
    const precios = await seguro(() => ctx.precios(edad));
    const enlace = await seguro(() => ctx.enlace());
    const registrado = `Listo${datos.acudiente ? `, ${primerNombre(datos.acudiente)}` : ''}: registré a *${deportista}*` +
        (edad != null ? ` (${edad} años)` : '') + '. 🙌';
    const cuerpo = [
        registrado,
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
