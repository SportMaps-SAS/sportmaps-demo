import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Award, Camera, EyeOff, Eye, MessageSquare, Newspaper, Trash2, Video } from 'lucide-react';
import { comprimirParaSubir } from '@/lib/imageCompression';
import type { MatchDto } from '@/lib/tournamentTypes';
import { LIVE_BASE } from './FixtureGeneratorDialog';

const FOLLOW_BASE = '/api/v1/tournament-live'; // tournament-follow.route se monta en la misma base
const MEDIA_BUCKET = 'tournament-media';
const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

interface Media { id: string; kind: 'photo' | 'video' | 'news'; match_id: string | null; title: string | null; body: string | null; url: string | null; video_url: string | null; created_at: string }
interface Comment { id: string; author_name: string; body: string; created_at: string; status?: string }
interface Roster { id: string; team_id: string; side: 'home' | 'away'; name: string }
interface MatchSocial { comments: Comment[]; media: Media[]; mvp: { available: boolean; winner?: { member_id: string; name: string } | null } }

const matchName = (m: MatchDto) => `${m.home_name ?? m.home_label ?? '¿?'} vs ${m.away_name ?? m.away_label ?? '¿?'}`;

/**
 * Contenido del torneo (API de tournament-follow.route, montada en /api/v1/tournament-live): publicar fotos, videos y
 * noticias; moderar comentarios (ocultar/mostrar/borrar) y elegir el MVP de cada partido.
 */
