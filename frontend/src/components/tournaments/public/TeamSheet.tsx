import { ExternalLink, FileText, MapPin, PlayCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { validateStreamUrl } from '@/lib/tournamentDisplay';
import { PublicMatchCard, TeamBadge } from './PublicMatchCard';
import {
  lastKoRoundByCup, phaseShort, safeUrl, sponsorsByTier, teamSheet, TIER_LABEL, venueDirections,
  type PublicMatchV2, type PublicSponsor, type StandingsV2, type TeamInfo, type TournamentView,
} from './publicModel';

/** Ficha de equipo: escudo, posición en la tabla, récord y todos sus partidos. */
export function TeamSheet({ teamId, onClose, matches, standings, teams, hrefFor }: {
  teamId: string | null; onClose: () => void; matches: PublicMatchV2[]; standings: StandingsV2 | null | undefined;
  teams: Map<string, TeamInfo>; hrefFor?: (m: PublicMatchV2) => string;
}) {
  const team = teamId ? teams.get(teamId) : null;
  const data = teamId ? teamSheet(teamId, matches, standings) : null;
  const last = lastKoRoundByCup(matches);
  return (
    <Sheet open={!!teamId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="mx-auto max-h-[88vh] max-w-lg overflow-y-auto rounded-t-2xl">
        {team && data && (
          <>
            <SheetHeader className="items-center text-center">
              <TeamBadge team={team} name={team.name} size="xl" />
              <SheetTitle className="text-xl">{team.name}</SheetTitle>
              <SheetDescription>
                {[team.club_name && team.club_name !== team.name ? team.club_name : null,
                  data.position ? `${data.position.pos}.º ${data.position.group ? `del Grupo ${data.position.group}` : 'en la tabla'}` : null,
                ].filter(Boolean).join(' · ') || 'Equipo del torneo'}
              </SheetDescription>
            </SheetHeader>
            <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[['Ganados', data.record.W], ['Perdidos', data.record.L], ['Puntos', data.position?.row.Pts ?? 0]].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-muted p-2"><dt className="text-[11px] uppercase text-muted-foreground">{k}</dt><dd className="text-2xl font-extrabold tabular-nums">{v}</dd></div>
              ))}
            </dl>
            <h3 className="mt-5 text-sm font-bold">Partidos</h3>
            <div className="mt-2 space-y-2">
              {data.matches.length === 0 ? <p className="text-sm text-muted-foreground">Aún no tiene partidos programados.</p>
                : data.matches.map((m) => (
                  <PublicMatchCard key={m.id} match={m} phase={phaseShort(m, last.get(m.cup_label ?? '') ?? m.round)} teams={teams} href={hrefFor?.(m)} />
                ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Patrocinadores: el principal grande; oficiales y aliados en franja que se desliza. */
export function SponsorsStrip({ sponsors }: { sponsors: PublicSponsor[] }) {
  const tiers = sponsorsByTier(sponsors);
  if (tiers.length === 0) return null;
  return (
    <section aria-label="Patrocinadores" className="space-y-3">
      {tiers.map((g) => (
        <div key={g.tier} className="space-y-1.5">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{TIER_LABEL[g.tier]}</h3>
          <ul className={g.tier === 'principal' ? 'grid gap-2' : '-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1'}>
            {g.sponsors.map((s) => {
              const url = safeUrl(s.url);
              const body = s.logo_url
                ? <img src={s.logo_url} alt={s.name} loading="lazy" className={g.tier === 'principal' ? 'mx-auto h-16 max-w-full object-contain' : 'h-10 max-w-[7rem] object-contain'} />
                : <span className="font-semibold">{s.name}</span>;
              const cls = g.tier === 'principal'
                ? 'flex min-h-[5rem] items-center justify-center rounded-xl border bg-white p-3 text-slate-900'
                : 'flex h-14 min-w-[7.5rem] snap-start items-center justify-center rounded-xl border bg-white px-3 text-sm text-slate-900';
              return (
                <li key={s.id}>
                  {url ? <a href={url} target="_blank" rel="noopener noreferrer sponsored" className={cls} aria-label={s.name}>{body}</a> : <div className={cls}>{body}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Pie: sede con mapa, reglamento, transmisión y «Powered by SportMaps» (siempre). */
export function PublicFooter({ t, slug }: { t: TournamentView; slug: string }) {
  const v = t.venue;
  const dirs = venueDirections(v, t.city);
  const embedQ = [v?.name, v?.address, t.city].filter(Boolean).join(', ');
  const rules = safeUrl(t.rules_url);
  const stream = t.stream_url && !validateStreamUrl(t.stream_url) ? t.stream_url : null;
  const cta = `/register?utm_source=torneo_en_vivo&utm_medium=pie&utm_campaign=${encodeURIComponent(slug)}`;
  return (
    <footer className="space-y-4 pt-2">
      {(stream || rules) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {stream && (
            <Button asChild className="bg-red-600 text-white hover:bg-red-700">
              <a href={stream} target="_blank" rel="noopener noreferrer"><PlayCircle className="mr-2 h-4 w-4" aria-hidden /> Ver transmisión</a>
            </Button>
          )}
          {rules && (
            <Button asChild variant="outline">
              <a href={rules} target="_blank" rel="noopener noreferrer"><FileText className="mr-2 h-4 w-4" aria-hidden /> Reglamento</a>
            </Button>
          )}
        </div>
      )}
      {(v?.name || v?.address) && (
        <section aria-label="Sede" className="overflow-hidden rounded-xl border bg-card">
          {embedQ && (
            <iframe
              title={`Mapa de ${v?.name ?? 'la sede'}`}
              src={`https://www.google.com/maps?q=${encodeURIComponent(embedQ)}&output=embed`}
              className="h-40 w-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          )}
          <div className="flex items-center gap-3 p-3">
            <MapPin className="h-5 w-5 shrink-0 text-[var(--brand-ink)]" aria-hidden />
            <div className="min-w-0 flex-1 text-sm">
              {v?.name && <p className="font-semibold">{v.name}</p>}
              {v?.address && <p className="text-muted-foreground">{v.address}</p>}
            </div>
          </div>
          {dirs && (
            <div className="grid grid-cols-2 gap-2 px-3 pb-3" role="group" aria-label="Cómo llegar">
              <Button asChild size="sm" variant="outline">
                <a href={dirs.google} target="_blank" rel="noopener noreferrer" aria-label="Cómo llegar con Google Maps">Google Maps <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden /></a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={dirs.waze} target="_blank" rel="noopener noreferrer" aria-label="Cómo llegar con Waze">Waze <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden /></a>
              </Button>
            </div>
          )}
        </section>
      )}
      <div className="flex flex-col items-center gap-2 border-t py-5 text-center text-sm text-muted-foreground">
        <a href="https://sportmaps.co" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium hover:text-foreground" data-testid="powered-by">
          <img src="/favicon.png" alt="" className="h-4 w-4" />
          Powered by SportMaps
        </a>
        <Button asChild size="sm" variant="secondary"><a href={cta}>Organiza tu torneo con SportMaps</a></Button>
      </div>
    </footer>
  );
}
