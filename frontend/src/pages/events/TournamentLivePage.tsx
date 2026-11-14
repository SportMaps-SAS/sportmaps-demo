import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePublicLive, useNoIndex } from '@/hooks/usePublicLive';
import { agoText, liveMatches } from '@/lib/tournamentDisplay';
import { PublicHeader } from '@/components/tournaments/public/PublicHeader';
import { brandStyle } from '@/components/tournaments/public/brand';
import { PublicMatchCard } from '@/components/tournaments/public/PublicMatchCard';
import { AllMatchesTab, CupsTab, EmptyState, MatchesTab, RankingTab, ScheduleTab, StandingsTab } from '@/components/tournaments/public/PublicTabs';
import { PublicFooter, SponsorsStrip, TeamSheet } from '@/components/tournaments/public/TeamSheet';
import type { ShareTarget } from '@/components/tournaments/public/ShareSheet';
import { toPlayerStat, usePlayerStats } from '@/components/tournaments/public/vivoSlots';
import { PublicSportProvider } from '@/components/tournaments/public/sportContext';
import { ShareResultButton } from '@/components/tournaments/live/ShareResultButton';
import {
  hasPlayerStats, lastKoRoundByCup, shortCategoryName, loadCategory, normalizePlayerStats, phaseShort, pickCategory, saveCategory, shareLink, teamIndex, todayBogota,
  tournamentPhase, tournamentView, type PublicMatchV2, type StandingsV2,
} from '@/components/tournaments/public/publicModel';

type TabKey = 'posiciones' | 'partidos' | 'programacion' | 'copas' | 'todos' | 'ranking';
const TAB_LABEL: Record<TabKey, string> = {
  posiciones: 'Posiciones', partidos: 'Partidos', programacion: 'Programación', copas: 'Copas', todos: 'Todos los partidos', ranking: 'Ranking',
};

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true" aria-label="Cargando torneo">
      <div className="h-44 animate-pulse bg-muted" />
      <div className="mx-auto max-w-3xl space-y-3 p-4">
        <div className="flex gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 w-24 animate-pulse rounded-full bg-muted" />)}</div>
        {[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}
      </div>
      <p className="sr-only" role="status">Cargando torneo…</p>
    </div>
  );
}

/**
 * Página PÚBLICA del torneo — sin login. Solo equipos y marcadores (nada de nombres de deportistas
 * más allá de lo que mande el payload público). Marca del torneo + «Powered by SportMaps» siempre.
 */
