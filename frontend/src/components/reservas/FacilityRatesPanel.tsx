import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { db } from './reservasHooks';
import { DEFAULT_CANCELLATION_POLICY, formatCOP, describeCancellationPolicy, type RateAudience } from './reservasApi';
import {
  EMPTY_RATE_FORM, WEEKDAY_LABELS, describeWeekdays, policyToForm, toHHmm, validatePolicy, validateRate,
  type RateForm,
} from './ratesLogic';

// facility_rates y cancellation_policies todavía no están en types.ts → filas tipadas aquí.
interface FacilityRateRow {
  id: string;
  school_id: string;
  facility_id: string;
  audience: RateAudience;
  weekdays: number[] | null;
  from_time: string;
  to_time: string;
  price_per_hour: number;
  priority: number | null;
  label: string | null;
}

interface PolicyRow {
  id: string;
  school_id: string;
  facility_id: string | null;
  hours_full_refund: number;
  hours_partial_refund: number;
  partial_pct: number;
  is_active: boolean;
}

interface FacilityLite { id: string; name: string }

const SCHOOL_SCOPE = '__school__';

export function FacilityRatesPanel({ facilities }: { facilities: FacilityLite[] }) {
  return (
    <div className="space-y-8">
      <RatesSection facilities={facilities} />
      <PolicySection facilities={facilities} />
    </div>
  );
}

// ─── Tarifas ──────────────────────────────────────────────────────────────────

