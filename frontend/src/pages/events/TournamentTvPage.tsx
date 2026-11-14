import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePublicLive, useNoIndex } from '@/hooks/usePublicLive';
import { nowAndNextByCourt } from '@/lib/tournamentDisplay';
import { brandStyle } from '@/components/tournaments/public/brand';
import { LiveBadge } from '@/components/tournaments/public/PublicHeader';
import { PublicMatchCard, TeamBadge } from '@/components/tournaments/public/PublicMatchCard';
import { PublicSportProvider, usePublicSport } from '@/components/tournaments/public/sportContext';
import {
  filterMatches, initials, shortCategoryName, lastKoRoundByCup, phaseShort, publicStandingColumns, sponsorsByTier, standingGroups, teamIndex, tournamentView, tvPlan,
  type PublicMatchV2, type TvSlide,
} from '@/components/tournaments/public/publicModel';

export const TV_ROTATION_MS = 10000;
/** Las tarjetas son las del celular; en la TV se agrandan con zoom para que se lean desde lejos. */
const TV_ZOOM = 1.45;
const tvGrid = (n: number) => (n <= 1 ? 'mx-auto grid max-w-4xl gap-6' : 'grid gap-6 lg:grid-cols-2');

/** Modo TV: solo lectura, letra grande, rota sola entre en vivo / posiciones / próximos / resultados / patrocinadores. */
export default function TournamentTvPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  useNoIndex();
  const { data, notFound, loading } = usePublicLive(slug);
  const [idx, setIdx] = useState(0);
  const t = data ? tournamentView(data) : null;
  const slides: TvSlide[] = data && t ? tvPlan(data, t.sponsors) : [];

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setInterval(() => setIdx((i) => i + 1), TV_ROTATION_MS);
    return () => clearInterval(timer);
  }, [slides.length]);

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-background text-3xl text-muted-foreground">Cargando…</div>;
  if (notFound || !data || !t) return <div className="flex min-h-screen items-center justify-center bg-background text-3xl text-muted-foreground">No encontramos este torneo.</div>;

  const { style } = brandStyle(t.brand_color);
  const slide = slides.length ? slides[idx % slides.length] : null;
  const teams = teamIndex(data);
  const matches = data.matches as PublicMatchV2[];
  const last = lastKoRoundByCup(matches);
  const ph = (m: PublicMatchV2) => [data.categories.length > 1 ? shortCategoryName(data.categories.find((c) => c.id === m.category_id)?.name ?? '') : null, phaseShort(m, last.get(m.cup_label ?? '') ?? m.round)].filter(Boolean).join(' · ');
  const nextByCourt = nowAndNextByCourt(matches.filter((m) => !m.is_bye)).filter((c) => c.next).slice(0, 6);
  const liveCount = data.event.live_enabled ? filterMatches(matches, 'live').length : 0;

  return (
    <PublicSportProvider sport={t.sport}>
    <div className="flex min-h-screen cursor-none select-none flex-col bg-background text-foreground" style={style} data-testid="tv">
      <header className="flex items-center gap-5 bg-[var(--brand)] px-10 py-5 text-[var(--brand-fg)]">
        {t.logo_url
          ? <img src={t.logo_url} alt="" className="h-20 w-20 rounded-2xl bg-white object-contain" />
          : <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white/15 text-3xl font-black" aria-hidden>{initials(t.title)}</span>}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-5xl font-extrabold">{t.title}</h1>
          {slide && <p className="mt-1 text-3xl opacity-90" aria-live="polite">{slide.title}</p>}
        </div>
        <LiveBadge count={liveCount} className="px-4 py-2 text-2xl" />
      </header>
      {slides.length > 1 && (
        <div className="h-1.5 bg-muted" aria-hidden>
          <div key={idx} className="h-full bg-[var(--brand)]" style={{ animation: `tvbar ${TV_ROTATION_MS}ms linear forwards` }} />
          <style>{'@keyframes tvbar{from{width:0}to{width:100%}}'}</style>
        </div>
      )}
      <main className="flex-1 px-10 py-8">
        {!slide && <p className="text-4xl text-muted-foreground">Todavía no hay partidos para mostrar.</p>}
        {slide?.kind === 'live' && (
          <div className={tvGrid(filterMatches(matches, 'live').slice(0, 6).length)} style={{ zoom: TV_ZOOM }}>
            {filterMatches(matches, 'live').slice(0, 6).map((m) => <PublicMatchCard key={m.id} match={m} phase={ph(m)} teams={teams} large hourOnlyTime />)}
          </div>
        )}
        {slide?.kind === 'standings' && <TvStandings data={data.standings[slide.categoryId]} teams={teams} />}
        {slide?.kind === 'upcoming' && (
          <div className={tvGrid(nextByCourt.length)} style={{ zoom: TV_ZOOM }}>
            {nowAndNextByCourt(matches.filter((m) => !m.is_bye)).filter((c) => c.next).slice(0, 6).map((c) => (
              <div key={c.court} className="space-y-2">
                <h2 className="text-3xl font-bold text-[var(--brand-ink)]">{c.court}</h2>
                <PublicMatchCard match={c.next!} phase={ph(c.next!)} teams={teams} large hourOnlyTime />
              </div>
            ))}
          </div>
        )}
        {slide?.kind === 'results' && (
          <div className={tvGrid(filterMatches(matches, 'played').slice(0, 6).length)} style={{ zoom: TV_ZOOM }}>
            {filterMatches(matches, 'played').slice(0, 6).map((m) => <PublicMatchCard key={m.id} match={m} phase={ph(m)} teams={teams} large hourOnlyTime />)}
          </div>
        )}
        {slide?.kind === 'sponsors' && (
          <div className="space-y-10">
            {sponsorsByTier(t.sponsors).map((g) => (
              <div key={g.tier} className="flex flex-wrap items-center justify-center gap-10">
                {g.sponsors.map((s) => (
                  <div key={s.id} className={`flex items-center justify-center rounded-2xl bg-white p-6 text-slate-900 ${g.tier === 'principal' ? 'h-48 w-96' : 'h-32 w-64'}`}>
                    {s.logo_url ? <img src={s.logo_url} alt={s.name} className="max-h-full max-w-full object-contain" /> : <span className="text-3xl font-bold">{s.name}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </main>
      <footer className="px-10 pb-6 text-xl text-muted-foreground">Powered by SportMaps · sportmaps.co</footer>
    </div>
    </PublicSportProvider>
  );
}

function TvStandings({ data, teams }: { data: Parameters<typeof standingGroups>[0]; teams: ReturnType<typeof teamIndex> }) {
  const { kind } = usePublicSport();
  if (!data) return null;
  const cols = publicStandingColumns(data.model, kind);
  const groups = standingGroups(data);
  return (
    <div className={`grid gap-8 ${groups.length > 1 ? 'xl:grid-cols-2' : ''}`}>
      {groups.map((g) => (
        <div key={g.label ?? 'liga'} className="space-y-2">
          {g.label && <h2 className="text-3xl font-bold text-[var(--brand-ink)]">Grupo {g.label}</h2>}
          <table className="w-full text-2xl tabular-nums">
            <thead><tr className="border-b text-xl text-muted-foreground">
              <th className="py-2 text-left">Equipo</th>
              {cols.map((c) => <th key={c.key} className="px-2 py-2 text-center">{c.label}</th>)}
            </tr></thead>
            <tbody>
              {g.rows.map((r, i) => (
                <tr key={r.team_id} className={`border-b ${i === 0 && r.P > 0 ? 'bg-amber-50 dark:bg-amber-950/30' : ''}`}>
                  <td className="py-3"><span className="flex items-center gap-3"><span className="w-8 text-muted-foreground">{i + 1}</span><TeamBadge team={teams.get(r.team_id)} name={r.team_name} size="lg" /><span className="font-semibold">{r.team_name}</span></span></td>
                  {cols.map((c) => <td key={c.key} className={`px-2 text-center ${c.strong ? 'font-extrabold' : ''}`}>{c.value(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
