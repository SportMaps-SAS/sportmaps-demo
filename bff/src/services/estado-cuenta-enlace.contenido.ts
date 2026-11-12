/**
 * estado-cuenta-enlace.contenido — lo que ve quien abre https://app.sportmaps.co/e/<token>
 * y el correo que lo acompaña. Funciones PURAS: sin base, sin red, sin reloj propio.
 *
 * Plan: docs/specs/estado-de-cuenta-envio-a-familias.md (§3 y §4.2).
 *
 * El enlace es una CREDENCIAL: quien lo reenvíe da acceso a lo de aquí. Por eso
 * esta capa es el único lugar que decide qué sale y se prueba campo por campo:
 *   · nombre CORTO del deportista («Valentina O.»), también dentro del concepto
 *     de cada cobro («Mensualidad 09/2026 - ISABELLA ALFONSO» pierde el nombre);
 *   · ids opacos por cobro (`c1`, `c2`…), nunca los de la base;
 *   · el comprobante y la pasarela solo salen como «hay/no hay» (`receipt_url`
 *     vale 'recibido' o null): la ruta del archivo en el almacenamiento no sale;
 *   · la asistencia sale RESUMIDA por mes: nunca la fecha de cada clase;
 *   · nada de correo, teléfono, documento, notas internas ni referencias bancarias.
 */

/**
 * Igual que `nombreCorto` de cobro-enlace-publico.service («Valentina Ospina» →
 * «Valentina O.»). Copiado a propósito: este módulo es puro y no importa nada que
 * toque la base (la prueba de que `/e/:token` y `/p/:token` abrevian igual está en
 * estado-cuenta-enlace.contenido.test.ts).
 */
