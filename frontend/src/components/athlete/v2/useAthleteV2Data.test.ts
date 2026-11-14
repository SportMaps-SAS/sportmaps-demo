/**
 * Lecturas del Deportista V2 con ficha vinculada (A2) y sin cobros de hijos (M6).
 * Supabase va simulado: se registra cada filtro que se arma y se devuelven filas fijas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const s = vi.hoisted(() => ({
  llamadas: [] as { tabla: string; ops: [string, unknown[]][] }[],
  filas: {} as Record<string, unknown[]>,
  rpc: vi.fn(),
  kudos: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabla: string) => {
    const reg = { tabla, ops: [] as [string, unknown[]][] };
    s.llamadas.push(reg);
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'or', 'is', 'eq', 'in', 'gte', 'not', 'order', 'limit']) {
      b[op] = (...args: unknown[]) => { reg.ops.push([op, args]); return b; };
    }
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: s.filas[tabla] ?? [], error: null }).then(ok);
    return b;
  };
  return { supabase: { from: builder, rpc: s.rpc } };
});
vi.mock('@/lib/api/v2Contratos', () => ({
  listarFelicitaciones: s.kudos,
  misConvocatorias: vi.fn(),
  misInformesDeportista: vi.fn(),
  responderConvocatoria: vi.fn(),
  sujetoDesde: vi.fn(),
}));

import {
  cargarAsistencia, cargarAutoevalPendiente, cargarEquipos, cargarFelicitaciones, cargarFichas, enviarRpeRapido,
  filtroDeportista, formularioAutoeval, useAthleteAttendance, useAthleteTeams, useMyKudos,
} from './useAthleteV2Data';

const YO = '11111111-1111-4111-8111-111111111111';
const FICHA = '22222222-2222-4222-8222-222222222222';
const FICHA2 = '33333333-3333-4333-8333-333333333333';

const ops = (tabla: string) => s.llamadas.find((l) => l.tabla === tabla)?.ops ?? [];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  s.llamadas = [];
  s.filas = {};
  s.rpc.mockReset();
  s.kudos.mockReset();
});

describe('filtro del deportista: cuenta + fichas vinculadas', () => {
  it('sin fichas, solo user_id; con fichas, suma unregistered_athlete_id', () => {
    expect(filtroDeportista(YO)).toBe(`user_id.eq.${YO}`);
    expect(filtroDeportista(YO, [FICHA, FICHA2])).toBe(`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA},${FICHA2})`);
  });
  it('descarta ids que no son uuid (no se cuelan en el .or())', () => {
    expect(filtroDeportista(YO, ['x),user_id.neq.(0'])).toBe(`user_id.eq.${YO}`);
  });
  it('my_linked_unregistered_ids: si falla o no existe, sigue sin fichas', async () => {
    s.rpc.mockResolvedValueOnce({ data: [FICHA, 'basura'], error: null });
    expect(await cargarFichas()).toEqual([FICHA]);
    s.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await cargarFichas()).toEqual([]);
    warn.mockRestore();
  });
});

describe('equipos (A2 + M6)', () => {
  it('lee por la cuenta y la ficha, y excluye inscripciones de sus hijos (child_id IS NULL)', async () => {
    s.filas.enrollments = [{
      school_id: 'sc', schools: { name: 'Monster Volley' },
      teams: { id: 't1', name: 'Sub 17', sport: 'voleibol', location: 'Coliseo', schedule: [], coach: { full_name: 'Andrés Gil' } },
    }];
    const eq = await cargarEquipos(YO, [FICHA]);
    expect(eq.map((e) => e.nombre)).toEqual(['Sub 17']);
    expect(ops('enrollments')).toContainEqual(['or', [`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA})`]]);
    expect(ops('enrollments')).toContainEqual(['is', ['child_id', null]]);
    expect(ops('enrollments').some(([op, a]) => op === 'eq' && a[0] === 'user_id')).toBe(false);
  });

  it('el hook pide las fichas UNA vez y las reutiliza en equipos, asistencia y felicitaciones', async () => {
    s.rpc.mockResolvedValue({ data: [FICHA], error: null });
    s.kudos.mockResolvedValue({ data: [], error: null, noDisponible: false });
    const w = wrapper();
    const a = renderHook(() => ({ t: useAthleteTeams(YO), at: useAthleteAttendance(YO), k: useMyKudos(YO) }), { wrapper: w });
    await waitFor(() => expect(a.result.current.t.isSuccess && a.result.current.at.isSuccess && a.result.current.k.isSuccess).toBe(true));
    expect(s.rpc).toHaveBeenCalledTimes(1);
    expect(s.rpc).toHaveBeenCalledWith('my_linked_unregistered_ids');
    expect(ops('enrollments')).toContainEqual(['or', [`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA})`]]);
    expect(ops('attendance_records')).toContainEqual(['or', [`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA})`]]);
    expect(s.kudos).toHaveBeenCalledWith({ unregisteredAthleteId: FICHA }, 20);
  });
});

describe('asistencia y racha de la ficha vinculada (A2)', () => {
  it('trae los registros de la ficha y sin los de sus hijos', async () => {
    s.filas.attendance_records = [
      { attendance_date: '2026-10-23', status: 'present' },
      { attendance_date: '2026-10-21', status: 'late' },
    ];
    const r = await cargarAsistencia(YO, [FICHA]);
    expect(r).toHaveLength(2);
    expect(ops('attendance_records')).toContainEqual(['or', [`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA})`]]);
    expect(ops('attendance_records')).toContainEqual(['is', ['child_id', null]]);
  });
});

describe('felicitaciones de la cuenta y de la ficha (A2)', () => {
  it('une las de la cuenta y las de cada ficha, sin repetidas y de la más nueva a la más vieja', async () => {
    s.kudos.mockImplementation(async (sujeto: { athleteUserId?: string; unregisteredAthleteId?: string }) => {
      if (sujeto.athleteUserId) return { data: [{ id: 'k1', message: 'Bien', coach_name: 'Andrés', created_at: '2026-10-01T10:00:00Z' }], error: null, noDisponible: false };
      return {
        data: [
          { id: 'k2', message: 'Gran recepción', coach_name: 'Andrés', created_at: '2026-10-20T10:00:00Z' },
          { id: 'k1', message: 'Bien', coach_name: 'Andrés', created_at: '2026-10-01T10:00:00Z' },
        ],
        error: null, noDisponible: false,
      };
    });
    const r = await cargarFelicitaciones(YO, [FICHA], 20);
    expect(r.oculto).toBe(false);
    expect(r.data.map((k) => k.id)).toEqual(['k2', 'k1']);
    expect(s.kudos).toHaveBeenCalledWith({ athleteUserId: YO }, 20);
    expect(s.kudos).toHaveBeenCalledWith({ unregisteredAthleteId: FICHA }, 20);
  });

  it('respeta el límite (la de Hoy pide 1) y la más nueva puede venir de la ficha', async () => {
    s.kudos.mockImplementation(async (sujeto: { athleteUserId?: string }) => ({
      data: sujeto.athleteUserId
        ? [{ id: 'a', message: 'Vieja', coach_name: 'X', created_at: '2026-09-01T00:00:00Z' }]
        : [{ id: 'b', message: 'Nueva', coach_name: 'X', created_at: '2026-10-24T00:00:00Z' }],
      error: null, noDisponible: false,
    }));
    const r = await cargarFelicitaciones(YO, [FICHA], 1);
    expect(r.data.map((k) => k.mensaje)).toEqual(['Nueva']);
  });

  it('si falla solo la ficha, muestra las de la cuenta; si la RPC no existe, se oculta', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.kudos.mockImplementation(async (sujeto: { athleteUserId?: string }) => (sujeto.athleteUserId
      ? { data: [{ id: 'a', message: 'Hola', coach_name: 'X', created_at: '2026-10-01T00:00:00Z' }], error: null, noDisponible: false }
      : { data: null, error: 'Algo salió mal. Intenta de nuevo.', noDisponible: false }));
    expect((await cargarFelicitaciones(YO, [FICHA])).data.map((k) => k.id)).toEqual(['a']);
    s.kudos.mockResolvedValue({ data: null, error: null, noDisponible: true });
    expect(await cargarFelicitaciones(YO, [FICHA])).toEqual({ oculto: true, data: [] });
    warn.mockRestore();
  });
});

describe('«¿Qué tan duro fue?» de la ficha vinculada', () => {
  const AHORA = new Date('2026-10-26T15:00:00Z');
  const sesion = (id: string) => ({
    id, session_date: '2026-10-26', finalized: true, finalized_at: '2026-10-26T12:00:00Z',
    teams: { name: 'Sub 17' }, schools: { category_id: 'cat' },
  });

  it('lista las sesiones de la cuenta y de la ficha; la de la ficha se responde por la ficha', async () => {
    s.filas.attendance_records = [{ session_id: 's-ficha', attendance_date: '2026-10-26', user_id: null, unregistered_athlete_id: FICHA }];
    s.filas.attendance_sessions = [sesion('s-ficha')];
    s.filas.sport_metric_definitions = [{ metric_key: 'rpe_borg' }];
    const p = await cargarAutoevalPendiente(YO, AHORA, [FICHA]);
    expect(p).toMatchObject({ sessionId: 's-ficha', fichaId: FICHA, requeridas: ['rpe_borg'] });
    expect(ops('attendance_records')).toContainEqual(['or', [`user_id.eq.${YO},unregistered_athlete_id.in.(${FICHA})`]]);
    expect(ops('attendance_records')).toContainEqual(['is', ['child_id', null]]);
    // ¿Ya respondió? Se pregunta por la ficha, no por la cuenta.
    expect(ops('performance_entries')).toContainEqual(['eq', ['subject_type', 'unregistered']]);
    expect(ops('performance_entries')).toContainEqual(['eq', ['subject_id', FICHA]]);
  });

  it('si la sesión está a nombre de la cuenta, manda la cuenta (sin ficha)', async () => {
    s.filas.attendance_records = [
      { session_id: 's1', attendance_date: '2026-10-26', user_id: YO, unregistered_athlete_id: null },
      { session_id: 's1', attendance_date: '2026-10-26', user_id: null, unregistered_athlete_id: FICHA },
    ];
    s.filas.attendance_sessions = [sesion('s1')];
    const p = await cargarAutoevalPendiente(YO, AHORA, [FICHA]);
    expect(p).toMatchObject({ sessionId: 's1', fichaId: null });
    expect(ops('performance_entries')).toContainEqual(['eq', ['subject_type', 'profile']]);
  });

  it('la sesión que cerró el automático de las 23:55 sigue en plazo al día siguiente', async () => {
    // finalized_at = hora del entreno (hace 2 días); updated_at = cierre real anoche.
    s.filas.attendance_records = [{ session_id: 's-auto', attendance_date: '2026-10-24', user_id: YO, unregistered_athlete_id: null }];
    s.filas.attendance_sessions = [{
      ...sesion('s-auto'), session_date: '2026-10-24',
      finalized_at: '2026-10-25T04:59:00Z', updated_at: '2026-10-26T04:55:00Z',
    }];
    expect(await cargarAutoevalPendiente(YO, AHORA, [])).toMatchObject({ sessionId: 's-auto' });
    // Pasado el día siguiente, ya no.
    expect(await cargarAutoevalPendiente(YO, new Date('2026-10-27T05:00:00Z'), [])).toBeNull();
  });

  it('una ficha que no es suya no genera tarjeta', async () => {
    s.filas.attendance_records = [{ session_id: 's2', attendance_date: '2026-10-26', user_id: null, unregistered_athlete_id: FICHA2 }];
    s.filas.attendance_sessions = [sesion('s2')];
    expect(await cargarAutoevalPendiente(YO, AHORA, [FICHA])).toBeNull();
  });

  it('envía p_unregistered_athlete_id por la ficha y el formulario lleva ?ficha=', async () => {
    s.rpc.mockResolvedValue({ data: { saved: 1 }, error: null });
    await enviarRpeRapido('s-ficha', YO, 5, FICHA);
    expect(s.rpc).toHaveBeenCalledWith('submit_post_training_self_eval', {
      p_session_id: 's-ficha', p_child_id: null, p_user_id: null, p_answers: { rpe_borg: 5 }, p_unregistered_athlete_id: FICHA,
    });
    await enviarRpeRapido('s1', YO, 3);
    expect(s.rpc).toHaveBeenLastCalledWith('submit_post_training_self_eval', {
      p_session_id: 's1', p_child_id: null, p_user_id: YO, p_answers: { rpe_borg: 3 },
    });
    expect(formularioAutoeval({ sessionId: 's-ficha', fichaId: FICHA })).toBe(`/post-entreno/s-ficha?ficha=${FICHA}`);
    expect(formularioAutoeval({ sessionId: 's1', fichaId: null })).toBe('/post-entreno/s1');
  });
});
