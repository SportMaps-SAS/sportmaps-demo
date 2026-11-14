/**
 * Lógica pura del entrenador V2 (Hoy, Equipos, Evaluar). Sin React ni red:
 * todo lo que decide qué se muestra vive acá para poder probarlo.
 *
 * Contrato: docs/specs/entrenador-deportista-v2.md. Decisión 5: el profe NUNCA
 * ve plata — solo «Al día · Pendiente · Vencido» por deportista.
 */
import { leerFranjas, horaColombia, primerNombre, type Franja } from '@/components/parent/v2/parentHomeLogic';
import { whatsappDeLaEscuela } from '@/lib/whatsappEscuela';

export { leerFranjas, horaColombia, primerNombre };
export type { Franja };

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ── Rutas que usan las pantallas (la sesión principal decide las definitivas) ──

export interface RutasCoachV2 {
  tomarLista: string;
  sesiones: string;
  agenda: string;
  equipos: string;
  equipo: (teamId: string, tab?: TabEquipo) => string;
  /** Pantalla «Evaluar al equipo» de una sesión ya cerrada. */
  evaluar: (sessionId: string) => string;
  informeMensual: string;
  informeEntreno: string;
  resultados: string;
  /** Pantalla del partido (Programar → Convocar → Resultado → Evaluar → Reporte). */
  partido: (matchId: string) => string;
  /** Pantalla del partido para uno nuevo de ese equipo. */
  partidoNuevo: (teamId: string) => string;
  misDeportistas: string;
  /** Pizarra libre: dibujar una jugada sin formulario (pantalla independiente). */
  pizarra: string;
}

export type TabEquipo = 'deportistas' | 'partidos' | 'evaluar';

export const RUTAS_COACH_V2: RutasCoachV2 = {
  tomarLista: '/coach-attendance',
  sesiones: '/training-plans',
  agenda: '/coach-plans',
  equipos: '/teams',
  equipo: (teamId, tab) => `/teams?equipo=${encodeURIComponent(teamId)}${tab ? `&tab=${tab}` : ''}`,
  evaluar: (sessionId) => `/coach/evaluar/${encodeURIComponent(sessionId)}`,
  informeMensual: '/informe-mensual',
  informeEntreno: '/coach-reports/entreno-equipo',
  resultados: '/results',
  partido: (matchId) => `/partidos/${encodeURIComponent(matchId)}`,
  partidoNuevo: (teamId) => `/partidos/nuevo?equipo=${encodeURIComponent(teamId)}`,
  misDeportistas: '/students',
  pizarra: '/pizarra',
};

export const conRutas = (r?: Partial<RutasCoachV2>): RutasCoachV2 => ({ ...RUTAS_COACH_V2, ...(r ?? {}) });

// ── RPC que puede no existir todavía (B1–B3) ────────────────────────────────

/** PGRST202 / 404 = la función todavía no está en la base: se oculta la sección. */
export function esRpcInexistente(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; status?: number; message?: string };
  if (e.code === 'PGRST202' || e.code === '42883' || e.status === 404) return true;
  return /could not find the function|function .* does not exist/i.test(e.message ?? '');
}

// ── Estado de pago (decisión 5) ─────────────────────────────────────────────

export type EstadoPago = 'al_dia' | 'pendiente' | 'vencido';

export const ETIQUETA_PAGO: Record<EstadoPago, string> = {
  al_dia: 'Al día',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
};

/**
 * Solo pasan los tres estados del contrato. Cualquier otra cosa (un monto, un
 * concepto, un estado técnico) se descarta: el profe nunca ve plata.
 */
export function normalizarEstadoPago(raw: unknown): EstadoPago | null {
  return raw === 'al_dia' || raw === 'pendiente' || raw === 'vencido' ? raw : null;
}

/** Filas de `team_payment_status` → mapa athlete_key → estado. Ignora todo lo demás. */
export function mapaEstadosPago(rows: unknown): Map<string, EstadoPago> {
  const m = new Map<string, EstadoPago>();
  if (!Array.isArray(rows)) return m;
  for (const r of rows as Array<Record<string, unknown>>) {
    const estado = normalizarEstadoPago(r?.estado);
    if (!estado) continue;
    // athlete_key = 'child:<uuid>' | 'profile:<uuid>' | 'unregistered:<uuid>'; también por subject_id.
    for (const k of [r?.athlete_key, r?.subject_id]) {
      if (typeof k === 'string' && k) m.set(k, estado);
    }
  }
  return m;
}

