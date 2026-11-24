/**
 * Vista unificada de «lo que falta por enviar» — PURA.
 *
 * Junta las dos fuentes que conviven en el teléfono:
 *  · la cola de listas de asistencia (localStorage, `colaAsistencia.ts`), y
 *  · la bandeja de salida común (IndexedDB, `bandeja.ts`).
 * Ninguna se migra a la otra (la de asistencia funciona y tiene su red de pruebas); esta capa solo las
 * presenta juntas: una banda y una pantalla, con el motivo de cada rechazo.
 */
import type { ListaEnCola } from '@/components/coach/v2/colaAsistencia';
import type { AccionEnBandeja } from './bandeja';

export type OrigenPendiente = 'asistencia' | 'bandeja';
export type EstadoPendiente = 'pendiente' | 'rechazada' | 'atascada';

export interface PendienteVista {
  origen: OrigenPendiente;
  /** `key` de la lista o `id` de la acción: con `origen` identifica a quién se le aplica Reintentar/Descartar. */
  id: string;
  /** Texto humano: «Sub 11 · jueves 8 de octubre». */
  etiqueta: string;
  /** Qué clase de cosa es: «Lista de asistencia», «Evaluación». */
  clase: string;
  estado: EstadoPendiente;
  error?: string;
  /** Cuándo se guardó en el teléfono (ms). */
  desde: number;
}

const CLASE_BANDEJA: Record<string, string> = { evaluar: 'Evaluación' };

export function armarPendientes(listas: ListaEnCola[], acciones: AccionEnBandeja[]): PendienteVista[] {
  const deListas: PendienteVista[] = listas.map((l) => ({
    origen: 'asistencia', id: l.key, etiqueta: l.etiqueta, clase: 'Lista de asistencia',
    estado: l.error ? (l.atascada ? 'atascada' : 'rechazada') : 'pendiente', error: l.error, desde: l.created_at,
  }));
  const deBandeja: PendienteVista[] = acciones.map((a) => ({
    origen: 'bandeja', id: a.id, etiqueta: a.etiqueta, clase: CLASE_BANDEJA[a.tipo] ?? 'Acción',
    estado: a.error ? (a.atascada ? 'atascada' : 'rechazada') : 'pendiente', error: a.error, desde: a.created_at,
  }));
  // Primero lo que necesita al usuario (con problema), luego lo más antiguo.
  const peso = (p: PendienteVista) => (p.estado === 'pendiente' ? 1 : 0);
  return [...deListas, ...deBandeja].sort((a, b) => peso(a) - peso(b) || a.desde - b.desde);
}

export interface ResumenBanda {
  pendientes: number;
  conProblema: number;
  /** Texto de la banda; null = no hay nada que mostrar. */
  texto: string | null;
  tono: 'info' | 'alerta';
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios.replace('{n}', String(n)));

export function resumenBanda(vistas: PendienteVista[], enLinea: boolean): ResumenBanda {
  const conProblema = vistas.filter((v) => v.estado !== 'pendiente').length;
  const pendientes = vistas.length - conProblema;
  if (conProblema > 0) {
    return { pendientes, conProblema, tono: 'alerta', texto: plural(conProblema, '1 con problema · toca para ver', '{n} con problema · toca para ver') };
  }
  if (pendientes > 0) {
    const n = plural(pendientes, '1 pendiente', '{n} pendientes');
    return { pendientes, conProblema, tono: 'info', texto: enLinea ? `Enviando ${n}…` : `Sin señal · ${n}` };
  }
  return { pendientes, conProblema, tono: 'info', texto: null };
}
