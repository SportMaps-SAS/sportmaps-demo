import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { useTournamentAccess } from '@/lib/tournaments/tournamentAccess';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CobroTorneoFields } from '@/components/school/CobroTorneoFields';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { mediosDeCobroDeLaEscuela, validarCobroDelTorneo } from '@/lib/tournaments/mediosDeCobro';
import { ArrowLeft, Trophy, Lock } from 'lucide-react';

type Scope = 'internal' | 'external';
type Visibility = 'public' | 'invited_only' | 'school_only';
type PayerMode = 'school' | 'parent' | 'flexible';

interface FormState {
  title: string;
  sport: string;
  description: string;
  event_date: string;
  /** Último día, si el torneo dura varios días (opcional). */
  end_date: string;
  start_time: string;
  end_time: string;
  /** Nombre del coliseo o cancha (sale en la página en vivo). */
  venue_name: string;
  address: string;
  city: string;
  capacity: string;
  tournament_scope: Scope;
  visibility: Visibility;
  payer_mode: PayerMode;
  registration_deadline: string;
  /** Solo torneos internos: false = gratis, sin cobro. */
  is_paid: boolean;
  price: string;
  payment_methods: string[];
}

const INITIAL: FormState = {
  title: '',
  sport: '',
  description: '',
  event_date: '',
  end_date: '',
  start_time: '08:00',
  end_time: '',
  venue_name: '',
  address: '',
  city: '',
  capacity: '',
  tournament_scope: 'external',
  visibility: 'public',
  payer_mode: 'school',
  registration_deadline: '',
  is_paid: true,
  price: '',
  payment_methods: [],
};

