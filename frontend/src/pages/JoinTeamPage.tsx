import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/ui/phone-input';
import { Loader2, CheckCircle2, AlertCircle, UserPlus, Shield } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

/**
 * Pagina publica de auto-registro del acudiente.
 * URL: /join-team/:teamId  (el equipo del link solo da contexto/branding)
 *
 * Flujo:
 * 1. Carga info del equipo/escuela/sede via get_team_join_info
 * 2. Acudiente ingresa: email, password, nombre, telefono, documento del menor
 * 3. Buscamos el documento con buscar_menor_por_documento_publico, acotado a la
 *    ESCUELA del link. Historia de las tres versiones, porque el pendulo se
 *    paso de largo dos veces:
 *      · validate_child_for_team_join miraba solo dentro del EQUIPO del link, y
 *        con el link equivocado el acudiente recibia "no encontrado" aunque su
 *        hijo existiera; se iba al QR y chocaba con el indice unico de documento.
 *      · find_athletes_by_document lo abrio a TODAS las escuelas del pais, y
 *        como esta pagina corre sin sesion, quedo entregandole a cualquier
 *        anonimo el nombre completo y la fecha de nacimiento de un menor con
 *        solo su documento (SEG-14).
 *      · La actual exige la escuela, no devuelve fecha de nacimiento y enmascara
 *        el nombre. Sigue encontrando al chico si el link es de la escuela
 *        correcta, que era el problema original.
 * 4. supabase.auth.signUp -> claim_children_by_document -> dashboard
 *
 * Un mismo documento puede devolver VARIAS filas (el mismo chico inscrito en dos
 * clubes), por eso el acudiente elige cual/cuales son suyos.
 */

interface TeamInfo {
  team_id: string;
  team_name: string;
  school_id: string;
  school_name: string;
  branch_id: string | null;
  branch_name: string | null;
  athletes_count: number;
}

/**
 * Lo que devuelve `buscar_menor_por_documento_publico`. Es deliberadamente menos
 * que antes: esta pantalla corre SIN sesion, y la funcion vieja entregaba a
 * cualquier anonimo el nombre completo y la FECHA DE NACIMIENTO de un menor a
 * partir de su documento (SEG-14).
 *
 * `nombre` viene enmascarado («Carlos S. D.»): alcanza para que el acudiente
 * reconozca a su hijo —el escribio el documento— y no para que un extrano
 * arme una ficha. El nombre completo aparece despues del alta, con sesion.
 */
interface AthleteMatch {
  child_id: string;
  nombre: string;
  school_id: string;
  school_name: string | null;
  team_name: string | null;
  branch_name: string | null;
  already_linked: boolean;
}

