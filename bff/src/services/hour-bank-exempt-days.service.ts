/**
 * hour-bank-exempt-days.service — días de evento en los que el banco de horas
 * NO descuenta (Halloween, competencia interna) y devolución de las horas de
 * una visita puntual. Pedido de Dreamers, 2026-11-21.
 *
 * Quién hace cumplir el día de evento es la BASE: un trigger sobre
 * `hour_bank_visits` (migración 20261123083815) deja en 0 toda visita que se
 * facture habiendo empezado en un día de evento. Acá solo se valida la entrada
 * y se llama a las RPC transaccionales; nada de esto calcula minutos.
 */

import { supabase } from '../config/supabase';
import { todayInZone } from '../utils/businessDate';

export class HourBankExemptError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface NuevoDiaDeEvento {
  date: string;
  reason: string;
  time_from: string | null;
  time_to: string | null;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DIAS_HACIA_ATRAS = 60;
export const DIAS_HACIA_ADELANTE = 366;

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function validarMotivo(valor: unknown): string {
  const motivo = typeof valor === 'string' ? valor.trim() : '';
  if (motivo.length < 3) throw new HourBankExemptError(400, 'Escribe el motivo (mínimo 3 letras)');
  if (motivo.length > 120) throw new HourBankExemptError(400, 'El motivo no puede pasar de 120 caracteres');
  return motivo;
}

/** Valida el cuerpo de «crear día de evento». `hoy` = fecha de Bogotá (YYYY-MM-DD). */
export function validarDiaDeEvento(body: unknown, hoy: string): NuevoDiaDeEvento {
  const b = (body ?? {}) as Record<string, unknown>;
  const date = typeof b.date === 'string' ? b.date : '';
  if (!FECHA.test(date) || Number.isNaN(new Date(`${date}T12:00:00Z`).getTime())) {
    throw new HourBankExemptError(400, 'Elige el día del evento');
  }
  if (date < sumarDias(hoy, -DIAS_HACIA_ATRAS)) {
    throw new HourBankExemptError(400, `Solo se pueden marcar eventos de los últimos ${DIAS_HACIA_ATRAS} días`);
  }
  if (date > sumarDias(hoy, DIAS_HACIA_ADELANTE)) {
    throw new HourBankExemptError(400, 'El evento no puede estar a más de un año');
  }
  const reason = validarMotivo(b.reason);

  const desde = b.time_from == null || b.time_from === '' ? null : b.time_from;
  const hasta = b.time_to == null || b.time_to === '' ? null : b.time_to;
  if (desde === null && hasta === null) return { date, reason, time_from: null, time_to: null };
  if (typeof desde !== 'string' || typeof hasta !== 'string' || !HORA.test(desde) || !HORA.test(hasta)) {
    throw new HourBankExemptError(400, 'La franja necesita hora de inicio y hora de fin');
  }
  if (hasta <= desde) throw new HourBankExemptError(400, 'La hora de fin debe ser posterior a la de inicio');
  return { date, reason, time_from: desde, time_to: hasta };
}

/** Las RPC lanzan «CODIGO: mensaje para la persona». Se traduce a un estado HTTP. */
export function errorDeRpc(error: { code?: string; message?: string } | null): HourBankExemptError {
  const crudo = error?.message ?? '';
  const [codigo, ...resto] = crudo.split(': ');
  const mensaje = resto.join(': ').trim();
  if (error?.code === '42501' || codigo === 'FORBIDDEN') return new HourBankExemptError(403, 'No administras esta escuela');
  if (codigo === 'NO_ENCONTRADA' || codigo === 'NO_ENCONTRADO') return new HourBankExemptError(404, mensaje || 'No se encontró');
  if (codigo === 'DATOS_INVALIDOS' || codigo === 'SIN_DESCUENTO') return new HourBankExemptError(400, mensaje || 'Datos inválidos');
  // PGRST202 / 42883: la migración 20261123083815 todavía no está aplicada.
  if (error?.code === 'PGRST202' || error?.code === '42883' || error?.code === '42P01' || error?.code === 'PGRST205') {
    return new HourBankExemptError(503, 'Esta función todavía no está disponible. Avísale a soporte.');
  }
  console.error('[hour-bank] error de RPC de día de evento:', error?.code, crudo);
  return new HourBankExemptError(500, 'No se pudo guardar. Intenta de nuevo.');
}

export interface DiaDeEvento {
  id: string;
  exempt_date: string;
  time_from: string | null;
  time_to: string | null;
  reason: string;
  created_at: string;
}

const recortarHora = (h: string | null): string | null => (h ? h.slice(0, 5) : null);

/** Días de evento vigentes de la escuela: los próximos y los de los últimos 60 días. */
export async function listarDiasDeEvento(schoolId: string): Promise<DiaDeEvento[]> {
  const desde = sumarDias(todayInZone(), -DIAS_HACIA_ATRAS);
  const { data, error } = await supabase
    .from('hour_bank_exempt_days')
    .select('id, exempt_date, time_from, time_to, reason, created_at')
    .eq('school_id', schoolId)
    .is('cancelled_at', null)
    .gte('exempt_date', desde)
    .order('exempt_date', { ascending: false })
    .limit(100);
  if (error) throw errorDeRpc(error);
  return ((data ?? []) as DiaDeEvento[]).map((d) => ({ ...d, time_from: recortarHora(d.time_from), time_to: recortarHora(d.time_to) }));
}

export interface ResultadoDiaDeEvento {
  id: string;
  duplicated: boolean;
  visits_waived: number;
  minutes_returned: number;
  athletes: string[];
  overage_confirmed: number;
}

export async function crearDiaDeEvento(schoolId: string, actorId: string, body: unknown): Promise<ResultadoDiaDeEvento> {
  const dia = validarDiaDeEvento(body, todayInZone());
  const { data, error } = await supabase.rpc('create_hour_bank_exempt_day', {
    p_school_id: schoolId,
    p_actor: actorId,
    p_date: dia.date,
    p_reason: dia.reason,
    p_time_from: dia.time_from,
    p_time_to: dia.time_to,
  });
  if (error) throw errorDeRpc(error);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    duplicated: r.duplicated === true,
    visits_waived: Number(r.visits_waived ?? 0),
    minutes_returned: Number(r.minutes_returned ?? 0),
    athletes: Array.isArray(r.athletes) ? (r.athletes as unknown[]).map(String) : [],
    overage_confirmed: Number(r.overage_confirmed ?? 0),
  };
}

