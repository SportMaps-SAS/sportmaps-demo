import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

import { Bandeja, type AlmacenBandeja } from './bandeja';
import {
  clasificarErrorAutoeval, enviarAutoeval, fusionarAutoeval, idAutoeval, mensajeErrorAutoeval, paramsAutoeval,
  TIPO_AUTOEVAL, type PayloadAutoeval,
} from './bandejaAutoeval';
import { faltoLaSenal } from './autoevalOffline';

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

const quien = { tipo: 'profile', id: 'u1' } as const;
const datos = (answers: Record<string, unknown> = { rpe_borg: 7 }, sujeto: PayloadAutoeval['sujeto'] = quien): PayloadAutoeval => ({ sessionId: 's1', sujeto, answers });
const entrada = (p: PayloadAutoeval) => ({ id: idAutoeval(p.sessionId, p.sujeto), tipo: TIPO_AUTOEVAL, schoolId: null, payload: p, etiqueta: '¿Qué tan duro fue? · Sub 11' });

function bandeja(almacen = almacenEnMemoria(), userId = 'u1') {
  return new Bandeja({ userId, manejadores: { [TIPO_AUTOEVAL]: enviarAutoeval }, almacen, now: () => 1_000_000, candado: null, canal: null });
}

beforeEach(() => {
  rpc.mockReset();
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
});

describe('autoevaluación — parámetros de la RPC', () => {
  it('cada sujeto manda exactamente lo que mandaban las pantallas', () => {
    expect(paramsAutoeval(datos({ rpe_borg: 6 }, { tipo: 'profile', id: 'u1' }))).toEqual({
      p_session_id: 's1', p_answers: { rpe_borg: 6 }, p_child_id: null, p_user_id: 'u1',
    });
    expect(paramsAutoeval(datos({ rpe_borg: 6 }, { tipo: 'child', id: 'h1' }))).toEqual({
      p_session_id: 's1', p_answers: { rpe_borg: 6 }, p_child_id: 'h1', p_user_id: null,
    });
    expect(paramsAutoeval(datos({ rpe_borg: 6 }, { tipo: 'unregistered', id: 'f1' }))).toEqual({
      p_session_id: 's1', p_answers: { rpe_borg: 6 }, p_child_id: null, p_user_id: null, p_unregistered_athlete_id: 'f1',
    });
  });

  it('la identidad es sesión + sujeto: dos hijos del mismo acudiente no se pisan', () => {
    expect(idAutoeval('s1', { tipo: 'child', id: 'h1' })).not.toBe(idAutoeval('s1', { tipo: 'child', id: 'h2' }));
    expect(idAutoeval('s1', quien)).toBe(idAutoeval('s1', quien));
  });
});

describe('autoevaluación — clasificación de errores', () => {
  it('sin código y con texto de red es falta de señal', () => {
    expect(clasificarErrorAutoeval({ message: 'TypeError: Failed to fetch' })).toEqual({ kind: 'retry', message: 'Sin señal' });
    expect(clasificarErrorAutoeval({ message: '' })).toEqual({ kind: 'retry', message: 'Sin señal' });
  });

  it('plazo vencido, no asistió, sin permiso, sesión inexistente y valor inválido son de regla, con su motivo', () => {
    const plazo = clasificarErrorAutoeval({ code: '55000', message: 'Ya se cerró el plazo para responder: era hasta el día siguiente al entreno.' });
    expect(plazo).toEqual({ kind: 'rule', message: 'Ya se cerró el plazo para responder este entreno.' });
    expect(clasificarErrorAutoeval({ code: '55000', message: 'El atleta no asistió a esta sesión.' })).toMatchObject({ kind: 'rule', message: 'Este entreno no figura como asistido.' });
    expect(clasificarErrorAutoeval({ code: '42501', message: 'No autorizado' })).toMatchObject({ kind: 'rule' });
    expect(clasificarErrorAutoeval({ code: 'P0002', message: 'Sesión no encontrada.' })).toMatchObject({ kind: 'rule' });
    expect(clasificarErrorAutoeval({ code: '22023', message: 'Falta responder: rpe_borg.' })).toMatchObject({ kind: 'rule' });
  });

  it('«la sesión todavía no se ha cerrado» se reintenta contando como fallo de servidor (queda atascada si no llega)', () => {
    expect(clasificarErrorAutoeval({ code: '55000', message: 'La sesión todavía no se ha cerrado.' })).toEqual({
      kind: 'retry', message: 'El entrenador todavía no cierra la lista de este entreno.', servidor: true,
    });
  });

  it('401 o JWT vencido es de sesión; 5xx y desconocidos se reintentan', () => {
    expect(clasificarErrorAutoeval({ status: 401, message: 'x' }).kind).toBe('auth');
    expect(clasificarErrorAutoeval({ code: 'PGRST301', message: 'JWT expired' }).kind).toBe('auth');
    expect(clasificarErrorAutoeval({ status: 503, message: 'upstream' })).toMatchObject({ kind: 'retry', servidor: true });
    expect(mensajeErrorAutoeval({ code: 'XX000', message: 'boom' })).toBe('Inténtalo de nuevo en un momento.');
  });

  it('faltoLaSenal: sin red del navegador o error de red; un rechazo de regla NO se guarda en el teléfono', () => {
    expect(faltoLaSenal(new TypeError('Failed to fetch'))).toBe(true);
    expect(faltoLaSenal({ code: '55000', message: 'Ya se cerró el plazo' })).toBe(false);
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    expect(faltoLaSenal({ code: '55000', message: 'lo que sea' })).toBe(true);
  });
});

