import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const post = vi.fn();
const patch = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: vi.fn(), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ profile: { role: 'school' }, loading: false }) }));
vi.mock('@/hooks/useEntitlements', () => ({ useEntitlements: () => ({ hasAddon: () => true, isLoading: false }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ schoolId: null, teams: [] }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));

import { TournamentWizard } from './TournamentWizard';
import { categoryRows, createFromWizard, draftDate, schoolPayload, sportsForSchool, validateStep, type WizardAnswers } from './tournamentWizard.logic';
import { TOURNAMENT_SPORTS, sportFromName, scorerKindFor, sheetKindFor } from '@/lib/tournamentSports';
import { tournamentAccessFor } from '@/lib/tournaments/tournamentAccess';
import { SCORING_PRESETS, presetKeyForSport, resolveConfig } from '@/lib/tournamentScoring';

beforeEach(() => { post.mockReset(); patch.mockReset(); });

const renderWizard = (access?: Parameters<typeof TournamentWizard>[0]['access']) => render(
  <MemoryRouter initialEntries={['/school/tournaments/nuevo-rapido']}>
    <Routes>
      <Route path="/school/tournaments/nuevo-rapido" element={<TournamentWizard access={access} />} />
      <Route path="/school/tournaments/:id" element={<div data-testid="detalle">detalle</div>} />
    </Routes>
  </MemoryRouter>,
);

describe('<TournamentWizard />', () => {
  it('4 pasos: nombre, tipo con categorías, deporte con reglas y formato; crea en borrador y va al detalle', async () => {
    post.mockResolvedValue({ id: 'ev1' });
    patch.mockResolvedValue({ success: true });
    renderWizard();
    expect(screen.getByText('Paso 1 de 4 · Nombre')).toBeTruthy();
    fireEvent.click(screen.getByTestId('wz-next'));
    expect(screen.getByRole('alert').textContent).toContain('nombre');
    fireEvent.change(screen.getByLabelText('Nombre del torneo'), { target: { value: 'Copa Monster' } });
    fireEvent.click(screen.getByTestId('wz-next'));

    expect(screen.getByText('Paso 2 de 4 · Tipo')).toBeTruthy();
    fireEvent.click(screen.getByText('Con categorías'));
    fireEvent.click(screen.getByTestId('wz-next'));
    expect(screen.getByRole('alert').textContent).toContain('categoría');
    fireEvent.click(screen.getByText('+ Sub-14'));
    fireEvent.change(screen.getByLabelText('Nueva categoría'), { target: { value: 'Sub-16 femenino' } });
    fireEvent.click(screen.getByTestId('wz-next'));

    expect(screen.getByText('Paso 3 de 4 · Deporte')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(TOURNAMENT_SPORTS.length);
    fireEvent.click(screen.getByText('Voleibol'));
    expect(screen.getByTestId('wz-presets')).toBeTruthy();
    fireEvent.click(screen.getByText(SCORING_PRESETS.voleibol_5.label));
    fireEvent.click(screen.getByTestId('wz-next'));

    expect(screen.getByText('Paso 4 de 4 · Formato')).toBeTruthy();
    expect(screen.getByText(/Puedes cambiarlo después/)).toBeTruthy();
    fireEvent.click(screen.getByText('Grupos + eliminatoria'));
    fireEvent.click(screen.getByTestId('wz-next'));

    await waitFor(() => expect(screen.getByTestId('detalle')).toBeTruthy());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/v1/events/school-tournament');
    expect(body).toMatchObject({ title: 'Copa Monster', sport: 'Voleibol', is_paid: false });
    expect(body.categories.map((c: any) => [c.category, c.rama])).toEqual([['Sub-14', 'Mixto'], ['Sub-16 femenino', 'Femenino']]);
    expect(patch).toHaveBeenCalledWith('/api/v1/tournament-live/school/ev1/config', { preset: 'voleibol_5' });
  });

  it('sin el complemento Torneos muestra el candado', () => {
    renderWizard(tournamentAccessFor({ role: 'school', hasTournamentsAddon: false }));
    expect(screen.getByTestId('wizard-locked')).toBeTruthy();
    expect(screen.getByText('Ir a Mi Plan')).toBeTruthy();
  });

  it('atletismo avisa que es por marcas', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText('Nombre del torneo'), { target: { value: 'Festival' } });
    fireEvent.click(screen.getByTestId('wz-next'));
    fireEvent.click(screen.getByText('Un solo torneo'));
    fireEvent.click(screen.getByTestId('wz-next'));
    fireEvent.click(screen.getByText('Atletismo'));
    expect(screen.getByTestId('wz-marks-note')).toBeTruthy();
  });
});

