/**
 * wa-registro-de-venta — la MEMORIA de los datos de quien asiste a un servicio que el bot vende por WhatsApp.
 *
 * Por qué (Monster 2026-11-15, tres ventas perdidas): el bot preguntaba el nombre aunque ya venía en la nota del
 * comprobante o en el primer mensaje del chat, y no guardaba la fecha de nacimiento ni el acudiente en ningún sitio.
 *
 * Regla (decisión de producto 2026-11-16): lo que ya se sabe no se vuelve a pedir. Antes de preguntar se reúne
 *   (a) la ficha del prospecto de ese contacto (`school_signup_leads`),
 *   (b) la nota del comprobante leída por el OCR y el pie de la foto,
 *   (c) lo que el cliente ya escribió en ESA venta,
 * y se pide SOLO lo que falte. Todo lo que se entienda se guarda en la ficha.
 *
 * Leer un texto es cosa de `whatsapp-datos-de-registro` (puro). Acá va lo que ese módulo no decide: de qué fuente se
 * acepta un nombre, de quién son los datos de la ficha, y dónde se guardan.
 */
import { supabase } from '../config/supabase';
import { normalizarFrase } from './whatsapp-reglas-turno';
import { nombreDeAsistente } from './whatsapp-comprobante-de-ficha.service';
import {
    datosFaltantes, edadEn, leerDatosDeRegistro, nombreYAcudienteEnLineas, nombresDeAsistentesEn, resumenParaLaEscuela, textoPidiendoDatos, unirDatosDeRegistro,
    type DatoFaltante, type DatosDeRegistro,
} from './whatsapp-datos-de-registro';

export const SIN_REGISTRO: DatosDeRegistro = {
    nombre: null, fechaNacimiento: null, edad: null, soloEdad: false, acudiente: null, posicion: null,
};

/** ¿Trae un dato de registro además del nombre? Pura. */
export function traeOtroDato(d: DatosDeRegistro): boolean {
    return !!d.fechaNacimiento || d.edad !== null || !!d.posicion || !!d.acudiente;
}

/** ¿Se sabe algo de quien asiste? Pura. */
export function hayRegistro(d: DatosDeRegistro | null | undefined): boolean {
    return !!d && (!!d.nombre || traeOtroDato(d));
}

/** El mismo nombre, o uno contenido en el otro («Gabriela Covaleda» y «Gabriela Covaleda García»). Pura. */
export function mismaPersona(a: string | null | undefined, b: string | null | undefined): boolean {
    const A = normalizarFrase(a).split(' ').filter(Boolean);
    const B = normalizarFrase(b).split(' ').filter(Boolean);
    if (!A.length || !B.length) return false;
    const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
    return corto.every((w) => largo.includes(w));
}

/** Lo que valida un dato de registro que viene de la base (una lectura vieja o a mano puede traer cualquier cosa). Pura. */
export function registroGuardado(v: unknown): DatosDeRegistro {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const texto = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
    const fecha = texto(o.fechaNacimiento);
    return unirDatosDeRegistro({
        nombre: texto(o.nombre),
        fechaNacimiento: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null,
        edad: typeof o.edad === 'number' && Number.isFinite(o.edad) ? o.edad : null,
        acudiente: texto(o.acudiente),
        posicion: texto(o.posicion),
    });
}

// ─── (a) La ficha del prospecto ─────────────────────────────────────────────

export interface FichaDeProspecto {
    full_name?: string | null;
    birth_date?: string | null;
    guardian_name?: string | null;
    respuestas?: Record<string, unknown> | null;
    source_detail?: Record<string, any> | null;
}

/**
 * Lo que la ficha ya sabe de quien asiste. El nombre solo si está marcado como el de quien asiste (`conocido`:
 * `asistente_servicio.nombre` o un registro completo); la fecha, el acudiente y la posición solo si la ficha es de
 * quien asiste (o el bot ya anotó datos sueltos en `asistente_servicio`): los datos de un perfil de WhatsApp sin
 * confirmar no son de nadie. Pura.
 */
