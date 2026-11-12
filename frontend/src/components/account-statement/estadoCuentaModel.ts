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
  /**
   * Columnas que `resolvePaymentOrigin` (lib/paymentOrigin) lee para decir CÓMO
   * se pagó. Opcionales: sin ellas el origen sale «Sin registrar», nunca inventado.
   */
  payment_method?: string | null;
  payment_channel?: string | null;
  payment_provider?: string | null;
  receipt_url?: string | null;
  wompi_reference?: string | null;
  wompi_transaction_id?: string | null;
  provider_transaction_id?: string | null;
}

/** Estados que `/my-payments?pay=<id>` abre directo en el checkout (MyPaymentsPage). */
export const ABRE_CHECKOUT = ['pending', 'overdue', 'rejected', 'failed'];
/** Estados que se deben (`partial` = queda saldo; se paga desde Pagos). */
export const POR_PAGAR = ['pending', 'overdue', 'partial', 'rejected', 'failed'];

import type { TonoEstado } from '@/components/common/ChipEstado';
import { resolvePaymentOrigin } from '@/lib/paymentOrigin';

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
  // El mes es el PERIODO del cobro, nunca el del vencimiento. En Dreamers el
  // primer cobro vence en el corte del mes siguiente (20261011101750): un alta
  // del 5-nov vence el 01/12 y sigue siendo de noviembre. Si un periodo quedó
  // mal (altas del 29–31 oct), se corrige el dato (20261107104128), no la etiqueta.
  if (c.period_year && c.period_month) return { y: c.period_year, m: c.period_month };
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

/** Formato por defecto de un monto en estas frases; las pantallas pasan `formatCurrency`. */
const formatoBasico = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;

/** Parte abonada de un cobro con abono parcial, y lo que falta. null si no hay abono real. */
export function abonoDe(c: CobroCuenta): { abonado: number; falta: number } | null {
  const total = Number(c.amount || 0);
  const abonado = Number(c.amount_paid || 0);
  // Un «abono» que ya cubre todo el valor es un dato raro, no un abono: no se inventa un «falta $0».
  if (c.status !== 'partial' || abonado <= 0 || total <= 0 || abonado >= total) return null;
  return { abonado, falta: Math.max(0, total - abonado) };
}

/** Línea secundaria de un cobro: «Venció el 10 de octubre», «Pagado el 6 de julio»… */
export function detalleCobro(
  c: CobroCuenta,
  now = new Date(),
  formato: (n: number) => string = formatoBasico,
  /**
   * `escuela`: el mismo dato, sin hablarle a la familia en segunda persona.
   * `publica`: la página /e/:token, sin sesión: habla a la familia pero no la manda a pantallas
   * que no existen ahí («se paga desde Pagos», «vuelve a subirlo»).
   */
  voz: 'familia' | 'escuela' | 'publica' = 'familia',
): string {
  const estado = estadoCobro(c, now).label;
  const escuela = voz === 'escuela';
  const publica = voz === 'publica';
  if (estado === 'Pagado') return c.payment_date ? `Pagado el ${fechaCorta(c.payment_date, now)}` : 'Pagado';
  if (estado === 'En revisión') {
    if (escuela) return c.payment_date ? `Comprobante enviado el ${fechaCorta(c.payment_date, now)}, por revisar.` : 'Comprobante por revisar.';
    return c.payment_date
      ? `Enviaste el comprobante el ${fechaCorta(c.payment_date, now)}. La escuela lo está revisando.`
      : 'La escuela está revisando tu comprobante.';
  }
  if (estado === 'Necesita aclaración') return escuela ? 'El comprobante tiene una aclaración pendiente.' : 'La escuela necesita que aclares el comprobante.';
  if (estado === 'Rechazado') return escuela ? 'Se rechazó el comprobante.' : publica ? 'La escuela rechazó el comprobante.' : 'La escuela rechazó el comprobante. Vuelve a pagarlo o a subirlo.';
  if (estado === 'No pasó') return escuela ? 'El pago en línea no pasó.' : publica ? 'El pago no pasó.' : 'El pago no pasó. Inténtalo de nuevo.';
  if (estado === 'Abono parcial') {
    const abono = abonoDe(c);
    if (escuela) return abono ? `Abonó ${formato(abono.abonado)}. Falta ${formato(abono.falta)}.` : 'Tiene un abono parcial.';
    if (publica) return abono ? `Abonaste ${formato(abono.abonado)}. Falta ${formato(abono.falta)}.` : 'Ya abonaste una parte.';
    return abono
      ? `Abonaste ${formato(abono.abonado)}. Falta ${formato(abono.falta)}, que se paga desde Pagos.`
      : 'Ya abonaste una parte. El saldo se paga desde Pagos.';
  }
  if (estado === 'Vencido') return c.due_date ? `Venció el ${fechaCorta(c.due_date, now)}` : 'Vencido';
  return c.due_date ? `Vence el ${fechaCorta(c.due_date, now)}` : 'Por pagar';
}

