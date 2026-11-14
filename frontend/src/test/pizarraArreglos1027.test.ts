/**
 * Paquete de arreglos de la pizarra (2026-10-27): contador de jugadores,
 * galería filtrada por modalidad, exportar con la cancha vacía, marca de agua,
 * jugada compartida por enlace (sin nombres), «Agregar a una sesión» y el 3D
 * en el celular. Lógica pura.
 */
import { describe, expect, it } from 'vitest';
import { boardHasContent, EMPTY_BOARD_REASON, exportAvailability, rosterCounts, rosterCountsLabel, VIDEO_FRAMES_REASON } from '@/lib/school/tacticalBoardUx';
import { galleryCaption, galleryFormations, initialPlayersFilter, playerCounts } from '@/lib/school/tacticalFormationGallery';
import { boardSportConfig } from '@/lib/school/tacticalBoardSport';
import { sportDef } from '@/lib/school/tacticalSports';
import { resolveExportBranding, wantsWatermark, WATERMARK_TEXT } from '@/lib/export/tacticalWatermark';
import {
  buildSharedPlayPayload, initialsOf, parseSharedPlay, publicOrigin, sharedPlayErrorMessage, sharedPlayMessage, sharedPlayUrl,
} from '@/lib/school/tacticalSharedPlay';
import { blockIdPatch, destinosDeSesiones } from '@/lib/school/pizarraSesiones';
import { defaultViewerCamera, figureBoost, labelScreenSize, shortTag } from '@/lib/school/tactical3d';
import { cameraKindLabel } from '@/lib/school/tactical3dCameras';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';

describe('6 · «En cancha N · Banco M»', () => {
  const roster = ['a', 'b', 'c'];
  it('cancha vacía: 0 en cancha, 3 en el banco (antes decía 3 y se leía al revés)', () => {
    expect(rosterCounts(roster, [])).toEqual({ onPitch: 0, bench: 3 });
    expect(rosterCountsLabel(rosterCounts(roster, []))).toBe('En cancha 0 · Banco 3');
  });
  it('los 3 en cancha: 3 y 0', () => {
    expect(rosterCounts(roster, ['a', 'b', 'c'])).toEqual({ onPitch: 3, bench: 0 });
  });
  it('un jugador guardado que ya no está en el equipo no cuenta; repetidos tampoco', () => {
    expect(rosterCounts(roster, ['a', 'zz', 'a'])).toEqual({ onPitch: 1, bench: 2 });
  });
});

describe('8 · galería en la modalidad de la cancha', () => {
  const futbol = boardSportConfig('futbol').formations;
  const pool = galleryFormations('futbol', futbol);

  it('fútbol 11 suma las de F7 y F5 llevadas a la cancha grande, sin repetir el 2-3-1', () => {
    expect(pool.length).toBeGreaterThan(futbol.length);
    expect(playerCounts(pool)).toEqual([11, 7, 5]);
    const sevens = pool.filter((f) => f.players === 7);
    expect(sevens.length).toBeGreaterThan(3);
    expect(sevens.filter((f) => /2-3-1/.test(f.label))).toHaveLength(1);
    expect(new Set(pool.map((f) => f.key)).size).toBe(pool.length);
    // Llevadas a la cancha de 11: los puntos caen dentro de su rectángulo.
    const big = sportDef('futbol').court;
    for (const f of pool) for (const s of f.slots) {
      expect(s.x).toBeGreaterThanOrEqual(big.x0 - 0.6);
      expect(s.x).toBeLessThanOrEqual(big.x1 + 0.6);
      expect(s.y).toBeGreaterThanOrEqual(big.y0 - 0.6);
      expect(s.y).toBeLessThanOrEqual(big.y1 + 0.6);
    }
  });

  it('otros deportes no cambian', () => {
    const v = boardSportConfig('voleibol').formations;
    expect(galleryFormations('voleibol', v)).toBe(v);
  });

  it('abre filtrada: formación puesta > jugadores en cancha > formación de arranque', () => {
    expect(initialPlayersFilter(pool, { currentKey: 'f7-2-3-1' })).toBe(7);
    expect(initialPlayersFilter(pool, { currentKey: '4-3-3', onPitch: 7 })).toBe(11);
    expect(initialPlayersFilter(pool, { onPitch: 5 })).toBe(5);
    expect(initialPlayersFilter(pool, { onPitch: 3, defaultPlayers: 7 })).toBe(7);
    expect(initialPlayersFilter(pool, { onPitch: 3, defaultPlayers: 9 })).toBeNull();
    // Un solo tamaño en el catálogo: no hay nada que filtrar.
    expect(initialPlayersFilter(boardSportConfig('futbol7').formations, { onPitch: 7 })).toBeNull();
  });

  it('el subtítulo dice la modalidad que se ve', () => {
    expect(galleryCaption('futbol', 9, 7)).toBe('9 formaciones de Fútbol 7');
    expect(galleryCaption('futbol', 1, 11)).toBe('1 formación de Fútbol 11');
    expect(galleryCaption('futbol', 53, null)).toBe('53 formaciones de Fútbol 11');
    expect(galleryCaption('voleibol', 12, null)).toBe(`12 formaciones de ${sportDef('voleibol').label}`);
  });
});