export function registroDeFicha(f: FichaDeProspecto | null | undefined, o: { hoy: string; conocido: boolean }): DatosDeRegistro {
    if (!f) return { ...SIN_REGISTRO };
    const sd = (f.source_detail && typeof f.source_detail === 'object' ? f.source_detail : {}) as Record<string, any>;
    const asistente = sd.asistente_servicio && typeof sd.asistente_servicio === 'object' ? sd.asistente_servicio : null;
    if (!o.conocido && !asistente) return { ...SIN_REGISTRO };
    const fecha = typeof f.birth_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.birth_date) ? f.birth_date.slice(0, 10) : null;
    const posicion = f.respuestas && typeof f.respuestas === 'object' && typeof (f.respuestas as any).posicion === 'string'
        ? String((f.respuestas as any).posicion).trim() || null : null;
    const edadDicha = typeof asistente?.edad === 'number' && Number.isFinite(asistente.edad) ? asistente.edad as number : null;
    return unirDatosDeRegistro({
        nombre: o.conocido && typeof f.full_name === 'string' && f.full_name.trim() ? f.full_name.trim() : null,
        fechaNacimiento: fecha,
        edad: fecha ? edadEn(fecha, o.hoy) : edadDicha,
        acudiente: typeof f.guardian_name === 'string' && f.guardian_name.trim() ? f.guardian_name.trim() : null,
        posicion,
    });
}

// ─── (b) La nota del comprobante y el pie de la foto ────────────────────────

/**
 * Los datos que vienen CON el archivo. Una nota que es solo un nombre puede ser el titular de la cuenta de la
 * escuela (el OCR a veces entrega eso como descripción): si coincide con `titular`, no es quien asiste. Pura.
 */
export function registroDeNota(
    textos: (string | null | undefined)[], o: { hoy: string; titular?: string | null },
): DatosDeRegistro {
    return unirDatosDeRegistro(...textos.map((t) => {
        const d = leerDatosDeRegistro(t, { hoy: o.hoy, fuente: 'nota' });
        if (d.nombre && !traeOtroDato(d) && o.titular && mismaPersona(d.nombre, o.titular)) return { ...d, nombre: null };
        return d;
    }));
}

// ─── (c) Lo que ya escribió en esta venta ───────────────────────────────────

/** Marcas con las que alguien dice de quién habla: con ellas un nombre vale aunque venga solo. */
const MARCA_DE_ASISTENTE = /\b(?:a nombre de|se llama|nombres?\s*(?:completo\s*)?:|(?:la|el|mi|una?)\s+ni[ñn][ao]|mi\s+(?:hij[ao]|sobrin[ao]|niet[ao]|herman[ao])|participante|asistente|es para|inscribir a)\b/i;

/** ¿El texto dice de quién habla con una marca («la niña…», «a nombre de…», «mi hijo…»)? Pura. */
export function tieneMarcaDeAsistente(texto: string | null | undefined): boolean {
    return MARCA_DE_ASISTENTE.test(String(texto ?? ''));
}

/**
 * Un mensaje ANTERIOR del chat. De ahí el nombre solo se toma si el mismo mensaje trae otro dato de registro
 * (fecha, edad, posición, acudiente) o una marca («la niña…», «a nombre de…»): dos palabras sueltas de un mensaje
 * viejo pueden ser cualquier cosa. Pura.
 */
export function registroDeMensajePrevio(texto: string | null | undefined, o: { hoy: string }): DatosDeRegistro {
    const d = leerDatosDeRegistro(texto, { hoy: o.hoy, fuente: 'nota' });
    if (d.nombre && !traeOtroDato(d) && !MARCA_DE_ASISTENTE.test(String(texto ?? ''))) return { ...d, nombre: null };
    return d;
}

/** Los mensajes anteriores de la venta, del más reciente al más viejo (gana lo último que dijo). Pura. */
export function registroDeChatPrevio(textos: (string | null | undefined)[], o: { hoy: string }): DatosDeRegistro {
    return unirDatosDeRegistro(...textos.map((t) => registroDeMensajePrevio(t, o)));
}

/** Tope de mensajes y de horas de la memoria de una venta. */
export const MAX_MENSAJES_DE_LA_VENTA = 40;
export const HORAS_DE_LA_VENTA = 72;
/** Cuánto antes de la última señal de la venta se lee (la venta la abre un mensaje de la persona, poco antes). */
export const MARGEN_ANTES_DE_LA_VENTA_MS = 24 * 3600_000;

