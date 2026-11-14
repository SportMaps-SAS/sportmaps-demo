/**
 * Autoevaluación post-entreno (V2): un toque por pregunta, sin fondos blancos
 * fijos (se rompía en tema oscuro) y el MISMO envío a
 * submit_post_training_self_eval. Nada sale a la red: supabase y
 * react-query van mockeados.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const m = vi.hoisted(() => ({
  ctx: null as unknown,
  query: { isLoading: false, isError: false },
  rpc: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-acudiente' }, profile: { full_name: 'Mauricio Herrera', role: 'parent' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: m.ctx, ...m.query, refetch: vi.fn() }),
  useMutation: (opts: { mutationFn: () => Promise<unknown>; onSuccess?: (d: unknown) => void }) => ({
    isPending: false,
    mutate: () => {
      opts.mutationFn().then((d) => opts.onSuccess?.(d));
    },
  }),
}));

import PostTrainingSelfEvalPage from './PostTrainingSelfEvalPage';

const baseCtx = {
  session: { id: 's1', session_date: '2026-07-31' },
  teamName: 'Fútbol Sub 15',
  sportCategoryId: 'cat',
  subjectType: 'child' as const,
  subjectId: 'h-tomas',
  childName: 'Tomás Herrera',
  focusItems: [{ key: 'focus_regate', label: 'Regate' }],
  totalPresentes: 4,
  yaRespondieron: 1,
};

function renderPage(url = '/post-entreno/s1?child_id=h-tomas') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/post-entreno/:sessionId" element={<PostTrainingSelfEvalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.ctx = baseCtx;
  m.query = { isLoading: false, isError: false };
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: { saved: 5, streak: 3, month_avg_borg: 6 }, error: null });
});

describe('PostTrainingSelfEvalPage (V2)', () => {
  it('portada: una frase con el nombre, el equipo y la fecha sin correrse de día', () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { name: '¿Cómo te fue en el entreno, Tomás?' })).toBeInTheDocument();
    expect(screen.getByText('Fútbol Sub 15 · Viernes 31 de julio')).toBeInTheDocument();
    expect(screen.getByText('Ya respondieron 1 de 4 del equipo')).toBeInTheDocument();
    // El defecto de tema oscuro: nada de fondos blancos ni del blanco fijo «background-light».
    expect(container.innerHTML).not.toMatch(/bg-white|bg-background-light/);
  });

  it('un toque por pregunta y envía exactamente lo mismo que antes', async () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }));

    expect(screen.getByRole('heading', { name: '¿Qué tan duro fue el entreno?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^7\s*Muy duro/ }));

    expect(screen.getByRole('heading', { name: '¿Entendiste los ejercicios de hoy?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Los entendí y los hice bien' }));

    expect(screen.getByRole('heading', { name: '¿Cuánto te esforzaste hoy?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Me esforcé mucho/ }));

    expect(screen.getByRole('heading', { name: '¿Cómo te sentiste al terminar?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Feliz y conforme con lo que hice' }));

    expect(screen.getByRole('heading', { name: '¿Qué quieres mejorar la próxima vez?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Regate' }));
    expect(container.innerHTML).not.toMatch(/bg-white|bg-background-light/);
    fireEvent.click(screen.getByRole('button', { name: 'Terminar' }));

    expect(m.rpc).toHaveBeenCalledWith('submit_post_training_self_eval', {
      p_session_id: 's1',
      p_child_id: 'h-tomas',
      p_user_id: null,
      p_answers: { rpe_borg: 7, task_comprehension: 1, self_effort_pct: 90, satisfaction: 3, focus: ['focus_regate'] },
    });
    expect(await screen.findByRole('heading', { name: '¡Listo! Tu profe ya lo ve.' })).toBeInTheDocument();
    expect(screen.getByText('Llevas 3 entrenos seguidos respondiendo.')).toBeInTheDocument();
  });

  it('el deportista adulto se envía como perfil, no como hijo', async () => {
    m.ctx = { ...baseCtx, subjectType: 'profile', subjectId: 'u-atleta', childName: null };
    renderPage();
    expect(screen.getByRole('heading', { name: '¿Cómo te fue en el entreno, Mauricio?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }));
    fireEvent.click(screen.getByRole('radio', { name: /^0\s*Nada/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Ni los entendí ni los pude hacer' }));
    fireEvent.click(screen.getByRole('radio', { name: /Di la mitad/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'No quedé conforme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminar' }));
    expect(m.rpc).toHaveBeenCalledWith('submit_post_training_self_eval', {
      p_session_id: 's1',
      p_child_id: null,
      p_user_id: 'u-atleta',
      p_answers: { rpe_borg: 0, task_comprehension: 4, self_effort_pct: 60, satisfaction: 1 },
    });
    expect(await screen.findByText('¡Listo! Tu profe ya lo ve.')).toBeInTheDocument();
  });

  it('el deportista que responde por su ficha vinculada manda p_unregistered_athlete_id', async () => {
    m.ctx = { ...baseCtx, subjectType: 'unregistered', subjectId: 'ficha-1', childName: null };
    renderPage('/post-entreno/s1?ficha=ficha-1');
    expect(screen.getByRole('heading', { name: '¿Cómo te fue en el entreno, Mauricio?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }));
    fireEvent.click(screen.getByRole('radio', { name: /^5\s*Duro/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Los entendí y los hice bien' }));
    fireEvent.click(screen.getByRole('radio', { name: /Me esforcé mucho/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Feliz y conforme con lo que hice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminar' }));
    expect(m.rpc).toHaveBeenCalledWith('submit_post_training_self_eval', {
      p_session_id: 's1',
      p_child_id: null,
      p_user_id: null,
      p_answers: { rpe_borg: 5, task_comprehension: 1, self_effort_pct: 90, satisfaction: 3 },
      p_unregistered_athlete_id: 'ficha-1',
    });
    expect(await screen.findByText('¡Listo! Tu profe ya lo ve.')).toBeInTheDocument();
  });

  it('la flecha vuelve a la pregunta anterior con la respuesta marcada', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Empezar' }));
    fireEvent.click(screen.getByRole('radio', { name: /^5\s*Duro/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pregunta anterior' }));
    expect(screen.getByRole('radio', { name: /^5\s*Duro/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('carga, error y entreno sin deportista se ven distintos', () => {
    m.query = { isLoading: true, isError: false };
    const { unmount } = renderPage();
    expect(screen.getByRole('status', { name: 'Cargando el entreno' })).toBeInTheDocument();
    unmount();

    m.query = { isLoading: false, isError: true };
    const r2 = renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos abrir este entreno.');
    r2.unmount();

    m.ctx = { ...baseCtx, subjectId: null };
    m.query = { isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText('No encontramos a qué deportista corresponde este entreno.')).toBeInTheDocument();
  });
});
