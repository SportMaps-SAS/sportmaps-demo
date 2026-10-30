/**
 * «Mi semana» del profe — ajustes de UNA fecha sobre el horario fijo (lógica PURA).
 *
 * El horario fijo del equipo (teams.schedule) no se toca. Lo que cambia esta
 * semana vive en `team_schedule_exceptions` (mig. embudo_y_agenda_clase_prueba):
 *  · cancelada: ese entreno no va. `hora_original` NULL = todo el día.
 *  · movida:    el entreno de `hora_original` pasa a hora_inicio–hora_fin y/o a otro lugar.
 *  · extra:     un entreno que el horario no tiene.
 * El generador de cupos de clase de prueba y el bot («horario de la semana»)
 * leen la MISMA tabla: lo que el profe ve aquí es lo único que el bot ofrece.
 *
 * Sin ajustes, todo da exactamente lo de `entrenosDelHorario` (la pestaña
 * Semana de siempre).
 */
import { sumarDias } from '../asistenciaModel';
import { entrenosDelHorario, horaCorta } from '../sesionesModel';
import { anioDe, estadoDePago, sexoTexto, textoRespuestas, type EstadoPagoProspecto } from '@/lib/clasePruebaTextos';

// ── Tipos ────────────────────────────────────────────────────────────────────

export type TipoAjuste = 'cancelada' | 'movida' | 'extra';

/** Una fila de team_schedule_exceptions (las horas llegan «HH:MM:SS»). */
export interface AjusteSemana {
  id: string;
  team_id: string;
  fecha: string;
  tipo: TipoAjuste;
  hora_original: string | null;
  hora_inicio: string | null;
  hora_fin: string | null;
  lugar: string | null;
  /** Columna opcional: si la base no la tiene, no llega. */
  motivo?: string | null;
}

/** Franja del horario fijo: `day` 0 = domingo (Date.getDay), igual que teams.schedule. */
export interface FranjaSemana { day: number; time: string; end?: string; place?: string }
export interface EquipoSemana { id: string; name: string; franjas: FranjaSemana[] }

export type EstadoEntreno = 'normal' | 'cancelada' | 'movida' | 'extra';

export interface EntrenoAjustado {
  /** Única en el día: equipo + hora del horario (o id del extra). */
  clave: string;
  teamId: string;
  nombre: string;
  fecha: string;
  /** Hora en que va (HH:MM). En una cancelada, la que tenía. */
  hora: string | null;
  horaFin: string | null;
  lugar: string | null;
  /** Hora del horario fijo (HH:MM); null en un extra. */
  horaBase: string | null;
  lugarBase: string | null;
  estado: EstadoEntreno;
  motivo: string | null;
  /** Los ajustes que lo cambian (lo que borra «Deshacer»). */
  ajustes: AjusteSemana[];
}

