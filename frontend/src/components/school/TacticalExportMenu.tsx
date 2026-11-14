/**
 * «Exportar ▾» de la pizarra táctica (spec docs/specs/pizarra-nivel-tacticalpad.md, T2 y §5):
 * Imagen (PNG) · Ficha del ejercicio (PDF) · Video (o Animación GIF) de la jugada · Compartir por WhatsApp.
 *
 * La animación sale en video si el navegador graba (MediaRecorder + captureStream
 * + algún codec); si no (Safari viejo, WebView de iOS, Capacitor) sale GIF, y el
 * ítem lo dice con palabras. En el celular, al terminar, el toast ofrece
 * «Compartir por WhatsApp» con el archivo (Web Share API necesita un toque
 * fresco: el de «Exportar» ya se venció mientras se armaba).
 *
 * El trabajo pesado (jsPDF, react-dom/server, MediaRecorder) se carga recién
 * al exportar con import(): la pizarra no paga ese peso al abrir.
 */
import { useMemo, useState } from 'react';
import { saveAs } from 'file-saver';
import { ChevronDown, Download, FileText, Film, Image as ImageIcon, Link2, Loader2, Plus, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/hooks/use-toast';
import type { TacticalExportInput } from '@/lib/export/tacticalExport';
// Liviano (sin React ni jsPDF): solo decide si sale video o GIF para rotular el ítem.
import { animationLabel, pickAnimationKind, type TacticalAnimationKind } from '@/lib/export/tacticalAnimationFormat';
import { exportAvailability } from '@/lib/school/tacticalBoardUx';

export type TacticalExportEvent = 'export_png' | 'export_pdf' | 'export_video' | 'share';

export interface TacticalExportMenuProps {
  /** Se llama al elegir una opción: devuelve el estado actual de la pizarra. */
  getInput: () => TacticalExportInput | Promise<TacticalExportInput>;
  /** Cuántos cuadros tiene la jugada (habilita el video/GIF con 2 o más). */
  frameCount: number;
  /** Forzar video o GIF (pruebas). Por defecto lo decide el navegador. */
  animationKind?: TacticalAnimationKind;
  /** Métrica de uso (T0): log_tactical_board_event. */
  onEvent?: (event: TacticalExportEvent) => void;
  disabled?: boolean;
  className?: string;
  /** En el toolbar de la pizarra: mismo alto que los demás botones (h-8). */
  compact?: boolean;
  /** ¿Hay algo en la cancha? Sin nada, PNG, PDF y video quedan apagados con el motivo. */
  hasContent?: boolean;
  /** «+ Cuadro» de la pizarra: con un solo cuadro, el ítem de video lleva ahí. */
  onAddFrame?: () => void;
  /** «Compartir enlace»: guarda la jugada y manda por WhatsApp un link de solo lectura. */
  onShareLink?: () => void;
}

type Busy = null | 'png' | 'pdf' | 'video' | 'share';

const loadExport = () => import('@/lib/export/tacticalExport');

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Inténtalo de nuevo.';
}

