import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Search, Loader2, Building2, Check, ShieldOff, CalendarClock, DollarSign, Receipt, Send, FileText, LayoutGrid, ShoppingBag, Plus, Pencil, X, Clock } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { toWaPhone } from '@/lib/api/payment-reminders';
import { MODULE_CATALOG, MODULE_GROUPS } from '@/config/module-catalog';

// Duraciones de prueba que se conceden a mano. El registro nuevo nace con 1 mes
// (trigger create_default_school_subscription); acá se extiende cuando se acuerda.
const MESES_PRUEBA = [1, 2, 3, 6, 12];

// Los ÚNICOS valores que v_school_entitlements sabe mapear a módulos. Cualquier
// otro deja a la escuela sin Academia y sin Reservas — por eso el selector es
// cerrado y la RPC valida contra esta misma lista.
const TIPOS_ESCUELA = [
  { value: 'academy',          label: 'Academia — solo formación' },
  { value: 'club',             label: 'Club deportivo' },
  { value: 'escuela',          label: 'Escuela deportiva' },
  { value: 'hybrid',           label: 'Híbrido — formación + reservas' },
  { value: 'venue',            label: 'Escenario — solo reservas' },
  { value: 'gimnasio',         label: 'Gimnasio — reservas + formación' },
  { value: 'personal_trainer', label: 'Entrenador personal' },
];

// Add-ons que el super-admin puede prender/apagar por escuela.
const ADDONS: { key: string; label: string; icon: string; note?: string }[] = [
  { key: 'accounting',     label: 'Contabilidad',           icon: '📊' },
  { key: 'invoicing',      label: 'Facturación electrónica', icon: '🧾', note: 'DIAN · por volumen' },
  { key: 'tournaments',    label: 'Torneos',                icon: '🏆' },
  { key: 'store',          label: 'Tienda',                 icon: '🛍️' },
  { key: 'nutrition',      label: 'Nutrición',              icon: '🥗' },
  { key: 'biomech',        label: 'Biomecánica',            icon: '📈' },
  { key: 'access_control', label: 'Control de acceso',      icon: '🔐', note: 'Hardware' },
  // ── Los DOS productos de marca. No confundirlos ──────────────────────────
  // pwa_branding = la marca se MUESTRA (manifest, iconos, login, colores) en
  //                web, Android e iOS. Se instala desde el navegador.
  // whitelabel   = ADEMAS app NATIVA propia en App Store y Play Store, y es el
  //                unico que permite ocultar el "powered by SportMaps".
  // Prender whitelabel prende tambien pwa_branding (ver toggleAddon): la
  // herencia se aplica al otorgar, nunca al leer.
  { key: 'pwa_branding',   label: 'PWA con marca propia',   icon: '📲', note: 'Se instala del navegador · incluye iOS' },
  { key: 'whitelabel',     label: 'App nativa propia',      icon: '🎨', note: 'App Store + Play Store · sin atribución' },
  { key: 'whatsapp',       label: 'WhatsApp campañas',      icon: '💬' },
  { key: 'wompi',          label: 'Pasarela Wompi',         icon: '💳' },
  { key: 'mp',             label: 'Pasarela MercadoPago',   icon: '💳' },
];

const PLANS = [
  { code: 'starter',     label: 'Free Start (gratis)' },
  { code: 'start',       label: 'Escuela Start · $69k' },
  { code: 'crecimiento', label: 'Escuela Crecimiento · $99k' },
  { code: 'profesional', label: 'Escuela Pro · $159k' },
  { code: 'elite',       label: 'Escuela Elite · $349k · todo incluido' },
  { code: 'enterprise',  label: 'Custom' },
];

type BillingCycle = 'monthly' | 'quarterly' | 'semiannual' | 'annual';

const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: 'Mensual',
  quarterly: 'Trimestral (3 meses)',
  semiannual: 'Semestral (6 meses)',
  annual: 'Anual',
};

// La facturación SaaS va siempre del 1 al 1 (mig 20261124173412): el período se
// reinicia eligiendo un MES, nunca un día. La base rechaza cualquier otro día.
const PERIODO_SIN_CAMBIO = '__sin_cambio__';

function mesesDeInicioDePeriodo(): { value: string; label: string }[] {
  const hoy = new Date();
  const meses: { value: string; label: string }[] = [];
  for (let i = -3; i <= 12; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    meses.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
      label: d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' }),
    });
  }
  return meses;
}

interface SchoolRow { id: string; name: string; city: string | null; }

interface MerchItem {
  id: string;
  name: string;
  price: number;
  size_options: string | null;
  image_url: string | null;
  active: boolean;
}

interface TournItem {
  id: string;
  name: string;
  price: number;
  active: boolean;
}

interface SaasInvoiceRow {
  id: string;
  invoice_number: string;
  plan_code: string;
  amount_cents: number;
  period_start: string;
  period_end: string;
  due_date: string;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
}

const formatCopCents = (cents: number) => `$${Math.round(cents / 100).toLocaleString('es-CO')}`;

/**
 * Segmented control de 3 posiciones para un módulo del menú. Deliberadamente
 * NO es el switch binario que usa la grilla de add-ons de arriba: con dos
 * posiciones se pierde la distinción entre "heredado" (NULL — sigue el
 * default) y "forzado OFF" (false — apagado a propósito), que es la base de
 * que F0-F2 no cambien nada hasta que alguien toque este control.
 */
function TriStateModuleControl({
  state, disabled, onChange,
}: { state: 'heredado' | 'on' | 'off'; disabled: boolean; onChange: (v: boolean | null) => void }) {
  return (
    <div className="inline-flex rounded-lg border overflow-hidden text-xs shrink-0">
      {(['heredado', 'on', 'off'] as const).map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onChange(s === 'heredado' ? null : s === 'on')}
          className={`px-2.5 py-1.5 font-medium transition-colors disabled:opacity-50 ${
            state === s
              ? s === 'off' ? 'bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground'
              : 'hover:bg-muted text-muted-foreground'
          }`}
        >
          {s === 'heredado' ? 'Heredado' : s === 'on' ? 'ON' : 'OFF'}
        </button>
      ))}
    </div>
  );
}

