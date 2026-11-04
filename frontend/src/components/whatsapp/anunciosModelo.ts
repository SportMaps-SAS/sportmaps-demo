/**
 * Modelo puro de WhatsApp › Anuncios (docs/specs/whatsapp-anuncios-atribucion.md).
 *
 * Lo que devuelve el BFF (`GET /api/v1/whatsapp/:schoolId/anuncios`) y las
 * cuentas de la pantalla: % de paso, nombres de los motivos de pago, el
 * selector «este anuncio va a…» y el rango de fechas. Sin React, probado en
 * anunciosModelo.test.ts.
 */

// ─── Lo que devuelve el BFF ──────────────────────────────────────────────────

export type Destino = 'clase_prueba' | 'servicio' | 'persona';

export interface MotivoDePago {
    motivo: string;
    servicio_id: string | null;
    servicio: string | null;
    conversaciones: number;
    pagos: number;
    monto: number;
}

export interface FilaEmbudo {
    source_id: string | null;
    source_type: string | null;
    headline: string | null;
    body: string | null;
    source_url: string | null;
    media_url: string | null;
    conversaciones: number;
    de_historial: number;
    contestaron: number;
    separaron_o_agendaron: number;
    pagaron: number;
    monto: number;
    pagos_por_motivo: MotivoDePago[];
    asistieron: number;
    matriculados: number;
    volvieron: number;
    primera_conversacion: string | null;
    ultima_conversacion: string | null;
}

export interface MapeoDestino {
    source_id: string;
    destino: Destino;
    servicio_id: string | null;
    nota: string | null;
    updated_at: string | null;
}

export interface ServicioDelCatalogo {
    id: string;
    nombre: string;
    tipo: string | null;
    activo: boolean;
}

export interface ResumenAnuncios {
    disponible: boolean;
    rango?: { desde: string; hasta: string };
    sede?: string | null;
    sedes?: { id: string; nombre: string }[];
    servicios?: ServicioDelCatalogo[];
    mapeos?: MapeoDestino[];
    anuncios?: FilaEmbudo[];
    total?: FilaEmbudo;
}

/** Total sin datos (BFF viejo o sin fila total). */
export const FILA_VACIA: FilaEmbudo = {
    source_id: null, source_type: null, headline: null, body: null, source_url: null, media_url: null,
    conversaciones: 0, de_historial: 0, contestaron: 0, separaron_o_agendaron: 0, pagaron: 0, monto: 0,
    pagos_por_motivo: [], asistieron: 0, matriculados: 0, volvieron: 0,
    primera_conversacion: null, ultima_conversacion: null,
};

// ─── Etapas del embudo ───────────────────────────────────────────────────────

export type ClaveEtapa = 'contestaron' | 'separaron_o_agendaron' | 'pagaron' | 'asistieron' | 'matriculados';

/** En el orden del embudo. `ayuda` va en el title de la columna. */
export const ETAPAS: { clave: ClaveEtapa; titulo: string; corto: string; ayuda: string }[] = [
    { clave: 'contestaron', titulo: 'Contestaron las preguntas', corto: 'Contestaron',
      ayuda: 'Respondieron las preguntas del asistente y quedaron como interesados.' },
    { clave: 'separaron_o_agendaron', titulo: 'Separaron o agendaron', corto: 'Separaron',
      ayuda: 'Separaron cupo, agendaron la clase de prueba o mandaron un comprobante (abono incluido).' },
    { clave: 'pagaron', titulo: 'Pagaron', corto: 'Pagaron',
      ayuda: 'Tienen un pago aprobado (completo o abono) que llegó por esa conversación.' },
    { clave: 'asistieron', titulo: 'Asistieron', corto: 'Asistieron',
      ayuda: 'Llegaron a la clase (aviso de llegada o marcado por el profe).' },
    { clave: 'matriculados', titulo: 'Se matricularon', corto: 'Matriculados',
      ayuda: 'El interesado quedó inscrito en la escuela.' },
];

/** % entero de `parte` sobre `base`; null sin base. Puro. */
export function pct(parte: number, base: number): number | null {
    if (!base || base <= 0 || !Number.isFinite(parte)) return null;
    return Math.round((parte / base) * 100);
}

/** «45 %» o «—». Puro. */
export function textoPct(parte: number, base: number): string {
    const p = pct(parte, base);
    return p === null ? '—' : `${p} %`;
}

// ─── Textos ──────────────────────────────────────────────────────────────────

/** El título del anuncio: el de Meta, si no el texto, si no el final del id. Puro. */
export function tituloDelAnuncio(f: Pick<FilaEmbudo, 'headline' | 'body' | 'source_id' | 'source_type'>): string {
    const h = (f.headline ?? '').trim();
    if (h) return h;
    const b = (f.body ?? '').replace(/\s+/g, ' ').trim();
    if (b) return b.length > 60 ? `${b.slice(0, 57)}…` : b;
    const tipo = f.source_type === 'post' ? 'Publicación' : 'Anuncio';
    return f.source_id ? `${tipo} …${f.source_id.slice(-6)}` : tipo;
}

