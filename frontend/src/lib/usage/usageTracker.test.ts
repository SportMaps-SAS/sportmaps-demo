import { describe, it, expect } from 'vitest';
import { normalizarRuta, startUsageTracking, stopUsageTracking, trackApi, trackScreen } from './usageTracker';

describe('normalizarRuta', () => {
  it('reemplaza uuids y números por :id y quita el query', () => {
    expect(normalizarRuta('/teams/3f2a9c1e-1111-4222-8333-444455556666/edit?x=1')).toBe('/teams/:id/edit');
    expect(normalizarRuta('/students/123')).toBe('/students/:id');
  });
  it('baja a minúsculas y quita la barra final', () => {
    expect(normalizarRuta('/Coach-Attendance/')).toBe('/coach-attendance');
    expect(normalizarRuta('/')).toBe('/');
  });
  it('no deja pasar tokens largos', () => {
    expect(normalizarRuta('/pagar/abc123def456ghi789')).toBe('/pagar/:id');
  });
});

describe('contadores y clics', () => {
  const enviados: Record<string, number>[] = [];
  const arrancar = () => {
    enviados.length = 0;
    startUsageTracking(async (p) => { enviados.push(p.counters); }, () => 'standalone');
  };

  it('cuenta pantallas y llamadas, y no cuenta /usage', async () => {
    arrancar();
    trackScreen('/teams/3f2a9c1e-1111-4222-8333-444455556666');
    trackApi('post', '/api/v1/attendance', 201);
    trackApi('POST', '/api/v1/usage', 200);
    document.dispatchEvent(new Event('visibilitychange')); // jsdom: visible → no envía
    stopUsageTracking();
    expect(enviados.length).toBe(0);
  });

  it('cuenta botones con verbo de acción y data-track, y descarta nombres', async () => {
    arrancar();
    document.body.innerHTML = `
      <button id="a">Guardar</button>
      <button id="b">Juan Pérez</button>
      <button id="c">Guardar 2026</button>
      <div id="d" data-track="coach.asistencia.guardar">x</div>`;
    for (const id of ['a', 'b', 'c', 'd']) document.getElementById(id)!.click();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    stopUsageTracking();
    const c = enviados[0] ?? {};
    const claves = Object.keys(c);
    expect(claves.some((k) => k.endsWith('|guardar'))).toBe(true);
    expect(claves.some((k) => k.endsWith('|coach.asistencia.guardar'))).toBe(true);
    expect(claves.some((k) => k.toLowerCase().includes('juan'))).toBe(false);
    expect(claves.some((k) => k.includes('2026'))).toBe(false);
  });
});
