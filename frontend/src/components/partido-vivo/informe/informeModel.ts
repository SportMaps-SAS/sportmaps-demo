/**
 * Informe del partido en vivo (spec partido-en-vivo-sustituciones §9.3.1): funciones PURAS.
 * Entrada: el JSON de `match_live_report` (`_live_report_data`). Salida: una estructura con el
 * orden fijo de Carmel, que consumen el PDF y el texto «Copiar para WhatsApp».
 * Los campos de origen de minutos (`minutes_live`, `minutes_published`, `minutes_source`) son
 * OPCIONALES: si no vienen, se usa `minutes`.
 */

export interface LiveSubject { name?: string | null; jersey_number?: number | null }
export interface LiveLineupRow extends LiveSubject {
  subject_type?: string; subject_id?: string; role?: 'starter' | 'bench' | string;
  seconds?: number; minutes?: number; pct?: number; sent_off?: boolean;
  minutes_live?: number | null; minutes_published?: number | null; minutes_source?: string | null;
}
export interface LiveSub { second?: number; in_break?: boolean; in?: LiveSubject; out?: LiveSubject }
export interface LiveGoalFor { period_no: number; second: number; scorer?: LiveSubject; assist?: LiveSubject | null }
export interface LiveGoalAgainst { period_no: number; second: number }
export interface LiveCard { type: 'yellow' | 'red' | string; period_no: number; second: number; subject?: LiveSubject }

export interface LiveReportData {
  match?: {
    id?: string; date?: string | null; kickoff_at?: string | null; opponent?: string | null;
    location?: string | null; is_home?: boolean | null; school_name?: string | null;
  };
  status?: string;
  lineup?: LiveLineupRow[];
  starters?: LiveLineupRow[];
  bench?: LiveLineupRow[];
  subs_by_period?: { period_no: number; items: LiveSub[] }[];
  goals_for?: LiveGoalFor[];
  goals_against?: LiveGoalAgainst[];
  cards?: LiveCard[];
  total_played_seconds?: number;
  duration_label?: string | null;
  score?: { for?: number; against?: number };
}

export interface InformeModel {
  titulo: string;
  fecha: string;
  hora: string | null;
  partido: string;
  lugar: string | null;
  resultado: string;
  alineacion: string[];
  banca: string[];
  cambios: { periodo: string; lineas: string[] }[];
  anotaciones: string[];
  golesContra: string[];
  amonestaciones: string[];
  informeGeneral: string;
  duracion: string | null;
  minutos: { nombre: string; dorsal: number | null; minutos: number; pct: number; origen: string | null }[];
}

export const periodLabel = (n: number): string =>
  n === 1 ? '1.er tiempo' : n === 2 ? '2.º tiempo' : n === 3 ? '3.er tiempo' : '4.º tiempo';

/** Reloj dentro del tiempo: 11' | 7'47" | 25" (segundos solo cuando no es redondo). */
export function fmtClock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m}'`;
  return m === 0 ? `${r}"` : `${m}'${String(r).padStart(2, '0')}"`;
}

