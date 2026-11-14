/**
 * Planilla de juego por deporte — modelo PURO (qué tablas lleva cada planilla). El PDF lo dibuja
 * planillaPdf.ts. Sirve precargada (equipos, fase, cancha, hora y nómina si existe) o en blanco
 * para llenar a mano.
 */
import type { SheetKind } from '@/lib/tournamentSports';

export interface PlanillaInfo {
  tournament: string;
  sport?: string | null;
  category?: string | null;
  phase?: string | null;
  court?: string | null;
  /** Fecha y hora ya formateadas («sáb 7 nov · 8:00 a. m.»). */
  when?: string | null;
  home?: string | null;
  away?: string | null;
  homeRoster?: RosterLine[];
  awayRoster?: RosterLine[];
  /** Sets máximos (vóley, raqueta). */
  bestOf?: number;
  /** Cómo llamar a cada lado (ajedrez: Blancas / Negras). */
  sides?: { home: string; away: string };
}

/** Jugador en la nómina: solo el nombre, o con dorsal y marca («Suspensión», «Fuera de edad»). */
export type RosterLine = string | { name: string; number?: string | number | null; flag?: string | null };

/** Nombre con su marca, para que el árbitro vea quién no puede jugar (no se esconde a nadie). */
export const lineName = (l: RosterLine): string => (typeof l === 'string' ? l : l.flag ? `${l.name} (${l.flag.toUpperCase()})` : l.name);
export const lineNumber = (l: RosterLine): string => (typeof l === 'string' || l.number == null ? '' : String(l.number));

export interface PlanillaBlock {
  title: string;
  columns: string[];
  /** Ancho relativo de cada columna (suma libre). */
  widths: number[];
  rows: number;
  /** Celdas precargadas por fila (las demás quedan en blanco). */
  prefill?: string[][];
  /** Dos bloques seguidos con `half` se dibujan lado a lado. */
  half?: boolean;
}

export interface PlanillaModel {
  title: string;
  header: Array<[string, string]>;
  blocks: PlanillaBlock[];
  signatures: string[];
}

const blank = (v: string | null | undefined) => (v && v.trim() ? v : '');

function rosterBlock(title: string, columns: string[], widths: number[], rows: number, roster: RosterLine[] | undefined): PlanillaBlock {
  const lines = (roster ?? []).slice(0, rows);
  return { title, columns, widths, rows: Math.max(rows, lines.length), prefill: lines.map((l) => [lineNumber(l), lineName(l)]), half: true };
}

