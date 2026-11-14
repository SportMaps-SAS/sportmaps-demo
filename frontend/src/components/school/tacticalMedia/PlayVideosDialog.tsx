/**
 * «Videos» de la jugada (M6c), adaptado de la pantalla de TacticalPad. En vez
 * de buscar en YouTube (exigiría una API key) se PEGA el enlace: YouTube,
 * Vimeo, cámaras deportivas (Veo, Hudl, Trace, Pixellot, Spiideo, XbotGo,
 * Reeplayer) y archivos públicos de Google Drive o Dropbox. Minuto de inicio
 * (y fin opcional), «Enlace privado» (no sale en el PDF ni en los paquetes) y
 * «Videos guardados» de la escuela para reusarlos en otras jugadas.
 * Cero almacenamiento: solo enlaces.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookmarkPlus, Link2, Loader2, Plus, Trash2, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  PLAY_VIDEOS_MAX, PROVIDER_LABEL, VIDEO_TIME_MAX_S, VIDEO_TITLE_MAX,
  formatClock, parseClock, parseVideoUrl, videoKey, type PlayVideo,
} from '@/lib/school/tacticalMedia';
import { useDeleteSavedVideo, useSaveVideo, useSavedVideos } from '@/lib/school/tacticalSavedVideos';
import { VideoPreview } from './VideoPreview';

export interface PlayVideosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
  videos: PlayVideo[];
  onSave: (videos: PlayVideo[]) => void;
  /** M6h: pestaña «Subir» (videos subidos de la escuela). Sin ella, solo enlaces. */
  uploadPanel?: ReactNode;
}

/** Arma el video del formulario o explica qué falta. */
export function buildDraftVideo(form: { url: string; title: string; start: string; end: string; isPrivate: boolean }):
  { ok: true; video: PlayVideo } | { ok: false; error: string } {
  const parsed = parseVideoUrl(form.url);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const start = form.start.trim() ? parseClock(form.start) : parsed.video.start_s;
  if (start === null || Number.isNaN(start) || start > VIDEO_TIME_MAX_S) return { ok: false, error: 'El inicio va como minutos:segundos (p. ej. 12:30).' };
  const end = form.end.trim() ? parseClock(form.end) : null;
  if (end !== null && (Number.isNaN(end) || end <= start || end > VIDEO_TIME_MAX_S)) {
    return { ok: false, error: 'El fin tiene que ser después del inicio (minutos:segundos).' };
  }
  const title = form.title.replace(/\s+/g, ' ').trim().slice(0, VIDEO_TITLE_MAX) || `Video de ${PROVIDER_LABEL[parsed.video.provider]}`;
  return { ok: true, video: { ...parsed.video, title, start_s: start, end_s: end, is_private: form.isPrivate } };
}

const EMPTY_FORM = { url: '', title: '', start: '', end: '', isPrivate: false };