/** Solo enlaces http(s): lo demás no se pinta. Puro. */
export function enlaceSeguro(url: string | null | undefined): string | null {
    const u = (url ?? '').trim();
    return /^https?:\/\//i.test(u) ? u : null;
}

const MOTIVOS: Record<string, string> = {
    clase_prueba: 'Clase de prueba',
    clase_extra: 'Clínica / clase extra',
    vacacional: 'Vacacional',
    inscripcion: 'Matrícula',
    mensualidad: 'Mensualidad',
    articulos: 'Uniformes y artículos',
    torneo: 'Torneo',
    viaje: 'Viaje',
    reserva: 'Reserva',
    seguro: 'Seguro',
    otro: 'Otro',
};

/** Cómo se llama el motivo de un pago: el servicio si lo hay, si no la categoría. Puro. */
export function textoMotivo(m: Pick<MotivoDePago, 'motivo' | 'servicio'>): string {
    const s = (m.servicio ?? '').trim();
    if (s) return s;
    return MOTIVOS[m.motivo] ?? m.motivo.replace(/_/g, ' ');
}

// ─── Selector «este anuncio va a…» ───────────────────────────────────────────

/** Radix Select no admite value vacío: «sin definir» es este centinela. */
export const SIN_DESTINO = 'auto';

/** Valor del selector para un mapeo. Puro. */
export function valorDelSelector(m: MapeoDestino | null | undefined): string {
    if (!m) return SIN_DESTINO;
    if (m.destino === 'servicio') return m.servicio_id ? `servicio:${m.servicio_id}` : SIN_DESTINO;
    return m.destino;
}

/** Del selector al cuerpo del PUT; null = quitar el mapeo (DELETE). Puro. */
export function mapeoDeValor(valor: string): { destino: Destino; servicio_id: string | null } | null {
    if (valor === 'clase_prueba' || valor === 'persona') return { destino: valor, servicio_id: null };
    if (valor.startsWith('servicio:') && valor.length > 'servicio:'.length) {
        return { destino: 'servicio', servicio_id: valor.slice('servicio:'.length) };
    }
    return null;
}

/** Opciones del selector: fijas + un servicio por ítem activo (y el mapeado aunque esté inactivo). Puro. */
export function opcionesDeDestino(servicios: ServicioDelCatalogo[], actual?: MapeoDestino | null):
    { valor: string; texto: string; grupo: 'fijo' | 'servicio' }[] {
    const fijas = [
        { valor: SIN_DESTINO, texto: 'Sin definir (el asistente decide por el texto)', grupo: 'fijo' as const },
        { valor: 'clase_prueba', texto: 'Clase de prueba', grupo: 'fijo' as const },
        { valor: 'persona', texto: 'Una persona (buzón)', grupo: 'fijo' as const },
    ];
    const servicios_ = servicios
        .filter((s) => s.activo || s.id === actual?.servicio_id)
        .map((s) => ({ valor: `servicio:${s.id}`, texto: s.activo ? s.nombre : `${s.nombre} (inactivo)`, grupo: 'servicio' as const }));
    return [...fijas, ...servicios_];
}

/** Índice de mapeos por anuncio. Puro. */
export function mapeosPorAnuncio(mapeos: MapeoDestino[] | undefined): Map<string, MapeoDestino> {
    return new Map((mapeos ?? []).map((m) => [m.source_id, m]));
}

/** Aplica el resultado de un PUT/DELETE a la lista local (sin recargar todo). Puro. */
export function aplicarMapeo(mapeos: MapeoDestino[], sourceId: string, nuevo: MapeoDestino | null): MapeoDestino[] {
    const resto = mapeos.filter((m) => m.source_id !== sourceId);
    return nuevo ? [nuevo, ...resto] : resto;
}

// ─── Fechas (Bogotá) ─────────────────────────────────────────────────────────

const DIA_MS = 24 * 3600_000;

/** YYYY-MM-DD de hoy en Bogotá (UTC-5 fijo). Puro. */
export function hoyBogota(ahora: number = Date.now()): string {
    return new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10);
}

/** Los últimos `dias` días hasta hoy, ambos incluidos. Puro. */
export function rangoUltimosDias(dias: number, ahora: number = Date.now()): { desde: string; hasta: string } {
    const hasta = hoyBogota(ahora);
    const desde = new Date(Date.parse(`${hasta}T00:00:00Z`) - (Math.max(1, dias) - 1) * DIA_MS).toISOString().slice(0, 10);
    return { desde, hasta };
}

/** Aviso de las conversaciones que llegaron por el historial del celular. Puro. */
export function avisoHistorial(total: Pick<FilaEmbudo, 'conversaciones' | 'de_historial'> | null | undefined): string | null {
    if (!total || total.de_historial <= 0) return null;
    const todas = total.de_historial >= total.conversaciones;
    const cuantas = todas ? 'Todas estas conversaciones' : `${total.de_historial} de estas ${total.conversaciones} conversaciones`;
    return `${cuantas} llegaron antes de conectar el número a SportMaps (historial del celular): se sabe de qué anuncio `
        + 'vinieron, pero lo que pasó después no lo midió el asistente.';
}