export async function cancelarDiaDeEvento(schoolId: string, actorId: string, dayId: string): Promise<void> {
  // El id llega del cliente: se ata a ESTA escuela antes de llamar a la RPC.
  const { data: dia, error: errDia } = await supabase
    .from('hour_bank_exempt_days')
    .select('id')
    .eq('id', dayId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (errDia) throw errorDeRpc(errDia);
  if (!dia) throw new HourBankExemptError(404, 'Ese evento no existe');
  const { error } = await supabase.rpc('cancel_hour_bank_exempt_day', { p_day_id: dayId, p_actor: actorId });
  if (error) throw errorDeRpc(error);
}

export interface ResultadoDevolucion {
  duplicated: boolean;
  minutes: number;
  available_minutes: number | null;
  overage_confirmed: boolean;
}

export async function devolverHorasDeVisita(schoolId: string, actorId: string, visitId: string, motivo: unknown): Promise<ResultadoDevolucion> {
  const reason = validarMotivo(motivo);
  const { data: visita, error: errVisita } = await supabase
    .from('hour_bank_visits')
    .select('id')
    .eq('id', visitId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (errVisita) throw errorDeRpc(errVisita);
  if (!visita) throw new HourBankExemptError(404, 'Visita no encontrada');

  const { data, error } = await supabase.rpc('waive_hour_bank_visit', { p_visit_id: visitId, p_actor: actorId, p_reason: reason });
  if (error) throw errorDeRpc(error);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    duplicated: r.duplicated === true,
    minutes: Number(r.minutes ?? 0),
    available_minutes: typeof r.available_minutes === 'number' ? r.available_minutes : null,
    overage_confirmed: r.overage_confirmed === true,
  };
}
