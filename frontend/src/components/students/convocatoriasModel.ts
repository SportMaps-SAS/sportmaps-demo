/**
 * Inscripciones a convocatorias — lógica PURA de la pestaña «Convocatorias» de
 * Deportistas (sin React ni Supabase): agrupar por convocatoria, ordenar por
 * llegada, numerar como en un Excel, filtrar y armar las filas del .xlsx.
 *
 * La escuela (Monster's) lleva estas listas en Excel y por correo: la pantalla
 * y el archivo descargado tienen que mostrar el MISMO orden y la MISMA
 * numeración.
 */

export type EstadoInscripcion = 'pendiente' | 'confirmada' | 'pagada' | 'descartada';

export interface InscripcionConvocatoria {
  id: string;
  created_at: string;
  status: string;
  estado_inscripcion: EstadoInscripcion;
  convocatoria: string;
  oferta_id: string | null;
  sede: string | null;
  deportista: string | null;
  telefono: string | null;
  contacto: string | null;
  acudiente: string | null;
  anio_nacimiento: number | null;
  genero: string | null;
  trayectoria: boolean | null;
  detalle: string | null;
  fechas: string[] | null;
  valor: number | null;
  valor_con_descuento: number | null;
  promo_pct: number | null;
  conversation_id: string | null;
  notas: string | null;
  nota_escuela: string | null;
}

export const ESTADOS: { value: EstadoInscripcion; label: string }[] = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'confirmada', label: 'Confirmada' },
  { value: 'pagada', label: 'Pagada' },
  { value: 'descartada', label: 'Descartada' },
];

export function etiquetaEstado(e: string | null | undefined): string {
  return ESTADOS.find((x) => x.value === e)?.label ?? 'Pendiente';
}

/** Estado normalizado: cualquier cosa desconocida cuenta como pendiente. */
export function estadoDe(i: Pick<InscripcionConvocatoria, 'estado_inscripcion'>): EstadoInscripcion {
  return ESTADOS.some((x) => x.value === i.estado_inscripcion) ? i.estado_inscripcion : 'pendiente';
}

export function nombreConvocatoria(i: Pick<InscripcionConvocatoria, 'convocatoria'>): string {
  return (i.convocatoria ?? '').trim() || 'Sin convocatoria';
}

/** Filtro de estado: 'activas' = todo menos descartadas (lo de por defecto). */
export type FiltroEstado = 'activas' | 'todas' | EstadoInscripcion;

export interface Filtros {
  convocatoria: string | null;
  estado: FiltroEstado;
  busqueda: string;
}

export const FILTROS_INICIALES: Filtros = { convocatoria: null, estado: 'activas', busqueda: '' };

export interface FilaNumerada {
  numero: number;
  inscripcion: InscripcionConvocatoria;
}

export interface GrupoConvocatoria {
  convocatoria: string;
  filas: FilaNumerada[];
  /** Fechas de la convocatoria si TODAS las filas del grupo traen las mismas; si no, null (van por fila). */
  fechasComunes: string[] | null;
}

export interface ResumenConvocatoria {
  convocatoria: string;
  pendiente: number;
  confirmada: number;
  pagada: number;
  descartada: number;
  total: number;
}

