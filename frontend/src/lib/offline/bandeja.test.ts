import { describe, expect, it, vi } from 'vitest';
import { Bandeja, MAX_INTENTOS_SERVIDOR, type AlmacenBandeja, type AccionEnBandeja } from './bandeja';
import { clasificarErrorEvaluar, esErrorDeRed } from './bandejaEvaluar';
import { armarPendientes, resumenBanda } from './pendientesModel';
import type { ResultadoEnvio } from '@/components/coach/v2/colaAsistencia';

function almacenEnMemoria(): AlmacenBandeja & { datos: Map<string, unknown> } {
  const datos = new Map<string, unknown>();
  return {
    datos,
    get: async <T,>(k: string) => (datos.has(k) ? (structuredClone(datos.get(k)) as T) : undefined),
    set: async (k, v) => { datos.set(k, structuredClone(v)); },
    del: async (k) => { datos.delete(k); },
    list: async <T,>(p: string) => [...datos.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v) as T),
  };
}

function nueva(opts: {
  almacen?: ReturnType<typeof almacenEnMemoria>; userId?: string; envio?: (a: AccionEnBandeja) => Promise<ResultadoEnvio>;
  reloj?: { t: number }; candado?: null;
}) {
  const almacen = opts.almacen ?? almacenEnMemoria();
  const reloj = opts.reloj ?? { t: 1_000_000 };
  const enviadas: string[] = [];
  const envio = opts.envio ?? (async (a) => { enviadas.push(a.id); return { kind: 'ok' } as ResultadoEnvio; });
  const b = new Bandeja({
    userId: opts.userId ?? 'u1', manejadores: { evaluar: envio }, almacen, now: () => reloj.t, candado: null, canal: null,
  });
  return { b, almacen, reloj, enviadas };
}

const entrada = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tipo: 'evaluar', schoolId: 's1', payload: { n: 1, ...extra }, etiqueta: `Sub 11 · ${id}`,
});

describe('Bandeja — guardar y enviar', () => {
  it('guarda en el almacén ya (antes de enviar) y sube una vez', async () => {
    const { b, almacen, enviadas } = nueva({});
    await b.encolar(entrada('evaluar:a'));
    expect(almacen.datos.size).toBe(1);
    const ev = await b.flush(true);
    expect(enviadas).toEqual(['evaluar:a']);
    expect(ev.map((e) => e.type)).toEqual(['sent']);
    expect(almacen.datos.size).toBe(0);
    expect(b.size).toBe(0);
  });

  it('guardar el mismo id otra vez REEMPLAZA (una sola acción, versión sube, gana lo último)', async () => {
    const { b, enviadas } = nueva({ envio: async (a) => { enviadas2.push(a); return { kind: 'ok' }; } });
    const enviadas2: AccionEnBandeja[] = [];
    await b.encolar(entrada('evaluar:a', { v: 'viejo' }));
    const segunda = await b.encolar(entrada('evaluar:a', { v: 'nuevo' }));
    expect(segunda.version).toBe(2);
    expect(b.size).toBe(1);
    await b.flush(true);
    expect(enviadas2).toHaveLength(1);
    expect((enviadas2[0].payload as { v: string }).v).toBe('nuevo');
    expect(enviadas).toEqual([]);
  });

  it('envía en orden de llegada y de a una', async () => {
    const orden: string[] = [];
    const reloj = { t: 1000 };
    const { b } = nueva({ reloj, envio: async (a) => { orden.push(a.id); return { kind: 'ok' }; } });
    await b.encolar(entrada('evaluar:a')); reloj.t += 10;
    await b.encolar(entrada('evaluar:b')); reloj.t += 10;
    await b.encolar(entrada('evaluar:c'));
    await b.flush(true);
    expect(orden).toEqual(['evaluar:a', 'evaluar:b', 'evaluar:c']);
  });

  it('doble flush a la vez no envía dos veces la misma acción', async () => {
    let llamadas = 0;
    const { b } = nueva({ envio: async () => { llamadas++; await new Promise((r) => setTimeout(r, 5)); return { kind: 'ok' }; } });
    await b.encolar(entrada('evaluar:a'));
    await Promise.all([b.flush(true), b.flush(true), b.flush(false)]);
    expect(llamadas).toBe(1);
  });
});

