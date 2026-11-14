/**
 * Escalera de avisos de saldo del banco de horas — lógica PURA (sin base ni red).
 * Plan: docs/specs/dreamers-horas-agotadas-bloqueo-y-excedentes-automaticos.md §2.1.
 *
 * Reglas:
 *  · El saldo para avisar es el «disponible para ENTRAR»: included − consumed
 *    (las reservas pendientes NO cuentan; ver plan §6-7).
 *  · Hay dos clases de escalón en la MISMA escalera: por porcentaje (los configurados en
 *    hour_bank_balance_notice_steps, clave «50») y por clases que quedan (CLASES_A_AVISAR,
 *    clave «c2»), contadas con el bloque del plan. Los de clases solo existen si la escuela
 *    tiene avisos encendidos (pedido de Dreamers 2026-10-29: mitad, 2 clases, 1 clase, agotado).
 *  · Un escalón sale la PRIMERA vez que se observa el saldo en o por debajo de su umbral,
 *    y una sola vez por inscripción y período.
 *  · Si de un golpe se cruzan varios escalones (p. ej. de 80 % a 15 %) se avisa SOLO el más
 *    severo y los demás se marcan como enviados en silencio (dos mensajes seguidos cansan).
 *  · Si el saldo vuelve a subir por encima del umbral (recarga de horas), la marca de ese
 *    escalón se borra y una segunda bajada vuelve a avisar.
 */

export type EscalonMarca = Record<string, string>; // {"20": "2026-10-12T15:04:05Z"}

export const ESCALONES_POR_DEFECTO = [50, 20, 0] as const;

/** Escalones válidos de la configuración: enteros 0..100, sin repetir, de mayor a menor. */
export function normalizarEscalones(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    const out = new Set<number>();
    for (const v of raw) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n <= 100) out.add(n);
    }
    return [...out].sort((a, b) => b - a);
}

/** Porcentaje de horas que le quedan (0..100). null si el período no tiene horas incluidas. */
export function porcentajeRestante(includedMinutes: number, consumedMinutes: number): number | null {
    const inc = Number(includedMinutes);
    if (!(inc > 0)) return null;
    const restante = inc - Math.max(0, Number(consumedMinutes) || 0);
    return Math.max(0, Math.min(100, (restante / inc) * 100));
}

/** Avisos por clases que quedan; se suman a los de porcentaje cuando la escuela tiene avisos encendidos. */
export const CLASES_A_AVISAR = [2, 1] as const;

export interface Umbral {
    /** Clave en hour_bank_periods.balance_notices: «50» (porcentaje) o «c2» (clases). */
    clave: string;
    tipo: 'pct' | 'clases';
    valor: number;
    /** Se avisa cuando el saldo queda en o por debajo de estos minutos. */
    minutos: number;
}

/**
 * La escalera de un período: los porcentajes configurados más «quedan 2 clases» y «queda 1
 * clase» según el bloque del plan. Un escalón de clases que no cabe en el plan (bloque × N ≥
 * incluidas) se omite: saldría con la primera visita y no diría nada útil.
 */
export function umbralesDelPeriodo(steps: number[], incluidoMinutos: number, bloqueMinutos: number): Umbral[] {
    const inc = Number(incluidoMinutos);
    if (!(inc > 0) || steps.length === 0) return [];
    const out: Umbral[] = steps.map((s) => ({ clave: String(s), tipo: 'pct', valor: s, minutos: (inc * s) / 100 }));
    if (bloqueMinutos > 0) {
        for (const n of CLASES_A_AVISAR) {
            if (n * bloqueMinutos < inc) out.push({ clave: `c${n}`, tipo: 'clases', valor: n, minutos: n * bloqueMinutos });
        }
    }
    return out;
}

export interface DecisionDeAvisos {
    /** Escalón a avisar ahora (el más severo cruzado y no enviado), o null. */
    aEnviar: Umbral | null;
    /** Claves cruzadas que se marcan como enviadas sin avisar (el resto de las cruzadas). */
    marcarEnSilencio: string[];
    /** Claves a borrar porque el saldo volvió a subir por encima del umbral. */
    borrarMarcas: string[];
}

/** Qué hacer con la escalera dado el saldo (minutos) y las marcas ya enviadas. */
export function decidirAvisos(umbrales: Umbral[], restanteMinutos: number, marcas: EscalonMarca): DecisionDeAvisos {
    if (umbrales.length === 0) return { aEnviar: null, marcarEnSilencio: [], borrarMarcas: [] };
    const restante = Math.max(0, Number(restanteMinutos) || 0);

    const marcado = (u: Umbral) => Object.prototype.hasOwnProperty.call(marcas, u.clave);
    // Recarga: un escalón marcado cuyo umbral el saldo ya superó se puede volver a avisar.
    const borrarMarcas = umbrales.filter((u) => marcado(u) && restante > u.minutos).map((u) => u.clave);

    // El de menos minutos = más severo; a igual umbral gana el de clases (dice más).
    const cruzadosSinAvisar = umbrales
        .filter((u) => restante <= u.minutos && !marcado(u))
        .sort((a, b) => a.minutos - b.minutos || (a.tipo === b.tipo ? 0 : a.tipo === 'clases' ? -1 : 1));
    if (cruzadosSinAvisar.length === 0) return { aEnviar: null, marcarEnSilencio: [], borrarMarcas };
    const [masSevero, ...resto] = cruzadosSinAvisar;
    return { aEnviar: masSevero, marcarEnSilencio: resto.map((u) => u.clave), borrarMarcas };
}