/** Días de calendario entre dos fechas (negativo si `hasta` es anterior). */
function diasEntre(desde: Date, hasta: Date): number {
  const a = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate()).getTime();
  const b = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

const dias = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;

/**
 * Una línea que dice, de un vistazo, cuándo era y cuándo se pagó:
 * «Límite 10 oct · pagó 8 oct», «Límite 10 nov · sin pagar».
 */
export function lineaFechas(c: CobroCuenta, now = new Date()): string {
  const estado = estadoCobro(c, now).label;
  const limite = c.due_date ? `Límite ${fechaCorta(c.due_date, now)}` : null;
  let resto: string | null = null;
  if (estado === 'Pagado') resto = c.payment_date ? `pagó ${fechaCorta(c.payment_date, now)}` : 'pagado';
  else if (estado === 'Abono parcial') resto = c.payment_date ? `abonó ${fechaCorta(c.payment_date, now)}` : 'con abono';
  else if (estado === 'En revisión') resto = c.payment_date ? `comprobante enviado ${fechaCorta(c.payment_date, now)}` : 'comprobante en revisión';
  else if (estado === 'Vencido' || estado === 'Por pagar') resto = 'sin pagar';
  return [limite, resto].filter(Boolean).join(' · ') || estado;
}

/**
 * Puntualidad en palabras: «Pagó a tiempo», «Pagó 3 días tarde», «Lleva 12 días
 * vencido». null cuando no aplica (en revisión, anulado, sin fechas).
 */