// ── Utilidades ───────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** «8:00», «08:00:00» → «08:00». null si no es una hora. */
export function hhmm(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function diaDeSemana(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

const TIPOS: TipoAjuste[] = ['cancelada', 'movida', 'extra'];

/** Filas de la base → ajustes válidos (descarta lo que no se entiende). */
export function leerAjustes(raw: unknown): AjusteSemana[] {
  if (!Array.isArray(raw)) return [];
  const out: AjusteSemana[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.id !== 'string' || typeof r.team_id !== 'string' || typeof r.fecha !== 'string') continue;
    if (!TIPOS.includes(r.tipo as TipoAjuste)) continue;
    out.push({
      id: r.id,
      team_id: r.team_id,
      fecha: r.fecha.slice(0, 10),
      tipo: r.tipo as TipoAjuste,
      hora_original: hhmm(r.hora_original as string | null),
      hora_inicio: hhmm(r.hora_inicio as string | null),
      hora_fin: hhmm(r.hora_fin as string | null),
      lugar: typeof r.lugar === 'string' && r.lugar.trim() ? r.lugar.trim() : null,
      motivo: typeof r.motivo === 'string' && r.motivo.trim() ? r.motivo.trim() : null,
    });
  }
  return out;
}

// ── Aplicar los ajustes al horario ───────────────────────────────────────────

/**
 * Todos los entrenos del día (también los cancelados, para verlos tachados y
 * poder deshacer), con los ajustes aplicados, ordenados por hora.
 *
 * Reglas:
 *  · Cancelada gana sobre movida (si el profe movió y después canceló, no va).
 *  · Cancelada con hora_original NULL = todo el día, pero solo el horario fijo:
 *    un extra se agregó a propósito y sigue.
 *  · Una movida cuya hora ya no está en el horario (la escuela cambió el
 *    horario después) se muestra igual: es un entreno que el profe anunció.
 */
export function entrenosDelDia(fecha: string, equipos: EquipoSemana[], ajustes: AjusteSemana[]): EntrenoAjustado[] {
  const dow = diaDeSemana(fecha);
  const out: EntrenoAjustado[] = [];
  for (const e of equipos) {
    const delDia = ajustes.filter((a) => a.team_id === e.id && a.fecha === fecha);
    // Las horas se comparan normalizadas («08:00:00» de la base = «8:00» del horario).
    const orig = (a: AjusteSemana) => hhmm(a.hora_original);
    const todoElDia = delDia.find((a) => a.tipo === 'cancelada' && !orig(a)) ?? null;
    const base = e.franjas
      .filter((f) => f.day === dow && hhmm(f.time))
      .map((f) => ({ hora: hhmm(f.time)!, fin: hhmm(f.end), lugar: f.place?.trim() || null }))
      .sort((a, b) => a.hora.localeCompare(b.hora));
    const horasBase = new Set(base.map((b) => b.hora));

    for (const f of base) {
      const cancel = delDia.find((a) => a.tipo === 'cancelada' && orig(a) === f.hora) ?? todoElDia;
      const mov = delDia.find((a) => a.tipo === 'movida' && orig(a) === f.hora) ?? null;
      const comun = { clave: `${e.id}|${fecha}|${f.hora}`, teamId: e.id, nombre: e.name, fecha, horaBase: f.hora, lugarBase: f.lugar };
      if (cancel) {
        out.push({ ...comun, hora: f.hora, horaFin: f.fin, lugar: f.lugar, estado: 'cancelada', motivo: cancel.motivo ?? null,
          ajustes: [cancel, ...(mov ? [mov] : [])] });
      } else if (mov) {
        out.push({ ...comun, hora: hhmm(mov.hora_inicio), horaFin: hhmm(mov.hora_fin), lugar: mov.lugar ?? f.lugar, estado: 'movida', motivo: mov.motivo ?? null, ajustes: [mov] });
      } else {
        out.push({ ...comun, hora: f.hora, horaFin: f.fin, lugar: f.lugar, estado: 'normal', motivo: null, ajustes: [] });
      }
    }

    for (const a of delDia) {
      const o = orig(a);
      if (a.tipo === 'movida' && o && !horasBase.has(o)) {
        const cancelada = !!todoElDia || delDia.some((c) => c.tipo === 'cancelada' && orig(c) === o);
        if (cancelada) continue;
        out.push({ clave: `${e.id}|${fecha}|${o}`, teamId: e.id, nombre: e.name, fecha, horaBase: o, lugarBase: null,
          hora: hhmm(a.hora_inicio), horaFin: hhmm(a.hora_fin), lugar: a.lugar, estado: 'movida', motivo: a.motivo ?? null, ajustes: [a] });
      }
      if (a.tipo === 'extra') {
        out.push({ clave: `${e.id}|${fecha}|extra:${a.id}`, teamId: e.id, nombre: e.name, fecha, horaBase: null, lugarBase: null,
          hora: hhmm(a.hora_inicio), horaFin: hhmm(a.hora_fin), lugar: a.lugar, estado: 'extra', motivo: a.motivo ?? null, ajustes: [a] });
      }
    }
  }
  return out.sort((a, b) => (a.hora ?? '').localeCompare(b.hora ?? '') || a.nombre.localeCompare(b.nombre));
}

/**
 * Lo mismo que `entrenosDelHorario` (primer entreno de cada equipo ese día, con
 * la hora en palabras) pero con los ajustes: sin los cancelados, con la hora
 * nueva de los movidos y con los extras. Sin ajustes ese día, es IDÉNTICO.
 */
export function entrenosDelHorarioConAjustes(fecha: string, equipos: EquipoSemana[], ajustes: AjusteSemana[]): { teamId: string; nombre: string; hora: string | null }[] {
  if (!ajustes.some((a) => a.fecha === fecha)) return entrenosDelHorario(fecha, equipos);
  const vistos = new Set<string>();
  const out: { teamId: string; nombre: string; hora: string | null }[] = [];
  for (const en of entrenosDelDia(fecha, equipos, ajustes)) {
    if (en.estado === 'cancelada' || vistos.has(en.teamId)) continue;
    vistos.add(en.teamId);
    out.push({ teamId: en.teamId, nombre: en.nombre, hora: en.hora ? horaCorta(en.hora) : null });
  }
  // Mismo orden que entrenosDelHorario: el de los equipos.
  const orden = new Map(equipos.map((e, i) => [e.id, i]));
  return out.sort((a, b) => (orden.get(a.teamId) ?? 0) - (orden.get(b.teamId) ?? 0));
}

/** «8:00 a. m. – 10:00 a. m. · Cancha 2» */
export function horarioTexto(en: Pick<EntrenoAjustado, 'hora' | 'horaFin' | 'lugar'>): string {
  const h = en.hora ? horaCorta(en.hora) : 'Sin hora';
  const rango = en.horaFin ? `${h} – ${horaCorta(en.horaFin)}` : h;
  return en.lugar ? `${rango} · ${en.lugar}` : rango;
}

/** Lo que dice la etiqueta del entreno en la semana. */
export function etiquetaEstado(en: Pick<EntrenoAjustado, 'estado' | 'motivo'>): string | null {
  if (en.estado === 'cancelada') return en.motivo ? `Cancelado · ${en.motivo}` : 'Cancelado';
  if (en.estado === 'movida') return 'Cambiado';
  if (en.estado === 'extra') return 'Extra';
  return null;
}

// ── «Repetir los ajustes de la semana pasada» ────────────────────────────────

const claveUnica = (a: Pick<AjusteSemana, 'team_id' | 'fecha' | 'tipo' | 'hora_original' | 'hora_inicio'>) =>
  `${a.team_id}|${a.fecha}|${a.tipo}|${hhmm(a.hora_original) ?? hhmm(a.hora_inicio) ?? '00:00'}`;

/**
 * Qué copiaría `repetir_semana_equipo` a la semana del `lunes`: los ajustes de
 * la semana anterior corridos 7 días, sin los que ya están (la RPC usa
 * ON CONFLICT DO NOTHING con la misma clave única). Por equipo, porque la RPC
 * es por equipo.
 */
export function planRepetir(ajustes: AjusteSemana[], lunes: string, teamIds: string[]): { total: number; porEquipo: Map<string, number> } {
  const desde = sumarDias(lunes, -7);
  const hasta = sumarDias(lunes, -1);
  const mios = new Set(teamIds);
  const yaEstan = new Set(ajustes.filter((a) => a.fecha >= lunes).map(claveUnica));
  const porEquipo = new Map<string, number>();
  for (const a of ajustes) {
    if (!mios.has(a.team_id) || a.fecha < desde || a.fecha > hasta) continue;
    if (yaEstan.has(claveUnica({ ...a, fecha: sumarDias(a.fecha, 7) }))) continue;
    porEquipo.set(a.team_id, (porEquipo.get(a.team_id) ?? 0) + 1);
  }
  let total = 0;
  for (const n of porEquipo.values()) total += n;
  return { total, porEquipo };
}

/** Semanas entre la de `hoy` y la de `fecha` (para abrir la Semana en el día del aviso). */
export function semanasHasta(hoy: string, fecha: string): number {
  const lunesDe = (iso: string) => {
    const d = new Date(`${iso}T12:00:00Z`);
    return sumarDias(iso, -((d.getUTCDay() + 6) % 7));
  };
  const a = new Date(`${lunesDe(hoy)}T12:00:00Z`).getTime();
  const b = new Date(`${lunesDe(fecha)}T12:00:00Z`).getTime();
  return Math.round((b - a) / (7 * 86_400_000));
}

export function esFechaIso(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());
}

