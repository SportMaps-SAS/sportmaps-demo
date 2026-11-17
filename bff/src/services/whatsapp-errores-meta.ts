/**
 * whatsapp-errores-meta — los errores de envío de Meta (Graph / Cloud API) en
 * palabras de la dueña de una academia: qué pasó, qué hacer y quién lo arregla.
 *
 * Puro: sin base ni red. Lo usan el reporte de campaña
 * (whatsapp-campana-reporte.service) y los dos caminos que guardan el motivo de
 * un envío fallido (`motivoConCodigo`).
 *
 * FORMATO DEL MOTIVO GUARDADO
 *
 * Desde el 2026-11-15 el motivo se guarda como `(#131026) Message undeliverable`
 * (código de Meta + título). Antes se guardaba solo el título, o `meta_131049`,
 * o el mensaje de Graph tal cual: `codigoDeMotivo` lee los tres.
 *
 * REGLA CONSERVADORA
 *
 * Un código que no está en la tabla NO se adivina: «Error de Meta (#código)» y
 * lo revisa SportMaps. `quien: 'escuela'` solo va en lo que la escuela de
 * verdad puede cambiar desde su pantalla (texto, plantilla, lista, número del
 * contacto) o en lo que no tiene arreglo y no es una falla (Meta decidió no
 * entregarle una promoción a esa persona).
 */

export type QuienCorrige = 'escuela' | 'sportmaps';

export interface ErrorTraducido {
    /** Agrupa: `meta_<código>`, o `integracion` / `tecnico` / `desconocido` para lo que no trae código. */
    clave: string;
    /** Código numérico de Meta, si se pudo saber. */
    codigo: number | null;
    /** Qué pasó, en lenguaje simple. */
    texto: string;
    que_hacer: string;
    quien: QuienCorrige;
    /** ¿La escuela tiene algo que hacer? false = lo revisa SportMaps, o no tiene arreglo y no es una falla. */
    requiere_accion: boolean;
}

interface Entrada { texto: string; que_hacer: string; quien: QuienCorrige; sin_accion?: true }

const LO_REVISA_SPORTMAPS = 'No tienes que hacer nada: el equipo de SportMaps ya recibió el aviso y lo revisa.';
const REVISA_PLANTILLA = 'Revisa el mensaje en WhatsApp › Plantillas. Si Meta lo pausó o lo rechazó, crea uno nuevo, espera su aprobación y haz otra campaña con ese.';

