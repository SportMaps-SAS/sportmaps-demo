/**
 * Pestaña Semana de Sesiones V2 con «Mi semana»:
 *  · sin la migración, la semana se ve como siempre (sin botones nuevos);
 *  · con la migración, cada entreno del horario tiene su «⋯», el cancelado sale
 *    tachado con su motivo y la clase de prueba aparece en su día;
 *  · `?tab=semana&fecha=` (link del aviso al profe) abre la Semana de ese día.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Res = { data: unknown; error: { code?: string; message?: string } | null; status?: number };
const st = vi.hoisted(() => ({
  tablas: {} as Record<string, () => Res>,
  rpcs: {} as Record<string, () => Res>,
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabla: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'insert', 'update', 'delete']) b[m] = () => b;
    b.then = (ok: (r: Res) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve((st.tablas[tabla] ?? (() => ({ data: [], error: null })))()).then(ok, ko);
    return b;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (fn: string) => Promise.resolve((st.rpcs[fn] ?? (() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 })))()),
    },
  };
});
vi.mock('@/lib/api/bffClient', () => ({ bffClient: { post: vi.fn().mockResolvedValue({}), get: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-coach' } }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: 's-monster', currentUserRole: 'coach' }) }));
vi.mock('@/lib/coachTeamScope', () => ({ fetchCoachTeams: vi.fn().mockResolvedValue({ teamIds: ['t-inf'] }), isSchoolAdminRole: () => false }));
vi.mock('../useAsistenciaV2Data', () => ({ registrosPorEquipoYDia: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('@/lib/dateUtils', async (orig) => ({ ...(await orig<typeof import('@/lib/dateUtils')>()), todayColombia: () => '2026-10-28' }));
vi.mock('@/components/school/TacticalBoard', () => ({ TacticalBoard: () => null }));
vi.mock('@/components/school/SessionViewer', () => ({ SessionViewer: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import CoachSessionsV2 from '../CoachSessionsV2';

const EQUIPO = {
  id: 't-inf', name: 'Infantil F', sport: 'volleyball', sport_modality: null, age_group: null,
  schedule: [{ day: 6, time: '08:00', end: '10:00', place: 'Pinar 2' }, { day: 0, time: '08:00', end: '10:00', place: 'Pinar 2' }],
};

const pintar = (ruta = '/training-plans?tab=semana') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[ruta]}><CoachSessionsV2 rutaPlanificacion="/training-plans/planificar" /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  st.tablas = { teams: () => ({ data: [EQUIPO], error: null }) };
  st.rpcs = {};
});

describe('Semana del profe', () => {
  it('sin la migración: la semana de siempre, sin «⋯» ni «Entreno extra»', async () => {
    st.tablas.team_schedule_exceptions = () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    pintar();
    const dias = await screen.findAllByTestId('dia-semana');
    expect(dias).toHaveLength(7);
    // Sábado 31: entreno del horario sin plan, como antes.
    expect(within(dias[5]).getByText('Entreno 8:00 a. m. · sin plan')).toBeInTheDocument();
    expect(screen.queryByTestId('entreno-ajustable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entreno-extra')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clases-prueba-dia')).not.toBeInTheDocument();
  });

  it('con la migración: «⋯» por entreno, el domingo cancelado por lluvia y la clase de prueba del sábado', async () => {
    st.tablas.team_schedule_exceptions = () => ({
      data: [{ id: 'c1', team_id: 't-inf', fecha: '2026-11-01', tipo: 'cancelada', hora_original: '08:00:00', hora_inicio: null, hora_fin: null, lugar: null, motivo: 'lluvia' }],
      error: null,
    });
    st.rpcs.clases_prueba_semana = () => ({
      // Forma exacta de clases_prueba_semana (mig. 20261030123543).
      data: [{ lead_id: 'l1', nombre: 'Mariana Gómez', anio: 2011, sexo: 'female', respuestas: { posicion: 'Punta' },
        estado_cupo: 'agendada', separado_hasta: null,
        franja: { id: 's1', fecha: '2026-10-31', hora_inicio: '08:00:00', hora_fin: '10:00:00', etiqueta: 'Infantil F', lugar: 'Pinar 2' },
        equipo: { id: 't-inf', nombre: 'Infantil F' }, equipo_recomendado: null, pago: { estado: 'paid' }, asistencia: null, etapa: 'agendado' }],
      error: null,
    });
    pintar();
    const chips = await screen.findAllByTestId('entreno-ajustable');
    expect(chips).toHaveLength(2);
    expect(screen.getByTestId('entreno-extra')).toBeInTheDocument();
    const dias = screen.getAllByTestId('dia-semana');
    // Domingo: ya no es «sin plan», es «cancelado por lluvia».
    expect(within(dias[6]).getByText('Entreno cancelado por lluvia')).toBeInTheDocument();
    expect(within(dias[6]).getByText('Cancelado · lluvia')).toBeInTheDocument();
    // Sábado: la clase de prueba con el pago.
    expect(await within(dias[5]).findByText(/Mariana Gómez · 2011 · Punta/)).toBeInTheDocument();
    expect(within(dias[5]).getByText(/Pagó ✅/)).toBeInTheDocument();
  });

  it('el link del aviso (?tab=semana&fecha=) abre la Semana de ese día, marcado', async () => {
    st.tablas.team_schedule_exceptions = () => ({ data: [], error: null });
    pintar('/training-plans?tab=semana&fecha=2026-11-07');
    expect(await screen.findByText(/Semana del 2 al 8 de noviembre/)).toBeInTheDocument();
    const dias = await screen.findAllByTestId('dia-semana');
    expect(dias[5].className).toMatch(/ring-2/);
    expect(screen.getByRole('tab', { name: 'Semana' })).toHaveAttribute('aria-selected', 'true');
  });
});
