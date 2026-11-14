/**
 * Integración de los bloques M6 (b, c, d, e, f, g, h) en la pizarra: lo que
 * solo aparece cuando conviven dos bloques.
 *
 *  - M6c + M6g: la nota del cuadro y el dueño del balón sobreviven juntos.
 *  - M6d + M6b: la pseudo-figura `court` no corre la numeración de rivales.
 *  - M6g + M6e: la curva de velocidad llega a la carrera y al balón del 3D;
 *    el balón del 3D sigue la posesión.
 *  - M6f + M6e: netball usa el aro, rugby los palos.
 *  - M6e: el video del 3D respeta la marca blanca.
 *  - M6c + M6h: un solo diálogo «Videos» con pestañas Enlaces / Subir.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import { hydrateFrames, serializeFrames } from '@/lib/school/tacticalAnimation';
import { applyCurve } from '@/lib/school/tacticalBoardSettings';
import { court3D } from '@/lib/school/tactical3d';
import { ballArc, curveDeriv, frameBallPct, playerMotion } from '@/lib/school/tactical3dMotion';
import { cameraKindLabel } from '@/lib/school/tactical3dCameras';
import { defaultTeamsConfig } from '@/lib/school/tacticalTeams';
import { TacticalStaticSvg } from '@/components/school/TacticalStaticSvg';
import { showsSportmapsWatermark } from '@/hooks/useSportmapsWatermark';
import { PlayVideosDialog } from '@/components/school/tacticalMedia/PlayVideosDialog';

vi.mock('@/lib/api/bffClient', () => ({ bffClient: { get: vi.fn(), post: vi.fn() }, BFFError: class extends Error {} }));
vi.mock('@/lib/school/tacticalSavedVideos', () => ({
  useSavedVideos: () => ({ isLoading: false, data: { available: true, videos: [] } }),
  useSaveVideo: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteSavedVideo: () => ({ mutate: vi.fn() }),
}));

const frame = (id: string, x: number, extra: Partial<TacticalFrame> = {}): TacticalFrame => ({
  id, duration_ms: 1000, ball: null, arrows: [],
  players: [{ key: 'slot:A', x, y: 50 }, { key: 'slot:B', x: 80, y: 20 }],
  ...extra,
});

describe('M6c + M6g: nota del cuadro y dueño del balón', () => {
  it('serializar e hidratar conserva los dos', () => {
    const frames = [frame('a', 20, { note: 'Salida corta', ball_owner: 'slot:A' }), frame('b', 40, { ball_owner: 'slot:B' })];
    const back = hydrateFrames(serializeFrames(frames));
    expect(back?.[0].note).toBe('Salida corta');
    expect(back?.[0].ball_owner).toBe('slot:A');
    expect(back?.[1].ball_owner).toBe('slot:B');
  });
});

describe('M6d + M6b: rivales numerados con «Campo»', () => {
  it('la pseudo-figura court (horizontal) no cambia el número de los rivales', () => {
    const teams = { ...defaultTeamsConfig(), away: { ...defaultTeamsConfig().away, roster: [{ number: 9, alias: 'Nueve' }, { number: 10, alias: 'Diez' }] } };
    const rivals = [
      { type: 'opponent' as const, x1: 30, y1: 40, x2: 30, y2: 40 },
      { type: 'opponent' as const, x1: 60, y1: 40, x2: 60, y2: 40 },
    ];
    const withCourt = [{ type: 'court' as const, x1: 0, y1: 0, x2: 0, y2: 0, court: { orient: 'h' as const } }, ...rivals];
    const plain = renderToStaticMarkup(<TacticalStaticSvg players={[]} arrows={rivals} teams={teams} />);
    const camp = renderToStaticMarkup(<TacticalStaticSvg players={[]} arrows={withCourt} teams={teams} />);
    for (const html of [plain, camp]) {
      expect(html).toContain('>9<');
      expect(html).toContain('>10<');
    }
    expect(camp).toContain('data-orient="h"');
  });
});

describe('M6g + M6e: la curva y la posesión llegan al 3D', () => {
  const court = court3D('futbol');
  const frames = [frame('a', 20), frame('b', 60)];

  it('curveDeriv es la derivada de applyCurve', () => {
    for (const c of ['suave', 'lineal', 'rapida_inicio', 'rapida_final'] as const) {
      for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const h = 1e-4;
        const num = (applyCurve(c, p + h) - applyCurve(c, p - h)) / (2 * h);
        expect(curveDeriv(c, p)).toBeCloseTo(num, 2);
      }
    }
  });

  it('rápida al inicio: el jugador corre más al principio que con la lineal', () => {
    const fast = playerMotion(court, frames, 'slot:A', 100, 1, 'rapida_inicio').speed;
    const lin = playerMotion(court, frames, 'slot:A', 100, 1, 'lineal').speed;
    expect(fast).toBeGreaterThan(lin * 2);
    // Sin curva = la de siempre (suave).
    expect(playerMotion(court, frames, 'slot:A', 500).speed).toBeCloseTo(playerMotion(court, frames, 'slot:A', 500, 1, 'suave').speed, 6);
  });

  it('el balón del 3D sale de los pies del dueño (posesión) y su parábola usa la curva', () => {
    const owned = frame('a', 20, { ball_owner: 'slot:A' });
    const at = frameBallPct(owned)!;
    expect(Math.abs(at.x - 20)).toBeLessThan(5);
    const far = [frame('a', 10, { ball: { x: 10, y: 95 } }), frame('b', 10, { ball: { x: 90, y: 5 } })];
    const main = { fromIndex: 0, toIndex: 1, progress: 0.25 };
    expect(ballArc(court, far, main, 'lineal').lift).not.toBeCloseTo(ballArc(court, far, main, 'suave').lift, 3);
  });
});

describe('M6f + M6e: rótulos de las cámaras por deporte', () => {
  it('netball usa el aro (como básquet) y rugby los palos', () => {
    expect(cameraKindLabel('detras', 'netball')).toBe('Detrás del aro');
    expect(cameraKindLabel('rival', 'netball')).toBe('Bajo el aro rival');
    expect(cameraKindLabel('detras', 'rugby')).toBe('Detrás de los palos');
    expect(cameraKindLabel('rival', 'futbol_americano')).toBe('Bajo los palos rivales');
    expect(cameraKindLabel('detras', 'ultimate')).toBe('Fondo propio');
  });
});

describe('M6e: «Powered by SportMaps» en el video del 3D', () => {
  it('siempre, salvo marca blanca nativa con la marca apagada', () => {
    expect(showsSportmapsWatermark(false, false)).toBe(true); // logo propio sin marca blanca: sigue
    expect(showsSportmapsWatermark(false, undefined)).toBe(true);
    expect(showsSportmapsWatermark(true, true)).toBe(true);
    expect(showsSportmapsWatermark(true, undefined)).toBe(true);
    expect(showsSportmapsWatermark(true, false)).toBe(false);
  });
});

describe('M6c + M6h: un solo diálogo «Videos»', () => {
  it('con el panel de subidos: pestañas Enlaces y Subir', () => {
    render(<PlayVideosDialog open onOpenChange={() => {}} readOnly={false} videos={[]} onSave={() => {}}
      uploadPanel={<div>Panel de subidos</div>} />);
    expect(screen.getByRole('tab', { name: 'Enlaces' })).toBeTruthy();
    const subir = screen.getByRole('tab', { name: 'Subir' });
    expect(screen.getByLabelText('Enlace del video')).toBeTruthy();
    fireEvent.mouseDown(subir);
    fireEvent.click(subir);
    expect(screen.getByText('Panel de subidos')).toBeTruthy();
  });

  it('sin el panel: solo enlaces, sin pestañas', () => {
    render(<PlayVideosDialog open onOpenChange={() => {}} readOnly={false} videos={[]} onSave={() => {}} />);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByLabelText('Enlace del video')).toBeTruthy();
  });
});
