/**
 * Guardar una autoevaluación post-entreno en el teléfono cuando no hay señal (o se cayó al enviar).
 * Lo usan la tarjeta «¿Qué tan duro fue?» del deportista y el formulario completo (deportista o acudiente).
 */
import { OFFLINE_ENABLED } from './offlineConfig';
import { obtenerBandeja } from './useBandeja';
import { esErrorDeRed } from './bandejaEvaluar';
import { fusionarAutoeval, idAutoeval, TIPO_AUTOEVAL, type PayloadAutoeval } from './bandejaAutoeval';

/** ¿Vale la pena guardarla en el teléfono en vez de mostrar un error? Solo si faltó la señal. */
export function faltoLaSenal(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const e = error as { code?: string | null; message?: string | null } | null | undefined;
  return esErrorDeRed(e ?? { message: error instanceof Error ? error.message : String(error ?? '') });
}

/**
 * Devuelve true si quedó guardada. `fusionar`: el «un toque» no pisa lo que ya había en el formulario completo.
 * No guarda con el modo offline apagado (VITE_OFFLINE_MODE=off): el llamador muestra su error de siempre.
 */
export async function guardarAutoeval(
  userId: string | null | undefined,
  datos: PayloadAutoeval,
  etiqueta: string,
  opciones: { fusionar?: boolean } = {},
): Promise<boolean> {
  if (!OFFLINE_ENABLED || !userId) return false;
  try {
    await obtenerBandeja(userId).bandeja.encolar(
      { id: idAutoeval(datos.sessionId, datos.sujeto), tipo: TIPO_AUTOEVAL, schoolId: null, payload: datos, etiqueta },
      opciones.fusionar ? fusionarAutoeval : undefined,
    );
    return true;
  } catch (e) {
    console.error('[offline] no se pudo guardar la autoevaluación en el teléfono', e);
    return false;
  }
}
