/**
 * Visor 3D, M6e (docs/specs/pizarra-m6e-camaras-3d.md): cámaras por deporte,
 * seguimiento suave, director automático, transiciones, arco del balón,
 * carrera de las figuras y sincronía con el 2D. Lógica pura.
 */
import { describe, expect, it } from 'vitest';
import { BOARD_H, BOARD_W, TACTICAL_SPORTS, type TacticalSport } from '@/lib/school/tacticalSports';
import { computeLive, court3D, EYE_HEIGHT_M, figureScale, fixedCameraPose, toMeters, type Court3D, type Vec3 } from '@/lib/school/tactical3d';
import {
  ballCamOffsets, blendPose, CAMERA_KINDS, cameraKindLabel, cameraPose, createDirector, directorShot, DRONE_PERIOD_S,
  finishZoneM, longPassM, resolveCameraKind, smoothAngle, smoothToward, spiderHeightM, transitionMs, tvPanLimitM,
  type CameraContext, type CameraKind,
} from '@/lib/school/tactical3dCameras';
import {
  arcApexM, arcCapM, ballArc, ballHeadingAt, DEFAULT_HEADING, frameIndexAt, gaitOf, liveBallPct, loftThresholdM, MAX_CADENCE_HZ,
  playerMotion, replayRange, spotlightKey, stepFrame, trailPoints, VIEWER_SPEEDS,
} from '@/lib/school/tactical3dMotion';
import { easeInOutCubic, interpolateFrames, totalDurationMs } from '@/lib/school/tacticalAnimation';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Metros → % del tablero (inversa de toMeters). */
const pct = (c: Court3D, x: number, z: number) => ({
  x: ((x * c.sx + BOARD_W / 2) / BOARD_W) * 100,
  y: ((z * c.sy + BOARD_H / 2) / BOARD_H) * 100,
});

function frame(id: string, c: Court3D, players: Record<string, [number, number]>, ball: [number, number] | null, ms = 1000): TacticalFrame {
  return {
    id,
    duration_ms: ms,
    players: Object.entries(players).map(([key, [x, z]]) => ({ key, ...pct(c, x, z) })),
    ball: ball ? pct(c, ball[0], ball[1]) : null,
    arrows: [],
  };
}

const ctxOf = (court: Court3D, extra: Partial<CameraContext> = {}): CameraContext => ({
  court, aspect: 16 / 9, fovDeg: 45, ball: { x: 0, y: 0.2, z: 0 }, player: null, playerView: 'pov', elapsedS: 0, ...extra,
});

const finite = (p: Vec3) => [p.x, p.y, p.z].every(Number.isFinite);

// ─── Catálogo y rótulos ─────────────────────────────────────────────────────

describe('cámaras: catálogo y nombres por deporte', () => {
  it('las 11 cámaras, en el orden de los botones', () => {
    expect(CAMERA_KINDS).toEqual(['tv', 'tactica', 'cenital', 'iso', 'detras', 'rival', 'balon', 'jugador', 'spider', 'dron', 'libre']);
  });

  it('arco / aro / fondo según el deporte', () => {
    expect(cameraKindLabel('detras', 'futbol')).toBe('Detrás del arco');
    // «Detrás del arco» y la del rival ya no son espejo: la del rival es la toma baja del arquero.
    expect(cameraKindLabel('rival', 'futbol')).toBe('Ojos del arquero rival');
    expect(cameraKindLabel('rival', 'balonmano')).toBe('Ojos del arquero rival');
    expect(cameraKindLabel('detras', 'baloncesto')).toBe('Detrás del aro');
    expect(cameraKindLabel('rival', 'baloncesto')).toBe('Bajo el aro rival');
    expect(cameraKindLabel('detras', 'voleibol')).toBe('Fondo propio');
    expect(cameraKindLabel('rival', 'voleibol')).toBe('Fondo rival, a ras');
    expect(cameraKindLabel('tv', 'voleibol')).toBe('Transmisión TV');
    expect(cameraKindLabel('spider', 'futbol')).toBe('Spider-cam');
  });

  it('«Seguir jugador» sin elegido sigue al primero; sin jugadores, TV', () => {
    expect(resolveCameraKind('jugador', 'b', ['a', 'b'])).toEqual({ kind: 'jugador', playerKey: 'b' });
    expect(resolveCameraKind('jugador', 'zz', ['a', 'b'])).toEqual({ kind: 'jugador', playerKey: 'a' });
    expect(resolveCameraKind('jugador', null, [])).toEqual({ kind: 'tv', playerKey: null });
    expect(resolveCameraKind('tv', 'a', ['a'])).toEqual({ kind: 'tv', playerKey: 'a' });
  });
});

