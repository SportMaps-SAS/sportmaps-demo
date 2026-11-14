/**
 * Sesiones V2 del entrenador — lógica PURA.
 * El plan en palabras de la cancha: «Plan del mes» (no «mesociclo»), «semana»
 * (no «microciclo»), «qué tan duro» / carga Suave · Media · Alta (no RPE).
 */
import { sumarDias } from './asistenciaModel';

export interface BloqueV2 {
  id?: string;
  /** Índice dentro de session_blocks (null si el bloque se armó con calentamiento/ejercicios sueltos). */
  index: number | null;
  nombre: string;
  minutos: number | null;
  texto: string;
}

export function objetivoTexto(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').join(' · ');
  return '';
}

function minutosDe(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.match(/\d+/);
    return m ? Number(m[0]) : null;
  }
  return null;
}

/**
 * Bloques de una sesión, en orden. Si la sesión no tiene `session_blocks`
 * (sesiones viejas), se arman con el calentamiento y los ejercicios.
 */
export function bloquesDeSesion(s: { session_blocks?: unknown; warmup?: string | null; drills?: unknown } | null | undefined): BloqueV2[] {
  if (!s) return [];
  const bloques = Array.isArray(s.session_blocks) ? s.session_blocks : [];
  if (bloques.length > 0) {
    return bloques.map((b: Record<string, unknown>, i: number) => ({
      id: typeof b?.id === 'string' ? b.id : undefined,
      index: i,
      nombre: (typeof b?.name === 'string' && b.name.trim()) || `Bloque ${i + 1}`,
      minutos: minutosDe(b?.minutes),
      texto: [b?.activity, b?.description, b?.objective ? `Objetivo: ${b.objective}` : null]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(' '),
    }));
  }
  const out: BloqueV2[] = [];
  if (s.warmup && s.warmup.trim()) out.push({ index: null, nombre: 'Calentamiento', minutos: null, texto: s.warmup });
  const drills = Array.isArray(s.drills) ? s.drills : [];
  for (const d of drills as Record<string, unknown>[]) {
    out.push({
      index: null,
      nombre: (typeof d?.name === 'string' && d.name) || 'Ejercicio',
      minutos: minutosDe(d?.duration),
      texto: typeof d?.focus === 'string' ? d.focus : '',
    });
  }
  return out;
}

export type Carga = 'Suave' | 'Media' | 'Alta';

/** Carga de la semana con el «qué tan duro» planeado de sus días (escala 1–10). */
export function cargaDeSemana(dias: { planned_rpe?: number | null }[]): { carga: Carga; nivel: 1 | 2 | 3 } | null {
  const v = dias.map((d) => d.planned_rpe).filter((x): x is number => typeof x === 'number' && x > 0);
  if (v.length === 0) return null;
  const prom = v.reduce((a, b) => a + b, 0) / v.length;
  if (prom <= 4) return { carga: 'Suave', nivel: 1 };
  if (prom <= 6.5) return { carga: 'Media', nivel: 2 };
  return { carga: 'Alta', nivel: 3 };
}

