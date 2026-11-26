import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { REVERSOS, claveDeporte, reversoPara } from './reversos';
import { ReversoFutbol } from '@/components/cards/reversos/ReversoFutbol';
import { ReversoGenerico, cuatroEstadisticas, valorVisible } from '@/components/cards/reversos/ReversoGenerico';
import type { CardBackData } from './contratos';

describe('registro de reversos', () => {
  it('fútbol tiene su reverso, con o sin tilde', () => {
    expect(reversoPara('futbol')).toBe(ReversoFutbol);
    expect(reversoPara('Fútbol')).toBe(ReversoFutbol);
    expect(claveDeporte(' FÚTBOL ')).toBe('futbol');
  });

  it('deporte desconocido, vacío o null → genérico', () => {
    expect(reversoPara('voleibol')).toBe(ReversoGenerico);
    expect(reversoPara('')).toBe(ReversoGenerico);
    expect(reversoPara(null)).toBe(ReversoGenerico);
    expect(reversoPara(undefined)).toBe(ReversoGenerico);
  });

  it('agregar un deporte es agregar una entrada', () => {
    expect(Object.keys(REVERSOS)).toEqual(expect.arrayContaining(['futbol', 'generico']));
  });
});

describe('estadísticas del reverso', () => {
  it('null se muestra «—»', () => {
    expect(valorVisible(null)).toBe('—');
    expect(valorVisible('  ')).toBe('—');
    expect(valorVisible('92 %')).toBe('92 %');
  });

  it('máximo 4 y, si no llega ninguna, las genéricas', () => {
    const muchas = Array.from({ length: 6 }, (_, i) => ({ clave: `k${i}`, etiqueta: `E${i}`, valor: String(i), detalle: null }));
    expect(cuatroEstadisticas(muchas)).toHaveLength(4);
    expect(cuatroEstadisticas(undefined).map((e) => e.clave)).toEqual(['asistencia', 'sesiones', 'ultimo_informe', 'antiguedad']);
  });
});

const back: CardBackData = {
  found: true,
  deporte: 'generico',
  estadisticas: [
    { clave: 'asistencia', etiqueta: 'Asistencia', valor: null, detalle: 'últimos 90 días' },
    { clave: 'sesiones', etiqueta: 'Sesiones', valor: '12', detalle: null },
    { clave: 'ultimo_informe', etiqueta: 'Último informe', valor: null, detalle: null },
    { clave: 'goles', etiqueta: 'Goles', valor: '3', detalle: null },
  ],
};

describe('pintado', () => {
  it('genérico: pinta lo que llega sin asumir claves, null como «—»', () => {
    render(<ReversoGenerico reverso={back} numero={null} posicion={null} acento="#FB9F1E" />);
    expect(screen.getByText('Goles')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('fútbol: zona de juego y número', () => {
    render(<ReversoFutbol reverso={{ ...back, deporte: 'futbol' }} numero={9} posicion="Centrodelantero" acento="#FB9F1E" />);
    expect(screen.getByRole('img', { name: 'Zona de juego: Delantero' })).toBeInTheDocument();
    expect(screen.getByText('Delantero')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('fútbol sin posición: cancha sin marcar', () => {
    render(<ReversoFutbol reverso={{ ...back, deporte: 'futbol' }} numero={null} posicion={null} acento="#FB9F1E" />);
    expect(screen.getByRole('img', { name: 'Sin zona de juego' })).toBeInTheDocument();
    expect(screen.getByText('Sin asignar')).toBeInTheDocument();
  });
});
