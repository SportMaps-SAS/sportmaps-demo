/**
 * Cola de listas con VARIAS instancias sobre el mismo localStorage (la PWA y una
 * pestaña de Chrome), backoff con sesión vencida y 5xx que no bloquea.
 */
import { describe, it, expect, vi } from 'vitest';
import type { QueueStorage } from '@/lib/tournamentActionQueue';
import {
  ColaAsistencia, MAX_INTENTOS_SERVIDOR, claveLista, type ListaEnCola, type ResultadoEnvio,
} from './colaAsistencia';
import type { RegistroLista } from './asistenciaModel';

function memoria(): QueueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

const K1 = claveLista('s1', 'team:t1', '2026-10-08');
const K2 = claveLista('s1', 'team:t2', '2026-10-08');
const K3 = claveLista('s1', 'team:t3', '2026-10-08');

const lista = (key: string, records: RegistroLista[]) => ({
  key, schoolId: 's1', etiqueta: key, payload: { teamId: key.split('|')[1], date: '2026-10-08', records },
});

describe('dos pestañas sobre el mismo localStorage', () => {
  it('cada una guarda una lista distinta con su copia vieja: no se pierde ninguna', () => {
    const storage = memoria();
    const t = 0;
    const send = vi.fn();
    const pwa = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    const chrome = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send }); // leyó vacío
    pwa.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    chrome.guardar(lista(K2, [{ childId: 'b', status: 'absent' }]), 0); // antes esto pisaba K1
    const tercera = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    expect(tercera.todas().map((i) => i.key).sort()).toEqual([K1, K2].sort());
    // La PWA, al releer, también ve la de Chrome.
    pwa.recargar();
    expect(pwa.size).toBe(2);
  });

  it('una pestaña con copia vieja no resucita una lista que la otra ya subió (no duplica)', async () => {
    const storage = memoria();
    const t = 0;
    const enviados: string[] = [];
    const send = vi.fn(async (i: ListaEnCola): Promise<ResultadoEnvio> => { enviados.push(`${i.key}@${i.version}`); return { kind: 'ok' }; });
    const a = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    a.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    const b = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send }); // b tiene K1 en memoria
    await a.flush(true);
    expect(enviados).toEqual([`${K1}@1`]);
    // b guarda OTRA lista sin haber releído: no debe volver a escribir K1.
    b.guardar(lista(K2, [{ childId: 'z', status: 'present' }]), 0);
    await b.flush(true);
    expect(enviados).toEqual([`${K1}@1`, `${K2}@1`]);
    expect(new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send }).size).toBe(0);
  });

  it('nunca sube una versión vieja encima de una nueva: la otra pestaña la corrigió mientras viajaba', async () => {
    const storage = memoria();
    const t = 0;
    let soltar: (r: ResultadoEnvio) => void = () => {};
    const enviados: ListaEnCola[] = [];
    const send = vi.fn((i: ListaEnCola) => { enviados.push(JSON.parse(JSON.stringify(i))); return new Promise<ResultadoEnvio>((res) => { soltar = res; }); });
    const a = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    a.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    const b = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    const p = a.flush(true);
    await Promise.resolve();
    // Corrigen en la otra pestaña mientras A está enviando v1.
    b.guardar(lista(K1, [{ childId: 'a', status: 'late' }]), 0);
    soltar({ kind: 'ok' });
    await p;
    // v2 sigue en la cola (la marca de v1 no la borra) y sube después.
    const c = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send: async (i) => { enviados.push(JSON.parse(JSON.stringify(i))); return { kind: 'ok' }; } });
    expect(c.size).toBe(1);
    expect(c.todas()[0].payload.records[0].status).toBe('late');
    await c.flush(true);
    expect(enviados.map((e) => `${e.version}:${e.payload.records[0].status}`)).toEqual(['1:present', '2:late']);
    expect(new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send }).size).toBe(0);
  });

  it('envía una sola pestaña a la vez: la otra no sube la misma lista en paralelo', async () => {
    const storage = memoria();
    const t = 0;
    let soltar: (r: ResultadoEnvio) => void = () => {};
    const send = vi.fn(() => new Promise<ResultadoEnvio>((res) => { soltar = res; }));
    const a = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    a.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    const b = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    const pa = a.flush(true);
    await Promise.resolve();
    const evB = await b.flush(true);
    expect(evB).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    soltar({ kind: 'ok' });
    await pa;
    await b.flush(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('volver a guardar una lista que ya subió entra como versión nueva (la marca no la borra)', async () => {
    const storage = memoria();
    const t = 0;
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'ok' }));
    const a = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    a.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    await a.flush(true);
    const b = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send });
    b.guardar(lista(K1, [{ childId: 'a', status: 'absent' }]), 0);
    expect(b.get(K1)?.version).toBe(2);
    a.recargar();
    expect(a.get(K1)?.payload.records[0].status).toBe('absent');
    await a.flush(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('Deshacer en una pestaña no lo revive la otra', () => {
    const storage = memoria();
    const t = 0;
    const a = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send: vi.fn() });
    a.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 8000);
    const b = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send: vi.fn() });
    expect(a.deshacer(K1)).toBe(true);
    b.soltar(K1); // b toca su copia vieja y escribe
    expect(new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => t, send: vi.fn() }).size).toBe(0);
  });
});

