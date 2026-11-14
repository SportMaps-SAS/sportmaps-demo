/**
 * Arreglos del panel de torneos tras la prueba E2E a 390 px (2026-10-28): acciones del partido en su
 * propia fila, formato del asistente en el generador, copas ajustadas al grupo más pequeño y la
 * plantilla de marcador reconocida aunque jsonb reordene las claves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
const toastFn = vi.hoisted(() => ({ toast: () => {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastFn }));

import { CupsEditor, FixtureGeneratorDialog } from './FixtureGeneratorDialog';
import { currentPresetKey } from './LiveSettingsPanel';
import { MatchCard } from './TournamentViews';
import type { LiveConfigDto } from '@/lib/tournamentTypes';
import type { DisplayMatch } from '@/lib/tournamentDisplay';
import { SCORING_PRESETS } from '@/lib/tournamentScoring';

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(() => { window.history.replaceState({}, '', '/'); });

const cfg = (competition_format: string | null, scoring: unknown = null): LiveConfigDto => ({
  event: { id: 'e1', title: 'Copa', sport: 'Voleibol', slug: 'copa', competition_format, live_enabled: true, scoring_config: scoring as never, format_config: null, stream_url: null },
  presets: Object.entries(SCORING_PRESETS).map(([key, p]) => ({ key, label: p.label, config: p.config })),
  suggested_preset: 'voleibol_3', global_live_disabled: false,
});

describe('MatchCard: acciones en su propia fila (B2)', () => {
  it('el botón no comparte la fila de los nombres', () => {
    const m = { id: 'm1', status: 'scheduled', model: 'sets', sets: [], is_bye: false, home_name: 'Águilas', away_name: 'Titanes', home_team_id: 'a', away_team_id: 'b', stage: 'league', round: 1, scheduled_at: null, court: null } as unknown as DisplayMatch;
    render(<MatchCard match={m} action={<button>Anotar</button>} />);
    const actions = screen.getByTestId('match-card-actions');
    expect(within(actions).getByRole('button', { name: 'Anotar' })).toBeTruthy();
    expect(actions.textContent).not.toContain('Águilas');
    expect(actions.parentElement?.className).toContain('flex-col');
  });
});

describe('generador: formato del asistente (B5)', () => {
  const teams = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Equipo ${i + 1}` }));
  it('arranca con el formato guardado en el torneo', async () => {
    get.mockResolvedValue(cfg('grupos'));
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Formato') as HTMLSelectElement).value).toBe('grupos'));
    expect(get).toHaveBeenCalledWith('/api/v1/tournament-live/school/e1/config');
  });
  it('sin formato guardado usa ?formato= del asistente', async () => {
    window.history.replaceState({}, '', '/school/tournaments/e1?formato=copa&nuevo=1');
    get.mockResolvedValue(cfg(null));
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Formato') as HTMLSelectElement).value).toBe('copa'));
  });
  it('con initialFormat no consulta la configuración', async () => {
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} initialFormat="copa" />);
    await waitFor(() => expect((screen.getByLabelText('Formato') as HTMLSelectElement).value).toBe('copa'));
    expect(get).not.toHaveBeenCalled();
  });
});

describe('generador: copas con grupos pequeños (B7)', () => {
  it('5 equipos en 2 grupos: oro 1.º y plata 2.º, y se puede generar', async () => {
    get.mockResolvedValue(cfg('grupos'));
    post.mockResolvedValueOnce({ matches: 6, format: 'grupos', seed: 1 });
    const teams = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `Equipo ${i + 1}` }));
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    await waitFor(() => expect((screen.getByLabelText('Formato') as HTMLSelectElement).value).toBe('grupos'));
    fireEvent.click(screen.getByLabelText('Varias copas (oro, plata…)'));
    const gen = screen.getByRole('button', { name: 'Generar calendario' }) as HTMLButtonElement;
    await waitFor(() => expect(gen.disabled).toBe(false));
    fireEvent.click(gen);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].config.cups).toEqual([
      { label: 'Copa oro', positions: [1], third_place: false },
      { label: 'Copa plata', positions: [2], third_place: false },
    ]);
  });
  it('las posiciones fuera de rango se ven y se pueden quitar', () => {
    const onChange = vi.fn();
    render(<CupsEditor cups={[{ label: 'Copa plata', positions: [2, 3, 4], thirdPlace: false }]} maxPosition={2} onChange={onChange} />);
    const out = screen.getAllByTestId('cup-position-out');
    expect(out.map((b) => b.textContent)).toEqual(['3.º ✕', '4.º ✕']);
    fireEvent.click(out[0]);
    expect(onChange).toHaveBeenCalledWith([{ label: 'Copa plata', positions: [2, 4], thirdPlace: false }]);
  });
});

describe('plantilla de marcador (B14a)', () => {
  it('reconoce la plantilla aunque jsonb devuelva las claves en otro orden', () => {
    const preset = SCORING_PRESETS.voleibol_3.config as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.keys(preset).reverse().map((k) => [k, preset[k]]));
    expect(currentPresetKey(cfg(null, reordered))).toBe('voleibol_3');
  });
  it('una configuración cambiada a mano sigue siendo «personalizada»', () => {
    const preset = SCORING_PRESETS.voleibol_3.config as Record<string, unknown>;
    expect(currentPresetKey(cfg(null, { ...preset, set_points: 21 }))).toBe('');
  });
});