/**
 * Los textos que el contacto escribió en esta venta (desde que empezó, con tope de horas y de mensajes), del más
 * reciente al más viejo. UNA lectura. Nunca lanza.
 */
export async function textosDeLaVenta(
    conversationId: string | null, o: { desde?: string | null; hasta?: string | null; ahora?: number } = {},
): Promise<string[]> {
    if (!conversationId) return [];
    try {
        const ahora = o.ahora ?? Date.now();
        const tope = ahora - HORAS_DE_LA_VENTA * 3600_000;
        const inicio = o.desde ? Date.parse(o.desde) : NaN;
        // `desde` es la ÚLTIMA señal de la venta (el mensaje de pago, la ficha), no su primer mensaje: lo que la
        // persona escribió para empezar («Interesadas en el vacacional… / Gabriela… / 13 años») va justo antes.
        const desde = new Date(Number.isFinite(inicio) ? Math.max(inicio - MARGEN_ANTES_DE_LA_VENTA_MS, tope) : ahora - MARGEN_ANTES_DE_LA_VENTA_MS).toISOString();
        let q = supabase.from('whatsapp_messages')
            .select('text_body, created_at')
            .eq('conversation_id', conversationId).eq('direction', 'inbound')
            .gte('created_at', desde);
        if (o.hasta) q = q.lte('created_at', o.hasta);
        const { data } = await q.order('created_at', { ascending: false }).limit(MAX_MENSAJES_DE_LA_VENTA);
        return ((Array.isArray(data) ? data : []) as any[])
            .map((m) => (typeof m?.text_body === 'string' ? m.text_body.trim() : ''))
            .filter(Boolean);
    } catch {
        return [];
    }
}

// ─── La respuesta a la pregunta del bot ─────────────────────────────────────

/**
 * La respuesta DIRECTA a «necesito estos datos de quien asiste» (hay pregunta abierta): acá sí vale un nombre
 * suelto. Si el lector de datos no decide un nombre, el de siempre (`nombreDeAsistente`: el comienzo del texto o
 * una línea que es entera el nombre). Pura.
 */
export function leerRespuestaDeDatos(texto: string | null | undefined, o: { hoy: string }): DatosDeRegistro {
    const d = leerDatosDeRegistro(texto, { hoy: o.hoy, fuente: 'chat' });
    if (d.nombre) return d;
    // Dos o más personas en el mensaje («Jugador 1: … / Jugador 2: …»): no se toma la primera en silencio.
    if (nombresDeAsistentesEn(texto, { sinLineasSueltas: true }).length >= 2) return d;
    // Dos nombres sin marca, cada uno en su línea: quien asiste y la persona responsable, en el orden pedido.
    const par = nombreYAcudienteEnLineas(texto);
    if (par) return { ...d, nombre: par.nombre, acudiente: d.acudiente ?? par.acudiente };
    const n = nombreDeAsistente(texto);
    return n && !(d.acudiente && mismaPersona(n, d.acudiente)) ? { ...d, nombre: n } : d;
}

/**
 * Une lo que ya se sabía con lo que acaba de decir. Lo nuevo gana (puede estar corrigiendo). Si ya se sabe quién
 * asiste y llega OTRO nombre sin marca, es el de la persona responsable (se le acaba de pedir), no un asistente
 * nuevo. Pura.
 */
export function combinarConRespuesta(conocido: DatosDeRegistro | null | undefined, leido: DatosDeRegistro): DatosDeRegistro {
    const previo = conocido ?? SIN_REGISTRO;
    let nuevo = leido;
    if (previo.nombre && leido.nombre) {
        if (mismaPersona(previo.nombre, leido.nombre)) {
            const masLargo = normalizarFrase(leido.nombre).length > normalizarFrase(previo.nombre).length ? leido.nombre : previo.nombre;
            nuevo = { ...leido, nombre: masLargo };
        } else {
            nuevo = { ...leido, nombre: null, acudiente: leido.acudiente ?? leido.nombre };
        }
    }
    return unirDatosDeRegistro(nuevo, previo);
}