describe('esperas y bloqueos', () => {
  it('sesión vencida (401): espera creciente, no insiste cada 2 s', async () => {
    let t = 0;
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'auth', message: 'No hay sesión activa' }));
    const cola = new ColaAsistencia({ key: 'k', random: () => 1, storage: memoria(), now: () => t, send });
    cola.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    const ev1 = await cola.flush();
    expect(ev1[0]).toMatchObject({ type: 'auth_error', delayMs: 1000 });
    t = 500;
    await cola.flush();
    expect(send).toHaveBeenCalledTimes(1);
    t = 1000;
    const ev2 = await cola.flush();
    expect(ev2[0]).toMatchObject({ type: 'auth_error', delayMs: 2000 });
    t = 2500;
    await cola.flush();
    expect(send).toHaveBeenCalledTimes(2);
    t = 3000;
    await cola.flush();
    expect(send).toHaveBeenCalledTimes(3);
    expect(cola.size).toBe(1);
  });

  it('una lista con 5xx no bloquea a las de atrás, y tras N intentos queda para «Volver a intentar / Descartar»', async () => {
    let t = 0;
    const subidas: string[] = [];
    const send = vi.fn(async (i: ListaEnCola): Promise<ResultadoEnvio> => {
      if (i.key === K1) return { kind: 'retry', message: '500', servidor: true };
      subidas.push(i.key);
      return { kind: 'ok' };
    });
    const cola = new ColaAsistencia({ key: 'k', random: () => 1, storage: memoria(), now: () => t, send });
    cola.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    t = 1;
    cola.guardar(lista(K2, [{ childId: 'b', status: 'present' }]), 0);
    t = 2;
    cola.guardar(lista(K3, [{ childId: 'c', status: 'present' }]), 0);
    await cola.flush();
    expect(subidas).toEqual([K2, K3]);
    expect(cola.pendientes().map((i) => i.key)).toEqual([K1]);

    for (let n = 2; n <= MAX_INTENTOS_SERVIDOR; n++) { t += 60_000; await cola.flush(); }
    expect(send.mock.calls.filter(([i]) => i.key === K1)).toHaveLength(MAX_INTENTOS_SERVIDOR);
    const atascada = cola.get(K1)!;
    expect(atascada.atascada).toBe(true);
    expect(atascada.error).toMatch(/varios intentos/);
    expect(cola.pendientes()).toHaveLength(0);
    // Ya no se reintenta sola.
    t += 60_000;
    await cola.flush(true);
    expect(send.mock.calls.filter(([i]) => i.key === K1)).toHaveLength(MAX_INTENTOS_SERVIDOR);
    // «Volver a intentar»: sale de nuevo.
    expect(cola.reintentar(K1)).toBe(true);
    send.mockImplementation(async () => ({ kind: 'ok' }));
    await cola.flush(true);
    expect(cola.size).toBe(0);
  });

  it('sin señal no cuenta como servidor caído: sigue esperando sin marcarla', async () => {
    let t = 0;
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'retry', message: 'Sin señal' }));
    const cola = new ColaAsistencia({ key: 'k', random: () => 1, storage: memoria(), now: () => t, send });
    cola.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    for (let n = 0; n < MAX_INTENTOS_SERVIDOR + 3; n++) { t += 60_000; await cola.flush(); }
    expect(cola.get(K1)?.error).toBeUndefined();
    expect(cola.pendientes()).toHaveLength(1);
  });

  it('Descartar una atascada la saca y no vuelve', async () => {
    const send = vi.fn(async (): Promise<ResultadoEnvio> => ({ kind: 'rule', message: 'La sesión ya fue finalizada.' }));
    const storage = memoria();
    const cola = new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => 0, send });
    cola.guardar(lista(K1, [{ childId: 'a', status: 'present' }]), 0);
    await cola.flush(true);
    cola.descartar(K1);
    expect(cola.size).toBe(0);
    expect(new ColaAsistencia({ key: 'k', random: () => 1, storage, now: () => 0, send }).size).toBe(0);
  });
});
