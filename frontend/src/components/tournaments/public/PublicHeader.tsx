import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FollowSlot } from './vivoSlots';
import { ShareButton, type EmbedOptions, type ShareTarget } from './ShareSheet';
import { dateRangeText, initials, PHASE_LABEL, type PublicPhase, type TournamentView } from './publicModel';

const PHASE_DOT: Record<PublicPhase, string> = {
  in_progress: 'bg-emerald-400', finished: 'bg-slate-300', upcoming: 'bg-amber-300', cancelled: 'bg-red-300',
};

/** Badge «en vivo» pulsante (respeta «reducir movimiento»). */
export function LiveBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-red-600 px-2.5 py-1 font-semibold text-white', className)} data-testid="live-badge">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
      </span>
      En vivo · {count} {count === 1 ? 'partido' : 'partidos'}
    </span>
  );
}

interface HeaderProps {
  slug: string;
  t: TournamentView;
  phase: PublicPhase;
  liveCount: number;
  shareTargets: ShareTarget[];
  updatedText: string;
  error: string | null;
  /** Equipos de la categoría visible, para «Seguir». */
  followTeams: Array<{ id: string; name: string }>;
  embed?: EmbedOptions;
}

/** Encabezado con la marca del torneo: portada, logo, nombre, organizador, fechas, estado y «en vivo». */
export function PublicHeader({ slug, t, phase, liveCount, shareTargets, updatedText, error, followTeams, embed }: HeaderProps) {
  const dates = dateRangeText(t.start_date, t.end_date);
  return (
    <header className="relative overflow-hidden bg-[var(--brand)] text-[var(--brand-fg)]">
      {t.cover_url ? (
        <div className="relative h-36 w-full sm:h-52">
          <img src={t.cover_url} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[var(--brand)]" />
        </div>
      ) : <div className="h-4" />}
      <div className={cn('relative mx-auto max-w-3xl px-4 pb-4', t.cover_url && '-mt-10')}>
        <div className="flex items-end gap-3">
          {t.logo_url ? (
            <img src={t.logo_url} alt={`Logo de ${t.title}`} className="h-16 w-16 shrink-0 rounded-2xl border-2 border-white/80 bg-white object-contain shadow-md" />
          ) : (
            <span aria-hidden className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border-2 border-white/60 bg-white/15 text-xl font-black">
              {initials(t.title)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-extrabold leading-tight sm:text-2xl">{t.title}</h1>
            {t.organizer_name && <p className="truncate text-sm opacity-85">Organiza {t.organizer_name}</p>}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/20 px-2.5 py-1 font-medium" data-testid="phase">
            <span className={cn('h-2 w-2 rounded-full', PHASE_DOT[phase])} aria-hidden /> {PHASE_LABEL[phase]}
          </span>
          <LiveBadge count={liveCount} />
          {dates && <span className="inline-flex items-center gap-1 opacity-90"><CalendarDays className="h-3.5 w-3.5" aria-hidden /> {dates}</span>}
          {[t.sport, t.city].filter(Boolean).length > 0 && <span className="capitalize opacity-80">· {[t.sport, t.city].filter(Boolean).join(' · ')}</span>}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <ShareButton targets={shareTargets} embed={embed} />
          <FollowSlot slug={slug} teams={followTeams} />
          <span className="ml-auto text-right text-[11px] opacity-80" aria-live="polite">{error ? <span role="status">{error}</span> : updatedText}</span>
        </div>
      </div>
    </header>
  );
}
