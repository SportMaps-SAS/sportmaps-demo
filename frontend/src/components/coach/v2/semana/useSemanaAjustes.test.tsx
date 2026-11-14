/**
 * Datos de «Mi semana»: tolera la base sin la migración, reintenta sin `motivo`,
 * no da por guardado lo que la RLS no dejó y avisa al BFF para sincronizar cupos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

type Res = { data: unknown; error: { code?: string; message?: string } | null; status?: number };
const st = vi.hoisted(() => ({
  tablas: {} as Record<string, (op: { metodo: string; payload?: unknown }) => Res>,
  rpcs: {} as Record<string, (args: Record<string, unknown>) => Res>,
  escrituras: [] as { tabla: string; metodo: string; payload?: unknown }[],
  post: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabla: string) => {
    const op: { metodo: string; payload?: unknown } = { metodo: 'select' };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'maybeSingle']) b[m] = () => b;
    for (const m of ['insert', 'update', 'delete']) {
      b[m] = (payload?: unknown) => { op.metodo = m; op.payload = payload; st.escrituras.push({ tabla, metodo: m, payload }); return b; };
    }
    b.then = (ok: (r: Res) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve((st.tablas[tabla] ?? (() => ({ data: [], error: null })))(op)).then(ok, ko);
    return b;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (fn: string, args: Record<string, unknown>) =>
        Promise.resolve((st.rpcs[fn] ?? (() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 })))(args)),
    },
  };
});
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { post: st.post } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-coach' } }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: 's-monster' }) }));

import { useSemanaAjustes, _olvidarColumnaMotivo } from './useSemanaAjustes';

const LUNES = '2026-10-26';
const envoltorio = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const usar = (teamIds = ['t-inf']) => renderHook(() => useSemanaAjustes({ teamIds, lunes: LUNES }), { wrapper: envoltorio() });

beforeEach(() => {
  st.tablas = {};
  st.rpcs = {};
  st.escrituras = [];
  st.post.mockReset().mockResolvedValue({});
  _olvidarColumnaMotivo();
});

describe('useSemanaAjustes', () => {
  it('sin la tabla (migración sin aplicar): no disponible, sin errores', async () => {
    st.tablas.team_schedule_exceptions = () => ({ data: null, error: { code: '42P01', message: 'relation "team_schedule_exceptions" does not exist' } });
    const { result } = usar();
    await waitFor(() => expect(result.current.clasesDisponibles).toBe(false));
    await waitFor(() => expect(result.current.disponible).toBe(false));
    expect(result.current.ajustes).toEqual([]);
    expect(result.current.clases).toEqual([]);
  });

  it('con la tabla: lee los ajustes y planea «repetir» con la semana anterior', async () => {
    st.tablas.team_schedule_exceptions = () => ({
      data: [{ id: 'a1', team_id: 't-inf', fecha: '2026-10-24', tipo: 'cancelada', hora_original: '08:00:00', hora_inicio: null, hora_fin: null, lugar: null }],
      error: null,
    });
    const { result } = usar();
    await waitFor(() => expect(result.current.disponible).toBe(true));
    expect(result.current.ajustes).toHaveLength(1);
    expect(result.current.repetirPlan.total).toBe(1);
  });

  it('las clases de prueba se quedan con las de MIS equipos', async () => {
    st.rpcs.clases_prueba_semana = () => ({
      data: [
        { lead_id: 'l1', nombre: 'Mariana', fecha: '2026-10-31', team_id: 't-inf' },
        { lead_id: 'l2', nombre: 'Otro', fecha: '2026-10-31', team_id: 't-otro' },
      ],
      error: null,
    });
    const { result } = usar();
    await waitFor(() => expect(result.current.clasesDisponibles).toBe(true));
    expect(result.current.clases.map((c) => c.leadId)).toEqual(['l1']);
  });

  it('cancelar inserta la fila con creado_por y school_id, y avisa al BFF para sincronizar cupos', async () => {
    st.tablas.team_schedule_exceptions = (op) => (op.metodo === 'insert' ? { data: [{ id: 'n1' }], error: null } : { data: [], error: null });
    const { result } = usar();
    await waitFor(() => expect(result.current.disponible).toBe(true));
    let r: unknown;
    await act(async () => { r = await result.current.aplicar({ tipo: 'cancelar', teamId: 't-inf', fecha: '2026-10-31', horaOriginal: '08:00', motivo: 'lluvia' }); });
    expect(r).toEqual({ ok: true });
    expect(st.escrituras[0]).toMatchObject({ metodo: 'insert', payload: { school_id: 's-monster', team_id: 't-inf', creado_por: 'u-coach', tipo: 'cancelada', motivo: 'lluvia' } });
    expect(st.post).toHaveBeenCalledWith('/api/v1/whatsapp/s-monster/cortesias/sincronizar-franjas', { teamId: 't-inf' });
  });

  it('si la base no tiene la columna motivo, guarda igual sin ella', async () => {
    let intentos = 0;
    st.tablas.team_schedule_exceptions = (op) => {
      if (op.metodo !== 'insert') return { data: [], error: null };
      intentos += 1;
      return (op.payload as Record<string, unknown>).motivo
        ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'motivo' column of 'team_schedule_exceptions' in the schema cache" } }
        : { data: [{ id: 'n1' }], error: null };
    };
    const { result } = usar();
    await waitFor(() => expect(result.current.disponible).toBe(true));
    let r: unknown;
    await act(async () => { r = await result.current.aplicar({ tipo: 'cancelar', teamId: 't-inf', fecha: '2026-10-31', horaOriginal: '08:00', motivo: 'lluvia' }); });
    expect(r).toEqual({ ok: true });
    expect(intentos).toBe(2);
    expect(st.escrituras[1].payload).not.toHaveProperty('motivo');
    // Ya sabe que la columna no está: la siguiente cancelación no falla primero.
    await act(async () => { r = await result.current.aplicar({ tipo: 'cancelar', teamId: 't-inf', fecha: '2026-11-01', horaOriginal: '08:00', motivo: 'lluvia' }); });
    expect(r).toEqual({ ok: true });
    expect(intentos).toBe(3);
  });

  it('un DELETE que la RLS no deja (0 filas) NO se da por hecho, y no se sincroniza', async () => {
    st.tablas.team_schedule_exceptions = () => ({ data: [], error: null });
    const { result } = usar();
    await waitFor(() => expect(result.current.disponible).toBe(true));
    let r: unknown;
    await act(async () => { r = await result.current.aplicar({ tipo: 'deshacer', teamId: 't-inf', ajusteIds: ['a1'] }); });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/permiso/) });
    expect(st.post).not.toHaveBeenCalled();
  });

  it('valida antes de escribir', async () => {
    const { result } = usar();
    let r: unknown;
    await act(async () => { r = await result.current.aplicar({ tipo: 'extra', teamId: 't-inf', fecha: '2026-10-31', horaInicio: '10:00', horaFin: '09:00', lugar: null }); });
    expect(r).toEqual({ ok: false, error: 'La hora de fin tiene que ser después de la de inicio.' });
    expect(st.escrituras).toEqual([]);
  });

  it('repetir: una RPC por equipo con ajustes la semana pasada, y suma lo copiado', async () => {
    st.tablas.team_schedule_exceptions = () => ({
      data: [
        { id: 'a1', team_id: 't-inf', fecha: '2026-10-24', tipo: 'cancelada', hora_original: '08:00' },
        { id: 'a2', team_id: 't-u17', fecha: '2026-10-25', tipo: 'extra', hora_inicio: '11:00' },
      ],
      error: null,
    });
    const llamadas: Record<string, unknown>[] = [];
    st.rpcs.repetir_semana_equipo = (args) => { llamadas.push(args); return { data: { copiadas: 1 }, error: null }; };
    const { result } = usar(['t-inf', 't-u17']);
    await waitFor(() => expect(result.current.repetirPlan.total).toBe(2));
    let r: unknown;
    await act(async () => { r = await result.current.repetir(); });
    expect(r).toEqual({ ok: true, copiadas: 2 });
    expect(llamadas).toEqual([{ p_team_id: 't-inf', p_lunes: LUNES }, { p_team_id: 't-u17', p_lunes: LUNES }]);
    expect(st.post).toHaveBeenCalledTimes(2);
  });

  it('marcar un cupo separado: la RPC dice SIN_CLASE_AGENDADA y sale en palabras', async () => {
    st.rpcs.marcar_clase_prueba_entrenador = () => ({ data: null, error: { code: '22023', message: 'SIN_CLASE_AGENDADA' } });
    const { result } = usar();
    let r: unknown;
    await act(async () => { r = await result.current.marcar({ leadId: 'l1', asistencia: 'asistio' }); });
    expect(r).toEqual({ ok: false, error: 'La clase todavía no está confirmada (falta el pago).' });
  });

  it('marcar sin la RPC: dice que todavía no está activo', async () => {
    const { result } = usar();
    let r: unknown;
    await act(async () => { r = await result.current.marcar({ leadId: 'l1', asistencia: 'asistio' }); });
    expect(r).toEqual({ ok: false, error: 'Esta opción todavía no está activa.' });
  });
});
