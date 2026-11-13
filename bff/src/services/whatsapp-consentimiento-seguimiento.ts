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
