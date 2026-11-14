/**
 * Base táctica propia (RAG ligero): selección por deporte + formación, tope de
 * caracteres y formación deducida de las posiciones. Lógica pura.
 */
import { describe, expect, it } from 'vitest';
import {
  KB_BY_SPORT, KB_FORMATION_MAX_CHARS, KB_PRINCIPLES_MAX_CHARS, findFormation, formationSection, inferFormation,
  kbVersion, principlesSection, selectKnowledge, type Pt,
} from './tactical-ai-knowledge';
import { MOMENTS } from '../data/tactical-kb/types';
import { AI_SPORTS, COURTS } from '../routes/school/tacticalAiShapes';

// Slots del catálogo de la pizarra (frontend/src/lib/school/tacticalFormations.ts):
// fútbol 11 usa el tablero completo; GK_Y=92, DEF 70, MID 45, FWD 18.
const F433: Pt[] = [
  { x: 50, y: 92 }, { x: 14, y: 68 }, { x: 37, y: 72 }, { x: 63, y: 72 }, { x: 86, y: 68 },
  { x: 28, y: 45 }, { x: 50, y: 47 }, { x: 72, y: 45 }, { x: 18, y: 21 }, { x: 50, y: 18 }, { x: 82, y: 21 },
];
const F442: Pt[] = [
  { x: 50, y: 92 }, { x: 14, y: 68 }, { x: 37, y: 72 }, { x: 63, y: 72 }, { x: 86, y: 68 },
  { x: 14, y: 43 }, { x: 38, y: 47 }, { x: 62, y: 47 }, { x: 86, y: 43 }, { x: 36, y: 18 }, { x: 64, y: 18 },
];
const BACK4: Pt[] = [{ x: 14, y: 68 }, { x: 37, y: 72 }, { x: 63, y: 72 }, { x: 86, y: 68 }];
const F4231: Pt[] = [
  { x: 50, y: 92 }, ...BACK4, { x: 37, y: 54 }, { x: 63, y: 54 },
  { x: 16, y: 34 }, { x: 50, y: 32 }, { x: 84, y: 34 }, { x: 50, y: 16 },
];
const F4141: Pt[] = [
  { x: 50, y: 92 }, ...BACK4, { x: 50, y: 56 },
  { x: 12, y: 42 }, { x: 36, y: 42 }, { x: 64, y: 42 }, { x: 88, y: 42 }, { x: 50, y: 17 },
];
const F532: Pt[] = [
  { x: 50, y: 92 }, { x: 10, y: 62 }, { x: 30, y: 71 }, { x: 50, y: 74 }, { x: 70, y: 71 }, { x: 90, y: 62 },
  { x: 28, y: 46 }, { x: 50, y: 51 }, { x: 72, y: 46 }, { x: 37, y: 18 }, { x: 63, y: 18 },
];
/** Rival dibujado en espejo (defiende arriba). */
const mirror = (pts: Pt[]): Pt[] => pts.map((p) => ({ x: 100 - p.x, y: 100 - p.y }));

/** Slots relativos a la cancha (0-100) llevados al rectángulo del deporte en el tablero. */
function onCourt(sport: keyof typeof COURTS, rel: Pt[]): Pt[] {
  const c = COURTS[sport];
  return rel.map((p) => ({ x: c.x0 + (p.x / 100) * (c.x1 - c.x0), y: c.y0 + (p.y / 100) * (c.y1 - c.y0) }));
}

