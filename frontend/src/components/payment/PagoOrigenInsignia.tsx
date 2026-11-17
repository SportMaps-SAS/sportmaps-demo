/**
 * Insignia neutra con la procedencia del pago («Migrado del Excel» / «Sin
 * comprobante»). SOLO para pantallas del personal de la escuela: no se monta en
 * lo que ven la familia ni el deportista. Sin insignia (null) para pagos con
 * comprobante y para los que no están pagados.
 */
import { Badge } from '@/components/ui/badge';
import { origenDelPago, type OrigenDelPagoInput } from '@/lib/payments/origenDelPago';

const TEXTOS = {
  migrado_excel: {
    label: 'Migrado del Excel',
    detalle: 'Este pago se cargó desde el Excel de la escuela. No tiene comprobante en la app.',
    clase: 'bg-slate-100 text-slate-600 border-slate-300',
  },
  manual_sin_comprobante: {
    label: 'Sin comprobante',
    detalle: 'Este pago se registró como pagado sin comprobante adjunto.',
    clase: 'bg-transparent text-muted-foreground border-dashed border-slate-300',
  },
} as const;

export function PagoOrigenInsignia({ payment, className = '' }: { payment: OrigenDelPagoInput; className?: string }) {
  const origen = origenDelPago(payment);
  if (origen !== 'migrado_excel' && origen !== 'manual_sin_comprobante') return null;
  const t = TEXTOS[origen];
  return (
    <Badge
      variant="outline"
      title={t.detalle}
      data-testid={`pago-origen-${origen}`}
      className={`text-[10px] leading-tight py-0.5 whitespace-nowrap font-medium ${t.clase} ${className}`}
    >
      {t.label}
    </Badge>
  );
}
