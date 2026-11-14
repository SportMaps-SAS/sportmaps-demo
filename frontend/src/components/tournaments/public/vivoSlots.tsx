/**
 * Dónde se enchufa lo de «vivo» (components/tournaments/live/) en la experiencia pública.
 *
 * 1. `FollowSlot` → `<SeguirTorneoButton />` en las acciones del encabezado.
 * 2. Página del partido → `<MatchSocialPanel />` (comentarios, medios y MVP) y `<ShareResultButton />`.
 * 3. Tarjetas jugadas de la pestaña Partidos → `<ShareResultButton />` (imagen del resultado).
 * 4. Tiempo real → `usePublicLive` (Broadcast + polling de respaldo); `transport` alimenta el indicador.
 * 5. Ranking → `GET /public/:slug/player-stats` (usePlayerStats, abajo) o `player_stats` en el payload.
 */
import { useEffect, useState } from 'react';
import { SeguirTorneoButton } from '@/components/tournaments/live/SeguirTorneoButton';
import { liveApi, type PlayerStatLine } from '@/components/tournaments/live/liveApi';
import type { PlayerStat, TeamInfo } from './publicModel';

export interface FollowSlotProps {
  slug: string;
  /** Equipos de la categoría que se está viendo (para «seguir a un equipo»). */
  teams: Array<{ id: string; name: string }>;
}

export function FollowSlot({ slug, teams }: FollowSlotProps) {
  return <SeguirTorneoButton slug={slug} teams={teams} className="bg-white/15 text-inherit hover:bg-white/25" />;
}

/** Línea del BFF de «vivo» → fila del ranking público. */
export function toPlayerStat(l: PlayerStatLine, teams: Map<string, TeamInfo & { category_id?: string | null }>): PlayerStat {
  const t = teams.get(l.team_id);
  return {
    id: l.member_id, team_id: l.team_id, team_name: t?.name ?? null, category_id: t?.category_id ?? null,
    player_label: l.name, aces: l.ace, attack_points: l.attack, blocks: l.block, points: l.points,
  };
}

/** Estadísticas por jugadora del torneo. `null` mientras carga o si el endpoint no existe / no hay datos. */
export function usePlayerStats(slug: string | undefined): PlayerStatLine[] | null {
  const [rows, setRows] = useState<PlayerStatLine[] | null>(null);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    liveApi.playerStats(slug)
      .then((r) => { if (alive) setRows(Array.isArray(r?.player_stats) && r.player_stats.length > 0 ? r.player_stats : null); })
      .catch(() => { if (alive) setRows(null); });
    return () => { alive = false; };
  }, [slug]);
  return rows;
}