describe('12 · exportar con la cancha vacía', () => {
  it('vacía: PNG, PDF y video apagados con el motivo', () => {
    const a = exportAvailability({ hasContent: false, frameCount: 1, canAddFrame: true });
    expect(a.png).toEqual({ enabled: false, reason: EMPTY_BOARD_REASON });
    expect(a.pdf.enabled).toBe(false);
    expect(a.video.enabled).toBe(false);
    expect(a.video.offerAddFrame).toBe(false);
  });
  it('con algo y un cuadro: PNG/PDF sí; el video ofrece «+ Cuadro» si se puede editar', () => {
    const a = exportAvailability({ hasContent: true, frameCount: 1, canAddFrame: true });
    expect(a.png.enabled && a.pdf.enabled).toBe(true);
    expect(a.video).toEqual({ enabled: false, reason: VIDEO_FRAMES_REASON, offerAddFrame: true });
    expect(exportAvailability({ hasContent: true, frameCount: 1, canAddFrame: false }).video.offerAddFrame).toBe(false);
  });
  it('dos cuadros: todo habilitado', () => {
    const a = exportAvailability({ hasContent: true, frameCount: 2, canAddFrame: true });
    expect(a.video).toEqual({ enabled: true, reason: null, offerAddFrame: false });
  });
  it('el «Campo» solo (figura court) no es contenido; un jugador o una flecha sí', () => {
    const court = { type: 'court', x1: 0, y1: 0, x2: 0, y2: 0, court: { cam: 'full' } } as never;
    expect(boardHasContent([{ players: [], arrows: [court] }])).toBe(false);
    expect(boardHasContent([{ players: [], arrows: [court] }, { players: [{ key: 'a', x: 1, y: 1 }], arrows: [] }])).toBe(true);
    expect(boardHasContent([{ players: [], arrows: [{ type: 'arrow', x1: 1, y1: 1, x2: 2, y2: 2 }] }])).toBe(true);
  });
});

describe('13 · marca de agua y logo del club', () => {
  it('siempre «Hecho con SportMaps», salvo marca blanca', () => {
    expect(WATERMARK_TEXT).toBe('Hecho con SportMaps · sportmaps.co');
    expect(resolveExportBranding({ showsSportmapsWatermark: true, hasBrandingFeature: false, logoUrl: 'https://x/logo.png' }))
      .toEqual({ watermark: true, clubLogoUrl: null });
    expect(wantsWatermark(undefined)).toBe(true);
    expect(wantsWatermark({ watermark: false })).toBe(false);
  });
  it('logo del club solo con el permiso del tier (y la marca de agua se queda)', () => {
    expect(resolveExportBranding({ showsSportmapsWatermark: true, hasBrandingFeature: true, logoUrl: ' https://cdn/x.png ' }))
      .toEqual({ watermark: true, clubLogoUrl: 'https://cdn/x.png' });
    expect(resolveExportBranding({ showsSportmapsWatermark: true, hasBrandingFeature: true, logoUrl: 'data:image/png;base64,xx' }).clubLogoUrl).toBeNull();
    expect(resolveExportBranding({ showsSportmapsWatermark: true, hasBrandingFeature: true, logoUrl: null }).clubLogoUrl).toBeNull();
  });
});

