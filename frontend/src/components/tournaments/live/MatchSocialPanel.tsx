import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send, Star, BadgeCheck, Image as ImageIcon, Newspaper, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { liveApi, type MatchSocialDto, type MvpSummary, type PlayerStatLine, type SocialMedia } from './liveApi';

const ago = (iso: string, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
};

/**
 * Pestañas «Partido · Comentarios · Medios» de la página de un partido (estilo Copa Fácil, con lo que
 * SportMaps sabe: MVP y estadísticas por jugadora de la planilla). Lo monta el agente «publico» en la
 * vista del partido: `<MatchSocialPanel slug={slug} matchId={m.id} />`.
 * Datos: GET /api/v1/tournament-live/public/:slug/matches/:id/social (caché de 10 s en el BFF).
 */
export function MatchSocialPanel({ slug, matchId, defaultTab = 'comentarios' }: { slug: string; matchId: string; defaultTab?: 'comentarios' | 'medios' | 'mvp' }) {
  const [data, setData] = useState<MatchSocialDto | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    liveApi.matchSocial(slug, matchId).then((d) => { setData(d); setFailed(false); }).catch(() => setFailed(true));
  }, [slug, matchId]);
  useEffect(() => { load(); }, [load]);

  if (!data) {
    return failed
      ? <div className="p-4 text-sm text-muted-foreground">No pudimos cargar. <Button variant="link" className="h-auto p-0" onClick={load}>Reintentar</Button></div>
      : <div className="p-4 text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Cargando…</div>;
  }

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="comentarios">Comentarios</TabsTrigger>
        <TabsTrigger value="medios">Medios</TabsTrigger>
        <TabsTrigger value="mvp">MVP</TabsTrigger>
      </TabsList>
      <TabsContent value="comentarios"><Comments slug={slug} matchId={matchId} data={data} onPosted={load} /></TabsContent>
      <TabsContent value="medios"><MediaList media={data.media} /></TabsContent>
      <TabsContent value="mvp" className="space-y-4">
        <MvpVote slug={slug} matchId={matchId} mvp={data.mvp} onVoted={load} />
        {data.player_stats.length > 0 && <StatsTable rows={data.player_stats} />}
      </TabsContent>
    </Tabs>
  );
}