/** ¿`despues` sabe algo que `antes` no sabía? Pura. */
export function aportaAlgo(antes: DatosDeRegistro | null | undefined, despues: DatosDeRegistro): boolean {
    const a = antes ?? SIN_REGISTRO;
    return (!!despues.nombre && despues.nombre !== a.nombre)
        || (!!despues.fechaNacimiento && despues.fechaNacimiento !== a.fechaNacimiento)
        || (despues.edad !== null && despues.edad !== a.edad)
        || (!!despues.acudiente && despues.acudiente !== a.acudiente)
        || (!!despues.posicion && despues.posicion !== a.posicion);
}

// ─── Lo que falta y cómo se pide ────────────────────────────────────────────

export function faltantesDe(d: DatosDeRegistro | null | undefined, hoy: string): DatoFaltante[] {
    return datosFaltantes(d ?? SIN_REGISTRO, { hoy });
}

/**
 * La frase que pide lo que falta SIN afirmar que se anotó nada (va detrás de otra frase: «Ya tengo tu comprobante
 * 📄 …», «Recibí tu comprobante… a nombre de …»). '' si no falta nada. Pura.
 */
export function pedidoDeFaltantes(faltan: DatoFaltante[], d: DatosDeRegistro | null | undefined, servicio: string): string {
    if (!faltan.length) return '';
    return textoPidiendoDatos(faltan, { servicio, conComprobante: false, anotado: { ...(d ?? SIN_REGISTRO), nombre: null } });
}

/** «asiste: Gabriela Covaleda García · 13 años (sin fecha) · falta: fecha de nacimiento» para la bandeja. Pura. */
export function resumenDeAsistente(d: DatosDeRegistro | null | undefined, hoy: string): string {
    const datos = d ?? SIN_REGISTRO;
    if (!hayRegistro(datos)) return 'sin nombre · falta: nombre completo, fecha de nacimiento';
    return resumenParaLaEscuela(datos, faltantesDe(datos, hoy));
}

// ─── Guardar en la ficha ────────────────────────────────────────────────────

/**
 * Los campos de la ficha que cambian con estos datos (sin `full_name`: el nombre lo pone quien llama, que sabe si
 * la ficha ya es de otra persona). `otraPersona`: la ficha ya tiene a alguien y esta compra es para otra persona;
 * no se pisa nada, queda en `source_detail.otros_asistentes`. Pura.
 */
export function camposDeRegistro(
    actual: FichaDeProspecto, datos: DatosDeRegistro,
    o: { servicioId: string; ahora: string; hoy: string; otraPersona?: boolean },
): { birth_date?: string; guardian_name?: string; respuestas?: Record<string, unknown>; source_detail: Record<string, unknown> } {
    const sd = (actual.source_detail && typeof actual.source_detail === 'object' ? actual.source_detail : {}) as Record<string, any>;
    const faltan = faltantesDe(datos, o.hoy);
    if (o.otraPersona) {
        const otros = (Array.isArray(sd.otros_asistentes) ? sd.otros_asistentes : [])
            .filter((x: any) => !mismaPersona(x?.nombre, datos.nombre));
        return {
            source_detail: {
                ...sd,
                otros_asistentes: [...otros, {
                    nombre: datos.nombre, fecha_nacimiento: datos.fechaNacimiento, edad: datos.edad, acudiente: datos.acudiente,
                    posicion: datos.posicion, servicio_id: o.servicioId, at: o.ahora, faltan,
                }].slice(-10),
            },
        };
    }
    const previo = sd.asistente_servicio && typeof sd.asistente_servicio === 'object' ? sd.asistente_servicio : {};
    const respuestas = actual.respuestas && typeof actual.respuestas === 'object' ? actual.respuestas : {};
    return {
        ...(datos.fechaNacimiento ? { birth_date: datos.fechaNacimiento } : {}),
        ...(datos.acudiente ? { guardian_name: datos.acudiente } : {}),
        ...(datos.posicion ? { respuestas: { ...respuestas, posicion: datos.posicion } } : {}),
        source_detail: {
            ...sd,
            asistente_servicio: {
                ...previo,
                nombre: datos.nombre ?? previo.nombre ?? null,
                servicio_id: o.servicioId,
                at: o.ahora,
                ...(datos.edad !== null ? { edad: datos.edad } : {}),
                solo_edad: datos.soloEdad,
                faltan,
            },
        },
    };
}