// ── Cómo le fue (Bien · Normal · Le costó) ───────────────────────────────────

export type ComoLeFue = 'bien' | 'normal' | 'costo';

/**
 * Mapeo a la escala existente de `coach_effort_rating` (performance_entries,
 * context_type='session', 50–100 con opciones 50/60/70/80/90/100; RPC
 * `submit_post_training_coach_rating`). Es la misma métrica que el acudiente ya
 * lee como «Así le fue» (hijosUtils.ratingFromEffort: ≥80 Bien, ≥70 Normal,
 * resto Le costó), así que ida y vuelta da lo mismo:
 *   Bien      → 90 «De muy buena manera»
 *   Normal    → 70 «De forma moderada»
 *   Le costó  → 60 «A la mitad de lo que se le exige»
 */
export const EFFORT_DE: Record<ComoLeFue, number> = { bien: 90, normal: 70, costo: 60 };
export const ETIQUETA_COMO: Record<ComoLeFue, string> = { bien: 'Bien', normal: 'Normal', costo: 'Le costó' };
export const OPCIONES_COMO: ComoLeFue[] = ['bien', 'normal', 'costo'];

export function comoDesdeEffort(v: number | null | undefined): ComoLeFue | null {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  if (n >= 80) return 'bien';
  if (n >= 70) return 'normal';
  return 'costo';
}

/**
 * Qué decirle al profe cuando `submit_post_training_coach_rating` falla (B3).
 * Antes todo error salía como «Revisa tu conexión», incluso cuando la base
 * rechazaba la evaluación por una regla: el profe reintentaba sin fin. Los
 * mensajes de la RPC ya vienen en español, así que se muestran tal cual.
 */
export function mensajeErrorEvaluar(error: { code?: string | null; message?: string | null } | null | undefined): string {
  const code = error?.code ?? '';
  const msg = (error?.message ?? '').trim();
  if (!code && (!msg || /failed to fetch|networkerror|network request failed|load failed/i.test(msg))) {
    return 'Sin conexión: la evaluación no se guardó. Revisa la señal e inténtalo de nuevo.';
  }
  if (code === '42501') return 'No se guardó: no figuras como entrenador de este equipo. Pídele a la administración que te asigne.';
  if (code === 'P0002') return 'No se guardó: este entreno ya no existe.';
  if (msg && (code === '55000' || code === '22023' || code === 'P0001')) return `No se guardó: ${conPunto(msg)}`;
  return 'No se guardó la evaluación por un error del servidor. Inténtalo de nuevo en un momento.';
}

// ── Deportistas ─────────────────────────────────────────────────────────────

export type TipoDeportista = 'child' | 'adult' | 'unregistered';

export interface Deportista {
  /** id de children / profiles / unregistered_athletes (según tipo). */
  id: string;
  tipo: TipoDeportista;
  userId: string | null;
  nombre: string;
  avatarUrl: string | null;
  acudiente: string | null;
  telefonoAcudiente: string | null;
}

/** Sujeto de performance_entries / match_lineup_players. */
export function sujetoDe(d: Pick<Deportista, 'id' | 'tipo' | 'userId'>): { subject_type: 'child' | 'profile' | 'unregistered'; subject_id: string } {
  if (d.tipo === 'child') return { subject_type: 'child', subject_id: d.id };
  if (d.tipo === 'adult') return { subject_type: 'profile', subject_id: d.userId ?? d.id };
  return { subject_type: 'unregistered', subject_id: d.id };
}

/** Jugador ya convocado (match_lineup_players), con lo que no se debe perder al reescribir. */
export interface ConvocadoPrevio {
  subject_type: 'child' | 'profile' | 'unregistered';
  subject_id: string;
  role?: 'starter' | 'bench' | string | null;
  position_code?: string | null;
  jersey_number?: number | null;
  minutes_played?: number | null;
}

export const claveConvocado = (s: { subject_type: string; subject_id: string }): string => `${s.subject_type}:${s.subject_id}`;

/**
 * Convocados que NO están en el roster activo del equipo: refuerzos de otra
 * categoría o inactivos que se sumaron desde la pantalla clásica. Se muestran
 * aparte para que el profe los quite a propósito, nunca por omisión.
 */