export default function JoinTeamPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('+57');
  const [childDoc, setChildDoc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [matches, setMatches] = useState<AthleteMatch[]>([]);
  const [searched, setSearched] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [linkedNames, setLinkedNames] = useState<string[]>([]);
  const [success, setSuccess] = useState(false);

  const claimable = matches.filter(m => !m.already_linked);
  const blocked   = matches.filter(m => m.already_linked);

  // ── Cargar info del equipo ───────────────────────────────────────────────
  const { data: teamInfo, isLoading: loadingTeam, error: teamError } = useQuery<TeamInfo | null>({
    queryKey: ['team-join-info', teamId],
    queryFn: async () => {
      if (!teamId) return null;
      const { data, error } = await (supabase.rpc as any)('get_team_join_info', { p_team_id: teamId });
      if (error) throw error;
      return (data && data.length > 0) ? data[0] : null;
    },
    enabled: !!teamId,
  });

  // ── Buscar el documento cuando cambia (global, no por equipo) ────────────
  useEffect(() => {
    setMatches([]);
    setSelectedIds([]);
    setSearched(false);
    if (!childDoc || childDoc.replace(/[^A-Za-z0-9]/g, '').length < 5) return;
    const timer = setTimeout(async () => {
      setValidating(true);
      // `p_school_id` ahora es OBLIGATORIO del lado de la base: sin el, la
      // busqueda era global —todas las escuelas del pais— para cualquier
      // anonimo con un numero de documento.
      if (!teamInfo?.school_id) { setValidating(false); return; }
      const { data, error } = await (supabase.rpc as any)('buscar_menor_por_documento_publico', {
        p_doc_number: childDoc,
        p_school_id: teamInfo.school_id,
      });
      setValidating(false);
      setSearched(true);
      if (error) {
        toast({ title: 'No pudimos buscar el documento', description: error.message, variant: 'destructive' });
        return;
      }
      const rows = (data as AthleteMatch[]) || [];
      setMatches(rows);
      // Pre-selecciona los vinculables de ESTA escuela; si no hay ninguno de
      // esta escuela, los vinculables de cualquier otra (link equivocado).
      const free = rows.filter(r => !r.already_linked);
      const here = free.filter(r => r.school_id === teamInfo?.school_id);
      setSelectedIds((here.length > 0 ? here : free).map(r => r.child_id));
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childDoc, teamInfo?.school_id]);

  const toggleSelected = (id: string) =>
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (matches.length === 0) {
      toast({ title: 'Documento no encontrado', description: 'No encontramos ningun atleta con ese documento en SportMaps', variant: 'destructive' });
      return;
    }
    if (selectedIds.length === 0) {
      toast({
        title: blocked.length > 0 ? 'Ese atleta ya tiene acudiente' : 'Selecciona al atleta',
        description: blocked.length > 0
          ? 'Ya existe una cuenta vinculada a ese atleta. Inicia sesion con ella o pidele a la escuela que la cambie.'
          : 'Marca cual de los atletas encontrados es tuyo.',
        variant: 'destructive',
      });
      return;
    }
    if (password.length < 8) {
      toast({ title: 'Password corto', description: 'Minimo 8 caracteres', variant: 'destructive' });
      return;
    }

    setSubmitting(true);
    try {
      // 1. Registrar en auth
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName, phone, role: 'parent' },
          emailRedirectTo: `${window.location.origin}/dashboard`,
        },
      });

      if (signUpError) {
        throw new Error(signUpError.message);
      }
      if (!signUpData.user) {
        throw new Error('No se pudo crear el usuario');
      }

      // Si requiere confirmar email, igual dejamos el claim para cuando haga login
      // Pero si ya esta autenticado (auto-confirm), seguimos con el claim
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        toast({
          title: 'Revisa tu correo',
          description: 'Te enviamos un enlace para confirmar tu cuenta. Despues de confirmar, haz login e ingresa el documento del menor.',
        });
        setSuccess(true);
        return;
      }

      // 2. Vincular a los atletas elegidos (global: puede ser mas de uno y de
      //    escuelas distintas). La RPC adopta huerfanos y respeta los que ya
      //    tienen otro acudiente.
      const { data: claimData, error: claimError } = await (supabase.rpc as any)('claim_children_by_document', {
        p_doc_number: childDoc,
        p_child_ids:  selectedIds,
        p_full_name:  fullName,
        p_phone:      phone,
      });

      if (claimError) {
        throw new Error(claimError.message);
      }

      const res = (claimData || {}) as {
        matches?: number;
        claimed?: { child_id: string; full_name: string }[];
        already_mine?: { child_id: string; full_name: string }[];
        taken_by_other?: { child_id: string; full_name: string }[];
      };
      const linked = [...(res.claimed || []), ...(res.already_mine || [])];
      if (linked.length === 0) {
        if ((res.taken_by_other || []).length > 0) {
          throw new Error('Ese atleta ya esta vinculado a otra cuenta. Contacta a la escuela para que lo pasen a la tuya.');
        }
        throw new Error('No se pudo completar la vinculacion');
      }
      setLinkedNames(linked.map(l => l.full_name));

      // Refrescar la sesion para que el profile.role='parent' se cargue
      // (el trigger handle_new_user puede haber puesto otro role por default)
      try {
        await supabase.auth.refreshSession();
      } catch {
        // Si falla el refresh no es critico — lo reintentara al navegar
      }

      // Limpiar localStorage para forzar que el dashboard use el nuevo role
      localStorage.removeItem('sportmaps_active_school_id');

      setSuccess(true);
      toast({
        title: '✅ Registro completado',
        description: `${linked.map(l => l.full_name).join(', ')} vinculado a tu cuenta`,
      });

      // Usar window.location para forzar reload completo (no solo navigate SPA)
      setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message || 'No se pudo completar el registro', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadingTeam) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (teamError || !teamInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" /> Equipo no encontrado
            </CardTitle>
            <CardDescription>
              El link que usaste no corresponde a un equipo valido. Contacta a la escuela.
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
              {linkedNames.length > 0
                ? `${linkedNames.join(', ')} quedo vinculado a tu cuenta. `
                : 'Te enviamos un correo para confirmar. '}
              Te redirigimos al dashboard.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/5 to-background">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <UserPlus className="h-6 w-6 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Registro del acudiente</CardTitle>
              <CardDescription className="text-xs">
                {teamInfo.school_name}
                {teamInfo.branch_name ? ` · ${teamInfo.branch_name}` : ''}
                {' · '}
                <span className="font-semibold text-primary">{teamInfo.team_name}</span>
              </CardDescription>
            </div>
          </div>

          {/* Este link fuerza role='parent' y vincula un `children`: sirve solo para el
              acudiente de un menor. El atleta mayor de edad se registra por su cuenta. */}
          <div className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
            Este enlace es para el <strong className="text-foreground">acudiente</strong> de un atleta{' '}
            <strong className="text-foreground">menor de edad</strong> ya cargado por la escuela.
            Si eres el atleta y eres mayor de edad, pídele a la escuela tu invitación de atleta
            para registrarte tu mismo.
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">Correo electronico *</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@correo.com" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Contraseña (min 8) *</Label>
              <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="********" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="fullName">Tu nombre completo (acudiente) *</Label>
              <Input id="fullName" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Nombre del acudiente" />
            </div>

            <div className="space-y-1.5">
              <Label>WhatsApp *</Label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>

            <div className="space-y-1.5 p-3 rounded-lg bg-primary/5 border border-primary/20">
              <Label htmlFor="childDoc" className="flex items-center gap-1.5 font-semibold">
                <Shield className="h-3.5 w-3.5" /> Documento del menor a tu cargo *
              </Label>
              <Input
                id="childDoc"
                required
                value={childDoc}
                onChange={e => setChildDoc(e.target.value)}
                placeholder="Documento del menor (TI o RC)"
                className={searched ? (claimable.length > 0 ? 'border-green-500' : 'border-destructive') : ''}
              />
              <p className="text-[11px] text-muted-foreground">
                Lo buscamos en toda la app, no solo en {teamInfo.team_name}: si esta en otro
                equipo o en otra sede igual lo encontramos.
              </p>

              {validating && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Buscando...
                </p>
              )}

              {/* Un mismo documento puede aparecer en varias escuelas (mismo chico,
                  dos clubes): el acudiente marca cual/cuales son suyos. */}
              {claimable.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-xs font-medium text-green-700">
                    {claimable.length === 1 ? 'Encontramos a:' : `Encontramos ${claimable.length} atletas con ese documento:`}
                  </p>
                  {claimable.map(m => (
                    <button
                      key={m.child_id}
                      type="button"
                      onClick={() => toggleSelected(m.child_id)}
                      className={`w-full text-left rounded-md border px-2.5 py-2 transition-all ${
                        selectedIds.includes(m.child_id) ? 'border-green-500 bg-green-50' : 'border-muted hover:border-muted-foreground/40'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-semibold">
                        {selectedIds.includes(m.child_id) && <CheckCircle2 className="h-3 w-3 text-green-600" />}
                        {m.nombre}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {[m.school_name, m.team_name, m.branch_name].filter(Boolean).join(' · ')}
                        {m.school_id !== teamInfo.school_id ? ' — otra escuela' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {blocked.length > 0 && (
                <div className="text-xs text-destructive space-y-1 pt-1">
                  {blocked.map(m => (
                    <p key={m.child_id} className="flex items-start gap-1">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                      <span>
                        {m.nombre} ({[m.school_name, m.team_name].filter(Boolean).join(' · ')}) ya tiene
                        una cuenta de acudiente vinculada.
                      </span>
                    </p>
                  ))}
                  <button
                    type="button"
                    onClick={() => navigate(`/login${email ? `?email=${encodeURIComponent(email)}` : ''}`)}
                    className="font-semibold underline"
                  >
                    Iniciar sesion con esa cuenta
                  </button>
                </div>
              )}

              {searched && matches.length === 0 && !validating && (
                <p className="text-xs text-destructive flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    No encontramos ningun atleta con ese documento en SportMaps. Revisa el numero
                    o pidele a {teamInfo.school_name} que lo cargue.
                  </span>
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || selectedIds.length === 0}
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
