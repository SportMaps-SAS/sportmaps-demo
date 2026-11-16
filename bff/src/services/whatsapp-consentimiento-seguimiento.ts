/**
 * Consentimiento de seguimiento desde la primera respuesta del bot (Monster 2026-11-12, aprobado por Iván).
 *
 * Por qué: pasadas 24 h solo se puede escribir con una plantilla, y la de seguimiento (marketing) exige que la
 * persona haya aceptado. El embudo solo pedía el consentimiento al FINAL (al elegir clase de prueba), así que
 * casi nadie lo daba (Monster: 2 de 273 contactos). Ahora, tras la bienvenida del embudo, el bot pregunta UNA vez:
 * «¿Podemos escribirte por aquí para darte seguimiento?» con [Sí, acepto] / [No, gracias].
 *
 * Apagado por defecto: WA_CONSENT_SEGUIMIENTO_SCHOOL_IDS (ids separados por coma).
 */
import type { BotonInteractivo } from './whatsapp.service';

export const PASO_CONSENT_SEGUIMIENTO = 'consentimiento_seguimiento';
/** Una sola vez por conversación cada 30 días. */
export const HORAS_FRENO_CONSENT_SEGUIMIENTO = 30 * 24;

export const BOTON_CONSENT_SEGUIMIENTO = { SI: 'cs_si', NO: 'cs_no' } as const;

export const BOTONES_CONSENT_SEGUIMIENTO: BotonInteractivo[] = [
    { id: BOTON_CONSENT_SEGUIMIENTO.SI, title: 'Sí, acepto' },
    { id: BOTON_CONSENT_SEGUIMIENTO.NO, title: 'No, gracias' },
];

export const ENTEXTO_CONSENT_SEGUIMIENTO = 'Responde *Sí, acepto* o *No, gracias*.';

/** ¿Corre en esta escuela? Apagado si la variable no existe. Pura. */
export function consentSeguimientoHabilitado(
    schoolId: string, env: string | undefined = process.env.WA_CONSENT_SEGUIMIENTO_SCHOOL_IDS,
): boolean {
    if (!schoolId || !env) return false;
    return env.split(',').map((s) => s.trim()).filter(Boolean).includes(schoolId);
}

export function esBotonConsentSeguimiento(botonId: string | null | undefined): boolean {
    return botonId === BOTON_CONSENT_SEGUIMIENTO.SI || botonId === BOTON_CONSENT_SEGUIMIENTO.NO;
}

/** La pregunta, corta y sin precios. Pura. */
export function textoConsentSeguimiento(nombreEscuela: string | null | undefined): string {
    const escuela = String(nombreEscuela ?? '').trim() || 'la escuela';
    return `Para ayudarte mejor: ¿podemos escribirte por aquí para darte seguimiento y contarte novedades de *${escuela}*? ` +
        'Puedes dejar de recibir mensajes cuando quieras.';
}

export function textoRespuestaConsentSeguimiento(acepto: boolean): string {
    return acepto
        ? '¡Gracias! 🙌 Quedamos atentos a lo que necesites. Cuando quieras, sigue con lo que estabas preguntando.'
        : 'Listo, no te escribiremos más allá de lo que tú preguntes. 🙌 Sigue con lo que estabas preguntando cuando quieras.';
}

// ─── Novedades y promociones para PROSPECTOS (2026-11-15, whatsapp-autoservicio D4) ──────────────
//
// Decisión de producto: a quien escribe interesado y NO es familia de la escuela se le pide, una
// sola vez en la vida de la conversación, consentimiento explícito para recibir novedades y
// promociones. Sale DESPUÉS de que el bot ya le contestó lo que preguntó (nunca de primero ni en
// medio de una venta, un pago, un comprobante o una agenda), dentro de la ventana de 24 h que abrió
// la persona. «Sí» = consentimiento (`wa_register_optin`, fuente `bot_prospecto`). «No» = SOLO baja
// de promociones (`wa_registrar_baja_promos`): se le sigue respondiendo y avisando de sus pagos.
// Sin respuesta: no se registra nada y no se vuelve a preguntar.
//
// Dónde se recuerda «ya se le preguntó»: el saliente (o el borrador) con este `step` en
// `whatsapp_messages` / `whatsapp_message_drafts`. No hace falta tabla ni columna nueva.
//
// Encendido por defecto; se apaga sin desplegar con WA_CONSENT_NOVEDADES_PROSPECTOS=false.

export const PASO_CONSENT_NOVEDADES = 'consentimiento_novedades';

/**
 * Los pasos que ya le preguntaron a la persona si quiere mensajes: este, el de seguimiento de arriba
 * y el consentimiento del embudo (`PASO_EMBUDO.CONSENTIMIENTO`, literal para no importar el embudo).
 * Con cualquiera de ellos en la conversación, esta pregunta no sale.
 */
export const PASOS_QUE_YA_PREGUNTARON_NOVEDADES = [PASO_CONSENT_NOVEDADES, PASO_CONSENT_SEGUIMIENTO, 'embudo_consentimiento'];

export const BOTON_CONSENT_NOVEDADES = { SI: 'cn_si', NO: 'cn_no' } as const;

export const BOTONES_CONSENT_NOVEDADES: BotonInteractivo[] = [
    { id: BOTON_CONSENT_NOVEDADES.SI, title: 'Sí, cuéntenme' },
    { id: BOTON_CONSENT_NOVEDADES.NO, title: 'No, gracias' },
];

