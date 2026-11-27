/**
 * Modo offline — configuración central (spec docs/specs/modo-offline-y-sincronizacion.md).
 *
 * Interruptor de reversa: `VITE_OFFLINE_MODE=off` apaga TODO lo nuevo (persistencia de
 * lecturas, arranque sin señal, precarga). La app queda como antes. Va encendido por defecto.
 */

export const OFFLINE_ENABLED: boolean = (() => {
  try { return import.meta.env.VITE_OFFLINE_MODE !== 'off'; } catch { return true; }
})();

/**
 * Súbelo cuando cambie la FORMA de los datos de alguna consulta persistida: invalida la copia
 * guardada en los teléfonos (se descarta al arrancar y se vuelve a llenar con red). No es la
 * versión del build a propósito: con el build, cada deploy borraría lo guardado y el que abre
 * la app sin señal justo después de un deploy se quedaría sin nada.
 */
export const OFFLINE_CACHE_VERSION = 1;

/** Cuánto vale un dato guardado como «utilizable sin señal» (spec D3). */
export const OFFLINE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * Lista blanca de consultas que se guardan en el teléfono: por PREFIJO de `queryKey`.
 * Solo lo del flujo del entrenador. Nunca pagos, finanzas, salud ni documentos
 * (`['coach-v2','pago',…]`, `['coach-v2','informes',…]` y `['coach-v2','buscar-refuerzos',…]`
 * quedan fuera a propósito).
 */
export const OFFLINE_QUERY_PREFIXES: readonly (readonly string[])[] = [
  // Asistencia V2
  ['v2-asis-equipos'],
  ['coach-attendance-teams-only'],
  ['v2-asis-planes'],
  ['v2-asis-clases-hoy'],
  ['v2-asis-origen-clase'],
  ['v2-asis-roster'],
  ['v2-asis-sesion'],
  // Inicio / equipos / sesiones del entrenador V2
  ['coach-v2', 'equipos'],
  ['coach-v2', 'deportistas'],
  ['coach-v2', 'sesiones'],
  ['coach-v2', 'sesion'],
  ['coach-v2', 'presentes'],
  ['coach-v2', 'plan-hoy'],
  ['coach-v2', 'partidos'],
  ['coach-v2', 'partidos-proximos'],
  ['v2-ses-rango'],
  ['v2-ses-listas'],
  ['semana-equipos-escuela'],
  // Inicio del deportista V2 (Fase 4, solo lectura). Cada clave lleva el userId y la copia es por
  // usuario. Quedan FUERA a propósito: cobros (plata), informes (datos de salud/desempeño),
  // y `fichas`/`plan`/`torneos-abiertos`, cuyas consultas tragan el error y devuelven `[]`: sin
  // señal, ese `[]` «exitoso» pisaría la copia buena.
  ['athlete-v2-teams'],
  ['athlete-v2-attendance'],
  ['athlete-v2-callups'],
  ['athlete-v2-autoeval'],
  ['athlete-v2-kudos'],
];

/** ¿La `queryKey` pertenece a la lista blanca? (prefijo exacto, elemento a elemento). */
export function esConsultaOffline(queryKey: readonly unknown[]): boolean {
  return OFFLINE_QUERY_PREFIXES.some((prefix) =>
    prefix.length <= queryKey.length && prefix.every((p, i) => queryKey[i] === p),
  );
}

/** true solo si el navegador AFIRMA que no hay red. */
export function sinRedAhora(): boolean {
  try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch { return false; }
}
