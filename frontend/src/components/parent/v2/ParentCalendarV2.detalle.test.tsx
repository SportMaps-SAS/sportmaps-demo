/**
 * Calendario del acudiente › Próximos: tocar un evento abre su detalle y, si es
 * un partido con el hijo convocado, se responde «Va / No va» ahí mismo (B1).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const manana = new Date();
manana.setDate(manana.getDate() + 1);
manana.setHours(10, 0, 0, 0);
const dia = `${manana.getFullYear()}-${String(manana.getMonth() + 1).padStart(2, '0')}-${String(manana.getDate()).padStart(2, '0')}`;

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-papa' } }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('./useParentCalendarData', () => ({
  AGENDA_DAYS: 14,
  useParentAgenda: () => ({
    isLoading: false, isError: false, refetch: vi.fn(),
    data: {
      children: [{ id: 'c-tomas', name: 'Tomás', schoolId: 's1', teamIds: ['t-sub15'] }],
      teams: [{ id: 't-sub15', name: 'Fútbol — Sub-15', schoolId: 's1', location: 'Cancha 1', coachName: null, schedule: [] }],
      events: [{
        id: 'e-1', title: 'vs Halcones FC', description: 'Amistoso\nLlegar 30 minutos antes',
        event_type: 'match', start_time: manana.toISOString(), location: 'Unidad Deportiva', team_id: 't-sub15', school_id: 's1',
      }],
    },
  }),
  useParentTournaments: () => ({ isLoading: false, isError: false, refetch: vi.fn(), data: { registered: [], open: [] } }),
}));
const responder = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/v2Contratos', () => ({
  misConvocatorias: async () => ({
    data: [{
      lineup_id: 'l-1', match_id: 'm-1', team_id: 't-sub15', subject_type: 'child', subject_id: 'c-tomas',
      athlete_name: 'Tomás Herrera', role: 'bench', opponent: 'Halcones FC', match_date: dia,
      kickoff_at: null, location: null, notes: null, response: null,
    }],
    error: null,
    noDisponible: false,
  }),
  responderConvocatoria: responder,
}));

import ParentCalendarV2 from './ParentCalendarV2';

describe('ParentCalendarV2 › detalle de un evento', () => {
  it('tocar el partido abre el detalle con lugar, nota completa y la convocatoria', async () => {
    responder.mockResolvedValue({ data: { response: 'no_va' }, error: null, noDisponible: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><ParentCalendarV2 /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Partido · Tomás: ver detalle/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Unidad Deportiva/ })).toHaveAttribute(
      'href', 'https://www.google.com/maps/search/?api=1&query=Unidad%20Deportiva',
    );
    expect(screen.getByText(/Llegar 30 minutos antes/)).toBeInTheDocument();
    expect(await screen.findByText('¿Va Tomás al partido contra Halcones FC?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No va' }));
    await waitFor(() => expect(responder).toHaveBeenCalledWith('l-1', { childId: 'c-tomas' }, 'no_va'));
    expect(await screen.findByText('Tomás no puede ir')).toBeInTheDocument();
  });
});