// ─── Poses por deporte ──────────────────────────────────────────────────────

describe.each(['futbol', 'voleibol', 'baloncesto'] as TacticalSport[])('poses en %s', (sport) => {
  const c = court3D(sport);
  const W = c.widthM;
  const L = c.lengthM;
  const halfV = Math.tan((22.5 * Math.PI) / 180);

  it('todas las cámaras (menos Libre) dan una pose finita por encima del piso', () => {
    for (const k of CAMERA_KINDS) {
      const pose = cameraPose(k, ctxOf(c, { player: { x: 1, z: 2, heading: Math.PI } }));
      if (k === 'libre') { expect(pose).toBeNull(); continue; }
      expect(pose, k).not.toBeNull();
      expect(finite(pose!.position) && finite(pose!.target), k).toBe(true);
      expect(pose!.position.y, k).toBeGreaterThan(0.5);
      const d = Math.hypot(pose!.position.x - pose!.target.x, pose!.position.y - pose!.target.y, pose!.position.z - pose!.target.z);
      expect(d, k).toBeGreaterThan(0.5);
    }
  });

  it('Transmisión TV: desde la banda, elevada, y PANEA siguiendo el balón a lo largo (con tope)', () => {
    const mid = cameraPose('tv', ctxOf(c))!;
    expect(mid.position.x).toBeLessThan(-W / 2);
    const elev = Math.atan2(mid.position.y - mid.target.y, Math.hypot(mid.position.x - mid.target.x, mid.position.z - mid.target.z));
    close(elev, (30 * Math.PI) / 180, 1e-6);
    const lim = tvPanLimitM(c);
    const fwd = cameraPose('tv', ctxOf(c, { ball: { x: 0, y: 0.2, z: -L / 2 } }))!;
    close(fwd.target.z, -lim);
    if (lim > 0) expect(fwd.position.z).toBeLessThan(mid.position.z);
    // La cámara no se mueve a lo ancho aunque el balón vaya a la otra banda.
    const side = cameraPose('tv', ctxOf(c, { ball: { x: W / 2, y: 0.2, z: 0 } }))!;
    close(side.position.x, mid.position.x);
  });

  it('Táctica alta = la tribuna de M4 (cancha entera)', () => {
    expect(cameraPose('tactica', ctxOf(c))).toEqual(fixedCameraPose(c, 'tribuna', 16 / 9, 45));
  });

  it('Cenital: arriba del centro, con la cancha entera en cuadro y el arco rival arriba', () => {
    const p = cameraPose('cenital', ctxOf(c))!;
    expect(p.position.x).toBe(0);
    expect(p.position.z).toBeGreaterThan(0);
    expect(p.position.z / p.position.y).toBeLessThan(0.02);
    expect(p.position.y * halfV).toBeGreaterThanOrEqual(L / 2);
    expect(p.target).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('Isométrica: desde la esquina propia-izquierda a 45° y 35,26°', () => {
    const p = cameraPose('iso', ctxOf(c))!;
    expect(p.position.x).toBeLessThan(0);
    expect(p.position.z).toBeGreaterThan(0);
    close(-p.position.x, p.position.z, 1e-9);
    const el = Math.atan2(p.position.y, Math.hypot(p.position.x, p.position.z));
    close(el, Math.atan(1 / Math.SQRT2), 1e-9);
    // La cancha entera entra (radio de la planta).
    expect(Math.hypot(p.position.x, p.position.y, p.position.z) * halfV).toBeGreaterThan(0.5 * Math.hypot(W, L) * 0.9);
  });

  it('Detrás del arco/aro propio (+z) y del rival (−z), mirándose', () => {
    const own = cameraPose('detras', ctxOf(c))!;
    const riv = cameraPose('rival', ctxOf(c))!;
    expect(own.position.z).toBeGreaterThan(L / 2 - 1);
    expect(riv.position.z).toBeLessThan(-(L / 2 - 1));
    expect(own.target.z).toBeLessThan(own.position.z);
    expect(riv.target.z).toBeGreaterThan(riv.position.z);
    // Ya no son espejo: la del rival es BAJA (ojos del arquero) y mira a la zona de definición.
    expect(riv.position.y).toBeLessThan(own.position.y);
    expect(riv.position.y).toBeLessThan(Math.max(4, L * 0.05));
    expect(riv.target.z).toBeLessThan(0);
  });

  it('Detrás del arco mira más allá del medio campo (menos césped vacío delante)', () => {
    const own = cameraPose('detras', ctxOf(c))!;
    if (sport === 'baloncesto') return; // el aro tiene su propia toma
    expect(own.target.z).toBeLessThan(0);
  });

  it('Seguir balón mira bien adelante del balón', () => {
    const ball = { x: 0, y: 0.2, z: 0 };
    const p = cameraPose('balon', ctxOf(c, { ball }))!;
    const { back } = ballCamOffsets(c);
    close(p.target.z, -back * 0.8, 1e-9);
  });

  it('Seguir balón: detrás del balón (+z) y mirando hacia el ataque (−z)', () => {
    const ball = { x: 2, y: 0.2, z: 5 };
    const p = cameraPose('balon', ctxOf(c, { ball }))!;
    expect(p.position.z).toBeGreaterThan(ball.z);
    expect(p.target.z).toBeLessThan(ball.z);
    expect(p.position.y).toBeGreaterThan(2.9);
    // Balón que viaja hacia el arco propio (+z, heading 0): la cámara se pone detrás (−z).
    const back = cameraPose('balon', ctxOf(c, { ball, ballHeading: 0 }))!;
    expect(back.position.z).toBeLessThan(ball.z);
    expect(back.target.z).toBeGreaterThan(ball.z);
  });

  it('TV con el balón alto: lo sigue a media altura (no se sale del cuadro)', () => {
    const low = cameraPose('tv', ctxOf(c, { ball: { x: 0, y: 0.2, z: 0 } }))!;
    const high = cameraPose('tv', ctxOf(c, { ball: { x: 0, y: 6, z: 0 } }))!;
    close(high.target.y - low.target.y, 2.9, 1e-9);
    close(high.position.y - low.position.y, 2.9, 1e-9);
  });

  it('Seguir jugador: sus ojos (POV) y detrás de él según hacia dónde mira (3ª persona)', () => {
    const s = figureScale(c);
    const player = { x: 1, z: 3, heading: 0 }; // mira hacia +z
    const pov = cameraPose('jugador', ctxOf(c, { player, ball: { x: 1, y: 0.2, z: -6 } }))!;
    expect(pov.position).toEqual({ x: 1, y: EYE_HEIGHT_M * s, z: 3 });
    const tp = cameraPose('jugador', ctxOf(c, { player, playerView: 'tercera' }))!;
    expect(tp.position.z).toBeLessThan(player.z); // detrás (mira a +z)
    expect(tp.target.z).toBeGreaterThan(player.z);
    // Sin jugador cae a TV.
    expect(cameraPose('jugador', ctxOf(c, { player: null }))).toEqual(cameraPose('tv', ctxOf(c)));
  });

  it('Spider-cam: alta sobre la jugada, adelantada al balón', () => {
    const ball = { x: 3, y: 0.2, z: -4 };
    const p = cameraPose('spider', ctxOf(c, { ball }))!;
    close(p.position.y, spiderHeightM(c));
    expect(p.target.x).toBe(3);
    expect(p.target.z).toBe(-4);
    expect(p.position.z).toBeGreaterThan(ball.z);
    // Balón alto (vóley): sube para quedar siempre 7 m por encima.
    const high = cameraPose('spider', ctxOf(c, { ball: { x: 0, y: 6, z: 0 } }))!;
    expect(high.position.y).toBeGreaterThanOrEqual(13);
  });

  it('Dron: órbita de radio fijo que arranca en la banda izquierda y vuelve a los 48 s', () => {
    const at = (s: number) => cameraPose('dron', ctxOf(c, { elapsedS: s }))!.position;
    const p0 = at(0);
    expect(p0.x).toBeLessThan(0);
    close(p0.z, 0, 1e-9);
    const p1 = at(DRONE_PERIOD_S / 4);
    close(Math.hypot(p1.x, p1.z), Math.hypot(p0.x, p0.z), 1e-9);
    expect(Math.abs(p1.z)).toBeGreaterThan(1);
    const p2 = at(DRONE_PERIOD_S);
    close(p2.x, p0.x, 1e-9); close(p2.z, p0.z, 1e-9);
  });
});

// ─── Seguimiento suave ──────────────────────────────────────────────────────

describe('seguimiento suave del balón', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 0, z: -20 };

  it('va detrás (no salta) y llega', () => {
    const one = smoothToward(a, b, 1 / 60, 0.45);
    expect(one.z).toBeLessThan(0);
    expect(one.z).toBeGreaterThan(-1);
    let p = a;
    for (let i = 0; i < 60 * 5; i++) p = smoothToward(p, b, 1 / 60, 0.45);
    close(p.z, b.z, 1e-3);
    close(p.x, b.x, 1e-3);
  });

  it('a los τ segundos recorrió el 63 %', () => {
    let p = a;
    for (let i = 0; i < 27; i++) p = smoothToward(p, b, 1 / 60, 0.45);
    close(p.z / b.z, 1 - Math.exp(-1), 1e-9);
  });

  it('igual a 30 o a 60 fps (dos pasos de dt/2 = un paso de dt)', () => {
    const fast = smoothToward(smoothToward(a, b, 1 / 60, 0.45), b, 1 / 60, 0.45);
    const slow = smoothToward(a, b, 1 / 30, 0.45);
    close(fast.z, slow.z, 1e-12);
  });

  it('sin tiempo no se mueve; giro por el camino corto', () => {
    expect(smoothToward(a, b, 0, 0.45)).toEqual(a);
    const ang = smoothAngle(Math.PI - 0.1, -Math.PI + 0.1, 10, 0.1);
    close(Math.cos(ang), Math.cos(-Math.PI + 0.1), 1e-6);
  });

  it('la cámara de TV que sigue al balón suavizado queda entre la pose de antes y la de después', () => {
    const c = court3D('futbol');
    const from = { x: 0, y: 0.2, z: 0 };
    const to = { x: 0, y: 0.2, z: -25 };
    const sm = smoothToward(from, to, 0.2, 0.45);
    const z0 = cameraPose('tv', ctxOf(c, { ball: from }))!.target.z;
    const z1 = cameraPose('tv', ctxOf(c, { ball: to }))!.target.z;
    const zs = cameraPose('tv', ctxOf(c, { ball: sm }))!.target.z;
    expect(zs).toBeLessThan(z0);
    expect(zs).toBeGreaterThan(z1);
  });
});

