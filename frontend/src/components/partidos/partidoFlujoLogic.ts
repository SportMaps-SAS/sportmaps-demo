/**
 * Lógica pura de la pantalla del partido (Programar → Convocar → Cerrar →
 * Evaluar → Reporte). Sin React ni red: lo que decide qué se muestra vive acá
 * para poder probarlo.
 *
 * Spec: docs/specs/partidos-registro-y-evaluacion-por-jugador.md (F3/F4).
 * Base: RPCs de 20260926131340 (create_match, update_match, save_match_roster,
 * submit_match_evaluation, publish_match_evaluation).
 */

// ── Barra de guardar (celular) ──────────────────────────────────────────────

/**
 * Barra fija de «Guardar resultado» / «Guardar evaluación». En el celular va
 * ENCIMA de MobileBottomNav (`bottom-nav-safe` = alto de la barra + safe-area;
 * antes era `bottom-0 z-20` y la barra de pestañas, z-30, tapaba el botón) y
 * deja libre la esquina derecha donde flota el botón de Mapi (`pr-20`). En
 * md+ la navegación inferior no existe y la barra vuelve al flujo normal.
 */
export const BARRA_GUARDAR =
  'fixed inset-x-0 bottom-nav-safe z-30 border-t bg-background/95 py-3 pl-3 pr-20 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0';

// ── Pasos ───────────────────────────────────────────────────────────────────

export type PasoPartido = 'programar' | 'convocar' | 'cerrar' | 'evaluar' | 'reporte';

export const PASOS: ReadonlyArray<{ id: PasoPartido; titulo: string }> = [
  { id: 'programar', titulo: 'Programar' },
  { id: 'convocar', titulo: 'Convocar' },
  { id: 'cerrar', titulo: 'Resultado' },
  { id: 'evaluar', titulo: 'Evaluar' },
  { id: 'reporte', titulo: 'Reporte' },
];

export const indicePaso = (p: PasoPartido): number => PASOS.findIndex((x) => x.id === p);

export function pasoSiguiente(p: PasoPartido): PasoPartido | null {
  const i = indicePaso(p);
  return i >= 0 && i < PASOS.length - 1 ? PASOS[i + 1].id : null;
}

export function pasoAnterior(p: PasoPartido): PasoPartido | null {
  const i = indicePaso(p);
  return i > 0 ? PASOS[i - 1].id : null;
}

/** Lo mínimo del partido que hace falta para decidir el paso. */
export interface PartidoBase {
  id: string;
  match_date: string;
  status: string | null;
  home_score: number | null;
  away_score: number | null;
  is_home: boolean | null;
}

/**
 * Dónde abrir la pantalla:
 *  - partido nuevo → Programar
 *  - programado y todavía no llega el día → Convocar
 *  - programado y ya es el día (o pasó) → Resultado
 *  - jugado sin evaluación → Evaluar
 *  - jugado y evaluado → Reporte
 */
export function pasoInicial(
  partido: PartidoBase | null,
  ctx: { hoyIso: string; tieneEvaluacion: boolean },
): PasoPartido {
  if (!partido) return 'programar';
  const jugado = partido.status === 'played' || (partido.home_score != null && partido.away_score != null);
  if (partido.status === 'cancelled') return 'programar';
  if (!jugado) return partido.match_date > ctx.hoyIso ? 'convocar' : 'cerrar';
  return ctx.tieneEvaluacion ? 'reporte' : 'evaluar';
}

/** Un partido ya hecho no se puede convocar ni evaluar hasta que exista. */
export function pasoHabilitado(p: PasoPartido, existe: boolean): boolean {
  return p === 'programar' || existe;
}

// ── Fecha y hora ────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' + 'HH:MM' en hora de Colombia → ISO con -05:00. Sin hora → null. */
export function kickoffIso(fecha: string, hora: string | null | undefined): string | null {
  if (!fecha || !hora || !/^\d{2}:\d{2}$/.test(hora)) return null;
  return `${fecha}T${hora}:00-05:00`;
}