describe('14 · jugada compartida por enlace', () => {
  const frames: TacticalFrame[] = [
    { id: 'x1', duration_ms: 1000, players: [{ key: 'athlete:uuid-juan', x: 10, y: 20 }, { key: 'child:uuid-ana', x: 30, y: 40 }], ball: null, arrows: [], note: 'Juan arranca', ball_owner: 'athlete:uuid-juan' },
    { id: 'x2', duration_ms: 800, players: [{ key: 'child:uuid-ana', x: 35, y: 45 }], ball: { x: 1, y: 2 }, arrows: [{ type: 'arrow', x1: 1, y1: 1, x2: 2, y2: 2 }] },
  ];
  const teams = {
    v: 1, export_names: true, player_scale: 1, object_scale: 1,
    home: { name: 'Mi club', caption: 'name' }, away: { name: 'Rival', caption: 'number', roster: [], rival_team_id: null },
  } as unknown as TacticalTeamsConfig;

  it('sin nombres ni ids de deportistas: claves p1…, dorsal o iniciales, sin notas', () => {
    const p = buildSharedPlayPayload({
      sport: 'futbol', frames, players: [], arrows: [],
      playerLabels: { 'athlete:uuid-juan': 'Juan Pérez', 'child:uuid-ana': 'Defensa central' },
      playerJerseys: { 'athlete:uuid-juan': null, 'child:uuid-ana': 4 },
      teams,
    });
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/uuid-|Juan|Pérez|arranca/);
    expect(p.frames.map((f) => f.players.map((x) => x.key))).toEqual([['p1', 'p2'], ['p2']]);
    expect(p.labels).toEqual({ p1: 'JP' });
    expect(p.jerseys).toEqual({ p1: null, p2: 4 });
    expect(p.frames[0].ball_owner).toBe('p1');
    expect(p.frames[1].ball).toEqual({ x: 1, y: 2 });
    expect(p.teams?.export_names).toBe(false);
    expect(p.teams?.home.caption).toBe('initials');
  });

  it('un solo cuadro sale de lo que se ve', () => {
    const p = buildSharedPlayPayload({ frames: null, players: [{ x: 5, y: 6, label: 'Arquero', jersey: null }, { x: 7, y: 8, jersey: 9 }], arrows: [] });
    expect(p.frames).toHaveLength(1);
    expect(p.frames[0].players).toEqual([{ key: 'p1', x: 5, y: 6 }, { key: 'p2', x: 7, y: 8 }]);
    expect(p.labels).toEqual({ p1: 'ARQ' });
  });

  it('iniciales', () => {
    expect(initialsOf('Lateral izq.')).toBe('LI');
    expect(initialsOf('')).toBe('');
    expect(initialsOf(undefined)).toBe('');
  });

  it('lee lo que devuelve la RPC y descarta lo que no sirve', () => {
    const payload = buildSharedPlayPayload({ sport: 'voleibol', frames, players: [], arrows: [] });
    const ok = parseSharedPlay({ title: 'Salida', sport: 'voleibol', payload, created_at: '2026-10-27' });
    expect(ok?.title).toBe('Salida');
    expect(ok?.sport).toBe('voleibol');
    expect(ok?.payload.frames).toHaveLength(2);
    expect(parseSharedPlay(null)).toBeNull();
    expect(parseSharedPlay({ payload: { frames: [] } })).toBeNull();
    expect(parseSharedPlay({ sport: 'cricket', payload })?.sport).toBeNull();
  });

  it('enlace y mensaje de WhatsApp', () => {
    expect(sharedPlayUrl('https://dev.sportmaps.co/', 'abc_DEF-123456789012')).toBe('https://dev.sportmaps.co/jugada/abc_DEF-123456789012');
    // App nativa (capacitor/localhost): el enlace es el de la web de producción.
    expect(publicOrigin('capacitor://localhost')).toBe('https://app.sportmaps.co');
    expect(publicOrigin('http://localhost')).toBe('https://app.sportmaps.co');
    expect(sharedPlayMessage('Córner', 'https://x/jugada/t')).toContain('Córner');
    expect(sharedPlayMessage('', 'https://x/jugada/t')).toContain('https://x/jugada/t');
    expect(sharedPlayErrorMessage('not_allowed')).toMatch(/rol/);
  });
});