// ─── Transiciones ───────────────────────────────────────────────────────────

describe('transiciones entre cámaras', () => {
  const c = court3D('futbol');
  const tv = cameraPose('tv', ctxOf(c))!;
  const iso = cameraPose('iso', ctxOf(c))!;

  it('entre 600 y 900 ms según la distancia', () => {
    for (const a of CAMERA_KINDS) for (const b of CAMERA_KINDS) {
      const pa = cameraPose(a, ctxOf(c, { player: { x: 0, z: 0, heading: Math.PI } }));
      const pb = cameraPose(b, ctxOf(c, { player: { x: 0, z: 0, heading: Math.PI } }));
      if (!pa || !pb) continue;
      const ms = transitionMs(pa, pb);
      expect(ms).toBeGreaterThanOrEqual(600);
      expect(ms).toBeLessThanOrEqual(900);
    }
    expect(transitionMs(tv, tv)).toBe(600);
    // Cruzar la cancha de 105 m tarda más que un ajuste corto.
    expect(transitionMs(tv, cameraPose('rival', ctxOf(c))!)).toBeGreaterThan(800);
    expect(transitionMs(cameraPose('detras', ctxOf(c))!, cameraPose('rival', ctxOf(c))!)).toBe(900);
  });

  it('arranca en la pose de antes, termina en la nueva y acelera/frena (ease)', () => {
    const dur = transitionMs(tv, iso);
    expect(blendPose(tv, iso, 0, dur).pose).toEqual(tv);
    const end = blendPose(tv, iso, dur, dur);
    expect(end.done).toBe(true);
    expect(end.pose).toEqual(iso);
    const q = blendPose(tv, iso, dur / 4, dur).pose;
    const k = (q.position.x - tv.position.x) / (iso.position.x - tv.position.x);
    close(k, easeInOutCubic(0.25), 1e-9);
    expect(k).toBeLessThan(0.25);
    const mid = blendPose(tv, iso, dur / 2, dur).pose;
    close(mid.target.z, (tv.target.z + iso.target.z) / 2, 1e-9);
  });
});