function RatesSection({ facilities }: { facilities: FacilityLite[] }) {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState<string>(facilities[0]?.id ?? '');
  const [editing, setEditing] = useState<FacilityRateRow | 'new' | null>(null);
  const [form, setForm] = useState<RateForm>(EMPTY_RATE_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const key = ['facility-rates', schoolId, facilityId];
  const { data: rates = [], isLoading, error } = useQuery({
    queryKey: key,
    enabled: !!schoolId && !!facilityId,
    queryFn: async (): Promise<FacilityRateRow[]> => {
      const { data, error: e } = await db
        .from('facility_rates')
        .select('*')
        .eq('school_id', schoolId)
        .eq('facility_id', facilityId)
        .order('audience')
        .order('priority', { ascending: false });
      if (e) throw e;
      return (data ?? []) as FacilityRateRow[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const row = {
        audience: form.audience,
        weekdays: [...form.weekdays].sort((a, b) => a - b),
        from_time: form.from_time,
        to_time: form.to_time,
        price_per_hour: parseInt(form.price_per_hour, 10),
      };
      if (editing && editing !== 'new') {
        const { error: e } = await db.from('facility_rates').update(row).eq('id', editing.id);
        if (e) throw e;
      } else {
        const { error: e } = await db.from('facility_rates').insert({ ...row, school_id: schoolId, facility_id: facilityId });
        if (e) throw e;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
      toast({ title: '✅ Tarifa guardada' });
      setEditing(null);
    },
    onError: (e: any) => setFormError(e?.message ?? 'No se pudo guardar la tarifa.'),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error: e } = await db.from('facility_rates').delete().eq('id', id);
      if (e) throw e;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
      toast({ title: 'Tarifa eliminada' });
    },
    onError: (e: any) => toast({ title: 'No se pudo eliminar', description: e?.message, variant: 'destructive' }),
  });

  const openNew = () => {
    setForm(EMPTY_RATE_FORM);
    setFormError(null);
    setEditing('new');
  };
  const openEdit = (r: FacilityRateRow) => {
    setForm({
      audience: r.audience,
      weekdays: r.weekdays ?? [],
      from_time: toHHmm(r.from_time),
      to_time: toHHmm(r.to_time),
      price_per_hour: String(Math.round(Number(r.price_per_hour))),
    });
    setFormError(null);
    setEditing(r);
  };
  const submit = () => {
    const msg = validateRate(form);
    setFormError(msg);
    if (!msg) save.mutate();
  };
  const toggleDay = (d: number) =>
    setForm((f) => ({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] }));

  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">Tarifas por franja</h2>
          <p className="text-sm text-muted-foreground">
            Precio por hora según audiencia (Público o Socio), días y horario. Si una instalación no tiene tarifas, se usa su «Tarifa por hora».
            Los festivos se cobran como domingo.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger className="w-56" aria-label="Instalación"><SelectValue placeholder="Instalación" /></SelectTrigger>
            <SelectContent>
              {facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button onClick={openNew} disabled={!facilityId}><Plus className="mr-1 h-4 w-4" /> Nueva tarifa</Button>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          No se pudieron leer las tarifas (puede que la función de tarifas aún no esté activa en tu escuela).
        </p>
      ) : isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : rates.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Esta instalación no tiene tarifas por franja todavía.</p>
      ) : (
        <ul className="divide-y divide-border/40 rounded-lg border border-border/40">
          {rates.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={r.audience === 'member' ? 'secondary' : 'default'}>{r.audience === 'member' ? 'Socio' : 'Público'}</Badge>
                  <span className="font-bold">{formatCOP(Number(r.price_per_hour))}/hora</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {describeWeekdays(r.weekdays)} · {toHHmm(r.from_time)} – {toHHmm(r.to_time)}
                </p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" aria-label="Editar tarifa" onClick={() => openEdit(r)}><Pencil className="h-4 w-4" /></Button>
                <Button variant="ghost" size="icon" aria-label="Eliminar tarifa" className="text-destructive" onClick={() => remove.mutate(r.id)} disabled={remove.isPending}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'Nueva tarifa' : 'Editar tarifa'}</DialogTitle>
            <DialogDescription>Cuando varias tarifas coinciden, gana la de mayor prioridad.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Audiencia</Label>
              <Select value={form.audience} onValueChange={(v) => setForm((f) => ({ ...f, audience: v as RateAudience }))}>
                <SelectTrigger aria-label="Audiencia"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Público</SelectItem>
                  <SelectItem value="member">Socio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Días</Label>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((label, d) => (
                  <Button key={d} type="button" size="sm" variant={form.weekdays.includes(d) ? 'default' : 'outline'} onClick={() => toggleDay(d)} aria-pressed={form.weekdays.includes(d)}>
                    {label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="rate_from">Desde</Label>
                <Input id="rate_from" type="time" value={form.from_time} onChange={(e) => setForm((f) => ({ ...f, from_time: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rate_to">Hasta</Label>
                <Input id="rate_to" type="time" value={form.to_time} onChange={(e) => setForm((f) => ({ ...f, to_time: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rate_price">Precio por hora (COP)</Label>
              <Input id="rate_price" inputMode="numeric" placeholder="Ej: 120000" value={form.price_per_hour} onChange={(e) => setForm((f) => ({ ...f, price_per_hour: e.target.value.replace(/[^\d]/g, '') }))} />
            </div>
            {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Política de cancelación ──────────────────────────────────────────────────

function PolicySection({ facilities }: { facilities: FacilityLite[] }) {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<string>(SCHOOL_SCOPE);
  const [values, setValues] = useState(policyToForm(DEFAULT_CANCELLATION_POLICY));
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const facilityIdForScope = scope === SCHOOL_SCOPE ? null : scope;
  const key = ['cancellation-policy-row', schoolId, scope];

  const { data: row, isLoading, error } = useQuery({
    queryKey: key,
    enabled: !!schoolId,
    queryFn: async (): Promise<PolicyRow | null> => {
      let q = db.from('cancellation_policies').select('*').eq('school_id', schoolId);
      q = facilityIdForScope ? q.eq('facility_id', facilityIdForScope) : q.is('facility_id', null);
      const { data, error: e } = await q.limit(1);
      if (e) throw e;
      const r = (data?.[0] ?? null) as PolicyRow | null;
      return r;
    },
  });

  // Carga los valores del formulario cuando llega la fila del alcance elegido (una vez por alcance).
  if (!isLoading && !error && loadedFor !== scope) {
    setLoadedFor(scope);
    setValues(
      row
        ? policyToForm({
            hours_full_refund: Number(row.hours_full_refund),
            hours_partial_refund: Number(row.hours_partial_refund),
            partial_pct: Number(row.partial_pct),
          })
        : policyToForm(DEFAULT_CANCELLATION_POLICY),
    );
    setFormError(null);
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        hours_full_refund: Number(values.hours_full_refund),
        hours_partial_refund: Number(values.hours_partial_refund),
        partial_pct: Number(values.partial_pct),
        is_active: true,
      };
      if (row) {
        const { error: e } = await db.from('cancellation_policies').update(payload).eq('id', row.id);
        if (e) throw e;
      } else {
        const { error: e } = await db
          .from('cancellation_policies')
          .insert({ ...payload, school_id: schoolId, facility_id: facilityIdForScope });
        if (e) throw e;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ['reservas-cancellation-policy'] });
      toast({ title: '✅ Política guardada' });
    },
    onError: (e: any) => setFormError(e?.message ?? 'No se pudo guardar la política.'),
  });

  const submit = () => {
    const msg = validatePolicy(values);
    setFormError(msg);
    if (!msg) save.mutate();
  };

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value.replace(/[^\d]/g, '') }));

  const preview = validatePolicy(values)
    ? null
    : describeCancellationPolicy({
        hours_full_refund: Number(values.hours_full_refund),
        hours_partial_refund: Number(values.hours_partial_refund),
        partial_pct: Number(values.partial_pct),
      });

  return (
    <Card className="space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">Política de cancelación</h2>
          <p className="text-sm text-muted-foreground">
            Define cuánto se devuelve según la anticipación con que cancela quien reservó. Si cancela la escuela, siempre se devuelve el 100 %.
            Sin política guardada se usa 24 h / 6 h / 50 %.
          </p>
        </div>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="w-60" aria-label="Alcance de la política"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={SCHOOL_SCOPE}>Toda la escuela</SelectItem>
            {facilities.map((f) => <SelectItem key={f.id} value={f.id}>Solo {f.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          No se pudo leer la política (puede que la función aún no esté activa en tu escuela).
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="pol_full">Horas para devolución total (100 %)</Label>
              <Input id="pol_full" inputMode="numeric" value={values.hours_full_refund} onChange={set('hours_full_refund')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pol_partial">Horas para devolución parcial</Label>
              <Input id="pol_partial" inputMode="numeric" value={values.hours_partial_refund} onChange={set('hours_partial_refund')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pol_pct">% de la devolución parcial</Label>
              <Input id="pol_pct" inputMode="numeric" value={values.partial_pct} onChange={set('partial_pct')} />
            </div>
          </div>
          {preview && <p className="text-xs text-muted-foreground">{preview}</p>}
          {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
          <div className="flex justify-end">
            <Button onClick={submit} disabled={save.isPending || isLoading}>{save.isPending ? 'Guardando…' : 'Guardar política'}</Button>
          </div>
        </>
      )}
    </Card>
  );
}
