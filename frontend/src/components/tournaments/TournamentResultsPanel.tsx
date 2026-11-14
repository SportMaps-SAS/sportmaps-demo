import { useCallback, useEffect, useMemo, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CalendarPlus, Share2, Tv, Radio, Clock } from 'lucide-react';
import type { LiveConfigDto, MatchDto, StandingsDto, FixturesResponse, TeamDto } from '@/lib/tournamentTypes';
import { byScheduleOrder } from '@/lib/tournamentDisplay';
import { MatchCard, StandingsView, BracketView } from './TournamentViews';
import { FixtureGeneratorDialog, LIVE_BASE, type TeamRef } from './FixtureGeneratorDialog';
import { LiveSettingsPanel } from './LiveSettingsPanel';
import { LiveScorer, type ScorerEndpoints } from './LiveScorer';
import { MatchScheduleDialog } from './MatchScheduleDialog';
import { PlanillaPartidoButton, loadMatchRoster } from './planilla/PlanillaPartidoButton';

const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface PanelCategory { id: string; division: string; category: string; rama: string }

/** Equipos de la categoría que se conocen por los partidos y la tabla (el BFF valida la cantidad real). */
export function teamsFrom(matches: MatchDto[], standings: StandingsDto | null): TeamRef[] {
  const map = new Map<string, string>();
  for (const m of matches) {
    if (m.home_team_id && m.home_name) map.set(m.home_team_id, m.home_name);
    if (m.away_team_id && m.away_name) map.set(m.away_team_id, m.away_name);
  }
  const rows = [...(standings?.standings ?? []), ...Object.values(standings?.groups ?? {}).flat()];
  for (const r of rows) map.set(r.team_id, r.team_name);
  return Array.from(map, ([id, name]) => ({ id, name }));
}

/** Partidos de fase final agrupados por copa (null = copa única), en el orden en que aparecen. */
export function knockoutByCup(matches: MatchDto[]): Array<{ cup: string | null; matches: MatchDto[] }> {
  const out: Array<{ cup: string | null; matches: MatchDto[] }> = [];
  for (const m of matches) {
    const cup = m.cup_label ?? null;
    const g = out.find((x) => x.cup === cup);
    if (g) g.matches.push(m); else out.push({ cup, matches: [m] });
  }
  return out;
}