const selectCls =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export default function CreateTournamentPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Un solo criterio de acceso (complemento de la escuela u organizador): lib/tournaments/tournamentAccess.ts
  const access = useTournamentAccess();
  const entLoading = access.loading;
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  // Viene del catálogo de cobros: se prellena con el cobro y, al crear, queda vinculado a él.
  const [params] = useSearchParams();
  const fromItem = params.get('from_item');
  const [itemName, setItemName] = useState<string | null>(null);
  const { schoolSettings } = useSchoolContext();
  // Solo los medios que la escuela ya tiene configurados (D4).
  const medios = mediosDeCobroDeLaEscuela(schoolSettings);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Al cambiar el alcance, sugerir visibilidad coherente.
  const onScopeChange = (scope: Scope) => {
    setForm((f) => ({
      ...f,
      tournament_scope: scope,
      visibility: scope === 'internal' ? 'school_only' : 'public',
    }));
  };

  const hasTournaments = access.allowed;

  useEffect(() => {
    if (!fromItem) return;
    (async () => {
      const { data } = await supabase.from('school_tournament_items' as any)
        .select('name, price, starts_at, capacity, description, event_id').eq('id', fromItem).maybeSingle();
      const it = data as any;
      if (!it) return;
      if (it.event_id) {
        toast({ title: 'Ese cobro ya tiene torneo', description: 'Ábrelo desde el catálogo con «Ver torneo».', variant: 'destructive' });
        navigate(`/school/tournaments/${it.event_id}`, { replace: true });
        return;
      }
      setItemName(it.name);
      const dia = it.starts_at ? new Date(it.starts_at) : null;
      const pad = (n: number) => String(n).padStart(2, '0');
      setForm((f) => ({
        ...f,
        tournament_scope: 'internal',
        visibility: 'school_only',
        title: it.name ?? f.title,
        description: it.description ?? f.description,
        capacity: it.capacity ? String(it.capacity) : f.capacity,
        event_date: dia ? `${dia.getFullYear()}-${pad(dia.getMonth() + 1)}-${pad(dia.getDate())}` : f.event_date,
        is_paid: Number(it.price) > 0,
        price: Number(it.price) > 0 ? String(Math.round(Number(it.price))) : '',
      }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromItem]);

  // ── Gate del addon ────────────────────────────────────────────────────────
  if (!entLoading && !hasTournaments) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle>Módulo de Torneos no activo</CardTitle>
            <CardDescription>
              {access.reason ?? 'Activa el módulo de Torneos para crear y gestionar tus propios torneos.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center gap-2">
            <Button variant="outline" onClick={() => navigate(-1)}>Volver</Button>
            {access.upgradeHref && <Button onClick={() => navigate(access.upgradeHref!)}>Ir a Mi Plan</Button>}
          </CardContent>
        </Card>
      </div>
    );
  }

  const validate = (): string | null => {
    if (!form.title.trim()) return 'El título es requerido.';
    if (!form.sport.trim()) return 'El deporte es requerido.';
    if (!form.event_date) return 'La fecha es requerida.';
    if (!form.start_time) return 'La hora de inicio es requerida.';
    if (form.end_date && form.end_date < form.event_date) return 'El último día no puede ser antes de la fecha de inicio.';
    if (!form.address.trim()) return 'La dirección es requerida.';
    if (!form.city.trim()) return 'La ciudad es requerida.';
    if (form.tournament_scope === 'internal') {
      return validarCobroDelTorneo({
        is_paid: form.is_paid,
        price: form.price,
        payment_methods: form.payment_methods,
        valid_until: form.registration_deadline || form.event_date,
      });
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) {
      toast({ title: 'Faltan datos', description: err, variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        title: form.title.trim(),
        sport: form.sport.trim(),
        description: form.description.trim() || null,
        event_date: form.event_date,
        start_time: form.start_time,
        end_time: form.end_time || null,
        ...(form.end_date ? { end_date: form.end_date } : {}),
        ...(form.venue_name.trim() ? { venue_name: form.venue_name.trim() } : {}),
        address: form.address.trim(),
        city: form.city.trim(),
        capacity: form.capacity ? Number(form.capacity) : undefined,
        tournament_scope: form.tournament_scope,
        visibility: form.visibility,
        payer_mode: form.payer_mode,
        registration_deadline: form.registration_deadline || null,
        // Cobro: solo torneos internos. Gratis = sin tarifa ni medios; con costo,
        // una fase de precio vigente hasta el cierre (o la fecha del torneo).
        ...(form.tournament_scope === 'internal'
          ? form.is_paid
            ? {
                is_paid: true,
                payment_methods: form.payment_methods,
                price_phases: [{
                  phase_name: 'Inscripción',
                  valid_until: form.registration_deadline || form.event_date,
                  price_solo: Number(form.price),
                }],
              }
            : { is_paid: false, payment_methods: [] }
          : {}),
      };
      const created = await bffClient.post<{ id: string }>(
        '/api/v1/events/school-tournament',
        payload,
      );
      // Desde el catálogo: el cobro queda vinculado al torneo (así no se vende suelto además).
      if (fromItem && created?.id) {
        const { error: linkError } = await supabase.from('school_tournament_items' as any)
          .update({ event_id: created.id }).eq('id', fromItem);
        if (linkError) {
          toast({ title: 'Torneo creado, pero no se pudo vincular al cobro', description: 'Vincúlalo desde el catálogo de cobros.', variant: 'destructive' });
          navigate(`/school/tournaments/${created.id}`);
          return created;
        }
      }
      toast({ title: '¡Torneo creado!', description: fromItem ? 'Se creó como borrador y quedó vinculado al cobro.' : 'Se creó como borrador.' });
      navigate(fromItem && created?.id ? `/school/tournaments/${created.id}` : `/school/tournaments`);
      return created;
    } catch (e: any) {
      toast({ title: 'Error al crear el torneo', description: e?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Volver
      </button>

      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Trophy className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Crear Torneo</h1>
          <p className="text-sm text-muted-foreground">
            Tu escuela como organizadora. Podrás agregar categorías y precios después.
          </p>
          {itemName && (
            <p className="mt-1 text-xs font-medium text-primary">
              Creando desde el cobro «{itemName}»: al guardar, queda vinculado y se inscribe en el torneo, no se vende suelto.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* Tipo de torneo */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tipo de torneo</CardTitle>
            <CardDescription>Define contra quién y quién ve el torneo.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Alcance</Label>
              <select
                className={selectCls}
                value={form.tournament_scope}
                onChange={(e) => onScopeChange(e.target.value as Scope)}
              >
                <option value="internal">Interno (mis propios equipos)</option>
                <option value="external">Externo (contra otras academias)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Visibilidad</Label>
              <select
                className={selectCls}
                value={form.visibility}
                disabled={form.tournament_scope === 'internal'}
                onChange={(e) => set('visibility', e.target.value as Visibility)}
              >
                {form.tournament_scope === 'internal' ? (
                  <option value="school_only">Solo mi escuela</option>
                ) : (
                  <>
                    <option value="public">Público (descubrible)</option>
                    <option value="invited_only">Privado (solo invitadas)</option>
                  </>
                )}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>¿Quién paga?</Label>
              <select
                className={selectCls}
                value={form.payer_mode}
                onChange={(e) => set('payer_mode', e.target.value as PayerMode)}
              >
                <option value="school">La escuela recauda</option>
                <option value="parent">Cada familia paga directo</option>
                <option value="flexible">Flexible</option>
              </select>
            </div>
          </CardContent>
        </Card>

        {/* Cobro — solo torneos internos */}
        {form.tournament_scope === 'internal' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cobro de la inscripción</CardTitle>
              <CardDescription>
                Si tiene costo, cada inscripción genera un cobro al acudiente. Si es gratis, no se cobra nada.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CobroTorneoFields
                isPaid={form.is_paid}
                onIsPaid={(v) => set('is_paid', v)}
                metodos={form.payment_methods}
                onMetodos={(m) => set('payment_methods', m)}
                medios={medios}
              />
              {form.is_paid && (
                <div className="space-y-1.5 sm:max-w-xs">
                  <Label htmlFor="price">Valor de la inscripción (COP) *</Label>
                  <Input id="price" type="number" min={1} value={form.price} onChange={(e) => set('price', e.target.value)} placeholder="50000" />
                  <p className="text-xs text-muted-foreground">
                    Vigente hasta el cierre de inscripciones (o la fecha del torneo si no hay cierre).
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Datos básicos */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Información</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="title">Título *</Label>
              <Input id="title" value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Copa Interacademias 2026" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sport">Deporte *</Label>
              <Input id="sport" value={form.sport} onChange={(e) => set('sport', e.target.value)} placeholder="Cheerleading" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="capacity">Cupo (opcional)</Label>
              <Input id="capacity" type="number" min={1} value={form.capacity} onChange={(e) => set('capacity', e.target.value)} placeholder="50" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="description">Descripción</Label>
              <Textarea id="description" value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} />
            </div>
          </CardContent>
        </Card>

        {/* Fecha y lugar */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fecha y lugar</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="event_date">Fecha *</Label>
              <Input id="event_date" type="date" value={form.event_date} onChange={(e) => set('event_date', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="end_date">Último día (si dura varios días)</Label>
              <Input id="end_date" type="date" min={form.event_date || undefined} value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="registration_deadline">Cierre de inscripciones</Label>
              <Input id="registration_deadline" type="date" value={form.registration_deadline} onChange={(e) => set('registration_deadline', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="start_time">Hora inicio *</Label>
              <Input id="start_time" type="time" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="end_time">Hora fin</Label>
              <Input id="end_time" type="time" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="venue_name">Sede (opcional)</Label>
              <Input id="venue_name" maxLength={120} value={form.venue_name} onChange={(e) => set('venue_name', e.target.value)} placeholder="Coliseo Iván de Bedout" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="address">Dirección *</Label>
              <Input id="address" value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="Coliseo, Cra 1 #1-1" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">Ciudad *</Label>
              <Input id="city" value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Bogotá" />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate(-1)} disabled={submitting}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Creando…' : 'Crear torneo'}
          </Button>
        </div>
      </div>
    </div>
  );
}
