/**
 * «Uso de IA de pizarra» (super admin): totales, por deporte, por escuela y
 * coach, y «Dar más cupo». BFF mockeado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/api/bffClient', () => {
  class BFFError extends Error {
    constructor(public status: number, message: string, public body?: unknown) { super(message); }
  }
  return { bffClient: { post: api.post, get: api.get }, BFFError };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

import { BFFError } from '@/lib/api/bffClient';
import AdminTacticalAiUsagePage, { type AiUsageReport } from '@/pages/admin/AdminTacticalAiUsagePage';

const S1 = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
const report: AiUsageReport = {
  period: '2026-10',
  totals: { analyses: 17, cache_hits: 3, tokens_in: 85_000, tokens_out: 100_300, cost_usd: 1.1, schools: 1, coaches: 2, coaches_at_limit: 1 },
  by_sport: [
    { sport: 'futbol', label: 'fútbol 11', analyses: 15, cache_hits: 3, cost_usd: 0.96, avg_cost_usd: 0.064 },
    { sport: 'voleibol', label: 'voleibol', analyses: 2, cache_hits: 0, cost_usd: 0.086, avg_cost_usd: 0.043 },
    { sport: 'baloncesto', label: 'baloncesto', analyses: 0, cache_hits: 0, cost_usd: 0, avg_cost_usd: null },
  ],
  schools: [{
    school_id: S1, name: 'Club Demo', analyses: 17, cache_hits: 3, tokens_in: 85_000, tokens_out: 100_300,
    cost_usd: 1.1, ceiling_usd: 10, pct: 11, hit_limit: false, coaches_at_limit: 1,
    coaches: [
      { user_id: U1, name: 'Profe Andrés', analyses: 15, cache_hits: 3, tokens_in: 75_000, tokens_out: 88_500, cost_usd: 1, budget_usd: 1, pct: 100, hit_limit: true, needs_more_count: 4 },
      { user_id: 'u2', name: 'Profe Beto', analyses: 2, cache_hits: 0, tokens_in: 10_000, tokens_out: 11_800, cost_usd: 0.1, budget_usd: 1, pct: 10, hit_limit: false, needs_more_count: 0 },
    ],
  }],
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  toast.mockReset();
  api.get.mockResolvedValue(report);
  api.post.mockResolvedValue({ ok: true });
});

describe('AdminTacticalAiUsagePage', () => {
  it('muestra totales, costo medio por deporte y la tabla por escuela y coach', async () => {
    render(<AdminTacticalAiUsagePage />);
    expect(await screen.findByText('Uso de IA de pizarra')).toBeInTheDocument();
    await screen.findByTestId(`ai-school-${S1}`);
    expect(api.get.mock.calls[0][0]).toMatch(/^\/api\/v1\/admin\/tactical-ai\/usage\?period=\d{4}-\d{2}$/);
    const totals = screen.getByRole('region', { name: 'Totales del mes' });
    expect(within(totals).getByText('Costo real')).toBeInTheDocument();
    expect(within(totals).getByText('17')).toBeInTheDocument();
    const fut = screen.getByTestId('ai-sport-futbol');
    expect(fut).toHaveTextContent('fútbol 11');
    expect(fut).toHaveTextContent('0,064');
    expect(screen.getByTestId('ai-sport-baloncesto')).toHaveTextContent('—');
    const coach = screen.getByTestId(`ai-coach-${U1}`);
    expect(coach).toHaveTextContent('Profe Andrés');
    expect(coach).toHaveTextContent('Topó (4)');
    expect(coach).toHaveTextContent('100 % de US$ 1,00');
    expect(screen.getByTestId(`ai-school-${S1}`)).toHaveTextContent('11 % de US$ 10');
  });

  it('«Dar más cupo» a un coach: POST grant en USD y recarga', async () => {
    render(<AdminTacticalAiUsagePage />);
    const coach = await screen.findByTestId(`ai-coach-${U1}`);
    fireEvent.click(within(coach).getByRole('button', { name: /Dar más cupo/ }));
    expect(await screen.findByText(/A Profe Andrés en Club Demo/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Monto (USD)'), { target: { value: '2,5' } });
    fireEvent.change(screen.getByLabelText('Nota (opcional)'), { target: { value: 'piloto' } });
    fireEvent.click(screen.getByRole('button', { name: /Dar cupo/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/admin/tactical-ai/grant', {
      school_id: S1, user_id: U1, amount_usd: 2.5, note: 'piloto',
    }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('recarga en la moneda del medidor del coach: «+50 % de IA» = US$ 0,50 del presupuesto base', async () => {
    render(<AdminTacticalAiUsagePage />);
    const coach = await screen.findByTestId(`ai-coach-${U1}`);
    fireEvent.click(within(coach).getByRole('button', { name: /Dar más cupo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^\+50 % de IA/ }));
    expect(screen.getByRole('button', { name: /^\+100 % de IA/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dar cupo/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/admin/tactical-ai/grant', {
      school_id: S1, user_id: U1, amount_usd: 0.5, note: 'Recarga +50 % de IA',
    }));
  });

  it('a la escuela no se ofrecen recargas de coach; el cupo ampliado temporal se marca', async () => {
    api.get.mockResolvedValue({ ...report, schools: [{ ...report.schools[0], quota_multiplier: 3 }] });
    render(<AdminTacticalAiUsagePage />);
    const school = await screen.findByTestId(`ai-school-${S1}`);
    expect(school).toHaveTextContent('Cupo ×3 temporal');
    fireEvent.click(within(school).getByRole('button', { name: /Dar más cupo/ }));
    await screen.findByLabelText('Monto (USD)');
    expect(screen.queryByRole('button', { name: /% de IA/ })).toBeNull();
  });

  it('«Dar más cupo» a la escuela: sin user_id', async () => {
    render(<AdminTacticalAiUsagePage />);
    const school = await screen.findByTestId(`ai-school-${S1}`);
    fireEvent.click(within(school).getByRole('button', { name: /Dar más cupo/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Dar cupo/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/admin/tactical-ai/grant', expect.objectContaining({ school_id: S1, user_id: null, amount_usd: 1 })));
  });

  it('monto inválido: no llama al BFF', async () => {
    render(<AdminTacticalAiUsagePage />);
    const school = await screen.findByTestId(`ai-school-${S1}`);
    fireEvent.click(within(school).getByRole('button', { name: /Dar más cupo/ }));
    fireEvent.change(await screen.findByLabelText('Monto (USD)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Dar cupo/ }));
    expect(api.post).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Monto inválido' }));
  });

  it('migración sin aplicar (503): mensaje claro', async () => {
    api.get.mockRejectedValue(new BFFError(503, 'x', { error: 'El cupo de IA por entrenador todavía no está habilitado.' }));
    render(<AdminTacticalAiUsagePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('todavía no está habilitado');
  });
});