describe('datos versionados', () => {
  it('todo deporte con IA tiene base, versión y los cinco momentos con al menos una viñeta', () => {
    for (const sp of AI_SPORTS) {
      const kb = KB_BY_SPORT[sp];
      expect(kb.sport).toBe(sp);
      expect(kbVersion(sp)).toMatch(new RegExp(`^${sp}-\\d{4}-\\d{2}-\\d{2}$`));
      for (const m of MOMENTS) {
        expect(kb.momentos[m].length).toBeGreaterThan(0);
        expect(kb.momentLabels[m]).toBeTruthy();
      }
      for (const f of kb.formaciones) {
        expect(f.fortalezas.length).toBeGreaterThan(0);
        expect(f.debilidades.length).toBeGreaterThan(0);
      }
    }
  });
  it('formaciones con líneas: la suma = jugadores de campo del deporte', () => {
    const outfield = { futbol: 10, futbol7: 6, futbol5: 4, futsal: 4 } as const;
    for (const [sp, n] of Object.entries(outfield)) {
      for (const f of KB_BY_SPORT[sp as keyof typeof outfield].formaciones) {
        if (f.lines) expect(f.lines.reduce((a, b) => a + b, 0), `${sp} ${f.key}`).toBe(n);
      }
    }
  });
  it('sin «vos» ni «che» (español de Colombia)', () => {
    const all = JSON.stringify(KB_BY_SPORT);
    expect(all).not.toMatch(/\bvos\b|\bche\b/i);
  });
});

describe('principios por deporte (sistema)', () => {
  it('cabe en el tope de caracteres en todos los deportes', () => {
    for (const sp of AI_SPORTS) {
      const t = principlesSection(sp);
      expect(t.length).toBeLessThanOrEqual(KB_PRINCIPLES_MAX_CHARS);
      expect(t).toContain('PRINCIPIOS TÁCTICOS DE REFERENCIA');
    }
  });
  it('fútbol trae los cinco momentos; voleibol los nombra por fase del rally', () => {
    const f = principlesSection('futbol');
    for (const m of ['Ataque organizado', 'Transición defensa→ataque', 'Defensa organizada', 'Transición ataque→defensa', 'Balón parado']) {
      expect(f).toContain(m);
    }
    const v = principlesSection('voleibol');
    expect(v).toContain('side-out');
    expect(v).not.toContain('Balón parado');
  });
  it('con un tope chico baja viñetas y nunca se pasa', () => {
    const full = principlesSection('futbol', 10_000);
    const small = principlesSection('futbol', 700);
    expect(small.length).toBeLessThanOrEqual(700);
    expect(small.length).toBeLessThan(full.length);
    expect(principlesSection('futbol', 120).length).toBeLessThanOrEqual(120);
  });
  it('no mezcla deportes: el de fútbol no habla de bloqueo de voleibol', () => {
    expect(principlesSection('futbol')).not.toMatch(/side-out|líbero/);
    expect(principlesSection('voleibol')).not.toMatch(/fuera de juego|extremos/);
  });
});