// ── Lo que el profe toca en la hoja ──────────────────────────────────────────

export type AccionAjuste =
  | { tipo: 'cancelar'; teamId: string; fecha: string; horaOriginal: string | null; motivo: string | null }
  | { tipo: 'mover'; teamId: string; fecha: string; horaOriginal: string; horaInicio: string; horaFin: string | null; lugar: string | null; ajusteId?: string }
  | { tipo: 'extra'; teamId: string; fecha: string; horaInicio: string; horaFin: string | null; lugar: string | null; ajusteId?: string }
  | { tipo: 'deshacer'; teamId: string; ajusteIds: string[] };

/** null si está bien; si no, qué corregir (en palabras del profe). */
export function errorDeAccion(a: AccionAjuste): string | null {
  if (a.tipo === 'deshacer') return a.ajusteIds.length ? null : 'No hay nada que deshacer.';
  if (!esFechaIso(a.fecha)) return 'Elige el día.';
  if (a.tipo === 'cancelar') return a.motivo && a.motivo.length > 120 ? 'El motivo es muy largo.' : null;
  if (!HHMM.test(a.horaInicio)) return 'Escribe la hora de inicio.';
  if (a.horaFin && !HHMM.test(a.horaFin)) return 'La hora de fin no es válida.';
  if (a.horaFin && a.horaFin <= a.horaInicio) return 'La hora de fin tiene que ser después de la de inicio.';
  if (a.lugar && a.lugar.length > 120) return 'El lugar es muy largo.';
  return null;
}