export function TournamentContentPanel({ eventId, slug }: { eventId: string; slug: string }) {
  const { toast } = useToast();
  const org = `${FOLLOW_BASE}/school/${eventId}`;
  const [matches, setMatches] = useState<MatchDto[]>([]);
  const [matchId, setMatchId] = useState('');
  const [feed, setFeed] = useState<{ media: Media[]; comments: Comment[] }>({ media: [], comments: [] });
  const [social, setSocial] = useState<MatchSocial | null>(null);
  const [roster, setRoster] = useState<Roster[]>([]);
  const [kind, setKind] = useState<'news' | 'photo' | 'video'>('news');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const loadFeed = useCallback(async () => {
    try { setFeed(await bffClient.get(`${FOLLOW_BASE}/public/${slug}/social`)); } catch { setFeed({ media: [], comments: [] }); }
  }, [slug]);
  const loadMatch = useCallback(async (id: string) => {
    if (!id) { setSocial(null); setRoster([]); return; }
    try {
      const [s, r] = await Promise.all([bffClient.get<MatchSocial>(`${org}/matches/${id}/social`), bffClient.get<{ roster: Roster[] }>(`${org}/matches/${id}/roster`)]);
      setSocial(s); setRoster(r.roster);
    } catch (e) { toast({ title: 'No se pudo cargar el partido', description: (e as Error).message, variant: 'destructive' }); }
  }, [org, toast]);

  useEffect(() => {
    bffClient.get<MatchDto[]>(`${LIVE_BASE}/school/${eventId}/matches`).then((m) => setMatches(m.filter((x) => !x.is_bye))).catch(() => setMatches([]));
    void loadFeed();
  }, [eventId, loadFeed]);
  useEffect(() => { void loadMatch(matchId); }, [matchId, loadMatch]);

  const publish = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { kind, title: title.trim() || null, body: body.trim() || null, match_id: matchId || null };
      if (kind === 'photo') {
        if (!file) throw new Error('Elige una foto');
        const small = await comprimirParaSubir(file, 'foto');
        const up = await bffClient.post<{ path: string; token: string }>(`${org}/media/upload-url`, { mime: small.type || 'image/jpeg' });
        const { error } = await supabase.storage.from(MEDIA_BUCKET).uploadToSignedUrl(up.path, up.token, small);
        if (error) throw new Error('No se pudo subir la foto');
        payload.media_path = up.path;
      }
      if (kind === 'video') payload.video_url = videoUrl.trim();
      await bffClient.post(`${org}/posts`, payload);
      toast({ title: 'Publicado', description: 'Ya se ve en la página en vivo.' });
      setTitle(''); setBody(''); setVideoUrl(''); setFile(null);
      await loadFeed(); if (matchId) await loadMatch(matchId);
    } catch (e) { toast({ title: 'No se pudo publicar', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const removePost = async (p: Media) => {
    if (!window.confirm('¿Borrar esta publicación?')) return;
    try { await bffClient.delete(`${org}/posts/${p.id}`); await loadFeed(); if (matchId) await loadMatch(matchId); }
    catch (e) { toast({ title: 'No se pudo borrar', description: (e as Error).message, variant: 'destructive' }); }
  };
  const moderate = async (c: Comment, action: 'hide' | 'show' | 'delete') => {
    if (action === 'delete' && !window.confirm('¿Borrar este comentario?')) return;
    try { await bffClient.patch(`${org}/comments/${c.id}`, { action }); await loadFeed(); if (matchId) await loadMatch(matchId); }
    catch (e) { toast({ title: 'No se pudo moderar', description: (e as Error).message, variant: 'destructive' }); }
  };
  const chooseMvp = async (memberId: string) => {
    try { await bffClient.put(`${org}/matches/${matchId}/mvp`, { member_id: memberId || null }); toast({ title: memberId ? 'MVP elegido' : 'MVP quitado' }); await loadMatch(matchId); }
    catch (e) { toast({ title: 'No se pudo guardar el MVP', description: (e as Error).message, variant: 'destructive' }); }
  };

  const comments = matchId ? social?.comments ?? [] : feed.comments;
  const media = matchId ? social?.media ?? [] : feed.media;
  const selected = matches.find((m) => m.id === matchId);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="ct-match">Partido</Label>
        <select id="ct-match" className={selectCls} value={matchId} onChange={(e) => setMatchId(e.target.value)}>
          <option value="">Todo el torneo</option>
          {matches.map((m) => <option key={m.id} value={m.id}>{matchName(m)}{m.status === 'played' ? ' · terminado' : m.status === 'live' ? ' · en juego' : ''}</option>)}
        </select>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Publicar</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2" role="tablist">
            <Button type="button" size="sm" role="tab" aria-selected={kind === 'news'} variant={kind === 'news' ? 'default' : 'outline'} onClick={() => setKind('news')}><Newspaper className="mr-1 h-4 w-4" /> Noticia</Button>
            <Button type="button" size="sm" role="tab" aria-selected={kind === 'photo'} variant={kind === 'photo' ? 'default' : 'outline'} onClick={() => setKind('photo')}><Camera className="mr-1 h-4 w-4" /> Foto</Button>
            <Button type="button" size="sm" role="tab" aria-selected={kind === 'video'} variant={kind === 'video' ? 'default' : 'outline'} onClick={() => setKind('video')}><Video className="mr-1 h-4 w-4" /> Video</Button>
          </div>
          <Input aria-label="Título" maxLength={120} placeholder="Título (opcional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          {kind === 'news' && <Textarea aria-label="Texto de la noticia" rows={4} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="¡Así quedaron las semifinales!" />}
          {kind === 'photo' && <Input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Foto" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
          {kind === 'video' && <Input aria-label="Enlace del video" inputMode="url" placeholder="https://youtube.com/…" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />}
          <Button onClick={publish} disabled={busy}>{busy ? 'Publicando…' : `Publicar${selected ? ` en ${matchName(selected)}` : ''}`}</Button>
        </CardContent>
      </Card>

      {matchId && social && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Award className="h-4 w-4" /> MVP del partido</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {roster.length === 0 ? <p className="text-sm text-muted-foreground">Para elegir MVP los equipos necesitan su nómina (Inscritos → Jugadores).</p> : (
              <>
                {social.mvp?.winner && <p className="text-sm">Actual: <strong>{social.mvp.winner.name}</strong></p>}
                <select aria-label="Elegir MVP" className={selectCls} defaultValue="" onChange={(e) => void chooseMvp(e.target.value)}>
                  <option value="">Elegir jugador…</option>
                  {roster.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.side === 'home' ? selected?.home_name : selected?.away_name})</option>)}
                </select>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="h-4 w-4" /> Comentarios</CardTitle></CardHeader>
        <CardContent>
          {comments.length === 0 ? <p className="text-sm text-muted-foreground">No hay comentarios.</p> : (
            <ul className="divide-y" data-testid="comments">
              {comments.map((c) => (
                <li key={c.id} className="flex items-start gap-2 py-2 text-sm">
                  <div className="min-w-0 flex-1"><p className="font-medium">{c.author_name}{c.status === 'hidden' && <Badge variant="outline" className="ml-2">Oculto</Badge>}</p><p className="text-muted-foreground">{c.body}</p></div>
                  {c.status === 'hidden'
                    ? <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Mostrar comentario" onClick={() => moderate(c, 'show')}><Eye className="h-4 w-4" /></Button>
                    : <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Ocultar comentario" onClick={() => moderate(c, 'hide')}><EyeOff className="h-4 w-4" /></Button>}
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Borrar comentario" onClick={() => moderate(c, 'delete')}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Publicado</CardTitle></CardHeader>
        <CardContent>
          {media.length === 0 ? <p className="text-sm text-muted-foreground">Aún no hay fotos, videos ni noticias.</p> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {media.map((p) => (
                <li key={p.id} className="flex gap-2 rounded border p-2 text-sm">
                  {p.kind === 'photo' && p.url ? <img src={p.url} alt="" className="h-16 w-16 shrink-0 rounded object-cover" /> : null}
                  <div className="min-w-0 flex-1">
                    <Badge variant="outline">{p.kind === 'news' ? 'Noticia' : p.kind === 'photo' ? 'Foto' : 'Video'}</Badge>
                    <p className="truncate font-medium">{p.title ?? p.video_url ?? ''}</p>
                    {p.body && <p className="line-clamp-2 text-muted-foreground">{p.body}</p>}
                  </div>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Borrar publicación" onClick={() => removePost(p)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
