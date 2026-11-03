/**
 * Estado de cuenta del hijo, vista del acudiente (V2) — modelo puro, sin React
 * ni Supabase.
 *
 * El saldo («Sofía debe $ 765.000») sale tal cual de la RPC
 * `get_athlete_account_statement` (summary.total_open, calculado en la base):
 * aquí NUNCA se suma un monto a cobrar. Los cobros por mes vienen de
 * `payments` solo para mostrarlos y para saber a cuál llevar el botón «Pagar»
 * (`/my-payments?pay=<id>`); lo que se cobra lo fija el BFF en el checkout.
 */

export interface CobroCuenta {
  id: string;
  status: string;
  amount: number | null;
  amount_paid: number | null;
  concept: string | null;
  due_date: string | null;
  payment_date: string | null;
  period_year: number | null;
  period_month: number | null;
  created_at: string;
}

/** Estados que `/my-payments?pay=<id>` abre directo en el checkout (MyPaymentsPage). */
export const ABRE_CHECKOUT = ['pending', 'overdue', 'rejected', 'failed'];
/** Estados que se deben (`partial` = queda saldo; se paga desde Pagos). */
export const POR_PAGAR = ['pending', 'overdue', 'partial', 'rejected', 'failed'];

import type { TonoEstado } from '@/components/common/ChipEstado';

export type { TonoEstado };