export interface FilaAjuste {
  school_id: string;
  team_id: string;
  fecha: string;
  tipo: TipoAjuste;
  hora_original: string | null;
  hora_inicio: string | null;
  hora_fin: string | null;
  lugar: string | null;
  creado_por: string;
  motivo?: string;
}

/**
 * La fila para team_schedule_exceptions, respetando sus CHECK:
 * movida lleva hora_original y hora_inicio; extra lleva hora_inicio y NO
 * hora_original; hora_fin > hora_inicio. `motivo` solo si hay (la columna
 * puede no existir: el hook reintenta sin ella).
 */
export function filaDeAccion(a: Exclude<AccionAjuste, { tipo: 'deshacer' }>, ctx: { schoolId: string; userId: string }): FilaAjuste {
  const comun = { school_id: ctx.schoolId, team_id: a.teamId, fecha: a.fecha, creado_por: ctx.userId };
  if (a.tipo === 'cancelar') {
    const motivo = a.motivo?.trim();
    return { ...comun, tipo: 'cancelada', hora_original: hhmm(a.horaOriginal), hora_inicio: null, hora_fin: null, lugar: null, ...(motivo ? { motivo } : {}) };
  }
  const lugar = a.lugar?.trim().slice(0, 120) || null;
  if (a.tipo === 'mover') {
    return { ...comun, tipo: 'movida', hora_original: hhmm(a.horaOriginal), hora_inicio: a.horaInicio, hora_fin: a.horaFin || null, lugar };
  }
  return { ...comun, tipo: 'extra', hora_original: null, hora_inicio: a.horaInicio, hora_fin: a.horaFin || null, lugar };
}

/** La hora de fin corrida igual que la de inicio (mover 8–10 a las 9 propone 9–11). */
export function finCorrido(inicioViejo: string | null, finViejo: string | null, inicioNuevo: string): string {
  const a = hhmm(inicioViejo);
  const b = hhmm(finViejo);
  if (!a || !b || !HHMM.test(inicioNuevo)) return '';
  const min = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  const fin = min(inicioNuevo) + (min(b) - min(a));
  if (fin <= min(inicioNuevo) || fin >= 24 * 60) return '';
  return `${String(Math.floor(fin / 60)).padStart(2, '0')}:${String(fin % 60).padStart(2, '0')}`;
}

/** Mensaje para el profe a partir del error de la base. */
export function mensajeDeError(e: { code?: string; message?: string } | null | undefined): string {
  if (!e) return 'No se pudo guardar. Inténtalo otra vez.';
  if (e.code === '42501') return 'No tienes permiso para cambiar este equipo. Pídeselo a la administración.';
  if (e.code === '23505') return 'Ese entreno ya tiene ese cambio. Deshazlo primero.';
  if (e.code === '23514') return 'Revisa las horas: la de fin tiene que ser después de la de inicio.';
  return 'No se pudo guardar. Revisa la señal e inténtalo otra vez.';
}

// ── Clases de prueba de la semana (RPC clases_prueba_semana) ─────────────────

