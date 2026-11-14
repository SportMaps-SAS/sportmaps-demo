import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { formatBogota, STATUS_LABEL, teamName } from '@/lib/tournamentDisplay';
import { avatarColor, currentSetIndex, hourOnly, initials, publicScore, winnerSide, type PublicMatchV2, type Side, type TeamInfo } from './publicModel';
import { usePublicSport } from './sportContext';

/** Escudo del equipo: logo si hay; si no, iniciales (3 letras) con un color estable derivado del nombre. */
export function TeamBadge({ team, name, size = 'md' }: { team?: TeamInfo | null; name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const dim = { sm: 'h-6 w-6 text-[9px]', md: 'h-8 w-8 text-[10px]', lg: 'h-12 w-12 text-sm', xl: 'h-20 w-20 text-xl' }[size];
  if (team?.logo_url) {
    return <img src={team.logo_url} alt="" loading="lazy" className={cn(dim, 'shrink-0 rounded-full border bg-white object-contain')} />;
  }
  const c = avatarColor(name);
  return (
    <span aria-hidden data-testid="team-avatar" className={cn(dim, 'inline-flex shrink-0 items-center justify-center rounded-full font-bold tracking-tight ring-2 ring-white/70')} style={{ backgroundColor: c.bg, color: c.fg }}>
      {initials(name, team?.short_name)}
    </span>
  );
}

/** Lugar de un equipo aún por definir («1.º Grupo A»): círculo punteado, sin iniciales. */
export function PendingBadge({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dim = { sm: 'h-6 w-6 text-[10px]', md: 'h-8 w-8 text-xs', lg: 'h-12 w-12 text-base' }[size];
  return <span aria-hidden className={cn(dim, 'inline-flex shrink-0 items-center justify-center rounded-full border-2 border-dashed text-muted-foreground')}>?</span>;
}

const STATUS_TONE: Record<string, string> = {
  live: 'bg-red-600 text-white',
  played: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  walkover: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  scheduled: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  cancelled: 'bg-muted text-muted-foreground',
};
export const PUBLIC_STATUS: Record<string, string> = { ...STATUS_LABEL, played: 'Finalizado', scheduled: 'Próximo' };

export function StatusPill({ status, large = false }: { status: string; large?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide', large ? 'text-sm' : 'text-[11px]', STATUS_TONE[status])}>
      {status === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" aria-hidden />}
      {PUBLIC_STATUS[status] ?? status}
    </span>
  );
}

interface CardProps {
  match: PublicMatchV2;
  phase: string;
  teams: Map<string, TeamInfo>;
  onTeam?: (teamId: string) => void;
  large?: boolean;
  /** Solo la hora (en Programación ya está el título del día). */
  hourOnlyTime?: boolean;
  highlight?: boolean;
  /** Feed «Todos los partidos»: categoría arriba y sede · cancha · fecha bajo el marcador. */
  categoryName?: string;
  venueName?: string | null;
  /** Ruta de la página del partido; sin ella la tarjeta no navega (modo TV). */
  href?: string;
  /** Acción extra al pie (p. ej. «Compartir resultado» de «vivo»). No navega al tocarla. */
  action?: ReactNode;
}

/** Tarjeta pública: fase · cancha · hora, escudos, marcador grande (sets o goles) y el detalle de sets. */
export function PublicMatchCard({ match: m, phase, teams, onTeam, large = false, hourOnlyTime = false, highlight = false, categoryName, venueName, href, action }: CardProps) {
  const navigate = useNavigate();
  const { kind, sides } = usePublicSport();
  const live = m.status === 'live';
  const sets = m.model === 'sets' ? m.sets ?? [] : [];
  const cur = live ? currentSetIndex(sets) : -1;
  const win = winnerSide(m);
  const sc = publicScore(m, kind);
  const when = hourOnlyTime ? hourOnly(m.scheduled_at) : formatBogota(m.scheduled_at);
  const feed = categoryName != null;
  const vs = `${teamName(m, 'home')} contra ${teamName(m, 'away')}`;

  const side = (s: Side) => {
    const id = s === 'home' ? m.home_team_id : m.away_team_id;
    const name = teamName(m, s);
    const t = id ? teams.get(id) : null;
    const isWin = win === s;
    const content = (
      <>
        {id ? <TeamBadge team={t} name={name} size={large ? 'lg' : 'md'} /> : <PendingBadge size={large ? 'lg' : 'md'} />}
        <span lang="es" className={cn('min-w-0 leading-tight [hyphens:auto] [overflow-wrap:break-word]', large ? 'text-2xl' : 'text-sm', isWin ? 'font-bold' : 'font-medium', !id && 'italic text-muted-foreground')}>
          {name}
        </span>
        {sides && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{s === 'home' ? sides.home : sides.away}</span>}
      </>
    );
    // Escudo arriba y nombre debajo: así los nombres largos («Campestre Cóndores») no se parten a la mitad en 390 px.
    const cls = cn('flex min-w-0 flex-1 basis-0 flex-col items-center gap-1 text-center', large && 'gap-2');
    return id && onTeam
      ? (
        <button type="button" className={cn(cls, 'rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
          onClick={(e) => { e.stopPropagation(); onTeam(id); }} aria-label={`Ver ficha de ${name}`}>
          {content}
        </button>
      )
      : <div className={cls}>{content}</div>;
  };

  const score = sc ? (
    <>
      <span className={cn('font-extrabold', large ? 'text-5xl' : 'text-3xl', win === 'away' && 'text-muted-foreground')}>{sc.home}</span>
      <span className={cn('px-0.5 text-muted-foreground', large ? 'text-base' : 'text-[11px]')}>{m.model === 'sets' ? 'sets' : '–'}</span>
      <span className={cn('font-extrabold', large ? 'text-5xl' : 'text-3xl', win === 'home' && 'text-muted-foreground')}>{sc.away}</span>
    </>
  ) : <span className={cn('text-muted-foreground', large ? 'text-2xl' : 'text-sm')}>vs</span>;
  const scoreCls = cn('flex shrink-0 items-center justify-center gap-1 self-start rounded-md tabular-nums', large ? 'min-w-[7rem] pt-1' : 'min-w-[5rem] pt-0.5');

  return (
    <article
      className={cn('rounded-xl border bg-card p-3 shadow-sm', href && 'cursor-pointer transition-shadow hover:shadow-md', live && 'border-red-500/60 ring-1 ring-red-500/30', highlight && 'border-amber-400 bg-amber-50 dark:bg-amber-950/30')}
      data-testid="public-match"
      aria-label={vs}
      onClick={href ? () => navigate(href) : undefined}
    >
      {feed && categoryName && <p className="mb-1 text-center text-xs font-bold uppercase tracking-wide text-[var(--brand-ink)]">{categoryName}</p>}
      <div className={cn('flex items-start gap-2 text-muted-foreground', large ? 'text-lg' : 'text-xs')}>
        <span className="min-w-0 flex-1">{(feed ? [phase] : [phase, m.court, when]).filter(Boolean).join(' · ')}</span>
        <StatusPill status={m.status} large={large} />
      </div>
      <div className="mt-2 flex items-start gap-2">
        {side('home')}
        {href
          ? <Link to={href} onClick={(e) => e.stopPropagation()} className={cn(scoreCls, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')} aria-label={`Ver el partido ${vs}`}>{score}</Link>
          : <div className={scoreCls}>{score}</div>}
        {side('away')}
      </div>
      {sets.length > 0 && (
        <ol className={cn('mt-2 flex flex-wrap justify-center gap-1.5 font-mono tabular-nums', large ? 'text-xl' : 'text-xs')} aria-label="Detalle de sets">
          {sets.map((s, i) => (
            <li key={i} className={cn('rounded-md px-1.5 py-0.5', i === cur ? 'bg-red-600 font-bold text-white' : 'bg-muted text-muted-foreground')} aria-current={i === cur ? 'true' : undefined}>
              {i === cur && <span className="sr-only">Set en curso: </span>}
              {s.home}-{s.away}
            </li>
          ))}
        </ol>
      )}
      {action && <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>{action}</div>}
      {feed && (
        <p className="mt-2 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
          {[venueName, m.court, when].filter(Boolean).join(' · ')}
        </p>
      )}
    </article>
  );
}
