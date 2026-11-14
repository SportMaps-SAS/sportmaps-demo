/**
 * Selección de la base táctica propia (data/tactical-kb) para el prompt de
 * «Analizar jugada» — RAG ligero, 2026-10-27.
 *
 * Qué entra y dónde (cuidando tokens):
 *   · SISTEMA: principios por momento de juego del DEPORTE (estable por deporte:
 *     no rompe la caché de prompt del proveedor). Tope KB_PRINCIPLES_MAX_CHARS.
 *   · USUARIO: fortalezas/debilidades de la FORMACIÓN propia (la que eligió el
 *     coach en la pizarra o, si no llegó, la deducida de las posiciones del
 *     primer cuadro) y de la del rival si se puede deducir. Tope
 *     KB_FORMATION_MAX_CHARS por formación.
 * Nada de la base pasa si el deporte no la tiene. Lógica PURA (sin base ni red).
 */
import { FUTBOL_KB } from '../data/tactical-kb/futbol';
import { FUTBOL5_KB, FUTBOL7_KB, FUTSAL_KB } from '../data/tactical-kb/futbol-reducido';
import { BALONCESTO_KB, BALONMANO_KB, VOLEIBOL_KB } from '../data/tactical-kb/otros-deportes';
import { MOMENTS, type FormationKnowledge, type SportKnowledge } from '../data/tactical-kb/types';
import { COURTS, PLAYERS_PER_SIDE, type AiSport } from '../routes/school/tacticalAiShapes';

export const KB_BY_SPORT: Record<AiSport, SportKnowledge> = {
  futbol: FUTBOL_KB,
  futbol7: FUTBOL7_KB,
  futbol5: FUTBOL5_KB,
  futsal: FUTSAL_KB,
  voleibol: VOLEIBOL_KB,
  baloncesto: BALONCESTO_KB,
  balonmano: BALONMANO_KB,
};

/** ~375 tokens de principios como máximo (4 caracteres ≈ 1 token en español). */
export const KB_PRINCIPLES_MAX_CHARS = 1500;
/** ~110 tokens por formación. */
export const KB_FORMATION_MAX_CHARS = 450;

/** Deportes que tienen arquero/portero (se separa antes de leer las líneas). */
const HAS_GK: Record<AiSport, boolean> = {
  futbol: true, futbol7: true, futbol5: true, futsal: true, voleibol: false, baloncesto: false, balonmano: true,
};

