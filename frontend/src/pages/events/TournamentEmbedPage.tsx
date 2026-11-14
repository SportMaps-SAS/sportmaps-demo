import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { usePublicLive, useNoIndex } from '@/hooks/usePublicLive';
import { brandStyle } from '@/components/tournaments/public/brand';
import { CupsTab, EmptyState, MatchesTab, ScheduleTab, StandingsTab } from '@/components/tournaments/public/PublicTabs';
import { TeamSheet } from '@/components/tournaments/public/TeamSheet';
import { PublicSportProvider } from '@/components/tournaments/public/sportContext';
import { cn } from '@/lib/utils';
import { parseEmbedView, pickCategory, shortCategoryName, teamIndex, tournamentView, type PublicMatchV2 } from '@/components/tournaments/public/publicModel';

/**
 * Vista para INSERTAR en otra web: /torneo/:slug/embed?vista=posiciones|partidos|programacion|copas&categoria=…&fondo=transparente
 * Sin encabezado ni menú. Es la ÚNICA ruta que vercel.json deja embeber (frame-ancestors *).
 * Avisa su alto a la página que la contiene con postMessage({ type: 'sportmaps:embed-height', height }).
 */
export default function TournamentEmbedPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const [params] = useSearchParams();
  useNoIndex();
  const { data, notFound, loading } = usePublicLive(slug);
  const [teamOpen, setTeamOpen] = useState<string | null>(null);
  const vista = parseEmbedView(params.get('vista'));
  const transparent = params.get('fondo') === 'transparente';
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!transparent) return;
    const prev = [document.documentElement.style.background, document.body.style.background];
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => { document.documentElement.style.background = prev[0]; document.body.style.background = prev[1]; };
  }, [transparent]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined' || window.parent === window) return;
    const ro = new ResizeObserver(() => window.parent.postMessage({ type: 'sportmaps:embed-height', slug, height: Math.ceil(el.scrollHeight) }, '*'));
    ro.observe(el);
    return () => ro.disconnect();
  });

  const matches = useMemo(() => (data?.matches ?? []) as PublicMatchV2[], [data]);
  const teams = useMemo(() => (data ? teamIndex(data) : new Map()), [data]);
  if (loading) return <div className="p-4" aria-busy="true"><div className="h-32 animate-pulse rounded-xl bg-muted" /></div>;
  if (notFound || !data) return <div className="p-4"><EmptyState icon="🔎" title="Torneo no disponible" /></div>;

  const t = tournamentView(data);
  const { style } = brandStyle(t.brand_color);
  const catId = pickCategory(data.categories, params.get('categoria'), matches);
  const catMatches = matches.filter((m) => !catId || m.category_id === catId);
  const catFull = data.categories.find((c) => c.id === catId)?.name;
  const catName = catFull ? shortCategoryName(catFull) : undefined;
  const full = `/torneo/${encodeURIComponent(slug)}/en-vivo${catId ? `?cat=${encodeURIComponent(catId)}` : ''}`;
  const props = { matches: catMatches, teams, onTeam: setTeamOpen };

  return (
    <PublicSportProvider sport={t.sport}>
    <div ref={rootRef} className={cn('p-3 text-foreground', !transparent && 'bg-background')} style={style} data-testid="embed">
      {catName && data.categories.length > 1 && <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--brand-ink)]">{catName}</p>}
      {vista === 'posiciones' && <StandingsTab standings={catId ? data.standings[catId] : undefined} {...props} />}
      {vista === 'partidos' && <MatchesTab {...props} />}
      {vista === 'programacion' && <ScheduleTab {...props} />}
      {vista === 'copas' && <CupsTab {...props} />}
      <p className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <a href={full} target="_blank" rel="noopener noreferrer" className="underline">Ver el torneo completo</a>
        <a href="https://sportmaps.co" target="_blank" rel="noopener noreferrer">Powered by SportMaps</a>
      </p>
      <TeamSheet teamId={teamOpen} onClose={() => setTeamOpen(null)} matches={matches} standings={catId ? data.standings[catId] : undefined} teams={teams} />
    </div>
    </PublicSportProvider>
  );
}
