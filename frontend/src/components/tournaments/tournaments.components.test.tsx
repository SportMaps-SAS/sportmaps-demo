import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
  BFF_URL: 'http://bff.test',
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => null }));

import { FixtureGeneratorDialog } from './FixtureGeneratorDialog';
import { LiveScorer } from './LiveScorer';
import { LiveSettingsPanel } from './LiveSettingsPanel';
import TournamentLivePage from '@/pages/events/TournamentLivePage';
import type { LiveConfigDto, MatchDto } from '@/lib/tournamentTypes';
import { SCORING_PRESETS, resolveConfig } from '@/lib/tournamentScoring';

const volley = resolveConfig(SCORING_PRESETS.voleibol_3.config);
const baseMatch = (p: Partial<MatchDto> = {}): MatchDto => ({
  id: 'm1', category_id: 'c1', stage: 'league', group_label: null, round: 1, slot: 1,
  home_team_id: 'a', away_team_id: 'b', home_name: 'Águilas', away_name: 'Cóndores', home_label: null, away_label: null,
  home_score: 0, away_score: 0, status: 'scheduled', scheduled_at: null, court: 'Cancha 1', version: 1,
  live_state: null, sets: [], scorer_label: null, started_at: null, finished_at: null, model: 'sets', config: volley, is_bye: false, ...p,
});

beforeEach(() => {
  get.mockReset(); post.mockReset(); patch.mockReset(); localStorage.clear();
});

