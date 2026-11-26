/**
 * Reverso genérico del carnet 3D (spec §7, D2): sirve para cualquier deporte o
 * cuando no hay datos de partido. Pinta las 4 estadísticas que mande
 * card_back_data, sin asumir claves; `valor: null` se muestra «—».
 *
 * Medidas en px fijas: el carnet se escala entero (base 340 × 540).
 */
import type { CardBackData } from '@/lib/cards/contratos';

export type Estadistica = NonNullable<CardBackData['estadisticas']>[number];

/** Las cuatro del genérico, por si la RPC no manda el arreglo. */
export const ESTADISTICAS_GENERICAS: Estadistica[] = [
  { clave: 'asistencia', etiqueta: 'Asistencia', valor: null, detalle: 'últimos 90 días' },
  { clave: 'sesiones', etiqueta: 'Sesiones', valor: null, detalle: 'últimos 90 días' },
  { clave: 'ultimo_informe', etiqueta: 'Último informe', valor: null, detalle: null },
  { clave: 'antiguedad', etiqueta: 'En el club', valor: null, detalle: null },
];

/** Hasta 4 estadísticas; si no llega ninguna, las genéricas en «—». */
export function cuatroEstadisticas(lista: CardBackData['estadisticas'] | null | undefined): Estadistica[] {
  const validas = (lista ?? []).filter((e) => e && typeof e.etiqueta === 'string');
  return (validas.length ? validas : ESTADISTICAS_GENERICAS).slice(0, 4);
}

export function valorVisible(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const s = String(v).trim();
  return s === '' ? '—' : s;
}

export function TarjetaEstadistica({ e, acento }: { e: Estadistica; acento: string }) {
  return (
    <div
      style={{
        borderRadius: 12,
        background: '#F3F4F6',
        padding: '8px 10px',
        minHeight: 58,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#4B5563', lineHeight: '14px' }}>
        {e.etiqueta}
      </span>
      <span style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: '24px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {valorVisible(e.valor)}
      </span>
      {e.detalle && (
        <span style={{ fontSize: 10, color: '#6B7280', lineHeight: '13px', borderTop: `2px solid ${acento}`, marginTop: 2, paddingTop: 1, alignSelf: 'flex-start' }}>
          {e.detalle}
        </span>
      )}
    </div>
  );
}

export interface ReversoProps {
  reverso: CardBackData;
  /** Número de camiseta ya resuelto (frente o zona de juego). */
  numero: number | null;
  posicion: string | null;
  acento: string;
}

export function ReversoGenerico({ reverso, acento }: ReversoProps) {
  const stats = cuatroEstadisticas(reverso.estadisticas);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div>
        <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#6B7280' }}>
          {reverso.deporte_nombre ? `Resumen · ${reverso.deporte_nombre}` : 'Resumen'}
        </p>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#111827' }}>Así va en el club</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {stats.map((e) => <TarjetaEstadistica key={e.clave} e={e} acento={acento} />)}
      </div>
    </div>
  );
}

export default ReversoGenerico;