// ─── Director ───────────────────────────────────────────────────────────────

describe('director automático (reglas del spec)', () => {
  const c = court3D('futbol');
  // Salida corta → pase largo → remate al arco rival. Cada tramo 1 s.
  const play = [
    frame('f0', c, { a: [0, 20], b: [-8, 15], c: [10, -10] }, [0, 20]),
    frame('f1', c, { a: [0, 18], b: [-8, 15], c: [10, -10] }, [-6, 16]), // pase corto (~7 m)
    frame('f2', c, { a: [0, 15], b: [-8, 12], c: [12, -14] }, [12, -14]), // pase largo (~35 m)
    frame('f3', c, { a: [0, 10], b: [-8, 8], c: [10, -40] }, [2, -51]), // remate
  ];

  it('elaboración → TV; pase largo → Seguir balón; remate → detrás del arco rival', () => {
    expect(directorShot(c, play, 0)).toBe('tv');
    expect(directorShot(c, play, 500)).toBe('tv');
    expect(directorShot(c, play, 1500)).toBe('balon');
    expect(directorShot(c, play, 2500)).toBe('rival');
    expect(directorShot(c, play, 99999)).toBe('rival');
  });

  it('balón que vuelve hacia el arco propio → detrás del arco propio', () => {
    const back = [frame('f0', c, {}, [0, 20]), frame('f1', c, {}, [0, 48])];
    expect(directorShot(c, back, 500)).toBe('detras');
  });

  it('umbrales: pase largo = 30 % del largo; definición = último 20 %', () => {
    close(longPassM(c), 31.5);
    close(finishZoneM(c), 21);
    expect(longPassM(court3D('voleibol'))).toBe(6);
  });

  it('vóley (red, sin arco): nunca corta a un fondo; el saque largo va con el balón', () => {
    const v = court3D('voleibol');
    const serve = [frame('f0', v, {}, [0, 8.5]), frame('f1', v, {}, [0, -8])];
    expect(directorShot(v, serve, 500)).toBe('balon');
    const short = [frame('f0', v, {}, [0, -3]), frame('f1', v, {}, [1, -6])];
    expect(directorShot(v, short, 500)).toBe('tv');
  });

  it('básquet: tiro al aro rival → detrás del aro rival', () => {
    const b = court3D('baloncesto');
    const shot = [frame('f0', b, {}, [0, -4]), frame('f1', b, {}, [0, -12.4])];
    expect(directorShot(b, shot, 600)).toBe('rival');
  });

  it('sin balón o un solo cuadro → TV', () => {
    expect(directorShot(c, [play[0]], 0)).toBe('tv');
    expect(directorShot(c, [frame('a', c, {}, null), frame('b', c, {}, null)], 500)).toBe('tv');
  });

  it('no corta antes de 1,2 s en la misma cámara (histéresis)', () => {
    const d = createDirector(1200);
    expect(d.step('tv', 0)).toBe('tv');
    expect(d.step('balon', 500)).toBe('tv');
    expect(d.step('balon', 1200)).toBe('balon');
    expect(d.step('rival', 1300)).toBe('balon');
    expect(d.step('rival', 2400)).toBe('rival');
    d.reset();
    expect(d.step('detras', 2500)).toBe('detras');
  });

  it('a lo largo de la jugada a 1×, con histéresis: TV → balón → arco rival', () => {
    const d = createDirector();
    const seen: CameraKind[] = [];
    for (let t = 0; t <= 3500; t += 50) {
      const k = d.step(directorShot(c, play, t), t);
      if (seen[seen.length - 1] !== k) seen.push(k);
    }
    expect(seen).toEqual(['tv', 'balon', 'rival']);
  });
});