export function nombreCorto(full: string | null | undefined): string | null {
    const partes = String(full ?? '').trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0) return null;
    if (partes.length === 1) return partes[0];
    return `${partes[0]} ${partes[1].charAt(0).toUpperCase()}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entradas (filas de la base) y salida (la vista pública)
// ─────────────────────────────────────────────────────────────────────────────

export interface PagoFila {
    status: string;
    amount: number | string | null;
    amount_paid?: number | string | null;
    late_fee_amount?: number | string | null;
    concept: string | null;
    due_date: string | null;
    payment_date: string | null;
    period_year: number | null;
    period_month: number | null;
    created_at: string;
    payment_method?: string | null;
    payment_channel?: string | null;
    payment_provider?: string | null;
    receipt_url?: string | null;
    wompi_reference?: string | null;
    wompi_transaction_id?: string | null;
    provider_transaction_id?: string | null;
}

export interface AsistenciaFila { attendance_date: string; status: string | null }

export interface AsistenciaMes { asistio: number; tarde: number; excusada: number; falto: number; total: number }

export interface ResumenCuenta {
    count_expected: number; total_expected: number;
    count_settled: number; total_settled: number;
    count_open: number; total_open: number;
    total_late_fees: number;
}

/** Un cobro tal como sale por el enlace: sin ids de la base, sin rutas, sin nombre completo. */
export interface CobroPublico {
    id: string;
    status: string;
    amount: number | null;
    amount_paid: number | null;
    concept: string | null;
    due_date: string | null;
    payment_date: string | null;
    period_year: number | null;
    period_month: number | null;
    created_at: string;
    payment_method: string | null;
    payment_channel: string | null;
    payment_provider: string | null;
    /** 'recibido' si la escuela tiene el comprobante; la ruta del archivo NUNCA sale. */
    receipt_url: 'recibido' | null;
    /** 'x' si el pago lo confirmó una pasarela (solo para decir «pago en línea»). */
    wompi_reference: 'x' | null;
}

export interface AtletaPublico {
    nombre: string;
    resumen: ResumenCuenta;
    cobros: CobroPublico[];
    /** `YYYY-MM` → asistencia resumida del mes. */
    asistencia: Record<string, AsistenciaMes>;
}

export interface VistaEstadoPublico {
    escuela: { nombre: string; logoUrl: string | null; colorPrimario: string; mostrarMarcaSportmaps: boolean };
    generadoEn: string;
    periodo: { desde: string; hasta: string; meses: number };
    enlaceVenceEn: string;
    atletas: AtletaPublico[];
    /** Enlace de cobro (/p/<token>) del cobro abierto más viejo, o null si no debe nada. */
    pagarUrl: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Período
// ─────────────────────────────────────────────────────────────────────────────

/** Hoy en Colombia (YYYY-MM-DD), sin depender de la zona del servidor. */
export function hoyColombia(ahora: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

/** Los últimos `meses` meses: desde el día 1 del mes más viejo hasta hoy. */
export function ventanaDe(ahora: Date, meses: number): { desde: string; hasta: string } {
    const n = Math.min(Math.max(Math.floor(meses) || 12, 1), 36);
    const hasta = hoyColombia(ahora);
    const [a, m] = hasta.split('-').map(Number);
    const indice = a * 12 + (m - 1) - (n - 1);
    const anio = Math.floor(indice / 12);
    const mes = (indice % 12) + 1;
    return { desde: `${anio}-${String(mes).padStart(2, '0')}-01`, hasta };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recorte de datos
// ─────────────────────────────────────────────────────────────────────────────

/** Minúsculas y sin tildes, para comparar «Ángel» con «ANGEL». */
const plano = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Palabras que no identifican a nadie: no se usan para reconocer el nombre dentro de un concepto. */
const PARTICULAS = new Set(['del', 'las', 'los', 'san', 'santa', 'van', 'von', 'dos']);

/**
 * El concepto de un cobro casi siempre trae el nombre del deportista:
 * «Mensualidad 09/2026 - ISABELLA ALFONSO», pero también con errores de la carga
 * («Sngel Felipe Torres (CLUB DEPORTIVO BESSER)» por «Ángel Felipe Torres»), solo con el
 * primer nombre, sin tildes o con otro orden. Un enlace que se puede reenviar no puede
 * soltar apellidos de un menor, así que se limpia en dos pasos:
 *   1. se descarta cada parte entre guiones que sea el nombre completo o que comparta
 *      una palabra con él (y no tenga números: «Plan 4 días» no es un nombre);
 *   2. del texto que queda se quita cualquier palabra del nombre, con o sin tilde.
 * Lo que sobra es el concepto («Mensualidad 09/2026»). Si no sobra nada, null.
 */
export function quitarNombreDelConcepto(concepto: string | null | undefined, nombreCompleto: string | null | undefined): string | null {
    const c = String(concepto ?? '').trim();
    if (!c) return null;
    const nombre = String(nombreCompleto ?? '').trim().replace(/\s+/g, ' ');
    if (!nombre) return c;

    const nombrePlano = plano(nombre);
    const palabras = new Set(
        nombrePlano.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PARTICULAS.has(w)),
    );

    const conservadas = c.split(/\s+[-—–]\s+/).filter((parte) => {
        const crudo = plano(parte).replace(/\s+/g, ' ').trim();
        const sinParentesis = plano(parte.replace(/\([^)]*\)/g, ' ')).replace(/\s+/g, ' ').trim();
        if (!sinParentesis) return false;                                   // era solo «(CLUB …)»
        if (crudo === nombrePlano || sinParentesis === nombrePlano) return false;
        if (/\d/.test(parte)) return true;                                   // «Mensualidad 09/2026», «Plan 4 días»
        return !sinParentesis.split(/[^a-z0-9]+/).some((w) => palabras.has(w));
    });

    const unido = conservadas.join(' · ');
    // Paso 2: ninguna palabra del nombre queda suelta en el texto (apellidos incluidos).
    let limpio = '';
    let desde = 0;
    for (const m of unido.matchAll(/[\p{L}\p{N}]+/gu)) {
        if (palabras.has(plano(m[0]))) {
            limpio += unido.slice(desde, m.index);
            desde = (m.index ?? 0) + m[0].length;
        }
    }
    limpio += unido.slice(desde);
    const final = limpio.replace(/\s{2,}/g, ' ').replace(/\(\s*\)/g, '').replace(/^[\s·-]+|[\s·-]+$/g, '').trim();
    return final || null;
}

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v) || 0);
const numOrNull = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

/** Un cobro de la base → un cobro publicable. `indice` da el id opaco. */
export function cobroPublico(p: PagoFila, indice: number, nombreCompleto: string | null): CobroPublico {
    const pasarela = p.payment_channel === 'online' || !!p.wompi_reference || !!p.wompi_transaction_id || !!p.provider_transaction_id;
    return {
        id: `c${indice + 1}`,
        status: p.status,
        amount: numOrNull(p.amount),
        amount_paid: numOrNull(p.amount_paid),
        concept: quitarNombreDelConcepto(p.concept, nombreCompleto),
        due_date: p.due_date ? String(p.due_date).slice(0, 10) : null,
        payment_date: p.payment_date ? String(p.payment_date).slice(0, 10) : null,
        period_year: p.period_year ?? null,
        period_month: p.period_month ?? null,
        created_at: p.created_at,
        payment_method: p.payment_method ?? null,
        payment_channel: p.payment_channel ?? null,
        payment_provider: p.payment_provider ?? null,
        receipt_url: p.receipt_url ? 'recibido' : null,
        wompi_reference: pasarela ? 'x' : null,
    };
}

/**
 * Misma cuenta que `get_athlete_account_statement` (summary, SIN ventana: una
 * deuda vieja cuenta aunque quede fuera de los últimos meses).
 */
export function resumenDeCobros(pagos: PagoFila[]): ResumenCuenta {
    const vivos = pagos.filter((p) => p.status !== 'cancelled' && p.status !== 'rejected');
    const pagados = pagos.filter((p) => p.status === 'paid');
    const parciales = pagos.filter((p) => p.status === 'partial');
    const total_expected = vivos.reduce((s, p) => s + num(p.amount), 0);
    const total_settled = pagados.reduce((s, p) => s + num(p.amount), 0) + parciales.reduce((s, p) => s + num(p.amount_paid), 0);
    const count_expected = vivos.length;
    const count_settled = pagados.length + parciales.length;
    return {
        count_expected, total_expected,
        count_settled, total_settled,
        count_open: count_expected - count_settled,
        total_open: total_expected - total_settled,
        total_late_fees: vivos.reduce((s, p) => s + num(p.late_fee_amount), 0),
    };
}

/** Estados en los que el cobro sigue vivo: se muestran aunque sean de antes de la ventana. */
const ESTADOS_ABIERTOS = ['pending', 'overdue', 'partial', 'awaiting_approval', 'glosado', 'rejected', 'failed'];

/** `YYYY-MM` del cobro: el PERIODO, y si falta, la fecha límite o de creación. */
export function mesDelCobro(p: Pick<PagoFila, 'period_year' | 'period_month' | 'due_date' | 'payment_date' | 'created_at'>): string | null {
    if (p.period_year && p.period_month) return `${p.period_year}-${String(p.period_month).padStart(2, '0')}`;
    const f = p.due_date || p.payment_date || p.created_at;
    return f ? String(f).slice(0, 7) : null;
}

/** Cobros que se muestran: los de la ventana y los que siguen abiertos aunque sean más viejos. Los anulados no. */
export function cobrosVisibles(pagos: PagoFila[], desde: string): PagoFila[] {
    const desdeMes = desde.slice(0, 7);
    return pagos.filter((p) => {
        if (p.status === 'cancelled') return false;
        const mes = mesDelCobro(p);
        if (!mes) return false;
        return mes >= desdeMes || ESTADOS_ABIERTOS.includes(p.status);
    });
}

/** Asistencia resumida por mes. Presente y tarde cuentan como «asistió»; una clase con un estado desconocido suma al total y a nada más. */
export function asistenciaPorMes(filas: AsistenciaFila[]): Record<string, AsistenciaMes> {
    const out: Record<string, AsistenciaMes> = {};
    for (const f of filas) {
        if (!f.attendance_date) continue;
        const k = String(f.attendance_date).slice(0, 7);
        const a = (out[k] ??= { asistio: 0, tarde: 0, excusada: 0, falto: 0, total: 0 });
        a.total++;
        if (f.status === 'present') a.asistio++;
        else if (f.status === 'late') { a.asistio++; a.tarde++; }
        else if (f.status === 'excused') a.excusada++;
        else if (f.status === 'absent') a.falto++;
    }
    return out;
}

/** Un deportista completo, listo para publicar. */
export function atletaPublico(p: {
    nombreCompleto: string | null; pagos: PagoFila[]; asistencia: AsistenciaFila[]; desde: string;
}): AtletaPublico {
    const visibles = cobrosVisibles(p.pagos, p.desde)
        .sort((a, b) => String(a.due_date ?? a.created_at).localeCompare(String(b.due_date ?? b.created_at)));
    return {
        nombre: nombreCorto(p.nombreCompleto) ?? 'Deportista',
        resumen: resumenDeCobros(p.pagos),
        cobros: visibles.map((c, i) => cobroPublico(c, i, p.nombreCompleto)),
        asistencia: asistenciaPorMes(p.asistencia.filter((a) => String(a.attendance_date).slice(0, 10) >= p.desde)),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// El correo
// ─────────────────────────────────────────────────────────────────────────────

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** «carolina@gmail.com» → «c•••••@gmail.com» (para decir a dónde llegará sin mostrar el correo entero). */
export function enmascararCorreo(correo: string): string {
    const [usuario, dominio] = String(correo).split('@');
    if (!dominio) return '•••';
    return `${usuario.charAt(0)}${'•'.repeat(Math.max(2, Math.min(usuario.length - 1, 6)))}@${dominio}`;
}

/** Clave de idempotencia del envío: una por familia y día; un reenvío tiene la suya. */
export function claveEnvioEstadoEnlace(p: { schoolId: string; familia: string; dia: string; reenvio: boolean }): string {
    return `${p.reenvio ? 'estado_cuenta_enlace_reenvio' : 'estado_cuenta_enlace'}:${p.schoolId}:${p.familia}:${p.dia}`;
}

export interface ResumenCorreoAtleta {
    nombre: string;
    debe: number;
    pagado: number;
    cobrosAbiertos: number;
    pagosATiempo: number;
    pagosTotales: number;
    clasesAsistidas: number;
    clasesTotales: number;
}

/** Resumen corto de un deportista para el correo, a partir de lo que ya se publica. */
export function resumenParaCorreo(a: AtletaPublico): ResumenCorreoAtleta {
    const pagados = a.cobros.filter((c) => c.status === 'paid' || c.status === 'approved');
    const aTiempo = pagados.filter((c) => c.due_date && c.payment_date && c.payment_date <= c.due_date).length;
    const asist = Object.values(a.asistencia);
    return {
        nombre: a.nombre,
        debe: Math.max(0, a.resumen.total_open),
        pagado: a.resumen.total_settled,
        cobrosAbiertos: a.resumen.count_open,
        pagosATiempo: aTiempo,
        pagosTotales: pagados.length,
        clasesAsistidas: asist.reduce((s, m) => s + m.asistio, 0),
        clasesTotales: asist.reduce((s, m) => s + m.total, 0),
    };
}

/** Cuerpo del correo (lo envuelve buildBrandedEmail, que pone logo, colores y el botón). Todo valor variable va escapado. */
export function cuerpoCorreoEstadoEnlace(p: { escuela: string; atletas: ResumenCorreoAtleta[]; meses: number }): string {
    const filas = p.atletas.map((a) => `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;"><strong>${escapar(a.nombre)}</strong></td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${cop(a.pagado)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;${a.debe > 0 ? 'color:#b91c1c;font-weight:bold;' : ''}">${a.debe > 0 ? cop(a.debe) : 'Al día'}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${a.pagosTotales ? `${a.pagosATiempo} de ${a.pagosTotales}` : '—'}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${a.clasesTotales ? `${a.clasesAsistidas} de ${a.clasesTotales}` : '—'}</td>
        </tr>`).join('');
    return `
        <p>Este es el estado de cuenta de <strong>${escapar(p.escuela)}</strong> de los últimos ${p.meses} ${p.meses === 1 ? 'mes' : 'meses'}: lo que se cobró, cuándo era el límite, cuándo y cómo se pagó, y la asistencia.</p>
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;margin:12px 0;">
          <tr style="background:#f5f5f5;">
            <th align="left" style="padding:6px 8px;">Deportista</th>
            <th align="right" style="padding:6px 8px;">Pagado</th>
            <th align="right" style="padding:6px 8px;">Debe</th>
            <th align="right" style="padding:6px 8px;">Pagos a tiempo</th>
            <th align="right" style="padding:6px 8px;">Clases</th>
          </tr>
          ${filas}
        </table>
        <p style="font-size:13px;color:#555;">El botón te lleva al detalle mes a mes. No necesitas iniciar sesión, y puedes guardarlo como PDF desde esa página.</p>`;
}
