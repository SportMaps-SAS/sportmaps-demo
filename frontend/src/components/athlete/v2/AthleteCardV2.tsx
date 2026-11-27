/**
 * Carnet del deportista — V2 (lienzo DepCarnet).
 *
 * El QR grande para entrar, la vigencia y «Guardar imagen». Un toque agranda el
 * código a pantalla completa para el lector. Misma fuente y misma exportación
 * que MyAthleteCardsPage: RPC my_athlete_id_cards (solo su carnet, relation
 * 'self'), el carnet vigente por escuela (pickCurrentCards), la imagen con
 * exportCardPng y el enlace público /c/:qr_token.
 *
 * Deportista en dos escuelas (D8): selector de escuela encima del carnet.
 *
 * Carnet 3D (spec carnet-3d-club.md §4): el vigente se ve en 3D (tocar gira,
 * el QR está atrás) y «Descargar imagen» lo exporta plano. «Mostrar código
 * QR» sigue abriendo el QR a pantalla completa para el lector.
 */
import { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, CheckCircle2, Download, IdCard, Loader2, QrCode, RefreshCw, Share2, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { exportCardPng, exportCarnet3DPng } from '@/lib/cards/cardExport';
import { AthleteCard3D } from '@/components/cards/AthleteCard3D';
import { useCarnet3D } from '@/hooks/useCarnet3D';
import { pickCurrentCards, slugifyFileName } from '@/lib/cards/cardLayout';
import type { CardData } from '@/components/cards/AthleteIdCard';
import { estadoCarnet, venceCarnet } from '@/components/cards/myCardsModel';
import { iniciales } from '@/components/parent/v2/parentHomeLogic';
import { useAuth } from '@/contexts/AuthContext';
import { OFFLINE_ENABLED } from '@/lib/offline/offlineConfig';
import { faltoLaSenal } from '@/lib/offline/autoevalOffline';
import { guardarCarnets, leerCarnets } from '@/lib/offline/carnetOffline';

interface CardRow {
  card_id: string;
  qr_token: string;
  status: string;
  issued_at: string;
  valid_until: string;
  version: number;
  school_id: string;
  school_name: string;
  school_logo: string | null;
  athlete_id: string;
  athlete_name: string;
  athlete_photo: string | null;
  team_name: string | null;
  branch_name: string | null;
  is_expired: boolean;
  relation: 'self' | 'parent' | 'unknown';
}

export function AthleteCardV2() {
  const [rows, setRows] = useState<CardRow[]>([]);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [escuela, setEscuela] = useState<string | null>(null);
  const [grande, setGrande] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const { user } = useAuth();
  const userId = user?.id;
  /** Cuándo se guardó la copia que se está mostrando (null = datos frescos del servidor). */
  const [copiaDe, setCopiaDe] = useState<number | null>(null);

  const cargar = async () => {
    setState('loading');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await supabase.rpc('my_athlete_id_cards' as any);
    if (error) {
      // Sin señal (no un rechazo del servidor): se muestra la última copia de ESTE usuario.
      const copia = faltoLaSenal(error) && OFFLINE_ENABLED ? leerCarnets<CardRow>(userId) : null;
      if (copia) {
        setRows(copia.rows);
        setCopiaDe(copia.guardadoEn);
        setState('ready');
        return;
      }
      setState('error');
      return;
    }
    const propios = ((data as CardRow[]) ?? []).filter((r) => r.relation === 'self');
    setRows(propios);
    setCopiaDe(null);
    setState('ready');
    guardarCarnets(userId, propios);
  };
  useEffect(() => { void cargar(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const carnets = useMemo(() => pickCurrentCards(rows).map((c) => c.card), [rows]);
  const carnet = carnets.find((c) => c.school_id === escuela) ?? carnets[0] ?? null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const url = carnet ? `${origin}/c/${carnet.qr_token}` : '';
  const estado = carnet ? estadoCarnet(carnet) : null;
  const vigente = estado?.label === 'Vigente';
  const { datos: datos3d, listo: listo3d, estado: estado3d } = useCarnet3D(vigente ? carnet?.qr_token : null);
  const archivo = carnet ? `carnet-${slugifyFileName(carnet.athlete_name, carnet.qr_token.slice(0, 8))}` : 'carnet';

  useEffect(() => {
    if (!grande) return;
    const cerrar = (e: KeyboardEvent) => { if (e.key === 'Escape') setGrande(false); };
    window.addEventListener('keydown', cerrar);
    return () => window.removeEventListener('keydown', cerrar);
  }, [grande]);

  const guardar = async () => {
    if (!carnet) return;
    setGuardando(true);
    try {
      if (datos3d) {
        await exportCarnet3DPng(datos3d, archivo);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('verify_athlete_id_card_public' as any, { p_qr_token: carnet.qr_token });
      if (error || !data) throw error ?? new Error('sin datos');
      await exportCardPng({ data: data as CardData, publicUrl: url }, archivo);
    } catch {
      toast.error('No se pudo guardar el carnet', { description: 'Inténtalo de nuevo en un momento.' });
    } finally {
      setGuardando(false);
    }
  };

  const compartir = async () => {
    if (!url) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Mi carnet', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success('Enlace copiado');
    } catch {
      /* el usuario canceló o no hay portapapeles */
    }
  };

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 pb-nav-safe">
      <h1 className="text-2xl font-bold">Carnet</h1>

      {state === 'loading' && (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando tu carnet">
          <Skeleton className="h-96 w-full rounded-3xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden /> No pudimos cargar tu carnet
          </p>
          <p className="text-sm text-muted-foreground">Revisa tu conexión e inténtalo de nuevo.</p>
          <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => { void cargar(); }}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Reintentar
          </Button>
        </div>
      )}

      {state === 'ready' && !carnet && (
        <div className="rounded-2xl border bg-card p-6 text-center">
          <IdCard className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="mt-2 font-semibold">Aún no tienes carnet</p>
          <p className="mt-1 text-sm text-muted-foreground">La escuela todavía no te lo ha emitido. Pídeselo si lo necesitas.</p>
        </div>
      )}

      {state === 'ready' && carnet && (
        <>
          {copiaDe !== null && (
            <div role="status" className="flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                Sin señal: este es tu carnet guardado el {new Date(copiaDe).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}.
                Si la escuela lo anuló después, lo sabremos cuando vuelva la señal.
              </p>
            </div>
          )}
          {carnets.length > 1 && (
            <div role="tablist" aria-label="Escuela" className="flex gap-1 overflow-x-auto rounded-xl bg-muted p-1">
              {carnets.map((c) => (
                <button
                  key={c.school_id}
                  type="button"
                  role="tab"
                  aria-selected={c.school_id === carnet.school_id}
                  onClick={() => setEscuela(c.school_id)}
                  className={cn('min-h-touch flex-1 whitespace-nowrap rounded-lg px-3 text-sm', c.school_id === carnet.school_id ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground')}
                >
                  {c.school_name}
                </button>
              ))}
            </div>
          )}

          {vigente && (estado3d === 'cargando' || (datos3d && !listo3d)) && (
            <Skeleton className="mx-auto rounded-2xl" style={{ width: 296, height: Math.round(296 * 540 / 340) }} aria-label="Cargando tu carnet" />
          )}

          {vigente && datos3d && listo3d && (
            <div className="flex flex-col items-center gap-2">
              <AthleteCard3D datos={datos3d} ancho={296} />
              <p className="text-xs text-muted-foreground">Toca el carnet para girarlo.</p>
              <Button variant="outline" className="min-h-touch gap-2 rounded-2xl" onClick={() => setGrande(true)}>
                <QrCode className="h-4 w-4" aria-hidden /> Mostrar código QR
              </Button>
            </div>
          )}

          {(!vigente || estado3d === 'error' || (estado3d === 'listo' && !datos3d)) && (
          <article className="overflow-hidden rounded-3xl border bg-card shadow-sm md:mx-auto md:max-w-md">
            <div className="flex items-center gap-3 bg-primary px-4 py-3 text-primary-foreground">
              {carnet.school_logo ? (
                <img src={carnet.school_logo} alt="" className="h-9 w-9 rounded-lg bg-white object-contain" />
              ) : (
                <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-foreground/20 text-xs font-bold">{iniciales(carnet.school_name)}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{carnet.school_name}</span>
              <span className="text-xs font-semibold opacity-90">Deportista</span>
            </div>
            <div className="flex items-center gap-3 px-4 pt-4">
              {carnet.athlete_photo ? (
                <img src={carnet.athlete_photo} alt="" className="h-14 w-14 rounded-xl object-cover" />
              ) : (
                <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-base font-bold text-primary">{iniciales(carnet.athlete_name)}</span>
              )}
              <div className="min-w-0">
                <p className="truncate text-lg font-bold leading-tight">{carnet.athlete_name}</p>
                {(carnet.team_name || carnet.branch_name) && (
                  <p className="truncate text-sm text-muted-foreground">{[carnet.team_name, carnet.branch_name].filter(Boolean).join(' · ')}</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => vigente && setGrande(true)}
              disabled={!vigente}
              aria-label="Agrandar el código QR"
              className="mx-auto my-4 flex flex-col items-center gap-2 rounded-2xl bg-white p-4 disabled:opacity-40"
            >
              <QRCodeSVG value={url} size={208} level="M" />
              {vigente && <span className="text-xs text-neutral-600">Toca el código para agrandarlo</span>}
            </button>
          </article>
          )}

          {estado && (
            <div className={cn('flex items-start gap-3 rounded-2xl p-4', vigente ? 'bg-primary/10' : 'bg-destructive/10')}>
              {vigente
                ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />}
              <div>
                <p className="font-semibold">{vigente ? venceCarnet(carnet) : `Tu carnet está ${estado.label.toLowerCase()}`}</p>
                <p className="text-sm text-muted-foreground">
                  {vigente ? 'Sirve en la entrada del club y en los torneos.' : 'Pídele a la escuela que lo renueve.'}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 md:mx-auto md:max-w-md">
            <Button className="h-12 min-h-touch rounded-2xl text-base font-semibold" onClick={() => { void guardar(); }} disabled={!vigente || guardando}>
              {guardando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-2 h-4 w-4" aria-hidden />}
              Descargar imagen
            </Button>
            <Button variant="outline" className="h-12 min-h-touch rounded-2xl text-base font-semibold" onClick={() => { void compartir(); }} disabled={!vigente}>
              <Share2 className="mr-2 h-4 w-4" aria-hidden /> Compartir
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">Sube el brillo de la pantalla si el lector no lo toma.</p>
        </>
      )}

      {grande && carnet && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Código QR del carnet"
          onClick={() => setGrande(false)}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-white p-6 text-neutral-900"
        >
          <QRCodeSVG value={url} size={Math.min(320, typeof window === 'undefined' ? 320 : window.innerWidth - 48)} level="M" />
          <p className="text-lg font-bold">{carnet.athlete_name}</p>
          <p className="text-sm text-neutral-600">{carnet.school_name} · {estado?.label.toLowerCase()}</p>
          <p className="text-xs text-neutral-500">Toca para cerrar</p>
        </div>
      )}
    </div>
  );
}

export default AthleteCardV2;