describe('Bandeja — errores', () => {
  it('rechazo de regla: se aparta CON su motivo, no se descarta, y las demás siguen', async () => {
    const { b, almacen } = nueva({
      envio: async (a) => (a.id === 'evaluar:a' ? { kind: 'rule', message: 'No se guardó: ya no existe.' } : { kind: 'ok' }),
    });
    await b.encolar(entrada('evaluar:a'));
    await b.encolar(entrada('evaluar:b'));
    const ev = await b.flush(true);
    expect(ev.map((e) => e.type).sort()).toEqual(['rule_error', 'sent']);
    expect(b.conProblema()).toHaveLength(1);
    expect(b.conProblema()[0].error).toBe('No se guardó: ya no existe.');
    expect(almacen.datos.size).toBe(1);
    // No se reintenta sola.
    const otra = await b.flush(true);
    expect(otra).toEqual([]);
  });

  it('falta de señal: espera creciente y NO se pierde; vuelve a salir cuando toca', async () => {
    let falla = true;
    const reloj = { t: 1000 };
    const { b } = nueva({ reloj, envio: async () => (falla ? { kind: 'retry', message: 'Sin señal' } : { kind: 'ok' }) });
    await b.encolar(entrada('evaluar:a'));
    const e1 = await b.flush(true);
    expect(e1[0].type).toBe('retry');
    expect(b.pendientes()[0].intentos).toBe(1);
    // Antes de la espera no se reintenta.
    expect(await b.flush(false)).toEqual([]);
    expect(b.proximoIntento()).toBeGreaterThan(reloj.t);
    falla = false;
    reloj.t = (b.proximoIntento() ?? 0) + 1;
    const e2 = await b.flush(false);
    expect(e2[0].type).toBe('sent');
    expect(b.size).toBe(0);
  });

  it('servidor caído muchas veces: queda atascada con motivo para que el usuario decida', async () => {
    const { b } = nueva({ envio: async () => ({ kind: 'retry', message: 'Servidor caído', servidor: true }) });
    await b.encolar(entrada('evaluar:a'));
    let ultimo: string | undefined;
    for (let i = 0; i < MAX_INTENTOS_SERVIDOR; i++) {
      const ev = await b.flush(true);
      ultimo = ev[0]?.type;
    }
    expect(ultimo).toBe('stuck');
    expect(b.conProblema()[0]).toMatchObject({ atascada: true, error: 'Servidor caído' });
  });

  it('sesión vencida (auth): frena sin perder nada ni gastar intentos', async () => {
    const { b } = nueva({ envio: async () => ({ kind: 'auth', message: 'Sin sesión' }) });
    await b.encolar(entrada('evaluar:a'));
    await b.encolar(entrada('evaluar:b'));
    const ev = await b.flush(true);
    expect(ev.map((e) => e.type)).toEqual(['auth_error']);
    expect(b.size).toBe(2);
    expect(b.pendientes().every((a) => a.intentos === 0)).toBe(true);
  });

  it('una excepción del manejador se trata como falta de señal (no se pierde)', async () => {
    const { b } = nueva({ envio: async () => { throw new TypeError('Failed to fetch'); } });
    await b.encolar(entrada('evaluar:a'));
    const ev = await b.flush(true);
    expect(ev[0].type).toBe('retry');
    expect(b.size).toBe(1);
  });

  it('Reintentar una rechazada la devuelve a la fila con versión nueva; Descartar la quita', async () => {
    let regla = true;
    const { b } = nueva({ envio: async () => (regla ? { kind: 'rule', message: 'No' } : { kind: 'ok' }) });
    await b.encolar(entrada('evaluar:a'));
    await b.flush(true);
    expect(b.conProblema()).toHaveLength(1);
    regla = false;
    expect(await b.reintentar('evaluar:a')).toBe(true);
    expect(b.conProblema()).toHaveLength(0);
    expect(b.pendientes()[0].version).toBe(2);
    await b.flush(true);
    expect(b.size).toBe(0);

    await b.encolar(entrada('evaluar:z'));
    await b.descartar('evaluar:z');
    expect(b.size).toBe(0);
    expect(await b.reintentar('evaluar:no-existe')).toBe(false);
  });

  it('si la vuelven a guardar MIENTRAS viaja la anterior, la versión nueva NO se borra', async () => {
    const { b, enviadas } = nueva({});
    let soltar!: () => void;
    const retenida = new Promise<void>((r) => { soltar = r; });
    const reenvios: AccionEnBandeja[] = [];
    const b2 = new Bandeja({
      userId: 'u1', almacen: (b as unknown as { almacen: AlmacenBandeja }).almacen, now: Date.now, candado: null, canal: null,
      manejadores: { evaluar: async (a) => { reenvios.push(a); if (reenvios.length === 1) await retenida; return { kind: 'ok' }; } },
    });
    await b2.encolar(entrada('evaluar:a', { v: 1 }));
    const vuelo = b2.flush(true);
    await new Promise((r) => setTimeout(r, 5));
    await b2.encolar(entrada('evaluar:a', { v: 2 })); // se vuelve a guardar durante el envío
    soltar();
    await vuelo;
    // La v1 llegó, pero la v2 sigue en la bandeja y sale a continuación (idempotente: gana la última).
    expect(reenvios.map((a) => (a.payload as { v: number }).v)).toEqual([1, 2]);
    expect(b2.size).toBe(0);
    expect(enviadas).toEqual([]);
  });
});