export function TournamentResultsPanel({ eventId, categories }: { eventId: string; categories: PanelCategory[] }) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}`;
  const [catId, setCatId] = useState(categories[0]?.id ?? '');
  const [config, setConfig] = useState<LiveConfigDto | null>(null);
  const [matches, setMatches] = useState<MatchDto[]>([]);
  const [standings, setStandings] = useState<StandingsDto | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [scoring, setScoring] = useState<MatchDto | null>(null);
  const [editing, setEditing] = useState<MatchDto | null>(null);
  const [catTeams, setCatTeams] = useState<TeamDto[]>([]);

  const loadConfig = useCallback(async () => {
    try { setConfig(await bffClient.get<LiveConfigDto>(`${base}/config`)); }
    catch (e) { toast({ title: 'No se pudieron cargar los ajustes en vivo', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, toast]);

  const loadResults = useCallback(async (c: string) => {
    if (!c) return;
    try {
      const [m, s, t] = await Promise.all([
        bffClient.get<MatchDto[]>(`${base}/matches?category_id=${c}`),
        bffClient.get<StandingsDto>(`${base}/standings?category_id=${c}`),
        // Internos y rivales externos: el sorteo manual los necesita aunque aún no haya partidos.
        bffClient.get<TeamDto[]>(`${base}/teams`).catch(() => [] as TeamDto[]),
      ]);
      setMatches(m); setStandings(s); setCatTeams(t.filter((x) => x.category_id === c));
    } catch (e) { toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, toast]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { void loadResults(catId); }, [catId, loadResults]);

  const teams = useMemo(() => {
    const known = catTeams.map((t) => ({ id: t.id, name: t.name }));
    return known.length > 0 ? known : teamsFrom(matches, standings);
  }, [catTeams, matches, standings]);
  const courts = useMemo(() => Array.from(new Set(matches.map((m) => m.court).filter(Boolean) as string[])).sort(), [matches]);
  const model = standings?.model ?? matches[0]?.model ?? 'goals';
  const sorted = useMemo(() => matches.slice().sort(byScheduleOrder), [matches]);
  const knockoutMatches = sorted.filter((m) => m.stage === 'knockout' || m.stage === 'third_place');
  const groupMatches = sorted.filter((m) => m.stage === 'group');
  const leagueMatches = sorted.filter((m) => m.stage === 'league');
  const cat = categories.find((c) => c.id === catId);
  const categoryName = cat ? `${cat.division} · ${cat.category} (${cat.rama})` : null;
  const groupLabels = Array.from(new Set(groupMatches.map((m) => m.group_label ?? ''))).sort();

  const endpoints: ScorerEndpoints = useMemo(() => ({
    actionsUrl: (id) => `${base}/matches/${id}/actions`,
    takeUrl: (id) => `${base}/matches/${id}/take`,
  }), [base]);

  const liveUrl = config ? `${window.location.origin}/torneo/${config.event.slug}/en-vivo` : '';
  const shareLive = async () => {
    try {
      if (navigator.share) await navigator.share({ title: config?.event.title, url: liveUrl });
      else { await navigator.clipboard.writeText(liveUrl); toast({ title: 'Enlace en vivo copiado' }); }
    } catch { /* cancelado */ }
  };

  const anotar = (m: MatchDto) => (
    <div className="flex gap-1">
      <PlanillaPartidoButton size="sm" variant="ghost" match={m} tournamentTitle={config?.event.title} sport={config?.event.sport}
        categoryName={categoryName} loadRoster={() => loadMatchRoster(eventId, m.id)} />
      <Button size="sm" variant="ghost" onClick={() => setEditing(m)} aria-label="Editar hora y cancha" title="Hora y cancha"><Clock className="h-4 w-4" /></Button>
      <Button size="sm" variant="outline" disabled={!m.home_team_id || !m.away_team_id} title={!m.home_team_id || !m.away_team_id ? 'Los equipos aún no están definidos' : undefined} onClick={() => setScoring(m)} aria-label="Anotar este partido">Anotar</Button>
    </div>
  );

  if (scoring) {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
        <LiveScorer
          match={scoring} endpoints={endpoints} queueKey={`torneo-cola:school:${eventId}`} tournamentTitle={config?.event.title}
          onClose={() => { setScoring(null); void loadResults(catId); }}
          onMatchChange={(m) => setMatches((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)))}
        />
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
        Primero agrega categorías (pestaña Categorías y Precios) para generar el calendario.
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Categoría" className={selectCls + ' max-w-xs'} value={catId} onChange={(e) => setCatId(e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.division} · {c.category} ({c.rama})</option>)}
        </select>
        <Button variant="outline" onClick={() => setGenOpen(true)}><CalendarPlus className="mr-1 h-4 w-4" /> Generar calendario</Button>
        {config && (
          <>
            <Button variant="outline" onClick={shareLive}><Share2 className="mr-1 h-4 w-4" /> Compartir en vivo</Button>
            <Button variant="ghost" asChild><a href={`/torneo/${config.event.slug}/tv`} target="_blank" rel="noreferrer"><Tv className="mr-1 h-4 w-4" /> Modo TV</a></Button>
            <Button variant="ghost" asChild><a href={`/torneo/${config.event.slug}/en-vivo`} target="_blank" rel="noreferrer"><Radio className="mr-1 h-4 w-4" /> Ver página pública</a></Button>
          </>
        )}
      </div>

      {config && (
        <LiveSettingsPanel eventId={eventId} config={config} onChanged={loadConfig}
          categories={categories.map((c) => ({ id: c.id, name: `${c.division} · ${c.category} (${c.rama})` }))} />
      )}

      <MatchScheduleDialog eventId={eventId} match={editing} courts={courts} onClose={() => setEditing(null)}
        onSaved={(m) => setMatches((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)))} />

      <FixtureGeneratorDialog
        open={genOpen} onOpenChange={setGenOpen} eventId={eventId} categoryId={catId} teams={teams}
        onGenerated={(_r: FixturesResponse) => { void loadResults(catId); }}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">{groupLabels.length > 0 ? 'Posiciones por grupo' : 'Tabla de posiciones'}</CardTitle></CardHeader>
        <CardContent><StandingsView data={standings ? { ...standings, model } : null} /></CardContent>
      </Card>

      {model === 'goals' && (standings?.scorers?.length ?? 0) > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Goleadores</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {standings!.scorers!.map((s, i) => (
              <div key={i} className="flex justify-between border-b py-1 last:border-0"><span>{i + 1}. {s.name}</span><span className="font-semibold">{s.goals}</span></div>
            ))}
          </CardContent>
        </Card>
      )}

      {matches.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">Genera el calendario para ver los partidos.</CardContent></Card>
      ) : (
        <>
          {leagueMatches.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Partidos</CardTitle></CardHeader>
              <CardContent className="space-y-2">{leagueMatches.map((m) => <MatchCard key={m.id} match={m} action={anotar(m)} />)}</CardContent>
            </Card>
          )}
          {groupLabels.map((g) => (
            <Card key={g}>
              <CardHeader><CardTitle className="text-base">Partidos · Grupo {g}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {groupMatches.filter((m) => (m.group_label ?? '') === g).map((m) => <MatchCard key={m.id} match={m} action={anotar(m)} />)}
              </CardContent>
            </Card>
          ))}
          {knockoutByCup(knockoutMatches).map(({ cup, matches: cm }) => (
            <Card key={cup ?? '_'}>
              <CardHeader><CardTitle className="text-base">{cup ? `Fase final · ${cup}` : 'Fase final'}</CardTitle></CardHeader>
              <CardContent><BracketView matches={cm} renderAction={(m) => anotar(m as MatchDto)} /></CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