describe('Pizarra libre · «Agregar a una sesión»', () => {
  const sesiones = [
    { id: 's2', session_date: '2026-10-29', session_blocks: [{ name: 'Calentamiento', id: 'b1' }, { name: 'Juego' }] },
    { id: 's1', session_date: '2026-10-28', session_blocks: [], warmup: 'Trote', drills: [] },
    { id: 's3', session_date: '2026-10-30', session_blocks: null },
  ];
  it('ordena por fecha; bloques con y sin id; sesiones viejas no se tocan', () => {
    const d = destinosDeSesiones(sesiones);
    expect(d.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3']);
    expect(d[0]).toMatchObject({ legacyOnly: true, canAppend: false, blocks: [] });
    expect(d[1].blocks.map((b) => [b.name, b.blockId, b.blockIndex])).toEqual([['Calentamiento', 'b1', 0], ['Juego', null, 1]]);
    expect(d[2]).toMatchObject({ legacyOnly: false, canAppend: true, blocks: [] });
  });
  it('asigna id al bloque que no tiene, respeta el que ya tiene, o agrega «Pizarra»', () => {
    const blocks = [{ name: 'Calentamiento', id: 'b1' }, { name: 'Juego' }];
    expect(blockIdPatch(blocks, 0, 'nuevo')).toEqual({ blocks, blockId: 'b1' });
    const r = blockIdPatch(blocks, 1, 'nuevo');
    expect(r.blockId).toBe('nuevo');
    expect(r.blocks[1]).toEqual({ name: 'Juego', id: 'nuevo' });
    expect(blocks[1]).toEqual({ name: 'Juego' }); // no muta
    const add = blockIdPatch(null, null, 'z');
    expect(add.blocks).toEqual([{ id: 'z', name: 'Pizarra', minutes: null, activity: '' }]);
  });
});

describe('15-18 · 3D en el celular', () => {
  it('vertical abre en «Táctica alta» (más cerca), horizontal en TV', () => {
    expect(defaultViewerCamera(390 / 844)).toBe('tactica');
    expect(defaultViewerCamera(16 / 9)).toBe('tv');
  });
  it('figuras más grandes y carteles más chicos en vertical', () => {
    expect(figureBoost(0.46)).toBeGreaterThan(1);
    expect(figureBoost(1.7)).toBe(1);
    expect(labelScreenSize(0.46)).toBeLessThan(labelScreenSize(1.7));
  });
  it('cartel corto: dorsal o iniciales (el nombre completo solo al tocar)', () => {
    expect(shortTag({ number: '10', label: 'Delantero centro' })).toBe('10');
    expect(shortTag({ number: null, label: 'Delantero centro' })).toBe('DC');
    expect(shortTag({ number: null, label: 'Arquero' })).toBe('ARQ');
    expect(shortTag({ number: null, label: '' })).toBe('');
  });
  it('«Detrás del arco» y la del rival se llaman distinto', () => {
    expect(cameraKindLabel('detras', 'futbol')).not.toBe(cameraKindLabel('rival', 'futbol'));
    expect(cameraKindLabel('rival', 'futbol')).toBe('Ojos del arquero rival');
  });
});