/** Lunes a domingo de la semana de `hoy` desplazada `offset` semanas. */
export function semanaDe(hoy: string, offset = 0): string[] {
  const d = new Date(`${hoy}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // lunes = 0
  const lunes = sumarDias(hoy, -dow + offset * 7);
  return Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i));
}

export function etiquetaDia(iso: string): { dia: string; num: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const f = new Date(y, m - 1, d);
  const dia = f.toLocaleDateString('es-CO', { weekday: 'short' }).replace('.', '');
  return { dia: dia.charAt(0).toUpperCase() + dia.slice(1), num: String(d) };
}

export function rangoSemana(dias: string[]): string {
  const f = (iso: string, mes: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-CO', mes ? { day: 'numeric', month: 'long' } : { day: 'numeric' });
  };
  const mismoMes = dias[0].slice(0, 7) === dias[6].slice(0, 7);
  return `Semana del ${f(dias[0], !mismoMes)} al ${f(dias[6], true)}`;
}

export function nombreMes(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const n = new Date(y, m - 1, 1).toLocaleDateString('es-CO', { month: 'long' });
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export type EstadoDia = 'Hoy' | 'Hecho' | 'Sin evaluar' | 'Sin lista' | 'Planeado' | '';

/**
 * Cómo va cada día de la semana:
 *  - Hoy: es hoy y hay entreno.
 *  - Hecho: se tomó lista y la sesión tiene evaluación.
 *  - Sin evaluar: se tomó lista pero falta evaluar.
 *  - Sin lista: ya pasó, había sesión y no hay lista.
 *  - Planeado: futuro con sesión.
 */
export function estadoDelDia(fecha: string, hoy: string, haySesion: boolean, hayLista: boolean, evaluada: boolean): EstadoDia {
  if (!haySesion && !hayLista) return '';
  if (fecha === hoy) return 'Hoy';
  if (fecha > hoy) return 'Planeado';
  if (hayLista) return evaluada ? 'Hecho' : 'Sin evaluar';
  return 'Sin lista';
}

export interface SemanaPlan { id: string; number: number | null; starts_on: string; ends_on: string; objective: string | null }

/** Índice (0..n-1) de la semana del plan que contiene hoy; -1 si hoy queda fuera. */
export function semanaActual(semanas: SemanaPlan[], hoy: string): number {
  return semanas.findIndex((w) => w.starts_on <= hoy && hoy <= w.ends_on);
}

/**
 * «hecha» sale de las LISTAS tomadas esa semana (attendance_sessions), no de las
 * sesiones planeadas: una semana pasada sin listas dice «sin listas».
 * Sin `listas` (no se sabe todavía), una semana pasada no lleva estado.
 */
export function textoSemana(i: number, actual: number, semanas: SemanaPlan[], hoy: string, listas?: number): string {
  const n = semanas[i].number ?? i + 1;
  if (i === actual) return `Semana ${n} · esta semana`;
  if (semanas[i].ends_on < hoy) {
    if (listas == null) return `Semana ${n}`;
    return listas > 0 ? `Semana ${n} · hecha` : `Semana ${n} · sin listas`;
  }
  return `Semana ${n}`;
}

// ── Horario de los equipos y plan vigente ────────────────────────────────────

export interface FranjaHorario { day: number; time: string }
export interface EquipoConHorario { id: string; name: string; franjas: FranjaHorario[] }

/** «15:30» → «3:30 p. m.» */
export function horaCorta(hhmm: string): string {
  const [hS, mS = '00'] = hhmm.split(':');
  const h = Number(hS);
  if (Number.isNaN(h)) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mS.padStart(2, '0').slice(0, 2)} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/**
 * Entrenos que el HORARIO del equipo pone ese día (la misma fuente con la que
 * Hoy dice «Hoy entrenas a…»), haya o no sesión planeada. `day` 0 = domingo.
 */
export function entrenosDelHorario(fecha: string, equipos: EquipoConHorario[]): { teamId: string; nombre: string; hora: string | null }[] {
  const [y, m, d] = fecha.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const out: { teamId: string; nombre: string; hora: string | null }[] = [];
  for (const e of equipos) {
    const fr = e.franjas.filter((f) => f.day === dow).sort((a, b) => a.time.localeCompare(b.time));
    if (fr.length) out.push({ teamId: e.id, nombre: e.name, hora: fr[0].time ? horaCorta(fr[0].time) : null });
  }
  return out;
}

/**
 * El plan que rige: el que contiene hoy o, si no, el próximo. Un plan que ya
 * terminó NO se muestra como el del mes (pickDefaultMesocycle sí lo devolvía).
 */
export function planVigente<T extends { starts_on: string; ends_on: string }>(planes: T[], hoy: string): T | null {
  const actual = planes.find((p) => p.starts_on <= hoy && hoy <= p.ends_on);
  if (actual) return actual;
  return planes.filter((p) => p.starts_on > hoy).sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0] ?? null;
}

/** Listas tomadas (claves «equipo|fecha») entre dos fechas, inclusive. */
export function listasEntre(claves: Iterable<string>, desde: string, hasta: string): number {
  let n = 0;
  for (const k of claves) {
    const f = k.slice(k.lastIndexOf('|') + 1);
    if (f >= desde && f <= hasta) n += 1;
  }
  return n;
}

/** Mes «del plan»: el del día del medio (un plan del 31 de agosto al 28 de septiembre es de septiembre). */
export function mesDelPlan(desde: string, hasta: string): string {
  const a = new Date(`${desde}T12:00:00Z`).getTime();
  const b = new Date(`${hasta}T12:00:00Z`).getTime();
  const mitad = new Date(a + (b - a) / 2).toISOString().slice(0, 10);
  return nombreMes(mitad);
}

/**
 * «Planear» / «Crear el plan» abren la planificación completa YA en el equipo
 * y el día (B6): `?equipo=<id>&fecha=<YYYY-MM-DD>`. TrainingPlansPage los lee.
 */
export function rutaPlanear(base: string, ctx: { equipo?: string | null; fecha?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (ctx.equipo) q.set('equipo', ctx.equipo);
  if (ctx.fecha) q.set('fecha', ctx.fecha);
  const s = q.toString();
  if (!s) return base;
  return `${base}${base.includes('?') ? '&' : '?'}${s}`;
}