// ─── Balón por el aire ──────────────────────────────────────────────────────

describe('arco del balón', () => {
  const c = court3D('futbol');
  const longPass = [frame('f0', c, {}, [0, 20], 1000), frame('f1', c, {}, [0, -10], 1500)]; // 30 m
  const shortPass = [frame('f0', c, {}, [0, 20]), frame('f1', c, {}, [5, 16])]; // 6,4 m

  const arcAt = (frames: TacticalFrame[], t: number) => ballArc(c, frames, interpolateFrames(frames, t));

  it('sentido del balón: el del tramo; quieto, el último que se movió; nunca, hacia el rival', () => {
    close(ballHeadingAt(c, longPass, interpolateFrames(longPass, 700)), Math.PI, 1e-9); // de z=20 a z=−10
    const back = [frame('f0', c, {}, [0, -10]), frame('f1', c, {}, [0, 20]), frame('f2', c, {}, [0, 20])];
    close(ballHeadingAt(c, back, interpolateFrames(back, 1500)), 0, 1e-9);
    expect(ballHeadingAt(c, [frame('a', c, {}, null)], interpolateFrames([frame('a', c, {}, null)], 0))).toBe(Math.PI);
  });

  it('pase corto: rueda (sin altura)', () => {
    const a = arcAt(shortPass, 500);
    expect(a.lofted).toBe(false);
    expect(a.moving).toBe(true);
    expect(a.lift).toBe(0);
  });

  it('pase largo: altura máxima en la mitad = 22 % de la distancia (con tope)', () => {
    const mid = arcAt(longPass, 750);
    expect(mid.lofted).toBe(true);
    close(mid.distM, 30, 1e-6);
    close(mid.apexM, Math.min(30 * 0.22, arcCapM(c)));
    close(mid.lift, mid.apexM, 1e-9);
    // Más lejos, más alto, hasta el tope del deporte.
    expect(arcApexM(c, 40)).toBeGreaterThan(arcApexM(c, 30));
    expect(arcApexM(c, 200)).toBe(arcCapM(c));
    expect(loftThresholdM(c)).toBe(16);
  });

  it('sale del pie y cae donde dice el cuadro (altura 0 en los extremos)', () => {
    expect(arcAt(longPass, 0).lift).toBe(0);
    close(arcAt(longPass, 1).lift, 0, 1e-3);
    const end = computeLive(c, longPass, null, 1500);
    expect(ballArc(c, longPass, end.main).lift).toBe(0);
    const target = toMeters(c, longPass[1].ball!.x, longPass[1].ball!.y);
    close(end.ball!.x, target.x, 1e-9);
    close(end.ball!.z, target.z, 1e-9);
  });

  it('la parábola es simétrica en el espacio: misma altura a la misma distancia de cada pie', () => {
    const live = (t: number) => computeLive(c, longPass, null, t);
    const tA = 300;
    const a = live(tA);
    // Busca el instante de la otra rama con el balón a la misma distancia del destino.
    const total = totalDurationMs(longPass);
    const startZ = toMeters(c, longPass[0].ball!.x, longPass[0].ball!.y).z;
    const endZ = toMeters(c, longPass[1].ball!.x, longPass[1].ball!.y).z;
    const travelled = Math.abs(a.ball!.z - startZ);
    let best = 0; let bd = Infinity;
    for (let t = 0; t <= total; t += 0.5) {
      const d = Math.abs(Math.abs(endZ - live(t).ball!.z) - travelled);
      if (d < bd) { bd = d; best = t; }
    }
    close(ballArc(c, longPass, a.main).lift, ballArc(c, longPass, live(best).main).lift, 0.02);
  });

  it('vóley: arco hasta en pases cortos de mano (umbral 5 m), tope 4 m', () => {
    const v = court3D('voleibol');
    const set = [frame('f0', v, {}, [0, 2]), frame('f1', v, {}, [3, -3])];
    const a = ballArc(v, set, interpolateFrames(set, 500));
    expect(a.lofted).toBe(true);
    expect(a.apexM).toBeLessThanOrEqual(4);
  });
});