/** Significados según la tabla de errores de la Cloud API de Meta. */
export const ERRORES_DE_META: Readonly<Record<number, Entrada>> = {
    // ── El contacto ──────────────────────────────────────────────────────────
    131026: {
        texto: 'El mensaje no se pudo entregar a ese número',
        que_hacer: 'Casi siempre el número no tiene WhatsApp, está mal escrito o tiene una versión muy vieja de la aplicación. Revisa el número del contacto; no se le vuelve a enviar solo.',
        quien: 'escuela',
    },
    131049: {
        texto: 'Meta decidió no entregarle esta promoción a esa persona',
        que_hacer: 'No es un error tuyo ni se puede corregir: WhatsApp limita cuántas promociones recibe cada persona, de todas las empresas. El sistema lo reintenta una sola vez al día siguiente.',
        quien: 'escuela', sin_accion: true,
    },
    131050: {
        texto: 'La persona apagó las promociones de tu escuela en WhatsApp',
        que_hacer: 'No hay nada que corregir: ya quedó fuera de tus listas de promociones.',
        quien: 'escuela', sin_accion: true,
    },
    130472: {
        texto: 'Meta no entregó el mensaje porque ese número está en una prueba interna de WhatsApp',
        que_hacer: 'No es un error tuyo ni se puede corregir. Le pasa a un grupo pequeño de personas.',
        quien: 'escuela', sin_accion: true,
    },

    // ── La plantilla (el mensaje aprobado por Meta) ──────────────────────────
    132001: { texto: 'Meta no encontró el mensaje de la campaña (lo borraron o cambió de idioma)', que_hacer: REVISA_PLANTILLA, quien: 'escuela' },
    132005: { texto: 'El mensaje quedó demasiado largo al ponerle el nombre de la persona', que_hacer: 'Acorta el texto del mensaje en WhatsApp › Plantillas y haz otra campaña con el nuevo.', quien: 'escuela' },
    132007: { texto: 'Meta rechazó el mensaje porque su contenido incumple sus políticas', que_hacer: REVISA_PLANTILLA, quien: 'escuela' },
    132015: { texto: 'Meta pausó el mensaje de la campaña por baja calidad', que_hacer: REVISA_PLANTILLA, quien: 'escuela' },
    132016: { texto: 'Meta desactivó el mensaje de la campaña', que_hacer: REVISA_PLANTILLA, quien: 'escuela' },
    // Los datos que arma el sistema no cuadran con la plantilla: no es algo que la escuela escriba.
    132000: { texto: 'Los datos del mensaje no coinciden con la plantilla aprobada', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    132012: { texto: 'El formato de un dato del mensaje no coincide con la plantilla aprobada', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },

    // ── Límites de Meta ──────────────────────────────────────────────────────
    131048: { texto: 'Meta limitó los envíos de tu número porque detectó demasiados bloqueos o reportes', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131056: { texto: 'Se le enviaron demasiados mensajes seguidos a ese mismo número', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    130429: { texto: 'Meta frenó los envíos por un momento: se llegó a su límite de velocidad', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    80007: { texto: 'La cuenta de WhatsApp llegó a su límite de envíos', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    4: { texto: 'Meta frenó los envíos por un momento: demasiadas solicitudes', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },

    // ── La cuenta y la integración ───────────────────────────────────────────
    190: { texto: 'Se venció el permiso que conecta tu número con SportMaps', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    368: { texto: 'Meta bloqueó temporalmente la cuenta de WhatsApp por incumplir sus políticas', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131031: { texto: 'Meta bloqueó la cuenta de WhatsApp', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131042: { texto: 'La cuenta de WhatsApp tiene un problema con el medio de pago registrado en Meta', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    133010: { texto: 'El número de la escuela no está registrado en la plataforma de WhatsApp', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131005: { texto: 'Meta negó el permiso para enviar desde tu número', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    10: { texto: 'Meta negó el permiso para enviar desde tu número', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },

    // ── Errores técnicos del envío ───────────────────────────────────────────
    131000: { texto: 'Meta tuvo un error interno al enviar', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131008: { texto: 'Al mensaje le faltó un dato obligatorio', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131009: { texto: 'Un dato del mensaje no es válido para Meta', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131016: { texto: 'El servicio de WhatsApp no estaba disponible en ese momento', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131047: { texto: 'Meta rechazó el mensaje por estar fuera de la ventana de 24 horas', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    131051: { texto: 'Meta no admite ese tipo de mensaje', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    100: { texto: 'Un dato del mensaje no es válido para Meta', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    1: { texto: 'Meta tuvo un error interno al enviar', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
    2: { texto: 'El servicio de Meta no estaba disponible en ese momento', que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps' },
};

/**
 * Títulos con los que Meta nombra cada error. Solo para leer los motivos VIEJOS,
 * que se guardaron sin el número. El orden importa: lo más específico primero.
 */
const TITULOS: readonly [RegExp, number][] = [
    [/stopped receiving marketing|chosen to stop receiving|stop receiving marketing/i, 131050],
    [/healthy ecosystem|ecosystem engagement|chose not to deliver/i, 131049],
    [/re-?engagement/i, 131047],
    [/undeliverable/i, 131026],
    [/part of an experiment/i, 130472],
    [/spam rate limit/i, 131048],
    [/pair rate limit/i, 131056],
    [/template is paused/i, 132015],
    [/template is disabled/i, 132016],
    [/template (name )?does not exist/i, 132001],
    [/param(eter)? count mismatch|number of (localizable_)?params/i, 132000],
    [/parameter format (does not match|mismatch)/i, 132012],
    [/hydrated text too long/i, 132005],
    [/character policy violated/i, 132007],
    [/payment issue/i, 131042],
    [/account has been locked/i, 131031],
    [/phone number not registered|is not registered on the whatsapp business/i, 133010],
    [/error validating access token|access token has expired|session has (expired|been invalidated)/i, 190],
    [/rate limit hit/i, 130429],
];

const esCodigo = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 10_000_000;

/**
 * El motivo que se guarda cuando un envío falla: `(#código) título`, recortado.
 * Sin código, el título tal cual (como antes). Si Graph ya lo trae con ese
 * prefijo, no se repite. Pura.
 */
export function motivoConCodigo(codigo: number | string | null | undefined, titulo: string | null | undefined, max = 300): string {
    const t = String(titulo ?? '').replace(/\s+/g, ' ').trim();
    const c = codigo === null || codigo === undefined || codigo === '' ? NaN : Number(codigo);
    if (!esCodigo(c)) return t.slice(0, max);
    const prefijo = `(#${c})`;
    if (t.startsWith(prefijo)) return t.slice(0, max);
    return (t ? `${prefijo} ${t}` : prefijo).slice(0, max);
}

/**
 * El código de Meta de un motivo guardado, o null. Lee el formato nuevo
 * (`(#131026) …`), `meta_131049`, un código conocido suelto en el texto y, por
 * último, el título en inglés de los motivos viejos. Pura.
 */
export function codigoDeMotivo(motivo: string | null | undefined): number | null {
    const m = String(motivo ?? '').trim();
    if (!m) return null;
    const nuevo = m.match(/\(#(\d{1,7})\)/);
    if (nuevo) return Number(nuevo[1]);
    const interno = m.match(/^meta_(\d{1,7})$/i);
    if (interno) return Number(interno[1]);
    // Un número suelto solo cuenta si es un código que conocemos (no un teléfono ni un HTTP 500).
    for (const suelto of m.match(/\b\d{3,6}\b/g) ?? []) {
        const n = Number(suelto);
        if (n >= 1000 && ERRORES_DE_META[n]) return n;
    }
    for (const [re, codigo] of TITULOS) if (re.test(m)) return codigo;
    return null;
}

/** Fallos nuestros o de la red, que no traen código de Meta. */
const SIN_TOKEN = /integration_without_token|token_decrypt_failed/i;
const TECNICO = /network_error|fetch failed|econn|etimedout|socket|timeout|graph_\d{3}|error_graph|simulacion|^failed$/i;

/** Traduce el motivo guardado de un envío fallido. Nunca lanza; lo desconocido lo revisa SportMaps. Pura. */
export function traducirErrorDeMeta(motivo: string | null | undefined): ErrorTraducido {
    const codigo = codigoDeMotivo(motivo);
    if (codigo !== null) {
        const e = ERRORES_DE_META[codigo];
        if (e) {
            return {
                clave: `meta_${codigo}`, codigo, texto: e.texto, que_hacer: e.que_hacer, quien: e.quien,
                requiere_accion: e.quien === 'escuela' && !e.sin_accion,
            };
        }
        return {
            clave: `meta_${codigo}`, codigo, texto: `Error de Meta (#${codigo})`, que_hacer: LO_REVISA_SPORTMAPS,
            quien: 'sportmaps', requiere_accion: false,
        };
    }
    const m = String(motivo ?? '').trim();
    if (SIN_TOKEN.test(m)) {
        return {
            clave: 'integracion', codigo: null, texto: 'La conexión de tu número con SportMaps tiene un problema',
            que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps', requiere_accion: false,
        };
    }
    if (TECNICO.test(m)) {
        return {
            clave: 'tecnico', codigo: null, texto: 'Hubo un error técnico al enviar',
            que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps', requiere_accion: false,
        };
    }
    return {
        clave: 'desconocido', codigo: null, texto: 'Meta rechazó el mensaje sin decir por qué',
        que_hacer: LO_REVISA_SPORTMAPS, quien: 'sportmaps', requiere_accion: false,
    };
}
