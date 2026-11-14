import { describe, expect, it } from 'vitest';
import { claveAtleta, juntarPorAtleta, marcarGrupos, ordenarPagosRecibidos, type FilaPagoRecibido } from './pagosRecibidosOrden';

describe('marcarGrupos', () => {
  it('marca qué filas continúan el bloque de la anterior y cuáles siguen en la próxima', () => {
    const filas = [{ id: '1', k: 'a' }, { id: '2', k: 'a' }, { id: '3', k: 'a' }, { id: '4', k: 'b' }];
    const g = marcarGrupos(filas, (f) => f.k);
    expect(g.get('1')).toEqual({ continua: false, sigue: true });
    expect(g.get('2')).toEqual({ continua: true, sigue: true });
    expect(g.get('3')).toEqual({ continua: true, sigue: false });
    expect(g.get('4')).toEqual({ continua: false, sigue: false });
  });
});

type Fila = FilaPagoRecibido & { dia: string };
const dia = (p: Fila) => p.dia;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('ordenarPagosRecibidos', () => {
  it('junta los pagos de una misma atleta dentro del día aunque se hayan emitido en fechas distintas', () => {
    // La atleta A pagó la mensualidad (emitida el 31-oct) y unas horas (emitidas
    // el 7-nov) el mismo día; con el orden por emisión, el pago de B quedaba en medio.
    const filas: Fila[] = [
      { id: 'a-horas', dia: '2026-11-07', child_id: 'a', created_at: '2026-11-07T15:00:00Z' },
      { id: 'b', dia: '2026-11-07', child_id: 'b', created_at: '2026-11-07T13:23:00Z' },
      { id: 'a-mens', dia: '2026-11-07', child_id: 'a', created_at: '2026-10-31T15:53:00Z' },
      { id: 'c', dia: '2026-11-07', child_id: 'c', created_at: '2026-10-30T17:34:00Z' },
    ];
    expect(ids(ordenarPagosRecibidos(filas, dia))).toEqual(['a-horas', 'a-mens', 'b', 'c']);
  });

  it('los días siguen de más reciente a más viejo y un atleta no se junta entre días', () => {
    const filas: Fila[] = [
      { id: 'a-29', dia: '2026-10-29', child_id: 'a', created_at: '2026-10-29T23:30:00Z' },
      { id: 'a-07', dia: '2026-11-07', child_id: 'a', created_at: '2026-11-07T10:00:00Z' },
      { id: 'b-31', dia: '2026-10-31', child_id: 'b', created_at: '2026-10-31T16:20:00Z' },
    ];
    expect(ids(ordenarPagosRecibidos(filas, dia))).toEqual(['a-07', 'b-31', 'a-29']);
  });

  it('identifica al atleta por cualquiera de sus tres columnas, no solo child_id', () => {
    expect(claveAtleta({ id: 'x', user_id: 'adulto' })).toBe('adulto');
    expect(claveAtleta({ id: 'x', unregistered_athlete_id: 'ua' })).toBe('ua');
    expect(claveAtleta({ id: 'x', parent_id: 'legacy' })).toBe('legacy');
    expect(claveAtleta({ id: 'x' })).toBe('pago:x');
  });

  it('no muta el arreglo original', () => {
    const filas: Fila[] = [
      { id: 'a', dia: '2026-11-01', child_id: 'a', created_at: '2026-11-01T00:00:00Z' },
      { id: 'b', dia: '2026-11-02', child_id: 'b', created_at: '2026-11-02T00:00:00Z' },
    ];
    ordenarPagosRecibidos(filas, dia);
    expect(ids(filas)).toEqual(['a', 'b']);
  });
});

describe('juntarPorAtleta', () => {
  it('junta las filas de cada atleta donde apareció primero y respeta su orden interno', () => {
    // Lote de varios atletas: primero la inscripción de todos, después el seguro de todos.
    const filas = [
      { id: 'a-insc', n: 'Ana Prueba' },
      { id: 'b-insc', n: 'Bruno Prueba' },
      { id: 'a-seg', n: 'Ana Prueba' },
      { id: 'b-seg', n: 'Bruno Prueba' },
      { id: 'a-mens', n: 'ana prueba ' },
    ];
    expect(ids(juntarPorAtleta(filas, (f) => f.n))).toEqual(['a-insc', 'a-seg', 'a-mens', 'b-insc', 'b-seg']);
  });

  it('las filas sin nombre no se juntan entre sí', () => {
    const filas = [{ id: '1', n: null }, { id: '2', n: 'Carla' }, { id: '3', n: '' }, { id: '4', n: 'Carla' }];
    expect(ids(juntarPorAtleta(filas, (f) => f.n))).toEqual(['1', '2', '4', '3']);
  });
});
