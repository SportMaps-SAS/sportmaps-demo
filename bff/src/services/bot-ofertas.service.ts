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
    /** Rango de año de nacimiento de quien aplica (null = sin límite). Para elegir la oferta. */
    anioDesde: number | null;
    anioHasta: number | null;
    /** Solo para quien cuenta trayectoria; si califica, se le manda solo esta(s). */
    requiereTrayectoria: boolean;
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
    /** Lo que el bot pregunta ANTES de mostrar ofertas (texto de la escuela). null = las muestra de una vez. */
    preguntasOfertas: string | null;
    /** Texto común que acompaña a las ofertas elegidas (texto de la escuela). */
    notaOfertas: string | null;
    /** Promoción de la escuela vigente HOY (ya filtrada por sus fechas); null si no hay. */
    promoOfertas: string | null;
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
    preguntasOfertas?: string | null;
    notaOfertas?: string | null;
    promo?: { texto: string | null; desde: string | null; hasta: string | null } | null;
}

/** El texto de la promoción si `hoy` está dentro de sus fechas (sin fecha = sin límite por ese lado). Pura. */
export function promoVigente(promo: FilasCrudas['promo'], hoy: string): string | null {
    const texto = (promo?.texto ?? '').trim();
    if (!texto) return null;
    if (promo?.desde && String(promo.desde) > hoy) return null;
    if (promo?.hasta && String(promo.hasta) < hoy) return null;
    return texto;
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
            mensajeSinCupos: o.mensaje_sin_cupos ?? null, vigenteHasta: o.vigente_hasta ?? null,
            anioDesde: o.anio_nacimiento_desde == null ? null : Number(o.anio_nacimiento_desde),
            anioHasta: o.anio_nacimiento_hasta == null ? null : Number(o.anio_nacimiento_hasta),
            requiereTrayectoria: o.requiere_trayectoria === true,
            sesiones,
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

    const limpio = (t: string | null | undefined) => (t ?? '').trim() || null;
    return {
        schoolId, hoy, ofertas, bloqueos, claseDePrueba,
        mensajeSinOfertas: limpio(filas.mensajeSinOfertas),
        preguntasOfertas: limpio(filas.preguntasOfertas),
        notaOfertas: limpio(filas.notaOfertas),
        promoOfertas: promoVigente(filas.promo, hoy),
    };
}

