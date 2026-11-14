import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { nowAndNextByCourt } from '@/lib/tournamentDisplay';
import { PublicMatchCard, TeamBadge } from './PublicMatchCard';
import {
  allMatchesFeed, buildCups, cupEmoji, PLAYER_METRIC_LABEL, playerRanking, type PlayerMetric, type PlayerStat, filterCounts, filterMatches, hourOnly, lastKoRoundByCup, MATCH_FILTER_LABEL, phaseShort,
  publicScore, publicStandingColumns, qualificationLegend, qualificationMap, roundMatchName, rowCup, scheduleByDayAndCourt, standingGroups,
  type MatchFilter, type PublicMatchV2, type StandingsV2, type TeamInfo,
} from './publicModel';
import { usePublicSport } from './sportContext';

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-8 text-center" role="status">
      <span className="text-3xl" aria-hidden>{icon}</span>
      <p className="font-medium">{title}</p>
      {children && <p className="max-w-xs text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Pastillas de filtro (Todos / En vivo / …) o de vista. Accesible como grupo de radio. */
export function Pills<K extends string>({ value, options, onChange, label }: { value: K; options: Array<{ key: K; label: string; count?: number }>; onChange: (k: K) => void; label: string }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => onChange(o.key)}
          className={cn(
            'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            o.key === value ? 'bg-[var(--brand)] text-[var(--brand-fg)]' : 'bg-muted text-foreground hover:bg-muted/70',
          )}
        >
          {o.label}{o.count != null && <span className="ml-1 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

const usePhase = (matches: PublicMatchV2[]) => {
  const last = useMemo(() => lastKoRoundByCup(matches), [matches]);
  return (m: PublicMatchV2) => phaseShort(m, last.get(m.cup_label ?? '') ?? m.round);
};

interface TabProps { matches: PublicMatchV2[]; teams: Map<string, TeamInfo>; onTeam: (id: string) => void; hrefFor?: (m: PublicMatchV2) => string; actionFor?: (m: PublicMatchV2) => ReactNode }

// ── Posiciones ───────────────────────────────────────────────────────────────

const CUP_ROW_TONE = ['bg-amber-50 dark:bg-amber-950/30', 'bg-slate-100 dark:bg-slate-800/50', 'bg-orange-50 dark:bg-orange-950/30', 'bg-sky-50 dark:bg-sky-950/30'];
const CUP_DOT_TONE = ['bg-amber-400', 'bg-slate-400', 'bg-orange-400', 'bg-sky-400'];

export function StandingsTab({ standings, matches, teams, onTeam }: TabProps & { standings: StandingsV2 | null | undefined }) {
  const groups = standingGroups(standings);
  const q = useMemo(() => qualificationMap(matches), [matches]);
  const legend = qualificationLegend(q);
  const cupOrder = useMemo(() => buildCups(matches).map((c) => c.label), [matches]);
  const { kind } = usePublicSport();
  if (!standings || groups.every((g) => g.rows.length === 0)) {
    return <EmptyState icon="📋" title="Todavía no hay posiciones">La tabla aparece cuando se arme el calendario de esta categoría.</EmptyState>;
  }
  const cols = publicStandingColumns(standings.model, kind);
  const tone = (cup: string | null, arr: string[]) => (cup ? arr[Math.max(0, cupOrder.indexOf(cup)) % arr.length] : '');
  const anyCup = legend.length > 0 || q.byTeam.size > 0;
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.label ?? 'liga'} aria-label={g.label ? `Grupo ${g.label}` : 'Tabla general'} className="space-y-1.5">
          {g.label && <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Grupo {g.label}</h3>}
          <div className="overflow-x-auto rounded-xl border bg-card" tabIndex={0} aria-label="Desliza para ver todas las columnas">
            <table className="w-full min-w-max border-collapse text-sm tabular-nums">
              <thead>
                <tr className="border-b text-[11px] uppercase text-muted-foreground">
                  <th scope="col" className="sticky left-0 z-10 bg-card py-2 pl-2 pr-2 text-left font-semibold">Equipo</th>
                  {cols.map((c) => <th key={c.key} scope="col" title={c.title} className={cn('px-1.5 py-2 text-center font-semibold', c.strong && 'text-foreground')}><abbr title={c.title} className="no-underline">{c.label}</abbr></th>)}
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r, i) => {
                  const cup = rowCup(q, g.label, i + 1, r.team_id);
                  const lead = !anyCup && i === 0 && r.P > 0;
                  const rowTone = cup ? tone(cup, CUP_ROW_TONE) : lead ? CUP_ROW_TONE[0] : '';
                  return (
                    <tr key={r.team_id} className={cn('border-b last:border-0', rowTone)} data-testid="standing-row">
                      <th scope="row" className={cn('sticky left-0 z-10 w-[12.5rem] max-w-[12.5rem] py-2 pl-2 pr-2 text-left font-medium', rowTone || 'bg-card')}>
                        <button type="button" onClick={() => onTeam(r.team_id)} className="flex w-full min-w-0 items-center gap-2 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <span className="w-4 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                          <TeamBadge team={teams.get(r.team_id)} name={r.team_name} size="sm" />
                          <span className="truncate">{r.team_name}</span>
                          {cup && <span className={cn('h-2 w-2 shrink-0 rounded-full', tone(cup, CUP_DOT_TONE))} aria-label={`Va a ${cup}`} />}
                        </button>
                      </th>
                      {cols.map((c) => <td key={c.key} className={cn('px-1.5 py-2 text-center', c.strong && 'font-bold')}>{c.value(r)}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {legend.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-muted/50 p-3 text-xs" aria-label="Quién clasifica">
          {legend.map((l) => (
            <li key={l.cup} className="flex items-center gap-2">
              <span className={cn('h-2.5 w-2.5 rounded-full', tone(l.cup, CUP_DOT_TONE))} aria-hidden />
              <span><b>{l.text}</b> → {l.cup}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        {cols.map((c) => `${c.label}: ${c.title.toLowerCase()}`).join(' · ')}
      </p>
    </div>
  );
}

// ── Partidos ─────────────────────────────────────────────────────────────────

export function MatchesTab({ matches, teams, onTeam, hrefFor, actionFor }: TabProps) {
  const counts = filterCounts(matches);
  const [f, setF] = useState<MatchFilter>(counts.live > 0 ? 'live' : 'all');
  const list = filterMatches(matches, f);
  const phase = usePhase(matches);
  const opts = (['all', 'live', 'played', 'upcoming'] as MatchFilter[])
    .filter((k) => k !== 'live' || counts.live > 0)
    .map((key) => ({ key, label: MATCH_FILTER_LABEL[key], count: counts[key] }));
  const empty: Record<MatchFilter, [string, string]> = {
    all: ['📅', 'Aún no hay partidos en esta categoría'], live: ['🏐', 'No hay partidos en juego ahora'],
    played: ['⏱️', 'Aún no hay partidos terminados'], upcoming: ['✅', 'No quedan partidos por jugar'],
  };
  return (
    <div className="space-y-3">
      <Pills<MatchFilter> label="Filtrar partidos" value={f} onChange={setF} options={opts} />
      {list.length === 0 ? <EmptyState icon={empty[f][0]} title={empty[f][1]} />
        : list.map((m) => <PublicMatchCard key={m.id} match={m} phase={phase(m)} teams={teams} onTeam={onTeam} href={hrefFor?.(m)} action={actionFor?.(m)} />)}
    </div>
  );
}

// ── Programación ─────────────────────────────────────────────────────────────

export function ScheduleTab({ matches, teams, onTeam, hrefFor }: TabProps) {
  const [view, setView] = useState<'ahora' | 'dia'>('dia');
  const days = scheduleByDayAndCourt(matches);
  const courts = nowAndNextByCourt(matches.filter((m) => !m.is_bye)).filter((c) => c.live || c.next);
  const phase = usePhase(matches);
  const { kind } = usePublicSport();
  if (days.length === 0) return <EmptyState icon="🗓️" title="La programación aún no está publicada">Cuando el organizador asigne horas y canchas las verás aquí.</EmptyState>;
  return (
    <div className="space-y-4">
      <Pills<'ahora' | 'dia'> label="Vista de programación" value={view} onChange={setView}
        options={[{ key: 'dia', label: 'Por día y cancha' }, { key: 'ahora', label: 'Ahora en cada cancha' }]} />
      {view === 'ahora' ? (
        courts.length === 0 ? <EmptyState icon="🏁" title="No hay partidos en juego ni pendientes" /> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {courts.map((c) => (
              <section key={c.court} className="space-y-2 rounded-xl border p-3" aria-label={c.court}>
                <h3 className="font-bold text-[var(--brand-ink)]">{c.court}</h3>
                {c.live && <PublicMatchCard match={c.live} phase={`Ahora · ${phase(c.live)}`} teams={teams} onTeam={onTeam} hourOnlyTime href={hrefFor?.(c.live)} />}
                {c.next && <PublicMatchCard match={c.next} phase={`Sigue · ${phase(c.next)}`} teams={teams} onTeam={onTeam} hourOnlyTime href={hrefFor?.(c.next)} />}
              </section>
            ))}
          </div>
        )
      ) : days.map((d) => (
        <section key={d.day ?? 'sin-fecha'} className="space-y-3" aria-label={d.title}>
          <h3 className="text-sm font-bold capitalize">{d.title}</h3>
          {d.courts.map((c) => (
            <div key={c.court} className="space-y-1">
              <h4 className="text-base font-extrabold text-[var(--brand-ink)]">{c.court}</h4>
              <ul className="divide-y rounded-xl border bg-card">
                {c.matches.map((m) => (
                  <li key={m.id} className={cn('flex items-center gap-3 px-3 py-2.5 text-sm', m.status === 'live' && 'bg-red-50 dark:bg-red-950/30')} data-testid="schedule-row">
                    <span className="w-[4.75rem] shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{hourOnly(m.scheduled_at)}</span>
                    <span className="min-w-0 flex-1">
                      <TeamLink m={m} side="home" onTeam={onTeam} /> <span className="text-muted-foreground">vs</span> <TeamLink m={m} side="away" onTeam={onTeam} />
                      {(() => { const sc = publicScore(m, kind); return sc && <span className="ml-1 font-bold tabular-nums">({sc.home}-{sc.away})</span>; })()}
                    </span>
                    <span className={cn('shrink-0 text-right text-[11px] uppercase', m.status === 'live' ? 'font-bold text-red-600' : 'text-muted-foreground')}>
                      {m.status === 'live' ? 'En vivo' : phase(m)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function TeamLink({ m, side, onTeam }: { m: PublicMatchV2; side: 'home' | 'away'; onTeam: (id: string) => void }) {
  const id = side === 'home' ? m.home_team_id : m.away_team_id;
  const name = (side === 'home' ? m.home_name ?? m.home_label : m.away_name ?? m.away_label) ?? 'Por definir';
  if (!id) return <span className="italic text-muted-foreground">{name}</span>;
  return <button type="button" className="font-medium hover:underline" onClick={() => onTeam(id)}>{name}</button>;
}

// ── Copas ────────────────────────────────────────────────────────────────────

export function CupsTab({ matches, teams, onTeam, hrefFor }: TabProps) {
  const cups = buildCups(matches);
  if (cups.length === 0) return <EmptyState icon="🏆" title="Las copas aún no se han definido">Aparecen cuando termine la fase de grupos y se arme la fase final.</EmptyState>;
  return (
    <div className="space-y-8">
      {cups.map((c) => (
        <section key={c.label} aria-label={c.label} className="space-y-3" data-testid="cup">
          <h3 className="flex items-center gap-2 text-lg font-extrabold text-[var(--brand-ink)]"><span aria-hidden>{cupEmoji(c.label)}</span> {c.label}</h3>
          {c.champion && (
            <p className="rounded-xl bg-amber-100 px-3 py-2 text-center font-bold text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" data-testid="champion">
              🏆 Campeón: {c.champion}
            </p>
          )}
          {c.rounds.map((r) => {
            const isFinal = c.final && r.matches.length === 1 && r.matches[0].id === c.final.id;
            return (
              <div key={r.round} className="space-y-2">
                {isFinal && <div className="text-center text-3xl" aria-hidden>🏆</div>}
                {r.matches.map((m, i) => (
                  <div key={m.id} className="space-y-1">
                    <h4 className={cn('text-xs font-bold uppercase tracking-wider text-muted-foreground', isFinal && 'text-center')}>{roundMatchName(r.name, i, r.matches.length)}</h4>
                    <PublicMatchCard match={m} phase={c.label} teams={teams} onTeam={onTeam} highlight={!!isFinal} href={hrefFor?.(m)} />
                  </div>
                ))}
              </div>
            );
          })}
          {c.thirdPlace && (
            <div className="space-y-1">
              <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">3.º y 4.º puesto</h4>
              <PublicMatchCard match={c.thirdPlace} phase={c.label} teams={teams} onTeam={onTeam} href={hrefFor?.(c.thirdPlace)} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// ── Todos los partidos (mezcla categorías) ───────────────────────────────────

export function AllMatchesTab({ matches, teams, onTeam, hrefFor, categories, venueName }: TabProps & { categories: Array<{ id: string; name: string }>; venueName?: string | null }) {
  const counts = filterCounts(matches);
  const [f, setF] = useState<MatchFilter>('all');
  const feed = allMatchesFeed(matches, categories, f);
  const phase = usePhase(matches);
  const opts = (['all', 'live', 'played', 'upcoming'] as MatchFilter[])
    .filter((k) => k !== 'live' || counts.live > 0)
    .map((key) => ({ key, label: MATCH_FILTER_LABEL[key], count: counts[key] }));
  return (
    <div className="space-y-3">
      <Pills<MatchFilter> label="Filtrar todos los partidos" value={f} onChange={setF} options={opts} />
      {feed.length === 0 ? <EmptyState icon="📅" title="No hay partidos para mostrar" />
        : feed.map(({ match: m, categoryName }) => (
          <PublicMatchCard key={m.id} match={m} phase={phase(m)} teams={teams} onTeam={onTeam} href={hrefFor?.(m)} categoryName={categoryName} venueName={venueName} />
        ))}
    </div>
  );
}

// ── Ranking individual (solo si el payload trae player_stats) ────────────────

export function RankingTab({ stats, categoryId, teams }: { stats: PlayerStat[]; categoryId: string | null; teams: Map<string, TeamInfo> }) {
  const [metric, setMetric] = useState<PlayerMetric>('points');
  const rows = playerRanking(stats, metric, categoryId);
  return (
    <div className="space-y-3">
      <Pills<PlayerMetric> label="Métrica del ranking" value={metric} onChange={setMetric}
        options={(Object.keys(PLAYER_METRIC_LABEL) as PlayerMetric[]).map((k) => ({ key: k, label: PLAYER_METRIC_LABEL[k] }))} />
      {rows.length === 0 ? <EmptyState icon="📊" title="Aún no hay datos de esta métrica" /> : (
        <ol className="divide-y rounded-xl border bg-card" aria-label={`Ranking de ${PLAYER_METRIC_LABEL[metric]}`}>
          {rows.map((r, i) => (
            <li key={r.id ?? `${r.player_label ?? ''}-${i}`} className="flex items-center gap-3 px-3 py-2.5 text-sm" data-testid="ranking-row">
              <span className={cn('w-6 text-center font-bold tabular-nums', r.rank <= 3 ? 'text-[var(--brand-ink)]' : 'text-muted-foreground')}>{r.rank}</span>
              <TeamBadge team={r.team_id ? teams.get(r.team_id) : null} name={r.team_name ?? r.player_label ?? ''} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.player_label || 'Sin nombre'}</span>
                {r.team_name && <span className="block truncate text-xs text-muted-foreground">{r.team_name}</span>}
              </span>
              <span className="text-lg font-extrabold tabular-nums">{r.value}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
