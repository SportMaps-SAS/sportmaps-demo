import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import fixture from './__fixtures__/torneo-demo.json';

const get = vi.fn();
vi.mock('@/lib/api/bffClient', () => ({
  bffClient: { get: (...a: unknown[]) => get(...a), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  BFFError: class BFFError extends Error {},
  BFF_URL: 'http://bff.test',
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => null }));

const notFound = () => Promise.reject(Object.assign(new Error('x'), { status: 404 }));
/** Payload del torneo; los endpoints de «vivo» (player-stats, social) responden 404 salvo que se diga otra cosa. */
const serve = (payload: unknown, extra: Record<string, unknown> = {}) => (url: string) => {
  for (const [suffix, body] of Object.entries(extra)) if (url.endsWith(suffix)) return Promise.resolve(body);
  if (url.endsWith('/live')) return Promise.resolve(payload);
  return notFound();
};

import TournamentLivePage from '@/pages/events/TournamentLivePage';
import TournamentMatchPage from '@/pages/events/TournamentMatchPage';
import TournamentTvPage from '@/pages/events/TournamentTvPage';
import TournamentEmbedPage from '@/pages/events/TournamentEmbedPage';

const clone = () => JSON.parse(JSON.stringify(fixture));
const routeLive = (path = '/torneo/copa/en-vivo') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/torneo/:slug/en-vivo" element={<TournamentLivePage />} />
      <Route path="/torneo/:slug/partido/:matchId" element={<TournamentMatchPage />} />
      <Route path="/torneo/:slug/tv" element={<TournamentTvPage />} />
      <Route path="/torneo/:slug/embed" element={<TournamentEmbedPage />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { get.mockReset(); localStorage.clear(); });

describe('<TournamentLivePage /> v2', () => {
  it('encabezado con marca, estado, en vivo y Powered by SportMaps', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Copa Campestre de Vóley 2026' })).toBeTruthy());
    expect(screen.getByText('Organiza Club Campestre Demo')).toBeTruthy();
    expect(screen.getByTestId('phase').textContent).toContain('En curso');
    expect(screen.getByTestId('live-badge').textContent).toContain('En vivo · 1 partido');
    expect(screen.getByText('31 oct – 1 nov 2026')).toBeTruthy();
    expect(screen.getByTestId('powered-by').textContent).toContain('Powered by SportMaps');
    expect(screen.getByText('Ver transmisión')).toBeTruthy();
    expect(screen.getByText('Reglamento')).toBeTruthy();
    expect(screen.getByText('Patrocinador principal')).toBeTruthy();
    expect(get.mock.calls[0][2]).toBe('public');
  });

  it('abre en Partidos con el filtro En vivo cuando hay juego, y el set en curso resaltado', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Partidos', selected: true })).toBeTruthy());
    expect(screen.getByRole('radio', { name: /En vivo/, checked: true })).toBeTruthy();
    const card = screen.getAllByTestId('public-match')[0];
    expect(within(card).getByText('12-14').getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Jugados/ }));
    expect(screen.getAllByTestId('public-match')).toHaveLength(10);
  });

  it('posiciones de voleibol por grupo con leyenda de copas', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => screen.getByRole('tab', { name: 'Posiciones' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Posiciones' }));
    expect(screen.getByRole('region', { name: 'Grupo A' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Grupo B' })).toBeTruthy();
    for (const h of ['PJ', 'PG', 'PP', 'PTS', 'SG', 'SP', 'DS', 'PF', 'PC', 'DP']) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getByRole('list', { name: 'Quién clasifica' }).textContent).toContain('→ Copa oro');
  });

  it('recuerda la categoría y muestra la copa con campeón', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => screen.getByRole('radio', { name: 'Mayores · Masculino' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Mayores · Masculino' }));
    expect(localStorage.getItem('torneo:copa:categoria')).toBe('c2');
    fireEvent.click(screen.getByRole('tab', { name: 'Copas' }));
    expect(screen.getByTestId('champion').textContent).toContain('Campestre Titanes');
    expect(screen.getByText('3.º y 4.º puesto')).toBeTruthy();
  });

  it('ficha del equipo al tocarlo', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => screen.getByRole('tab', { name: 'Posiciones' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Posiciones' }));
    fireEvent.click(screen.getAllByRole('button', { name: /Halcones del Norte/ })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Halcones del Norte' })).toBeTruthy();
    expect(within(dialog).getAllByTestId('public-match').length).toBe(3);
  });

  it('hoja Compartir con QR, enlace y WhatsApp', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => screen.getByRole('button', { name: /Compartir/ }));
    fireEvent.click(screen.getByRole('button', { name: /Compartir/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('share-qr').querySelector('svg')).toBeTruthy();
    expect(within(dialog).getByTestId('share-link').textContent).toMatch(/\/torneo\/copa\/en-vivo$/);
    expect(within(dialog).getByText('WhatsApp').closest('a')!.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/);
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Categoría' }));
    expect(within(dialog).getByTestId('share-link').textContent).toContain('?cat=c1');
  });

  it('Ranking solo aparece si el payload trae player_stats', async () => {
    get.mockImplementation(serve(clone()));
    const { unmount } = routeLive();
    await waitFor(() => screen.getByRole('tab', { name: 'Posiciones' }));
    expect(screen.queryByRole('tab', { name: 'Ranking' })).toBeNull();
    unmount();
    get.mockImplementation(serve({ ...clone(), player_stats: [{ player_label: 'N.º 7', team_id: 't1', team_name: 'Campestre Águilas', points: 14, category_id: 'c1' }] }));
    routeLive();
    await waitFor(() => screen.getByRole('tab', { name: 'Ranking' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    expect(screen.getAllByTestId('ranking-row')).toHaveLength(1);
  });

  it('Ranking también sale del endpoint player-stats de «vivo»', async () => {
    get.mockImplementation(serve(clone(), { '/player-stats': { player_stats: [
      { member_id: 'p1', name: 'Jugadora 1', team_id: 't1', ace: 3, attack: 5, block: 1, points: 9 },
      { member_id: 'p2', name: 'Jugadora 2', team_id: 't9', ace: 0, attack: 2, block: 0, points: 2 },
    ] } }));
    routeLive();
    await waitFor(() => screen.getByRole('tab', { name: 'Ranking' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Ranking' }));
    expect(screen.getAllByTestId('ranking-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Aces' }));
    expect(screen.getByText('Jugadora 1')).toBeTruthy();
  });

  it('Compartir → Insertar en tu web arma el iframe con vista, categoría y fondo', async () => {
    get.mockImplementation(serve(clone()));
    routeLive();
    await waitFor(() => screen.getByRole('button', { name: /Compartir/ }));
    fireEvent.click(screen.getByRole('button', { name: /Compartir/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Insertar en tu web/ }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Copas' }));
    fireEvent.click(within(dialog).getByLabelText('Fondo transparente'));
    const code = (within(dialog).getByTestId('embed-code') as HTMLTextAreaElement).value;
    expect(code).toMatch(/^<iframe src="[^"]*\/torneo\/copa\/embed\?vista=copas&amp;categoria=c1&amp;fondo=transparente"/);
  });

  it('funciona con el payload de hoy (sin campos nuevos)', async () => {
    const legacy = clone();
    delete legacy.tournament; delete legacy.teams;
    for (const m of legacy.matches) delete m.cup_label;
    get.mockImplementation(serve(legacy));
    routeLive();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
    expect(screen.getByText('Organiza Club Campestre Demo')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Copas' }));
    expect(screen.getByRole('region', { name: 'Fase final' })).toBeTruthy();
    expect(screen.getAllByTestId('team-avatar').length).toBeGreaterThan(0);
  });

  it('404 muestra estado vacío', async () => {
    get.mockRejectedValue(Object.assign(new Error('x'), { status: 404 }));
    routeLive('/torneo/no/en-vivo');
    await waitFor(() => expect(screen.getByText(/No encontramos este torneo/)).toBeTruthy());
  });
});

describe('<TournamentMatchPage />', () => {
  it('marcador, sets en cuadrícula y el panel social de «vivo» aunque falle (una sola barra de pestañas)', async () => {
    get.mockImplementation(serve(clone()));
    routeLive('/torneo/copa/partido/m11');
    await waitFor(() => expect(screen.getByTestId('match-detail')).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Campestre Cóndores vs EDF La Calera');
    expect(screen.getByLabelText('Marcador 1 a 0')).toBeTruthy();
    expect(screen.getByText('14').className).toMatch(/border-red-500/);
    await waitFor(() => expect(screen.getByText(/No pudimos cargar/)).toBeTruthy());
    expect(screen.queryByRole('tablist', { name: 'Secciones del partido' })).toBeNull();
  });
  it('comentarios llegan del endpoint social', async () => {
    get.mockImplementation(serve(clone(), { '/social': {
      comments: [{ id: 'k1', author_name: 'Familia Rojas', body: '¡Vamos Cóndores!', created_at: '2026-10-31T15:00:00Z', verified: false }],
      media: [], mvp: { available: false, voting_open: false, candidates: [], votes: {}, total: 0, winner: null }, player_stats: [],
    } }));
    routeLive('/torneo/copa/partido/m11');
    await waitFor(() => screen.getByTestId('match-detail'));
    fireEvent.click(screen.getByRole('tab', { name: 'Comentarios' }));
    await waitFor(() => expect(screen.getByText('¡Vamos Cóndores!')).toBeTruthy());
  });
  it('un partido jugado ofrece «Compartir resultado»', async () => {
    get.mockImplementation(serve(clone()));
    routeLive('/torneo/copa/partido/m1');
    await waitFor(() => screen.getByTestId('match-detail'));
    expect(screen.getByRole('button', { name: /Compartir resultado/ })).toBeTruthy();
  });
});

describe('<TournamentEmbedPage />', () => {
  it('sin encabezado ni pestañas, con la vista y categoría pedidas', async () => {
    get.mockImplementation(serve(clone()));
    routeLive('/torneo/copa/embed?vista=copas&categoria=c2&fondo=transparente');
    await waitFor(() => expect(screen.getByTestId('embed')).toBeTruthy());
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByTestId('champion').textContent).toContain('Campestre Titanes');
    expect(screen.getByText('Powered by SportMaps')).toBeTruthy();
    expect(document.body.style.background).toBe('transparent');
  });
  it('vista desconocida cae en posiciones', async () => {
    get.mockImplementation(serve(clone()));
    routeLive('/torneo/copa/embed?vista=otra');
    await waitFor(() => expect(screen.getByTestId('embed')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Grupo A' })).toBeTruthy();
  });
});

describe('<TournamentTvPage />', () => {
  it('rota sola sin interacción y siempre dice Powered by SportMaps', async () => {
    get.mockImplementation(serve(clone()));
    routeLive('/torneo/copa/tv');
    await waitFor(() => expect(screen.getByTestId('tv')).toBeTruthy());
    expect(screen.getByText('En vivo', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/Powered by SportMaps/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
