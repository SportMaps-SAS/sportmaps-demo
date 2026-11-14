import { useState } from 'react';
import { Share2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import type { DisplayMatch } from '@/lib/tournamentDisplay';
import { buildShareCardModel, renderShareCardPng, shareFileName, shareText } from './shareCard';

interface Props {
  match: DisplayMatch & Record<string, unknown>;
  tournament: string;
  category?: string | null;
  mvp?: string | null;
  /** Enlace a la página pública (va en el texto que acompaña la imagen). */
  url?: string;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  label?: string;
  className?: string;
}

/**
 * «Compartir resultado»: arma el PNG en el celular y abre el menú de compartir (WhatsApp, Instagram…).
 * Si el navegador no comparte archivos, descarga la imagen.
 */
export function ShareResultButton({ match, tournament, category, mvp, url, size = 'sm', variant = 'outline', label = 'Compartir', className }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      const model = buildShareCardModel(match as never, { tournament, category, mvp });
      const blob = await renderShareCardPng(model);
      const file = new File([blob], shareFileName(model), { type: 'image/png' });
      const text = shareText(model, url);
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.share && nav.canShare?.({ files: [file] })) {
        try { await nav.share({ files: [file], text, title: tournament }); } catch (e) {
          if ((e as Error)?.name !== 'AbortError') throw e;
        }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        toast({ title: 'Imagen descargada', description: 'Súbela a tu historia o envíala por WhatsApp.' });
      }
    } catch (e) {
      toast({ title: 'No pudimos crear la imagen', description: (e as Error)?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
    } finally { setBusy(false); }
  };

  return (
    <Button type="button" size={size} variant={variant} onClick={onClick} disabled={busy} className={className} aria-label={`Compartir resultado de ${tournament}`}>
      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Share2 className="mr-1 h-4 w-4" />} {label}
    </Button>
  );
}

export default ShareResultButton;