describe('formación deducida de las posiciones', () => {
  it('fútbol 11: 4-3-3, 4-4-2, 4-2-3-1, 4-1-4-1 y 5-3-2 del catálogo', () => {
    expect(inferFormation('futbol', F433)?.key).toBe('4-3-3');
    expect(inferFormation('futbol', F442)?.key).toBe('4-4-2');
    expect(inferFormation('futbol', F4231)?.key).toBe('4-2-3-1');
    expect(inferFormation('futbol', F4141)?.key).toBe('4-1-4-1');
    expect(inferFormation('futbol', F532)?.key).toBe('5-3-2');
  });
  it('el rival en espejo se lee desde su arco', () => {
    expect(inferFormation('futbol', mirror(F442), 'rival')?.key).toBe('4-4-2');
    expect(inferFormation('futbol', mirror(F433), 'rival')?.key).toBe('4-3-3');
  });
  it('fútbol 7 y fútbol 5 dentro de su rectángulo de cancha', () => {
    const f7 = onCourt('futbol7', [
      { x: 50, y: 94 }, { x: 30, y: 74 }, { x: 70, y: 74 }, { x: 14, y: 50 }, { x: 50, y: 54 }, { x: 86, y: 50 }, { x: 50, y: 24 },
    ]);
    expect(inferFormation('futbol7', f7)?.key).toBe('f7-2-3-1');
    const f5 = onCourt('futbol5', [{ x: 50, y: 94 }, { x: 50, y: 76 }, { x: 18, y: 56 }, { x: 82, y: 56 }, { x: 50, y: 32 }]);
    expect(inferFormation('futbol5', f5)?.key).toBe('f5-1-2-1');
    const sq = onCourt('futbol5', [{ x: 50, y: 94 }, { x: 28, y: 72 }, { x: 72, y: 72 }, { x: 28, y: 40 }, { x: 72, y: 40 }]);
    expect(inferFormation('futbol5', sq)?.key).toBe('f5-2-2');
  });
  it('equipo incompleto, sin arquero o desordenado → null (mejor nada que equivocarse)', () => {
    expect(inferFormation('futbol', F433.slice(0, 9))).toBeNull();
    expect(inferFormation('futbol', F433.map((p) => ({ ...p, y: p.y === 92 ? 50 : p.y })))).toBeNull();
    const caos = F433.map((p, i) => ({ x: p.x, y: i === 0 ? 92 : 20 + i * 6.5 }));
    expect(inferFormation('futbol', caos)).toBeNull();
  });
  it('voleibol no se deduce (sin líneas): solo por clave', () => {
    expect(inferFormation('voleibol', Array.from({ length: 6 }, (_, i) => ({ x: 20 + i * 10, y: 70 })))).toBeNull();
    expect(findFormation('voleibol', 'vb-recepcion-w')?.label).toBe('Recepción en W');
  });
});

describe('selectKnowledge (lo que entra al prompt)', () => {
  it('la formación elegida por el coach manda sobre la deducida', () => {
    const k = selectKnowledge({ sport: 'futbol', formationKey: '3-5-2', firstFrame: { propios: F433, rivales: [] } });
    expect(k.ownFormation).toBe('3-5-2');
    expect(k.user).toContain('3-5-2');
    expect(k.user).toContain('la eligió el entrenador');
    expect(k.user).not.toContain('4-3-3');
  });
  it('clave desconocida → se deduce de las posiciones', () => {
    const k = selectKnowledge({ sport: 'futbol', formationKey: 'inventada', firstFrame: { propios: F433, rivales: mirror(F442) } });
    expect(k.ownFormation).toBe('4-3-3');
    expect(k.rivalFormation).toBe('4-4-2');
    expect(k.user).toContain('deducida de las posiciones');
    expect(k.user).toContain('Formación del rival');
  });
  it('sin formación reconocible → solo principios (user null): no gasta tokens de más', () => {
    const k = selectKnowledge({ sport: 'futbol', firstFrame: { propios: F433.slice(0, 3), rivales: [] } });
    expect(k.user).toBeNull();
    expect(k.system).toContain('PRINCIPIOS');
    expect(k.version).toBe(kbVersion('futbol'));
  });
  it('solo la formación pedida: no se manda el catálogo entero', () => {
    const k = selectKnowledge({ sport: 'futbol', formationKey: '4-4-2', firstFrame: null });
    const otras = KB_BY_SPORT.futbol.formaciones.filter((f) => f.key !== '4-4-2');
    for (const f of otras) expect(k.user).not.toContain(`: ${f.label}.`);
  });
  it('cada formación cabe en su tope', () => {
    for (const sp of AI_SPORTS) {
      for (const f of KB_BY_SPORT[sp].formaciones) {
        expect(formationSection(f, 'Formación del equipo propio (deducida de las posiciones)').length).toBeLessThanOrEqual(KB_FORMATION_MAX_CHARS);
      }
    }
  });
  it('voleibol con su formación de recepción', () => {
    const k = selectKnowledge({ sport: 'voleibol', formationKey: 'vb-recepcion-w', firstFrame: null });
    expect(k.user).toContain('Recepción en W');
    expect(k.system).toContain('Saque y recepción del saque');
  });
});