export default function AdminSubscriptionsPage() {
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<SchoolRow | null>(null);
  const [ent, setEnt] = useState<Record<string, any> | null>(null);
  const [loadingEnt, setLoadingEnt] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // ── Catálogo de artículos escolares — panel interno, NUNCA la escuela
  // (docs/specs/articulos-escolares-catalogo.md §9.5). Estado propio, no
  // reusa `ent`/`v_school_entitlements`: es una tabla nueva y aparte.
  const [merchEnabled, setMerchEnabled] = useState(false);
  const [merchItems, setMerchItems] = useState<MerchItem[]>([]);
  const [loadingMerch, setLoadingMerch] = useState(false);
  const [savingMerch, setSavingMerch] = useState(false);
  const [merchEditingId, setMerchEditingId] = useState<string | null>(null);
  const [merchName, setMerchName] = useState('');
  const [merchPrice, setMerchPrice] = useState('');
  const [merchSizes, setMerchSizes] = useState('');
  const [merchImageUrl, setMerchImageUrl] = useState('');
  // ── Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md) —
  // solo Dreamers hoy. Mismo patrón que merchEnabled: school_settings no
  // tiene policy de SELECT para is_super_admin(), hace falta RPC de lectura.
  const [hoursPlanEnabled, setHoursPlanEnabled] = useState(false);
  const [loadingHoursPlan, setLoadingHoursPlan] = useState(false);
  const [savingHoursPlan, setSavingHoursPlan] = useState(false);
  // ── Catálogo de torneos — mismo patrón que artículos (20260908152538): el
  // toggle de activación sigue siendo control exclusivo de este panel; el
  // CONTENIDO del catálogo (estos ítems) ya lo administra también la propia
  // escuela desde PaymentsAutomationPage. Este bloque queda como respaldo de
  // soporte, no como único lugar de edición.
  const [tournEnabled, setTournEnabled] = useState(false);
  const [tournItems, setTournItems] = useState<TournItem[]>([]);
  const [loadingTourn, setLoadingTourn] = useState(false);
  const [savingTourn, setSavingTourn] = useState(false);
  const [tournEditingId, setTournEditingId] = useState<string | null>(null);
  const [tournName, setTournName] = useState('');
  const [tournPrice, setTournPrice] = useState('');
  const [saasBillingEnabled, setSaasBillingEnabled] = useState<boolean | null>(null);
  const [saasInvoices, setSaasInvoices] = useState<SaasInvoiceRow[]>([]);
  const [loadingSaas, setLoadingSaas] = useState(false);
  const [sendingInvoiceId, setSendingInvoiceId] = useState<string | null>(null);
  const [customPriceCents, setCustomPriceCents] = useState<number | null>(null);
  // Precio mensual por addon (school_addons.monthly_price_cents). Lo encendido
  // con precio > 0 se suma a cada factura SaaS (mig 20260929183752).
  const [addonPrices, setAddonPrices] = useState<Record<string, number>>({});
  const [addonPriceDraft, setAddonPriceDraft] = useState<Record<string, string>>({});
  const [savingAddonPrice, setSavingAddonPrice] = useState<string | null>(null);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [customPriceDraft, setCustomPriceDraft] = useState('');
  const [billingCycleDraft, setBillingCycleDraft] = useState<BillingCycle>('monthly');
  const [periodStartDraft, setPeriodStartDraft] = useState('');
  const [billingEmailsDraft, setBillingEmailsDraft] = useState('');
  const [savingCustomPrice, setSavingCustomPrice] = useState(false);
  const [currentPeriod, setCurrentPeriod] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchSchools = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('admin_list_schools_global' as any, {
        p_search: debounced || null, p_verified: null, p_limit: 25, p_offset: 0,
      });
      if (error) throw error;
      const rows = ((data as any)?.rows ?? []) as any[];
      setSchools(rows.map((s) => ({ id: s.id, name: s.name, city: s.city })));
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [debounced]);

  useEffect(() => { void fetchSchools(); }, [fetchSchools]);

  async function loadEnt(schoolId: string) {
    setLoadingEnt(true);
    setEnt(null);
    const { data, error } = await supabase
      .from('v_school_entitlements' as any)
      .select('*')
      .eq('school_id', schoolId)
      .maybeSingle();
    if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
    else setEnt(data as any);
    setLoadingEnt(false);
  }

  function resetMerchForm() {
    setMerchEditingId(null);
    setMerchName('');
    setMerchPrice('');
    setMerchSizes('');
    setMerchImageUrl('');
  }

  async function loadMerch(schoolId: string) {
    setLoadingMerch(true);
    // school_settings no tiene policy de SELECT para is_super_admin() (solo
    // is_school_admin()/owner) — un select directo siempre devolvía NULL acá.
    // La RPC sortea eso sin tocar la RLS de una tabla compartida por medio repo.
    const [{ data: enabled }, { data: items, error }] = await Promise.all([
      supabase.rpc('admin_get_school_merchandise_enabled' as any, { p_school_id: schoolId }),
      supabase.from('school_merchandise_items' as any)
        .select('id, name, price, size_options, image_url, active')
        .eq('school_id', schoolId)
        .order('sort_order', { ascending: true }),
    ]);
    if (error) toast({ title: 'Error cargando el catálogo', description: error.message, variant: 'destructive' });
    setMerchEnabled(!!enabled);
    setMerchItems((items as any) || []);
    resetMerchForm();
    setLoadingMerch(false);
  }

  async function toggleMerchEnabled() {
    if (!selected) return;
    const next = !merchEnabled;
    setSavingMerch(true);
    const { error } = await supabase.rpc('admin_set_school_merchandise_enabled' as any, {
      p_school_id: selected.id, p_enabled: next,
    });
    setSavingMerch(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    setMerchEnabled(next);
    toast({ title: next ? 'Catálogo activado' : 'Catálogo desactivado', description: selected.name });
  }

  async function loadHoursPlan(schoolId: string) {
    setLoadingHoursPlan(true);
    const { data, error } = await supabase.rpc('admin_get_hours_plan_enabled' as any, { p_school_id: schoolId });
    if (error) toast({ title: 'Error cargando banco de horas', description: error.message, variant: 'destructive' });
    setHoursPlanEnabled(!!data);
    setLoadingHoursPlan(false);
  }

  async function toggleHoursPlanEnabled() {
    if (!selected) return;
    const next = !hoursPlanEnabled;
    setSavingHoursPlan(true);
    const { error } = await supabase.rpc('admin_set_hours_plan_enabled' as any, {
      p_school_id: selected.id, p_enabled: next,
    });
    setSavingHoursPlan(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    setHoursPlanEnabled(next);
    toast({ title: next ? 'Banco de horas activado' : 'Banco de horas desactivado', description: selected.name });
  }

  function startEditMerchItem(item: MerchItem) {
    setMerchEditingId(item.id);
    setMerchName(item.name);
    setMerchPrice(String(item.price));
    setMerchSizes(item.size_options || '');
    setMerchImageUrl(item.image_url || '');
  }

  async function saveMerchItem() {
    if (!selected) return;
    const name = merchName.trim();
    const price = Number(merchPrice.replace(/\./g, '').replace(/,/g, ''));
    if (!name) { toast({ title: 'Falta el nombre', variant: 'destructive' }); return; }
    if (!Number.isFinite(price) || price < 0) { toast({ title: 'Precio inválido', variant: 'destructive' }); return; }
    if (merchImageUrl.trim() && !/^https:\/\//.test(merchImageUrl.trim())) {
      toast({ title: 'La imagen debe ser una URL https://', variant: 'destructive' });
      return;
    }
    setSavingMerch(true);
    const row = {
      school_id: selected.id,
      name,
      price,
      size_options: merchSizes.trim() || null,
      image_url: merchImageUrl.trim() || null,
    };
    const { error } = merchEditingId
      ? await supabase.from('school_merchandise_items' as any).update(row).eq('id', merchEditingId)
      : await supabase.from('school_merchandise_items' as any).insert(row);
    setSavingMerch(false);
    if (error) { toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' }); return; }
    toast({ title: merchEditingId ? 'Artículo actualizado' : 'Artículo agregado', description: name });
    await loadMerch(selected.id);
  }

  async function toggleMerchItemActive(item: MerchItem) {
    if (!selected) return;
    setSavingMerch(true);
    const { error } = await supabase.from('school_merchandise_items' as any)
      .update({ active: !item.active }).eq('id', item.id);
    setSavingMerch(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    await loadMerch(selected.id);
  }

  function resetTournForm() {
    setTournEditingId(null);
    setTournName('');
    setTournPrice('');
  }

  async function loadTourn(schoolId: string) {
    setLoadingTourn(true);
    const [{ data: enabled }, { data: items, error }] = await Promise.all([
      supabase.rpc('admin_get_school_tournament_charges_enabled' as any, { p_school_id: schoolId }),
      supabase.from('school_tournament_items' as any)
        .select('id, name, price, active')
        .eq('school_id', schoolId)
        .order('sort_order', { ascending: true }),
    ]);
    if (error) toast({ title: 'Error cargando el catálogo', description: error.message, variant: 'destructive' });
    setTournEnabled(!!enabled);
    setTournItems((items as any) || []);
    resetTournForm();
    setLoadingTourn(false);
  }

  async function toggleTournEnabled() {
    if (!selected) return;
    const next = !tournEnabled;
    setSavingTourn(true);
    const { error } = await supabase.rpc('admin_set_school_tournament_charges_enabled' as any, {
      p_school_id: selected.id, p_enabled: next,
    });
    setSavingTourn(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    setTournEnabled(next);
    toast({ title: next ? 'Catálogo activado' : 'Catálogo desactivado', description: selected.name });
  }

  function startEditTournItem(item: TournItem) {
    setTournEditingId(item.id);
    setTournName(item.name);
    setTournPrice(String(item.price));
  }

  async function saveTournItem() {
    if (!selected) return;
    const name = tournName.trim();
    const price = Number(tournPrice.replace(/\./g, '').replace(/,/g, ''));
    if (!name) { toast({ title: 'Falta el nombre', variant: 'destructive' }); return; }
    if (!Number.isFinite(price) || price < 0) { toast({ title: 'Precio inválido', variant: 'destructive' }); return; }
    setSavingTourn(true);
    const row = { school_id: selected.id, name, price };
    const { error } = tournEditingId
      ? await supabase.from('school_tournament_items' as any).update(row).eq('id', tournEditingId)
      : await supabase.from('school_tournament_items' as any).insert(row);
    setSavingTourn(false);
    if (error) { toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' }); return; }
    toast({ title: tournEditingId ? 'Cobro actualizado' : 'Cobro agregado', description: name });
    await loadTourn(selected.id);
  }

  async function toggleTournItemActive(item: TournItem) {
    if (!selected) return;
    setSavingTourn(true);
    const { error } = await supabase.from('school_tournament_items' as any)
      .update({ active: !item.active }).eq('id', item.id);
    setSavingTourn(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    await loadTourn(selected.id);
  }

  async function loadSaasInvoicing(schoolId: string) {
    setLoadingSaas(true);
    const [{ data: sub }, { data: invoices }, { data: addonRows }] = await Promise.all([
      supabase.from('school_subscriptions' as any)
        .select('saas_billing_enabled, custom_price_cents, billing_cycle, current_period_start, current_period_end, billing_emails')
        .eq('school_id', schoolId).maybeSingle(),
      supabase.from('school_subscription_invoices' as any).select('*').eq('school_id', schoolId).order('period_start', { ascending: false }),
      supabase.from('school_addons' as any).select('addon_key, monthly_price_cents').eq('school_id', schoolId),
    ]);
    const prices: Record<string, number> = {};
    for (const row of ((addonRows as any[]) || [])) prices[row.addon_key] = row.monthly_price_cents ?? 0;
    setAddonPrices(prices);
    setAddonPriceDraft(Object.fromEntries(Object.entries(prices).map(([k, c]) => [k, c > 0 ? String(Math.round(c / 100)) : ''])));
    setSaasBillingEnabled((sub as any)?.saas_billing_enabled ?? false);
    setSaasInvoices((invoices as any) || []);
    const cents = (sub as any)?.custom_price_cents ?? null;
    const cycle = ((sub as any)?.billing_cycle as BillingCycle) ?? 'monthly';
    setCustomPriceCents(cents);
    setBillingCycle(cycle);
    setCustomPriceDraft(cents != null ? String(Math.round(cents / 100)) : '');
    setBillingCycleDraft(cycle);
    setPeriodStartDraft('');
    setBillingEmailsDraft((((sub as any)?.billing_emails as string[] | null) ?? []).join(', '));
    const periodStart = (sub as any)?.current_period_start ?? null;
    const periodEnd = (sub as any)?.current_period_end ?? null;
    setCurrentPeriod(periodStart && periodEnd ? { start: periodStart, end: periodEnd } : null);
    setLoadingSaas(false);
  }

  async function saveCustomPrice() {
    if (!selected) return;
    const trimmed = customPriceDraft.trim();
    const pesos = trimmed === '' ? null : Number(trimmed.replace(/\./g, '').replace(/,/g, ''));
    if (pesos !== null && (Number.isNaN(pesos) || pesos < 0)) {
      toast({ title: 'Valor inválido', description: 'Escribe un monto en pesos, sin puntos ni signos.', variant: 'destructive' });
      return;
    }
    const billingEmails = billingEmailsDraft.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);
    const invalidEmail = billingEmails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (invalidEmail) {
      toast({ title: 'Correo inválido', description: `"${invalidEmail}" no parece un correo válido.`, variant: 'destructive' });
      return;
    }
    setSavingCustomPrice(true);
    const { error } = await supabase.rpc('admin_set_school_custom_price' as any, {
      p_school_id: selected.id,
      p_custom_price_cents: pesos === null ? null : Math.round(pesos * 100),
      p_billing_cycle: billingCycleDraft,
      p_period_start: periodStartDraft || null,
      p_billing_emails: billingEmails,
    });
    setSavingCustomPrice(false);
    if (error) {
      toast({ title: 'No se pudo guardar el precio negociado', description: error.message, variant: 'destructive' });
      return;
    }
    await loadSaasInvoicing(selected.id);
    toast({
      title: pesos === null ? 'Override quitado — vuelve al precio de catálogo' : 'Precio negociado guardado',
      description: selected.name,
    });
  }

  function selectSchool(s: SchoolRow) {
    setSelected(s);
    void loadEnt(s.id);
    void loadSaasInvoicing(s.id);
    void loadMerch(s.id);
    void loadTourn(s.id);
    void loadHoursPlan(s.id);
  }

  /** Manda (o reenvía) email + push de una factura, y deja lista la ventana de WhatsApp. */
  async function sendSaasInvoice(invoiceId: string) {
    setSendingInvoiceId(invoiceId);
    try {
      const r = await bffClient.post<{ ok: boolean; whatsapp: { phone: string | null; message: string } | null }>(
        `/api/v1/platform/invoices/${invoiceId}/send`,
        {},
      );
      const waPhone = toWaPhone(r?.whatsapp?.phone);
      if (waPhone && r?.whatsapp?.message) {
        window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(r.whatsapp.message)}`, '_blank');
      }
      toast({
        title: 'Factura enviada',
        description: waPhone
          ? 'Email y notificación enviados. Se abrió WhatsApp con el mensaje listo.'
          : 'Email y notificación enviados. La escuela no tiene un celular válido para WhatsApp.',
      });
    } catch (e: any) {
      toast({ title: 'No se pudo enviar la factura', description: e?.message, variant: 'destructive' });
    } finally {
      setSendingInvoiceId(null);
    }
  }

  async function viewSaasInvoicePdf(invoiceId: string) {
    try {
      const r = await bffClient.get<{ ok: boolean; url: string }>(`/api/v1/platform/invoices/${invoiceId}/pdf-url`);
      window.open(r.url, '_blank');
    } catch (e: any) {
      toast({ title: 'No se pudo abrir el PDF', description: e?.message || 'Genera/envía la factura primero.', variant: 'destructive' });
    }
  }

  async function markSaasInvoicePaid(invoiceId: string) {
    setSendingInvoiceId(invoiceId);
    try {
      await bffClient.post(`/api/v1/platform/invoices/${invoiceId}/mark-paid`, {});
      setSaasInvoices((prev) => prev.map((i) => (i.id === invoiceId ? { ...i, status: 'paid' } : i)));
      toast({ title: 'Factura marcada como pagada' });
    } catch (e: any) {
      toast({ title: 'No se pudo marcar como pagada', description: e?.message, variant: 'destructive' });
    } finally {
      setSendingInvoiceId(null);
    }
  }

  async function toggleSaasBilling(next: boolean) {
    if (!selected) return;
    setSavingKey('__saas_billing__');
    const { data, error } = await supabase.rpc('admin_set_saas_billing_enabled' as any, {
      p_school_id: selected.id, p_enabled: next,
    });
    setSavingKey(null);
    if (error) {
      toast({ title: 'No se pudo cambiar', description: error.message, variant: 'destructive' });
      return;
    }
    setSaasBillingEnabled(next);
    const firstInvoiceId = (data as any)?.first_invoice_id as string | null;
    await loadSaasInvoicing(selected.id);
    if (firstInvoiceId) {
      toast({ title: 'Facturación SaaS activada', description: 'Generando y enviando la primera factura…' });
      await sendSaasInvoice(firstInvoiceId);
    } else {
      toast({ title: next ? 'Facturación SaaS activada' : 'Facturación SaaS desactivada', description: selected.name });
    }
  }

  async function saveAddonPrice(key: string) {
    if (!selected) return;
    const trimmed = (addonPriceDraft[key] ?? '').trim();
    const pesos = trimmed === '' ? 0 : Number(trimmed.replace(/\./g, '').replace(/,/g, ''));
    if (Number.isNaN(pesos) || pesos < 0) {
      toast({ title: 'Valor inválido', description: 'Escribe un monto en pesos, sin puntos ni signos.', variant: 'destructive' });
      return;
    }
    setSavingAddonPrice(key);
    // Mismo RPC del toggle: con el addon encendido, solo cambia el precio.
    const { error } = await supabase.rpc('admin_set_school_addon' as any, {
      p_school_id: selected.id, p_addon_key: key, p_enabled: true,
      p_monthly_price_cents: Math.round(pesos * 100),
    });
    setSavingAddonPrice(null);
    if (error) {
      toast({ title: 'No se pudo guardar el precio', description: error.message, variant: 'destructive' });
      return;
    }
    setAddonPrices((prev) => ({ ...prev, [key]: Math.round(pesos * 100) }));
    toast({
      title: pesos === 0 ? 'Adicional sin costo' : 'Precio del adicional guardado',
      description: pesos === 0 ? 'No se suma a la factura.' : `Se suma a la próxima factura: $${pesos.toLocaleString('es-CO')}/mes`,
    });
  }

  async function toggleAddon(key: string, next: boolean) {
    if (!selected) return;
    setSavingKey(key);
    const { error } = await supabase.rpc('admin_set_school_addon' as any, {
      p_school_id: selected.id, p_addon_key: key, p_enabled: next,
    });
    if (error) {
      setSavingKey(null);
      toast({ title: 'No se pudo cambiar', description: error.message, variant: 'destructive' });
      return;
    }
    setEnt((prev) => prev ? { ...prev, [`has_${key}`]: next } : prev);

    // La app nativa INCLUYE la marca del PWA. Esa herencia se aplica al
    // OTORGAR, nunca al leer: si se resolviera en una vista con un OR, todo el
    // sistema tendria dos reglas para la misma pregunta y bastaria con que una
    // quedara desincronizada para que una escuela tuviera el icono con su logo
    // y los colores de SportMaps adentro. Ya paso: un OR en la vista activo la
    // marca en 29 escuelas de golpe (migraciones 20260814104612 / 105131).
    //
    // Al apagar white-label NO se apaga pwa_branding: puede haberse vendido
    // suelto, y decidir eso no le corresponde a este toggle.
    if (key === 'whitelabel' && next) {
      const { error: errPwa } = await supabase.rpc('admin_set_school_addon' as any, {
        p_school_id: selected.id, p_addon_key: 'pwa_branding', p_enabled: true,
      });
      if (!errPwa) {
        setEnt((prev) => prev ? { ...prev, has_pwa_branding: true } : prev);
        toast({
          title: 'App propia activada',
          description: 'Se activó también "PWA con marca propia": la app nativa la incluye.',
        });
        setSavingKey(null);
        return;
      }
      toast({
        title: 'Ojo: quedó a medias',
        description: 'Se activó la app propia pero NO la marca del PWA. Prendela a mano.',
        variant: 'destructive',
      });
      setSavingKey(null);
      return;
    }

    setSavingKey(null);
    toast({ title: next ? 'Módulo activado' : 'Módulo desactivado', description: `${key} · ${selected.name}` });
  }

  /**
   * Regenera los iconos del manifest PWA desde el logo ya cargado.
   *
   * Hace falta un boton porque los iconos se generan como efecto de guardar la
   * marca: una escuela que ya tenia logo, o a la que se le prende el addon hoy,
   * se queda sin iconos y el manifest le devuelve la marca SportMaps hasta que
   * su admin entre y reguarde el logo.
   */
  async function regenerarIconosPwa() {
    if (!selected) return;
    setSavingKey('__pwa_icons__');
    try {
      const r = await bffClient.post<{ ok: boolean }>(
        `/api/v1/schools/${selected.id}/pwa-icons/regenerate`,
        {},
        { 'X-Requested-With': 'SportMaps' },
      );
      toast({
        title: r?.ok ? 'Iconos generados' : 'No se generaron',
        description: r?.ok
          ? `${selected.name} ya se instala con su marca. Ojo: quien la tenga instalada necesita reinstalar.`
          : 'Revisa que la escuela tenga logo cargado.',
        variant: r?.ok ? undefined : 'destructive',
      });
    } catch (e: any) {
      toast({
        title: 'No se pudieron generar los iconos',
        description: e?.message || 'Verifica que la escuela tenga un logo cargado.',
        variant: 'destructive',
      });
    } finally {
      setSavingKey(null);
    }
  }

  /**
   * Corre un RPC de prueba y RELEE la fuente antes de pintar.
   * El resto de esta página usa update optimista (pinta lo que pidió, no lo que
   * la BD respondió) y por eso era imposible distinguir "se guardó" de "no se
   * guardó". Acá no: si la relectura no coincide con lo pedido, se ve.
   */
  async function accionPrueba(rpc: string, params: Record<string, unknown>, ok: string) {
    if (!selected) return;
    setSavingKey(rpc);
    const { error } = await supabase.rpc(rpc as any, { p_school_id: selected.id, ...params });
    if (error) {
      setSavingKey(null);
      toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' });
      return;
    }
    await loadEnt(selected.id);   // verificado, no optimista
    setSavingKey(null);
    toast({ title: ok, description: selected.name });
  }

  async function changePlan(code: string) {
    if (!selected) return;
    setSavingKey('__plan__');
    const { error } = await supabase.rpc('admin_set_school_plan' as any, {
      p_school_id: selected.id, p_plan_code: code, p_status: 'active',
    });
    setSavingKey(null);
    if (error) { toast({ title: 'No se pudo cambiar el plan', description: error.message, variant: 'destructive' }); return; }
    setEnt((prev) => prev ? { ...prev, plan_code: code } : prev);
    toast({ title: 'Plan actualizado', description: `${code} · ${selected.name}` });
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Building2 className="h-7 w-7 text-primary" />
          Suscripciones y módulos
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Activa o desactiva planes y módulos por escuela con un switch. Cambios inmediatos (auditados).
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        {/* Lista de escuelas */}
        <Card>
          <CardHeader className="pb-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Buscar escuela…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="p-2 max-h-[70dvh] overflow-y-auto">
            {loading ? (
              <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : schools.length === 0 ? (
              <p className="text-sm text-muted-foreground p-4 text-center">Sin resultados.</p>
            ) : schools.map((s) => (
              <button
                key={s.id}
                onClick={() => selectSchool(s)}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${selected?.id === s.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
              >
                <div className="font-medium text-sm truncate">{s.name}</div>
                {s.city && <div className="text-xs text-muted-foreground">{s.city}</div>}
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Detalle de la escuela seleccionada */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {selected ? selected.name : 'Selecciona una escuela'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <p className="text-muted-foreground text-sm py-8 text-center">Elige una escuela de la izquierda para gestionar su plan y módulos.</p>
            ) : loadingEnt ? (
              <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : (
              <div className="space-y-6">
                {/* Plan */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-semibold">Plan:</span>
                  <Select value={ent?.plan_code || 'starter'} onValueChange={changePlan}>
                    <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PLANS.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {ent?.subscription_status && <Badge variant="outline">{ent.subscription_status}</Badge>}
                  {savingKey === '__plan__' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>

                {/* Periodo de prueba */}
                <div className="rounded-xl border p-4 space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <CalendarClock className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Periodo de prueba</p>
                    {ent?.is_operational === false && <Badge variant="destructive">Bloqueada</Badge>}
                    {ent?.blocking_exempt && <Badge variant="outline" className="border-amber-500 text-amber-600">Avisa sin bloquear</Badge>}
                    {ent?.account_type && ent.account_type !== 'real' && (
                      <Badge variant="secondary">{String(ent.account_type).toUpperCase()}</Badge>
                    )}
                  </div>

                  {/* Estado verificado, leído de la BD tras cada cambio */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-muted-foreground">Registro</div>
                      <div className="font-medium">
                        {ent?.school_created_at ? new Date(ent.school_created_at).toLocaleDateString('es-CO') : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Vence</div>
                      <div className="font-medium">
                        {ent?.trial_ends_at ? new Date(ent.trial_ends_at).toLocaleDateString('es-CO') : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Días restantes</div>
                      <div className="font-medium">
                        {ent?.trial_ends_at
                          ? Math.round((new Date(ent.trial_ends_at).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000)
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Meses concedidos</div>
                      <div className="font-medium">{ent?.trial_months ?? '—'}</div>
                    </div>
                  </div>

                  {/* Fijar duración contada desde la fecha de registro */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Prueba desde el registro:</span>
                    {MESES_PRUEBA.map((m) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={ent?.trial_months === m ? 'default' : 'outline'}
                        disabled={!!savingKey}
                        onClick={() => accionPrueba('admin_set_trial', { p_months: m }, `Prueba fijada en ${m} mes(es)`)}
                      >
                        {m} {m === 1 ? 'mes' : 'meses'}
                      </Button>
                    ))}
                  </div>

                  {/* Fecha exacta, para acuerdos que no caen en meses redondos */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">O fecha exacta:</span>
                    <Input
                      type="date"
                      className="w-44 h-9"
                      defaultValue={ent?.trial_ends_at ? new Date(ent.trial_ends_at).toISOString().slice(0, 10) : ''}
                      disabled={!!savingKey}
                      onChange={(e) => {
                        if (!e.target.value) return;
                        // Se fija al cierre del día elegido: si no, "vence el 20"
                        // dejaría a la escuela bloqueada desde la medianoche del 20.
                        void accionPrueba(
                          'admin_set_trial',
                          { p_months: null, p_ends_at: `${e.target.value}T23:59:00-05:00` },
                          'Fecha de vencimiento actualizada',
                        );
                      }}
                    />
                    <Button size="sm" variant="outline" disabled={!!savingKey}
                      onClick={() => accionPrueba('admin_extend_trial', { p_months: 1 }, 'Prueba extendida 1 mes')}>
                      +1 mes
                    </Button>
                    <Button size="sm" variant="outline" disabled={!!savingKey}
                      onClick={() => accionPrueba('admin_expire_trial_now', {}, 'Prueba expirada')}>
                      Expirar ya
                    </Button>
                  </div>

                  {/* Exención: avisa pero no corta (el caso Dynasty) */}
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
                    <ShieldOff className="h-4 w-4 text-amber-600" />
                    <span className="text-xs text-muted-foreground flex-1 min-w-44">
                      {ent?.blocking_exempt
                        ? `Exenta del bloqueo${ent.blocking_exempt_reason ? `: ${ent.blocking_exempt_reason}` : ''}`
                        : 'Ve el aviso y se bloquea al vencer.'}
                    </span>
                    <Button
                      size="sm"
                      variant={ent?.blocking_exempt ? 'default' : 'outline'}
                      disabled={!!savingKey}
                      onClick={() => accionPrueba(
                        'admin_set_blocking_exempt',
                        {
                          p_exempt: !ent?.blocking_exempt,
                          p_reason: ent?.blocking_exempt ? null : 'En uso real — exenta por decisión comercial',
                        },
                        ent?.blocking_exempt ? 'Exención retirada' : 'Exenta del bloqueo',
                      )}
                    >
                      {ent?.blocking_exempt ? 'Quitar exención' : 'No bloquear'}
                    </Button>
                    <Select
                      value={ent?.account_type || 'real'}
                      onValueChange={(v) => accionPrueba('admin_set_account_type', { p_account_type: v }, `Cuenta marcada como ${v}`)}
                    >
                      <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="real">Cliente real</SelectItem>
                        <SelectItem value="test">Pruebas</SelectItem>
                        <SelectItem value="demo">Demo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    Las cuentas marcadas <b>Pruebas</b> o <b>Demo</b> nunca se bloquean ni las toca el cron de expiración.
                  </p>
                </div>

                {/* Tipo de escuela — decide qué módulos ve (CAR-1b) */}
                <div className="rounded-xl border p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Tipo de escuela</p>
                    {ent?.school_type && !TIPOS_ESCUELA.some((t) => t.value === ent.school_type) && (
                      <Badge variant="destructive">Valor desconocido — sin módulos</Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Select
                      value={ent?.school_type || 'academy'}
                      onValueChange={(v) => accionPrueba('admin_set_school_type', { p_school_type: v }, `Tipo cambiado a ${v}`)}
                    >
                      <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIPOS_ESCUELA.map((t) => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* El efecto real, no el prometido: cambiar el tipo prende y
                        apaga módulos completos. */}
                    <div className="flex gap-2 text-xs">
                      <Badge variant={ent?.has_academy ? 'default' : 'outline'}>
                        Academia {ent?.has_academy ? '✓' : '✗'}
                      </Badge>
                      <Badge variant={ent?.has_reservations ? 'default' : 'outline'}>
                        Reservas {ent?.has_reservations ? '✓' : '✗'}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    Decide qué módulos ve la escuela: <b>Academia</b> y <b>Reservas</b> se derivan de
                    acá, no del plan. Un club que además quiera reservar espacios va en <b>Híbrido</b>.
                    Cambiarlo prende o apaga módulos enteros — no es una preferencia estética.
                  </p>
                </div>

                {/* Cobros a familias — interruptor maestro (CAR-2) */}
                <div className="rounded-xl border p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Cobros a familias</p>
                    {ent?.has_billing === false && (
                      <Badge variant="outline" className="border-amber-500 text-amber-600">Apagados</Badge>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    {ent?.has_billing === false
                      ? 'Esta escuela NO cobra mensualidades por SportMaps: no ve Pagos, Finanzas ni Recordatorios, y ningún cron le genera cartera ni mora. Sus cobros existentes no se borran — vuelven a verse al reactivar.'
                      : 'Cobra mensualidades por SportMaps. Apágalo para clubes que cobran por fuera (membresías propias, convenios).'}
                  </p>

                  <Button
                    size="sm"
                    variant={ent?.has_billing === false ? 'default' : 'outline'}
                    disabled={!!savingKey}
                    onClick={() => accionPrueba(
                      'admin_set_billing_enabled',
                      { p_enabled: ent?.has_billing === false },
                      ent?.has_billing === false ? 'Cobros activados' : 'Cobros desactivados',
                    )}
                  >
                    {ent?.has_billing === false ? 'Activar cobros' : 'Desactivar cobros'}
                  </Button>

                  <p className="text-[11px] text-muted-foreground">
                    Apagarlo fuerza <code>auto_generate_payments</code>, <code>late_fee_enabled</code> y{' '}
                    <code>reminder_enabled</code> a <b>false</b>, que es lo que hace que los tres crons
                    salten la escuela. No toca <b>/mi-plan</b> (lo que la escuela nos paga a nosotros).
                  </p>
                </div>

                {/* Facturación SportMaps — lo que la escuela NOS paga a nosotros */}
                <div className="rounded-xl border p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Receipt className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Facturación SportMaps</p>
                    {saasBillingEnabled && <Badge variant="outline" className="border-emerald-500 text-emerald-600">Activa</Badge>}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Recibo informal (no factura DIAN) de la mensualidad SaaS que esta escuela nos paga a
                    nosotros. Activar por primera vez genera y envía la primera factura de inmediato; de
                    ahí en adelante el ciclo sigue solo cada mes.
                  </p>

                  <Button
                    size="sm"
                    variant={saasBillingEnabled ? 'outline' : 'default'}
                    disabled={savingKey === '__saas_billing__' || loadingSaas}
                    onClick={() => toggleSaasBilling(!saasBillingEnabled)}
                  >
                    {savingKey === '__saas_billing__' ? <Loader2 className="h-4 w-4 animate-spin" /> : (
                      saasBillingEnabled ? 'Desactivar facturación' : 'Activar facturación'
                    )}
                  </Button>

                  {saasInvoices.length > 0 && (
                    <div className="space-y-2 pt-2">
                      {saasInvoices.map((inv) => (
                        <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 text-xs">
                          <div>
                            <p className="font-medium">{inv.invoice_number} · {formatCopCents(inv.amount_cents)}</p>
                            <p className="text-muted-foreground">
                              Vence {new Date(inv.due_date).toLocaleDateString('es-CO')} ·{' '}
                              <Badge
                                variant="outline"
                                className={
                                  inv.status === 'paid' ? 'border-emerald-500 text-emerald-600'
                                  : inv.status === 'overdue' ? 'border-red-500 text-red-600'
                                  : inv.status === 'cancelled' ? 'border-muted-foreground text-muted-foreground'
                                  : 'border-amber-500 text-amber-600'
                                }
                              >
                                {inv.status}
                              </Badge>
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => viewSaasInvoicePdf(inv.id)} title="Ver PDF">
                              <FileText className="h-4 w-4" />
                            </Button>
                            {inv.status !== 'cancelled' && (
                              <Button
                                size="sm" variant="ghost"
                                disabled={sendingInvoiceId === inv.id}
                                onClick={() => sendSaasInvoice(inv.id)}
                                title="Enviar / reenviar por email y WhatsApp"
                              >
                                {sendingInvoiceId === inv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                              </Button>
                            )}
                            {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                              <Button
                                size="sm" variant="ghost"
                                disabled={sendingInvoiceId === inv.id}
                                onClick={() => markSaasInvoicePaid(inv.id)}
                                title="Marcar como pagada"
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Precio negociado — override del catálogo para tratos comerciales */}
                <div className="rounded-xl border p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Precio negociado</p>
                    {customPriceCents != null && (
                      <Badge variant="outline" className="border-emerald-500 text-emerald-600">
                        {formatCopCents(customPriceCents)} · {BILLING_CYCLE_LABELS[billingCycle].toLowerCase()}
                      </Badge>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Override del precio de catálogo para esta escuela — para tratos comerciales con valor distinto
                    al de lista. Vacío = usa el precio de catálogo del plan de arriba. Con valor, la próxima factura
                    que se genere (botón "Activar/reenviar facturación") sale con este monto, no con el de catálogo.
                  </p>

                  {currentPeriod && (
                    <p className="text-xs text-muted-foreground">
                      Período vigente: <b>{new Date(currentPeriod.start).toLocaleDateString('es-CO')}</b> —{' '}
                      <b>{new Date(currentPeriod.end).toLocaleDateString('es-CO')}</b>
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground">
                    La facturación va siempre del 1 al 1. Al activarla, los días que faltan para el próximo 1 no se
                    cobran; si el trato es cobrar el mes en curso completo, elige ese mes abajo antes de activar.
                  </p>

                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Valor (COP)</label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder="Ej: 249000"
                        value={customPriceDraft}
                        onChange={(e) => setCustomPriceDraft(e.target.value)}
                        className="w-40"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Ciclo</label>
                      <Select value={billingCycleDraft} onValueChange={(v) => setBillingCycleDraft(v as BillingCycle)}>
                        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(Object.keys(BILLING_CYCLE_LABELS) as BillingCycle[]).map((c) => (
                            <SelectItem key={c} value={c}>{BILLING_CYCLE_LABELS[c]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground">Reiniciar período desde el 1 de</label>
                      <Select
                        value={periodStartDraft || PERIODO_SIN_CAMBIO}
                        onValueChange={(v) => setPeriodStartDraft(v === PERIODO_SIN_CAMBIO ? '' : v)}
                      >
                        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={PERIODO_SIN_CAMBIO}>Sin cambio</SelectItem>
                          {mesesDeInicioDePeriodo().map((m) => (
                            <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Correos adicionales de facturación</label>
                    <Input
                      type="text"
                      placeholder="contabilidad@escuela.com, alguien-mas@escuela.com"
                      value={billingEmailsDraft}
                      onChange={(e) => setBillingEmailsDraft(e.target.value)}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">
                      Se SUMAN a los admins de la escuela al enviar la factura (no los reemplazan). Separados por coma. Vacío = solo los admins, como hoy.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-2">
                    <Button size="sm" disabled={savingCustomPrice} onClick={saveCustomPrice}>
                      {savingCustomPrice ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar'}
                    </Button>
                    {customPriceCents != null && (
                      <Button
                        size="sm" variant="outline" disabled={savingCustomPrice}
                        onClick={() => { setCustomPriceDraft(''); void saveCustomPrice(); }}
                      >
                        Quitar override
                      </Button>
                    )}
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    "Reiniciar período desde" es opcional — solo úsalo si el período vigente quedó desfasado
                    (ej. arrastrado de un ciclo mensual viejo) y el trato nuevo arranca en otro mes. El fin de
                    período se calcula solo según el ciclo elegido arriba (+1, +3, +6 meses o +1 año).
                  </p>

                  <p className="text-[11px] text-muted-foreground">
                    Trimestral, semestral y anual quedan fuera del ciclo automático de renovación (por diseño —
                    hoy solo <code>monthly</code> se auto-renueva); esas facturas se generan y reenvían a mano
                    desde este panel cuando corresponda.
                  </p>
                </div>

                {/* Módulos */}
                <div>
                  <p className="text-sm font-semibold mb-3">Módulos (add-ons)</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {ADDONS.map((a) => {
                      const on = !!ent?.[`has_${a.key}`];
                      const busy = savingKey === a.key;
                      return (
                        <button
                          key={a.key}
                          onClick={() => toggleAddon(a.key, !on)}
                          disabled={busy}
                          className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${on ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/30'}`}
                        >
                          <span className="text-xl">{a.icon}</span>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm">{a.label}</div>
                            {a.note && <div className="text-[11px] text-muted-foreground">{a.note}</div>}
                          </div>
                          {/* Switch */}
                          <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                            {busy ? (
                              <Loader2 className="h-3 w-3 animate-spin text-white mx-auto" />
                            ) : (
                              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`}>
                                {on && <Check className="h-3 w-3 text-primary mx-auto mt-1" />}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Precio de los adicionales encendidos. Lo que tenga precio
                      > 0 se suma como línea aparte en cada factura SaaS; en 0
                      es "incluido" y no se cobra. */}
                  {ADDONS.some((a) => !!ent?.[`has_${a.key}`]) && (
                    <div className="mt-3 rounded-xl border p-3 space-y-2">
                      <div>
                        <div className="text-sm font-medium">Precio mensual de adicionales</div>
                        <div className="text-[11px] text-muted-foreground">
                          Se suma a la factura SportMaps de la escuela desde la próxima que se genere. Vacío o 0 = incluido, no se cobra.
                        </div>
                      </div>
                      {ADDONS.filter((a) => !!ent?.[`has_${a.key}`]).map((a) => {
                        const saved = addonPrices[a.key] ?? 0;
                        const draft = addonPriceDraft[a.key] ?? '';
                        const draftCents = draft.trim() === '' ? 0 : Math.round(Number(draft.replace(/\./g, '').replace(/,/g, '')) * 100);
                        return (
                          <div key={a.key} className="flex flex-wrap items-center gap-2">
                            <span className="text-sm flex-1 min-w-[10rem]">{a.icon} {a.label}</span>
                            <div className="flex items-center gap-1">
                              <span className="text-sm text-muted-foreground">$</span>
                              <Input
                                className="h-8 w-28"
                                inputMode="numeric"
                                placeholder="0"
                                value={draft}
                                onChange={(e) => setAddonPriceDraft((prev) => ({ ...prev, [a.key]: e.target.value }))}
                              />
                              <span className="text-[11px] text-muted-foreground">/mes</span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={savingAddonPrice === a.key || draftCents === saved}
                              onClick={() => saveAddonPrice(a.key)}
                            >
                              {savingAddonPrice === a.key ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Guardar'}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Los iconos del manifest se generan al guardar la marca. Si
                      la escuela ya tenía logo de antes, no los tiene y su app se
                      instalaría como SportMaps: este botón los crea sin que su
                      admin tenga que entrar a reguardar el logo. */}
                  {!!ent?.has_pwa_branding && (
                    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">Íconos de la app instalable</div>
                        <div className="text-[11px] text-muted-foreground">
                          Se generan desde el logo. Si la escuela ya tenía logo cargado, hay que generarlos una vez.
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!savingKey}
                        onClick={regenerarIconosPwa}
                      >
                        {savingKey === '__pwa_icons__' && <Loader2 className="h-3 w-3 animate-spin mr-2" />}
                        Generar íconos
                      </Button>
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground mt-3">
                    Prender un módulo lo activa al instante para la escuela (Modelo asistido). El cobro se gestiona aparte.
                  </p>
                </div>

                {/* Módulos del menú — override UX-only, capa independiente de los
                    add-ons de arriba. Un ítem con addon asociado (Contabilidad,
                    Control de Acceso) sigue necesitando el addon: acá solo se
                    puede apagar por encima, nunca sustituye la compra. */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <LayoutGrid className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Módulos del menú</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Oculta ítems del menú lateral para esta escuela. <b>Heredado</b> = visible
                    (o sigue al addon de arriba, si el ítem tiene uno). No reemplaza un addon:
                    forzar <b>ON</b> acá no activa un módulo que la escuela no compró.
                  </p>

                  <div className="space-y-4">
                    {MODULE_GROUPS.map((group) => {
                      const items = Object.values(MODULE_CATALOG).filter((m) => m.group === group);
                      return (
                        <div key={group}>
                          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                            {group}
                          </p>
                          <div className="space-y-1.5">
                            {items.map((def) => {
                              const raw = ent?.module_overrides?.[def.key] as boolean | undefined;
                              const state: 'heredado' | 'on' | 'off' = raw === undefined ? 'heredado' : raw ? 'on' : 'off';
                              const hasAddonRight = !def.addon || !!ent?.[`has_${def.addon}`];
                              return (
                                <div
                                  key={def.key}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm truncate">{def.label}</span>
                                    {def.addon && !hasAddonRight && (
                                      <Badge variant="outline" className="border-amber-500 text-amber-600 shrink-0">
                                        sin addon
                                      </Badge>
                                    )}
                                  </div>
                                  <TriStateModuleControl
                                    state={state}
                                    disabled={!!savingKey}
                                    onChange={(v) => accionPrueba(
                                      'admin_set_school_module',
                                      { p_module_key: def.key, p_enabled: v },
                                      v === null
                                        ? `${def.label}: vuelto a heredado`
                                        : `${def.label}: forzado ${v ? 'ON' : 'OFF'}`,
                                    )}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Valor efectivo ahora mismo — la escuela real puede tener un
                      addon apagado Y un override en heredado a la vez; esta tabla
                      resuelve la cuenta en vez de que alguien la haga a mano. */}
                  <div className="mt-4 rounded-xl border p-3">
                    <p className="text-xs font-semibold mb-2">Valor efectivo ahora mismo</p>
                    <div className="space-y-1 text-xs">
                      {Object.values(MODULE_CATALOG).map((def) => {
                        const raw = ent?.module_overrides?.[def.key] as boolean | undefined;
                        const hasAddonRight = !def.addon || !!ent?.[`has_${def.addon}`];
                        const isOn = raw !== false;
                        const effective = hasAddonRight && isOn;
                        const motivo = !hasAddonRight
                          ? 'sin addon'
                          : raw === undefined ? 'heredado' : `forzado ${raw ? 'ON' : 'OFF'}`;
                        return (
                          <div key={def.key} className="flex items-center justify-between gap-2 py-0.5">
                            <span className="text-muted-foreground">{def.label}</span>
                            <span className={effective ? 'text-emerald-600' : 'text-muted-foreground'}>
                              {effective ? '✅' : '❌'} {motivo}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Catálogo de artículos deportivos — el TOGGLE de activación sigue
                    siendo control exclusivo de este panel (nunca lo prende la
                    escuela sola, spec articulos-escolares-catalogo.md §9.5), pero
                    desde 20260908152538 el CONTENIDO del catálogo también lo edita
                    la propia escuela desde Cobros → Configuración. Este bloque
                    queda como respaldo de soporte, no como único lugar de edición.
                    No es un addon comercial: no aparece en school_addons ni en /mi-plan. */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <ShoppingBag className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Catálogo de artículos deportivos</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Guayos, uniformes, accesorios — se ofrecen al padre en el mismo pago de
                    inscripción/mensualidad, como cobro aparte. El toggle solo lo prende este
                    panel; una vez activo, la escuela también administra sus ítems.
                  </p>

                  {loadingMerch ? (
                    <div className="py-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        onClick={toggleMerchEnabled}
                        disabled={savingMerch}
                        className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${merchEnabled ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/30'}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">Vender artículos a los padres</div>
                          <div className="text-[11px] text-muted-foreground">Si está apagado, no ven la sección al pagar.</div>
                        </div>
                        <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${merchEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                          {savingMerch ? (
                            <Loader2 className="h-3 w-3 animate-spin text-white mx-auto" />
                          ) : (
                            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${merchEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}>
                              {merchEnabled && <Check className="h-3 w-3 text-primary mx-auto mt-1" />}
                            </span>
                          )}
                        </span>
                      </button>

                      {merchItems.length > 0 && (
                        <div className="space-y-1.5">
                          {merchItems.map((item) => (
                            <div key={item.id} className={`flex items-center gap-2 rounded-lg border p-2 ${!item.active ? 'opacity-50 bg-muted/30' : ''}`}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium truncate">{item.name}</span>
                                  {item.size_options && <span className="text-[11px] text-muted-foreground">{item.size_options}</span>}
                                </div>
                                <div className="text-xs text-primary font-semibold">${item.price.toLocaleString('es-CO')}</div>
                              </div>
                              <Badge variant={item.active ? 'secondary' : 'outline'} className="text-[10px] shrink-0">
                                {item.active ? 'Activo' : 'Inactivo'}
                              </Badge>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" disabled={savingMerch} onClick={() => startEditMerchItem(item)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" disabled={savingMerch} onClick={() => toggleMerchItemActive(item)}>
                                <ShieldOff className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="rounded-xl border border-dashed p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold">{merchEditingId ? 'Editar artículo' : '+ Agregar artículo'}</p>
                          {merchEditingId && (
                            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={resetMerchForm}>
                              <X className="h-3 w-3 mr-1" /> Cancelar
                            </Button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Input placeholder="Nombre (ej. Guayos)" value={merchName} onChange={(e) => setMerchName(e.target.value)} className="h-8 text-sm" />
                          <Input placeholder="Precio (COP)" inputMode="numeric" value={merchPrice} onChange={(e) => setMerchPrice(e.target.value)} className="h-8 text-sm" />
                          <Input placeholder="Tallas, ej. S, M, L (opcional)" value={merchSizes} onChange={(e) => setMerchSizes(e.target.value)} className="h-8 text-sm" />
                          <Input placeholder="Imagen https:// (opcional)" value={merchImageUrl} onChange={(e) => setMerchImageUrl(e.target.value)} className="h-8 text-sm" />
                        </div>
                        <Button size="sm" disabled={savingMerch} onClick={saveMerchItem}>
                          {savingMerch ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                          {merchEditingId ? 'Guardar cambios' : 'Agregar'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md) —
                    solo Dreamers hoy. get_or_open_hour_bank_period() (mig 20260915101557)
                    usa este flag como gate real: un plan con included_minutes_per_period
                    ya no alcanza solo para activarlo, hace falta prenderlo acá. */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Banco de horas</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Saldo por minutos vía torniquete, en vez de mensualidad fija. Piloto
                    Dreamers — no prender en otra escuela sin confirmar antes el flujo con ella.
                  </p>

                  {loadingHoursPlan ? (
                    <div className="py-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <button
                      onClick={toggleHoursPlanEnabled}
                      disabled={savingHoursPlan}
                      className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${hoursPlanEnabled ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/30'}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">Activar banco de horas</div>
                        <div className="text-[11px] text-muted-foreground">Si está apagado, un plan por horas no hace nada aunque exista.</div>
                      </div>
                      <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${hoursPlanEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                        {savingHoursPlan ? (
                          <Loader2 className="h-3 w-3 animate-spin text-white mx-auto" />
                        ) : (
                          <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${hoursPlanEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}>
                            {hoursPlanEnabled && <Check className="h-3 w-3 text-primary mx-auto mt-1" />}
                          </span>
                        )}
                      </span>
                    </button>
                  )}
                </div>

                {/* Catálogo de cobros de torneo — mismo patrón que artículos
                    (20260908152538): toggle exclusivo de este panel, contenido
                    editable también por la escuela. NO es el módulo grande de
                    Torneos por Escuela (delegaciones/brackets/resultados). */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <ShoppingBag className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">Catálogo de cobros de torneo</p>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Ej. "Torneo Interclubes — $50.000" — un cobro simple más, separado de
                    mensualidad/inscripción/artículos. El toggle solo lo prende este panel;
                    una vez activo, la escuela también administra sus ítems.
                  </p>

                  {loadingTourn ? (
                    <div className="py-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        onClick={toggleTournEnabled}
                        disabled={savingTourn}
                        className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${tournEnabled ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/30'}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">Vender cobros de torneo a los padres</div>
                          <div className="text-[11px] text-muted-foreground">Si está apagado, no ven la sección al pagar.</div>
                        </div>
                        <span className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${tournEnabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                          {savingTourn ? (
                            <Loader2 className="h-3 w-3 animate-spin text-white mx-auto" />
                          ) : (
                            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${tournEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}>
                              {tournEnabled && <Check className="h-3 w-3 text-primary mx-auto mt-1" />}
                            </span>
                          )}
                        </span>
                      </button>

                      {tournItems.length > 0 && (
                        <div className="space-y-1.5">
                          {tournItems.map((item) => (
                            <div key={item.id} className={`flex items-center gap-2 rounded-lg border p-2 ${!item.active ? 'opacity-50 bg-muted/30' : ''}`}>
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium truncate">{item.name}</span>
                                <div className="text-xs text-primary font-semibold">${item.price.toLocaleString('es-CO')}</div>
                              </div>
                              <Badge variant={item.active ? 'secondary' : 'outline'} className="text-[10px] shrink-0">
                                {item.active ? 'Activo' : 'Inactivo'}
                              </Badge>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" disabled={savingTourn} onClick={() => startEditTournItem(item)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" disabled={savingTourn} onClick={() => toggleTournItemActive(item)}>
                                <ShieldOff className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="rounded-xl border border-dashed p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold">{tournEditingId ? 'Editar cobro' : '+ Agregar cobro'}</p>
                          {tournEditingId && (
                            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={resetTournForm}>
                              <X className="h-3 w-3 mr-1" /> Cancelar
                            </Button>
                          )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Input placeholder="Nombre (ej. Torneo Interclubes)" value={tournName} onChange={(e) => setTournName(e.target.value)} className="h-8 text-sm" />
                          <Input placeholder="Precio (COP)" inputMode="numeric" value={tournPrice} onChange={(e) => setTournPrice(e.target.value)} className="h-8 text-sm" />
                        </div>
                        <Button size="sm" disabled={savingTourn} onClick={saveTournItem}>
                          {savingTourn ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                          {tournEditingId ? 'Guardar cambios' : 'Agregar'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
