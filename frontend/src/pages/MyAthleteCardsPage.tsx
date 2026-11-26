/**
 * Carnets — acudiente («Carnets») y deportista («Mis carnets»). Rediseño V2:
 * una frase, la lista de carnets vigentes (uno por deportista y escuela) y,
 * al tocar uno, el carnet en grande para mostrarlo o descargarlo.
 *
 * Carnet 3D (spec carnet-3d-club.md §4, §11.1): el vigente se ve en 3D con su
 * reverso; «Descargar imagen» lo exporta plano. La versión para imprimir
 * sigue con la plantilla clásica. Revocado/vencido: vista clásica de estado.
 *
 * Carga, vacío y error son distintos: un error al cargar NUNCA se ve como
 * «no tienes carnets».
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, IdCard, Download, ExternalLink, AlertTriangle, RefreshCw, ChevronRight, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { AthleteIdCard, type CardData } from '@/components/cards/AthleteIdCard';
import { exportCardPng, exportCarnet3DPng } from '@/lib/cards/cardExport';
import { AthleteCard3D, DatosDelDeportista } from '@/components/cards/AthleteCard3D';
import { filasDatosDeportista, useCarnet3DDesdeVerify } from '@/hooks/useCarnet3D';
import { pickCurrentCards, slugifyFileName } from '@/lib/cards/cardLayout';
import { ChipEstado } from '@/components/common/ChipEstado';
import { estadoCarnet, venceCarnet, fraseCarnets } from '@/components/cards/myCardsModel';
import { cn } from '@/lib/utils';

type MyCardRow = {
  card_id: string;
  qr_token: string;
  status: 'active' | 'revoked' | 'expired' | string;
  issued_at: string;
  valid_until: string;
  version: number;
  school_id: string;
  school_name: string;
  school_slug: string | null;
  school_logo: string | null;
  school_branding: any;
  athlete_kind: 'child' | 'profile';
  athlete_id: string;
  athlete_name: string;
  athlete_photo: string | null;
  team_name: string | null;
  branch_name: string | null;
  is_expired: boolean;
  relation: 'self' | 'parent' | 'unknown';
};

export default function MyAthleteCardsPage() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const isAthlete = profile?.role === 'athlete';
  const [rows, setRows] = useState<MyCardRow[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<CardData | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState<'imagen' | 'imprimir' | null>(null);
  const { datos: datos3d, listo: listo3d } = useCarnet3DDesdeVerify(previewData);
  const filas = useMemo(() => filasDatosDeportista(previewData), [previewData]);

  const publicCardOrigin = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/c`;
  }, []);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setState('loading');
    const { data, error } = await supabase.rpc('my_athlete_id_cards' as any);
    if (error) {
      setRows([]);
      setState('error');
      return;
    }
    setRows((data as MyCardRow[]) || []);
    setState('ready');
  }

  // Por escuela, y dentro de cada escuela solo el carnet vigente de cada atleta:
  // al reemitir, el anterior queda "Revocado" y antes salía como otra tarjeta
  // más, que el acudiente leía como "le quitaron el carnet a mi hijo".
  const groups = useMemo(() => {
    const map = new Map<string, { school_name: string; school_logo: string | null; rows: MyCardRow[] }>();
    for (const r of rows) {
      if (!map.has(r.school_id)) map.set(r.school_id, { school_name: r.school_name, school_logo: r.school_logo, rows: [] });
      map.get(r.school_id)!.rows.push(r);
    }
    return Array.from(map.entries()).map(([schoolId, g]) => ({
      schoolId,
      school_name: g.school_name,
      school_logo: g.school_logo,
      cards: pickCurrentCards(g.rows).sort((a, b) => a.card.athlete_name.localeCompare(b.card.athlete_name, 'es')),
    }));
  }, [rows]);

  const allCards = groups.flatMap((g) => g.cards.map((c) => c.card));
  const frase = fraseCarnets(allCards, isAthlete);

  async function openPreview(qrToken: string) {
    setPreviewToken(qrToken);
    setPreviewData(null);
    setPreviewError(false);
    setPreviewOpen(true);
    const { data, error } = await supabase.rpc('verify_athlete_id_card_public' as any, {
      p_qr_token: qrToken,
    });
    if (error) {
      setPreviewError(true);
      return;
    }
    setPreviewData(data as CardData);
  }

  const nombreArchivo = () =>
    `carnet-${slugifyFileName(previewData?.athlete?.full_name, (previewToken ?? '').slice(0, 8))}`;

  async function downloadImagen() {
    if (!datos3d) return;
    setDownloading('imagen');
    try {
      await exportCarnet3DPng(datos3d, nombreArchivo());
    } catch {
      toast({ title: 'No se pudo descargar la imagen', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    } finally {
      setDownloading(null);
    }
  }

  async function downloadPreview() {
    if (!previewData || !previewToken) return;
    setDownloading('imprimir');
    try {
      await exportCardPng(
        { data: previewData, publicUrl: `${publicCardOrigin}/${previewToken}` },
        `${nombreArchivo()}-para-imprimir`,
      );
    } catch {
      toast({ title: 'No se pudo descargar el carnet', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-5 pb-nav-safe">
      <header className="space-y-1.5">
        <p className="text-sm font-medium text-muted-foreground">{isAthlete ? 'Mis carnets' : 'Carnets'}</p>
        {state === 'ready' && <h1 className="text-2xl font-bold leading-tight tracking-tight">{frase.titulo}</h1>}
        {state === 'ready' && frase.subtitulo && <p className="text-base text-muted-foreground">{frase.subtitulo}</p>}
      </header>

      {state === 'loading' && (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando los carnets">
          <Skeleton className="h-8 w-4/5 rounded-lg" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-base font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            No pudimos cargar los carnets
          </p>
          <p className="text-sm text-muted-foreground">Revisa tu conexión e inténtalo de nuevo.</p>
          <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      )}

      {state === 'ready' && allCards.length === 0 && (
        <div className="rounded-2xl border bg-card p-6 text-center">
          <IdCard className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <p className="mt-2 font-semibold">{isAthlete ? 'Aún no tienes carnet' : 'Aún no hay carnets'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isAthlete
              ? 'La escuela todavía no te ha emitido el carnet. Pídeselo si lo necesitas.'
              : 'La escuela todavía no ha emitido el carnet de tus hijos. Pídeselo si lo necesitas.'}
          </p>
        </div>
      )}

      {state === 'ready' && groups.map((group) => (
        <section key={group.schoolId} aria-label={group.school_name} className="space-y-1.5">
          {groups.length > 1 && (
            <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{group.school_name}</h2>
          )}
          <div className="overflow-hidden rounded-2xl border bg-card">
            {group.cards.map(({ card: c, revokedCount }, i) => {
              const estado = estadoCarnet(c);
              const detalle = [c.team_name, c.branch_name].filter(Boolean).join(' · ');
              return (
                <button
                  type="button"
                  key={c.card_id}
                  className={cn('flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50', i > 0 && 'border-t')}
                  onClick={() => openPreview(c.qr_token)}
                >
                  {c.athlete_photo ? (
                    <img src={c.athlete_photo} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <IdCard className="h-6 w-6" aria-hidden="true" />
                    </div>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words text-base font-semibold leading-tight">
                      {c.athlete_name}{c.relation === 'self' && !isAthlete ? ' (tú)' : ''}
                    </span>
                    {detalle && <span className="break-words text-xs text-muted-foreground">{detalle}</span>}
                    <span className="text-xs text-muted-foreground">{venceCarnet(c)}</span>
                    {revokedCount > 0 && (
                      <span className="text-xs text-muted-foreground">Este carnet reemplaza al anterior.</span>
                    )}
                  </span>
                  <span className="flex flex-col items-end gap-2">
                    <ChipEstado {...estado} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[95vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Carnet deportivo</DialogTitle>
            <DialogDescription>
              {datos3d ? 'Toca el carnet para girarlo: el código QR está atrás.' : 'Muestra el código QR en la entrada de la escuela.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            {previewError ? (
              <div role="alert" className="w-full space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-center">
                <p className="font-semibold text-destructive">No pudimos abrir el carnet</p>
                <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => previewToken && void openPreview(previewToken)}>
                  Reintentar
                </Button>
              </div>
            ) : !previewData || (previewData.status === 'active' && !listo3d) ? (
              <Loader2 className="h-6 w-6 animate-spin" aria-label="Cargando el carnet" />
            ) : datos3d ? (
              <AthleteCard3D datos={datos3d} ancho={280} />
            ) : (
              <AthleteIdCard
                data={previewData}
                face="front"
                publicUrl={`${publicCardOrigin}/${previewToken}`}
              />
            )}
            {datos3d && <DatosDelDeportista filas={filas} />}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              onClick={downloadImagen}
              disabled={downloading !== null || !datos3d}
              className="h-12 w-full gap-2 rounded-xl text-base font-semibold"
            >
              {downloading === 'imagen' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
              Descargar imagen
            </Button>
            <Button
              variant="outline"
              onClick={downloadPreview}
              disabled={downloading !== null || previewData?.status !== 'active'}
              className="min-h-touch w-full gap-2 rounded-xl"
            >
              {downloading === 'imprimir' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Printer className="h-4 w-4" aria-hidden="true" />}
              Versión para imprimir
            </Button>
            <Button
              variant="ghost"
              onClick={() => previewToken && window.open(`/c/${previewToken}`, '_blank')}
              className="min-h-touch w-full gap-2"
              disabled={!previewToken}
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Abrir el enlace para compartir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