export function buildPlanilla(kind: SheetKind, info: PlanillaInfo): PlanillaModel {
  const homeSide = info.sides?.home ?? 'Local';
  const awaySide = info.sides?.away ?? 'Visitante';
  const home = blank(info.home);
  const away = blank(info.away);
  const header: Array<[string, string]> = [
    ['Torneo', blank(info.tournament)],
    ['Deporte', blank(info.sport)],
    ['Categoría', blank(info.category)],
    ['Fase', blank(info.phase)],
    ['Cancha / mesa', blank(info.court)],
    ['Fecha y hora', blank(info.when)],
    [homeSide, home],
    [awaySide, away],
  ];
  const bestOf = Math.max(1, Math.min(info.bestOf ?? 5, 7));
  const tHome = home || homeSide;
  const tAway = away || awaySide;
  const blocks: PlanillaBlock[] = [];
  const sigs = ['Árbitro / juez', `Capitán ${tHome}`, `Capitán ${tAway}`];

  switch (kind) {
    case 'volleyball': {
      blocks.push(rosterBlock(`Nómina ${tHome}`, ['N.º', 'Jugador', 'C / L'], [1, 5, 1.2], 14, info.homeRoster));
      blocks.push(rosterBlock(`Nómina ${tAway}`, ['N.º', 'Jugador', 'C / L'], [1, 5, 1.2], 14, info.awayRoster));
      blocks.push({ title: 'Sets', columns: ['Set', tHome, tAway, `Tiempos ${homeSide}`, `Tiempos ${awaySide}`, 'Cambios L / V'], widths: [0.8, 1.4, 1.4, 1.6, 1.6, 1.6], rows: bestOf,
        prefill: Array.from({ length: bestOf }, (_, i) => [String(i + 1)]) });
      blocks.push({ title: 'Rotaciones (formación inicial por set)', columns: ['Set · equipo', 'I', 'II', 'III', 'IV', 'V', 'VI'], widths: [2.4, 1, 1, 1, 1, 1, 1], rows: bestOf * 2,
        prefill: Array.from({ length: bestOf * 2 }, (_, i) => [`Set ${Math.floor(i / 2) + 1} · ${i % 2 === 0 ? tHome : tAway}`]) });
      break;
    }
    case 'football': {
      blocks.push(rosterBlock(`Nómina ${tHome}`, ['N.º', 'Jugador', 'Goles', 'TA', 'TR'], [0.8, 4.4, 0.9, 0.6, 0.6], 18, info.homeRoster));
      blocks.push(rosterBlock(`Nómina ${tAway}`, ['N.º', 'Jugador', 'Goles', 'TA', 'TR'], [0.8, 4.4, 0.9, 0.6, 0.6], 18, info.awayRoster));
      blocks.push({ title: 'Resultado', columns: ['Equipo', '1.er tiempo', '2.º tiempo', 'Final', 'Penales'], widths: [3, 1.3, 1.3, 1.3, 1.3], rows: 2, prefill: [[tHome], [tAway]] });
      blocks.push({ title: 'Goles', columns: ['Min', 'Equipo', 'N.º', 'Jugador'], widths: [0.8, 2.4, 0.8, 3.6], rows: 10, half: true });
      blocks.push({ title: 'Tarjetas (TA amarilla · TR roja)', columns: ['Min', 'Equipo', 'N.º', 'TA/TR', 'Motivo'], widths: [0.8, 2, 0.8, 0.9, 2.6], rows: 10, half: true });
      blocks.push({ title: 'Cambios', columns: ['Min', 'Equipo', 'Sale (N.º)', 'Entra (N.º)'], widths: [0.8, 3, 1.6, 1.6], rows: 8 });
      break;
    }
    case 'basketball': {
      const fouls = ['F1', 'F2', 'F3', 'F4', 'F5'];
      blocks.push(rosterBlock(`Nómina ${tHome}`, ['N.º', 'Jugador', ...fouls, 'Pts'], [0.8, 3.6, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8], 14, info.homeRoster));
      blocks.push(rosterBlock(`Nómina ${tAway}`, ['N.º', 'Jugador', ...fouls, 'Pts'], [0.8, 3.6, 0.5, 0.5, 0.5, 0.5, 0.5, 0.8], 14, info.awayRoster));
      blocks.push({ title: 'Puntos por cuarto', columns: ['Equipo', 'Q1', 'Q2', 'Q3', 'Q4', 'Tiempo extra', 'Total'], widths: [3, 1, 1, 1, 1, 1.4, 1.2], rows: 2, prefill: [[tHome], [tAway]] });
      blocks.push({ title: 'Faltas de equipo y tiempos muertos', columns: ['Equipo', 'Faltas Q1', 'Faltas Q2', 'Faltas Q3', 'Faltas Q4', 'Tiempos muertos'], widths: [3, 1, 1, 1, 1, 2], rows: 2, prefill: [[tHome], [tAway]] });
      break;
    }
    case 'racket': {
      blocks.push({ title: 'Jugadores', columns: ['Lado', 'Jugador(es)'], widths: [2, 6], rows: 2, prefill: [[homeSide, [home, ...(info.homeRoster ?? []).map(lineName)].filter(Boolean).join(' · ')], [awaySide, [away, ...(info.awayRoster ?? []).map(lineName)].filter(Boolean).join(' · ')]] });
      blocks.push({ title: 'Sets (games o puntos)', columns: ['Set', tHome, tAway, 'Tie-break', 'Saca primero'], widths: [0.8, 1.6, 1.6, 1.6, 1.8], rows: bestOf,
        prefill: Array.from({ length: bestOf }, (_, i) => [String(i + 1)]) });
      blocks.push({ title: 'Observaciones (amonestaciones, retiros, lesiones)', columns: [''], widths: [1], rows: 4 });
      sigs.splice(1, 2, `Jugador ${tHome}`, `Jugador ${tAway}`);
      break;
    }
    case 'chess': {
      const rows = 40;
      blocks.push({ title: 'Jugadas', columns: ['N.º', 'Blancas', 'Negras', 'N.º', 'Blancas', 'Negras'], widths: [0.6, 2, 2, 0.6, 2, 2], rows,
        prefill: Array.from({ length: rows }, (_, i) => [String(i + 1), '', '', String(i + 1 + rows)]) });
      blocks.push({ title: 'Resultado (marca uno)', columns: ['1 - 0', '½ - ½', '0 - 1', 'Tiempo usado blancas', 'Tiempo usado negras'], widths: [1, 1, 1, 2, 2], rows: 1 });
      sigs.splice(0, 3, `Blancas: ${home || '__________'}`, `Negras: ${away || '__________'}`, 'Árbitro');
      break;
    }
    case 'cricket': {
      for (const [team, roster] of [[tHome, info.homeRoster], [tAway, info.awayRoster]] as const) {
        const names = (roster ?? []).slice(0, 11).map(lineName);
        blocks.push({ title: `Bateo ${team}`, columns: ['Bateador', 'Runs', 'Bolas', '4s', '6s', 'Cómo salió'], widths: [3, 0.8, 0.8, 0.6, 0.6, 2.4], rows: 11, prefill: names.map((n) => [n]), half: true });
      }
      blocks.push({ title: 'Resumen por innings', columns: ['Equipo', 'Runs', 'Wickets', 'Overs', 'Extras', 'Total'], widths: [3, 1, 1, 1, 1, 1], rows: 2, prefill: [[tHome], [tAway]] });
      blocks.push({ title: 'Lanzadores', columns: ['Lanzador', 'Equipo', 'Overs', 'Maidens', 'Runs', 'Wickets'], widths: [3, 2, 0.9, 0.9, 0.9, 0.9], rows: 8 });
      break;
    }
    case 'marks': {
      blocks.push({ title: 'Prueba: ______________________   Serie: ____   Viento: ____', columns: ['Carril / orden', 'Participante', 'Equipo', 'Int. 1', 'Int. 2', 'Int. 3', 'Mejor marca', 'Pos.'], widths: [1, 3, 2, 1, 1, 1, 1.4, 0.7], rows: 16 });
      sigs.splice(0, 3, 'Juez de la prueba', 'Cronometrista / medidor', 'Juez árbitro');
      break;
    }
    default: {
      blocks.push(rosterBlock(`Nómina ${tHome}`, ['N.º', 'Participante', 'Puntos'], [0.8, 5, 1], 12, info.homeRoster));
      blocks.push(rosterBlock(`Nómina ${tAway}`, ['N.º', 'Participante', 'Puntos'], [0.8, 5, 1], 12, info.awayRoster));
      blocks.push({ title: 'Marcador por periodo / partida / mapa', columns: ['Periodo', tHome, tAway, 'Notas'], widths: [1.4, 1.6, 1.6, 3.4], rows: 7,
        prefill: Array.from({ length: 7 }, (_, i) => [String(i + 1)]) });
      blocks.push({ title: 'Resultado final', columns: ['Equipo', 'Marcador', 'Desempate'], widths: [3, 1.5, 1.5], rows: 2, prefill: [[tHome], [tAway]] });
    }
  }

  return { title: `Planilla de juego${info.sport ? ` · ${info.sport}` : ''}`, header, blocks, signatures: sigs };
}

/** Nombre de archivo sin tildes ni espacios. */
export function planillaFileName(info: Pick<PlanillaInfo, 'home' | 'away' | 'tournament'>): string {
  const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  const vs = info.home && info.away ? `${slug(info.home)}-vs-${slug(info.away)}` : 'en-blanco';
  return `planilla-${slug(info.tournament || 'torneo') || 'torneo'}-${vs}.pdf`;
}
