/** Sección «Inscripción»: el QR de inscripción y su enlace (reutiliza list_school_join_qrs de V1). */
import { useCallback, useEffect, useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { qrPrincipal } from '@/lib/cards/carnetsV2Model';
import { cargarQrs, type QrInscripcion } from './carnetsV2Api';
import { FilaV2, SeccionV2 } from './SeccionV2';

function enlace(slug: string) {
  return typeof window === 'undefined' ? '' : `${window.location.origin}/join/${slug}`;
}

export function SeccionQrInscripcion({ schoolId }: { schoolId: string }) {
  const { toast } = useToast();
  const [qrs, setQrs] = useState<QrInscripcion[] | null>(null);
  const [error, setError] = useState(false);

  const cargar = useCallback(async () => {
    setError(false);
    try { setQrs(await cargarQrs(schoolId)); } catch { setError(true); }
  }, [schoolId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const qr = qrs ? qrPrincipal(qrs) : null;
  const url = qr ? enlace(qr.slug) : '';

  async function copiar() {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Enlace copiado', description: 'Pégalo en WhatsApp o en tus redes.' });
    } catch {
      toast({ title: 'Enlace de inscripción', description: url });
    }
  }

  return (
    <SeccionV2 titulo="Inscripción" id="sec-qr">
      {error ? (
        <div className="flex flex-col gap-2 p-3.5">
          <p className="text-sm text-muted-foreground">No pudimos cargar el QR de inscripción.</p>
          <Button variant="outline" size="sm" onClick={() => void cargar()} className="self-start">Reintentar</Button>
        </div>
      ) : qrs === null ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando el QR" /></div>
      ) : !qr ? (
        <>
          <p className="px-3.5 pt-3.5 text-sm text-muted-foreground">Con un QR las familias se inscriben solas, desde el celular.</p>
          <FilaV2 titulo="Crear el QR de inscripción" detalle="Para pegarlo en la sede o compartirlo" href="/qr-signup" />
        </>
      ) : (
        <>
          <div className="flex items-center gap-3.5 p-3.5">
            <div className="shrink-0 rounded-xl border bg-white p-2">
              <QRCodeSVG value={url} size={96} level="M" aria-label={`QR de inscripción: ${qr.name}`} role="img" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[15px] font-semibold">{qr.name}</span>
              <span className="break-all text-xs text-muted-foreground">{url}</span>
              <span className="text-xs text-muted-foreground">{qr.signup_count} inscritos · {qr.scan_count} lecturas</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 px-3.5 pb-3.5">
            <Button variant="outline" className="min-h-11 gap-2 rounded-xl" onClick={copiar}><Copy className="h-4 w-4" />Copiar enlace</Button>
            <Button asChild variant="outline" className="min-h-11 gap-2 rounded-xl">
              <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" />Abrir</a>
            </Button>
          </div>
          <FilaV2 titulo="QR de inscripción" detalle="Póster, descarga y QR por equipo o plan" href="/qr-signup" />
        </>
      )}
    </SeccionV2>
  );
}