/** Marcas resultantes tras aplicar la decisión (no muta la entrada). */
export function aplicarDecision(marcas: EscalonMarca, d: DecisionDeAvisos, ahoraIso: string): EscalonMarca {
    const out: EscalonMarca = { ...marcas };
    for (const k of d.borrarMarcas) delete out[k];
    for (const k of d.marcarEnSilencio) out[k] = ahoraIso;
    if (d.aEnviar !== null) out[d.aEnviar.clave] = ahoraIso;
    return out;
}

/** «2 h», «1 h 30 min», «45 min», «0 h». Mismo formato que formatHourBankMinutes del banco de horas. */
export function formatoHoras(minutos: number): string {
    const abs = Math.max(0, Math.round(minutos));
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (h === 0 && m === 0) return '0 h';
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${m} min`;
}

/** Clases de `bloque` minutos que todavía caben en el saldo (siempre entero, nunca negativo). */
export function clasesRestantes(minutosRestantes: number, bloqueMinutos: number): number {
    if (!(bloqueMinutos > 0)) return 0;
    return Math.max(0, Math.floor(Math.max(0, minutosRestantes) / bloqueMinutos));
}

export interface ContextoMensaje {
    aviso: Pick<Umbral, 'tipo' | 'valor'>;
    atleta: string;
    restanteMinutos: number;
    incluidoMinutos: number;
    bloqueMinutos: number;
    /** «1 de noviembre», ya formateada (se renueva el día 1). */
    seRenueva: string;
    momento: 'entrada' | 'cierre';
    /** true cuando el bloqueo físico está encendido (hoy nunca; reservado para cuando exista). */
    conBloqueo?: boolean;
}

export interface MensajeDeSaldo {
    titulo: string;
    cuerpo: string;
    severidad: 'info' | 'aviso' | 'critico';
}

/** «13 %». Redondeado a entero; nunca dice «0 %» si todavía queda algo. */
export function formatoPorcentaje(restanteMinutos: number, incluidoMinutos: number): string {
    const pct = porcentajeRestante(incluidoMinutos, incluidoMinutos - restanteMinutos) ?? 0;
    return `${pct > 0 && pct < 1 ? 1 : Math.round(pct)} %`;
}

/** Texto del aviso. Siempre dice cuánto le queda en horas, clases y porcentaje, y cuándo se renueva. */
export function armarMensaje(c: ContextoMensaje): MensajeDeSaldo {
    const quedan = formatoHoras(c.restanteMinutos);
    const clases = clasesRestantes(c.restanteMinutos, c.bloqueMinutos);
    const renueva = `Las horas se renuevan el ${c.seRenueva}; las que no se usen no pasan al mes siguiente.`;
    const saldo = `${quedan} de las ${formatoHoras(c.incluidoMinutos)} de este mes (${formatoPorcentaje(c.restanteMinutos, c.incluidoMinutos)})`;
    const alcanzan = clases >= 1
        ? ` Alcanzan para ${clases} ${clases === 1 ? 'clase más' : 'clases más'} de ${formatoHoras(c.bloqueMinutos)}.`
        : ' Ya no alcanza para una clase completa.';
    const entrada = c.momento === 'entrada' ? `${c.atleta} acaba de entrar y ` : '';
    const cuerpo = `${entrada}${entrada ? 'le' : 'Le'} quedan ${saldo}.${alcanzan} ${renueva}`;

    if ((c.aviso.tipo === 'pct' && c.aviso.valor <= 0) || c.restanteMinutos <= 0) {
        return {
            titulo: `${c.atleta} ya usó todas sus horas`,
            cuerpo: `Con la visita de hoy, ${c.atleta} usó las ${formatoHoras(c.incluidoMinutos)} de su plan de este mes. `
                + `Para seguir entrenando antes del ${c.seRenueva} puede pedir más horas a la escuela. ${renueva}`
                + (c.conBloqueo ? ' Desde su próxima visita el lector no abrirá hasta que haya saldo.' : ''),
            severidad: 'critico',
        };
    }
    if (c.aviso.tipo === 'clases') {
        // El título cuenta las clases que de verdad caben (pudo bajar más de un bloque de golpe).
        const titulo = clases >= 1
            ? `A ${c.atleta} ${clases === 1 ? 'le queda 1 clase' : `le quedan ${clases} clases`} este mes`
            : `A ${c.atleta} le quedan ${quedan} este mes`;
        return { titulo, cuerpo, severidad: 'aviso' };
    }
    if (c.aviso.valor >= 50) {
        return { titulo: `${c.atleta} ya usó la mitad de sus horas`, cuerpo, severidad: 'info' };
    }
    return { titulo: `A ${c.atleta} le quedan ${quedan} este mes`, cuerpo, severidad: 'aviso' };
}

/** Día 1 del mes siguiente a `periodEnd` (YYYY-MM-DD) o al mes de `hoy`, en español: «1 de noviembre». */
export function fechaDeRenovacion(periodEnd: string | null | undefined, hoy: string): string {
    const base = (periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ? periodEnd : hoy);
    const [y, m] = base.split('-').map(Number);
    const sig = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `1 de ${meses[sig.getUTCMonth()]}`;
}

/** ¿Es hora de mandar correos? 8:00–19:59 hora Colombia (las horas fuera de ventana se difieren). */
export function dentroDeHorarioDeCorreo(ahora: Date): boolean {
    const hBogota = (ahora.getUTCHours() + 24 - 5) % 24;
    return hBogota >= 8 && hBogota < 20;
}