describe('lógica del asistente', () => {
  const base: WizardAnswers = { name: 'Liga', kind: 'single', categories: [], sport: sportFromName('Tenis')!, preset: 'tenis', format: 'liga' };
  it('un solo torneo = una categoría General; categorías sin repetidas', () => {
    expect(categoryRows(base)).toHaveLength(1);
    expect(categoryRows({ kind: 'categories', categories: ['Sub-12', 'sub-12', ' ', 'Masculino'] }).map((c) => c.category)).toEqual(['Sub-12', 'Masculino']);
  });
  it('fecha de borrador en Bogotá', () => expect(draftDate(new Date('2026-10-27T03:00:00Z'), 14)).toBe('2026-11-09'));
  it('valida cada paso', () => {
    expect(validateStep(0, { name: '' })).toBeTruthy();
    expect(validateStep(1, { kind: 'categories', categories: [] })).toBeTruthy();
    expect(validateStep(1, { kind: 'single', categories: [] })).toBeNull();
  });
  it('el organizador usa POST /api/v1/events y va a su panel', async () => {
    const client = { post: vi.fn().mockResolvedValue({ id: 'o1' }), patch: vi.fn() };
    const out = await createFromWizard('organizer', base, client as any);
    expect(client.post.mock.calls[0][0]).toBe('/api/v1/events');
    expect(client.post.mock.calls[0][1].slug).toMatch(/^liga-/);
    expect(out.href).toContain('/organizer/event/o1');
    expect(client.patch).not.toHaveBeenCalled();
  });
  it('si guardar las reglas falla, el torneo igual queda creado con un aviso', async () => {
    const client = { post: vi.fn().mockResolvedValue({ id: 'e2' }), patch: vi.fn().mockRejectedValue(new Error('x')) };
    const out = await createFromWizard('school', base, client as any);
    expect(out.href).toBe('/school/tournaments/e2?formato=liga&nuevo=1');
    expect(out.warnings).toHaveLength(1);
  });
  it('el payload de escuela cumple lo que exige el BFF', () => {
    const p = schoolPayload(base);
    for (const k of ['title', 'sport', 'event_date', 'start_time', 'address', 'city', 'tournament_scope'] as const) expect(p[k]).toBeTruthy();
  });
  it('el payload de escuela guarda el formato elegido (B5)', () => {
    expect(schoolPayload({ ...base, format: 'grupos' }).competition_format).toBe('grupos');
  });
});

describe('catálogo de deportes', () => {
  it('trae los 19 deportes pedidos', () => {
    expect(TOURNAMENT_SPORTS.map((s) => s.name)).toEqual([
      'Fútbol', 'Futsal', 'Balonmano', 'Baloncesto', 'Voleibol', 'Vóley playa', 'Futvóley', 'Tenis de mesa', 'Tenis', 'Beach tennis',
      'Pádel', 'Bádminton', 'Ajedrez', 'Bochas', 'Hockey', 'Críquet', 'Atletismo', 'Deporte genérico', 'Videojuegos (e-sports)',
    ]);
  });
  it('cada nombre resuelve a su plantilla en el motor (lo que hará el BFF) y sus plantillas existen', () => {
    for (const s of TOURNAMENT_SPORTS) {
      expect(presetKeyForSport(s.name), s.name).toBe(s.defaultPreset);
      for (const p of s.presets) expect(SCORING_PRESETS[p], `${s.name}/${p}`).toBeTruthy();
    }
  });
  it('tipo de anotador y planilla por plantilla', () => {
    const k = (p: string) => scorerKindFor(resolveConfig(SCORING_PRESETS[p].config));
    expect(k('futbol')).toBe('goals');
    expect(k('voleibol_3')).toBe('sets');
    expect(k('tenis')).toBe('tennis');
    expect(k('beach_tennis')).toBe('tennis');
    expect(k('ajedrez')).toBe('chess');
    expect(k('criquet')).toBe('cricket');
    expect(k('videojuegos_mapas')).toBe('maps');
    expect(sheetKindFor(resolveConfig(SCORING_PRESETS.voleibol_3.config))).toBe('volleyball');
    expect(sheetKindFor(resolveConfig(null), 'Baloncesto')).toBe('basketball');
  });
  it('acceso: organizador sí; escuela según el complemento; otros roles no', () => {
    expect(tournamentAccessFor({ role: 'organizer', hasTournamentsAddon: false }).allowed).toBe(true);
    expect(tournamentAccessFor({ role: 'school_admin', hasTournamentsAddon: true }).actor).toBe('school');
    expect(tournamentAccessFor({ role: 'school', hasTournamentsAddon: false }).allowed).toBe(false);
    expect(tournamentAccessFor({ role: 'parent', hasTournamentsAddon: true }).allowed).toBe(false);
  });
});

describe('paso «¿Qué deporte?» según la escuela', () => {
  it('escuela de un solo deporte: ese arriba y los demás plegados', () => {
    const g = sportsForSchool(TOURNAMENT_SPORTS, ['Voleibol', 'voleibol ']);
    expect(g.main.map((s) => s.name)).toContain('Voleibol');
    expect(g.main.map((s) => s.name)).not.toContain('Fútbol');
    expect(g.main.length + g.others.length).toBe(TOURNAMENT_SPORTS.length);
  });
  it('multideporte o varios deportes: todos, los suyos primero', () => {
    expect(sportsForSchool(TOURNAMENT_SPORTS, ['Multideporte']).others).toHaveLength(0);
    const g = sportsForSchool(TOURNAMENT_SPORTS, ['Baloncesto', 'Ajedrez']);
    expect(g.others).toHaveLength(0);
    expect(g.main.slice(0, 2).map((s) => s.name).sort()).toEqual(['Ajedrez', 'Baloncesto']);
    expect(sportsForSchool(TOURNAMENT_SPORTS, []).main.map((s) => s.name)).toEqual(TOURNAMENT_SPORTS.map((s) => s.name));
  });
  it('en pantalla: Voleibol preseleccionado y «Ver otros deportes» despliega el resto', () => {
    render(
      <MemoryRouter><TournamentWizard schoolSports={['Voleibol']} access={tournamentAccessFor({ role: 'school', hasTournamentsAddon: true })} /></MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Nombre del torneo'), { target: { value: 'Copa' } });
    fireEvent.click(screen.getByTestId('wz-next'));
    fireEvent.click(screen.getByText('Un solo torneo'));
    fireEvent.click(screen.getByTestId('wz-next'));
    const main = screen.getByTestId('wz-sports-main');
    expect(main.textContent).toContain('Voleibol');
    expect(screen.queryByText('Ajedrez')).toBeNull();
    expect(screen.getByText('Voleibol').closest('button')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('wz-sports-others-toggle'));
    expect(screen.getByText('Ajedrez')).toBeTruthy();
  });
});