/** «Nombre Apellido 10» (el dorsal va solo si existe). */
export function nombreConDorsal(s: LiveSubject | undefined | null): string {
  const n = (s?.name ?? '').trim() || 'Sin nombre';
  return s?.jersey_number != null ? `${n} ${s.jersey_number}` : n;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** 'YYYY-MM-DD' (o ISO) → «5 de noviembre de 2026», sin desfase de zona horaria. */
export function fmtFechaLarga(d: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '');
  if (!m) return d ?? '';
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

/** timestamptz → «HH:MM» en hora de Colombia (UTC-5, sin horario de verano). */
export function fmtHoraBogota(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const b = new Date(t - 5 * 3600 * 1000);
  return `${String(b.getUTCHours()).padStart(2, '0')}:${String(b.getUTCMinutes()).padStart(2, '0')}`;
}

/** Minutos efectivos de una fila: publicados > en vivo > calculados por el RPC. */
export function minutosEfectivos(r: LiveLineupRow): number {
  const v = r.minutes_published ?? r.minutes_live ?? r.minutes ?? 0;
  return Number.isFinite(v) ? v : 0;
}

const ORIGEN: Record<string, string> = { live: 'en vivo', manual: 'manual', published: 'publicado' };

export function buildInforme(d: LiveReportData, opts: { informeGeneral?: string | null } = {}): InformeModel {
  const m = d.match ?? {};
  const escuela = (m.school_name ?? '').trim() || 'Escuela';
  const rival = (m.opponent ?? '').trim() || 'Rival';
  const lineup = d.lineup ?? [...(d.starters ?? []), ...(d.bench ?? [])];
  const titulares = d.starters ?? lineup.filter((r) => r.role === 'starter');
  const banca = d.bench ?? lineup.filter((r) => r.role === 'bench');
  const lugar = (m.location ?? '').trim();

  const cambios = [...(d.subs_by_period ?? [])]
    .sort((a, b) => a.period_no - b.period_no)
    .map((g) => ({
      periodo: periodLabel(g.period_no),
      lineas: [...(g.items ?? [])]
        .sort((a, b) => Number(!!b.in_break) - Number(!!a.in_break) || (a.second ?? 0) - (b.second ?? 0))
        .map((i) => `${nombreConDorsal(i.in)} ingresa ${i.in_break ? 'en el descanso' : `al ${fmtClock(i.second)}`} (sale ${nombreConDorsal(i.out)})`),
    }))
    .filter((g) => g.lineas.length > 0);

  const porTiempo = <T extends { period_no: number; second: number }>(xs: T[] | undefined) =>
    [...(xs ?? [])].sort((a, b) => a.period_no - b.period_no || a.second - b.second);

  const anotaciones = porTiempo(d.goals_for).map((g) =>
    `${nombreConDorsal(g.scorer)} ${fmtClock(g.second)}${g.assist ? ` (asist. ${nombreConDorsal(g.assist)})` : ''}`);
  // Gol en contra: solo minuto y tiempo, SIN autor (el rival no tiene alineación).
  const golesContra = porTiempo(d.goals_against).map((g) => `${fmtClock(g.second)} ${periodLabel(g.period_no).toLowerCase()}`);
  const amonestaciones = porTiempo(d.cards).map((c) =>
    `${c.type === 'red' ? 'Roja' : 'Amarilla'}: ${nombreConDorsal(c.subject)} ${fmtClock(c.second)} (${periodLabel(c.period_no)})`);

  const sc = d.score ?? {};
  const total = d.total_played_seconds ?? 0;
  return {
    titulo: 'Informe del partido',
    fecha: fmtFechaLarga(m.date),
    hora: fmtHoraBogota(m.kickoff_at),
    partido: m.is_home === false ? `${rival} vs ${escuela}` : `${escuela} vs ${rival}`,
    lugar: lugar || null,
    resultado: `${sc.for ?? 0}-${sc.against ?? 0}`,
    alineacion: titulares.map(nombreConDorsal),
    banca: banca.map(nombreConDorsal),
    cambios,
    anotaciones,
    golesContra,
    amonestaciones,
    informeGeneral: (opts.informeGeneral ?? '').trim(),
    duracion: d.duration_label ?? (total > 0 ? `casi ${Math.round(total / 60)} minutos` : null),
    minutos: lineup.map((r) => ({
      nombre: (r.name ?? '').trim() || 'Sin nombre',
      dorsal: r.jersey_number ?? null,
      minutos: minutosEfectivos(r),
      pct: r.pct ?? 0,
      origen: r.minutes_source ? (ORIGEN[r.minutes_source] ?? r.minutes_source) : null,
    })),
  };
}

/** «subject_type:subject_id» → minutos efectivos (misma clave que `claveSujeto` de PartidoFlujo). */
export function mapaMinutosVivo(d: LiveReportData | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of d?.lineup ?? []) {
    if (r.subject_type && r.subject_id) out.set(`${r.subject_type}:${r.subject_id}`, minutosEfectivos(r));
  }
  return out;
}

const esBorradorDeSistema = (t: string) => /^Informe del partido\n/.test(t) || /^Alineación:\n/.test(t);

/**
 * Texto libre del entrenador para «Informe General»: `development`, o `summary` si no hay.
 * Se ignora el borrador por plantilla que arma el servidor (_live_draft_report) para no duplicarlo.
 */
export function informeGeneralDe(summary: string | null | undefined, development: string | null | undefined): string {
  for (const t of [development, summary]) {
    const v = (t ?? '').trim();
    if (v && !esBorradorDeSistema(v)) return v;
  }
  return '';
}

const lista = (xs: string[], vacio: string) => (xs.length ? xs.join('\n') : vacio);

/** Texto «Copiar para WhatsApp»: misma plantilla y orden que el PDF. */
export function informeToWhatsApp(i: InformeModel): string {
  const out: string[] = [];
  out.push(`*${i.titulo}*`);
  out.push(`Fecha: ${i.fecha}`);
  if (i.hora) out.push(`Hora: ${i.hora}`);
  out.push(`Partido: ${i.partido}`);
  if (i.lugar) out.push(`Lugar: ${i.lugar}`);
  out.push(`Resultado: ${i.resultado}`);
  out.push('', '*Alineación*', lista(i.alineacion, 'Sin titulares'));
  out.push('', '*Sustituciones*', lista(i.banca, 'Ninguno'));
  out.push('', '*Cambios realizados*');
  out.push(i.cambios.length ? i.cambios.map((g) => `${g.periodo}\n${g.lineas.join('\n')}`).join('\n') : 'Ninguno');
  out.push('', '*Anotaciones*', lista(i.anotaciones, 'Ninguna'));
  out.push('', '*Goles en contra*', lista(i.golesContra, 'Ninguno'));
  out.push('', '*Amonestaciones*', lista(i.amonestaciones, 'Ninguna'));
  out.push('', '*Informe General*');
  if (i.informeGeneral) out.push(i.informeGeneral);
  if (i.duracion) out.push('', `Duración total: ${i.duracion}`);
  return out.join('\n').replace(/\n+$/, '');
}