export function refuerzosDe(roster: Array<Pick<Deportista, 'id' | 'tipo' | 'userId'>>, previos: ConvocadoPrevio[]): ConvocadoPrevio[] {
  const delRoster = new Set(roster.map((d) => claveConvocado(sujetoDe(d))));
  const vistos = new Set<string>();
  return previos.filter((p) => {
    const k = claveConvocado(p);
    if (delRoster.has(k) || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

/**
 * `p_players` para `save_match_roster` (borra y reinserta TODO): los del roster
 * marcados + los refuerzos (de la convocatoria anterior o recién buscados en
 * esta sesión) que siguen marcados, conservando rol, posición, dorsal y
 * minutos de la convocatoria anterior cuando ya existían.
 */
export function armarConvocatoria(
  roster: Array<Pick<Deportista, 'id' | 'tipo' | 'userId'>>,
  seleccion: Set<string>,
  previos: ConvocadoPrevio[],
  nuevosRefuerzos: Array<{ subject_type: 'child' | 'profile' | 'unregistered'; subject_id: string }> = [],
) {
  const previoDe = new Map(previos.map((p) => [claveConvocado(p), p]));
  const sujetos = [
    ...roster.map(sujetoDe),
    ...refuerzosDe(roster, previos).map((p) => ({ subject_type: p.subject_type, subject_id: p.subject_id })),
    ...nuevosRefuerzos,
  ];
  const vistos = new Set<string>();
  return sujetos
    .filter((s) => { const k = claveConvocado(s); if (!seleccion.has(k) || vistos.has(k)) return false; vistos.add(k); return true; })
    .map((s) => {
      const previo = previoDe.get(claveConvocado(s));
      return {
        ...s,
        role: previo?.role ?? 'starter',
        position_code: previo?.position_code ?? null,
        jersey_number: previo?.jersey_number ?? null,
        minutes_played: previo?.minutes_played ?? null,
      };
    });
}

/** Claves con las que una RPC puede referirse a este deportista. */
export function clavesDe(d: Pick<Deportista, 'id' | 'userId'>): string[] {
  return [d.id, d.userId].filter((x): x is string => !!x);
}

export function estadoPagoDe(d: Pick<Deportista, 'id' | 'userId'>, mapa: Map<string, EstadoPago> | null | undefined): EstadoPago | null {
  if (!mapa) return null;
  for (const k of clavesDe(d)) {
    const e = normalizarEstadoPago(mapa.get(k));
    if (e) return e;
  }
  return null;
}

export const iniciales = (nombre: string) =>
  nombre.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('') || '?';

/** «Sofía Rojas» → «Sofía R.» */
export function nombreCorto(n: string): string {
  const partes = n.trim().split(/\s+/);
  if (partes.length < 2) return partes[0] ?? '';
  return `${partes[0]} ${partes[partes.length - 1].charAt(0)}.`;
}

/** «Fútbol — Sub-15» → «S15»; sin categoría, las iniciales. */
export function abreviaturaEquipo(nombre: string): string {
  const m = /sub[\s-]?(\d{1,2})/i.exec(nombre);
  if (m) return `S${m[1]}`;
  const sinGuion = nombre.replace(/[—–-]/g, ' ');
  return iniciales(sinGuion);
}

/** Enlace de WhatsApp al acudiente con un saludo listo. null si no hay celular válido. */
export function whatsappAcudiente(telefono: string | null | undefined, deportista: string, profe?: string | null): string | null {
  const base = whatsappDeLaEscuela(telefono);
  if (!base) return null;
  const quien = profe ? `soy ${primerNombre(profe)}, profe de ${primerNombre(deportista)}.` : `te escribo por ${primerNombre(deportista)}.`;
  return `${base}?text=${encodeURIComponent(`Hola, ${quien} `)}`;
}

// ── Fechas y momento del día ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDia = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fechaLocal(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const minutos = (hhmm: string) => {
  const [h, m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

const diasEntre = (a: Date, b: Date) =>
  Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
    - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000);

/** «martes 20», «hoy», «ayer». */
export function diaCorto(iso: string, hoy: Date): string {
  const d = fechaLocal(iso);
  if (!d) return iso;
  const dif = diasEntre(d, hoy);
  if (dif === 0) return 'hoy';
  if (dif === 1) return 'ayer';
  return `${DIAS[d.getDay()]} ${d.getDate()}`;
}

/** «Martes 20 de octubre». */
export function diaLargo(iso: string): string {
  const d = fechaLocal(iso);
  if (!d) return iso;
  const t = `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const nombreMes = (mes1a12: number) => MESES[(mes1a12 - 1 + 12) % 12];

export interface EquipoHorario {
  id: string;
  nombre: string;
  lugar: string | null;
  franjas: Franja[];
  deportistas: number;
}

export interface SesionReciente {
  id: string;
  teamId: string;
  fecha: string; // YYYY-MM-DD
  cerrada: boolean;
  evaluada: boolean;
}

export type Momento =
  | { tipo: 'antes'; equipo: EquipoHorario; franja: Franja; enMinutos: number }
  | { tipo: 'durante'; equipo: EquipoHorario; franja: Franja }
  | { tipo: 'despues'; equipo: EquipoHorario; franja: Franja; sesion: SesionReciente | null }
  | { tipo: 'libre'; proximo: { equipo: EquipoHorario; franja: Franja; enDias: number } | null };

/**
 * Qué toca ahora. Entre los entrenos de HOY manda el que está en curso o el
 * próximo; si ya pasaron todos, el último (después del entreno). Un entreno que
 * ya terminó y cuya evaluación ya está hecha no cuenta: se pasa al siguiente.
 */
export function momentoDelDia(equipos: EquipoHorario[], ahora: Date, sesionesHoy: SesionReciente[]): Momento {
  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  const hoy = ahora.getDay();
  const deHoy = equipos
    .flatMap((e) => e.franjas.filter((f) => f.day === hoy).map((f) => ({ e, f })))
    .filter(({ f }) => !Number.isNaN(minutos(f.time)))
    .sort((a, b) => minutos(a.f.time) - minutos(b.f.time));

  const fin = (f: Franja) => (f.end ? minutos(f.end) : minutos(f.time) + 60);

  const enCurso = deHoy.find(({ f }) => minutos(f.time) <= ahoraMin && ahoraMin < fin(f));
  if (enCurso) {
    const s = sesionesHoy.find((x) => x.teamId === enCurso.e.id) ?? null;
    if (s?.cerrada) return { tipo: 'despues', equipo: enCurso.e, franja: enCurso.f, sesion: s };
    return { tipo: 'durante', equipo: enCurso.e, franja: enCurso.f };
  }

  // Después de uno que terminó y sigue sin evaluar → evaluar primero.
  const terminados = deHoy.filter(({ f }) => fin(f) <= ahoraMin);
  for (let i = terminados.length - 1; i >= 0; i--) {
    const { e, f } = terminados[i];
    const s = sesionesHoy.find((x) => x.teamId === e.id) ?? null;
    if (!s || !s.evaluada) return { tipo: 'despues', equipo: e, franja: f, sesion: s };
  }

  const siguiente = deHoy.find(({ f }) => minutos(f.time) > ahoraMin);
  if (siguiente) {
    return { tipo: 'antes', equipo: siguiente.e, franja: siguiente.f, enMinutos: minutos(siguiente.f.time) - ahoraMin };
  }

  // Día sin entreno (o ya terminó todo): el próximo en los siguientes 7 días.
  let mejor: { equipo: EquipoHorario; franja: Franja; enDias: number; orden: number } | null = null;
  for (const e of equipos) {
    for (const f of e.franjas) {
      const enDias = ((f.day - hoy + 7) % 7) || 7;
      const orden = enDias * 1440 + minutos(f.time);
      if (Number.isNaN(orden)) continue;
      if (!mejor || orden < mejor.orden) mejor = { equipo: e, franja: f, enDias, orden };
    }
  }
  return { tipo: 'libre', proximo: mejor ? { equipo: mejor.equipo, franja: mejor.franja, enDias: mejor.enDias } : null };
}

/**
 * Resumen de la semana (lunes a hoy) para Hoy: entrenos con lista, cuántos
 * con la lista tomada y cuántos cerrados sin evaluar. Con «Hoy no entrenas» es
 * lo que llena la pantalla (ítem 30).
 */
export function resumenSemana(sesiones: Array<Pick<SesionReciente, 'fecha' | 'cerrada' | 'evaluada'>>, ahora: Date): {
  entrenos: number; conLista: number; sinEvaluar: number;
} {
  const lunes = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - ((ahora.getDay() + 6) % 7));
  const desde = isoDia(lunes);
  const hasta = isoDia(ahora);
  const deLaSemana = sesiones.filter((s) => s.fecha >= desde && s.fecha <= hasta);
  return {
    entrenos: deLaSemana.length,
    conLista: deLaSemana.filter((s) => s.cerrada).length,
    sinEvaluar: deLaSemana.filter((s) => s.cerrada && !s.evaluada).length,
  };
}

/** Equipos sin horario fijo (ítem 31: «Agregar horario» o pedírselo a la administración). */
export function equiposSinHorario<T extends Pick<EquipoHorario, 'franjas'>>(equipos: T[]): T[] {
  return equipos.filter((e) => e.franjas.length === 0);
}

/** Cierra con punto sin duplicarlo («p. m.» ya lo trae). */
export const conPunto = (t: string) => (t.endsWith('.') ? t : `${t}.`);

/** La frase grande de Hoy. */
export function fraseMomento(m: Momento, vinieron?: number | null): { titulo: string; detalle: string | null } {
  const lugar = (e: EquipoHorario, f: Franja) => f.place || e.lugar || null;
  if (m.tipo === 'antes') {
    const titulo = m.enMinutos <= 90
      ? `En ${m.enMinutos} minutos entrenas a ${m.equipo.nombre}.`
      : conPunto(`Hoy entrenas a ${m.equipo.nombre} a las ${horaColombia(m.franja.time)}`);
    const detalle = [lugar(m.equipo, m.franja), m.equipo.deportistas ? `${m.equipo.deportistas} deportistas` : null, horaColombia(m.franja.time)]
      .filter(Boolean).join(' · ');
    return { titulo, detalle };
  }
  if (m.tipo === 'durante') {
    return { titulo: `Ya empezó el entreno de ${m.equipo.nombre}.`, detalle: 'Toma la lista: todos arrancan en «Vino».' };
  }
  if (m.tipo === 'despues') {
    if (!m.sesion?.cerrada) {
      return { titulo: `¿Ya tomaste la lista de ${m.equipo.nombre}?`, detalle: 'El entreno de hoy todavía no tiene lista.' };
    }
    const titulo = vinieron != null && m.equipo.deportistas
      ? `Vinieron ${vinieron} de ${m.equipo.deportistas}. ¿Cómo le fue a ${m.equipo.nombre}?`
      : `¿Cómo le fue a ${m.equipo.nombre}?`;
    return { titulo, detalle: 'Un toque por deportista. Las familias reciben el resumen.' };
  }
  if (!m.proximo) return { titulo: 'Hoy no entrenas.', detalle: 'No tienes entrenos con horario en tus equipos.' };
  const { equipo, franja, enDias } = m.proximo;
  const cuando = enDias === 1 ? 'Mañana' : `El ${DIAS[franja.day]}`;
  const donde = lugar(equipo, franja);
  return {
    titulo: 'Hoy no entrenas.',
    detalle: conPunto(`${cuando}: ${equipo.nombre} a las ${horaColombia(franja.time)}${donde ? ` en ${donde}` : ''}`),
  };
}

// ── Pendientes ──────────────────────────────────────────────────────────────

export interface Pendiente {
  id: string;
  titulo: string;
  detalle: string;
  cta: string;
  href: string;
}

export interface InformeEquipo {
  teamId: string;
  equipo: string;
  total: number;
  listos: number;
  publicados: number;
  faltanNota: number;
}

export interface PartidoProximo {
  id: string;
  teamId: string;
  equipo: string;
  rival: string;
  fecha: string;
  hora: string | null;
  convocado: boolean;
}

export function construirPendientes(args: {
  sinEvaluar: Array<SesionReciente & { equipo: string }>;
  informes: InformeEquipo[];
  /** La escuela le deja publicar al profe («Quién publica y envía» = cada entrenador). */
  puedePublicar: boolean;
  mes: number;
  partidos: PartidoProximo[];
  ocultos: string[];
  hoy: Date;
  rutas: RutasCoachV2;
}): Pendiente[] {
  const { hoy, rutas } = args;
  const out: Pendiente[] = [];
  for (const s of args.sinEvaluar) {
    const dia = diaCorto(s.fecha, hoy);
    out.push({
      id: `eval:${s.id}`,
      titulo: `Falta evaluar el entreno ${dia === 'hoy' || dia === 'ayer' ? `de ${dia}` : `del ${dia}`}`,
      detalle: `${s.equipo} · un toque por deportista · 1 minuto`,
      cta: 'Evaluar',
      href: rutas.evaluar(s.id),
    });
  }
  if (args.puedePublicar) {
    for (const i of args.informes) {
      const porPublicar = i.listos;
      if (porPublicar <= 0) continue;
      out.push({
        id: `inf:${i.teamId}:${args.mes}`,
        titulo: `Informe de ${nombreMes(args.mes)} por publicar`,
        detalle: `${i.equipo} · ${porPublicar} de ${i.total} listos`,
        cta: 'Publicar',
        href: rutas.equipo(i.teamId, 'evaluar'),
      });
    }
  }
  for (const p of args.partidos) {
    if (p.convocado) continue;
    const d = fechaLocal(p.fecha);
    const cuando = d ? (diasEntre(hoy, d) === 0 ? 'de hoy' : diasEntre(hoy, d) === 1 ? 'de mañana' : `del ${DIAS[d.getDay()]}`) : '';
    out.push({
      id: `conv:${p.id}`,
      titulo: `Convocar al partido ${cuando}`.trim(),
      detalle: `${p.equipo} contra ${p.rival}${p.hora ? ` · ${p.hora}` : ''}`,
      cta: 'Convocar',
      href: rutas.equipo(p.teamId, 'partidos'),
    });
  }
  return out.filter((p) => !args.ocultos.includes(p.id));
}

// ── «Más tarde»: se esconde hasta mañana (solo en este navegador) ───────────

const claveMasTarde = (hoy: Date) => `sm_coach_v2_mas_tarde_${isoDia(hoy)}`;

export function leerMasTarde(hoy: Date): string[] {
  try {
    const raw = localStorage.getItem(claveMasTarde(hoy));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function guardarMasTarde(hoy: Date, ids: string[]): void {
  try {
    localStorage.setItem(claveMasTarde(hoy), JSON.stringify(ids));
  } catch {
    /* modo privado: se pierde al recargar, no pasa nada */
  }
}

// ── Plan de hoy (training_sessions) ─────────────────────────────────────────

export interface PasoPlan { min: string | null; texto: string }

/** session_blocks (nuevo) o drills (viejo) → pasos legibles. */
export function pasosDelPlan(s: { session_blocks?: unknown; drills?: unknown; warmup?: string | null }): PasoPlan[] {
  const leer = (arr: unknown): PasoPlan[] =>
    Array.isArray(arr)
      ? (arr as Array<Record<string, unknown> | null>)
          .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
          .map((b) => {
            const texto = String(b.activity || b.name || b.description || b.objective || '').trim();
            const m = b.minutes ?? b.duration ?? null;
            return { min: m != null && String(m).trim() !== '' ? `${String(m).replace(/\D/g, '') || m}′` : null, texto };
          })
          .filter((p) => p.texto)
      : [];
  const bloques = leer(s.session_blocks);
  if (bloques.length) return bloques;
  const ejercicios = leer(s.drills);
  if (s.warmup?.trim()) ejercicios.unshift({ min: null, texto: `Calentamiento: ${s.warmup.trim()}` });
  return ejercicios;
}

export function minutosTotales(pasos: PasoPlan[]): number | null {
  const n = pasos.reduce((acc, p) => acc + (p.min ? Number(p.min.replace(/\D/g, '')) || 0 : 0), 0);
  return n > 0 ? n : null;
}

// ── Partidos ────────────────────────────────────────────────────────────────

export interface Partido {
  id: string;
  rival: string;
  fecha: string;
  kickoffAt: string | null;
  lugar: string | null;
  enCasa: boolean | null;
  golesLocal: number | null;
  golesVisita: number | null;
  estado: string | null;
  tipo: string | null;
  nota: string | null;
}

export function horaDePartido(p: Pick<Partido, 'kickoffAt'>): string | null {
  if (!p.kickoffAt) return null;
  const d = new Date(p.kickoffAt);
  if (Number.isNaN(d.getTime())) return null;
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return horaColombia(hhmm);
}

export function resultadoDe(p: Partido): { marcador: string; frase: string; tono: 'gana' | 'pierde' | 'empata' } | null {
  if (p.golesLocal == null || p.golesVisita == null) return null;
  const nuestros = p.enCasa === false ? p.golesVisita : p.golesLocal;
  const suyos = p.enCasa === false ? p.golesLocal : p.golesVisita;
  const marcador = `${nuestros} – ${suyos}`;
  if (nuestros > suyos) return { marcador, frase: `Ganamos a ${p.rival}`, tono: 'gana' };
  if (nuestros < suyos) return { marcador, frase: `Perdimos con ${p.rival}`, tono: 'pierde' };
  return { marcador, frase: `Empatamos con ${p.rival}`, tono: 'empata' };
}

export function proximoPartido(partidos: Partido[], hoy: Date): Partido | null {
  const hoyIso = isoDia(hoy);
  return partidos
    .filter((p) => p.estado !== 'cancelled' && p.fecha >= hoyIso && (p.golesLocal == null || p.golesVisita == null))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0))[0] ?? null;
}

/** Conteo de respuestas de `callup_status`. */
export function contarRespuestas(rows: Array<{ respuesta: string | null }>): { van: number; noVan: number; sinResponder: number } {
  let van = 0;
  let noVan = 0;
  let sinResponder = 0;
  for (const r of rows) {
    if (r.respuesta === 'va') van++;
    else if (r.respuesta === 'no_va') noVan++;
    else sinResponder++;
  }
  return { van, noVan, sinResponder };
}

// ── Tarjeta de equipo ───────────────────────────────────────────────────────

const DIAS_CORTOS = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

/** «Martes y jueves · 4:00 p. m. · Cancha 2» */
export function horarioDe(e: EquipoHorario): string {
  if (e.franjas.length === 0) return e.lugar ?? 'Sin horario fijo';
  const dias = [...new Set(e.franjas.map((f) => f.day))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DIAS_CORTOS[d]);
  const listaDias = dias.length > 1 ? `${dias.slice(0, -1).join(', ')} y ${dias[dias.length - 1]}` : dias[0];
  const horas = [...new Set(e.franjas.map((f) => horaColombia(f.time)))];
  const lugar = e.franjas.find((f) => f.place)?.place ?? null;
  return [listaDias.charAt(0).toUpperCase() + listaDias.slice(1), horas.length === 1 ? horas[0] : null, lugar].filter(Boolean).join(' · ');
}

/** «Hoy», «Mañana», «Sábado», «—». */
export function proximoDe(e: EquipoHorario, ahora: Date): string {
  if (e.franjas.length === 0) return '—';
  const hoy = ahora.getDay();
  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  let mejor = 8;
  for (const f of e.franjas) {
    const [h, m = '0'] = f.time.split(':');
    const finMin = f.end ? Number(f.end.split(':')[0]) * 60 + Number(f.end.split(':')[1] ?? 0) : Number(h) * 60 + Number(m);
    let d = (f.day - hoy + 7) % 7;
    if (d === 0 && finMin <= ahoraMin) d = 7;
    mejor = Math.min(mejor, d);
  }
  if (mejor === 0) return 'Hoy';
  if (mejor === 1) return 'Mañana';
  const dia = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'][(hoy + mejor) % 7];
  return dia;
}


/** Rutas de la vista previa (CoachV2Preview) a partir de su base. */
export function rutasDePreview(base: string): Partial<RutasCoachV2> {
  const b = base.replace(/\/$/, '');
  return {
    equipos: `${b}/equipos`,
    equipo: (teamId, tab) => `${b}/equipos?equipo=${encodeURIComponent(teamId)}${tab ? `&tab=${tab}` : ''}`,
    evaluar: (sessionId) => `${b}/evaluar/${encodeURIComponent(sessionId)}`,
  };
}

/**
 * Altas del profe en Equipos (Carmel/Besser 2026-11-07). Inscribir: crea
 * deportistas (Carmel) o pasa de categoría (Besser). Ficha nueva: solo Carmel.
 */
/** ¿Qué altas deja la escuela al profe? (mismos flags que el BFF). */
export function altasPermitidas(e: { coachCanCreateAthletes?: boolean; coachCanEditCategories?: boolean }): { inscribir: boolean; nuevo: boolean } {
  const nuevo = e.coachCanCreateAthletes === true;
  return { inscribir: nuevo || e.coachCanEditCategories === true, nuevo };
}
