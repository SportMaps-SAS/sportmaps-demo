/**
 * Paquete de arreglos de la pizarra (2026-10-27) montado en la pizarra:
 * contador «En cancha · Banco», «Pídele una jugada a la IA», Dibujar sin
 * «Activar dibujo», Exportar con la cancha vacía y la pizarra libre (/pizarra).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { LineupDetail } from '@/lib/school/footballQueries';
import { EMPTY_BOARD_REASON } from '@/lib/school/tacticalBoardUx';

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => ({
  lineup: null as unknown,
  lineupsParams: [] as unknown[],
  save: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a) },
}));
vi.mock('@/hooks/useFootballData', () => ({
  useFootballLineups: (p: unknown) => { h.lineupsParams.push(p); return { data: h.lineup ? [{ id: 'L1' }] : [], isLoading: false }; },
  useFootballLineup: () => ({ data: h.lineup ?? undefined, isLoading: false }),
  useSaveFootballLineup: () => ({ mutateAsync: h.save, isPending: false }),
  useTacticalPresets: () => ({ data: [] }),
  useCreateTacticalPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateTacticalPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteTacticalPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useFootballEvents: () => ({ data: [] }),
  useFootballSeasonStats: () => ({ data: { team_id: 't1', stats: [] } }),
}));
vi.mock('@/hooks/usePerformanceData', () => ({
  useTeamPerformanceRoster: () => ({
    data: {
      sport_category_id: null, metrics: [], latest_values: {},
      subjects: [
        { subject_type: 'child', subject_id: 'a', full_name: 'Ana Pérez' },
        { subject_type: 'child', subject_id: 'b', full_name: 'Beto Ruiz' },
        { subject_type: 'child', subject_id: 'c', full_name: 'Caro Díaz' },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useTeamTacticalSport', () => ({ useTeamTacticalSport: () => ({ sport: 'futbol', schoolId: 'school-1', isLoading: false }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ currentUserRole: 'coach', schoolId: 'school-1' }) }));
vi.mock('@/hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => undefined }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false, useCompactLandscape: () => false }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));

import { TacticalBoard } from '@/components/school/TacticalBoard';
import { TooltipProvider } from '@/components/ui/tooltip';

const lineupWith3 = (): LineupDetail => ({
  id: 'L1', team_id: 't1', source_type: 'training_session', source_id: 's1', formation: null,
  arrows: [], created_by: 'u', created_at: '', updated_at: '',
  players: ['a', 'b', 'c'].map((id, i) => ({
    id: `p${i}`, subject_type: 'child', subject_id: id, role: 'starter', slot_label: 'Medio', x: 20 + i * 20, y: 50, jersey_number: i + 1,
  })),
});

// En la app hay un TooltipProvider global (el ítem de video apagado lleva tooltip).
const board = (over: { scratch?: boolean } = {}) => (
  <TooltipProvider>
    <TacticalBoard open onClose={vi.fn()} teamId="t1" teamName="Sub 11" sourceType="training_session"
      sourceId={over.scratch ? '' : 's1'} contextLabel="Entrenamiento" scratch={over.scratch} />
  </TooltipProvider>
);

const openMenu = (name: string | RegExp) => {
  const trigger = screen.getByRole('button', { name });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
};

beforeEach(() => {
  h.lineup = null;
  h.lineupsParams = [];
  h.save = vi.fn().mockResolvedValue({});
  h.rpc = vi.fn().mockResolvedValue({ data: true, error: null });
});

describe('6 · contador de jugadores', () => {
  it('cancha vacía: «En cancha 0 · Banco 3»', () => {
    render(board());
    expect(screen.getByTestId('tb-roster-counts').textContent).toBe('En cancha 0 · Banco 3');
  });
  it('con los 3 en cancha: «En cancha 3 · Banco 0»', () => {
    h.lineup = lineupWith3();
    render(board());
    expect(screen.getByTestId('tb-roster-counts').textContent).toBe('En cancha 3 · Banco 0');
  });
});

describe('7 · «Empieza aquí» → IA', () => {
  it('«Pídele una jugada a la IA» abre el panel de IA', () => {
    render(board());
    const hint = screen.getByRole('region', { name: 'Empieza aquí' });
    fireEvent.click(within(hint).getByTestId('hint-ask-ai'));
    expect(screen.queryByRole('region', { name: 'Empieza aquí' })).toBeNull();
    const ai = screen.getAllByRole('button', { pressed: true }).find((b) => /Analizar jugada|IA/.test(b.textContent ?? ''));
    expect(ai).toBeTruthy();
  });
});

describe('9 · Dibujar sin «Activar dibujo»', () => {
  it('al abrir Dibujar el modo dibujo ya está prendido; al cerrarlo se apaga', () => {
    h.lineup = lineupWith3();
    render(board());
    fireEvent.click(screen.getByRole('button', { name: /^Dibujar/ }));
    expect(screen.getByRole('button', { name: /Dibujando/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Dibujar/ }));
    expect(screen.queryByRole('button', { name: /Dibujando/ })).toBeNull();
  });
});

describe('12 · Exportar', () => {
  it('cancha vacía: PNG y PDF apagados con el motivo', () => {
    render(board());
    const menu = openMenu('Exportar la jugada');
    const png = within(menu).getByRole('menuitem', { name: /Imagen \(PNG\)/ });
    expect(png.getAttribute('aria-disabled')).toBe('true');
    expect(png.textContent).toContain(EMPTY_BOARD_REASON);
    expect(within(menu).getByRole('menuitem', { name: /Ficha del ejercicio/ }).getAttribute('aria-disabled')).toBe('true');
  });
  it('con jugadores y un cuadro: el video lleva a «+ Cuadro»', () => {
    h.lineup = lineupWith3();
    render(board());
    const menu = openMenu('Exportar la jugada');
    expect(within(menu).getByRole('menuitem', { name: /Imagen \(PNG\)/ }).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(within(menu).getByTestId('export-add-frame'));
    expect(screen.getAllByRole('listitem', { name: /^Cuadro \d+$/ })).toHaveLength(2);
  });
});

describe('Pizarra libre (/pizarra)', () => {
  it('no carga alineación y «Guardar» ofrece Mis jugadas o una sesión', () => {
    render(board({ scratch: true }));
    expect(h.lineupsParams.every((p) => JSON.stringify(p) === '{}')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Guardar jugada' })).toBeNull();
    const menu = openMenu(/^Guardar/);
    expect(within(menu).getByRole('menuitem', { name: /Guardar en mis jugadas/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Agregar a una sesión/ })).toBeTruthy();
    expect(h.save).not.toHaveBeenCalled();
  });
});