function porLlegada(a: InscripcionConvocatoria, b: InscripcionConvocatoria): number {
  const d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function coincideBusqueda(i: InscripcionConvocatoria, q: string): boolean {
  if (!q) return true;
  const texto = sinTildes([i.deportista, i.acudiente, i.contacto].filter(Boolean).join(' '));
  if (texto.includes(sinTildes(q))) return true;
  const digitosQ = q.replace(/\D/g, '');
  return digitosQ.length >= 3 && (i.telefono ?? '').replace(/\D/g, '').includes(digitosQ);
}

function pasaEstado(i: InscripcionConvocatoria, f: FiltroEstado): boolean {
  const e = estadoDe(i);
  if (f === 'todas') return true;
  if (f === 'activas') return e !== 'descartada';
  return e === f;
}

/** Convocatorias en el orden en que aparecen: la que recibió la primera inscripción va primero. */
export function ordenConvocatorias(lista: InscripcionConvocatoria[]): string[] {
  const primera = new Map<string, InscripcionConvocatoria>();
  for (const i of [...lista].sort(porLlegada)) {
    const n = nombreConvocatoria(i);
    if (!primera.has(n)) primera.set(n, i);
  }
  return [...primera.keys()];
}

export function resumenPorConvocatoria(lista: InscripcionConvocatoria[]): ResumenConvocatoria[] {
  const mapa = new Map<string, ResumenConvocatoria>();
  for (const nombre of ordenConvocatorias(lista)) {
    mapa.set(nombre, { convocatoria: nombre, pendiente: 0, confirmada: 0, pagada: 0, descartada: 0, total: 0 });
  }
  for (const i of lista) {
    const r = mapa.get(nombreConvocatoria(i))!;
    r[estadoDe(i)] += 1;
    r.total += 1;
  }
  return [...mapa.values()];
}

const claveFechas = (f: string[] | null | undefined) => JSON.stringify(f ?? []);

/**
 * Agrupa por convocatoria, ordena cada grupo por llegada (created_at asc) y
 * numera 1, 2, 3… Los números se calculan DESPUÉS de los filtros de
 * convocatoria y estado (como un Excel filtrado, sin huecos) pero ANTES de la
 * búsqueda: buscar a alguien muestra su número de la lista, no un «1».
 */
export function agruparConvocatorias(lista: InscripcionConvocatoria[], filtros: Filtros): GrupoConvocatoria[] {
  const q = filtros.busqueda.trim();
  const grupos: GrupoConvocatoria[] = [];
  for (const nombre of ordenConvocatorias(lista)) {
    if (filtros.convocatoria && filtros.convocatoria !== nombre) continue;
    const delGrupo = lista
      .filter((i) => nombreConvocatoria(i) === nombre && pasaEstado(i, filtros.estado))
      .sort(porLlegada);
    const filas = delGrupo
      .map((inscripcion, idx) => ({ numero: idx + 1, inscripcion }))
      .filter((f) => coincideBusqueda(f.inscripcion, q));
    if (filas.length === 0) continue;
    const claves = new Set(delGrupo.map((i) => claveFechas(i.fechas)));
    const fechasComunes = claves.size === 1 && (delGrupo[0].fechas?.length ?? 0) > 0 ? delGrupo[0].fechas! : null;
    grupos.push({ convocatoria: nombre, filas, fechasComunes });
  }
  return grupos;
}

// ── Formatos ─────────────────────────────────────────────────────────────────

const TZ = 'America/Bogota';

/** «26/11 14:05» en hora de Bogotá. */
export function fechaInscripcion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const partes = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')} ${p('hour')}:${p('minute')}`;
}

/** «26/11/2026 14:05» para el Excel (con año: el archivo se guarda). */
export function fechaInscripcionLarga(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const anio = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, year: 'numeric' }).format(d);
  const [dm, hm] = fechaInscripcion(iso).split(' ');
  return `${dm}/${anio} ${hm}`;
}

/** Fecha de la convocatoria: «sáb 29 nov» si viene AAAA-MM-DD; si es texto libre, tal cual. */
export function fechaConvocatoria(f: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(f)) return f;
  const d = new Date(f.length === 10 ? `${f}T12:00:00-05:00` : f);
  if (Number.isNaN(d.getTime())) return f;
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
    .format(d).replace(/\./g, '').replace(/,/g, '');
}

export function textoFechas(f: string[] | null | undefined): string {
  return (f ?? []).map(fechaConvocatoria).join(' · ');
}

export function pesos(n: number | null | undefined): string {
  if (n == null) return '';
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
}

/** ¿Hay descuento real para mostrar tachado? */
export function tieneDescuento(i: Pick<InscripcionConvocatoria, 'valor' | 'valor_con_descuento'>): boolean {
  return i.valor_con_descuento != null && (i.valor == null || i.valor_con_descuento < i.valor);
}