export default function TournamentLivePage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  useNoIndex();
  const { data, notFound, error, loading, updatedAt, now, transport } = usePublicLive(slug);
  const statLines = usePlayerStats(slug);
  const [catSel, setCatSel] = useState<string | null>(() => params.get('cat') ?? loadCategory(slug));
  const [tab, setTab] = useState<TabKey | null>(null);
  const [teamOpen, setTeamOpen] = useState<string | null>(null);

  const matches = useMemo(() => (data?.matches ?? []) as PublicMatchV2[], [data]);
  const categories = useMemo(() => (data?.categories ?? []).map((c) => ({ ...c, full: c.name, name: shortCategoryName(c.name) })), [data]);
  const catId = pickCategory(categories, catSel, matches);
  const catMatches = useMemo(() => matches.filter((m) => !catId || m.category_id === catId), [matches, catId]);
  const teams = useMemo(() => (data ? teamIndex(data) : new Map()), [data]);
  const liveAll = useMemo(() => liveMatches(matches), [matches]);
  const lastKo = useMemo(() => lastKoRoundByCup(matches), [matches]);

  useEffect(() => { if (catId) saveCategory(slug, catId); }, [slug, catId]);

  if (loading) return <LoadingSkeleton />;
  if (notFound || !data) {
    return (
      <div className="mx-auto max-w-md p-6">
        <EmptyState icon="🔎" title="No encontramos este torneo o todavía no es público">Revisa el enlace con quien lo organiza.</EmptyState>
      </div>
    );
  }

  const t = tournamentView(data);
  const phase = tournamentPhase(t, matches, todayBogota(now));
  const { style } = brandStyle(t.brand_color);
  // Ranking: lo que traiga el payload o, si no, el endpoint de «vivo». Sin datos, la pestaña no aparece.
  const playerStats = hasPlayerStats(data) ? normalizePlayerStats(data.player_stats, teams) : statLines ? statLines.map((l) => toPlayerStat(l, teams)) : null;
  const showRanking = !!playerStats;
  const tabs: TabKey[] = ['posiciones', 'partidos', 'programacion', 'copas', ...(categories.length > 1 ? ['todos' as const] : []), ...(showRanking ? ['ranking' as const] : [])];
  const active: TabKey = tab && tabs.includes(tab) ? tab : (liveAll.some((m) => m.category_id === catId) ? 'partidos' : 'posiciones');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const catName = categories.find((c) => c.id === catId)?.name;
  const shareTargets: ShareTarget[] = [
    { scope: 'tournament', label: 'Torneo', title: t.title, url: shareLink(origin, slug, 'tournament') },
    ...(catId && catName && categories.length > 1 ? [{ scope: 'category' as const, label: 'Categoría', title: `${t.title} · ${catName}`, url: shareLink(origin, slug, 'category', { categoryId: catId }) }] : []),
  ];
  const hrefFor = (m: PublicMatchV2) => `/torneo/${encodeURIComponent(slug)}/partido/${encodeURIComponent(m.id)}`;
  const pickCat = (id: string) => {
    setCatSel(id);
    const p = new URLSearchParams(params); p.set('cat', id); setParams(p, { replace: true });
  };
  const standing = catId ? data.standings[catId] : undefined;
  const inCat = new Set(catMatches.flatMap((m) => [m.home_team_id, m.away_team_id]));
  const followTeams = Array.from(teams.values())
    .filter((x) => (x.category_id ? x.category_id === catId : inCat.has(x.id)))
    .map((x) => ({ id: x.id, name: x.name }));
  const actionFor = (m: PublicMatchV2) => (m.status === 'played' || m.status === 'walkover'
    ? <ShareResultButton match={m} tournament={t.title} category={catName} url={`${origin}${hrefFor(m)}`} label="Compartir resultado" />
    : null);
  const tabProps = { matches: catMatches, teams, onTeam: setTeamOpen, hrefFor, actionFor };

  return (
    <PublicSportProvider sport={t.sport}>
    <div className="min-h-screen bg-background text-foreground" style={style}>
      <PublicHeader slug={slug} t={t} phase={phase} liveCount={data.event.live_enabled ? liveAll.length : 0}
        shareTargets={shareTargets} error={error} followTeams={followTeams} embed={{ slug, categoryId: catId, title: t.title }}
        updatedText={transport === 'push' ? 'En tiempo real' : agoText(updatedAt, now)} />

      <nav className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur" aria-label="Secciones del torneo">
        <div className="mx-auto max-w-3xl space-y-2 px-4 py-2">
          {categories.length > 1 && active !== 'todos' && (
            categories.length <= 6 ? (
              <div className="-mx-4 flex snap-x gap-2 overflow-x-auto scroll-px-4 px-4 pr-10 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] [scrollbar-width:none]" role="radiogroup" aria-label="Categoría">
                {categories.map((c) => (
                  <button key={c.id} type="button" role="radio" aria-checked={c.id === catId} onClick={() => pickCat(c.id)} title={c.full}
                    className={cn('shrink-0 snap-start whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-semibold', c.id === catId ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-fg)]' : 'bg-card')}>
                    {c.name}
                  </button>
                ))}
              </div>
            ) : (
              <label className="block">
                <span className="sr-only">Categoría</span>
                <select value={catId ?? ''} onChange={(e) => pickCat(e.target.value)} className="h-10 w-full rounded-lg border bg-card px-3 text-sm font-semibold" aria-label="Categoría">
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )
          )}
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4" role="tablist" aria-label="Pestañas">
            {tabs.map((k) => (
              <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={k === active} aria-controls={`panel-${k}`} onClick={() => setTab(k)}
                className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors', k === active ? 'bg-[var(--brand)] text-[var(--brand-fg)]' : 'text-muted-foreground hover:bg-muted')}>
                {TAB_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-3xl space-y-6 px-4 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-4">
        {!data.event.live_enabled && (
          <p className="rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">Este torneo no tiene marcador en vivo: aquí verás los resultados y la tabla cuando se carguen.</p>
        )}
        {data.event.live_enabled && liveAll.length > 0 && active !== 'partidos' && active !== 'todos' && (
          <section aria-label="En juego ahora" className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-bold"><span className="h-2 w-2 animate-pulse rounded-full bg-red-600 motion-reduce:animate-none" aria-hidden /> En juego ahora</h2>
            <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
              {liveAll.map((m) => (
                <div key={m.id} className="w-[85%] shrink-0 snap-start sm:w-80">
                  <PublicMatchCard match={m} phase={[categories.length > 1 ? categories.find((c) => c.id === m.category_id)?.name : null, phaseShort(m, lastKo.get(m.cup_label ?? '') ?? m.round)].filter(Boolean).join(' · ')}
                    teams={teams} onTeam={setTeamOpen} href={hrefFor(m)} hourOnlyTime />
                </div>
              ))}
            </div>
          </section>
        )}

        <section role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
          {active === 'posiciones' && <StandingsTab standings={standing} {...tabProps} />}
          {active === 'partidos' && <MatchesTab key={catId ?? 'x'} {...tabProps} />}
          {active === 'programacion' && <ScheduleTab {...tabProps} />}
          {active === 'copas' && <CupsTab {...tabProps} />}
          {active === 'todos' && <AllMatchesTab {...tabProps} matches={matches} categories={categories} venueName={t.venue?.name} />}
          {active === 'ranking' && <RankingTab stats={playerStats ?? []} categoryId={catId} teams={teams} />}
        </section>

        <SponsorsStrip sponsors={t.sponsors} />
        <PublicFooter t={t} slug={slug} />
        {data.event.live_enabled && (
          <p className="text-center">
            <a href={`/torneo/${encodeURIComponent(slug)}/tv`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <Monitor className="h-3.5 w-3.5" aria-hidden /> Abrir en modo TV
            </a>
          </p>
        )}
      </main>

      <TeamSheet teamId={teamOpen} onClose={() => setTeamOpen(null)} matches={matches} standings={teamOpen ? findStandings(data.standings, teamOpen) : undefined} teams={teams} hrefFor={hrefFor} />
    </div>
    </PublicSportProvider>
  );
}

function findStandings(all: Record<string, StandingsV2>, teamId: string) {
  return Object.values(all).find((s) => (s.standings ?? []).some((r) => r.team_id === teamId) || Object.values(s.groups ?? {}).some((rows) => rows.some((r) => r.team_id === teamId)));
}
