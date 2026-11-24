import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/phone-input';
import { Loader2, CheckCircle2, AlertCircle, UserPlus, Shield } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatFriendlyDuration } from '@/lib/utils';

/**
 * Pagina publica de auto-registro por plan (offering_plan).
 * URL: /join-plan/:planId
 *
 * Espejo de JoinTeamPage pero usando offering_plans + enrollments.offering_plan_id.
 * Sirve para atletas (adultos) y padres: ambos ingresan el CC del atleta y,
 * si ese atleta tiene un enrollment activo a este plan, se vinculan.
 */

interface PlanInfo {
  plan_id: string;
  plan_name: string;
  offering_id: string;
  offering_name: string;
  school_id: string;
  school_name: string;
  branch_id: string | null;
  branch_name: string | null;
  plan_price: number | null;
  plan_currency: string | null;
  duration_days: number | null;
  max_sessions: number | null;
  athletes_count: number;
}

interface ValidationResult {
  child_id: string;
  full_name: string;
  already_linked: boolean;
}

type RegistrantKind = 'parent' | 'athlete';

export default function JoinPlanPage() {
  const { planId } = useParams<{ planId: string }>();
  const { toast } = useToast();

  const [registrantKind, setRegistrantKind] = useState<RegistrantKind>('parent');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('+57');
  const [docNumber, setDocNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [success, setSuccess] = useState(false);

  // ── Cargar info del plan ──────────────────────────────────────────────────
  const { data: planInfo, isLoading: loadingPlan, error: planError } = useQuery<PlanInfo | null>({
    queryKey: ['plan-join-info', planId],
    queryFn: async () => {
      if (!planId) return null;
      const { data, error } = await (supabase.rpc as any)('get_plan_join_info', { p_plan_id: planId });
      if (error) throw error;
      return (data && data.length > 0) ? data[0] : null;
    },
    enabled: !!planId,
  });

  // ── Validar documento cuando cambia ───────────────────────────────────────
  useEffect(() => {
    setValidation(null);
    if (!docNumber || !planId || docNumber.replace(/\D/g, '').length < 5) return;
    const timer = setTimeout(async () => {
      setValidating(true);
      const { data, error } = await (supabase.rpc as any)('validate_doc_for_plan_join', {
        p_plan_id: planId,
        p_doc_number: docNumber,
      });
      setValidating(false);
      if (!error && data && data.length > 0) {
        setValidation(data[0] as ValidationResult);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [docNumber, planId]);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validation) {
      toast({ title: 'Documento invalido', description: 'No encontramos un atleta con ese CC inscrito en este plan.', variant: 'destructive' });
      return;
    }
    if (validation.already_linked) {
      toast({ title: 'Ya vinculado', description: 'Este atleta ya tiene una cuenta asociada. Inicia sesion.', variant: 'destructive' });
      return;
    }
    if (password.length < 8) {
      toast({ title: 'Password corto', description: 'Minimo 8 caracteres', variant: 'destructive' });
      return;
    }

    setSubmitting(true);
    try {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, phone, role: registrantKind },
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });

      if (signUpError) throw new Error(signUpError.message);
      if (!signUpData.user) throw new Error('No se pudo crear el usuario');

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        toast({
          title: 'Revisa tu correo',
          description: 'Te enviamos un enlace para confirmar tu cuenta. Despues de confirmar, haz login.',
        });
        setSuccess(true);
        return;
      }

      const { data: claimData, error: claimError } = await (supabase.rpc as any)('claim_member_for_plan', {
        p_child_id:  validation.child_id,
        p_plan_id:   planId,
        p_role:      registrantKind,
        p_full_name: fullName,
        p_phone:     phone,
      });
      if (claimError) throw new Error(claimError.message);

      const status = Array.isArray(claimData) && claimData.length > 0 ? claimData[0].status_code : null;
      if (status === 'already_linked') throw new Error('Este atleta ya esta vinculado a otra cuenta. Contacta a la escuela.');
      if (status === 'not_found')      throw new Error('Atleta no encontrado o sin enrollment al plan.');
      if (status === 'no_auth')        throw new Error('Sesion no valida. Vuelve a iniciar sesion.');
      if (status === 'invalid_role')   throw new Error('Rol no valido.');
      if (status !== 'ok')             throw new Error('No se pudo completar la vinculacion.');

      try { await supabase.auth.refreshSession(); } catch { /* no-op */ }
      localStorage.removeItem('sportmaps_active_school_id');

      setSuccess(true);
      toast({ title: '✅ Registro completado', description: `${validation.full_name} vinculado a tu cuenta.` });
      setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'No se pudo completar el registro', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingPlan) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (planError || !planInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" /> Plan no encontrado
            </CardTitle>
            <CardDescription>
              El link que usaste no corresponde a un plan valido o el plan ya no esta activo. Contacta a la escuela.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="h-5 w-5" /> ¡Listo!
            </CardTitle>
            <CardDescription>
              {validation
                ? `${validation.full_name} quedo vinculado a tu cuenta. Te redirigimos al dashboard.`
                : 'Te enviamos un correo para confirmar tu cuenta.'}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const formatPrice = (val: number | null, ccy: string | null) => {
    if (val == null) return '';
    try {
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency: ccy || 'COP', minimumFractionDigits: 0 }).format(val);
    } catch {
      return `${val} ${ccy || ''}`;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/5 to-background">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <UserPlus className="h-6 w-6 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Registro al plan</CardTitle>
              <CardDescription className="text-xs">
                {planInfo.school_name}
                {planInfo.branch_name ? ` · ${planInfo.branch_name}` : ''}
                {' · '}
                <span className="font-semibold text-primary">{planInfo.plan_name}</span>
              </CardDescription>
            </div>
          </div>

          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Servicio:</span>
              <span className="font-medium">{planInfo.offering_name}</span>
            </div>
            {planInfo.plan_price != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Precio:</span>
                <span className="font-medium">{formatPrice(planInfo.plan_price, planInfo.plan_currency)}</span>
              </div>
            )}
            {planInfo.max_sessions != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sesiones:</span>
                <span className="font-medium">{planInfo.max_sessions}</span>
              </div>
            )}
            {planInfo.duration_days != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Duracion:</span>
                <span className="font-medium">{formatFriendlyDuration(planInfo.duration_days)}</span>
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">¿Quien crea esta cuenta?</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={registrantKind === 'parent' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRegistrantKind('parent')}
                  className="text-xs h-auto py-2 leading-tight"
                >
                  Soy el acudiente<br /><span className="font-normal opacity-80">del atleta menor de edad</span>
                </Button>
                <Button
                  type="button"
                  variant={registrantKind === 'athlete' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setRegistrantKind('athlete')}
                  className="text-xs h-auto py-2 leading-tight"
                >
                  Soy el atleta<br /><span className="font-normal opacity-80">y soy mayor de edad</span>
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {registrantKind === 'parent'
                  ? 'La cuenta queda a tu nombre como responsable del pago; el atleta menor queda a tu cargo.'
                  : 'La cuenta queda a tu nombre como atleta: pagas y ves tu plan tu mismo, sin acudiente.'}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Correo electronico *</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@correo.com" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña (min 8) *</Label>
              <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="********" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fullName">
                {registrantKind === 'parent' ? 'Tu nombre completo (acudiente) *' : 'Tu nombre completo (atleta) *'}
              </Label>
              <Input
                id="fullName"
                required
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                placeholder={registrantKind === 'parent' ? 'Nombre del acudiente' : 'Tu nombre'}
              />
            </div>

            <div className="space-y-1.5">
              <Label>WhatsApp *</Label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>

            <div className="space-y-1.5 p-3 rounded-lg bg-primary/5 border border-primary/20">
              <Label htmlFor="docNumber" className="flex items-center gap-1.5 font-semibold">
                <Shield className="h-3.5 w-3.5" />
                {registrantKind === 'parent' ? 'Documento del menor a tu cargo *' : 'Tu documento (atleta) *'}
              </Label>
              <Input
                id="docNumber"
                required
                value={docNumber}
                onChange={e => setDocNumber(e.target.value)}
                placeholder={registrantKind === 'parent' ? 'Documento del menor (TI o RC)' : 'Tu documento (CC)'}
                className={validation ? (validation.already_linked ? 'border-destructive' : 'border-green-500') : ''}
              />
              {validating && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Validando...
                </p>
              )}
              {validation && !validation.already_linked && (
                <p className="text-xs text-green-600 flex items-center gap-1 font-medium">
                  <CheckCircle2 className="h-3 w-3" /> {validation.full_name}
                </p>
              )}
              {validation && validation.already_linked && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Este atleta ya tiene una cuenta vinculada
                </p>
              )}
              {docNumber.length >= 5 && !validating && !validation && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {registrantKind === 'parent'
                    ? 'No encontramos un menor con ese documento en este plan'
                    : 'No encontramos un atleta con ese documento en este plan'}
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !validation || validation.already_linked}
            >
              {submitting ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Registrando...</>
              ) : (
                'Completar registro'
              )}
            </Button>

            <p className="text-xs text-muted-foreground text-center">
              Al registrarte aceptas los terminos y la politica de privacidad de SportMaps.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