export interface ClasePruebaSemana {
  leadId: string;
  nombre: string;
  anio: number | null;
  sexo: 'Mujer' | 'Hombre' | null;
  respuestas: string[];
  fecha: string | null;
  hora: string | null;
  /** Equipo de la franja (el entreno al que viene). */
  teamId: string | null;
  equipo: string | null;
  estadoCupo: 'agendada' | 'separada' | null;
  pago: EstadoPagoProspecto;
  asistencia: 'asistio' | 'no_vino' | null;
  /** Grupo recomendado por el profe (lead.team_id después de marcar). */
  teamRecomendado: string | null;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const objeto = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * La respuesta de la RPC → clases de prueba. Forma de la migración
 * 20261030123543: `{ lead_id, nombre, anio, sexo, respuestas, estado_cupo
 * ('agendada'|'separado'), separado_hasta, franja: { id, fecha, hora_inicio,
 * hora_fin, etiqueta, lugar }, equipo: { id, nombre } | null,
 * equipo_recomendado: { id, nombre } | null (= lead.team_id: al principio, el
 * grupo que eligió el bot), pago: { estado, … } | null, asistencia, etapa }`.
 * También acepta claves planas (`fecha`, `hora`, `team_id`…) por si cambia.
 * Sin teléfono, a propósito.
 */
export function leerClasesPruebaSemana(raw: unknown): ClasePruebaSemana[] {
  const filas = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { clases?: unknown }).clases)
    ? (raw as { clases: unknown[] }).clases : [];
  const out: ClasePruebaSemana[] = [];
  for (const r of filas as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const leadId = texto(r.lead_id) ?? texto(r.id);
    const nombre = texto(r.nombre) ?? texto(r.full_name);
    if (!leadId || !nombre) continue;
    const cupo = String(r.estado_cupo ?? '').toLowerCase();
    const asis = String(r.asistencia ?? '');
    const franja = objeto(r.franja);
    const equipo = objeto(r.equipo);
    const recomendado = objeto(r.equipo_recomendado);
    out.push({
      leadId,
      nombre,
      anio: anioDe(r.anio ?? r.birth_year ?? r.birth_date),
      sexo: sexoTexto(r.sexo ?? r.gender),
      respuestas: textoRespuestas(r.respuestas),
      fecha: (texto(franja?.fecha) ?? texto(r.fecha) ?? texto(r.slot_date) ?? texto(r.fecha_clase))?.slice(0, 10) ?? null,
      hora: hhmm(texto(franja?.hora_inicio) ?? texto(r.hora) ?? texto(r.start_time) ?? texto(r.cupo_hora)),
      teamId: texto(equipo?.id) ?? texto(r.slot_team_id) ?? texto(r.team_id),
      equipo: texto(equipo?.nombre) ?? texto(r.equipo) ?? texto(r.team_name) ?? texto(franja?.etiqueta),
      estadoCupo: cupo.startsWith('separad') ? 'separada' : cupo === 'agendada' ? 'agendada' : null,
      pago: estadoDePago(r.pago ?? r.pago_estado),
      asistencia: asis === 'asistio' || asis === 'no_vino' ? asis : null,
      teamRecomendado: texto(recomendado?.id) ?? texto(r.team_recomendado),
    });
  }
  return out.sort((a, b) => `${a.fecha ?? ''}${a.hora ?? ''}`.localeCompare(`${b.fecha ?? ''}${b.hora ?? ''}`));
}

/** «Mariana · 2011 · Punta · Club y torneos (…)» (el sexo va solo si no hay respuestas). */
export function lineaClasePrueba(c: ClasePruebaSemana): string {
  return [c.nombre, c.anio, ...(c.respuestas.length ? c.respuestas : [c.sexo])].filter((x) => x != null && x !== '').join(' · ');
}

/** «Pagó ✅» / «Pago en revisión» / «Cupo separado · sin comprobante» / null (gratis). */
export function textoPagoClase(c: Pick<ClasePruebaSemana, 'pago' | 'estadoCupo'>): string | null {
  if (c.pago === 'pagado') return 'Pagó ✅';
  if (c.pago === 'en_revision') return 'Pago en revisión';
  if (c.estadoCupo === 'separada') return 'Cupo separado · sin comprobante';
  return null;
}