describe('<FixtureGeneratorDialog />', () => {
  const teams = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Equipo ${i + 1}` }));
  it('muestra solo las opciones del formato y el resumen en vivo', () => {
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    expect(screen.getByTestId('fx-summary').textContent).toContain('28 partidos de liga');
    expect(screen.queryByText('Cuántos grupos')).toBeNull();
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'grupos' } });
    expect(screen.getByText('Cuántos grupos')).toBeTruthy();
    expect(screen.getByTestId('fx-summary').textContent).toContain('2 grupos de 4 · 12 partidos de grupo + 3 de fase final');
  });
  it('envía el cuerpo al BFF y muestra el error que devuelve', async () => {
    post.mockRejectedValueOnce(new Error('Ya hay partidos jugados'));
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generar calendario' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Ya hay partidos jugados'));
    expect(post.mock.calls[0][0]).toBe('/api/v1/tournament-live/school/e1/categories/c1/fixtures');
    expect(post.mock.calls[0][1]).toMatchObject({ format: 'liga' });
  });
});

describe('<LiveScorer />', () => {
  const endpoints = { actionsUrl: (id: string) => `/a/${id}`, takeUrl: (id: string) => `/t/${id}` };
  it('anota al instante, encola y sincroniza con expected_version', async () => {
    post.mockImplementation((url: string, body: { expected_version?: number }) =>
      Promise.resolve(url.startsWith('/a/') ? { ok: true, match: baseMatch({ version: (body.expected_version ?? 0) + 1, status: 'live', live_state: { status: 'live', points: '', walkover: null } }) } : { ok: true }));
    render(<LiveScorer match={baseMatch()} endpoints={endpoints} queueKey="q1" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Iniciar partido/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminar partido' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sumar un punto a Águilas' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Sincronizado'));
    const actionCalls = post.mock.calls.filter((c) => String(c[0]).startsWith('/a/'));
    expect(actionCalls[0][1]).toMatchObject({ action: { type: 'start' }, expected_version: 1 });
    expect(actionCalls[1][1]).toMatchObject({ action: { type: 'point', side: 'home' }, expected_version: 2 });
    expect(typeof actionCalls[0][1].client_action_id).toBe('string');
  });
  it('sin señal deja la acción pendiente y la muestra', async () => {
    post.mockImplementation((url: string) => (url.startsWith('/a/') ? Promise.reject(Object.assign(new Error('x'), { status: 0 })) : Promise.resolve({ ok: true })));
    render(<LiveScorer match={baseMatch()} endpoints={endpoints} queueKey="q2" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Iniciar partido/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Sin señal · 1 pendiente/));
    expect(screen.getByRole('button', { name: 'Terminar partido' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('q2')!).items).toHaveLength(1);
  });
  it('ofrece «Tomar el partido» si otro anotador lo tiene', async () => {
    post.mockImplementation((url: string) => (url.startsWith('/a/')
      ? Promise.reject(Object.assign(new Error('x'), { status: 409, body: { code: 'otro_anotador', error: 'Mesa 2 está anotando este partido.', match: baseMatch() } }))
      : Promise.resolve({ ok: true })));
    render(<LiveScorer match={baseMatch()} endpoints={endpoints} queueKey="q3" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Iniciar partido/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tomar el partido' })).toBeTruthy());
  });
});

describe('<LiveSettingsPanel />', () => {
  const cfg: LiveConfigDto = {
    event: { id: 'e1', title: 'T', sport: 'voleibol', slug: 't', competition_format: 'liga', live_enabled: false, scoring_config: null, format_config: null, stream_url: null },
    presets: [{ key: 'futbol', label: 'Fútbol', config: {} }, { key: 'voleibol_3', label: 'Vóley 2 de 3', config: {} }],
    suggested_preset: 'voleibol_3', global_live_disabled: true,
  };
  it('avisa si está apagado global, valida el enlace y enciende el marcador', async () => {
    get.mockResolvedValue([]); patch.mockResolvedValue({ success: true });
    render(<LiveSettingsPanel eventId="e1" config={cfg} onChanged={() => {}} />);
    expect(screen.getByText(/apagado temporalmente/)).toBeTruthy();
    expect(screen.getByText(/Vóley 2 de 3 \(sugerida\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Enlace de la transmisión/), { target: { value: 'https://evil.com/x' } });
    expect(screen.getAllByRole('alert').some((a) => /YouTube/.test(a.textContent ?? ''))).toBe(true);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/v1/tournament-live/school/e1/config', { live_enabled: true }));
  });
});

describe('<TournamentLivePage />', () => {
  it('payload de hoy: en vivo, set en curso, tabla de voleibol, transmisión y pie', async () => {
    const pm = (p: object) => ({ ...baseMatch(), ...p, version: undefined, config: undefined, live_state: undefined, scorer_label: undefined });
    get.mockResolvedValue({
      event: { id: 'e1', title: 'Copa Monster', sport: 'voleibol', city: 'Bogotá', event_date: '2026-10-24', school_name: 'Monster', live_enabled: true, stream_url: 'https://youtu.be/x', format: 'liga' },
      categories: [{ id: 'c1', name: 'Sub 14' }],
      matches: [pm({ id: 'a', status: 'live', home_score: 1, away_score: 0, sets: [{ home: 25, away: 20, closed: true, deciding: false }, { home: 5, away: 3, closed: false, deciding: false }] }),
        pm({ id: 'b', status: 'scheduled', court: 'Cancha 2', home_name: 'Lobos', away_name: 'Osos' })],
      standings: { c1: { model: 'sets', standings: [{ team_id: 'a', team_name: 'Águilas', P: 1, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, SW: 1, SL: 0, PF: 30, PA: 23 }] } },
      server_time: '2026-10-24T15:00:00Z',
    });
    render(<MemoryRouter initialEntries={['/torneo/copa/en-vivo']}><Routes><Route path="/torneo/:slug/en-vivo" element={<TournamentLivePage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('live-badge')).toBeTruthy());
    expect(screen.getByText('5-3').getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Posiciones' }));
    expect(screen.getByText('SG')).toBeTruthy();
    expect(screen.getByText('Ver transmisión')).toBeTruthy();
    expect(screen.getByText('Powered by SportMaps')).toBeTruthy();
    expect(get.mock.calls[0][2]).toBe('public');
    expect(document.head.querySelector('meta[name="robots"][content="noindex"]')).toBeTruthy();
  });
  it('404 muestra mensaje', async () => {
    get.mockRejectedValue(Object.assign(new Error('x'), { status: 404 }));
    render(<MemoryRouter initialEntries={['/torneo/no/en-vivo']}><Routes><Route path="/torneo/:slug/en-vivo" element={<TournamentLivePage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No encontramos este torneo/)).toBeTruthy());
  });
});
