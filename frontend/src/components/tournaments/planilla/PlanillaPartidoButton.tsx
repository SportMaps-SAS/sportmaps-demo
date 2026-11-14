/**
 * Botón «Planilla»: descarga en PDF la planilla de juego del deporte, precargada con el partido
 * (equipos, fase, cancha, hora y nómina si se puede leer) o en blanco si no se pasa `match`.
 *
 * Dónde va: en el anotador (LiveScorer, ya montado) y en cada partido del panel del organizador
 * (SchoolTournamentDetailPage / TournamentResultsPanel), con
 *   <PlanillaPartidoButton match={m} tournamentTitle={ev.title} sport={ev.sport}
 *     loadRoster={() => loadMatchRoster(ev.id, m.id)} />
 */
import { useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { FileDown, Loader2 } from 'lucide-react';
import { bffClient } from '@/lib/api/bffClient';
import { formatBogota, stageLabel, teamName } from '@/lib/tournamentDisplay';
import { sheetKindFor, sportForPreset, sportFromName } from '@/lib/tournamentSports';
import type { ScoringConfig } from '@/lib/tournamentScoring';
import type { MatchDto } from '@/lib/tournamentTypes';
import { buildPlanilla, planillaFileName, type PlanillaInfo, type RosterLine } from './planillaModel';
import { downloadPlanilla } from './planillaPdf';

/** Nómina del partido; `category` viene del BFF si el panel no la pasa. */
export interface PlanillaRoster { home: RosterLine[]; away: RosterLine[]; category?: string | null }

interface SheetRosterPlayer { name: string; shirt_number: number | null; flag: string | null }

type MatchLike = Pick<MatchDto, 'home_name' | 'away_name' | 'home_label' | 'away_label' | 'stage' | 'group_label' | 'round' | 'court' | 'scheduled_at'> & { config?: ScoringConfig };

interface Props extends Omit<ButtonProps, 'onClick'> {
  match?: MatchLike | null;
  tournamentTitle?: string;
  sport?: string | null;
  categoryName?: string | null;
  /** Sin `match`: config para saber qué planilla en blanco imprimir. */
  config?: ScoringConfig;
  loadRoster?: () => Promise<PlanillaRoster | null>;
  label?: string;
}

/**
 * Nómina del partido desde el BFF (solo organizador: GET /tournament-live/school/:id/matches/:mid/sheet-roster):
 * dorsal, categoría y la marca de quien no está habilitado (misma regla que el QR del carné).
 */
export async function loadMatchRoster(eventId: string, matchId: string): Promise<PlanillaRoster | null> {
  try {
    const r = await bffClient.get<{ category: string | null; home: SheetRosterPlayer[]; away: SheetRosterPlayer[] }>(
      `/api/v1/tournament-live/school/${encodeURIComponent(eventId)}/matches/${encodeURIComponent(matchId)}/sheet-roster`,
    );
    const line = (x: SheetRosterPlayer): RosterLine => ({ name: x.name, number: x.shirt_number, flag: x.flag });
    return { home: (r.home ?? []).map(line), away: (r.away ?? []).map(line), category: r.category ?? null };
  } catch {
    return null;
  }
}

export function planillaInfoFor(p: { match?: MatchLike | null; tournamentTitle?: string; sport?: string | null; categoryName?: string | null; config?: ScoringConfig }, roster?: PlanillaRoster | null): PlanillaInfo {
  const cfg = p.match?.config ?? p.config;
  const sp = sportFromName(p.sport) ?? sportForPreset(cfg?.preset);
  const m = p.match;
  return {
    tournament: p.tournamentTitle ?? '',
    sport: p.sport ?? sp?.name ?? null,
    category: p.categoryName ?? roster?.category ?? null,
    phase: m ? stageLabel(m) : null,
    court: m?.court ?? null,
    when: m?.scheduled_at ? formatBogota(m.scheduled_at, { day: true }) : null,
    home: m ? teamName(m, 'home') : null,
    away: m ? teamName(m, 'away') : null,
    homeRoster: roster?.home ?? [],
    awayRoster: roster?.away ?? [],
    bestOf: cfg?.model === 'sets' ? cfg.best_of : undefined,
    sides: sp?.sides,
  };
}

export function PlanillaPartidoButton({ match, tournamentTitle, sport, categoryName, config, loadRoster, label = 'Planilla', ...btn }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    setBusy(true);
    try {
      const roster = match && loadRoster ? await loadRoster().catch(() => null) : null;
      const info = planillaInfoFor({ match, tournamentTitle, sport, categoryName, config }, roster);
      const cfg = match?.config ?? config;
      const kind = cfg ? sheetKindFor(cfg, sport) : (sportFromName(sport)?.sheet ?? 'generic');
      await downloadPlanilla(buildPlanilla(kind, info), planillaFileName(info));
    } catch {
      toast({ title: 'No se pudo generar la planilla', description: 'Intenta de nuevo.', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" variant="outline" {...btn} onClick={() => void onClick()} disabled={busy || btn.disabled} data-testid="planilla-btn">
      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileDown className="mr-1 h-4 w-4" />} {label}
    </Button>
  );
}