/** Estado vacío y cerrado para la clase de prueba (error de lectura sin caché). */
export function estadoCerrado(schoolId: string, ahora: number = Date.now()): EstadoOfertas {
    return {
        schoolId, hoy: hoyBogota(ahora), ofertas: [], bloqueos: [],
        claseDePrueba: { disponible: false, motivo: 'error', bloqueadaHasta: null, proximoBloqueo: null },
        mensajeSinOfertas: null, preguntasOfertas: null, notaOfertas: null, promoOfertas: null,
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
            .select('id, tipo, titulo, descripcion, sede, publico, genero, estado, vigente_desde, vigente_hasta, prioridad, cupos, requiere_inscripcion, requiere_pago, valor, cta, mensaje_sin_cupos, anio_nacimiento_desde, anio_nacimiento_hasta, requiere_trayectoria')
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
            .select('mensaje_sin_ofertas, preguntas_ofertas, nota_ofertas, promo_texto, promo_desde, promo_hasta')
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
        preguntasOfertas: ajustes.error ? null : ((ajustes.data as any)?.preguntas_ofertas ?? null),
        notaOfertas: ajustes.error ? null : ((ajustes.data as any)?.nota_ofertas ?? null),
        promo: ajustes.error ? null : {
            texto: (ajustes.data as any)?.promo_texto ?? null,
            desde: (ajustes.data as any)?.promo_desde ?? null,
            hasta: (ajustes.data as any)?.promo_hasta ?? null,
        },
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

/**
 * Líneas «• fechas, horas · lugar · género · público» agrupando sesiones iguales en distintas fechas.
 * `omitirLugar`: el lugar va una sola vez aparte (todas las sesiones son en el mismo sitio).
 */
export function lineasDeSesiones(sesiones: SesionOferta[], hoy?: string, op: { omitirLugar?: boolean } = {}): string[] {
    const grupos = new Map<string, { s: SesionOferta; fechas: string[] }>();
    for (const s0 of sesiones) {
        const s = op.omitirLugar ? { ...s0, lugar: null } : s0;
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

/** El lugar si TODAS las sesiones son en el mismo sitio (y lo tienen); si no, null. */
function lugarComun(sesiones: SesionOferta[]): string | null {
    const lugares = new Set(sesiones.map((s) => (s.lugar ?? '').trim()));
    const unico = lugares.size === 1 ? [...lugares][0] : '';
    return unico || null;
}

/**
 * Bloque de UNA oferta para WhatsApp (formato con *negritas*).
 *   - Con `descripcion` (la escuela escribió su texto): descripción, «*Fechas y
 *     horarios:*» con las sesiones que no han pasado, «*Lugar:*» si es uno solo,
 *     y el cierre (`cta`) — el texto de la escuela tal cual, con fechas vivas.
 *   - Sin ella: título, sede · público y las sesiones (formato corto).
 */
export function textoDeOferta(o: OfertaBot, hoy?: string): string {
    const monto = o.requierePago && o.valor != null ? o.valor.toLocaleString('es-CO') : null;
    // Si el texto de la escuela ya dice el monto («$145.000»), no se repite la línea genérica.
    // Con bordes de dígito: «$145.000» no cuenta como «45.000».
    const reMonto = monto != null ? new RegExp(`(?<![\\d.])${monto.replace(/\./g, '\\.')}(?![.,]?\\d)`) : null;
    const montoEnTexto = reMonto != null && [o.descripcion, o.cta].some((t) => reMonto.test(t ?? ''));
    const pago = monto != null && !montoEnTexto ? `Valor: $${monto}` : '';
    if (o.descripcion?.trim()) {
        const lugar = lugarComun(o.sesiones);
        const lineas = lineasDeSesiones(o.sesiones, hoy, { omitirLugar: Boolean(lugar) });
        return [
            o.descripcion.trim(),
            lineas.length ? `*Fechas y horarios:*\n${lineas.join('\n')}` : '',
            lugar ? `*Lugar:* ${lugar}.` : '',
            pago,
            (o.cta ?? '').trim(),
        ].filter(Boolean).join('\n\n');
    }
    const cabecera = [`*${o.titulo}*`];
    const sub = [o.sede, o.publico].filter(Boolean).join(' · ');
    if (sub) cabecera.push(sub);
    const lineas = lineasDeSesiones(o.sesiones, hoy);
    return [...cabecera, ...lineas, ...(pago ? [pago] : [])].join('\n');
}

/**
 * Varias ofertas en un mensaje: cada bloque; los «cómo inscribirse» de las ofertas
 * en formato corto van una sola vez al final (las de texto propio traen su cierre),
 * y la nota común de la escuela si se pide. null si no hay ofertas.
 */
export function textoDeOfertas(
    ofertas: OfertaBot[], estado: Pick<EstadoOfertas, 'hoy' | 'notaOfertas'>, op: { conNota?: boolean } = {},
): string | null {
    if (!ofertas.length) return null;
    const bloques = ofertas.map((o) => textoDeOferta(o, estado.hoy));
    const ctas = [...new Set(ofertas.filter((o) => !o.descripcion?.trim()).map((o) => o.cta).filter(Boolean))] as string[];
    const nota = op.conNota && estado.notaOfertas ? [estado.notaOfertas] : [];
    return [bloques.join('\n\n'), ...ctas, ...nota].join('\n\n');
}

/**
 * Mensaje determinista con las ofertas vigentes (filtradas por tipo/género) para
 * mandarle a la persona. null si no queda ninguna.
 */
export function textoOfertasParaPersona(
    estado: EstadoOfertas,
    opciones: { tipo?: TipoOferta; genero?: Exclude<GeneroOferta, 'mixto'> | null; conNota?: boolean } = {},
): string | null {
    let ofertas = estado.ofertas;
    if (opciones.tipo) ofertas = ofertas.filter((o) => o.tipo === opciones.tipo);
    ofertas = filtrarPorGenero(ofertas, opciones.genero ?? null);
    return textoDeOfertas(ofertas, estado, { conNota: opciones.conNota });
}

// ─── Elegir la oferta por los datos de la persona (puro) ───────────────────

export interface DatosDePersona {
    /** Año de nacimiento (escrito, o calculado de «tengo 15 años»). */
    anio: number | null;
    genero: Exclude<GeneroOferta, 'mixto'> | null;
    /** true = contó clubes/torneos; false = dijo que no tiene; null = no dijo. */
    trayectoria: boolean | null;
}

const SIN_TRAYECTORIA = /\b(ningun[oa]?|nunca|no (he|ha|hemos) (jugado|entrenado|estado|participado)|sin experiencia|no tengo (experiencia|trayectoria)|principiante|desde cero|apenas (empiezo|empieza|voy a empezar)|no juego)\b/;
const CON_TRAYECTORIA = /\b(club(es)?|torneos?|ligas?|seleccion(es)?|campeonatos?|superliga|intercolegiad\w*|interclubes|departamental(es)?|nacional(es)?|juegos (nacionales|departamentales|intercolegiados|supérate|superate)|equipo de (la|el|mi) (universidad|colegio|empresa))\b/;

/** Año de nacimiento, género y trayectoria a partir de lo que respondió. Pura. */
export function datosDeRespuesta(texto: string, hoy: string): DatosDePersona {
    const t = String(texto ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const anioHoy = Number(hoy.slice(0, 4));
    // El año de nacimiento es el MÁS ANTIGUO plausible (los torneos suelen ser recientes).
    const anios = [...t.matchAll(/\b(19[4-9]\d|20\d\d)\b/g)].map((m) => Number(m[1]))
        .filter((a) => a >= 1940 && a <= anioHoy - 3);
    let anio: number | null = anios.length ? Math.min(...anios) : null;
    if (anio == null) {
        // «tengo 15 años» es edad; «llevo 4 años jugando» / «hace 6 años» no.
        const edad = t.match(/(?<!\b(?:hace|llev\w+|durante)\s+(?:mas de\s+)?)\b(\d{1,2})\s*anos?\b/);
        const n = edad ? Number(edad[1]) : NaN;
        if (n >= 3 && n <= 80) anio = anioHoy - n;
    }
    const trayectoria = SIN_TRAYECTORIA.test(t) ? false : CON_TRAYECTORIA.test(t) ? true : null;
    return { anio, genero: detectarGenero(String(texto ?? '')), trayectoria };
}

/** Rango [min, max] de años que nombra un texto («Nacidos en 2013 y 2014»); null si no nombra años. */
export function aniosEnTexto(texto: string | null | undefined): [number, number] | null {
    const anios = [...String(texto ?? '').matchAll(/\b(19\d\d|20\d\d)\b/g)].map((m) => Number(m[1]));
    return anios.length ? [Math.min(...anios), Math.max(...anios)] : null;
}

/**
 * La(s) oferta(s) que le aplican, con solo las sesiones de su género y de su año
 * (si la sesión nombra años). Reglas (criterios de cada oferta, de la base):
 *   1. género (mixto o sin género sirven a todos);
 *   2. año de nacimiento dentro de `anioDesde..anioHasta` (si se sabe el año);
 *   3. `requiereTrayectoria`: solo si contó trayectoria; si califica para alguna
 *      así, se le mandan SOLO esas («si por sus datos aplica a mayores»).
 * Si nada aplica, todas las de su género (que la escuela decida). Pura.
 */
export function elegirOfertas(estado: Pick<EstadoOfertas, 'ofertas'>, datos: DatosDePersona): { ofertas: OfertaBot[]; porDatos: boolean } {
    const base = filtrarPorGenero(estado.ofertas, datos.genero);
    const anio = datos.anio;
    const conAnio = base
        .filter((o) => anio == null
            || ((o.anioDesde == null || anio >= o.anioDesde) && (o.anioHasta == null || anio <= o.anioHasta)))
        .map((o) => {
            if (anio == null) return o;
            const sesiones = o.sesiones.filter((s) => {
                const r = aniosEnTexto(s.publico);
                return !r || (anio >= r[0] && anio <= r[1]);
            });
            return { ...o, sesiones };
        })
        .filter((o) => o.sesiones.length > 0 || !estado.ofertas.find((x) => x.id === o.id)?.sesiones.length);
    // Con el año conocido, primero las ofertas hechas para su edad (tienen rango) y después las generales.
    const porEdad = (xs: OfertaBot[]) => anio == null ? xs
        : [...xs].sort((a, b) => Number(b.anioDesde != null || b.anioHasta != null) - Number(a.anioDesde != null || a.anioHasta != null));
    const competitivas = conAnio.filter((o) => o.requiereTrayectoria && datos.trayectoria === true);
    if (competitivas.length) return { ofertas: porEdad(competitivas), porDatos: true };
    const resto = conAnio.filter((o) => !o.requiereTrayectoria);
    if (resto.length) return { ofertas: porEdad(resto), porDatos: true };
    return { ofertas: base, porDatos: false };
}

// ─── Conversación guiada, una pregunta a la vez (puro) ──────────────────────
//
// La interfaz (botones, listas, estado) vive en quien conversa (la puerta del
// desconocido, el embudo); aquí solo QUÉ preguntar y con qué opciones, sacado de
// las ofertas de la escuela. Los textos de pregunta son andamiaje.

export type PasoOferta = 'genero' | 'anio' | 'trayectoria' | 'detalle' | 'sede' | 'lista';

export interface DatosOferta {
    genero: Exclude<GeneroOferta, 'mixto'> | null;
    /** Año de nacimiento representativo del rango elegido. */
    anio: number | null;
    trayectoria: boolean | null;
    /** Texto libre: clubes, torneos, posición (para la escuela). */
    detalle: string | null;
    sede: string | null;
    nombre?: string | null;
}

export interface OpcionOferta { id: string; titulo: string; descripcion?: string }

export interface PreguntaDeOferta {
    paso: PasoOferta;
    /** La pregunta (vacía en 'lista'). */
    texto: string;
    /** Botones/filas; [] en 'detalle' (texto libre) y en 'lista'. */
    opciones: OpcionOferta[];
    /** Las ofertas que van quedando (las finales en 'lista'). */
    ofertas: OfertaBot[];
}

export const ID_OFERTA = {
    INSCRIBIRME: 'of_inscribirme',
    EVALUACION: 'of_evaluacion',
    PERSONA: 'of_persona',
} as const;

export const DATOS_OFERTA_VACIOS: DatosOferta = { genero: null, anio: null, trayectoria: null, detalle: null, sede: null, nombre: null };

const slug = (t: string) => t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/** Primer párrafo de las preguntas de la escuela, para abrir la conversación. */
export function introDeOfertas(estado: Pick<EstadoOfertas, 'preguntasOfertas'>): string | null {
    const p = (estado.preguntasOfertas ?? '').split(/\n\s*\n/)[0]?.trim();
    return p || null;
}

/** Rangos de año de nacimiento para elegir, sacados de las ofertas (sesiones y criterios). Del más joven al mayor. */
export function rangosDeAnio(ofertas: OfertaBot[], hoy: string): { desde: number | null; hasta: number | null }[] {
    const anioHoy = Number(hoy.slice(0, 4));
    const tramos = new Map<string, { desde: number | null; hasta: number | null }>();
    for (const o of ofertas) {
        for (const s of o.sesiones) {
            const r = aniosEnTexto(s.publico);
            if (r) tramos.set(`${r[0]}-${r[1]}`, { desde: r[0], hasta: r[1] });
        }
    }
    const cubiertos = [...tramos.values()];
    const minCub = cubiertos.length ? Math.min(...cubiertos.map((t) => t.desde!)) : null;
    const maxCub = cubiertos.length ? Math.max(...cubiertos.map((t) => t.hasta!)) : null;
    for (const o of ofertas) {
        // Criterio de la oferta que no está cubierto por las sesiones: un tramo abierto.
        if (o.anioHasta != null && (minCub == null || o.anioHasta < minCub)) tramos.set(`-${o.anioHasta}`, { desde: null, hasta: o.anioHasta });
        if (o.anioDesde != null && (maxCub == null || o.anioDesde > maxCub)) tramos.set(`${o.anioDesde}-`, { desde: o.anioDesde, hasta: null });
    }
    const sinTope = ofertas.some((o) => o.anioDesde == null && !o.sesiones.some((s) => aniosEnTexto(s.publico)));
    if (sinTope && minCub != null && ![...tramos.values()].some((t) => t.desde == null)) {
        tramos.set(`-${minCub - 1}`, { desde: null, hasta: minCub - 1 });
    }
    if (sinTope && maxCub != null && maxCub + 1 <= anioHoy - 4 && ![...tramos.values()].some((t) => t.hasta == null)) {
        tramos.set(`${maxCub + 1}-`, { desde: maxCub + 1, hasta: null });
    }
    return [...tramos.values()]
        .sort((a, b) => (b.hasta ?? 9999) - (a.hasta ?? 9999))
        .slice(0, 10);
}

function tituloDeRango(r: { desde: number | null; hasta: number | null }): string {
    if (r.desde == null) return `${r.hasta} o antes`;
    if (r.hasta == null) return `${r.desde} o después`;
    return r.desde === r.hasta ? String(r.desde) : `${r.desde} a ${r.hasta}`;
}

function idDeRango(r: { desde: number | null; hasta: number | null }): string {
    return `of_a_${r.desde ?? 'x'}_${r.hasta ?? 'x'}`;
}

/** Sedes distintas (no vacías) de unas ofertas. */
function sedesDe(ofertas: OfertaBot[]): string[] {
    return [...new Set(ofertas.map((o) => (o.sede ?? '').trim()).filter(Boolean))];
}

const mismaSede = (a: string, b: string) => slug(a) === slug(b) || slug(a).includes(slug(b)) || slug(b).includes(slug(a));

/**
 * Qué preguntar ahora, según lo que ya se sabe y lo que hace falta para llegar a
 * UNA oferta (o pocas). Orden: género → año → trayectoria (solo si una oferta que
 * la exige le puede aplicar) → detalle (si dijo que sí) → sede (si quedan ofertas
 * de sedes distintas) → 'lista'. Solo pregunta lo que distingue entre ofertas.
 */
export function siguientePreguntaOferta(estado: Pick<EstadoOfertas, 'ofertas' | 'hoy'>, datos: DatosOferta): PreguntaDeOferta {
    const todas = estado.ofertas;
    const hayGenero = todas.some((o) => (o.genero && o.genero !== 'mixto') || o.sesiones.some((s) => s.genero && s.genero !== 'mixto'));
    if (datos.genero == null && hayGenero) {
        return {
            paso: 'genero', texto: '¿La convocatoria es para *femenino* o *masculino*?',
            opciones: [{ id: 'of_g_femenino', titulo: 'Femenino' }, { id: 'of_g_masculino', titulo: 'Masculino' }],
            ofertas: todas,
        };
    }
    const porGenero = filtrarPorGenero(todas, datos.genero);
    const hayAnios = porGenero.some((o) => o.anioDesde != null || o.anioHasta != null || o.sesiones.some((s) => aniosEnTexto(s.publico)));
    if (datos.anio == null && hayAnios) {
        return {
            paso: 'anio', texto: '¿En qué año nació el deportista? 🎂',
            opciones: rangosDeAnio(porGenero, estado.hoy).map((r) => ({ id: idDeRango(r), titulo: tituloDeRango(r) })),
            ofertas: porGenero,
        };
    }
    // ¿Alguna oferta que exige trayectoria le aplica por género y año?
    const conTrayectoria = elegirOfertas({ ofertas: porGenero }, { anio: datos.anio, genero: datos.genero, trayectoria: true })
        .ofertas.some((o) => o.requiereTrayectoria);
    if (datos.trayectoria == null && conTrayectoria) {
        return {
            paso: 'trayectoria', texto: '¿Ha entrenado en algún club o jugado torneos?',
            opciones: [{ id: 'of_t_si', titulo: 'Sí' }, { id: 'of_t_no', titulo: 'No' }],
            ofertas: porGenero,
        };
    }
    if (datos.trayectoria === true && conTrayectoria && datos.detalle == null) {
        return {
            paso: 'detalle', texto: '¡Genial! 🙌 Cuéntame en qué clubes o torneos ha jugado y en qué posición juega.',
            opciones: [], ofertas: porGenero,
        };
    }
    let elegidas = elegirOfertas({ ofertas: porGenero }, { anio: datos.anio, genero: datos.genero, trayectoria: datos.trayectoria }).ofertas;
    const sedes = sedesDe(elegidas);
    if (datos.sede) {
        const enSede = elegidas.filter((o) => o.sede && mismaSede(o.sede, datos.sede!));
        if (enSede.length) elegidas = enSede;
    } else if (elegidas.length > 1 && sedes.length > 1) {
        return {
            paso: 'sede', texto: '¿Qué sede te queda mejor? 📍',
            opciones: sedes.map((s) => ({ id: `of_s_${slug(s)}`, titulo: s.slice(0, 24) })),
            ofertas: elegidas,
        };
    }
    return { paso: 'lista', texto: '', opciones: [], ofertas: elegidas };
}

/**
 * Lo que respondió (botón o texto) aplicado a los datos. null = no se entendió
 * (la interfaz repregunta una vez y luego pasa a la escuela). Pura.
 */
export function aplicarRespuestaOferta(
    pregunta: PreguntaDeOferta, datos: DatosOferta, r: { botonId?: string | null; texto?: string | null }, hoy: string,
): DatosOferta | null {
    const id = r.botonId ?? '';
    const texto = String(r.texto ?? '').trim();
    const t = texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    switch (pregunta.paso) {
        case 'genero': {
            if (id === 'of_g_femenino') return { ...datos, genero: 'femenino' };
            if (id === 'of_g_masculino') return { ...datos, genero: 'masculino' };
            const g = texto ? detectarGenero(texto) : null;
            return g ? { ...datos, genero: g } : null;
        }
        case 'anio': {
            const m = id.match(/^of_a_(\d+|x)_(\d+|x)$/);
            if (m) {
                const desde = m[1] === 'x' ? null : Number(m[1]);
                const hasta = m[2] === 'x' ? null : Number(m[2]);
                return { ...datos, anio: hasta ?? desde };
            }
            // También la fila elegida por su título («2013 a 2014») o un año/edad escrito.
            const fila = pregunta.opciones.find((o) => o.titulo.toLowerCase() === t);
            if (fila) return aplicarRespuestaOferta(pregunta, datos, { botonId: fila.id }, hoy);
            const d = texto ? datosDeRespuesta(texto, hoy) : null;
            return d?.anio != null ? { ...datos, anio: d.anio, genero: datos.genero ?? d.genero } : null;
        }
        case 'trayectoria': {
            if (id === 'of_t_si') return { ...datos, trayectoria: true };
            if (id === 'of_t_no') return { ...datos, trayectoria: false };
            if (/^(si|sii+|claro|obvio|si señor|si senor|afirmativo)\b/.test(t)) return { ...datos, trayectoria: true };
            if (/^(no|nop|nunca|ninguno|ninguna)\b/.test(t)) return { ...datos, trayectoria: false };
            const d = texto ? datosDeRespuesta(texto, hoy) : null;
            if (d?.trayectoria != null) {
                // Si ya contó dónde jugó, eso es el detalle: no se le vuelve a preguntar.
                return { ...datos, trayectoria: d.trayectoria, detalle: d.trayectoria ? texto.slice(0, 300) : datos.detalle };
            }
            return null;
        }
        case 'detalle':
            return texto ? { ...datos, detalle: texto.slice(0, 300) } : null;
        case 'sede': {
            const op = pregunta.opciones.find((o) => o.id === id)
                ?? pregunta.opciones.find((o) => texto && (mismaSede(o.titulo, texto) || t.includes(slug(o.titulo).replace(/_/g, ' '))));
            if (!op) return null;
            const sede = sedesDe(pregunta.ofertas).find((s) => mismaSede(s, op.titulo)) ?? op.titulo;
            return { ...datos, sede };
        }
        default:
            return datos;
    }
}

/** Filas para elegir la fecha (≤ 10): «Sáb 5 dic · 7:00 a. m.», con lugar y público en la descripción. */
export function opcionesDeFechas(oferta: OfertaBot, hoy?: string): OpcionOferta[] {
    const DIA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    void hoy;
    return oferta.sesiones.slice(0, 10).map((s) => {
        const [y, m, d] = s.fecha.split('-').map(Number);
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        const titulo = `${DIA[dow]} ${d} ${MES[m - 1]} · ${horaLegible(s.horaInicio)}`.slice(0, 24);
        const descripcion = [s.lugar, s.genero && s.genero !== 'mixto' ? ETIQUETA_GENERO[s.genero] : null, s.publico]
            .filter(Boolean).join(' · ').slice(0, 72);
        return { id: `of_f_${s.id}`, titulo, ...(descripcion ? { descripcion } : {}) };
    });
}

/** Bloque <ofertas_vigentes> para el prompt del modelo ('' si no hay). */
export function textoOfertasParaIa(estado: EstadoOfertas): string {
    if (!estado.ofertas.length) return '';
    const cuerpo = estado.ofertas.map((o) => {
        const anios = o.anioDesde != null || o.anioHasta != null
            ? `Nacidos ${o.anioDesde != null && o.anioHasta != null ? `de ${o.anioDesde} a ${o.anioHasta}`
                : o.anioDesde != null ? `desde ${o.anioDesde}` : `hasta ${o.anioHasta}`}` : null;
        const cab = [`[${o.tipo}] ${o.titulo}`, o.sede, o.publico ? `Público: ${o.publico}` : null, anios,
            o.requiereTrayectoria ? 'Solo con trayectoria (clubes, torneos)' : null,
            o.genero && o.genero !== 'mixto' ? `Género: ${o.genero}` : null]
            .filter(Boolean).join(' · ');
        const extra = [
            o.descripcion,
            // Sin valor cargado NO es «gratis»: que el modelo no lo afirme (Monster solo dio el de mayores).
            o.requierePago && o.valor != null ? `Valor: $${o.valor.toLocaleString('es-CO')}`
                : 'Valor: la escuela no lo indicó; si preguntan, di que la escuela lo confirma (nunca digas que es gratis)',
            o.cta ? `${o.descripcion?.trim() ? 'Cierre' : 'Cómo inscribirse'}: ${o.cta}` : null,
        ].filter(Boolean);
        return [cab, ...lineasDeSesiones(o.sesiones, estado.hoy).map((l) => `  ${l}`), ...extra.map((e) => `  ${e}`)].join('\n');
    }).join('\n\n');
    const preguntas = estado.preguntasOfertas
        ? `\n<preguntas_de_la_escuela>\n${estado.preguntasOfertas}\n</preguntas_de_la_escuela>` : '';
    const promo = estado.promoOfertas
        ? `\n<promocion_vigente_hoy>\n${estado.promoOfertas}\n</promocion_vigente_hoy>` : '';
    return `<ofertas_vigentes hoy="${fechaLegible(estado.hoy)}">\n${cuerpo}\n</ofertas_vigentes>${preguntas}${promo}`;
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
        r.push(`- Del ${fechaLegible(cp.proximoBloqueo.desde, estado.hoy)} al ${fechaLegible(cp.proximoBloqueo.hasta, estado.hoy)} `
            + `NO hay clases de prueba (la última es el ${fechaLegible(sumarDias(cp.proximoBloqueo.desde, -1), estado.hoy)}). `
            + 'Nunca propongas ni aceptes una fecha dentro de ese rango.');
    }
    if (hayOfertas) {
        r.push('- Si preguntan por convocatorias, pruebas para entrar a un equipo, inscripciones o algo de <ofertas_vigentes>, '
            + 'contesta SOLO con esas fechas, horas y lugares, filtrando por lo que pidan (femenino/masculino, año de nacimiento, sede, '
            + 'equipo). Nunca inventes fechas ni des sesiones que no estén ahí. Para inscribirse, di exactamente lo de «Cómo inscribirse». '
            + 'A quien pregunte por una convocatoria NO le ofrezcas clase de prueba.');
        if (estado.preguntasOfertas) {
            r.push('- Antes de dar fechas de una oferta, si aún no sabes su año de nacimiento, su trayectoria (clubes, torneos) y si es '
                + 'femenino o masculino, pídeselos con las preguntas de la escuela (<preguntas_de_la_escuela>). Con esos datos, dale SOLO '
                + 'la oferta que le aplica según sus años, si exige trayectoria y el género; no le mandes todas.');
        }
    } else if (!cp.disponible) {
        r.push(`- No hay ofertas para nuevos deportistas en este momento.${estado.mensajeSinOfertas ? ` Di: «${estado.mensajeSinOfertas}».` : ' Di que la escuela le escribe para contarle las próximas fechas.'}`);
    }
    return r;
}