/** Lo que acompaña a la pregunta si los botones no salen (o queda en borrador). */
export const ENTEXTO_CONSENT_NOVEDADES = 'Responde *SÍ* o *NO*.';

/** ¿Está prendida? Sí, salvo que la variable diga false / 0 / off / no. Pura. */
export function consentNovedadesEncendido(
    env: string | undefined = process.env.WA_CONSENT_NOVEDADES_PROSPECTOS,
): boolean {
    return !['false', '0', 'off', 'no'].includes(String(env ?? '').trim().toLowerCase());
}

export function esBotonConsentNovedades(botonId: string | null | undefined): boolean {
    return botonId === BOTON_CONSENT_NOVEDADES.SI || botonId === BOTON_CONSENT_NOVEDADES.NO;
}

/** La pregunta. Pura. */
export function textoConsentNovedades(nombreEscuela: string | null | undefined): string {
    const escuela = String(nombreEscuela ?? '').trim() || 'la escuela';
    return `¿Quieres que te contemos por aquí las novedades y promociones de *${escuela}*? ` +
        'Puedes decir que no y te seguimos atendiendo igual.';
}

/** Lo que se le contesta. El «no» no promete silencio: se le sigue respondiendo. Pura. */
export function textoRespuestaConsentNovedades(acepto: boolean): string {
    return acepto
        ? '¡Listo! 🙌 Te contaremos por aquí las novedades y promociones. (Si algún día no las quieres, tocas «No recibir más».)'
        : 'Listo, no te enviaremos novedades ni promociones. 🙌 Por aquí te seguimos atendiendo igual cuando nos escribas.';
}

/**
 * Los resultados del turno de un número sin ficha tras los que SÍ se puede preguntar: el bot acaba
 * de contestar una consulta (valores, sede, edades, inscripción, la respuesta con la ficha) y no
 * dejó nada abierto. Todo lo demás queda por fuera a propósito: la bienvenida y los saludos (sería
 * el primer mensaje), el embudo y la clase de prueba (agenda en curso), los horarios (ofrecen
 * reservar), la venta de un servicio (`venta_*`, anuncios), los pagos, los comprobantes, el código
 * de verificación, lo que pasa a una persona y los silencios.
 */
const RESULTADOS_QUE_PREGUNTAN_NOVEDADES = new Set([
    'precios', 'plan_clases', 'inscripcion', 'prospecto_precios', 'prospecto_info', 'prospecto_ia',
]);

export function turnoPermiteConsentNovedades(resultado: string | null | undefined): boolean {
    return RESULTADOS_QUE_PREGUNTAN_NOVEDADES.has(String(resultado ?? ''));
}

/** ¿Ya decidió? Con consentimiento, baja total o baja de promociones no se le pregunta. Pura. */
export function yaDecidioNovedades(
    o: { opted_in_at?: string | null; opted_out_at?: string | null; promos_out_at?: string | null } | null | undefined,
): boolean {
    return Boolean(o && (o.opted_in_at || o.opted_out_at || o.promos_out_at));
}

const SI_ESCRITO = new Set(['si', 'si cuentenme', 'si cuenteme', 'si claro', 'si por favor', 'si gracias', 'si quiero', 'claro', 'claro que si']);
const NO_ESCRITO = new Set(['no', 'no gracias', 'no quiero', 'prefiero que no']);

/**
 * «Sí» / «No» ESCRITOS (los botones no salieron o la pregunta salió aprobada desde el buzón). Se
 * compara el mensaje COMPLETO, sin tildes ni signos: «no sé si puedo ir» no es un «no». Pura.
 */
export function respuestaEscritaDeNovedades(texto: string | null | undefined): 'si' | 'no' | null {
    const n = String(texto ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n) return null;
    return SI_ESCRITO.has(n) ? 'si' : NO_ESCRITO.has(n) ? 'no' : null;
}

/**
 * ¿Lo ÚLTIMO que dijo el bot fue esta pregunta y sigue sin respuesta? Solo entonces un «sí» escrito
 * se lee como consentimiento; cualquier otro saliente del bot posterior la cierra. Pura.
 */
export function preguntaDeNovedadesAbierta(
    filas: { direction: string; ai_generated?: boolean | null; payload?: any; wa_timestamp?: string | null; created_at?: string | null }[],
): boolean {
    const momento = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
        new Date(f.wa_timestamp || f.created_at || 0).getTime();
    const ultimo = filas
        .filter((f) => f.direction === 'outbound' && f.ai_generated !== false && f.payload?.step)
        .sort((a, b) => momento(b) - momento(a))[0];
    return !!ultimo && ultimo.payload.step === PASO_CONSENT_NOVEDADES && !ultimo.payload.respuesta;
}

/**
 * ¿Hay algo abierto en lo reciente que no se debe interrumpir? El último saliente del bot trae un
 * flujo con estado (`payload.flujo`: embudo, plan, formulario…) o una pregunta pendiente
 * (`payload.pregunta`). Pura.
 */
export function hayFlujoAbiertoEn(
    filas: { direction: string; ai_generated?: boolean | null; payload?: any; wa_timestamp?: string | null; created_at?: string | null }[],
): boolean {
    const momento = (f: { wa_timestamp?: string | null; created_at?: string | null }) =>
        new Date(f.wa_timestamp || f.created_at || 0).getTime();
    const ultimo = filas
        .filter((f) => f.direction === 'outbound' && f.ai_generated !== false && f.payload?.step)
        .sort((a, b) => momento(b) - momento(a))[0];
    return !!ultimo && Boolean(ultimo.payload.flujo || ultimo.payload.pregunta);
}
