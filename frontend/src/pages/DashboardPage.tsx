import { useAuth } from '@/contexts/AuthContext';
import { useNavigate, useSearchParams, Navigate } from 'react-router-dom';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { StatCard } from '@/components/dashboard/StatCard';
import { ActivityList } from '@/components/dashboard/ActivityList';
import { QuickActions } from '@/components/dashboard/QuickActions';
import { QuickActionsEditDialog } from '@/components/dashboard/QuickActionsEditDialog';
import { useSettings } from '@/hooks/useSettings';
import { NotificationList } from '@/components/dashboard/NotificationList';
import { WelcomeMessage } from '@/components/dashboard/WelcomeMessage';
import { PendingEnrollmentModal } from '@/components/dashboard/PendingEnrollmentModal';
import { useDashboardConfig } from '@/hooks/useDashboardConfig';
import { useNotifications, useDashboardStats } from '@/hooks/useDashboardStats';
import { useDashboardStatsReal } from '@/hooks/useDashboardStatsReal'; // Import the new hook
import { UserRole, OnboardingStep } from '@/types/dashboard';
import { Plus, MapPin, Zap, CalendarCheck, ChevronRight, CreditCard, Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { DashboardChecklist } from '@/components/dashboard/DashboardChecklist';
import { InvitationBanner } from '@/components/dashboard/InvitationBanner';
import { CoachProfileWizard } from '@/components/coach/CoachProfileWizard';
import { SchoolOnboardingWizard } from '@/components/onboarding/SchoolOnboardingWizard';
import { ActivateStoreCTA } from '@/components/vendor/ActivateStoreCTA';
import { OpenTournamentsCard } from '@/components/dashboard/OpenTournamentsCard';
import { SchoolTournamentsHomeCard } from '@/components/dashboard/SchoolTournamentsHomeCard';
import { supabase } from '@/integrations/supabase/client';
import { getStepsForRole } from '@/lib/onboarding/getStepsForRole';
import { acceptPendingInvitations } from '@/lib/invitations/acceptPendingInvitations';
import { ParentHomeV2 } from '@/components/parent/v2/ParentHomeV2';
import { usaInicioAcudienteV2 } from '@/components/parent/v2/parentHomeLogic';
import { ACUDIENTE_V2, DEPORTISTA_V2, ENTRENADOR_V2 } from '@/lib/feature-flags';
import { CoachHomeV2 } from '@/components/coach/v2/CoachHomeV2';
import { AthleteHomeV2 } from '@/components/athlete/v2/AthleteHomeV2';
import { useRolActivo } from '@/hooks/useRolActivo';
import { resolveOnboardingGateStatus } from '@/lib/onboardingGate';
import { JoinSchoolCodeBanner } from '@/components/school-join/JoinSchoolCodeBanner';

/**
 * Dueño de espacios (facility_manager, escuela school_type 'venue'): su Inicio
 * es /venue/dashboard. Va en un envoltorio y no como return temprano dentro del
 * componente de abajo: ese corre una veintena de hooks de escuela (stats,
 * onboarding, acciones rápidas) que no le corresponden y que, con un rol
 * ausente de sus tablas, no están pensados para este perfil.
 */
export default function DashboardPage() {
  const { profile } = useAuth();
  // UserProfile.role (AuthContext) aún no lista facility_manager: se compara como string.
  if ((profile?.role as string | undefined) === 'facility_manager') {
    return <Navigate to="/venue/dashboard" replace />;
  }
  return <SchoolRoleDashboardPage />;
}

function SchoolRoleDashboardPage() {
  const { profile, user, realRole } = useAuth();
  const { toast } = useToast();
  const { activeBranchId, activeBranchName, totalBranches } = useSchoolContext();
  const rolActivo = useRolActivo();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const pendingInviteId = localStorage.getItem('pending_invite_id');
  const inviteUrlId = searchParams.get('invite');
  const [invitation, setInvitation] = useState<any | null>(null); // Keep any for polymorphic invitation data for now, but remove explicit any when possible
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStep[]>([]);
  const [onboardingStatus, setOnboardingStatus] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [showCoachWizard, setShowCoachWizard] = useState(false);
  const [rpcStatus, setRpcStatus] = useState<any>(null);
  // Fallback directo si el RPC falla o tarda — query bruta a schools por owner.
  const [fallbackSchool, setFallbackSchool] = useState<{ id: string; onboarding_status: string; business_model?: string } | null>(null);
  const hasAutoOpenedRef = useRef(false);

  // Fallback: si el rol del profile indica escuela, consulta directa a schools.
  // Garantiza que el wizard aparezca aunque get_onboarding_status() rompa.
  useEffect(() => {
    const isSchoolRole = ['school', 'school_admin', 'admin', 'owner', 'super_admin']
      .includes(profile?.role as string);
    if (!isSchoolRole || !user?.id) return;

    (async () => {
      const { data, error } = await supabase
        .from('schools')
        .select('id, onboarding_status, business_model')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.warn('[Dashboard] fallback schools query falló:', error);
        return;
      }
      if (data) setFallbackSchool(data);
    })();
  }, [profile?.role, user?.id]);

  // Get real stats from NEW hook (Multitenant aware)
  const { stats: realStats, loading: realStatsLoading } = useDashboardStatsReal();

  // Unify stats: only use generic stats hook for non-school/coach roles
  const isMultitenantRole = profile?.role === 'school' || (profile?.role as string) === 'school_admin' || profile?.role === 'coach' || profile?.role === 'parent';
  const { data: statsData } = useDashboardStats(isMultitenantRole ? undefined : ((profile?.role as UserRole) || 'athlete'));

  // Usar la misma lógica que AppSidebar para definir el navigationRole
  let dashboardRole: UserRole = (profile?.role as UserRole) || 'athlete';

  const role = profile?.role as unknown as string;

  if (role === 'owner' || role === 'super_admin') {
    // Owners siempre operan a nivel de sede
    dashboardRole = 'school';
  } else if (role === 'school_admin') {
    dashboardRole = 'school_admin';
  } else if (role === 'school') {
    dashboardRole = 'school';
  } else if (role === 'staff') {
    dashboardRole = 'coach';
  }

  const isSchoolDashboard = dashboardRole === 'school' || dashboardRole === 'school_admin';

  // Acciones Rápidas personalizables — solo escuela/school_admin (ver plan).
  // `useSettings` ya trae `profiles.preferences` completo, no hace falta un
  // fetch aparte solo para esto.
  const { data: settingsData, updateDashboardPreferences, saving: savingSettings } = useSettings();
  const savedQuickActionIds: string[] | undefined = isSchoolDashboard
    ? (settingsData?.profile?.preferences?.dashboard_quick_actions as string[] | undefined)
    : undefined;
  const [showQuickActionsEdit, setShowQuickActionsEdit] = useState(false);

  // For multitenant roles, we pass empty stats to config so cards show 0/loading instead of different demo data
  const config = useDashboardConfig(
    dashboardRole,
    isMultitenantRole ? undefined : statsData,
    savedQuickActionIds
  );
  const { data: notifications } = useNotifications();

  const refreshOnboardingData = useCallback(async () => {
    if (!profile || !user) return;

    try {
      // Prioridad: 1. URL (?invite=...)  2. localStorage (pending_invite_id)
      const targetInviteId = inviteUrlId || pendingInviteId;
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      // Limpiar si el valor guardado no es un UUID válido
      if (targetInviteId && !UUID_REGEX.test(targetInviteId)) {
        localStorage.removeItem('pending_invite_id');
      }

      if (targetInviteId && UUID_REGEX.test(targetInviteId)) {
        console.log('Intentando auto-aceptar invitación:', targetInviteId);
        const { error: acceptError } = await (supabase.rpc as any)('accept_invitation_pro', {
          p_invite_id: targetInviteId
        });

        if (!acceptError) {
          console.log('Invitación aceptada con éxito');
          // Solo limpiar si tuvo éxito
          localStorage.removeItem('pending_invite_id');
          toast({
            title: '¡Invitación aceptada!',
            description: 'Te hemos vinculado correctamente con la academia.',
          });

          // Limpiar el parámetro de la URL sin recargar para mantener fluidez
          if (inviteUrlId) {
            const newUrl = window.location.pathname;
            window.history.replaceState({}, '', newUrl);
          }

          // RECargar para asegurar que los nuevos permisos (role en profiles) se apliquen
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } else {
          console.error('Error al aceptar invitación:', acceptError);
          // Siempre limpiar para evitar bucles de reintento
          localStorage.removeItem('pending_invite_id');
        }
      }

      // Adoptar hijos pre-cargados por la escuela cuyo parent_email_temp coincide
      // con este correo (aunque la aceptación de invitación haya fallado). Evita
      // que el acudiente no vea a su hijo pre-registrado y lo cree duplicado.
      try {
        await (supabase.rpc as any)('claim_orphan_children', { p_school_id: null });
      } catch (e) {
        console.warn('claim_orphan_children no-op:', e);
      }

      // Backstop de MEMBRESÍA: acepta TODAS las invitaciones pendientes de este
      // correo (parent/athlete), sin depender de localStorage (que se pierde si
      // el link se abre en otro dispositivo). Vive en acceptPendingInvitations
      // porque el dashboard NO es la primera pantalla de un registro nuevo: el
      // gate de onboarding de más abajo lo manda a /onboarding/<rol> y ese
      // camino también tiene que aceptar (Besser 2026-09-25: 3 acudientes con
      // cuenta creada y la invitación 'pending' por registrarse sin el link).
      await acceptPendingInvitations();

      // 1. Obtener status de onboarding desde RPC (La función SQL maestra)
      const { data: status, error: statusError } = await (supabase.rpc as any)('get_onboarding_status');

      if (statusError) {
        console.error('Error fetching onboarding status:', statusError);
        return;
      }

      console.log('Onboarding status updated:', status);

      if (status) {
        setOnboardingStatus(status.onboarding_status);
        setRpcStatus(status);
        // 2. Gestionar invitaciones
        const { data: invitations, error: inviteError } = await supabase
          .from('invitations')
          .select('*, schools(name)')
          .eq('email', profile.email)
          .eq('status', 'pending');

        if (!inviteError && invitations && invitations.length > 0) {
          const currentInvites = invitations[0];
          setInvitation({
            id: currentInvites.id,
            school_name: (currentInvites.schools as any)?.name || 'Tu Escuela',
            role_to_assign: currentInvites.role_to_assign,
          });
        } else {
          setInvitation(null);
        }

        // 3. Generar pasos para la UI
        const steps = getStepsForRole(profile.role as UserRole, status);
        setOnboardingSteps(steps);

        if (steps.every(s => s.completed)) {
          // No banner logic needed here anymore
        }

        // 4. Integrar lógica del Coach Wizard
        if (profile.role === 'coach') {
          const isWizardIncomplete = !status.has_professional_profile;

          // Solo abrir automáticamente la primera vez que detectamos que está incompleto
          if (isWizardIncomplete && !showCoachWizard && !hasAutoOpenedRef.current) {
            setShowCoachWizard(true);
            hasAutoOpenedRef.current = true;
          }
          // Si ya está completo, asegurarnos de que el wizard esté cerrado
          else if (!isWizardIncomplete && showCoachWizard) {
            setShowCoachWizard(false);
          }
        }
      }  // Here we could sync status.has_school etc to state if needed
    } catch (error) {
      console.error('Error refreshing onboarding data:', error);
    } finally {
      setLoadingStatus(false);
    }
    // Deps por VALOR, no por identidad de objeto. `profile` es un objeto nuevo
    // cada vez que AuthContext hace setProfile — y eso pasa al menos dos veces
    // por login (ruta getSession + ruta onAuthStateChange). Con `[profile]` este
    // callback cambiaba de identidad, el efecto de abajo volvía a correr, y todo
    // el bloque (claim_orphan_children, get_my_invitations, accept_invitation_pro,
    // get_onboarding_status — dos de ellos ESCRIBEN) se ejecutaba 3 veces por
    // carga del dashboard.
  }, [profile?.email, profile?.role, user?.id, toast]);

  useEffect(() => {
    refreshOnboardingData();
  }, [refreshOnboardingData]);

  // Super-admins de plataforma usan /admin, NO el dashboard de escuela
  if (profile?.role === 'admin' || (profile?.role as string) === 'super_admin') {
    return <Navigate to="/admin" replace />;
  }

  // ── Personal Trainer redirect ────────────────────────────────────────────────
  if (profile?.role === 'personal_trainer') {
    return <Navigate to="/trainer/dashboard" replace />;
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (!profile) return (
    <div className="flex items-center justify-center h-[60dvh]">
      <div className="text-center space-y-3">
        <div className="flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <span className="sr-only">Cargando panel</span>
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Cargando tu panel...</p>
          </div>
        </div>
      </div>
    </div>
  );

  // ────────────────────────────────────────────────────────────────────────────
  // Gate: si es rol de escuela y onboarding sin completar, lo mandamos a
  // /onboarding/school. Mismo patron que trainer (RequirePersonalTrainer)
  // y vendor (VendorGuard). Esto bloquea el dashboard hasta que termine.
  // ────────────────────────────────────────────────────────────────────────────
  {
    const isSchoolRole = ['school', 'school_admin', 'admin', 'owner']
      .includes(profile?.role as string);
    // resolveOnboardingGateStatus: no se decide hasta que el servidor responda
    // (antes el respaldo redirigía primero y generaba un bucle con
    // /onboarding/school para quien es dueño de una escuela y miembro de otra).
    const effectiveStatus = resolveOnboardingGateStatus({
      loading: loadingStatus,
      serverStatus: onboardingStatus,
      fallbackStatus: fallbackSchool?.onboarding_status,
    });
    const hasSchool = !!(rpcStatus?.has_school || rpcStatus?.school_id || fallbackSchool?.id);

    // Rol de escuela SIN escuela creada (típico en registro con Google: solo se
    // eligió el rol y complete_role_selection no crea la academia). Enviar a
    // /setup/school a capturar el nombre. Solo cuando el RPC YA respondió
    // (rpcStatus presente) y confirma que no hay escuela, para no rebotar a un
    // owner real durante la carga ni crear escuelas duplicadas.
    if (isSchoolRole && !loadingStatus && rpcStatus && !hasSchool) {
      return <Navigate to="/setup/school" replace />;
    }

    if (isSchoolRole && hasSchool && effectiveStatus && effectiveStatus !== 'completed') {
      return <Navigate to="/onboarding/school" replace />;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Gate: roles "persona" (athlete, parent, coach, wellness_professional) deben
  // completar su onboarding full-screen una vez. Bandera: profiles.onboarding_completed.
  // Usuarios existentes ya fueron marcados completados (migración 20260617000003),
  // así que esto solo afecta a nuevos registros (default onboarding_completed=false).
  // ────────────────────────────────────────────────────────────────────────────
  {
    const PERSON_ONBOARDING: Record<string, string> = {
      athlete: '/onboarding/athlete',
      parent: '/onboarding/parent',
      coach: '/onboarding/coach',
      wellness_professional: '/onboarding/wellness',
    };
    // Con el rol REAL, no el del contexto elegido: un dueño que entra «como
    // acudiente» (multirol) no debe caer en el onboarding de acudiente.
    const dest = PERSON_ONBOARDING[(realRole ?? profile.role) as string];
    if (dest && profile.onboarding_completed === false) {
      return <Navigate to={dest} replace />;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Inicio del acudiente — rediseño V2. Va DESPUÉS de los gates (onboarding de
  // persona) y de refreshOnboardingData (claim_orphan_children, aceptar
  // invitaciones), que corren en los hooks de arriba igual que para todos.
  // Conserva lo que el acudiente ya tenía y no es decorativo: la invitación
  // pendiente, el modal de inscripción pendiente y los torneos abiertos.
  // ────────────────────────────────────────────────────────────────────────────
  // Hoy del deportista — V2 (docs/specs/entrenador-deportista-v2.md). Mismo
  // lugar que el acudiente: después de los gates. Conserva el modal de
  // inscripción pendiente y los primeros pasos mientras no estén completos.
  // Hoy del entrenador — V2: una frase y un botón según el momento del día.
  // Va después de los gates (onboarding de persona, perfil del coach).
  // Multirol: manda el rol activo (el mismo que eligen las pestañas de abajo),
  // no profile.role — si no, un acudiente que entra como deportista vería la
  // barra del deportista con el Inicio del acudiente.
  // Una sola campana: la de la cabecera de la app (GlobalNotificationBell en
  // AuthLayout). Los Inicios V2 ya no dibujan la suya.

  const invitacionPendiente = invitation && (
    <InvitationBanner
      invitation={invitation}
      onAction={() => {
        setInvitation(null);
        refreshOnboardingData();
      }}
    />
  );

  if (ENTRENADOR_V2 && rolActivo === 'coach') {
    return (
      <>
        {invitacionPendiente}
        {onboardingSteps.length > 0 && !onboardingSteps.every(s => s.completed) && onboardingStatus !== 'completed' && (
          <DashboardChecklist
            steps={onboardingSteps}
            onStepClick={(step) => (step.id === 'complete_profile' ? setShowCoachWizard(true) : navigate(step.href))}
          />
        )}
        <CoachHomeV2 nombreProfe={profile.full_name ?? undefined} />
        <CoachProfileWizard open={showCoachWizard} onOpenChange={setShowCoachWizard} onSuccess={refreshOnboardingData} />
      </>
    );
  }

  if (DEPORTISTA_V2 && rolActivo === 'athlete') {
    return (
      <>
        <PendingEnrollmentModal />
        {invitacionPendiente}
        {/* Cuenta sin escuela: «¿Ya tienes escuela? Ingresa su código» (spec codigo-de-escuela). */}
        <JoinSchoolCodeBanner className="mb-4" />
        {onboardingSteps.length > 0 && !onboardingSteps.every(s => s.completed) && onboardingStatus !== 'completed' && (
          <DashboardChecklist steps={onboardingSteps} onStepClick={(step) => navigate(step.href)} />
        )}
        {/* Los torneos abiertos van DENTRO de AthleteHomeV2, con su diseño. */}
        <AthleteHomeV2 />
      </>
    );
  }

  if (ACUDIENTE_V2 && usaInicioAcudienteV2(rolActivo)) {
    return (
      <ParentHomeV2
        userId={user?.id}
        nombreAcudiente={profile.full_name}
        extras={
          <>
            <PendingEnrollmentModal />
            {/* Primeros pasos (vincular hijo, ficha médica, invitación…): el mismo
                checklist que tenía el Inicio anterior, mientras no esté completo. */}
            {onboardingSteps.length > 0 && !onboardingSteps.every(s => s.completed) && onboardingStatus !== 'completed' && (
              <DashboardChecklist steps={onboardingSteps} onStepClick={(step) => navigate(step.href)} />
            )}
            {invitacionPendiente}
            <JoinSchoolCodeBanner />
          </>
        }
        pie={<OpenTournamentsCard />}
      />
    );
  }

  // Dashboard handles empty states via the Quick Start Checklist

  // Logic to determine stats to display
  const dynamicStats = config.stats.map((stat, index) => {
    // 1. SHOW LOADING STATE
    if (realStatsLoading) {
      return {
        ...stat,
        value: '...',
        description: 'Cargando datos...'
      };
    }

    // 2. REAL USER: SHOW REAL DATA
    if (realStats) {
      if (profile.role === 'school' || (profile.role as string) === 'school_admin' || profile.role === 'admin' || (profile.role as any) === 'super_admin' || profile.role === 'coach') {
        if (index === 0) {
          // Students (Config Index 0) — tarjeta "Deportistas Activos": contar solo activos, no inactivos
          const count = realStats.active_students || 0;
          const total = realStats.students_count || 0;
          const inactive = Math.max(total - count, 0);
          return {
            ...stat,
            value: count,
            description: total > 0
              ? (inactive > 0
                  ? `${count} activo${count !== 1 ? 's' : ''} · ${inactive} inactivo${inactive !== 1 ? 's' : ''}`
                  : `${count} deportista${count !== 1 ? 's' : ''} activo${count !== 1 ? 's' : ''}`)
              : 'Agrega tu primer deportista'
          };
        }
        if (index === 1) {
          const count = realStats.classes_count || 0;
          const plansCount = (realStats as any).plans_count ?? 0;
          if (profile.role === 'coach') {
            return { ...stat, value: count, description: 'Equipos asignados' };
          }
          // owner/school → split card showing Equipos + Planes
          return {
            ...stat,
            title: 'Equipos',
            value: count,
            description: undefined,
            splitValue: plansCount,
            splitTitle: 'Planes',
            splitIcon: Zap,
          };
        }
        if (index === 2) {
          // Coaches relative or third card
          const count = profile.role === 'coach'
            ? (realStats.upcomingEvents || 0)
            : ((realStats as any).coaches_count || 0);

          return {
            ...stat,
            value: count,
            description: profile.role === 'coach' ? 'Próximos eventos' : 'Entrenadores activos'
          };
        }
        if (index === 3) {
          // Revenue, notifications or attendance
          let value: string | number = 0;
          let description = stat.description;

          if (profile.role === 'coach') {
            value = `${realStats.attendanceRate || 0}%`;
            description = 'Promedio general';
          } else if (realStats.revenue_state === 'forbidden') {
            // Sin permiso de lectura financiera: la tarjeta no se muestra
            // (nunca un $0 que parezca un dato). Se filtra abajo.
            return { ...stat, hidden: true };
          } else if (realStats.monthly_revenue == null) {
            // Falló la lectura: "—", no $0.
            value = '—';
            description = 'No se pudo cargar';
          } else {
            value = formatCurrency(realStats.monthly_revenue);
            // Ingreso cobrado este mes (Bogotá) por fecha de pago, con la misma
            // fórmula que Contabilidad y Gestión de Pagos (finance_income_summary).
            description = 'Cobrado este mes';
            // Con tienda: desglose Mensualidades / Tienda (las ventas de la
            // tienda no están en payments; se leen con store_income_summary).
            const bd = realStats.revenue_breakdown;
            if (bd) {
              description = `Mensualidades ${formatCurrency(bd.mensualidades)} · Tienda ${
                bd.tienda == null ? '—' : formatCurrency(bd.tienda)}`;
            }
          }

          return {
            ...stat,
            value,
            description
          };
        }
      }

      // Add logic for Parent real stats here if useDashboardStatsReal supports it
      if (profile.role === 'parent') {
        if (index === 0) {
          return {
            ...stat,
            value: realStats.children || 0,
            description: 'Hijos inscritos en academias'
          };
        }
        if (index === 1) {
          return {
            ...stat,
            value: realStats.children_attendance || '0%',
            description: 'Asistencia promedio (30 días)'
          };
        }
        if (index === 2) {
          return {
            ...stat,
            value: realStats.upcoming_payments || 0,
            description: 'Mensualidades pendientes'
          };
        }
        if (index === 3) {
          return {
            ...stat,
            value: realStats.unreadNotifications || 0,
            description: 'Sin leer'
          };
        }
      }
    }

    return stat;
  });

  // Transform notifications for display (Demo vs Real)
  const displayNotifications = notifications?.slice(0, 5).map(n => ({
    id: n.id,
    title: n.title,
    message: n.message,
    type: n.type as 'info' | 'warning' | 'success',
    read: n.read || false,
    timestamp: new Date(n.created_at).toLocaleDateString('es', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    })
  }));

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-3xl font-bold font-poppins tracking-tight">{config.title}</h2>
            {activeBranchId && (
              <Badge variant="outline" className="bg-primary/5 text-primary border-primary/20 animate-in fade-in slide-in-from-left-2">
                <MapPin className="h-3 w-3 mr-1" />
                {activeBranchName}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground font-poppins">{config.description}</p>
        </div>
      </div>

      {/* Welcome Message */}
      <WelcomeMessage
        role={profile.role as UserRole}
        userName={profile.full_name?.split(' ')[0]}
      />

      {/* Tomar asistencia — acceso directo grande para el coach, arriba de todo.
          Hoy "Marcar Asistencia" vivía como botón secundario chico adentro de
          QuickActions, debajo de las stat cards: para verlo había que scrollear.
          El pedido fue explícito — de primeras, grande, inmediato. */}
      {profile.role === 'coach' && (
        <div className="grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => navigate('/coach-attendance')}
            className="w-full text-left rounded-2xl bg-gradient-to-br from-primary to-primary-dark text-primary-foreground shadow-elevation hover:shadow-performance transition-all duration-300 hover:scale-[1.01] p-5 sm:p-6 flex items-center gap-4"
          >
            <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
              <CalendarCheck className="w-7 h-7" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.2em] opacity-80 mb-0.5">Acceso rápido</p>
              <h3 className="text-lg sm:text-xl font-black leading-tight">Tomar asistencia</h3>
              <p className="text-sm opacity-85 mt-0.5">Pasa lista de tu equipo de hoy en segundos</p>
            </div>
            <ChevronRight className="w-6 h-6 opacity-70 shrink-0" />
          </button>

          {/* Sesiones de entrenamiento — segundo acceso directo. Antes: Gestión →
              Entrenamiento → Métricas y Rendimiento, con la sección plegada por
              defecto. Pedido de Carmel 2026-09-24 ("son muchos pasos"). */}
          <button
            type="button"
            onClick={() => navigate('/training-plans')}
            className="w-full text-left rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 text-white shadow-elevation hover:shadow-performance transition-all duration-300 hover:scale-[1.01] p-5 sm:p-6 flex items-center gap-4"
          >
            <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
              <Activity className="w-7 h-7" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.2em] opacity-80 mb-0.5">Acceso rápido</p>
              <h3 className="text-lg sm:text-xl font-black leading-tight">Sesiones de entrenamiento</h3>
              <p className="text-sm opacity-85 mt-0.5">Planifica la semana, arma la sesión y abre la pizarra</p>
            </div>
            <ChevronRight className="w-6 h-6 opacity-70 shrink-0" />
          </button>
        </div>
      )}

      {/* Pagar ahora — acceso directo grande para el padre cuando tiene
          mensualidades pendientes, arriba de todo. Con un solo cobro pendiente
          aterriza con el modal de pago YA abierto (`?pay=auto`, lo resuelve
          MyPaymentsPage); con varios, en la lista, donde cada cobro tiene su
          botón "Pagar". Antes: Mis Pagos → tarjeta → Pagar Ahora (3 clicks). */}
      {profile.role === 'parent' && (realStats?.upcoming_payments || 0) > 0 && (
        <button
          type="button"
          onClick={() => navigate(realStats.upcoming_payments === 1 ? '/my-payments?pay=auto' : '/my-payments')}
          className="w-full text-left rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 text-white shadow-elevation hover:shadow-performance transition-all duration-300 hover:scale-[1.01] p-5 sm:p-6 flex items-center gap-4"
        >
          <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
            <CreditCard className="w-7 h-7" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.2em] opacity-80 mb-0.5">Acceso rápido</p>
            <h3 className="text-lg sm:text-xl font-black leading-tight">
              Tienes {realStats.upcoming_payments} pago{realStats.upcoming_payments === 1 ? '' : 's'} pendiente{realStats.upcoming_payments === 1 ? '' : 's'}
            </h3>
            <p className="text-sm opacity-85 mt-0.5">Toca para pagar ahora</p>
          </div>
          <ChevronRight className="w-6 h-6 opacity-70 shrink-0" />
        </button>
      )}

      {/* CTA Activar Mi Tienda — visible solo para roles elegibles sin vendor_profile */}
      <ActivateStoreCTA />

      {/* Torneos/ligas internas abiertas en mi escuela — solo padre/atleta */}
      <OpenTournamentsCard />

      {/* Torneos de la escuela con accesos directos — solo admin con el módulo */}
      <SchoolTournamentsHomeCard />

      {/* Pending Enrollment Modal */}
      <PendingEnrollmentModal />

      {/* Cuenta sin escuela (acudiente o deportista): ingresar el código de su escuela. */}
      {(profile.role === 'parent' || profile.role === 'athlete') && <JoinSchoolCodeBanner />}

      {/* Invitations and Onboarding Checklist */}
      {invitation && !['school', 'school_admin', 'admin', 'super_admin', 'owner'].includes(profile.role as string) && (
        <InvitationBanner
          invitation={invitation}
          onAction={() => {
            setInvitation(null);
            refreshOnboardingData();
          }}
        />
      )}

      {/* Wizard guiado para escuelas.
          Triple fuente: rpcStatus.has_school, rpcStatus.school_id, o
          fallbackSchool (query directa). Cualquiera prende el wizard. */}
      {(() => {
        const isSchoolRole = ['school', 'school_admin', 'admin', 'owner', 'super_admin']
            .includes(profile?.role as string);
        const hasSchoolInRpc = !!(rpcStatus?.has_school || rpcStatus?.school_id);
        const hasSchoolInFallback = !!fallbackSchool?.id;
        const hasSchool = hasSchoolInRpc || hasSchoolInFallback;
        const effectiveOnboardingStatus = onboardingStatus
          ?? fallbackSchool?.onboarding_status
          ?? null;
        const isCompleted = effectiveOnboardingStatus === 'completed';
        const shouldShow = isSchoolRole && hasSchool && !isCompleted;

        if (!shouldShow) return null;

        // Compone status para el wizard: prefiere rpcStatus si existe,
        // si no, sintetiza uno minimo desde fallbackSchool y query basicas.
        const wizardStatus = rpcStatus ?? {
          school_id:               fallbackSchool!.id,
          onboarding_status:       fallbackSchool!.onboarding_status,
          business_model:          fallbackSchool!.business_model,
          has_school:              true,
          has_branches:            false,
          has_teams:               false,
          has_plans:               false,
          has_staff:               false,
          has_students:            false,
          payment_setup_completed: false,
          role:                    profile?.role,
        };

        return (
          <div className="animate-in fade-in slide-in-from-top-4 duration-500">
            <SchoolOnboardingWizard
              status={wizardStatus}
              onComplete={() => {
                setOnboardingStatus('completed');
                refreshOnboardingData();
              }}
              onRefresh={refreshOnboardingData}
            />
          </div>
        );
      })()}

      {/* Checklist genérico para otros roles (parent, coach, athlete) */}
      {onboardingSteps.length > 0 && !onboardingSteps.every(s => s.completed) && onboardingStatus !== 'completed'
        && !['school', 'school_admin', 'admin', 'owner', 'super_admin'].includes(profile.role as string) && (
        <div className="animate-in fade-in slide-in-from-top-4 duration-500">
          <DashboardChecklist
            steps={onboardingSteps}
            onStepClick={(step) => {
              if (step.id === 'complete_profile' && profile.role === 'coach') {
                setShowCoachWizard(true);
              } else {
                navigate(step.href);
              }
            }}
          />
        </div>
      )}

      {/* Coach Profile Wizard */}
      {profile.role === 'coach' && (
        <CoachProfileWizard
          open={showCoachWizard}
          onOpenChange={setShowCoachWizard}
          onSuccess={refreshOnboardingData}
        />
      )}

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {dynamicStats.map((stat, index) => (stat as { hidden?: boolean }).hidden ? null : (
          <div key={index} data-tour={
            index === 0 ? 'revenue-card' :
              index === 1 ? 'students-card' :
                index === 2 ? 'programs-card' :
                  'notifications-card'
          }>
            <StatCard {...stat} />
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Quick Actions - Always show */}
        {config.quickActions && config.quickActions.length > 0 && (
          <div data-tour="quick-actions">
            <QuickActions
              actions={config.quickActions}
              onEdit={isSchoolDashboard ? () => setShowQuickActionsEdit(true) : undefined}
            />
            {isSchoolDashboard && (
              <QuickActionsEditDialog
                open={showQuickActionsEdit}
                onOpenChange={setShowQuickActionsEdit}
                currentIds={savedQuickActionIds ?? []}
                saving={savingSettings}
                onSave={async (ids) => {
                  await updateDashboardPreferences({ dashboard_quick_actions: ids });
                  setShowQuickActionsEdit(false);
                }}
              />
            )}
          </div>
        )}

        {/* Activities - Only show if there are activities */}
        {config.activities && config.activities.length > 0 && (
          <div className="md:col-span-2 lg:col-span-1">
            <ActivityList
              title="Próximas Actividades"
              activities={config.activities}
            />
          </div>
        )}

        {/* Notifications - Show real or demo notifications */}
        {displayNotifications && displayNotifications.length > 0 && (
          <NotificationList notifications={displayNotifications} />
        )}
      </div>

    </div>
  );
}