// ─── Sincronía con el 2D ────────────────────────────────────────────────────

describe('sincronía con el 2D en 10 instantes', () => {
  const c = court3D('futbol');
  const play = [
    frame('f0', c, { a: [0, 20], b: [-8, 15] }, [0, 20], 1000),
    frame('f1', c, { a: [2, 10], b: [-8, 5] }, [-8, 5], 1200),
    frame('f2', c, { a: [6, -5], b: [-2, -10] }, [6, -5], 800),
    frame('f3', c, { a: [6, -30], b: [-2, -25] }, [3, -51], 1500),
  ];
  const total = totalDurationMs(play);

  it.each([0, 250, 700, 1000, 1500, 2200, 2600, 3000, 3900, total])('t = %i ms: balón y jugadores en el mismo lugar que el 2D; la altura no mueve la planta', (t) => {
    const two = interpolateFrames(play, t);
    const live = computeLive(c, play, null, t);
    for (const p of two.players) {
      const q = live.main.players.find((x) => x.key === p.key)!;
      expect(q.x).toBe(p.x);
      expect(q.y).toBe(p.y);
    }
    const b = toMeters(c, two.ball!.x, two.ball!.y);
    expect(live.ball!.x).toBe(b.x);
    expect(live.ball!.z).toBe(b.z);
    expect(liveBallPct(live.main)).toEqual({ x: two.ball!.x, y: two.ball!.y });
    // La orientación de la figura es la del desplazamiento del 2D en ese tramo.
    if (t > 0 && t < total) {
      const m = playerMotion(c, play, 'a', t);
      const t2 = Math.min(total, t + 5);
      const p0 = two.players.find((x) => x.key === 'a')!;
      const p1 = interpolateFrames(play, t2).players.find((x) => x.key === 'a')!;
      const d0 = toMeters(c, p0.x, p0.y);
      const d1 = toMeters(c, p1.x, p1.y);
      if (Math.hypot(d1.x - d0.x, d1.z - d0.z) > 1e-4) close(m.heading, Math.atan2(d1.x - d0.x, d1.z - d0.z), 1e-6);
    }
  });
});

