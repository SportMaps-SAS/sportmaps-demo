/**
 * Fechas del agente (plan §11). El modelo entrega ISO (AAAA-MM-DD); el servidor
 * valida y la tarjeta muestra SIEMPRE día, mes y año completos: esa es la
 * verificación humana de que «del 3 al 10» se entendió bien.
 * Todo es fecha calendario (sin hora): se opera en UTC para no correr el día.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function esFechaIso(s: unknown): s is string {
    if (typeof s !== 'string' || !ISO.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function sumarDias(iso: string, n: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Días entre dos fechas (b - a), sin incluir. */
export function diferenciaDias(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Todas las fechas del rango, ambas incluidas. */
export function diasDelRango(desde: string, hasta: string): string[] {
    const out: string[] = [];
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) out.push(d);
    return out;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', ...opts });
const fDiaSemana = fmt({ weekday: 'long' });
const fMes = fmt({ month: 'long' });

function partes(iso: string) {
    const d = new Date(`${iso}T00:00:00Z`);
    return { semana: fDiaSemana.format(d), dia: d.getUTCDate(), mes: fMes.format(d), anio: d.getUTCFullYear() };
}

/** «lunes 3 de noviembre de 2026» */
export function fechaLarga(iso: string): string {
    const p = partes(iso);
    return `${p.semana} ${p.dia} de ${p.mes} de ${p.anio}`;
}

/** «del lunes 3 al lunes 10 de noviembre de 2026», o «el lunes 3 de noviembre de 2026» si es un día. */
export function rangoLegible(desde: string, hasta: string): string {
    if (desde === hasta) return `el ${fechaLarga(desde)}`;
    const a = partes(desde);
    const b = partes(hasta);
    if (a.anio !== b.anio) return `del ${fechaLarga(desde)} al ${fechaLarga(hasta)}`;
    if (a.mes !== b.mes) return `del ${a.semana} ${a.dia} de ${a.mes} al ${b.semana} ${b.dia} de ${b.mes} de ${b.anio}`;
    return `del ${a.semana} ${a.dia} al ${b.semana} ${b.dia} de ${b.mes} de ${b.anio}`;
}

/** «3 de noviembre» (para listas). */
export function fechaCorta(iso: string): string {
    const p = partes(iso);
    return `${p.dia} de ${p.mes}`;
}

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
export function esMes(s: unknown): s is string {
    return typeof s === 'string' && MES.test(s);
}

/** Primer y último día de un mes AAAA-MM. */
export function limitesDelMes(mes: string): { desde: string; hasta: string } {
    const [y, m] = mes.split('-').map(Number);
    const fin = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { desde: `${mes}-01`, hasta: `${mes}-${String(fin).padStart(2, '0')}` };
}

export function nombreDelMes(mes: string): string {
    const p = partes(`${mes}-01`);
    return `${p.mes} de ${p.anio}`;
}