describe('Bandeja — usuarios y pestañas', () => {
  it('otro usuario en el mismo celular NO ve ni envía lo del dueño', async () => {
    const almacen = almacenEnMemoria();
    const a = nueva({ almacen, userId: 'ana' });
    await a.b.encolar(entrada('evaluar:x'));
    const bruno = nueva({ almacen, userId: 'bruno' });
    await bruno.b.cargar();
    expect(bruno.b.size).toBe(0);
    await bruno.b.flush(true);
    expect(bruno.enviadas).toEqual([]);
    // Lo de Ana sigue ahí, intacto, esperando a su dueña.
    await a.b.cargar();
    expect(a.b.size).toBe(1);
  });

  it('un tipo que esta versión no conoce se conserva tal cual (ni se envía ni se descarta)', async () => {
    const almacen = almacenEnMemoria();
    const { b } = nueva({ almacen });
    await b.encolar({ id: 'raro:1', tipo: 'otra-cosa', schoolId: 's1', payload: {}, etiqueta: 'x' });
    const ev = await b.flush(true);
    expect(ev).toEqual([]);
    expect(almacen.datos.size).toBe(1);
  });

  it('dos pestañas con el candado: solo una envía y la acción llega UNA vez', async () => {
    const almacen = almacenEnMemoria();
    let ocupado = false;
    const candado = { con: async <T,>(fn: (r: () => void) => Promise<T>) => { if (ocupado) return null; ocupado = true; try { return await fn(() => undefined); } finally { ocupado = false; } } };
    let llamadas = 0;
    const manejadores = { evaluar: async () => { llamadas++; await new Promise((r) => setTimeout(r, 10)); return { kind: 'ok' } as ResultadoEnvio; } };
    const t1 = new Bandeja({ userId: 'u1', manejadores, almacen, candado, canal: null });
    const t2 = new Bandeja({ userId: 'u1', manejadores, almacen, candado, canal: null });
    await t1.encolar(entrada('evaluar:a'));
    await t2.cargar();
    await Promise.all([t1.flush(true), t2.flush(true)]);
    expect(llamadas).toBe(1);
    await t2.cargar();
    expect(t2.size).toBe(0);
  });

  it('avisa a los oyentes y al canal cuando cambia', async () => {
    const onChange = vi.fn();
    const avisar = vi.fn();
    const b = new Bandeja({ userId: 'u1', manejadores: { evaluar: async () => ({ kind: 'ok' }) }, almacen: almacenEnMemoria(), candado: null, canal: { avisar, escuchar: () => () => undefined }, onChange });
    await b.encolar(entrada('evaluar:a'));
    expect(onChange).toHaveBeenCalled();
    expect(avisar).toHaveBeenCalled();
  });
});