/** Versión de la base del deporte: entra al hash de la caché de análisis. */
export function kbVersion(sport: AiSport): string {
  return KB_BY_SPORT[sport]?.version ?? 'sin-base';
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/**
 * Principios por momento de juego, para el SISTEMA. Baja de 3 a 1 viñeta por
 * momento hasta caber en `maxChars`; si ni así cabe, recorta.
 */
export function principlesSection(sport: AiSport, maxChars = KB_PRINCIPLES_MAX_CHARS): string {
  const kb = KB_BY_SPORT[sport];
  if (!kb) return '';
  const head = 'PRINCIPIOS TÁCTICOS DE REFERENCIA (base de SportMaps para este deporte; úsalos para la lectura, los riesgos y las variantes, sin copiarlos textual):';
  for (let per = 3; per >= 1; per--) {
    const body = MOMENTS.map((m) => `- ${kb.momentLabels[m]}: ${kb.momentos[m].slice(0, per).join(' ')}`).join('\n');
    const text = `${head}\n${body}`;
    if (text.length <= maxChars) return text;
  }
  const body = MOMENTS.map((m) => `- ${kb.momentLabels[m]}: ${kb.momentos[m][0] ?? ''}`).join('\n');
  return clip(`${head}\n${body}`, maxChars);
}

export function findFormation(sport: AiSport, key: string | null | undefined): FormationKnowledge | null {
  if (!key) return null;
  const own = KB_BY_SPORT[sport]?.formaciones.find((f) => f.key === key);
  if (own) return own;
  // Fútbol 11 con plantel de 7 usa 'f7-2-3-1' del catálogo de fútbol: las
  // claves son únicas entre deportes, así que se busca en la base del otro.
  for (const kb of Object.values(KB_BY_SPORT)) {
    const f = kb.formaciones.find((x) => x.key === key);
    if (f) return f;
  }
  return null;
}

// ─── Formación por posiciones ───────────────────────────────────────────────

/** Separación mínima entre dos líneas y dispersión máxima dentro de una línea,
 *  en fracción del LARGO de la cancha. */
export const LINE_MIN_GAP = 0.05;
export const LINE_MAX_SPREAD = 0.15;
/** Por debajo de esto (0 = fondo rival, 1 = fondo propio) no es arquero. */
const GK_MIN_DEPTH = 0.8;

export interface Pt { x: number; y: number }

/**
 * Formación de un equipo según las posiciones (en % del tablero). `side`
 * 'propio' defiende abajo; 'rival' defiende arriba (se espeja). Solo con el
 * equipo COMPLETO dibujado; si no encaja limpio en ninguna formación con
 * líneas de la base, null (mejor nada que una formación equivocada).
 */
export function inferFormation(sport: AiSport, players: Pt[], side: 'propio' | 'rival' = 'propio'): FormationKnowledge | null {
  const kb = KB_BY_SPORT[sport];
  const c = COURTS[sport];
  if (!kb || !c || players.length !== PLAYERS_PER_SIDE[sport]) return null;
  const len = c.y1 - c.y0;
  if (!(len > 0)) return null;
  // Profundidad: 1 = pegado a SU propio arco, 0 = arco contrario.
  let depth = players.map((p) => {
    const t = (p.y - c.y0) / len;
    return side === 'propio' ? t : 1 - t;
  }).filter(Number.isFinite).sort((a, b) => b - a);
  if (depth.length !== players.length) return null;
  if (HAS_GK[sport]) {
    if (depth[0] < GK_MIN_DEPTH) return null;
    depth = depth.slice(1);
  }

  let best: { f: FormationKnowledge; spread: number } | null = null;
  for (const f of kb.formaciones) {
    if (!f.lines || f.lines.reduce((a, b) => a + b, 0) !== depth.length) continue;
    let i = 0;
    let maxSpread = 0;
    let ok = true;
    let prevMin: number | null = null;
    for (const n of f.lines) {
      const group = depth.slice(i, i + n);
      i += n;
      const hi = group[0];
      const lo = group[group.length - 1];
      maxSpread = Math.max(maxSpread, hi - lo);
      if (prevMin !== null && prevMin - hi < LINE_MIN_GAP) { ok = false; break; }
      prevMin = lo;
    }
    if (!ok || maxSpread > LINE_MAX_SPREAD) continue;
    if (!best || maxSpread < best.spread - 1e-9 || (Math.abs(maxSpread - best.spread) <= 1e-9 && f.lines.length < (best.f.lines?.length ?? 99))) {
      best = { f, spread: maxSpread };
    }
  }
  return best?.f ?? null;
}

export function formationSection(f: FormationKnowledge, who: string, maxChars = KB_FORMATION_MAX_CHARS): string {
  return clip(`${who}: ${f.label}. Fortalezas: ${f.fortalezas.join(' ')} Debilidades: ${f.debilidades.join(' ')}`, maxChars);
}

export interface KnowledgeSelection {
  /** Va al final del prompt de SISTEMA. */
  system: string;
  /** Va al final del prompt de USUARIO (null = nada de formación). */
  user: string | null;
  ownFormation: string | null;
  rivalFormation: string | null;
  version: string;
}

/**
 * Lo que entra al prompt para una jugada. `formationKey` es la que eligió el
 * coach en la pizarra (manda si es del catálogo de la base); si no, se deduce
 * de los propios del primer cuadro. La del rival solo se deduce.
 */
export function selectKnowledge(args: {
  sport: AiSport;
  formationKey?: string | null;
  firstFrame?: { propios: Pt[]; rivales: Pt[] } | null;
}): KnowledgeSelection {
  const { sport } = args;
  const chosen = findFormation(sport, args.formationKey);
  const own = chosen ?? (args.firstFrame ? inferFormation(sport, args.firstFrame.propios, 'propio') : null);
  const rival = args.firstFrame ? inferFormation(sport, args.firstFrame.rivales, 'rival') : null;
  const lines: string[] = [];
  if (own) lines.push(formationSection(own, chosen ? 'Formación del equipo propio (la eligió el entrenador)' : 'Formación del equipo propio (deducida de las posiciones)'));
  if (rival) lines.push(formationSection(rival, 'Formación del rival (deducida de las posiciones)'));
  return {
    system: principlesSection(sport),
    user: lines.length ? `Referencia táctica de las formaciones (úsala para los riesgos, los contraataques y las variantes):\n${lines.join('\n')}` : null,
    ownFormation: own?.key ?? null,
    rivalFormation: rival?.key ?? null,
    version: kbVersion(sport),
  };
}