export function TacticalExportMenu({
  getInput, frameCount, onEvent, disabled, className, animationKind, compact, hasContent = true, onAddFrame, onShareLink,
}: TacticalExportMenuProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const avail = exportAvailability({ hasContent, frameCount, canAddFrame: !!onAddFrame });
  const videoReady = avail.video.enabled;
  const kind = useMemo<TacticalAnimationKind>(() => animationKind ?? pickAnimationKind(), [animationKind]);
  const animLabel = animationLabel(kind);
  const animNoun = kind === 'video' ? 'el video' : 'la animación';

  const downloadPng = async (input?: TacticalExportInput) => {
    const mod = await loadExport();
    const data = input ?? (await getInput());
    const blob = await mod.exportPng({ players: data.players, arrows: data.arrows, title: data.title, teamName: data.teamName, sport: data.sport, teams: data.teams, branding: data.branding });
    saveAs(blob, mod.exportFileName(data.title, 'png'));
  };

  /** `work` devuelve el título final del toast, o null si ya dejó el toast como debe quedar. */
  const run = async (kind: Exclude<Busy, null>, work: (t: ReturnType<typeof toast>) => Promise<string | null>) => {
    if (busy) return;
    setBusy(kind);
    // Sin cierre automático mientras trabaja (el video dura lo que dura la jugada).
    const t = toast({ title: 'Preparando…', description: 'Esto toma unos segundos.', duration: 120_000 });
    try {
      const done = await work(t);
      if (done !== null) t.update({ id: t.id, title: done, description: undefined, duration: 4000 });
    } catch (e) {
      const mod = await loadExport().catch(() => null);
      if (mod?.isTacticalVideoUnsupported(e)) {
        t.update({
          id: t.id,
          duration: 10_000,
          title: `No se pudo hacer ${animNoun}`,
          description: e instanceof Error ? e.message : undefined,
          action: (
            <ToastAction altText="Descargar imagen" onClick={() => void downloadPng().catch(() => undefined)}>
              Descargar imagen
            </ToastAction>
          ),
        });
      } else {
        t.update({ id: t.id, title: 'No se pudo exportar', description: errorMessage(e), variant: 'destructive', duration: 6000 });
      }
    } finally {
      setBusy(null);
    }
  };

  const onPng = () =>
    run('png', async (t) => {
      t.update({ id: t.id, title: 'Generando imagen…' });
      await downloadPng();
      onEvent?.('export_png');
      return 'Imagen descargada';
    });

  const onPdf = () =>
    run('pdf', async (t) => {
      t.update({ id: t.id, title: 'Armando la ficha del ejercicio…' });
      const mod = await loadExport();
      const data = await getInput();
      const blob = await mod.exportExercisePdf({ ...data, title: data.title || 'Ejercicio' });
      saveAs(blob, mod.exportFileName(data.title, 'pdf', 'ficha'));
      onEvent?.('export_pdf');
      return 'Ficha descargada';
    });

  const onVideo = () =>
    run('video', async (t) => {
      const mod = await loadExport();
      const data = await getInput();
      const working = kind === 'video' ? 'Grabando el video…' : 'Armando la animación GIF…';
      t.update({
        id: t.id,
        title: working,
        description: kind === 'video' ? 'Se reproduce la jugada mientras se graba.' : 'Esto toma unos segundos.',
      });
      let last = -1;
      const res = await mod.exportAnimation({
        kind,
        frames: data.frames ?? [],
        playerLabels: data.playerLabels,
        playerJerseys: data.playerJerseys,
        teams: data.teams,
        playerNames: data.playerNames,
        sport: data.sport,
        playback: data.playback,
        branding: data.branding,
        onProgress: (p) => {
          const pct = Math.round(p * 10) * 10;
          if (pct !== last) {
            last = pct;
            t.update({ id: t.id, title: `${working} ${pct} %` });
          }
        },
      });
      // 'export_video' cubre video y GIF: es el evento que acepta log_tactical_board_event.
      onEvent?.('export_video');
      const filename = mod.exportFileName(data.title, res.ext);
      const what = res.kind === 'video' ? 'Video' : 'Animación GIF';
      const text = data.title ? `Jugada: ${data.title}` : 'Te comparto la jugada';
      if (mod.canShareFiles(res.blob, filename)) {
        // En el celular: el archivo va directo a la hoja de compartir (WhatsApp, Guardar…).
        t.update({
          id: t.id,
          duration: 60_000,
          title: res.kind === 'video' ? 'Video listo' : 'Animación GIF lista',
          description: 'Toca «Compartir» para enviar el archivo por WhatsApp o guardarlo.',
          action: (
            <ToastAction
              altText="Compartir por WhatsApp"
              onClick={() => {
                void mod
                  .shareFile(res.blob, filename, text)
                  .then((r) => {
                    if (r.method !== 'cancelled') onEvent?.('share');
                  })
                  .catch(() => saveAs(res.blob, filename));
              }}
            >
              Compartir
            </ToastAction>
          ),
        });
        return null;
      }
      saveAs(res.blob, filename);
      return `${what} descargad${res.kind === 'video' ? 'o' : 'a'}`;
    });

  const onShare = () =>
    run('share', async (t) => {
      t.update({ id: t.id, title: 'Preparando para compartir…' });
      const mod = await loadExport();
      const data = await getInput();
      const blob = await mod.exportPng({ players: data.players, arrows: data.arrows, title: data.title, teamName: data.teamName, sport: data.sport, teams: data.teams, branding: data.branding });
      const text = data.title ? `Jugada: ${data.title}` : 'Te comparto la jugada';
      const res = await mod.shareFile(blob, mod.exportFileName(data.title, 'png'), text);
      if (res.method === 'cancelled') return 'Compartir cancelado';
      onEvent?.('share');
      if (res.method === 'download') {
        t.update({
          id: t.id,
          duration: 10_000,
          title: 'Imagen descargada',
          description: 'Ábrela en WhatsApp y adjúntala al chat.',
          action: (
            <ToastAction altText="Abrir WhatsApp" onClick={() => window.open(res.whatsappUrl, '_blank', 'noopener,noreferrer')}>
              Abrir WhatsApp
            </ToastAction>
          ),
        });
        return null;
      }
      return 'Compartido';
    });

  const itemClass = 'min-h-touch gap-3 cursor-pointer';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={`${compact ? 'h-8 gap-1' : 'min-h-touch gap-2'} ${className ?? ''}`}
          disabled={disabled || !!busy}
          aria-label="Exportar la jugada"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Exportar
          <ChevronDown className="h-4 w-4 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem className={itemClass} disabled={!avail.png.enabled} onSelect={() => void onPng()}>
          <ImageIcon className="h-4 w-4" />
          <ItemText label="Imagen (PNG)" reason={avail.png.reason} />
        </DropdownMenuItem>
        <DropdownMenuItem className={itemClass} disabled={!avail.pdf.enabled} onSelect={() => void onPdf()}>
          <FileText className="h-4 w-4" />
          <ItemText label="Ficha del ejercicio (PDF)" reason={avail.pdf.reason} />
        </DropdownMenuItem>
        {videoReady ? (
          <DropdownMenuItem className={itemClass} onSelect={() => void onVideo()}>
            <Film className="h-4 w-4" /> {animLabel}
          </DropdownMenuItem>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* El ítem deshabilitado no recibe el puntero: el tooltip va en el envoltorio. */}
              <div>
                <DropdownMenuItem className={itemClass} disabled>
                  <Film className="h-4 w-4" />
                  <ItemText label={animLabel} reason={avail.video.reason} />
                </DropdownMenuItem>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left">
              {hasContent ? 'Agrega un segundo cuadro para animar la jugada.' : 'Pon jugadores o dibuja algo en la cancha primero.'}
            </TooltipContent>
          </Tooltip>
        )}
        {avail.video.offerAddFrame && onAddFrame && (
          <DropdownMenuItem className={`${itemClass} pl-9 text-emerald-700 dark:text-emerald-400`} onSelect={() => onAddFrame()} data-testid="export-add-frame">
            <Plus className="h-4 w-4" /> Agregar un cuadro (+ Cuadro)
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {onShareLink && (
          <DropdownMenuItem className={itemClass} disabled={!hasContent} onSelect={() => onShareLink()} data-testid="export-share-link">
            <Link2 className="h-4 w-4" />
            <ItemText label="Compartir enlace por WhatsApp" reason={hasContent ? 'Abre la jugada en la web, sin descargar nada' : avail.png.reason} />
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className={itemClass} disabled={!avail.png.enabled} onSelect={() => void onShare()}>
          <Share2 className="h-4 w-4" />
          <ItemText label={onShareLink ? 'Compartir imagen por WhatsApp' : 'Compartir por WhatsApp'} reason={avail.png.reason} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Texto del ítem con el motivo debajo cuando está apagado. */
function ItemText({ label, reason }: { label: string; reason: string | null }) {
  if (!reason) return <span>{label}</span>;
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span className="text-xs text-muted-foreground">{reason}</span>
    </span>
  );
}
