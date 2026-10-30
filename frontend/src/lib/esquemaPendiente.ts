/**
 * ¿La base todavía no tiene esto? Las migraciones se aplican a mano y al final
 * (docs/specs/whatsapp-monster-plan-maestro.md §1): el código sale ANTES que la
 * columna, la tabla o la RPC. Cuando falta, la pantalla OCULTA el control y
 * sigue como hoy; nunca muestra el error al usuario.
 *
 *  · Tabla o función que no existe: PGRST202 (función fuera del caché de
 *    esquema), PGRST205 (tabla), 42883 (función), 42P01 (relación), 404.
 *    Los mismos códigos que `esNoDisponible` de lib/api/v2Contratos.
 *  · Columna que no existe: 42703 (SELECT o filtro) y PGRST204
 *    («Could not find the 'x' column of 'y' in the schema cache», INSERT/UPDATE).
 *
 * Puro a propósito (sin cliente de Supabase): lo usan modelos y pruebas.
 */

export interface ErrorDeBase {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

const CODIGOS_FALTA = ['PGRST202', 'PGRST205', 'PGRST204', '42883', '42P01', '42703'];

export function faltaEnLaBase(error: ErrorDeBase | null | undefined, status?: number): boolean {
  if (!error) return false;
  if (status === 404) return true;
  if (CODIGOS_FALTA.includes(error.code ?? '')) return true;
  return /could not find the (function|table|.* column)|schema cache|column .* does not exist/i.test(error.message ?? '');
}

/** ¿El error es justo por ESTA columna? (para reintentar sin ella). */
export function faltaLaColumna(error: ErrorDeBase | null | undefined, columna: string): boolean {
  if (!error) return false;
  const msg = error.message ?? '';
  if (error.code !== '42703' && error.code !== 'PGRST204' && !/column/i.test(msg)) return false;
  return msg.includes(columna);
}