/** Porcentaje del descuento: el de la promo si viene; si no, calculado. */
export function porcentajeDescuento(i: Pick<InscripcionConvocatoria, 'valor' | 'valor_con_descuento' | 'promo_pct'>): number | null {
  if (i.promo_pct != null) return Math.round(i.promo_pct);
  if (i.valor && i.valor_con_descuento != null && i.valor_con_descuento < i.valor) {
    return Math.round((1 - i.valor_con_descuento / i.valor) * 100);
  }
  return null;
}

export function textoTrayectoria(t: boolean | null): string {
  return t == null ? '' : t ? 'Sí' : 'No';
}

// ── Excel ───────────────────────────────────────────────────────────────────

export const COLUMNAS_EXCEL: { header: string; key: string; width: number; type?: 'currency' | 'integer' }[] = [
  { header: '#', key: 'numero', width: 6, type: 'integer' },
  { header: 'Fecha inscripción', key: 'fecha', width: 18 },
  { header: 'Convocatoria', key: 'convocatoria', width: 28 },
  { header: 'Sede', key: 'sede', width: 16 },
  { header: 'Deportista', key: 'deportista', width: 28 },
  { header: 'Acudiente', key: 'acudiente', width: 24 },
  { header: 'Teléfono', key: 'telefono', width: 16 },
  { header: 'Año nac.', key: 'anio', width: 10, type: 'integer' },
  { header: 'Género', key: 'genero', width: 12 },
  { header: 'Trayectoria', key: 'trayectoria', width: 12 },
  { header: 'Detalle', key: 'detalle', width: 30 },
  { header: 'Valor', key: 'valor', width: 14, type: 'currency' },
  { header: 'Valor con descuento', key: 'valor_desc', width: 18, type: 'currency' },
  { header: 'Estado', key: 'estado', width: 12 },
  { header: 'Nota de la escuela', key: 'nota', width: 30 },
  { header: 'Fechas', key: 'fechas', width: 36 },
];

export type FilaExcel = Record<string, string | number | null>;

export function filaExcel(f: FilaNumerada): FilaExcel {
  const i = f.inscripcion;
  return {
    numero: f.numero,
    fecha: fechaInscripcionLarga(i.created_at),
    convocatoria: nombreConvocatoria(i),
    sede: i.sede ?? '',
    deportista: i.deportista ?? '',
    acudiente: i.acudiente ?? i.contacto ?? '',
    telefono: i.telefono ?? '',
    anio: i.anio_nacimiento ?? null,
    genero: i.genero ?? '',
    trayectoria: textoTrayectoria(i.trayectoria),
    detalle: i.detalle ?? '',
    valor: i.valor ?? null,
    valor_desc: tieneDescuento(i) ? i.valor_con_descuento : null,
    estado: etiquetaEstado(estadoDe(i)),
    nota: i.nota_escuela ?? '',
    fechas: textoFechas(i.fechas),
  };
}

/** Nombre de hoja válido para Excel: sin []:*?/\, máximo 31 caracteres, único. */
export function nombreHoja(nombre: string, usados: Set<string>): string {
  const base = (nombre.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Convocatoria').slice(0, 31);
  let candidato = base;
  for (let n = 2; usados.has(candidato.toLowerCase()); n++) {
    const sufijo = ` (${n})`;
    candidato = base.slice(0, 31 - sufijo.length) + sufijo;
  }
  usados.add(candidato.toLowerCase());
  return candidato;
}

/** Una hoja por convocatoria, mismo orden y numeración que la pantalla. */
export function hojasExcel(grupos: GrupoConvocatoria[]): { name: string; rows: FilaExcel[] }[] {
  const usados = new Set<string>();
  return grupos.map((g) => ({ name: nombreHoja(g.convocatoria, usados), rows: g.filas.map(filaExcel) }));
}

/** inscripciones-convocatorias-AAAA-MM-DD (fecha de Bogotá, sin extensión). */
export function nombreArchivoExcel(ahora: Date = new Date()): string {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
  return `inscripciones-convocatorias-${dia}`;
}
