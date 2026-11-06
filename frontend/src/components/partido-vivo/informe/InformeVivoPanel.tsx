import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, FileDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { buildInforme, informeToWhatsApp } from './informeModel';
import { generarInformePdf } from './informePdf';
import { useLiveMatchEnabled, useLiveReport } from './useInformeVivo';

/**
 * Botones «Copiar para WhatsApp» y «Descargar PDF» del informe en vivo.
 * No renderiza nada con el flag apagado o si el partido no se registró en vivo.
 * Nunca publica: publish_match_report sigue siendo el interruptor manual del diálogo.
 */
export function InformeVivoPanel({ matchId, informeGeneral }: { matchId: string; informeGeneral?: string | null }) {
  const { schoolId, schoolName, schoolBranding } = useSchoolContext();
  const on = useLiveMatchEnabled(schoolId);
  const q = useLiveReport(matchId, on);
  const [pdf, setPdf] = useState(false);
  if (!on || !q.data) return null;
  const modelo = buildInforme(q.data, { informeGeneral });

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(informeToWhatsApp(modelo));
      toast.success('Informe copiado. Pégalo en WhatsApp.');
    } catch { toast.error('No pudimos copiar. Inténtalo de nuevo.'); }
  };
  const descargar = async () => {
    setPdf(true);
    try {
      const blob = await generarInformePdf(modelo, {
        logoUrl: schoolBranding?.logo_url, primaryColor: schoolBranding?.branding_settings?.primary_color, schoolName,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `informe-partido-${matchId.slice(0, 8)}.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch { toast.error('No pudimos generar el PDF.'); }
    setPdf(false);
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Informe del partido en vivo</p>
      <p className="text-xs text-muted-foreground">
        Se arma con el registro del partido. El «Informe General» es el texto que escribes aquí. No se publica a las familias hasta que lo actives abajo.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copiar}><Copy className="w-4 h-4 mr-2" />Copiar para WhatsApp</Button>
        <Button type="button" variant="outline" size="sm" onClick={descargar} disabled={pdf}>
          {pdf ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileDown className="w-4 h-4 mr-2" />}Descargar PDF
        </Button>
      </div>
    </div>
  );
}
