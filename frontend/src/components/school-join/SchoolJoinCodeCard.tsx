/**
 * Tarjeta «Código de la escuela» (spec codigo-de-escuela-union-por-codigo §3).
 * Solo administración: la RPC get_school_join_code lo exige (user_admin_school_ids).
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Copy, Check, MessageCircle, QrCode, RefreshCw, Download, Link2, Loader2, KeyRound } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { schoolJoinApi } from '@/lib/api/schoolJoin';
import { buildJoinUrl, buildJoinWhatsAppText, formatJoinCode, joinErrorMessage } from '@/lib/schoolJoinCode';

export function SchoolJoinCodeCard({ schoolId, schoolName }: { schoolId: string; schoolName: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const qrWrapRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['school-join-code', schoolId],
    queryFn: () => schoolJoinApi.getCode(schoolId),
    enabled: !!schoolId,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const rotate = useMutation({
    mutationFn: () => schoolJoinApi.rotateCode(schoolId),
    onSuccess: (info) => {
      qc.setQueryData(['school-join-code', schoolId], info);
      toast({ title: 'Código cambiado', description: `El nuevo código es ${formatJoinCode(info.code)}. El anterior ya no sirve.` });
    },
    onError: (e) => toast({ title: 'No se pudo cambiar el código', description: joinErrorMessage(e), variant: 'destructive' }),
  });

  // Sin la migración aplicada (o sin permiso) la tarjeta no se muestra: no rompe la página.
  if (error) return null;

  const code = data?.code ?? '';
  const pretty = formatJoinCode(code);
  const url = code ? buildJoinUrl(window.location.origin, code) : '';
  const waHref = code ? `https://wa.me/?text=${encodeURIComponent(buildJoinWhatsAppText(schoolName, code, url))}` : '#';

  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? pretty : url);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
      toast({ title: what === 'code' ? 'Código copiado' : 'Enlace copiado' });
    } catch {
      toast({ title: 'No se pudo copiar', variant: 'destructive' });
    }
  };

  const downloadQR = () => {
    const canvas = qrWrapRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `codigo-escuela-${code.toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <KeyRound className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Código de la escuela</p>
          <p className="text-xs text-muted-foreground">
            Compártelo con las familias que ya tienen cuenta. Al ingresarlo, quedan aquí en «Por asignar».
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando código…
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-2xl sm:text-3xl font-bold tracking-widest select-all" aria-label="Código de la escuela">
              {pretty}
            </span>
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => copy('code')}>
              {copied === 'code' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              Copiar
            </Button>
          </div>
          {typeof data?.uses_count === 'number' && data.uses_count > 0 && (
            <p className="text-xs text-muted-foreground">Usado {data.uses_count} {data.uses_count === 1 ? 'vez' : 'veces'}.</p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={waHref} target="_blank" rel="noreferrer">
                <MessageCircle className="h-4 w-4 text-emerald-600" /> WhatsApp
              </a>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => copy('link')}>
              {copied === 'link' ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />}
              Enlace
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setQrOpen(true)}>
              <QrCode className="h-4 w-4" /> QR
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setConfirmRotate(true)} disabled={rotate.isPending}>
              {rotate.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Cambiar
            </Button>
          </div>
        </>
      )}

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>QR para unirse a {schoolName}</DialogTitle>
            <DialogDescription>
              Imprímelo o compártelo. Al escanearlo, la familia entra con su cuenta y el código ya queda puesto.
            </DialogDescription>
          </DialogHeader>
          <div ref={qrWrapRef} className="flex flex-col items-center gap-3">
            <div className="bg-white p-3 rounded-xl border shadow-sm">
              {url && <QRCodeSVG value={url} size={200} level="M" />}
            </div>
            <div className="hidden" aria-hidden="true">
              {url && <QRCodeCanvas value={url} size={720} level="M" includeMargin />}
            </div>
            <p className="font-mono text-xl font-bold tracking-widest">{pretty}</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadQR}>
              <Download className="h-4 w-4" /> Descargar QR
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cambiar el código?</AlertDialogTitle>
            <AlertDialogDescription>
              El código {pretty} dejará de servir de inmediato, también en los QR impresos. Las solicitudes que ya
              llegaron siguen en «Por asignar».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => rotate.mutate()}>Sí, cambiar código</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