/** ISO → 'HH:MM' en hora de Colombia (para precargar el campo de hora). */
export function horaDeKickoff(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// ── Marcador ────────────────────────────────────────────────────────────────

export type TipoEvento = 'goal' | 'assist' | 'own_goal' | 'yellow' | 'red';

export interface EventoPartido {
  id?: string;
  subject_type: string;
  subject_id: string;
  type: TipoEvento | string;
}

/**
 * Goles que salen de los eventos: los `goal` de nuestras jugadoras son
 * nuestros; los `own_goal` (autogol de una jugadora nuestra) suman al rival.
 */
export function sumaGoles(eventos: EventoPartido[]): { nuestros: number; autogoles: number } {
  let nuestros = 0;
  let autogoles = 0;
  for (const e of eventos) {
    if (e.type === 'goal') nuestros++;
    else if (e.type === 'own_goal') autogoles++;
  }
  return { nuestros, autogoles };
}

/** Marcador guardado leído desde «nosotros / ellos» (home/away según local). */
export function marcadorPropio(p: Pick<PartidoBase, 'home_score' | 'away_score' | 'is_home'>): { nuestros: number | null; rival: number | null } {
  const local = p.is_home !== false;
  return {
    nuestros: local ? p.home_score : p.away_score,
    rival: local ? p.away_score : p.home_score,
  };
}

/** «Nosotros / ellos» → columnas home_score / away_score. */
export function aColumnasMarcador(nuestros: number, rival: number, esLocal: boolean | null): { home_score: number; away_score: number } {
  return esLocal === false ? { home_score: rival, away_score: nuestros } : { home_score: nuestros, away_score: rival };
}

/**
 * Valor inicial de nuestro marcador: si se registraron goles por jugadora,
 * manda la suma; si no, lo que ya estaba guardado; si nada, 0.
 */
export function marcadorNuestroSugerido(guardado: number | null, eventos: EventoPartido[]): number {
  const { nuestros } = sumaGoles(eventos);
  if (nuestros > 0) return nuestros;
  return guardado ?? 0;
}

/** Valor inicial del rival: lo guardado, o como mínimo los autogoles. */
export function marcadorRivalSugerido(guardado: number | null, eventos: EventoPartido[]): number {
  const { autogoles } = sumaGoles(eventos);
  return Math.max(guardado ?? 0, autogoles);
}

/** Conteo por jugadora y tipo: clave «tipo:id» → { goal: n, … }. */
export function eventosPorJugadora(eventos: EventoPartido[]): Map<string, Partial<Record<string, number>>> {
  const m = new Map<string, Partial<Record<string, number>>>();
  for (const e of eventos) {
    const k = `${e.subject_type}:${e.subject_id}`;
    const c = m.get(k) ?? {};
    c[e.type] = (c[e.type] ?? 0) + 1;
    m.set(k, c);
  }
  return m;
}

/** El último evento de ese tipo de esa jugadora (para quitarlo con «−»). */
export function ultimoEvento<T extends EventoPartido>(eventos: T[], clave: string, tipo: string): T | null {
  for (let i = 0; i < eventos.length; i++) {
    // getFootballEvents viene ordenado del más nuevo al más viejo.
    const e = eventos[i];
    if (`${e.subject_type}:${e.subject_id}` === clave && e.type === tipo) return e;
  }
  return null;
}

/** Goles, asistencias y tarjetas por jugadora solo tienen sentido en fútbol. */
export function usaEventosDeFutbol(deporte: string | null | undefined): boolean {
  if (!deporte) return false;
  const d = deporte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /futbol|soccer|futsal|microfutbol/.test(d);
}

// ── Evaluación ──────────────────────────────────────────────────────────────

export interface Sujeto { subject_type: string; subject_id: string }

export const claveSujeto = (s: Sujeto): string => `${s.subject_type}:${s.subject_id}`;

/** Se evalúa SOLO a quien quedó convocado, una vez cada una. */
export function quienesSeEvaluan<T extends Sujeto>(convocados: T[] | null | undefined): T[] {
  const vistos = new Set<string>();
  const out: T[] = [];
  for (const c of convocados ?? []) {
    const k = claveSujeto(c);
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(c);
  }
  return out;
}

export type Escala = 'scale_1_5' | 'scale_1_10' | 'yes_no' | 'number' | 'text';

export interface Criterio {
  metric_key: string;
  display_name: string;
  scale: Escala;
  applies_to?: 'match' | 'training' | 'both' | string | null;
  is_active?: boolean | null;
  sort_order?: number | null;
}

/** Criterios de partido de la escuela: activos, que apliquen a partido, en orden. */
export function criteriosDePartido<T extends Criterio>(filas: T[] | null | undefined): T[] {
  return (filas ?? [])
    .filter((c) => c.is_active !== false && (c.applies_to == null || c.applies_to === 'match' || c.applies_to === 'both'))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** Valor capturado: número para escalas, texto para comentario. */
export type ValorEval = { value?: number | ''; notes?: string };

export type Planilla = Record<string, Record<string, ValorEval>>; // claveSujeto → metric_key → valor

/** Filas guardadas (performance_entries) → planilla para editar. */
export function planillaDesdeFilas(
  filas: Array<{ subject_type: string; subject_id: string; metric_key: string; value: number | null; notes: string | null }>,
  criterios: Criterio[],
): Planilla {
  const escala = new Map(criterios.map((c) => [c.metric_key, c.scale]));
  const p: Planilla = {};
  for (const f of filas) {
    const k = claveSujeto(f);
    p[k] = p[k] ?? {};
    p[k][f.metric_key] = escala.get(f.metric_key) === 'text' ? { notes: f.notes ?? '' } : { value: f.value ?? '' };
  }
  return p;
}

/** `p_entries` para submit_match_evaluation: solo lo que tiene valor y es de alguien evaluable. */
export function entradasEvaluacion(planilla: Planilla, criterios: Criterio[], evaluables: Sujeto[]) {
  const porClave = new Map(criterios.map((c) => [c.metric_key, c]));
  const permitidos = new Map(evaluables.map((s) => [claveSujeto(s), s]));
  const out: Array<{ subject_type: string; subject_id: string; metric_key: string; value: number | null; notes: string | null }> = [];
  for (const [k, vals] of Object.entries(planilla)) {
    const s = permitidos.get(k);
    if (!s) continue;
    for (const [metric, v] of Object.entries(vals)) {
      const c = porClave.get(metric);
      if (!c) continue;
      if (c.scale === 'text') {
        const t = (v.notes ?? '').trim();
        if (t) out.push({ subject_type: s.subject_type, subject_id: s.subject_id, metric_key: metric, value: 0, notes: t });
      } else if (v.value !== '' && v.value != null && Number.isFinite(v.value)) {
        out.push({ subject_type: s.subject_type, subject_id: s.subject_id, metric_key: metric, value: v.value, notes: null });
      }
    }
  }
  return out;
}

/** ¿Cuántas evaluables tienen al menos un criterio con valor? */
export function evaluadasDe(planilla: Planilla, criterios: Criterio[], evaluables: Sujeto[]): number {
  const conValor = new Set(entradasEvaluacion(planilla, criterios, evaluables).map((e) => claveSujeto(e)));
  return conValor.size;
}
