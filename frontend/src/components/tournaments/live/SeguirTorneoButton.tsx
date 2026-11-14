import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, CalendarPlus, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { liveApi } from './liveApi';

export interface SeguirTeam { id: string; name: string }

interface Props {
  slug: string;
  /** Equipos del torneo (de la categoría que se está viendo), para «seguir a un equipo». */
  teams?: SeguirTeam[];
  className?: string;
}

/**
 * Botón «Seguir» de la página pública.
 *   · Con cuenta: seguir todo el torneo o equipos → avisos en la app y push
 *     («empieza en 15 min», «Empezó…», «Final…»).
 *   · Sin cuenta: «Agregar al calendario» (.ics con alarma 15 min antes) + invitación a crear cuenta.
 * Punto de enchufe: el slot de acciones del encabezado de TournamentLivePage (agente «publico»).
 */
export function SeguirTorneoButton({ slug, teams = [], className }: Props) {
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const { toast } = useToast();
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user || !open || loaded) return;
    liveApi.myFollows(slug)
      .then((r) => { setFollows(new Set(r.follows.map((f) => f.team_id ?? '*'))); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [user, open, loaded, slug]);

  const toggle = async (teamId: string | null) => {
    const key = teamId ?? '*';
    setBusy(key);
    try {
      if (follows.has(key)) {
        await liveApi.unfollow(slug, teamId);
        setFollows((s) => { const n = new Set(s); n.delete(key); return n; });
      } else {
        await liveApi.follow(slug, teamId);
        setFollows((s) => new Set(s).add(key));
        toast({ title: 'Listo', description: 'Te avisaremos antes de cada partido y con el resultado final.' });
      }
    } catch (e) {
      toast({ title: 'No se pudo guardar', description: (e as Error)?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const following = follows.size > 0;
  const returnTo = typeof window !== 'undefined' ? window.location.pathname : `/torneo/${slug}/en-vivo`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant={following ? 'default' : 'outline'} className={className} data-testid="seguir-torneo">
          {following ? <BellRing className="mr-1 h-4 w-4" /> : <Bell className="mr-1 h-4 w-4" />}
          {following ? 'Siguiendo' : 'Seguir'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end">
        {user ? (
          <>
            <p className="text-sm font-medium">¿Qué quieres seguir?</p>
            <div className="space-y-1.5">
              <FollowRow label="Todo el torneo" active={follows.has('*')} busy={busy === '*'} onClick={() => toggle(null)} />
              {teams.slice(0, 30).map((t) => (
                <FollowRow key={t.id} label={t.name} active={follows.has(t.id)} busy={busy === t.id} onClick={() => toggle(t.id)} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Te llega en la campana de SportMaps y como notificación si las tienes activadas.</p>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Agrega los partidos a tu calendario</p>
            <p className="text-xs text-muted-foreground">Tu celular te recuerda 15 min antes de cada partido.</p>
            <div className="space-y-1.5">
              <Button asChild variant="outline" size="sm" className="w-full justify-start">
                <a href={liveApi.calendarUrl(slug)}><CalendarPlus className="mr-2 h-4 w-4" /> Todo el torneo</a>
              </Button>
              {teams.slice(0, 30).map((t) => (
                <Button key={t.id} asChild variant="ghost" size="sm" className="w-full justify-start">
                  <a href={liveApi.calendarUrl(slug, t.id)}><CalendarPlus className="mr-2 h-4 w-4" /> {t.name}</a>
                </Button>
              ))}
            </div>
            <div className="border-t pt-2 text-xs text-muted-foreground">
              ¿Quieres avisos de «Empezó» y del resultado final?{' '}
              <Link className="font-medium text-primary underline" to={`/login?redirect=${encodeURIComponent(returnTo)}`}>Inicia sesión</Link>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FollowRow({ label, active, busy, onClick }: { label: string; active: boolean; busy: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant={active ? 'secondary' : 'ghost'} size="sm" className="w-full justify-between" onClick={onClick} disabled={busy} aria-pressed={active}>
      <span className="truncate">{label}</span>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? <Check className="h-4 w-4" /> : <Bell className="h-4 w-4 opacity-50" />}
    </Button>
  );
}

export default SeguirTorneoButton;