describe('clasificarErrorEvaluar', () => {
  it('sin código y con texto de red = falta de señal', () => {
    expect(esErrorDeRed({ message: 'TypeError: Failed to fetch' })).toBe(true);
    expect(clasificarErrorEvaluar({ message: 'Failed to fetch' })).toMatchObject({ kind: 'retry', message: 'Sin señal' });
    expect(esErrorDeRed({ code: '42501', message: 'x' })).toBe(false);
  });
  it('«no se ha cerrado» / «no asistió»: la lista puede estar aún en la cola → se reintenta', () => {
    expect(clasificarErrorEvaluar({ code: '55000', message: 'La sesión todavía no se ha cerrado.' })).toMatchObject({ kind: 'retry', servidor: true });
    expect(clasificarErrorEvaluar({ code: '55000', message: 'El atleta abc no asistió a esta sesión.' })).toMatchObject({ kind: 'retry' });
  });
  it('informe ya publicado, no eres coach, sesión inexistente, dato inválido = regla (se muestra el motivo)', () => {
    expect(clasificarErrorEvaluar({ code: '55000', message: 'El informe de este periodo ya fue publicado para x.' }).kind).toBe('rule');
    expect(clasificarErrorEvaluar({ code: '42501', message: 'No autorizado' }).kind).toBe('rule');
    expect(clasificarErrorEvaluar({ code: 'P0002', message: 'Sesión no encontrada.' }).kind).toBe('rule');
    expect(clasificarErrorEvaluar({ code: '22023', message: 'effort_pct fuera de rango' }).kind).toBe('rule');
  });
  it('JWT vencido o 401 = sesión, no regla', () => {
    expect(clasificarErrorEvaluar({ code: 'PGRST301', message: 'JWT expired' }).kind).toBe('auth');
    expect(clasificarErrorEvaluar({ status: 401, message: 'x' }).kind).toBe('auth');
  });
  it('error desconocido del servidor se reintenta', () => {
    expect(clasificarErrorEvaluar({ code: '57014', message: 'timeout' })).toMatchObject({ kind: 'retry', servidor: true });
  });
});

describe('pendientesModel', () => {
  const lista = (extra: object = {}) => ({ key: 'k', schoolId: 's', payload: { date: '2026-11-24', records: [] }, etiqueta: 'Sub 9', created_at: 1, updated_at: 1, version: 1, attempts: 0, nextAttemptAt: 0, holdUntil: 0, ...extra });
  const accion = (extra: object = {}) => ({ id: 'evaluar:a', tipo: 'evaluar', userId: 'u', schoolId: 's', payload: {}, etiqueta: 'Sub 11', created_at: 2, updated_at: 2, version: 1, rev: 'r', intentos: 0, nextAttemptAt: 0, ...extra });

  it('une listas y acciones; lo que tiene problema va primero', () => {
    const v = armarPendientes([lista()], [accion({ error: 'No' })]);
    expect(v.map((x) => [x.origen, x.estado])).toEqual([['bandeja', 'rechazada'], ['asistencia', 'pendiente']]);
    expect(v[0].clase).toBe('Evaluación');
  });
  it('banda: nada = null; sin señal; con señal; con problema', () => {
    expect(resumenBanda([], true).texto).toBeNull();
    const una = armarPendientes([lista()], []);
    expect(resumenBanda(una, false).texto).toBe('Sin señal · 1 pendiente');
    expect(resumenBanda(armarPendientes([lista(), lista({ key: 'k2' })], []), true).texto).toBe('Enviando 2 pendientes…');
    const mal = armarPendientes([lista({ error: 'x', atascada: true })], [accion({ error: 'y' })]);
    expect(resumenBanda(mal, true)).toMatchObject({ tono: 'alerta', conProblema: 2 });
    expect(resumenBanda(mal, true).texto).toBe('2 con problema · toca para ver');
  });
});