describe('autoevaluación — fusión al guardar de nuevo', () => {
  it('lo nuevo pisa clave por clave y lo que ya estaba se conserva', () => {
    const previo = datos({ rpe_borg: 5, task_comprehension: 4, focus: ['focus_a'] });
    const nuevo = datos({ rpe_borg: 8 });
    expect(fusionarAutoeval(previo, nuevo).answers).toEqual({ rpe_borg: 8, task_comprehension: 4, focus: ['focus_a'] });
    expect(fusionarAutoeval(undefined, nuevo)).toBe(nuevo);
  });

  it('el «un toque» no borra el formulario completo ya guardado; sin fusionar gana lo último (formulario completo)', async () => {
    const b = bandeja();
    await b.encolar(entrada(datos({ rpe_borg: 5, task_comprehension: 4 })));
    await b.encolar(entrada(datos({ rpe_borg: 9 })), fusionarAutoeval);
    expect(b.size).toBe(1);
    expect((b.todas()[0].payload as PayloadAutoeval).answers).toEqual({ rpe_borg: 9, task_comprehension: 4 });
    await b.encolar(entrada(datos({ rpe_borg: 3 })));
    expect((b.todas()[0].payload as PayloadAutoeval).answers).toEqual({ rpe_borg: 3 });
    expect(b.todas()[0].version).toBe(3);
  });
});

describe('autoevaluación — envío por la bandeja', () => {
  it('sube una sola vez con los parámetros del sujeto y se borra del teléfono', async () => {
    rpc.mockResolvedValue({ data: { saved: 1, streak: 2, month_avg_borg: 6 }, error: null });
    const almacen = almacenEnMemoria();
    const b = bandeja(almacen);
    await b.encolar(entrada(datos({ rpe_borg: 7 }, { tipo: 'child', id: 'h1' })));
    const [e1, e2] = await Promise.all([b.flush(true), b.flush(true)]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('submit_post_training_self_eval', { p_session_id: 's1', p_answers: { rpe_borg: 7 }, p_child_id: 'h1', p_user_id: null });
    expect([...e1, ...e2].map((e) => e.type)).toContain('sent');
    expect(almacen.datos.size).toBe(0);
  });

  it('plazo vencido: queda visible con su motivo y no se reintenta solo', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'Ya se cerró el plazo para responder: era hasta el día siguiente al entreno.' } });
    const b = bandeja();
    await b.encolar(entrada(datos()));
    const ev = await b.flush(true);
    expect(ev[0]).toMatchObject({ type: 'rule_error', message: 'Ya se cerró el plazo para responder este entreno.' });
    expect(b.conProblema()).toHaveLength(1);
    await b.flush(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('sin señal: no llama a la red y la acción sigue guardada', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    const b = bandeja();
    await b.encolar(entrada(datos()));
    await b.flush(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(b.pendientes()).toHaveLength(1);
  });

  it('la red se cae durante el envío (la llamada lanza): se reintenta, no se pierde', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const b = bandeja();
    await b.encolar(entrada(datos()));
    const ev = await b.flush(true);
    expect(ev[0]).toMatchObject({ type: 'retry', message: 'Sin señal' });
    expect(b.pendientes()).toHaveLength(1);
  });

  it('sesión vencida con señal: se espera y se reintenta; sin señal el «sin sesión» es solo falta de señal', async () => {
    rpc.mockResolvedValue({ data: null, error: { status: 401, message: 'JWT expired' } });
    const b = bandeja();
    await b.encolar(entrada(datos()));
    const ev = await b.flush(true);
    expect(ev[0].type).toBe('auth_error');
    expect(b.pendientes()).toHaveLength(1);

    const b2 = bandeja(almacenEnMemoria(), 'u2');
    await b2.encolar(entrada(datos()));
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    expect((await b2.flush(true)).map((e) => e.type)).not.toContain('auth_error');
  });

  it('otra cuenta en el mismo teléfono no ve ni envía la respuesta ajena', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    const almacen = almacenEnMemoria();
    const a = bandeja(almacen, 'madre');
    await a.encolar(entrada(datos({ rpe_borg: 7 }, { tipo: 'child', id: 'h1' })));
    const otra = bandeja(almacen, 'otro');
    await otra.cargar();
    expect(otra.size).toBe(0);
    await otra.flush(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('dos pestañas leyendo el mismo almacén envían una sola vez gracias al candado', async () => {
    rpc.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 10)); return { data: {}, error: null }; });
    const almacen = almacenEnMemoria();
    let ocupado = false;
    const candado = { con: async <T,>(fn: (r: () => void) => Promise<T>) => { if (ocupado) return null; ocupado = true; try { return await fn(() => undefined); } finally { ocupado = false; } } };
    const nueva = () => new Bandeja({ userId: 'u1', manejadores: { [TIPO_AUTOEVAL]: enviarAutoeval }, almacen, now: () => 1_000_000, candado, canal: null });
    const t1 = nueva();
    const t2 = nueva();
    await t1.encolar(entrada(datos()));
    await t2.cargar();
    await Promise.all([t1.flush(true), t2.flush(true)]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('autoevaluación — acción de otro tipo no se toca', () => {
  it('un tipo desconocido en la bandeja se conserva', async () => {
    const b = bandeja();
    await b.encolar({ id: 'raro:1', tipo: 'otra-cosa', schoolId: null, payload: {}, etiqueta: 'x' });
    await b.flush(true);
    expect(b.size).toBe(1);
  });
});