// ─── Carrera de las figuras ─────────────────────────────────────────────────

describe('carrera de las figuras', () => {
  const c = court3D('futsal');
  const run = [
    frame('f0', c, { a: [0, 10], s: [5, 5] }, null, 1000),
    frame('f1', c, { a: [0, 0], s: [5, 5] }, null, 1000),
    frame('f2', c, { a: [0, 0], s: [5, 5] }, null, 1000),
  ];

  it('quieto: postura de reposo, mirando al arco rival', () => {
    const m = playerMotion(c, run, 's', 500);
    expect(m.moving).toBe(false);
    expect(m.heading).toBe(DEFAULT_HEADING);
    expect(gaitOf(m)).toEqual({ legSwing: 0, bob: 0, lean: 0, run: 0 });
  });

  it('corriendo: mira hacia donde va, se inclina y la zancada avanza', () => {
    const m = playerMotion(c, run, 'a', 500);
    expect(m.moving).toBe(true);
    close(m.heading, Math.PI, 1e-9); // de +z a 0 = hacia −z
    expect(m.speed).toBeGreaterThan(5);
    const g = gaitOf(m);
    expect(g.run).toBeGreaterThan(0.9);
    expect(g.lean).toBeGreaterThan(0);
    let last = -1;
    for (let t = 0; t <= 1000; t += 50) {
      const ph = playerMotion(c, run, 'a', t).phase;
      expect(ph).toBeGreaterThanOrEqual(last);
      last = ph;
    }
  });

  it('cadencia con tope (las jugadas van comprimidas): 10 m en 1 s = 3 ciclos, no 6', () => {
    const end = playerMotion(c, run, 'a', 1000);
    close(end.phase, Math.min(10 / 1.7, MAX_CADENCE_HZ * 1), 1e-9);
    // Llegó y se queda: no corre, conserva hacia dónde miraba.
    const after = playerMotion(c, run, 'a', 1500);
    expect(after.moving).toBe(false);
    close(after.heading, Math.PI, 1e-9);
  });
});

// ─── Reproducción ───────────────────────────────────────────────────────────

