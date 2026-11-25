/**
 * bot-ofertas.service — QUÉ puede ofrecer hoy el bot de WhatsApp de una escuela.
 *
 * Único lugar que contesta dos preguntas que antes vivían repartidas (y fijas)
 * en el código del bot:
 *
 *   1. ¿Hoy se puede ofrecer la CLASE DE PRUEBA? (interruptor de la escuela
 *      `school_trial_class_settings.enabled/whatsapp_enabled` + bloqueos por
 *      fecha en `bot_oferta_bloqueos`). Y, para una fecha concreta, ¿se puede
 *      agendar ese día? (una franja del 5-dic no se ofrece si diciembre está
 *      bloqueado, aunque hoy sea 26-nov).
 *   2. ¿Qué OFERTAS hay vigentes? (`bot_ofertas` activas, dentro de su vigencia,
 *      con sus `bot_oferta_sesiones` que aún no pasaron, en America/Bogota).
 *
 * Origen: Monster's Volley, 2026-11-25. En diciembre y enero no hay clases de
 * prueba y llegaban personas por las CONVOCATORIAS a las que el bot les ofrecía
 * clase de prueba. El interruptor `whatsapp_enabled` solo escondía las franjas:
 * la oferta estaba escrita en ~15 sitios. Todos ellos preguntan aquí.
 *
 * Reglas:
 *   - Nada de contenido de ofertas en código: títulos, fechas, lugares y el
 *     «cómo inscribirse» salen de la base. Aquí solo hay andamiaje (formato y
 *     las reglas para el modelo).
 *   - Falla CERRADO para la clase de prueba: si no se puede leer la base y no hay
 *     una lectura previa en caché, no se ofrece (perder una oferta un minuto es
 *     menos grave que ofrecerla en plena pausa).
 *   - Nunca lanza.
 */

import { supabase } from '../config/supabase';

export const TIPOS_OFERTA = [
    'convocatoria', 'clase_prueba', 'clinica', 'vacacional', 'cambio_de_grupo', 'torneo', 'otro',
] as const;
export type TipoOferta = typeof TIPOS_OFERTA[number];
export type GeneroOferta = 'femenino' | 'masculino' | 'mixto';

export const ZONA_HORARIA = 'America/Bogota';

export interface SesionOferta {
    id: string;
    /** 'YYYY-MM-DD' */
    fecha: string;
    /** 'HH:MM' */
    horaInicio: string;
    horaFin: string | null;
    lugar: string | null;
    genero: GeneroOferta | null;
    publico: string | null;
    notas: string | null;
}

export interface OfertaBot {
    id: string;
    tipo: TipoOferta;
    titulo: string;
    descripcion: string | null;
    sede: string | null;
    publico: string | null;
    genero: GeneroOferta | null;
    prioridad: number;
    cupos: number | null;
    requiereInscripcion: boolean;
    requierePago: boolean;
    valor: number | null;
    cta: string | null;
    mensajeSinCupos: string | null;
    vigenteHasta: string | null;
    /** Solo las que no han pasado, ordenadas. */
    sesiones: SesionOferta[];
}

export interface BloqueoOferta {
    tipo: TipoOferta;
    desde: string;
    hasta: string;
    motivo: string | null;
}

export interface EstadoClaseDePrueba {
    /** ¿Se puede ofrecer HOY? */
    disponible: boolean;
    motivo: 'apagada' | 'bloqueo' | 'error' | null;
    /** Si está bloqueada hoy: último día del bloqueo ('YYYY-MM-DD'). */
    bloqueadaHasta: string | null;
    /** Si hoy está disponible pero viene un bloqueo: ese bloqueo. */
    proximoBloqueo: BloqueoOferta | null;
}

export interface EstadoOfertas {
    schoolId: string;
    /** 'YYYY-MM-DD' en America/Bogota. */
    hoy: string;
    ofertas: OfertaBot[];
    /** Bloqueos que no han terminado (hasta >= hoy). */
    bloqueos: BloqueoOferta[];
    claseDePrueba: EstadoClaseDePrueba;
    mensajeSinOfertas: string | null;
}

// ─── Fechas (puras) ──────────────────────────────────────────────────────────

const FMT_FECHA = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit',
});
const FMT_HORA = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_HORARIA, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** 'YYYY-MM-DD' de hoy en Bogotá. */
export function hoyBogota(ahora: number = Date.now()): string {
    return FMT_FECHA.format(new Date(ahora));
}

