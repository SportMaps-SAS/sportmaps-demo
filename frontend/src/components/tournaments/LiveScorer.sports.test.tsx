import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { LiveScorer, setScoreText } from './LiveScorer';
import type { MatchDto } from '@/lib/tournamentTypes';
import { SCORING_PRESETS, resolveConfig } from '@/lib/tournamentScoring';

const cfg = (k: string) => resolveConfig(SCORING_PRESETS[k].config);
const mk = (preset: string, p: Partial<MatchDto> = {}): MatchDto => {
  const c = cfg(preset);
  return {
    id: 'm1', category_id: 'c1', stage: 'league', group_label: null, round: 1, slot: 1,
    home_team_id: 'a', away_team_id: 'b', home_name: 'Ana', away_name: 'Luis', home_label: null, away_label: null,
    home_score: 0, away_score: 0, status: 'live', scheduled_at: null, court: 'Mesa 1', version: 1,
    live_state: { status: 'live', points: '', walkover: null }, sets: [], scorer_label: null, started_at: null, finished_at: null,
    model: c.model, config: c, is_bye: false, ...p,
  };
};
const endpoints = { actionsUrl: (id: string) => `/api/v1/tournament-live/school/e1/matches/${id}/actions`, takeUrl: (id: string) => `/x/${id}/take` };
// El servidor no responde (cola sin señal): el estado se ve igual, aplicado localmente.
beforeEach(() => { get.mockReset(); get.mockResolvedValue({ tags: [] }); post.mockReset(); post.mockImplementation(() => new Promise(() => {})); localStorage.clear(); });

const scorer = (m: MatchDto) => render(<LiveScorer match={m} endpoints={endpoints} queueKey="k" onClose={() => {}} tournamentTitle="Copa" />);

describe('anotador por deporte', () => {
  it('tenis: muestra 15-30-40 y los games del set', () => {
    scorer(mk('tenis'));
    const ana = screen.getByLabelText('Sumar un punto a Ana');
    fireEvent.click(ana);
    expect(ana.textContent).toContain('15');
    fireEvent.click(ana); fireEvent.click(ana);
    expect(ana.textContent).toContain('40');
    fireEvent.click(ana);
    expect(screen.getByTestId('tennis-games').textContent).toContain('Games: 1 - 0');
    expect(ana.textContent).toContain('0');
  });
  it('tenis: el texto del set con tie-break y super tie-break', () => {
    expect(setScoreText({ home: 7, away: 6, tb: { home: 7, away: 4 } })).toBe('7-6(4)');
    expect(setScoreText({ home: 1, away: 0, tb: { home: 10, away: 8 }, super: true })).toBe('[10-8]');
    expect(setScoreText({ home: 6, away: 4 })).toBe('6-4');
  });
  it('ajedrez: tres botones de resultado y ½ - ½ al marcar tablas', async () => {
    scorer(mk('ajedrez'));
    expect(screen.getByTestId('chess-panel')).toBeTruthy();
    expect(screen.queryByLabelText('Sumar un punto a Ana')).toBeNull();
    fireEvent.click(screen.getByText(/Tablas/));
    await waitFor(() => expect(screen.getByTestId('chess-score').textContent).toBe('½ - ½'));
    // Resultado + terminar quedaron en cola.
    await waitFor(() => expect(post.mock.calls.filter((c) => String(c[0]).endsWith('/actions')).length).toBeGreaterThanOrEqual(1));
  });
  it('críquet: carga runs / wickets / overs por innings', () => {
    scorer(mk('criquet'));
    fireEvent.change(screen.getByLabelText('Runs Ana'), { target: { value: '156' } });
    fireEvent.change(screen.getByLabelText('Wickets Ana'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Overs (máx. 20) Ana'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Runs Luis'), { target: { value: '149' } });
    fireEvent.click(screen.getByText('Guardar innings'));
    expect(screen.getByText('156/7 (20)')).toBeTruthy();
  });
  it('videojuegos: cada toque es un mapa ganado', () => {
    scorer(mk('videojuegos_mapas'));
    fireEvent.click(screen.getByLabelText('Ana gana el mapa'));
    expect(screen.getByTestId('sets-won').textContent).toBe('1 - 0');
  });
  it('hockey en eliminatoria: un empate pide shoot-out y lo muestra', async () => {
    scorer(mk('hockey', { stage: 'knockout' }));
    fireEvent.click(screen.getByLabelText('Sumar un punto a Ana'));
    fireEvent.click(screen.getByLabelText('Sumar un punto a Luis'));
    fireEvent.click(screen.getByText('Terminar partido'));
    fireEvent.click(screen.getByText('Sí, terminar'));
    fireEvent.click(await screen.findByTestId('shootout-open'));
    fireEvent.change(screen.getByLabelText('Shoot-out / penales Ana'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Shoot-out / penales Luis'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Guardar desempate'));
    expect((await screen.findByTestId('shootout-result')).textContent).toContain('3 - 2');
  });
  it('fútbol sigue igual y trae el botón de planilla', () => {
    scorer(mk('futbol'));
    fireEvent.click(screen.getByLabelText('Sumar un punto a Ana'));
    expect(screen.getByLabelText('Sumar un punto a Ana').textContent).toContain('1');
    expect(screen.getByTestId('planilla-btn')).toBeTruthy();
  });
});