describe('reproducción: cuadro a cuadro, repetición, foco y rastro', () => {
  const c = court3D('futbol');
  const play = [
    frame('f0', c, { a: [0, 20], b: [5, 5] }, [0, 20], 1000),
    frame('f1', c, { a: [0, 10], b: [5, 5] }, [5, 5], 1000),
    frame('f2', c, { a: [0, 0], b: [5, -5] }, [5, -5], 2000),
  ];

  it('cámara lenta 0,25× además de las del 2D', () => {
    expect(VIEWER_SPEEDS).toEqual([0.25, 0.5, 1, 2]);
  });

  it('◀ ▶ salta al cuadro anterior / siguiente', () => {
    expect(stepFrame(play, 0, 1)).toBe(1000);
    expect(stepFrame(play, 1000, 1)).toBe(3000);
    expect(stepFrame(play, 3000, 1)).toBe(3000);
    expect(stepFrame(play, 1500, -1)).toBe(1000);
    expect(stepFrame(play, 1000, -1)).toBe(0);
    expect(stepFrame(play, 0, -1)).toBe(0);
    expect(frameIndexAt(play, 999)).toBe(0);
    expect(frameIndexAt(play, 1000)).toBe(1);
    expect(frameIndexAt(play, 3000)).toBe(2);
  });

  it('repetición = último tramo', () => {
    expect(replayRange(play)).toEqual({ startMs: 1000, endMs: 3000 });
    expect(replayRange([play[0]])).toEqual({ startMs: 0, endMs: 0 });
  });

  it('foco del congelado: el elegido; si no, el más cercano al balón', () => {
    const live = interpolateFrames(play, 1000);
    expect(spotlightKey(live, liveBallPct(live), null)).toBe('b');
    expect(spotlightKey(live, liveBallPct(live), 'a')).toBe('a');
    expect(spotlightKey(live, null, 'zz')).toBe('a');
    expect(spotlightKey({ players: [] }, null, null)).toBeNull();
  });

  it('rastro: cuadros ya pasados + el instante, sin repetidos', () => {
    const mid = interpolateFrames(play, 2000);
    const pts = trailPoints(play, 'a', mid);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ x: play[0].players[0].x, y: play[0].players[0].y });
    const still = trailPoints(play, 'b', interpolateFrames(play, 500));
    expect(still).toHaveLength(1);
    expect(trailPoints(play, 'a', interpolateFrames(play, 3000))).toHaveLength(3);
  });
});

describe('todas las cámaras en todos los deportes', () => {
  it.each(TACTICAL_SPORTS)('%s', (sport) => {
    const c = court3D(sport);
    for (const k of CAMERA_KINDS) {
      const pose = cameraPose(k, ctxOf(c, { player: { x: 0, z: 0, heading: Math.PI }, aspect: 0.5 }));
      if (pose) expect(finite(pose.position) && pose.position.y > 0.5, `${sport}/${k}`).toBe(true);
      expect(cameraKindLabel(k, sport).length).toBeGreaterThan(2);
    }
  });
});

describe('encuadre vertical (celular)', () => {
  it('portraitFraming: null en horizontal; en vertical reserva arriba/abajo y desplaza hacia abajo', async () => {
    const { portraitFraming } = await import('@/lib/school/tactical3dCameras');
    expect(portraitFraming(926, 428, 45)).toBeNull();
    expect(portraitFraming(1440, 900, 45)).toBeNull();
    const pf = portraitFraming(428, 926, 45)!;
    expect(pf.aspect).toBeGreaterThan(428 / 926);
    expect(pf.shiftPx).toBeGreaterThan(0);
  });

  it('todas las cámaras de campo encuadran el ancho completo en vertical (aspect 0,5)', () => {
    const c = court3D('futbol');
    const halfH = Math.tan((45 / 2) * Math.PI / 180) * 0.5;
    for (const k of ['tv', 'tactica', 'cenital', 'iso', 'detras', 'rival', 'spider', 'dron'] as const) {
      const pose = cameraPose(k, ctxOf(c, { aspect: 0.5 }))!;
      const dist = Math.hypot(pose.position.x - pose.target.x, pose.position.y - pose.target.y, pose.position.z - pose.target.z);
      // El ancho de la cancha (68 m) cabe en el FOV horizontal a esa distancia.
      expect(dist * halfH * 2).toBeGreaterThanOrEqual(c.widthM * 0.9);
    }
  });
});