/** 'HH:MM' de ahora en Bogotá. */
export function horaBogota(ahora: number = Date.now()): string {
    return FMT_HORA.format(new Date(ahora)).replace(/^24/, '00');
}

/** Suma días a una fecha 'YYYY-MM-DD' (sin zonas: aritmética de calendario). */
export function sumarDias(fecha: string, dias: number): string {
    const [y, m, d] = fecha.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) + dias * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];

function partes(fecha: string): { y: number; m: number; d: number; dow: number } {
    const [y, m, d] = fecha.split('-').map(Number);
    return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** 'sábado 5 de diciembre' (con el año si no es el de `hoy`). */
export function fechaLegible(fecha: string, hoy?: string): string {
    const p = partes(fecha);
    const anio = hoy && Number(hoy.slice(0, 4)) !== p.y ? ` de ${p.y}` : '';
    return `${DIAS[p.dow]} ${p.d} de ${MESES[p.m - 1]}${anio}`;
}

/** 'sábado 5, domingo 6 y sábado 12 de diciembre' — agrupa por mes. */
export function fechasLegibles(fechas: string[], hoy?: string): string {
    const orden = [...new Set(fechas)].sort();
    const porMes: { clave: string; y: number; m: number; dias: string[] }[] = [];
    for (const f of orden) {
        const p = partes(f);
        const clave = `${p.y}-${p.m}`;
        let g = porMes.find((x) => x.clave === clave);
        if (!g) { g = { clave, y: p.y, m: p.m, dias: [] }; porMes.push(g); }
        g.dias.push(`${DIAS[p.dow]} ${p.d}`);
    }
    const tramos = porMes.map((g) => {
        const anio = hoy && Number(hoy.slice(0, 4)) !== g.y ? ` de ${g.y}` : '';
        return `${unirConY(g.dias)} de ${MESES[g.m - 1]}${anio}`;
    });
    return unirConY(tramos);
}

function unirConY(xs: string[]): string {
    if (xs.length <= 1) return xs[0] ?? '';
    return `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** '19:00' → '7:00 p. m.' */
export function horaLegible(hhmm: string): string {
    const [h, m] = hhmm.split(':').map(Number);
    const sufijo = h < 12 ? 'a. m.' : 'p. m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${sufijo}`;
}

/** '7:00 a 9:00 p. m.' / '7:00 a. m.' */
export function rangoLegible(inicio: string, fin: string | null): string {
    if (!fin) return horaLegible(inicio);
    const a = horaLegible(inicio);
    const b = horaLegible(fin);
    const mismoSufijo = a.slice(-5) === b.slice(-5);
    return mismoSufijo ? `${a.slice(0, -6)} a ${b}` : `${a} a ${b}`;
}

const hhmm = (t: unknown): string => String(t ?? '').slice(0, 5);

// ─── Armado del estado (puro) ────────────────────────────────────────────────

export interface FilasCrudas {
    ofertas: any[];
    sesiones: any[];
    bloqueos: any[];
    /** Fila de school_trial_class_settings (null = sin fila = prendida). */
    ajustesClasePrueba: { enabled?: boolean | null; whatsapp_enabled?: boolean | null } | null;
    mensajeSinOfertas: string | null;
}

/** El bloqueo de `tipo` que cubre `fecha`, si hay. */
export function bloqueoEn(bloqueos: BloqueoOferta[], tipo: TipoOferta, fecha: string): BloqueoOferta | null {
    return bloqueos.find((b) => b.tipo === tipo && b.desde <= fecha && fecha <= b.hasta) ?? null;
}

/** Último día de un bloqueo contando los que lo continúan sin hueco (o se solapan). */
export function finEncadenado(bloqueos: BloqueoOferta[], tipo: TipoOferta, hasta: string): string {
    let fin = hasta;
    let cambio = true;
    while (cambio) {
        cambio = false;
        for (const b of bloqueos) {
            if (b.tipo === tipo && b.desde <= sumarDias(fin, 1) && b.hasta > fin) { fin = b.hasta; cambio = true; }
        }
    }
    return fin;
}

/** ¿Se puede agendar una clase de prueba ese día? (independiente de si hoy se ofrece). */
export function claseDePruebaPermitidaEn(estado: EstadoOfertas, fecha: string): boolean {
    return !bloqueoEn(estado.bloqueos, 'clase_prueba', fecha);
}

export function armarEstado(schoolId: string, filas: FilasCrudas, ahora: number = Date.now()): EstadoOfertas {
    const hoy = hoyBogota(ahora);
    const horaAhora = horaBogota(ahora);

    const bloqueos: BloqueoOferta[] = (filas.bloqueos ?? [])
        .filter((b) => b && TIPOS_OFERTA.includes(b.tipo) && String(b.hasta) >= hoy)
        .map((b) => ({ tipo: b.tipo, desde: String(b.desde), hasta: String(b.hasta), motivo: b.motivo ?? null }))
        .sort((a, b) => a.desde.localeCompare(b.desde));

    const sesionesPorOferta = new Map<string, SesionOferta[]>();
    for (const s of filas.sesiones ?? []) {
        const fecha = String(s.fecha);
        const ini = hhmm(s.hora_inicio);
        const fin = s.hora_fin ? hhmm(s.hora_fin) : null;
        // Pasada: fecha anterior a hoy, o de hoy y ya terminó (o empezó, si no tiene fin).
        if (fecha < hoy) continue;
        if (fecha === hoy && (fin ?? ini) <= horaAhora) continue;
        const lista = sesionesPorOferta.get(s.oferta_id) ?? [];
        lista.push({
            id: s.id, fecha, horaInicio: ini, horaFin: fin, lugar: s.lugar ?? null,
            genero: s.genero ?? null, publico: s.publico ?? null, notas: s.notas ?? null,
        });
        sesionesPorOferta.set(s.oferta_id, lista);
    }
    const conSesionesDefinidas = new Set((filas.sesiones ?? []).map((s) => s.oferta_id));

    const ofertas: OfertaBot[] = [];
    for (const o of filas.ofertas ?? []) {
        if (!o || o.estado !== 'activa' || !TIPOS_OFERTA.includes(o.tipo)) continue;
        if (o.vigente_desde && String(o.vigente_desde) > hoy) continue;
        if (o.vigente_hasta && String(o.vigente_hasta) < hoy) continue;
        if (bloqueoEn(bloqueos, o.tipo, hoy)) continue;
        const sesiones = (sesionesPorOferta.get(o.id) ?? [])
            .sort((a, b) => (a.fecha + a.horaInicio).localeCompare(b.fecha + b.horaInicio));
        // Una oferta que se definió por sesiones y ya no le queda ninguna, venció.
        if (conSesionesDefinidas.has(o.id) && sesiones.length === 0) continue;
        ofertas.push({
            id: o.id, tipo: o.tipo, titulo: o.titulo, descripcion: o.descripcion ?? null,
            sede: o.sede ?? null, publico: o.publico ?? null, genero: o.genero ?? null,
            prioridad: Number(o.prioridad ?? 0), cupos: o.cupos ?? null,
            requiereInscripcion: o.requiere_inscripcion !== false, requierePago: o.requiere_pago === true,
            valor: o.valor == null ? null : Number(o.valor), cta: o.cta ?? null,
            mensajeSinCupos: o.mensaje_sin_cupos ?? null, vigenteHasta: o.vigente_hasta ?? null, sesiones,
        });
    }
    ofertas.sort((a, b) => b.prioridad - a.prioridad
        || (a.sesiones[0]?.fecha ?? '9999').localeCompare(b.sesiones[0]?.fecha ?? '9999')
        || a.titulo.localeCompare(b.titulo));

    const aj = filas.ajustesClasePrueba;
    const prendida = !aj || (aj.enabled !== false && aj.whatsapp_enabled !== false);
    const bloqueoHoy = bloqueoEn(bloqueos, 'clase_prueba', hoy);
    const proximoCrudo = bloqueos.find((b) => b.tipo === 'clase_prueba' && b.desde > hoy) ?? null;
    // Bloqueos pegados (dic en una fila, ene en otra) cuentan como uno solo.
    const proximo = proximoCrudo
        ? { ...proximoCrudo, hasta: finEncadenado(bloqueos, 'clase_prueba', proximoCrudo.hasta) } : null;
    const claseDePrueba: EstadoClaseDePrueba = !prendida
        ? { disponible: false, motivo: 'apagada', bloqueadaHasta: null, proximoBloqueo: null }
        : bloqueoHoy
            ? { disponible: false, motivo: 'bloqueo', bloqueadaHasta: finEncadenado(bloqueos, 'clase_prueba', bloqueoHoy.hasta), proximoBloqueo: null }
            : { disponible: true, motivo: null, bloqueadaHasta: null, proximoBloqueo: proximo };

    const msg = (filas.mensajeSinOfertas ?? '').trim();
    return { schoolId, hoy, ofertas, bloqueos, claseDePrueba, mensajeSinOfertas: msg || null };
}

/** Estado vacío y cerrado para la clase de prueba (error de lectura sin caché). */
export function estadoCerrado(schoolId: string, ahora: number = Date.now()): EstadoOfertas {
    return {
        schoolId, hoy: hoyBogota(ahora), ofertas: [], bloqueos: [],
        claseDePrueba: { disponible: false, motivo: 'error', bloqueadaHasta: null, proximoBloqueo: null },
        mensajeSinOfertas: null,
    };
}

// ─── Lectura con caché ───────────────────────────────────────────────────────

const TTL_MS = 60_000;
const cache = new Map<string, { estado: EstadoOfertas; vence: number; filas: FilasCrudas }>();

export function invalidarCacheOfertas(schoolId?: string): void {
    if (schoolId) cache.delete(schoolId);
    else cache.clear();
}

async function leerFilas(schoolId: string): Promise<FilasCrudas> {
    const [ofertas, sesiones, bloqueos, trial, ajustes] = await Promise.all([
        supabase.from('bot_ofertas')
            .select('id, tipo, titulo, descripcion, sede, publico, genero, estado, vigente_desde, vigente_hasta, prioridad, cupos, requiere_inscripcion, requiere_pago, valor, cta, mensaje_sin_cupos')
            .eq('school_id', schoolId).eq('estado', 'activa'),
        supabase.from('bot_oferta_sesiones')
            .select('id, oferta_id, fecha, hora_inicio, hora_fin, lugar, genero, publico, notas')
            .eq('school_id', schoolId),
        supabase.from('bot_oferta_bloqueos')
            .select('tipo, desde, hasta, motivo')
            .eq('school_id', schoolId),
        supabase.from('school_trial_class_settings')
            .select('enabled, whatsapp_enabled')
            .eq('school_id', schoolId).maybeSingle(),
        supabase.from('bot_ofertas_ajustes')
            .select('mensaje_sin_ofertas')
            .eq('school_id', schoolId).maybeSingle(),
    ]);
    // Las tablas de ofertas pueden no existir todavía (BFF nuevo con base vieja):
    // eso equivale a «sin ofertas ni bloqueos», no a un error.
    // Solo «la tabla no existe»: una columna faltante (42703) u otro error NO
    // equivale a «sin bloqueos» — eso dejaría ofrecer la clase en plena pausa.
    const faltaTabla = (e: any) => e && (e.code === '42P01' || e.code === 'PGRST205');
    for (const r of [ofertas, sesiones, bloqueos, ajustes]) {
        if (r.error && !faltaTabla(r.error)) throw r.error;
    }
    if (trial.error) throw trial.error;
    return {
        ofertas: ofertas.error ? [] : (ofertas.data ?? []),
        sesiones: sesiones.error ? [] : (sesiones.data ?? []),
        bloqueos: bloqueos.error ? [] : (bloqueos.data ?? []),
        ajustesClasePrueba: (trial.data as any) ?? null,
        mensajeSinOfertas: ajustes.error ? null : ((ajustes.data as any)?.mensaje_sin_ofertas ?? null),
    };
}

/**
 * Estado de las ofertas de la escuela para «ahora». Caché de 60 s por escuela
 * (las filas; el filtrado por fecha/hora se rehace en cada llamada). Nunca lanza.
 */
export async function estadoDeOfertas(schoolId: string, ahora: number = Date.now()): Promise<EstadoOfertas> {
    const c = cache.get(schoolId);
    if (c && c.vence > Date.now()) return armarEstado(schoolId, c.filas, ahora);
    try {
        const filas = await leerFilas(schoolId);
        const estado = armarEstado(schoolId, filas, ahora);
        cache.set(schoolId, { estado, filas, vence: Date.now() + TTL_MS });
        return estado;
    } catch (err: any) {
        console.warn('[bot-ofertas] no se pudo leer la configuración de ofertas', { schoolId, err: err?.message ?? err });
        if (c) return armarEstado(schoolId, c.filas, ahora);
        return estadoCerrado(schoolId, ahora);
    }
}

/** ¿Se puede ofrecer la clase de prueba HOY? Nunca lanza (falla cerrado). */
export async function claseDePruebaDisponible(schoolId: string, ahora: number = Date.now()): Promise<boolean> {
    return (await estadoDeOfertas(schoolId, ahora)).claseDePrueba.disponible;
}

// ─── Filtros para lo que pide la persona (puros) ────────────────────────────

/** Género pedido en un texto libre ('convocatoria femenina de mayores' → femenino). */
export function detectarGenero(texto: string): Exclude<GeneroOferta, 'mixto'> | null {
    const t = texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const fem = /\b(femenin\w*|mujer(es)?|nina(s)?|chicas|damas|ellas)\b/.test(t);
    const mas = /\b(masculin\w*|hombre(s)?|nino(s)?|chicos|varon(es)?|caballeros)\b/.test(t);
    if (fem && !mas) return 'femenino';
    if (mas && !fem) return 'masculino';
    return null;
}

/** Deja solo las sesiones (y ofertas) que sirven para ese género. Mixto sirve a ambos. */
export function filtrarPorGenero(ofertas: OfertaBot[], genero: Exclude<GeneroOferta, 'mixto'> | null): OfertaBot[] {
    if (!genero) return ofertas;
    const sirve = (g: GeneroOferta | null) => !g || g === 'mixto' || g === genero;
    // Se decide ANTES de recortar sesiones: una oferta sin sesiones (opcionales)
    // y sin género, o mixta, también sirve.
    return ofertas
        .filter((o) => sirve(o.genero)
            && (o.sesiones.length === 0 || o.genero === genero || o.sesiones.some((s) => sirve(s.genero))))
        .map((o) => ({ ...o, sesiones: o.sesiones.filter((s) => sirve(s.genero)) }));
}

// ─── Textos (andamiaje; el contenido sale de la base) ───────────────────────

const ETIQUETA_GENERO: Record<GeneroOferta, string> = { femenino: 'femenino', masculino: 'masculino', mixto: 'mixto' };

/** Líneas «• fechas, horas · lugar · género · público» agrupando sesiones iguales en distintas fechas. */
export function lineasDeSesiones(sesiones: SesionOferta[], hoy?: string): string[] {
    const grupos = new Map<string, { s: SesionOferta; fechas: string[] }>();
    for (const s of sesiones) {
        const k = [s.horaInicio, s.horaFin, s.lugar, s.genero, s.publico, s.notas].join('|');
        const g = grupos.get(k);
        if (g) g.fechas.push(s.fecha);
        else grupos.set(k, { s, fechas: [s.fecha] });
    }
    return [...grupos.values()]
        .sort((a, b) => (a.fechas[0] + a.s.horaInicio).localeCompare(b.fechas[0] + b.s.horaInicio))
        .map(({ s, fechas }) => {
            const extras = [
                s.lugar,
                s.genero && s.genero !== 'mixto' ? ETIQUETA_GENERO[s.genero] : null,
                s.publico,
                s.notas,
            ].filter(Boolean);
            return `• ${fechasLegibles(fechas, hoy)}, ${rangoLegible(s.horaInicio, s.horaFin)}`
                + (extras.length ? ` · ${extras.join(' · ')}` : '');
        });
}

/** Bloque de UNA oferta para WhatsApp (formato con *negritas*). */
export function textoDeOferta(o: OfertaBot, hoy?: string): string {
    const cabecera = [`*${o.titulo}*`];
    const sub = [o.sede, o.publico].filter(Boolean).join(' · ');
    if (sub) cabecera.push(sub);
    if (o.descripcion) cabecera.push(o.descripcion);
    const lineas = lineasDeSesiones(o.sesiones, hoy);
    const pago = o.requierePago && o.valor != null ? [`Valor: $${o.valor.toLocaleString('es-CO')}`] : [];
    return [...cabecera, ...lineas, ...pago].join('\n');
}

/**
 * Mensaje determinista con las ofertas vigentes (filtradas por tipo/género) para
 * mandarle a la persona. null si no queda ninguna.
 */
export function textoOfertasParaPersona(
    estado: EstadoOfertas,
    opciones: { tipo?: TipoOferta; genero?: Exclude<GeneroOferta, 'mixto'> | null } = {},
): string | null {
    let ofertas = estado.ofertas;
    if (opciones.tipo) ofertas = ofertas.filter((o) => o.tipo === opciones.tipo);
    ofertas = filtrarPorGenero(ofertas, opciones.genero ?? null);
    if (!ofertas.length) return null;
    const bloques = ofertas.map((o) => textoDeOferta(o, estado.hoy));
    const ctas = [...new Set(ofertas.map((o) => o.cta).filter(Boolean))] as string[];
    return [bloques.join('\n\n'), ...ctas].join('\n\n');
}

/** Bloque <ofertas_vigentes> para el prompt del modelo ('' si no hay). */
export function textoOfertasParaIa(estado: EstadoOfertas): string {
    if (!estado.ofertas.length) return '';
    const cuerpo = estado.ofertas.map((o) => {
        const cab = [`[${o.tipo}] ${o.titulo}`, o.sede, o.publico ? `Público: ${o.publico}` : null,
            o.genero && o.genero !== 'mixto' ? `Género: ${o.genero}` : null]
            .filter(Boolean).join(' · ');
        const extra = [
            o.descripcion,
            o.requierePago && o.valor != null ? `Valor: $${o.valor.toLocaleString('es-CO')}` : (o.requierePago ? null : 'Sin costo indicado por la escuela'),
            o.cta ? `Cómo inscribirse: ${o.cta}` : null,
        ].filter(Boolean);
        return [cab, ...lineasDeSesiones(o.sesiones, estado.hoy).map((l) => `  ${l}`), ...extra.map((e) => `  ${e}`)].join('\n');
    }).join('\n\n');
    return `<ofertas_vigentes hoy="${fechaLegible(estado.hoy)}">\n${cuerpo}\n</ofertas_vigentes>`;
}

/**
 * Reglas para el modelo según el estado (instrucciones, no contenido): si hoy
 * no hay clase de prueba, que no la ofrezca aunque la ficha la mencione; si hay
 * ofertas, que conteste con ellas. Devuelve líneas que empiezan con «- ».
 */
export function reglasDeOfertasParaIa(estado: EstadoOfertas): string[] {
    const r: string[] = [];
    const cp = estado.claseDePrueba;
    const hayOfertas = estado.ofertas.length > 0;
    if (!cp.disponible) {
        const vuelve = cp.motivo === 'bloqueo' && cp.bloqueadaHasta
            ? ` Vuelven el ${fechaLegible(sumarDias(cp.bloqueadaHasta, 1), estado.hoy)}.` : '';
        r.push(`- HOY NO HAY CLASES DE PRUEBA.${vuelve} No las ofrezcas, no las agendes, no des sus horarios ni su valor, `
            + 'aunque la ficha, el catálogo o la conversación anterior las mencionen. Si alguien la pide, dile que por ahora no hay'
            + (hayOfertas ? ' y ofrécele lo de <ofertas_vigentes>.' : ' y que la escuela le escribe.'));
    } else if (cp.proximoBloqueo) {
        r.push(`- Las clases de prueba solo se pueden agendar hasta el ${fechaLegible(sumarDias(cp.proximoBloqueo.desde, -1), estado.hoy)}; `
            + `del ${fechaLegible(cp.proximoBloqueo.desde, estado.hoy)} al ${fechaLegible(cp.proximoBloqueo.hasta, estado.hoy)} no hay. `
            + 'Nunca propongas una fecha dentro de ese rango.');
    }
    if (hayOfertas) {
        r.push('- Si preguntan por convocatorias, pruebas para entrar a un equipo, inscripciones o algo de <ofertas_vigentes>, '
            + 'contesta SOLO con esas fechas, horas y lugares, filtrando por lo que pidan (femenino/masculino, año de nacimiento, sede, '
            + 'equipo). Nunca inventes fechas ni des sesiones que no estén ahí. Para inscribirse, di exactamente lo de «Cómo inscribirse». '
            + 'A quien pregunte por una convocatoria NO le ofrezcas clase de prueba.');
    } else if (!cp.disponible) {
        r.push(`- No hay ofertas para nuevos deportistas en este momento.${estado.mensajeSinOfertas ? ` Di: «${estado.mensajeSinOfertas}».` : ' Di que la escuela le escribe para contarle las próximas fechas.'}`);
    }
    return r;
}
