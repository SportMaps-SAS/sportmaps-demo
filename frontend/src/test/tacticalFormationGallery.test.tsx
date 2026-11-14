/**
 * M6a: galería de formaciones — rival en espejo (lógica pura) y el componente
 * FormationGallery (render, filtro, elegir para mi equipo o para el rival).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { TacticalArrow } from '@/lib/school/footballQueries';
import { boardSportConfig } from '@/lib/school/tacticalBoardSport';
import { formationByKey } from '@/lib/school/tacticalFormations';
import { SPORTS } from '@/lib/school/tacticalSports';
import {
  countRivals, filterFormations, formationGroups, galleryFormations, mirrorPoint, playerCounts, removeRivalShapes,
  replaceRivalShapes, rivalShapesFor,
} from '@/lib/school/tacticalFormationGallery';
import { FormationGallery } from '@/components/school/FormationGallery';

vi.setConfig({ testTimeout: 30_000 });

describe('rival en espejo', () => {
  it('giro de 180°: el arquero rival queda arriba y su izquierda en nuestra derecha', () => {
    const f = formationByKey('4-4-2');
    const shapes = rivalShapesFor(f);
    expect(shapes).toHaveLength(11);
    expect(shapes.every((s) => s.type === 'opponent' && s.x1 === s.x2 && s.y1 === s.y2)).toBe(true);
    // Arquero propio abajo (y 92) → rival arriba (y 8).
    expect(shapes[0]).toMatchObject({ x1: 50, y1: 8 });
    // Lateral izq. propio en x 14 → el del rival en x 86.
    const li = f.slots.findIndex((s) => s.label === 'Lateral izq.');
    expect(shapes[li].x1).toBe(86);
    // Lo que en el equipo propio está en su mitad (abajo), en el rival queda arriba.
    f.slots.forEach((slot, i) => { if (slot.y > 50) expect(shapes[i].y1).toBeLessThan(50); });
    expect(mirrorPoint(mirrorPoint({ x: 12.3, y: 77.7 }))).toEqual({ x: 12.3, y: 77.7 });
  });

  it('el espejo de cualquier formación de cualquier deporte cae dentro de su cancha', () => {
    for (const def of Object.values(SPORTS)) {
      for (const f of def.formations) {
        for (const s of rivalShapesFor(f)) {
          expect(s.x1).toBeGreaterThanOrEqual(def.court.x0 - 0.6);
          expect(s.x1).toBeLessThanOrEqual(def.court.x1 + 0.6);
          expect(s.y1).toBeGreaterThanOrEqual(def.court.y0 - 0.6);
          expect(s.y1).toBeLessThanOrEqual(def.court.y1 + 0.6);
        }
      }
    }
  });

  it('cambiar la formación del rival reemplaza a los rivales y no toca el resto de figuras', () => {
    const arrow: TacticalArrow = { type: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, color: 'white' };
    const cone: TacticalArrow = { type: 'cone', x1: 5, y1: 5, x2: 5, y2: 5 };
    const loose: TacticalArrow = { type: 'opponent', x1: 40, y1: 40, x2: 40, y2: 40 };
    const once = replaceRivalShapes([arrow, loose, cone], formationByKey('4-3-3'));
    expect(once.slice(0, 2)).toEqual([arrow, cone]);
    expect(countRivals(once)).toBe(11);
    const twice = replaceRivalShapes(once, formationByKey('3-5-2'));
    expect(countRivals(twice)).toBe(11);
    expect(twice).toHaveLength(13);
    expect(removeRivalShapes(twice)).toEqual([arrow, cone]);
  });
});

describe('filtros de la galería', () => {
  const futbol = boardSportConfig('futbol').formations;
  it('familias en orden y jugadores', () => {
    expect(formationGroups(futbol).slice(0, 2)).toEqual(['Clásicas', 'Modernas']);
    expect(formationGroups(futbol)).toEqual(expect.arrayContaining(['Defensivas', 'Ofensivas', 'Históricas']));
    expect(playerCounts(futbol)).toEqual([11, 7]);
  });
  it('texto sin tildes, «433» encuentra «4-3-3», por familia y por jugadores', () => {
    expect(filterFormations(futbol, { query: '433' }).map((f) => f.key)).toContain('4-3-3');
    expect(filterFormations(futbol, { query: 'piramide' }).map((f) => f.key)).toEqual(['2-3-5']);
    expect(filterFormations(futbol, { query: 'rombo' }).map((f) => f.key)).toEqual(expect.arrayContaining(['4-1-2-1-2', '3-4-3-rombo']));
    expect(filterFormations(futbol, { players: 7 }).map((f) => f.key)).toEqual(['f7-2-3-1']);
    const hist = filterFormations(futbol, { group: 'Históricas' });
    expect(hist.length).toBeGreaterThanOrEqual(5);
    expect(hist.every((f) => f.group === 'Históricas')).toBe(true);
  });
});

function renderGallery(sport: 'futbol' | 'voleibol' | 'baloncesto' = 'futbol', rivalCount = 0, initialPlayers: number | null = null) {
  const props = {
    onApplyOwn: vi.fn(),
    onApplyRival: vi.fn(),
    onClearRival: vi.fn(),
  };
  const formations = boardSportConfig(sport).formations;
  render(
    <FormationGallery sport={sport} formations={formations} currentKey={null} rivalCount={rivalCount} initialPlayers={initialPlayers} {...props} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Formación/ }));
  const dialog = screen.getByRole('dialog');
  // Fútbol 11 suma en la galería las de F7 y F5 (llevadas a la cancha grande).
  return { ...props, dialog, formations: galleryFormations(sport, formations) };
}

describe('FormationGallery', () => {
  it('abre con todas las tarjetas, miniatura con un punto por jugador y familias', () => {
    const { dialog, formations } = renderGallery();
    const cards = dialog.querySelectorAll('[data-formation-key]');
    expect(cards).toHaveLength(formations.length);
    const card = dialog.querySelector('[data-formation-key="4-2-3-1"]')!;
    expect(card.querySelectorAll('circle')).toHaveLength(11);
    expect(within(dialog).getByRole('region', { name: 'Históricas' })).toBeTruthy();
    // Botones de al menos 44 px (clase) para el celular.
    expect(card.className).toContain('min-h-[44px]');
  });

  it('buscar y filtrar por familia y jugadores', () => {
    const { dialog } = renderGallery();
    fireEvent.change(within(dialog).getByLabelText('Buscar formación'), { target: { value: '4-2-3-1' } });
    const keys = [...dialog.querySelectorAll('[data-formation-key]')].map((e) => e.getAttribute('data-formation-key'));
    expect(keys).toEqual(['4-2-3-1', '4-2-3-1-estrecho']);
    fireEvent.change(within(dialog).getByLabelText('Buscar formación'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '7 jugadores' }));
    const sevens = galleryFormations('futbol', boardSportConfig('futbol').formations).filter((f) => f.players === 7);
    expect(dialog.querySelectorAll('[data-formation-key]')).toHaveLength(sevens.length);
    expect(sevens.length).toBeGreaterThan(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Todos' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Históricas' }));
    const hist = [...dialog.querySelectorAll('[data-formation-key]')].map((e) => e.getAttribute('data-formation-key'));
    expect(hist).toContain('3-2-2-3');
    expect(hist).not.toContain('4-3-3');
  });

  it('cancha en F7: abre filtrada a 7 y el subtítulo lo dice («Todos» quita el filtro)', () => {
    const { dialog, formations } = renderGallery('futbol', 0, 7);
    const sevens = formations.filter((f) => f.players === 7);
    expect(dialog.querySelectorAll('[data-formation-key]')).toHaveLength(sevens.length);
    expect(within(dialog).getByText(new RegExp(`^${sevens.length} formaciones de Fútbol 7`))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Todos' }));
    expect(dialog.querySelectorAll('[data-formation-key]')).toHaveLength(formations.length);
  });

  it('elegir para mi equipo llama onApplyOwn con la formación y cierra', () => {
    const { dialog, onApplyOwn, onApplyRival } = renderGallery();
    fireEvent.click(within(dialog).getByRole('button', { name: '4-2-3-1' }));
    expect(onApplyOwn).toHaveBeenCalledTimes(1);
    expect(onApplyOwn.mock.calls[0][0].key).toBe('4-2-3-1');
    expect(onApplyRival).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pestaña Rival: miniaturas rojas en espejo, onApplyRival y «Quitar rival»', () => {
    const { dialog, onApplyOwn, onApplyRival, onClearRival } = renderGallery('futbol', 11);
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Rival' }));
    const card = dialog.querySelector('[data-formation-key="4-4-2"]')!;
    const circles = [...card.querySelectorAll('circle')];
    expect(circles.every((c) => c.getAttribute('fill') === '#dc2626')).toBe(true);
    // El arquero rival (primer punto) arriba: y = 8 % de 340.
    expect(Number(circles[0].getAttribute('cy'))).toBeCloseTo(8 * 3.4, 5);
    expect(within(dialog).getByText(/Hoy hay 11 en la cancha/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '4-4-2' }));
    expect(onApplyRival).toHaveBeenCalledTimes(1);
    expect(onApplyRival.mock.calls[0][0].key).toBe('4-4-2');
    expect(onApplyOwn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Formación/ }));
    const d2 = screen.getByRole('dialog');
    fireEvent.click(within(d2).getByRole('tab', { name: 'Rival' }));
    fireEvent.click(within(d2).getByRole('button', { name: /Quitar rival/ }));
    expect(onClearRival).toHaveBeenCalledTimes(1);
  });

  it('voleibol muestra las rotaciones y baloncesto las zonas', () => {
    const { dialog } = renderGallery('voleibol');
    expect(within(dialog).getByRole('region', { name: 'Rotaciones 5-1' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '5-1 · R1 recepción' })).toBeTruthy();
  });

  it('baloncesto: zonas y presiones', () => {
    const { dialog } = renderGallery('baloncesto');
    expect(within(dialog).getByRole('region', { name: 'Zonas' })).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Presiones' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Zona 2-3' })).toBeTruthy();
  });
});