export function puntualidad(c: CobroCuenta, now = new Date(), formato: (n: number) => string = formatoBasico): EstadoEnPalabras | null {
  const estado = estadoCobro(c, now).label;
  if (estado === 'Pagado' && c.due_date && c.payment_date) {
    const d = diasEntre(parseDia(c.due_date), parseDia(c.payment_date));
    return d <= 0 ? { label: 'Pagó a tiempo', tono: 'ok' } : { label: `Pagó ${dias(d)} tarde`, tono: 'aviso' };
  }
  if ((estado === 'Vencido' || estado === 'Abono parcial') && c.due_date && estaVencido(c, now)) {
    const d = diasEntre(parseDia(c.due_date), now);
    if (d <= 0) return null;
    const abono = estado === 'Abono parcial' ? abonoDe(c) : null;
    return {
      label: abono ? `Falta ${formato(abono.falta)} · vencido hace ${dias(d)}` : `Lleva ${dias(d)} vencido`,
      tono: 'peligro',
    };
  }
  return null;
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

/** A quién pertenece un estado de cuenta: hijo, adulto con cuenta o ficha sin cuenta. */
export interface ObjetivoEstadoCuenta {
  child_id: string | null;
  adult_id: string | null;
  unregistered_athlete_id: string | null;
  name: string;
}

/** `?child_id=…` / `?user_id=…` / `?unregistered_athlete_id=…` de /estado-cuenta (gana el hijo). */
export function parametrosEstadoCuenta(o: ObjetivoEstadoCuenta): string {
  const p = new URLSearchParams();
  if (o.child_id) p.set('child_id', o.child_id);
  else if (o.adult_id) p.set('user_id', o.adult_id);
  else if (o.unregistered_athlete_id) p.set('unregistered_athlete_id', o.unregistered_athlete_id);
  return p.toString();
}

/** Asistencia de un mes, contada de las sesiones que trae la RPC (`events` con tipo «sesion»). */
export interface AsistenciaMes {
  /** Estuvo en clase (presente o llegó tarde). */
  asistio: number;
  tarde: number;
  excusada: number;
  falto: number;
  total: number;
}

interface EventoCuenta {
  tipo: string;
  fecha: string;
  attendance_status?: string | null;
}

/**
 * Asistencia por mes (`YYYY-MM`). Presente y tarde cuentan como asistió; la
 * excusada y la falta no. Un estado que no conocemos suma al total pero a ningún
 * otro grupo: nunca se esconde una clase ni se le inventa un resultado.
 */
export function asistenciaPorMes(events: EventoCuenta[]): Map<string, AsistenciaMes> {
  const out = new Map<string, AsistenciaMes>();
  for (const e of events) {
    if (e.tipo !== 'sesion' || !e.fecha) continue;
    const key = e.fecha.slice(0, 7);
    const a = out.get(key) ?? { asistio: 0, tarde: 0, excusada: 0, falto: 0, total: 0 };
    a.total++;
    if (e.attendance_status === 'present') a.asistio++;
    else if (e.attendance_status === 'late') { a.asistio++; a.tarde++; }
    else if (e.attendance_status === 'excused') a.excusada++;
    else if (e.attendance_status === 'absent') a.falto++;
    out.set(key, a);
  }
  return out;
}

/** «Asistió a 8 de 12 clases · 3 faltas · 1 excusada · llegó tarde 1 vez». */
export function textoAsistencia(a: AsistenciaMes): string {
  const partes = [`Asistió a ${a.asistio} de ${a.total} ${a.total === 1 ? 'clase' : 'clases'}`];
  if (a.falto) partes.push(`${a.falto} ${a.falto === 1 ? 'falta' : 'faltas'}`);
  if (a.excusada) partes.push(`${a.excusada} ${a.excusada === 1 ? 'excusada' : 'excusadas'}`);
  if (a.tarde) partes.push(`llegó tarde ${a.tarde} ${a.tarde === 1 ? 'vez' : 'veces'}`);
  return partes.join(' · ');
}

/** Qué respaldo tiene un pago: el comprobante que subieron, la confirmación de la pasarela o nada. */
export type SoportePago = 'comprobante' | 'en-linea' | 'ninguno';

export interface ComoPago {
  /** «Transferencia», «Efectivo», «Wompi», «Registrado por la escuela»… */
  label: string;
  /** Matiz corto: «con comprobante», «sin comprobante». */
  nota: string | null;
  soporte: SoportePago;
  /** El medio de pago no está registrado: solo le sirve a la escuela, para completarlo. */
  sinRegistrar: boolean;
}

/**
 * Cómo se pagó, a partir de `resolvePaymentOrigin` (nunca el `payment_method` crudo)
 * con tres ajustes para los datos reales de Besser: un pago registrado a mano que SÍ
 * tiene comprobante no es «Sin registrar» (hay 3), el efectivo no tiene comprobante, y
 * lo que pasó por la pasarela se confirma en línea.
 */
export function comoPago(c: CobroCuenta): ComoPago {
  const o = resolvePaymentOrigin(c);
  const tieneComprobante = !!c.receipt_url;
  if (o.kind === 'gateway') return { label: o.label, nota: o.qualifier, soporte: 'en-linea', sinRegistrar: false };
  if (o.kind === 'unknown') {
    if (tieneComprobante) return { label: 'Comprobante subido', nota: 'sin medio registrado', soporte: 'comprobante', sinRegistrar: true };
    if (c.payment_channel === 'manual') return { label: 'Registrado por la escuela', nota: 'sin comprobante', soporte: 'ninguno', sinRegistrar: false };
    return { label: 'Sin registrar', nota: null, soporte: 'ninguno', sinRegistrar: true };
  }
  if (tieneComprobante) return { label: o.label, nota: 'con comprobante', soporte: 'comprobante', sinRegistrar: false };
  return { label: o.label, nota: 'sin comprobante', soporte: 'ninguno', sinRegistrar: false };
}