export function PlayVideosDialog({ open, onOpenChange, readOnly, videos, onSave, uploadPanel }: PlayVideosDialogProps) {
  const [tab, setTab] = useState<'links' | 'upload'>('links');
  const { toast } = useToast();
  const [list, setList] = useState<PlayVideo[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [startTouched, setStartTouched] = useState(false);
  const [saveToLibrary, setSaveToLibrary] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const saved = useSavedVideos(open);
  const saveVideo = useSaveVideo();
  const deleteSaved = useDeleteSavedVideo();

  useEffect(() => {
    if (!open) return;
    setList(videos);
    setForm(EMPTY_FORM);
    setStartTouched(false);
    setSelected(videos[0] ? videoKey(videos[0]) : null);
  }, [open, videos]);

  const draft = useMemo(() => (form.url.trim() ? buildDraftVideo(form) : null), [form]);
  // El t= del enlace llena el inicio, mientras el coach no lo haya escrito a mano.
  useEffect(() => {
    if (startTouched) return;
    const p = parseVideoUrl(form.url);
    setForm((f) => ({ ...f, start: p.ok && p.video.start_s ? formatClock(p.video.start_s) : '' }));
  }, [form.url, startTouched]);

  const previewVideo = draft?.ok ? draft.video : list.find((v) => videoKey(v) === selected) ?? null;
  const full = list.length >= PLAY_VIDEOS_MAX;

  function addToPlay(v: PlayVideo): boolean {
    if (list.some((x) => videoKey(x) === videoKey(v))) {
      toast({ title: 'Ese video ya está en la jugada' });
      return false;
    }
    if (full) {
      toast({ title: `Máximo ${PLAY_VIDEOS_MAX} videos por jugada`, variant: 'destructive' });
      return false;
    }
    setList((prev) => [...prev, v]);
    setSelected(videoKey(v));
    return true;
  }

  function addDraft(): PlayVideo | null {
    if (!draft || !draft.ok) return null;
    const v = draft.video;
    if (!addToPlay(v)) return null;
    if (saveToLibrary && saved.data?.available !== false) {
      saveVideo.mutate(v, {
        onError: (err: unknown) => toast({
          title: 'No se pudo guardar en Videos guardados',
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        }),
      });
    }
    setForm(EMPTY_FORM);
    setStartTouched(false);
    return v;
  }

  function done() {
    if (!readOnly) {
      let next = list;
      // Un enlace válido escrito y no agregado se agrega al tocar Listo.
      if (draft?.ok && !list.some((x) => videoKey(x) === videoKey(draft.video)) && !full) {
        const v = addDraft();
        if (v) next = [...list, v];
      }
      onSave(next);
    }
    onOpenChange(false);
  }

  const inputCls = 'h-9 bg-white/5 border-white/15 text-white placeholder:text-white/40';
  const savedList = saved.data?.videos ?? [];

  const linksBody = (
    <>
      {!readOnly && (
        // Cómo se usa, en tres pasos: sin esto no se entendía que «Usar» solo lo
        // pasa a la jugada y que hay que guardar la jugada para no perderlo.
        <ol className="grid gap-1.5 rounded-lg border border-white/10 bg-white/5 p-2.5 text-xs text-white/80 sm:grid-cols-3" aria-label="Cómo agregar un video">
          {[
            ['1', 'Elige un video guardado (botón «Agregar») o pega un enlace a la derecha.'],
            ['2', 'Revisa la vista previa y, si quieres, marca desde qué minuto empieza.'],
            ['3', 'Toca «Listo» y después «Guardar jugada» en la pizarra.'],
          ].map(([n, t]) => (
            <li key={n} className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">{n}</span>
              <span>{t}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Columna derecha en desktop (primera en celular): la jugada */}
        <section className="space-y-3 md:order-2">
          {previewVideo ? <VideoPreview video={previewVideo} /> : (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/5 text-white/50 text-sm" style={{ aspectRatio: '16 / 9' }}>
              <Video className="h-7 w-7" />
              {readOnly ? 'Esta jugada no tiene videos.' : 'Pega un enlace para ver la vista previa.'}
            </div>
          )}

          {!readOnly && (
            <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={form.isPrivate} onCheckedChange={(v) => setForm((f) => ({ ...f, isPrivate: v }))} aria-label="Enlace privado" />
                  Enlace privado
                </label>
                <span className="text-[11px] text-white/50 text-right">No sale en el PDF ni en los paquetes</span>
              </div>
              <div className="flex gap-1.5">
                <div className="relative flex-1">
                  <Link2 className="absolute left-2.5 top-2.5 h-4 w-4 text-white/40" />
                  <Input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    placeholder="Pegar enlace del video…" aria-label="Enlace del video" inputMode="url" autoComplete="off"
                    className={`${inputCls} pl-8`} />
                </div>
              </div>
              {draft && 'error' in draft && <p role="alert" className="text-xs text-red-300" data-testid="video-url-error">{draft.error}</p>}
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Título (p. ej. «Salida vs. presión alta»)" aria-label="Título del video" maxLength={VIDEO_TITLE_MAX} className={inputCls} />
              <div className="grid grid-cols-2 gap-1.5">
                <Input value={form.start} onChange={(e) => { setStartTouched(true); setForm((f) => ({ ...f, start: e.target.value })); }}
                  placeholder="Inicio (min:seg)" aria-label="Minuto de inicio" inputMode="numeric" className={inputCls} />
                <Input value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
                  placeholder="Fin (opcional)" aria-label="Minuto de fin" inputMode="numeric" className={inputCls} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-white/75">
                  <Checkbox checked={saveToLibrary} onCheckedChange={(v) => setSaveToLibrary(v === true)} aria-label="Guardar también en Videos guardados"
                    className="border-white/40" />
                  Guardar también en Videos guardados
                </label>
                <Button type="button" size="sm" onClick={addDraft} disabled={!draft?.ok || full}
                  className="gap-1 bg-emerald-600 hover:bg-emerald-500 text-white">
                  <Plus className="h-4 w-4" /> Agregar a la jugada
                </Button>
              </div>
            </div>
          )}

          <div>
            <p className="text-sm font-semibold mb-1.5">En esta jugada ({list.length}/{PLAY_VIDEOS_MAX})</p>
            {list.length === 0 ? (
              <p className="text-xs text-white/50">
                {readOnly ? 'Ninguno todavía.' : 'Ninguno todavía. Toca «Agregar» en un video guardado o pega un enlace.'}
              </p>
            ) : (
              <ul className="space-y-1">
                {list.map((v) => {
                  const k = videoKey(v);
                  return (
                    <li key={k} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${k === selected && !draft?.ok ? 'border-emerald-400/60 bg-emerald-500/10' : 'border-white/10 bg-white/5'}`}>
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setSelected(k); setForm(EMPTY_FORM); }}>
                        <span className="block truncate font-medium">{v.title}</span>
                        <span className="block text-[11px] text-white/55">
                          {PROVIDER_LABEL[v.provider]} · desde {formatClock(v.start_s)}{v.end_s ? ` hasta ${formatClock(v.end_s)}` : ''}{v.is_private ? ' · privado' : ''}
                        </span>
                      </button>
                      {!readOnly && (
                        <Button type="button" size="sm" variant="ghost" aria-label={`Quitar ${v.title}`}
                          className="h-8 w-8 p-0 text-white/60 hover:bg-white/10 hover:text-red-300"
                          onClick={() => setList((prev) => prev.filter((x) => videoKey(x) !== k))}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Videos guardados de la escuela */}
        <section className="space-y-2 md:order-1 md:border-r md:border-white/10 md:pr-4">
          <div>
            <p className="text-sm font-semibold">Videos guardados</p>
            <p className="text-[11px] text-white/50">Los de toda la escuela, para reusarlos en cualquier jugada.</p>
          </div>
          {saved.isLoading ? <Loader2 className="h-5 w-5 animate-spin text-white/50" /> : saved.data?.available === false ? (
            <p className="text-xs text-white/50">Los videos guardados se activan con la próxima actualización de la base.</p>
          ) : savedList.length === 0 ? (
            <p className="text-xs text-white/50">Todavía no hay videos guardados en la escuela. Los que agregues con «Guardar también» quedan acá para otras jugadas.</p>
          ) : (
            <ul className="space-y-1 max-h-[46vh] overflow-y-auto pr-1">
              {savedList.map((v) => (
                <li key={v.id} className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{v.title}</span>
                    <span className="block text-[11px] text-white/55">{PROVIDER_LABEL[v.provider]} · desde {formatClock(v.start_s)}{v.is_private ? ' · privado' : ''}</span>
                  </div>
                  {!readOnly && (
                    <>
                      <Button type="button" size="sm" variant="outline" aria-label={`Agregar ${v.title} a esta jugada`} disabled={full}
                        title="Agregar a esta jugada"
                        className="h-8 gap-1 px-2 bg-transparent border-white/20 text-white hover:bg-white/10 hover:text-white"
                        onClick={() => {
                          const { id: _i, created_by: _c, created_at: _a, ...video } = v;
                          if (addToPlay(video)) setForm(EMPTY_FORM);
                        }}>
                        <BookmarkPlus className="h-4 w-4" /> Agregar
                      </Button>
                      <Button type="button" size="sm" variant="ghost" aria-label={`Borrar ${v.title} de Videos guardados`}
                        className="h-8 w-8 p-0 text-white/50 hover:bg-white/10 hover:text-red-300"
                        onClick={() => deleteSaved.mutate(v.id, {
                          onError: (err: unknown) => toast({ title: 'No se pudo borrar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' }),
                        })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3">
        {!readOnly && list.length > 0 && (
          <p className="mr-auto text-xs text-white/60">Al terminar, toca «Guardar jugada» en la pizarra para que los videos queden guardados.</p>
        )}
        {!readOnly && <Button type="button" variant="ghost" className="text-white/70 hover:bg-white/10 hover:text-white" onClick={() => onOpenChange(false)}>Cancelar</Button>}
        <Button type="button" className="bg-emerald-600 hover:bg-emerald-500 text-white" onClick={done}>{readOnly ? 'Cerrar' : 'Listo'}</Button>
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-4xl max-h-[92vh] overflow-y-auto bg-zinc-900 text-white border-white/10 p-4 sm:p-6 gap-3">
        <DialogHeader className="space-y-0.5 pr-8 text-left">
          <DialogTitle className="text-xl">Videos</DialogTitle>
          <DialogDescription className="text-white/60 text-xs">
            Enlaces de YouTube, Vimeo, cámaras deportivas (Veo, Hudl, Trace, Pixellot, Spiideo, XbotGo, Reeplayer), Google Drive o Dropbox.{uploadPanel ? ' En «Subir», los videos del celular o descargados de Veo y Hudl.' : ' No se sube ningún archivo.'}
          </DialogDescription>
        </DialogHeader>

        {uploadPanel ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'links' | 'upload')} className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-2 bg-white/10">
              <TabsTrigger value="links" className="text-white/70 data-[state=active]:bg-white data-[state=active]:text-zinc-900">Enlaces</TabsTrigger>
              <TabsTrigger value="upload" className="text-white/70 data-[state=active]:bg-white data-[state=active]:text-zinc-900">Subir</TabsTrigger>
            </TabsList>
            <TabsContent value="links" className="mt-3 space-y-3">{linksBody}</TabsContent>
            <TabsContent value="upload" className="mt-3">
              <div className="rounded-lg bg-background p-3 text-foreground">{uploadPanel}</div>
            </TabsContent>
          </Tabs>
        ) : linksBody}
      </DialogContent>
    </Dialog>
  );
}
