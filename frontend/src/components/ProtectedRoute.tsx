import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: ('athlete' | 'parent' | 'coach' | 'school' | 'school_admin' | 'wellness_professional' | 'store_owner' | 'admin' | 'super_admin' | 'organizer' | 'reporter' | 'personal_trainer' | 'accountant' | 'facility_manager')[];
  skipOnboardingCheck?: boolean;
  /** When true, allowedRoles is enforced strictly — school context roles do NOT count. */
  strictRoleCheck?: boolean;
}

// Roles de MEMBRESÍA (school_members, vía useSchoolContext) que administran una
// escuela. Ojo: acá 'admin' es admin DE ESCUELA, no de plataforma.
//
// Antes estos roles saltaban allowedRoles por completo: cualquier dueño o admin
// de escuela entraba por URL a /admin/users, /admin/analytics, /pacientes
// (historias clínicas), etc. Ahora solo cuentan en rutas que admiten
// administración de escuela ('school' o 'school_admin' en allowedRoles). Así
// el dueño cuyo perfil no es 'school' (11 personal_trainer y 1 coach dueños en
// la base, 2026-10-10) sigue entrando a las rutas de su escuela, sin abrir el
// resto.
export const SCHOOL_ADMIN_CONTEXT_ROLES = ['owner', 'admin', 'school_admin'] as const;
const SCHOOL_ADMIN_ROUTE_ROLES = ['school', 'school_admin'] as const;

export function ProtectedRoute({ children, allowedRoles, skipOnboardingCheck = false, strictRoleCheck = false }: ProtectedRouteProps) {
  const { user, profile, loading: authLoading, needsRoleChoice } = useAuth();
  const { onboardingStatus, loading: schoolLoading, currentUserRole, schoolId } = useSchoolContext();
  const location = useLocation();

  if (authLoading || (schoolLoading && user)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    // Volver a donde iba después del login (p. ej. una invitación /salud/invitacion/:token).
    const destino = location.pathname + location.search;
    const to = destino && destino !== '/' ? `/login?redirectTo=${encodeURIComponent(destino)}` : '/login';
    return <Navigate to={to} replace />;
  }

  // Selección de rol diferida: usuarios que entraron por OAuth (Google) sin
  // rol asignado deben elegirlo antes de usar la app. skipOnboardingCheck
  // exime a la propia pantalla de selección para evitar bucle de redirección.
  if (
    !skipOnboardingCheck &&
    profile?.needs_role_selection &&
    location.pathname !== '/onboarding/role'
  ) {
    return <Navigate to="/onboarding/role" replace />;
  }

  // Persona multirol sin rol elegido: primero elige con qué rol entrar, para que
  // la app cargue de una vez con el módulo correcto. Vuelve a donde iba.
  // Nunca desde /onboarding/role (skipOnboardingCheck) ni con needs_role_selection
  // pendiente: /elegir-rol mandaría a /onboarding/role y este de vuelta acá (bucle).
  if (
    needsRoleChoice &&
    !skipOnboardingCheck &&
    !profile?.needs_role_selection &&
    location.pathname !== '/elegir-rol'
  ) {
    const destino = location.pathname + location.search;
    return <Navigate to={`/elegir-rol?redirectTo=${encodeURIComponent(destino)}`} replace />;
  }

  // Allow access even without profile - it will be created automatically
  if (allowedRoles && profile) {
    const hasAllowedProfileRole = allowedRoles.includes(profile.role as any);

    if (strictRoleCheck) {
      // Strict mode: only profile.role counts. Used by routes that consume
      // platform-wide RPCs gated server-side (e.g. super-admin-only pages).
      if (!hasAllowedProfileRole) {
        return <Navigate to="/unauthorized" replace />;
      }
    } else {
      // Default: allowedRoles manda. La membresía de administración de escuela
      // cuenta SOLO si la ruta admite administración de escuela, y solo con una
      // escuela activa real (useSchoolContext le pone 'owner' a un perfil
      // school/school_admin/reporter SIN membresías para el onboarding; ese caso
      // ya entra por su rol de perfil si corresponde).
      const routeAdmitsSchoolAdmin = allowedRoles.some((r) =>
        (SCHOOL_ADMIN_ROUTE_ROLES as readonly string[]).includes(r),
      );
      const hasSchoolAdminContext =
        routeAdmitsSchoolAdmin &&
        !!schoolId &&
        !!currentUserRole &&
        (SCHOOL_ADMIN_CONTEXT_ROLES as readonly string[]).includes(currentUserRole);
      if (!hasSchoolAdminContext && !hasAllowedProfileRole) {
        return <Navigate to="/unauthorized" replace />;
      }
    }
  }

  // Hard Gate for School Onboarding (REMOVED: Consolidated in Dashboard)
  // Hard Gate for Other Roles (REMOVED: Consolidated in Dashboard)

  return <>{children}</>;
}