function Comments({ slug, matchId, data, onPosted }: { slug: string; matchId: string | null; data: Pick<MatchSocialDto, 'comments'>; onPosted: () => void }) {
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const { toast } = useToast();
  const [body, setBody] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('sm_tlive_name') ?? ''; } catch { return ''; } });
  const [challenge, setChallenge] = useState<{ question: string; token: string } | null>(null);
  const [answer, setAnswer] = useState('');
  const [website, setWebsite] = useState(''); // trampa para bots (oculta)
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user || challenge) return;
    liveApi.challenge(slug).then(setChallenge).catch(() => undefined);
  }, [user, challenge, slug]);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await liveApi.comment(slug, matchId, user
        ? { body }
        : { body, author_name: name, challenge_token: challenge?.token, challenge_answer: answer, website });
      setBody(''); setAnswer(''); setChallenge(null);
      try { if (!user) localStorage.setItem('sm_tlive_name', name); } catch { /* sin almacenamiento */ }
      onPosted();
    } catch (e) {
      // «Muy rápido» no es un error de la suma: se conserva la misma pregunta y la respuesta escrita.
      const code = (e as { body?: { code?: string } })?.body?.code;
      if (code === 'reto_muy_rapido') {
        toast({ title: 'Un momento', description: (e as Error)?.message || 'Espera un momento y vuelve a enviar.' });
      } else {
        toast({ title: 'No se publicó', description: (e as Error)?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
        if (code === 'reto_invalido' || code === 'reto_vencido') setAnswer('');
        setChallenge(null);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 py-2">
      {data.comments.length === 0
        ? <p className="py-6 text-center text-sm text-muted-foreground">Aún no hay comentarios. ¡Sé el primero!</p>
        : (
          <ul className="space-y-2">
            {data.comments.map((c) => (
              <li key={c.id} className="rounded-lg border p-2 text-sm">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{c.author_name}</span>
                  {c.verified && <BadgeCheck className="h-3.5 w-3.5 text-primary" aria-label="Con cuenta de SportMaps" />}
                  <span>· {ago(c.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      <div className="space-y-2 rounded-lg border p-2">
        {!user && (
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Tu nombre" placeholder="Tu nombre" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
            <Input aria-label={challenge?.question ?? 'Comprobación'} placeholder={challenge?.question ?? 'Cargando…'} inputMode="numeric" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
          </div>
        )}
        <div className="flex gap-2">
          <Input aria-label="Escribe un comentario" placeholder="Escribe un comentario" maxLength={500} value={body} onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
          <Button type="button" size="icon" onClick={submit} disabled={busy || !body.trim()} aria-label="Enviar comentario">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Sé respetuoso. No publiques datos de menores. El organizador puede ocultar comentarios.</p>
      </div>
    </div>
  );
}

export function MediaList({ media }: { media: SocialMedia[] }) {
  const news = media.filter((m) => m.kind === 'news');
  const render = (items: SocialMedia[], empty: string) => (items.length === 0
    ? <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
    : (
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((m) => (
          <li key={m.id} className="overflow-hidden rounded-lg border">
            {m.kind === 'photo' && m.url && <img src={m.url} alt={m.title ?? 'Foto del partido'} loading="lazy" className="aspect-[4/3] w-full object-cover" />}
            {m.kind === 'video' && m.video_url && (
              <a href={m.video_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-3 text-sm font-medium text-primary">
                <PlayCircle className="h-5 w-5" /> Ver video
              </a>
            )}
            {(m.title || m.body) && (
              <div className="space-y-1 p-3 text-sm">
                {m.kind === 'news' && <div className="flex items-center gap-1 text-xs text-muted-foreground"><Newspaper className="h-3.5 w-3.5" /> Noticia · {ago(m.created_at)}</div>}
                {m.title && <p className="font-semibold">{m.title}</p>}
                {m.body && <p className="whitespace-pre-wrap text-muted-foreground">{m.body}</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    ));
  return (
    <Tabs defaultValue="todo" className="py-2">
      <TabsList>
        <TabsTrigger value="todo"><ImageIcon className="mr-1 h-4 w-4" /> Todo</TabsTrigger>
        <TabsTrigger value="noticias"><Newspaper className="mr-1 h-4 w-4" /> Noticias</TabsTrigger>
      </TabsList>
      <TabsContent value="todo">{render(media, 'Aún no hay fotos ni videos.')}</TabsContent>
      <TabsContent value="noticias">{render(news, 'Aún no hay noticias.')}</TabsContent>
    </Tabs>
  );
}

function MvpVote({ slug, matchId, mvp, onVoted }: { slug: string; matchId: string; mvp: MvpSummary; onVoted: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const votedKey = `sm_tlive_mvp_${matchId}`;
  const [voted, setVoted] = useState(() => { try { return !!localStorage.getItem(votedKey); } catch { return false; } });

  if (!mvp.available) {
    return <p className="py-4 text-sm text-muted-foreground">El MVP por jugadora solo está para equipos con planilla inscrita.</p>;
  }
  const vote = async (id: string) => {
    setBusy(id);
    try {
      await liveApi.voteMvp(slug, matchId, id);
      try { localStorage.setItem(votedKey, id); } catch { /* sin almacenamiento */ }
      setVoted(true); onVoted();
    } catch (e) {
      const msg = (e as Error)?.message ?? 'Intenta de nuevo.';
      if (/Ya votaste/.test(msg)) setVoted(true);
      toast({ title: 'Voto no registrado', description: msg, variant: 'destructive' });
    } finally { setBusy(null); }
  };
  return (
    <div className="space-y-2 py-2">
      {mvp.winner && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="mvp-winner">
          <Star className="h-5 w-5" /> <span><b>MVP: {mvp.winner.name}</b> {mvp.winner.source === 'organizer' ? '· elegida por el organizador' : `· ${mvp.total} voto${mvp.total === 1 ? '' : 's'}`}</span>
        </div>
      )}
      {mvp.voting_open && !voted && <p className="text-sm font-medium">¿Quién fue la mejor del partido?</p>}
      {!mvp.voting_open && !mvp.winner && <p className="text-sm text-muted-foreground">La votación abre cuando empieza el partido.</p>}
      <ul className="grid grid-cols-2 gap-2">
        {mvp.candidates.map((c) => {
          const n = mvp.votes[c.id] ?? 0;
          const pct = mvp.total ? Math.round((n / mvp.total) * 100) : 0;
          return (
            <li key={c.id}>
              <Button type="button" variant="outline" className="h-auto w-full flex-col items-start gap-0.5 py-2 text-left" disabled={!mvp.voting_open || voted || !!busy} onClick={() => vote(c.id)}>
                <span className="truncate text-sm font-medium">{c.name}</span>
                {(voted || !mvp.voting_open) && <span className="text-xs text-muted-foreground">{pct}%</span>}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function StatsTable({ rows }: { rows: PlayerStatLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="py-1 text-left">Jugadora</th><th>Puntos</th><th>Ataque</th><th>Aces</th><th>Bloqueos</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.member_id} className="border-t text-center tabular-nums">
              <td className="py-1 text-left">{r.name}</td><td className="font-semibold">{r.points}</td><td>{r.attack}</td><td>{r.ace}</td><td>{r.block}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default MatchSocialPanel;
