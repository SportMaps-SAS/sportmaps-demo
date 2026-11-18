/**
 * Qué escuelas reciben el «resumen de cuentas» cada 4 horas (resumen-cuentas.job).
 *
 * `RESUMEN_CUENTAS_ESCUELAS` = ids separados por coma. Vacía o sin definir = NADIE (lo seguro).
 * Hoy: Monster´s Volley y Dynasty. Sumar o quitar una escuela = cambiar la variable, sin código ni base.
 *
 * Vive aparte para que `pagos-por-validar.job` (el resumen de siempre) lo lea sin importar el job nuevo:
 * las escuelas de esta lista NO reciben además el correo viejo (sería el mismo aviso dos veces).
 */
export function idsConResumenDeCuentas(env: NodeJS.ProcessEnv = process.env): Set<string> {
    return new Set((env.RESUMEN_CUENTAS_ESCUELAS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}
