/**
 * Reverso de fútbol del carnet 3D (spec §7, D1): mini cancha con la «Zona de
 * juego» (la posición asignada; no es un mapa de calor), el número y 4
 * estadísticas tal como lleguen de card_back_data (hoy las genéricas; F4 del
 * backend agrega las del partido con las mismas formas).
 */
import { coordenadasZona, zonaDeJuego } from '@/lib/cards/zonaDeJuego';
import { TarjetaEstadistica, cuatroEstadisticas, type ReversoProps } from './ReversoGenerico';

function MiniCancha({ posicion, acento }: { posicion: string | null; acento: string }) {
  const z = zonaDeJuego(posicion);
  const punto = z ? coordenadasZona(z) : null;
  const linea = 'rgba(255,255,255,0.85)';
  return (
    <svg viewBox="0 0 100 140" width={96} height={134} role="img" aria-label={z ? `Zona de juego: ${z.etiqueta}` : 'Sin zona de juego'}>
      <rect x="0" y="0" width="100" height="140" rx="6" fill="#2F7D32" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect key={i} x="0" y={i * 20} width="100" height="10" fill="#2A7230" />
      ))}
      <rect x="5" y="5" width="90" height="130" fill="none" stroke={linea} strokeWidth="1.2" />
      <line x1="5" y1="70" x2="95" y2="70" stroke={linea} strokeWidth="1.2" />
      <circle cx="50" cy="70" r="12" fill="none" stroke={linea} strokeWidth="1.2" />
      <rect x="27" y="5" width="46" height="18" fill="none" stroke={linea} strokeWidth="1.2" />
      <rect x="27" y="117" width="46" height="18" fill="none" stroke={linea} strokeWidth="1.2" />
      <rect x="40" y="5" width="20" height="7" fill="none" stroke={linea} strokeWidth="1.2" />
      <rect x="40" y="128" width="20" height="7" fill="none" stroke={linea} strokeWidth="1.2" />
      {punto && (
        <>
          <circle cx={punto.x} cy={punto.y} r="13" fill={acento} opacity="0.35" />
          <circle cx={punto.x} cy={punto.y} r="7" fill={acento} stroke="#FFFFFF" strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

export function ReversoFutbol({ reverso, numero, posicion, acento }: ReversoProps) {
  const pos = posicion ?? reverso.zona_de_juego?.posicion ?? null;
  const num = numero ?? reverso.zona_de_juego?.numero ?? null;
  const z = zonaDeJuego(pos);
  const stats = cuatroEstadisticas(reverso.estadisticas);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <MiniCancha posicion={pos} acento={acento} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#6B7280' }}>
            Zona de juego
          </p>
          <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: '24px' }}>
            {z ? z.etiqueta : 'Sin asignar'}
          </p>
          {pos && z && pos.trim().toLowerCase() !== z.etiqueta.toLowerCase() && (
            <p style={{ margin: 0, fontSize: 12, color: '#4B5563', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pos}</p>
          )}
          {!z && (
            <p style={{ margin: 0, fontSize: 11, color: '#6B7280', lineHeight: '14px' }}>
              El entrenador la define en la ficha o en la alineación.
            </p>
          )}
          <p style={{ margin: '8px 0 0', fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#6B7280' }}>
            Número
          </p>
          <p style={{ margin: 0, fontSize: 34, fontWeight: 900, color: '#111827', lineHeight: '36px' }}>{num ?? '—'}</p>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {stats.map((e) => <TarjetaEstadistica key={e.clave} e={e} acento={acento} />)}
      </div>
    </div>
  );
}

export default ReversoFutbol;
