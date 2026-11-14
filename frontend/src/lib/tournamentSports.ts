/**
 * Catálogo de deportes de TORNEO: qué plantilla de marcador usa cada uno, cómo se anota y qué
 * planilla se imprime. Lo usan el asistente de creación, el anotador (LiveScorer) y la planilla.
 *
 * El nombre (`name`) es lo que se guarda en `events.sport`; el BFF sugiere la plantilla con
 * `presetKeyForSport(name)` (motor compartido), así que cada nombre de aquí debe resolver a su
 * `defaultPreset` (lo afirma una prueba).
 */
import { SCORING_PRESETS, type ScoringConfig } from '@/lib/tournamentScoring';

/** Cómo se ve el anotador. */
export type ScorerKind =
  | 'goals'    // fútbol, futsal, hockey, balonmano, baloncesto, videojuegos por goles, genérico
  | 'sets'     // vóley, vóley playa, futvóley, bádminton, tenis de mesa, pádel, bochas
  | 'tennis'   // tenis, beach tennis: 15-30-40, games y tie-break
  | 'chess'    // 1 · ½ · 0, blancas / negras
  | 'cricket'  // runs / wickets / overs por innings
  | 'maps'     // videojuegos al mejor de N mapas
  | 'marks';   // atletismo: ranking por marca (no es «A vs B»)

/** Qué planilla imprimible corresponde. */
export type SheetKind = 'volleyball' | 'football' | 'basketball' | 'racket' | 'chess' | 'cricket' | 'generic' | 'marks';

export interface TournamentSport {
  key: string;
  /** Nombre visible y valor de `events.sport`. */
  name: string;
  emoji: string;
  /** Plantillas de marcador que tienen sentido (la primera es la sugerida). */
  presets: string[];
  defaultPreset: string;
  mode: 'versus' | 'marks';
  /** Palabra para el marcador grande: «Goles», «Puntos», «Runs»… */
  unit: string;
  sheet: SheetKind;
  /** Cómo llamar a local / visitante (ajedrez: blancas / negras). */
  sides?: { home: string; away: string };
  /** Nombre del desempate de un empate en eliminatoria. */
  shootout?: string;
}

