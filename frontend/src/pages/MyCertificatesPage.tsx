/**
 * Constancias — rediseño V2 (acudiente). Una frase, un botón para pedir una
 * constancia y la lista con su estado en palabras. Carga, vacío y error son
 * tres estados distintos.
 */
import { useEffect, useState } from 'react';
import { Loader2, Download, ExternalLink, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { ChipEstado } from '@/components/common/ChipEstado';
import { estadoConstancia, fraseConstancias } from '@/components/certificates/myCertificatesModel';
import { cn } from '@/lib/utils';

type Mine = {
  id: string;
  folio: string;
  kind: string;
  title: string;
  status: 'pending_payment' | 'pending_review' | 'issued' | 'revoked';
  created_at: string;
  issued_at: string | null;
  pdf_url: string | null;
  qr_verify_token: string;
  school_id: string;
  school_name: string;
  athlete_name: string;
};

type Tpl = { id: string; name: string; kind: string };
/** A quién se le pide: un hijo (acudiente) o uno mismo en una escuela (deportista adulto). */
type ChildOpt = { id: string; full_name: string; school_id: string; kind: 'child' | 'profile' };

export default function MyCertificatesPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<Mine[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);

  const [reqOpen, setReqOpen] = useState(false);
  const [reqLoading, setReqLoading] = useState(false);
  const [children, setChildren] = useState<ChildOpt[]>([]);
  const [selectedChild, setSelectedChild] = useState<string>('');
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [selectedTpl, setSelectedTpl] = useState<string>('');

  useEffect(() => {
    void load();
    void loadChildren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState('loading');
    const { data, error } = await supabase.rpc('my_athlete_certificates' as any);
    if (error) {
      setItems([]);
      setState('error');
      return;
    }
    setItems((data as Mine[]) || []);
    setState('ready');
  }

  async function loadChildren() {
    if (!user) return;
    const [hijos, propias] = await Promise.all([
      supabase.from('children').select('id, full_name, school_id').eq('parent_id', user.id),
      // Deportista adulto: puede pedir sus propias constancias en cada escuela donde está activo.
      supabase.from('school_members').select('school_id').eq('profile_id', user.id).eq('role', 'athlete').eq('status', 'active'),
    ]);
    const opts: ChildOpt[] = ((hijos.data as any[]) ?? [])
      .filter((c) => c.school_id)
      .map((c) => ({ id: c.id, full_name: c.full_name, school_id: c.school_id, kind: 'child' as const }));
    const escuelas = [...new Set((((propias.data as any[]) ?? []).map((m) => m.school_id)).filter(Boolean))] as string[];
    if (escuelas.length > 0) {
      const { data: sch } = await supabase.from('schools').select('id, name').in('id', escuelas);
      const nombre = new Map(((sch as any[]) ?? []).map((s) => [s.id, s.name]));
      for (const sid of escuelas) {
        opts.push({ id: user.id, full_name: escuelas.length > 1 ? `Yo · ${nombre.get(sid) ?? 'mi escuela'}` : 'Yo', school_id: sid, kind: 'profile' });
      }
    }
    setChildren(opts);
  }

  const optKey = (c: ChildOpt) => `${c.kind}:${c.id}:${c.school_id}`;

  async function loadTemplatesForChild(childId: string) {
    const child = children.find((c) => optKey(c) === childId);
    if (!child) return setTemplates([]);
    const { data, error } = await supabase
      .from('school_certificate_templates' as any)
      .select('id, name, kind')
      .eq('school_id', child.school_id)
      .eq('active', true)
      .order('name');
    if (error) return setTemplates([]);
    setTemplates((data as unknown as Tpl[]) || []);
  }

  async function submitRequest() {
    const child = children.find((c) => optKey(c) === selectedChild);
    const tpl = templates.find((t) => t.id === selectedTpl);
    if (!child || !tpl) return;
    setReqLoading(true);
    const { data, error } = await supabase.rpc('request_athlete_certificate' as any, {
      p_school_id:   child.school_id,
      p_template_id: tpl.id,
      p_child_id:    child.kind === 'child' ? child.id : null,
      p_profile_id:  child.kind === 'profile' ? child.id : null,
    });
    setReqLoading(false);
    if (error) {
      return toast({ title: 'No se pudo pedir la constancia', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    }
    toast({
      title: (data as any)?.already_pending ? 'Ya la habías pedido' : 'Listo, la pediste',
      description: 'La escuela la revisa y te avisa cuando esté lista.',
    });
    setReqOpen(false);
    setSelectedChild(''); setSelectedTpl(''); setTemplates([]);
    await load();
  }

  async function downloadPdf(it: Mine) {
    setBusyId(it.id);
    try {
      const res = await bffClient.get<any>(`/api/v1/certificates/${it.id}/signed-url`);
      if (!res?.url) throw new Error('no_url');
      window.open(res.url, '_blank');
    } catch {
      toast({ title: 'No se pudo descargar', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  const frase = fraseConstancias(items);
  const puedePedir = children.length > 0;

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-5 pb-nav-safe">
      <section aria-label="Resumen" className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-muted-foreground">Constancias</p>
          {state === 'ready' && <h1 className="text-2xl font-bold leading-tight tracking-tight">{frase.titulo}</h1>}
          {state === 'ready' && <p className="text-base text-muted-foreground">{frase.subtitulo}</p>}
        </div>
        {state === 'ready' && puedePedir && (
          <Button
            onClick={() => setReqOpen(true)}
            className="h-14 w-full rounded-2xl text-lg font-semibold active:scale-[0.97] motion-reduce:active:scale-100"
          >
            Pedir una constancia
          </Button>
        )}
      </section>

      {state === 'loading' && (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando las constancias">
          <Skeleton className="h-8 w-4/5 rounded-lg" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-base font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            No pudimos cargar las constancias
          </p>
          <p className="text-sm text-muted-foreground">Revisa tu conexión e inténtalo de nuevo.</p>
          <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      )}

      {state === 'ready' && items.length > 0 && (
        <div className="overflow-hidden rounded-2xl border bg-card">
          {items.map((it, i) => {
            const estado = estadoConstancia(it.status);
            const lista = it.status === 'issued' && !!it.pdf_url;
            return (
              <div key={it.id} className={cn('space-y-1 px-4 py-3', i > 0 && 'border-t')}>
                <div className="flex items-start gap-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words text-base font-semibold">{it.title || 'Constancia'}</span>
                    <span className="break-words text-xs text-muted-foreground">
                      {it.athlete_name}{it.school_name ? ` · ${it.school_name}` : ''} · Folio {it.folio}
                    </span>
                    {estado.detalle && <span className="text-xs text-muted-foreground">{estado.detalle}</span>}
                  </span>
                  <ChipEstado label={estado.label} tono={estado.tono} />
                </div>
                <div className="flex flex-wrap gap-x-4">
                  {lista && (
                    <button
                      type="button"
                      onClick={() => downloadPdf(it)}
                      disabled={busyId === it.id}
                      className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-primary disabled:opacity-60"
                    >
                      {busyId === it.id
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <Download className="h-4 w-4" aria-hidden="true" />}
                      Descargar
                    </button>
                  )}
                  {(it.status === 'issued' || it.status === 'revoked') && (
                  <a
                    href={`/cert/${it.qr_verify_token}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-touch items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    Verificar
                  </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {state === 'ready' && items.length === 0 && !puedePedir && (
        <div className="rounded-2xl border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">Cuando la escuela te emita una constancia, aparece aquí.</p>
        </div>
      )}

      <Dialog open={reqOpen} onOpenChange={setReqOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pedir una constancia</DialogTitle>
            <DialogDescription>Elige para quién es y qué constancia necesitas.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>¿Para quién?</Label>
              <Select
                value={selectedChild}
                onValueChange={(v) => { setSelectedChild(v); void loadTemplatesForChild(v); setSelectedTpl(''); }}
              >
                <SelectTrigger className="min-h-touch text-input"><SelectValue placeholder="Elige para quién" /></SelectTrigger>
                <SelectContent>
                  {children.map((c) => (
                    <SelectItem key={optKey(c)} value={optKey(c)}>{c.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>¿Qué constancia?</Label>
              <Select value={selectedTpl} onValueChange={setSelectedTpl} disabled={!selectedChild || templates.length === 0}>
                <SelectTrigger className="min-h-touch text-input">
                  <SelectValue placeholder={!selectedChild ? 'Primero elige para quién' : (templates.length === 0 ? 'La escuela aún no ofrece constancias' : 'Elige una')} />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="min-h-touch" onClick={() => setReqOpen(false)}>Cancelar</Button>
            <Button className="min-h-touch" onClick={submitRequest} disabled={!selectedChild || !selectedTpl || reqLoading}>
              {reqLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Pedirla
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
