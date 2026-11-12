/**
 * «¿Quién pagó en <mes>?» — modelo puro del Ciclo de Mes, sin React ni Supabase.
 *
 * Una fila por atleta con el cobro de mensualidad de ese período: estado en
 * palabras, fechas (límite / pago), puntualidad y valor. Reutiliza el modelo del
 * estado de cuenta (`estadoCuentaModel`) para que las dos pantallas digan lo mismo.
 *
 * No suma plata: el dinero del mes (facturado, cobrado, cartera) lo da la RPC
 * `preview_close_month` en las tarjetas de arriba. Aquí solo se cuentan personas.
 */
import {
  estadoCobro, estaVencido, valorCobro, POR_PAGAR, type CobroCuenta, type EstadoEnPalabras,
} from '@/components/account-statement/estadoCuentaModel';

/** Un cobro del período con los ids que dicen de quién es. */
export interface CobroDelMes extends CobroCuenta {
  child_id: string | null;
  user_id: string | null;
  unregistered_athlete_id: string | null;
  /** `payments.payment_category`: null cuenta como mensualidad (ver isMensualidad). */
  payment_category?: string | null;
}

export type GrupoPago = 'vencido' | 'pendiente' | 'revision' | 'abono' | 'pago';

export interface ObjetivoAtleta {
  child_id: string | null;
  adult_id: string | null;
  unregistered_athlete_id: string | null;
  name: string;
}

export interface FilaPago {
  clave: string;
  nombre: string;
  objetivo: ObjetivoAtleta;
  /** El cobro más urgente del período. */
  cobro: CobroCuenta;
  /** Cuántos cobros más tiene ese atleta en el período (p. ej. mensualidad + camiseta). */
  otros: number;
  estado: EstadoEnPalabras;
  grupo: GrupoPago;
  /** Días de atraso (vencidos) o de retraso al pagar; 0 si no aplica. Solo para ordenar. */
  dias: number;
}

/** Urgencia: lo que hay que mirar primero va arriba. */
const ORDEN: Record<GrupoPago, number> = { vencido: 0, abono: 1, revision: 2, pendiente: 3, pago: 4 };

export function grupoDe(c: CobroCuenta, now: Date): GrupoPago {
  const { label } = estadoCobro(c, now);
  if (label === 'Pagado') return 'pago';
  if (label === 'Abono parcial') return 'abono';
  if (label === 'En revisión' || label === 'Necesita aclaración') return 'revision';
  if (label === 'Vencido') return 'vencido';
  return 'pendiente'; // Por pagar, Rechazado, No pasó
}

const MS_DIA = 86_400_000;
const inicioDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const parseDia = (d: string) => new Date(d.length <= 10 ? `${d}T00:00:00` : d);

/** Días entre la fecha límite y (el pago, o hoy si sigue debiéndose). Solo para ordenar. */
function diasDeAtraso(c: CobroCuenta, grupo: GrupoPago, now: Date): number {
  if (!c.due_date) return 0;
  const limite = inicioDia(parseDia(c.due_date));
  if (grupo === 'pago' && c.payment_date) return Math.max(0, Math.round((inicioDia(parseDia(c.payment_date)) - limite) / MS_DIA));
  if ((grupo === 'vencido' || grupo === 'abono') && estaVencido(c, now)) return Math.max(0, Math.round((inicioDia(now) - limite) / MS_DIA));
  return 0;
}

/**
 * Una fila por atleta. `nombres` mapea el id del atleta (child_id, user_id o
 * unregistered_athlete_id) a su nombre. Los anulados no cuentan. Un atleta sin
 * nombre conocido se muestra como «Sin nombre»: nunca se oculta su deuda.
 */
export function filasDelMes(cobros: CobroDelMes[], nombres: Map<string, string>, now = new Date()): FilaPago[] {
  const porAtleta = new Map<string, CobroDelMes[]>();
  for (const c of cobros) {
    if (c.status === 'cancelled') continue;
    const id = c.child_id || c.user_id || c.unregistered_athlete_id;
    if (!id) continue;
    if (!porAtleta.has(id)) porAtleta.set(id, []);
    porAtleta.get(id)!.push(c);
  }
  const filas: FilaPago[] = [];
  for (const [id, lista] of porAtleta) {
    const ordenados = [...lista].sort((a, b) => ORDEN[grupoDe(a, now)] - ORDEN[grupoDe(b, now)]);
    const principal = ordenados[0];
    const grupo = grupoDe(principal, now);
    filas.push({
      clave: id,
      nombre: nombres.get(id) ?? 'Sin nombre',
      objetivo: {
        child_id: principal.child_id,
        adult_id: principal.child_id || principal.unregistered_athlete_id ? null : principal.user_id,
        unregistered_athlete_id: principal.child_id ? null : principal.unregistered_athlete_id,
        name: nombres.get(id) ?? 'Sin nombre',
      },
      cobro: principal,
      otros: ordenados.length - 1,
      estado: estadoCobro(principal, now),
      grupo,
      dias: diasDeAtraso(principal, grupo, now),
    });
  }
  return filas.sort((a, b) =>
    ORDEN[a.grupo] - ORDEN[b.grupo] || b.dias - a.dias || a.nombre.localeCompare(b.nombre, 'es'));
}

export interface ResumenPagos {
  /** Atletas con cobro de pago real (valor mayor que cero) en el período. */
  total: number;
  pagaron: number;
  aTiempo: number;
  vencidos: number;
  enRevision: number;
  abonos: number;
  porPagar: number;
}

/** Cuenta personas, no pesos. Los cobros en $0 (becados) no entran. */
export function resumenPagos(filas: FilaPago[]): ResumenPagos {
  const r: ResumenPagos = { total: 0, pagaron: 0, aTiempo: 0, vencidos: 0, enRevision: 0, abonos: 0, porPagar: 0 };
  for (const f of filas) {
    if (!(Number(f.cobro.amount || 0) > 0)) continue;
    r.total++;
    if (f.grupo === 'pago') { r.pagaron++; if (f.dias === 0) r.aTiempo++; }
    else if (f.grupo === 'vencido') r.vencidos++;
    else if (f.grupo === 'revision') r.enRevision++;
    else if (f.grupo === 'abono') r.abonos++;
    else if (POR_PAGAR.includes(f.cobro.status)) r.porPagar++;
  }
  return r;
}

/** Valor que se muestra a la derecha de la fila: lo pagado si ya pagó, si no el valor del cobro. */
export const valorFila = (f: FilaPago) => valorCobro(f.cobro);
