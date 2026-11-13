import { useEffect, useState } from 'react';
import { etiquetaEstadoPago, etiquetaAsistencia } from '@/components/account-statement/estadoCuentaModel';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, FileText, AlertCircle } from 'lucide-react';
import { bffClient } from '@/lib/api/bffClient';

// Página a la que apuntan los links de email/WhatsApp de una factura SaaS
// SportMaps → escuela. La ve tanto el super_admin como el owner/admin de LA
// escuela dueña de la factura (RLS de school_subscription_invoices ya
// resuelve eso; el signed URL del PDF lo valida además el BFF).

interface InvoiceRow {
  id: string;
  invoice_number: string;
  plan_code: string;
  amount_cents: number;
  // Desde la migración 20260929183752; vacío en facturas anteriores.
  line_items?: { kind: 'plan' | 'addon' | 'one_time'; code: string; label?: string; amount_cents: number }[] | null;
  period_start: string;
  period_end: string;
  due_date: string;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  school_id: string;
}

const PLAN_NAMES: Record<string, string> = {
  starter: 'Free Start',
  start: 'Escuela Start',
  crecimiento: 'Escuela Crecimiento',
  profesional: 'Escuela Pro',
  elite: 'Escuela Elite',
  enterprise: 'Custom',
};

const ADDON_NAMES: Record<string, string> = {
  accounting: 'Contabilidad',
  invoicing: 'Facturación electrónica',
  tournaments: 'Torneos',
  store: 'Tienda escolar',
  nutrition: 'Nutrición',
  biomech: 'Biomecánica',
  access_control: 'Control de acceso',
  pwa_branding: 'PWA con tu marca',
  whitelabel: 'App nativa propia',
  whatsapp: 'WhatsApp campañas',
  wompi: 'Pasarela Wompi',
  mp: 'Pasarela MercadoPago',
};

const formatCop = (cents: number) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;
const formatDate = (d: string) => new Date(d).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });

export default function SaasInvoiceReceiptPage() {
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const [invoice, setInvoice] = useState<InvoiceRow | null>(null);
  const [schoolName, setSchoolName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingPdf, setOpeningPdf] = useState(false);

  useEffect(() => {
    if (!invoiceId) return;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('school_subscription_invoices' as any)
        .select('*, schools(name)')
        .eq('id', invoiceId)
        .maybeSingle();
      if (err || !data) {
        setError('No pudimos encontrar esta factura, o no tienes acceso a ella.');
      } else {
        setInvoice(data as any);
        setSchoolName((data as any).schools?.name || '');
      }
      setLoading(false);
    })();
  }, [invoiceId]);

  async function openPdf() {
    if (!invoiceId) return;
    setOpeningPdf(true);
    try {
      const r = await bffClient.get<{ ok: boolean; url: string }>(`/api/v1/platform/invoices/${invoiceId}/pdf-url`);
      window.open(r.url, '_blank');
    } catch (e: any) {
      setError(e?.message || 'No se pudo abrir el PDF de la factura.');
    } finally {
      setOpeningPdf(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="max-w-lg mx-auto mt-16 px-4">
        <Card>
          <CardContent className="pt-6 flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <p className="text-sm text-muted-foreground">{error || 'Factura no encontrada.'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const planName = PLAN_NAMES[invoice.plan_code] ?? invoice.plan_code;
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const lines = items.length === 0
    ? [{ label: 'Plan', value: planName, amount: null as number | null }]
    : items.map((it) => it.kind === 'plan'
      ? { label: 'Plan', value: PLAN_NAMES[it.code] ?? it.code, amount: it.amount_cents }
      : it.kind === 'one_time'
        ? { label: 'Cobro', value: it.label || (it.code === 'certificado_digital' ? 'Certificado digital (anual)' : it.code), amount: it.amount_cents }
        : { label: 'Adicional', value: ADDON_NAMES[it.code] ?? it.code, amount: it.amount_cents });
  const statusVariant =
    invoice.status === 'paid' ? 'border-emerald-500 text-emerald-600'
    : invoice.status === 'overdue' ? 'border-red-500 text-red-600'
    : invoice.status === 'cancelled' ? 'border-muted-foreground text-muted-foreground'
    : 'border-amber-500 text-amber-600';

  return (
    <div className="max-w-lg mx-auto mt-10 px-4 pb-16">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Factura SportMaps</CardTitle>
            <Badge variant="outline" className={statusVariant}>{etiquetaEstadoPago(invoice.status).label}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{invoice.invoice_number} · {schoolName}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-4 space-y-2 text-sm">
            {lines.map((l, i) => (
              <div key={i} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{l.label}</span>
                <span className="font-medium text-right">
                  {l.value}{l.amount !== null && <> · {formatCop(l.amount)}</>}
                </span>
              </div>
            ))}
            <div className="flex justify-between"><span className="text-muted-foreground">Período</span><span className="font-medium">{formatDate(invoice.period_start)} — {formatDate(invoice.period_end)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Vence</span><span className="font-medium">{formatDate(invoice.due_date)}</span></div>
            <div className="flex justify-between text-base pt-2 border-t"><span className="font-semibold">Total</span><span className="font-bold">{formatCop(invoice.amount_cents)}</span></div>
          </div>

          <Button className="w-full" onClick={openPdf} disabled={openingPdf}>
            {openingPdf ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <FileText className="h-4 w-4 mr-2" />}
            Ver / descargar PDF con cómo pagar
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            Este es un recibo interno de SportMaps, no una factura electrónica DIAN.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