export const TOURNAMENT_SPORTS: TournamentSport[] = [
  { key: 'futbol', name: 'Fútbol', emoji: '⚽', presets: ['futbol'], defaultPreset: 'futbol', mode: 'versus', unit: 'Goles', sheet: 'football', shootout: 'Penales' },
  { key: 'futsal', name: 'Futsal', emoji: '👟', presets: ['futbol'], defaultPreset: 'futbol', mode: 'versus', unit: 'Goles', sheet: 'football', shootout: 'Penales' },
  { key: 'balonmano', name: 'Balonmano', emoji: '🤾', presets: ['balonmano', 'balonmano_3'], defaultPreset: 'balonmano', mode: 'versus', unit: 'Goles', sheet: 'football', shootout: 'Lanzamientos de 7 m' },
  { key: 'baloncesto', name: 'Baloncesto', emoji: '🏀', presets: ['baloncesto'], defaultPreset: 'baloncesto', mode: 'versus', unit: 'Puntos', sheet: 'basketball' },
  { key: 'voleibol', name: 'Voleibol', emoji: '🏐', presets: ['voleibol_3', 'voleibol_5'], defaultPreset: 'voleibol_3', mode: 'versus', unit: 'Puntos', sheet: 'volleyball' },
  { key: 'voley_playa', name: 'Vóley playa', emoji: '🏖️', presets: ['voley_playa'], defaultPreset: 'voley_playa', mode: 'versus', unit: 'Puntos', sheet: 'volleyball' },
  { key: 'futvoley', name: 'Futvóley', emoji: '🦶', presets: ['futvoley'], defaultPreset: 'futvoley', mode: 'versus', unit: 'Puntos', sheet: 'volleyball' },
  { key: 'tenis_mesa', name: 'Tenis de mesa', emoji: '🏓', presets: ['tenis_mesa'], defaultPreset: 'tenis_mesa', mode: 'versus', unit: 'Puntos', sheet: 'racket' },
  { key: 'tenis', name: 'Tenis', emoji: '🎾', presets: ['tenis', 'tenis_super'], defaultPreset: 'tenis', mode: 'versus', unit: 'Puntos', sheet: 'racket' },
  { key: 'beach_tennis', name: 'Beach tennis', emoji: '🌴', presets: ['beach_tennis', 'beach_tennis_3'], defaultPreset: 'beach_tennis', mode: 'versus', unit: 'Puntos', sheet: 'racket' },
  { key: 'padel', name: 'Pádel', emoji: '🥎', presets: ['padel'], defaultPreset: 'padel', mode: 'versus', unit: 'Games', sheet: 'racket' },
  { key: 'badminton', name: 'Bádminton', emoji: '🏸', presets: ['badminton'], defaultPreset: 'badminton', mode: 'versus', unit: 'Puntos', sheet: 'racket' },
  { key: 'ajedrez', name: 'Ajedrez', emoji: '♟️', presets: ['ajedrez'], defaultPreset: 'ajedrez', mode: 'versus', unit: 'Puntos', sheet: 'chess', sides: { home: 'Blancas', away: 'Negras' }, shootout: 'Armagedón' },
  { key: 'bochas', name: 'Bochas', emoji: '🎱', presets: ['bochas', 'bochas_13'], defaultPreset: 'bochas', mode: 'versus', unit: 'Puntos', sheet: 'generic' },
  { key: 'hockey', name: 'Hockey', emoji: '🏑', presets: ['hockey'], defaultPreset: 'hockey', mode: 'versus', unit: 'Goles', sheet: 'football', shootout: 'Shoot-out / penales' },
  { key: 'criquet', name: 'Críquet', emoji: '🏏', presets: ['criquet'], defaultPreset: 'criquet', mode: 'versus', unit: 'Runs', sheet: 'cricket', shootout: 'Super over' },
  { key: 'atletismo', name: 'Atletismo', emoji: '🏃', presets: ['generico'], defaultPreset: 'generico', mode: 'marks', unit: 'Marca', sheet: 'marks' },
  { key: 'generico', name: 'Deporte genérico', emoji: '🏆', presets: ['generico', 'generico_sin_empate'], defaultPreset: 'generico', mode: 'versus', unit: 'Puntos', sheet: 'generic', shootout: 'Desempate' },
  { key: 'videojuegos', name: 'Videojuegos (e-sports)', emoji: '🎮', presets: ['videojuegos_mapas', 'videojuegos_mapas_5', 'videojuegos_goles'], defaultPreset: 'videojuegos_mapas', mode: 'versus', unit: 'Mapas', sheet: 'generic' },
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Deporte del catálogo a partir de `events.sport` (texto libre de torneos viejos incluido). */
export function sportFromName(name: string | null | undefined): TournamentSport | null {
  if (!name) return null;
  const n = norm(name);
  return TOURNAMENT_SPORTS.find((s) => norm(s.name) === n || s.key === n)
    ?? TOURNAMENT_SPORTS.find((s) => n.startsWith(norm(s.name)))
    ?? null;
}

/** Deporte que corresponde a una plantilla (para el anotador, que solo recibe la config). */
export function sportForPreset(preset: string | null | undefined): TournamentSport | null {
  if (!preset) return null;
  return TOURNAMENT_SPORTS.find((s) => s.defaultPreset === preset) ?? TOURNAMENT_SPORTS.find((s) => s.presets.includes(preset)) ?? null;
}

/** Tipo de anotador según la configuración efectiva del partido. */
export function scorerKindFor(cfg: Pick<ScoringConfig, 'model' | 'preset' | 'tennis' | 'half_points' | 'cricket' | 'set_points'>): ScorerKind {
  if (cfg.model === 'sets') {
    if (cfg.tennis) return 'tennis';
    if (cfg.preset?.startsWith('videojuegos') || cfg.set_points === 1) return 'maps';
    return 'sets';
  }
  if (cfg.half_points) return 'chess';
  if (cfg.cricket) return 'cricket';
  return 'goals';
}

/** Planilla que corresponde a la config cuando no se conoce el deporte. */
export function sheetKindFor(cfg: Pick<ScoringConfig, 'model' | 'preset' | 'tennis' | 'half_points' | 'cricket' | 'set_points'>, sport?: string | null): SheetKind {
  const bySport = sportFromName(sport) ?? sportForPreset(cfg.preset);
  if (bySport) return bySport.sheet;
  switch (scorerKindFor(cfg)) {
    case 'tennis': return 'racket';
    case 'chess': return 'chess';
    case 'cricket': return 'cricket';
    case 'sets': return cfg.preset?.startsWith('vole') || cfg.preset === 'voley_playa' ? 'volleyball' : 'racket';
    default: return 'generic';
  }
}

export const presetLabel = (key: string) => SCORING_PRESETS[key]?.label ?? key;

/** Formatos del asistente (valores de `competition_format`). */
export const WIZARD_FORMATS = [
  { key: 'liga', label: 'Todos contra todos', hint: 'Cada equipo juega contra todos. Gana quien más puntos sume.' },
  { key: 'grupos', label: 'Grupos + eliminatoria', hint: 'Fase de grupos y después cruces hasta la final.' },
  { key: 'copa', label: 'Eliminatoria', hint: 'Partido único: el que pierde queda fuera.' },
] as const;
export type WizardFormat = (typeof WIZARD_FORMATS)[number]['key'];
