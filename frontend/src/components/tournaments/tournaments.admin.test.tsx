/**
 * Pantallas de administración del torneo: copas en el generador, reglas por categoría y desempates,
 * rivales externos (uno a uno / lista), patrocinadores y hora/cancha a mano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), delete: (...a: unknown[]) => del(...a) },
  BFFError: class BFFError extends Error {},
}));
// toast estable, como el hook real (si cambia en cada render, los useCallback que lo usan se recrean sin fin).
const toastFn = vi.hoisted(() => ({ toast: () => {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastFn }));
vi.mock('@/components/common/ImageUpload', () => ({
  ImageUpload: ({ path, onChange }: { path?: string; onChange: (u: string) => void }) => (
    <button type="button" data-testid="upload" data-path={path} onClick={() => onChange('https://x.supabase.co/logo.png')}>subir</button>
  ),
}));

import { FixtureGeneratorDialog } from './FixtureGeneratorDialog';
import { LiveSettingsPanel } from './LiveSettingsPanel';
import { TournamentTeamsPanel } from './TournamentTeamsPanel';
import { TournamentSponsorsPanel, sponsorUrlError } from './TournamentSponsorsPanel';
import { MatchScheduleDialog } from './MatchScheduleDialog';
import { knockoutByCup } from './TournamentResultsPanel';
import type { LiveConfigDto, MatchDto, TeamDto } from '@/lib/tournamentTypes';
import { SCORING_PRESETS, resolveConfig } from '@/lib/tournamentScoring';

const volley = resolveConfig(SCORING_PRESETS.voleibol_3.config);
const match = (p: Partial<MatchDto> = {}): MatchDto => ({
  id: 'm1', category_id: 'c1', stage: 'league', group_label: null, cup_label: null, round: 1, slot: 1,
  home_team_id: 'a', away_team_id: 'b', home_name: 'Águilas', away_name: 'Cóndores', home_label: null, away_label: null,
  home_score: null, away_score: null, status: 'scheduled', scheduled_at: '2026-11-07T13:00:00.000Z', court: 'Cancha 1', version: 0,
  live_state: null, sets: [], scorer_label: null, started_at: null, finished_at: null, model: 'sets', config: volley, is_bye: false, ...p,
});
const config = (scoring: LiveConfigDto['event']['scoring_config'] = { ...SCORING_PRESETS.voleibol_3.config }): LiveConfigDto => ({
  event: { id: 'e1', title: 'Copa', sport: 'Voleibol', slug: 'copa', competition_format: null, live_enabled: true, scoring_config: scoring, format_config: null, stream_url: null },
  presets: Object.entries(SCORING_PRESETS).map(([key, p]) => ({ key, label: p.label, config: p.config })),
  suggested_preset: 'voleibol_3', global_live_disabled: false,
});

beforeEach(() => { get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); });

describe('generador: varias copas', () => {
  const teams = Array.from({ length: 16 }, (_, i) => ({ id: `t${i}`, name: `Equipo ${i + 1}` }));
  it('activa copas oro y plata y envía posiciones por copa', async () => {
    post.mockResolvedValueOnce({ matches: 38, format: 'grupos', seed: 1 });
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'grupos' } });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('Varias copas (oro, plata…)'));
    expect(screen.getByTestId('cups-editor')).toBeTruthy();
    expect(screen.getByTestId('fx-summary').textContent).toContain('de Copa oro + 7 de Copa plata');
    fireEvent.click(screen.getByRole('button', { name: 'Generar calendario' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].config).toMatchObject({
      groups: { count: 4, advance: 4 },
      cups: [{ label: 'Copa oro', positions: [1, 2] }, { label: 'Copa plata', positions: [3, 4] }],
    });
  });
  it('una posición usada en otra copa no se puede marcar', () => {
    render(<FixtureGeneratorDialog open onOpenChange={() => {}} eventId="e1" categoryId="c1" teams={teams} onGenerated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Formato'), { target: { value: 'grupos' } });
    fireEvent.click(screen.getByLabelText('Varias copas (oro, plata…)'));
    const ones = screen.getAllByRole('button', { name: '1.º' });
    expect(ones[0].getAttribute('aria-pressed')).toBe('true');
    expect((ones[1] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ajustes: reglas por categoría y desempates', () => {
  it('Mini a 1 set de 15 se guarda en by_category sin tocar lo del torneo', async () => {
    get.mockResolvedValue([]);
    patch.mockResolvedValue({ success: true });
    render(<LiveSettingsPanel eventId="e1" config={config()} onChanged={() => {}} categories={[{ id: 'mini', name: 'Mini' }, { id: 'sub14', name: 'Sub 14' }]} />);
    expect(screen.getByTestId('rule-summary-mini').textContent).toBe('Al mejor de 3 sets a 25 (decisivo a 15)');
    fireEvent.change(screen.getByLabelText('Sets de Mini'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Puntos por set de Mini'), { target: { value: '15' } });
    expect(screen.getByTestId('rule-summary-mini').textContent).toBe('Al mejor de 1 set a 15');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar reglas por categoría' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0][1];
    expect(body.scoring_config.by_category).toEqual({ mini: { best_of: 1, set_points: 15 } });
    expect(body.scoring_config.set_points).toBe(25);
  });
  it('un número de sets par muestra el error y no deja guardar', () => {
    get.mockResolvedValue([]);
    render(<LiveSettingsPanel eventId="e1" config={config()} onChanged={() => {}} categories={[{ id: 'mini', name: 'Mini' }]} />);
    fireEvent.change(screen.getByLabelText('Sets de Mini'), { target: { value: '2' } });
    expect(screen.getByText(/1, 3, 5/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Guardar reglas por categoría' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('reordena desempates y agrega diferencia de puntos', async () => {
    get.mockResolvedValue([]);
    patch.mockResolvedValue({ success: true });
    render(<LiveSettingsPanel eventId="e1" config={config()} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText('Agregar desempate'), { target: { value: 'point_diff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Subir Cociente de sets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar desempates' }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].scoring_config.tiebreakers).toEqual(['pts', 'set_ratio', 'wins', 'point_ratio', 'head_to_head', 'point_diff']);
  });
});

describe('equipos del torneo', () => {
  const teams: TeamDto[] = [
    { id: 't1', name: 'Monster A', category_id: 'c1', short_name: 'MON', logo_url: null, is_external: false, club_name: 'Monster Volley' },
    { id: 't2', name: 'Rival', category_id: 'c1', short_name: null, logo_url: null, is_external: true, club_name: null },
  ];
  it('lista internos y externos; pegar una lista los envía de una', async () => {
    get.mockResolvedValue(teams);
    post.mockResolvedValue({ created: [], skipped: [] });
    render(<TournamentTeamsPanel eventId="e1" schoolId="s1" categories={[{ id: 'c1', name: 'Sub 14' }]} />);
    await waitFor(() => expect(screen.getByText('Monster A')).toBeTruthy());
    expect(screen.getByText('Rival externo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Quitar Monster A' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Agregar equipo rival/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Pegar una lista' }));
    fireEvent.change(screen.getByLabelText('Un equipo por línea'), { target: { value: '1. Águilas\nTitanes | Club Titanes\nÁguilas' } });
    expect(screen.getByTestId('paste-count').textContent).toBe('Se agregarán 2 equipos.');
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]).toEqual(['/api/v1/tournament-live/school/e1/teams/external', {
      category_id: 'c1', teams: [{ team_name: 'Águilas' }, { team_name: 'Titanes', club_name: 'Club Titanes' }],
    }]);
  });
  it('uno a uno con logo subido a la carpeta de la escuela', async () => {
    get.mockResolvedValue([]);
    post.mockResolvedValue({ created: [{}], skipped: [] });
    render(<TournamentTeamsPanel eventId="e1" schoolId="s1" categories={[{ id: 'c1', name: 'Sub 14' }]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Agregar equipo rival/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Agregar equipo rival/ }));
    fireEvent.change(screen.getByLabelText('Nombre del equipo *'), { target: { value: 'Halcones' } });
    expect(screen.getByTestId('upload').getAttribute('data-path')).toBe('logos/s1/torneos/e1');
    fireEvent.click(screen.getByTestId('upload'));
    fireEvent.click(screen.getByRole('button', { name: 'Agregar' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].teams[0]).toMatchObject({ team_name: 'Halcones', logo_url: 'https://x.supabase.co/logo.png' });
  });
});

describe('patrocinadores', () => {
  it('valida https y agrega', async () => {
    get.mockResolvedValue([]);
    post.mockResolvedValue({});
    render(<TournamentSponsorsPanel eventId="e1" schoolId="s1" />);
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Bebidas' } });
    fireEvent.change(screen.getByLabelText('Sitio web o red social (opcional)'), { target: { value: 'http://x.co' } });
    expect(screen.getByRole('alert').textContent).toContain('https://');
    fireEvent.change(screen.getByLabelText('Sitio web o red social (opcional)'), { target: { value: 'https://x.co' } });
    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'principal' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregar/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]).toEqual(['/api/v1/tournament-live/school/e1/sponsors', { name: 'Bebidas', tier: 'principal', url: 'https://x.co', logo_url: null }]);
    expect(sponsorUrlError('')).toBeNull();
  });
});

describe('hora y cancha a mano', () => {
  it('muestra la hora en Colombia y envía ISO con -05:00', async () => {
    patch.mockResolvedValue(match({ court: 'Cancha 3' }));
    const saved = vi.fn();
    render(<MatchScheduleDialog eventId="e1" match={match()} courts={['Cancha 1']} onClose={() => {}} onSaved={saved} />);
    const when = screen.getByLabelText('Fecha y hora (hora de Colombia)') as HTMLInputElement;
    expect(when.value).toBe('2026-11-07T08:00');
    fireEvent.change(when, { target: { value: '2026-11-07T09:30' } });
    fireEvent.change(screen.getByLabelText('Cancha'), { target: { value: 'Cancha 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(patch.mock.calls[0]).toEqual(['/api/v1/tournament-live/school/e1/matches/m1/schedule', { scheduled_at: '2026-11-07T09:30:00-05:00', court: 'Cancha 3' }]);
  });
  it('agrupa la fase final por copa', () => {
    const g = knockoutByCup([match({ id: '1', cup_label: 'Copa oro' }), match({ id: '2', cup_label: 'Copa plata' }), match({ id: '3', cup_label: 'Copa oro' })]);
    expect(g.map((x) => [x.cup, x.matches.length])).toEqual([['Copa oro', 2], ['Copa plata', 1]]);
  });
});