export interface EstadoEnPalabras {
  label: string;
  tono: TonoEstado;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const parseDia = (d: string) => new Date(d.length <= 10 ? `${d}T00:00:00` : d);

function hoyLocal(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** ¿Ya pasó la fecha límite de un cobro que se debe? */
export function estaVencido(c: CobroCuenta, now = new Date()): boolean {
  if (c.status === 'overdue') return true;
  if (!POR_PAGAR.includes(c.status) || !c.due_date) return false;
  return parseDia(c.due_date) < hoyLocal(now);
}

/** El estado de UN cobro en palabras de la familia. Nunca el estado técnico. */
export function estadoCobro(c: CobroCuenta, now = new Date()): EstadoEnPalabras {
  switch (c.status) {
    case 'paid':
    case 'approved':
      return { label: 'Pagado', tono: 'ok' };
    case 'awaiting_approval':
      return { label: 'En revisión', tono: 'info' };
    case 'glosado':
      return { label: 'Necesita aclaración', tono: 'aviso' };
    case 'partial':
      return { label: 'Abono parcial', tono: 'aviso' };
    case 'rejected':
      return { label: 'Rechazado', tono: 'peligro' };
    case 'failed':
      return { label: 'No pasó', tono: 'peligro' };
    case 'cancelled':
      return { label: 'Anulado', tono: 'neutro' };
    default:
      return estaVencido(c, now) ? { label: 'Vencido', tono: 'peligro' } : { label: 'Por pagar', tono: 'aviso' };
  }
}

export interface MesCuenta {
  key: string; // YYYY-MM
  titulo: string; // «Octubre de 2026»
  estado: EstadoEnPalabras;
  cobros: CobroCuenta[];
}

/** El estado del mes = el más urgente de sus cobros. */
const PRIORIDAD: string[] = ['Vencido', 'Rechazado', 'No pasó', 'Por pagar', 'Abono parcial', 'Necesita aclaración', 'En revisión', 'Pagado'];

function mesDe(c: CobroCuenta): { y: number; m: number } | null {
  if (c.period_year && c.period_month) {
    // «Primer cobro sin recargo» (Dreamers, 20261011101750): el trigger de BD
    // mueve el vencimiento al corte del mes siguiente para no cobrar mora en
    // el mes de alta, pero deja el periodo en el mes de alta a propósito (lo
    // usan el dedup y la exoneración de mora). Agrupar por ese periodo pone un
    // cobro que vence en noviembre bajo "Octubre" — se ve como deuda atrasada
    // sin estarlo. Si el vencimiento cae en un mes posterior al periodo, se
    // agrupa por el mes del vencimiento; period_year/period_month en BD no se tocan.
    if (c.due_date) {
      const d = parseDia(c.due_date);
      const dy = d.getFullYear();
      const dm = d.getMonth() + 1;
      if (dy * 12 + dm > c.period_year * 12 + c.period_month) return { y: dy, m: dm };
    }
    return { y: c.period_year, m: c.period_month };
  }
  const f = c.due_date || c.payment_date || c.created_at;
  if (!f) return null;
  const d = parseDia(f);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

/** Agrupa los cobros por mes (el más reciente arriba). Los anulados no se muestran. */
export function agruparPorMes(cobros: CobroCuenta[], now = new Date()): MesCuenta[] {
  const map = new Map<string, { y: number; m: number; cobros: CobroCuenta[] }>();
  for (const c of cobros) {
    if (c.status === 'cancelled') continue;
    const mes = mesDe(c);
    if (!mes) continue;
    const key = `${mes.y}-${String(mes.m).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, { ...mes, cobros: [] });
    map.get(key)!.cobros.push(c);
  }
  return [...map.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, g]) => {
      const estados = g.cobros.map((c) => estadoCobro(c, now));
      const estado = estados.reduce((peor, e) => {
        const ip = PRIORIDAD.indexOf(peor.label);
        const ie = PRIORIDAD.indexOf(e.label);
        return ie !== -1 && (ip === -1 || ie < ip) ? e : peor;
      }, estados[0]);
      const cobrosOrdenados = [...g.cobros].sort((a, b) =>
        PRIORIDAD.indexOf(estadoCobro(a, now).label) - PRIORIDAD.indexOf(estadoCobro(b, now).label),
      );
      return {
        key,
        titulo: `${MESES[g.m - 1][0].toUpperCase()}${MESES[g.m - 1].slice(1)} de ${g.y}`,
        estado,
        cobros: cobrosOrdenados,
      };
    });
}

function fechaCorta(d: string, now: Date): string {
  const date = parseDia(d);
  const base = `${date.getDate()} de ${MESES[date.getMonth()]}`;
  return date.getFullYear() !== now.getFullYear() ? `${base} de ${date.getFullYear()}` : base;
}

/** Línea secundaria de un cobro: «Venció el 10 de octubre», «Pagado el 6 de julio»… */
export function detalleCobro(c: CobroCuenta, now = new Date()): string {
  const estado = estadoCobro(c, now).label;
  if (estado === 'Pagado') return c.payment_date ? `Pagado el ${fechaCorta(c.payment_date, now)}` : 'Pagado';
  if (estado === 'En revisión') {
    return c.payment_date
      ? `Enviaste el comprobante el ${fechaCorta(c.payment_date, now)}. La escuela lo está revisando.`
      : 'La escuela está revisando tu comprobante.';
  }
  if (estado === 'Necesita aclaración') return 'La escuela necesita que aclares el comprobante.';
  if (estado === 'Rechazado') return 'La escuela rechazó el comprobante. Vuelve a pagarlo o a subirlo.';
  if (estado === 'No pasó') return 'El pago no pasó. Inténtalo de nuevo.';
  if (estado === 'Abono parcial') return 'Ya abonaste una parte. El saldo se paga desde Pagos.';
  if (estado === 'Vencido') return c.due_date ? `Venció el ${fechaCorta(c.due_date, now)}` : 'Vencido';
  return c.due_date ? `Vence el ${fechaCorta(c.due_date, now)}` : 'Por pagar';
}

/** El valor que se muestra en la fila (dato de la base, no un cálculo). */
export function valorCobro(c: CobroCuenta): number {
  if (c.status === 'paid' || c.status === 'approved') return Number(c.amount_paid || c.amount || 0);
  return Number(c.amount || 0);
}

/** «Mensualidad 10/2026 - Sofía Herrera» → «Mensualidad 10/2026» (el nombre ya está arriba). */
export function tituloCobro(c: CobroCuenta, nombre: string): string {
  const concepto = (c.concept || 'Cobro').trim();
  if (!nombre) return concepto;
  const sinNombre = concepto
    .split(/\s+[-—–]\s+/)
    .filter((parte) => parte.trim().toLowerCase() !== nombre.trim().toLowerCase())
    .join(' · ');
  return sinNombre || concepto;
}

export const primerNombre = (nombre: string) => nombre.trim().split(/\s+/)[0] || nombre;

export interface ResumenCuenta {
  /** «Sofía debe $ 765.000» / «Sofía está al día» */
  titulo: string;
  subtitulo: string | null;
  boton: { label: string; href: string } | null;
  tono: 'debe' | 'revision' | 'al-dia';
}

/**
 * La frase de arriba y el único botón. `totalOpen` viene de la RPC
 * (summary.total_open): no se recalcula aquí.
 */
export function resumenCuenta(
  nombre: string,
  totalOpen: number,
  cobros: CobroCuenta[],
  formato: (n: number) => string,
  now = new Date(),
): ResumenCuenta {
  const quien = primerNombre(nombre);
  const porPagar = cobros.filter((c) => POR_PAGAR.includes(c.status));
  const enRevision = cobros.filter((c) => c.status === 'awaiting_approval');
  const aclarar = cobros.filter((c) => c.status === 'glosado');
  const vencidos = porPagar.filter((c) => estaVencido(c, now));

  const nota = (n: number, una: string, varias: string) => (n === 1 ? una : varias.replace('{n}', String(n)));
  const extras: string[] = [];
  if (enRevision.length) extras.push(nota(enRevision.length, '1 pago está en revisión.', '{n} pagos están en revisión.'));
  if (aclarar.length) extras.push(nota(aclarar.length, 'La escuela necesita que aclares 1 comprobante.', 'La escuela necesita que aclares {n} comprobantes.'));

  if (porPagar.length > 0) {
    const unico = porPagar.length === 1 ? porPagar[0] : null;
    const href = unico && ABRE_CHECKOUT.includes(unico.status) ? `/my-payments?pay=${unico.id}` : '/my-payments';
    const cuantos = vencidos.length > 0
      ? nota(vencidos.length, '1 cobro vencido.', '{n} cobros vencidos.')
      : nota(porPagar.length, '1 cobro por pagar.', '{n} cobros por pagar.');
    return {
      titulo: totalOpen > 0 ? `${quien} debe ${formato(totalOpen)}` : `${quien} tiene cobros por pagar`,
      subtitulo: [cuantos, ...extras].join(' '),
      boton: { label: unico ? 'Pagar' : `Pagar ${porPagar.length} cobros`, href },
      tono: 'debe',
    };
  }
  if (aclarar.length > 0) {
    return {
      titulo: `Falta aclarar un pago de ${quien}`,
      subtitulo: extras.join(' '),
      boton: { label: 'Responder a la escuela', href: '/my-payments' },
      tono: 'revision',
    };
  }
  if (enRevision.length > 0) {
    return {
      titulo: `${quien} no tiene nada por pagar`,
      subtitulo: `${extras.join(' ')} Te avisamos cuando la escuela lo apruebe.`,
      boton: null,
      tono: 'revision',
    };
  }
  return { titulo: `${quien} está al día`, subtitulo: 'No hay cobros pendientes.', boton: null, tono: 'al-dia' };
}
