import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { RealtimeNotificationsProvider } from "@/components/RealtimeNotificationsProvider";
import { useAuth } from "@/contexts/AuthContext";
import { useSchoolContext } from "@/hooks/useSchoolContext";
import { useEntitlements } from "@/hooks/useEntitlements";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GlobalNotificationBell } from "@/components/GlobalNotificationBell";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Repeat } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { BrandingScope } from "@/components/BrandingScope";
import { useDeviceContext } from "@/hooks/useDeviceContext";
import { usePwaTenantSync } from "@/hooks/usePwaTenantSync";
import { PushPermissionBanner } from "@/components/PushPermissionBanner";
import { useSincronizarPushSilencioso } from "@/hooks/usePushSubscription";
import { TrialStatusBanner } from "@/components/entitlements/TrialStatusBanner";
import { SupportChatButton } from "@/components/support/SupportChatButton";
import { VolverAcudiente } from "@/components/parent/v2/VolverAcudiente";
import { pestanasDeRol } from "@/lib/acudienteTabs";
import { useRolActivo } from "@/hooks/useRolActivo";
import { CoachListasSync } from "@/components/coach/v2/CoachListasSync";
import { useFabSoporteOculto } from "@/lib/supportFab";
import { inicialesPersona } from "@/lib/iniciales";
import { clasesCascaronV2 } from "@/layouts/cascaronV2";

export default function AuthLayout() {
  const { user, profile, roleContexts } = useAuth();
  const { schoolId, schoolName, currentUserRole, schoolBranding } = useSchoolContext();
  const pestanasV2 = pestanasDeRol(useRolActivo());
  const { pathname } = useLocation();
  const fabOculto = useFabSoporteOculto();
  const cascaron = clasesCascaronV2({ v2: !!pestanasV2, pathname, fabVisible: !fabOculto });
  const entitlements = useEntitlements();
  // Registrar device del usuario al loguearse (Fase 6.1).
  // Hoy solo web/PWA; cuando se instale Capacitor (Fase 7) detecta nativo.
  useDeviceContext();
  // Deja el slug de la escuela en localStorage para que la PROXIMA carga pida
  // el manifest con la marca correcta y la app se instale con su logo.
  usePwaTenantSync();
  // Web: si el permiso ya está concedido, refresca la suscripción push y la
  // rota si se creó con otra llave VAPID. Silencioso, una vez por sesión.
  useSincronizarPushSilencioso();

  // Logo escuela en header: usar el del context (ya lo hace fetch
  // useSchoolContext.fetchSchoolBranding). Sirve para feature gate por tier.
  // `marcaPropia` = addon pwa_branding, espejo de school_shows_own_brand() en
  // la BD. Un solo flag para "se le muestra su marca", sin ORs sueltos que se
  // desincronicen entre pantallas.
  const schoolLogo = entitlements.marcaPropia ? (schoolBranding?.logo_url ?? null) : null;

  // V2: el Inicio ya trae su cabecera con la escuela; aquí no se repite (27/32).
  const showSchoolBranding = ['owner', 'admin', 'school_admin', 'school', 'coach'].includes(currentUserRole || '') && cascaron.mostrarEscuelaEnBarra;
  const isCoach = currentUserRole === 'coach';
  const hasSchool = !!schoolId;

  return (
    <SidebarProvider>
      <RealtimeNotificationsProvider />
      {/* h-[100dvh] + overflow-hidden (no min-h-screen): el scroll SOLO debe
          pasar dentro de <main>, que ya tiene su propio overflow-auto. Con
          min-h-screen la ventana también podía crecer y scrollear, y en
          WKWebView (iOS nativo) ese doble contenedor de scroll hacía que el
          header sticky se "despegara" visualmente durante el rebote elástico
          — el usuario lo veía como el título de la página tapado por la
          barra de estado, sin ningún header encima. */}
      <div className="h-[100dvh] flex w-full overflow-hidden">
        <AppSidebar />

        <div className="flex-1 flex flex-col w-full max-w-full overflow-x-hidden">

          {/* ── Header ─────────────────────────────────────────────────── */}
          <header className="min-h-14 sm:min-h-16 flex items-center border-b px-3 sm:px-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 justify-between sticky top-0 z-50 sticky-safe">

            {/* Left: hamburger + school branding */}
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              {/* SidebarTrigger abre el drawer en mobile, colapsa en desktop.
                  V2 en celular: no hay menú lateral, la barra inferior («Más») hace ese papel (34). */}
              <SidebarTrigger className={`flex-shrink-0 hover:bg-accent transition-colors h-9 w-9 ${cascaron.trigger}`} />

              <div className="h-6 w-[1px] bg-border hidden md:block flex-shrink-0" />

              {/* School Branding — truncado en mobile */}
              {showSchoolBranding && (hasSchool || !isCoach) && (
                <div className="flex items-center gap-2 min-w-0 animate-in fade-in slide-in-from-left-2 duration-500">
                  {schoolLogo ? (
                    <img
                      src={schoolLogo}
                      alt={schoolName}
                      className="h-7 w-7 sm:h-9 sm:w-9 rounded-lg object-contain bg-white p-0.5 sm:p-1 border shadow-sm flex-shrink-0"
                    />
                  ) : (
                    <div className="h-7 w-7 sm:h-9 sm:w-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 text-primary font-bold text-[10px] sm:text-xs flex-shrink-0">
                      {schoolName?.substring(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs sm:text-sm font-bold text-foreground leading-none truncate max-w-[100px] sm:max-w-[160px]">
                      {schoolName || 'Mi Academia'}
                    </span>
                    <span className="text-[9px] sm:text-[10px] text-muted-foreground uppercase tracking-wider font-medium mt-0.5 hidden sm:block">
                      {currentUserRole?.replace('_', ' ')}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Right: notifications + theme + avatar */}
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <div className="flex items-center gap-1 sm:gap-2 pr-2 border-r">
                {/* Sin menú lateral en el celular (V2), el cambio de rol de una persona multirol queda aquí. */}
                {pestanasV2 && roleContexts.length > 0 && (
                  <Link
                    to="/elegir-rol"
                    aria-label="Cambiar de rol"
                    title="Cambiar de rol"
                    className="md:hidden inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent transition-colors"
                  >
                    <Repeat className="h-4 w-4" />
                  </Link>
                )}
                <GlobalNotificationBell />
                <ThemeToggle />
              </div>
              <div className="flex items-center gap-2 sm:gap-3 pl-1">
                {/* Nombre — solo visible en md+ */}
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-sm font-semibold text-foreground leading-none">
                    {profile?.full_name || user?.email?.split('@')[0]}
                  </span>
                  <span className="text-[10px] text-muted-foreground capitalize">
                    {profile?.role === 'parent' ? 'Acudiente' :
                      profile?.role === 'athlete' ? 'Deportista' :
                        profile?.role === 'coach' ? 'Entrenador' :
                          profile?.role === 'personal_trainer' ? 'Entrenador Personal' :
                            profile?.role || 'Usuario'}
                  </span>
                </div>
                <Avatar className="h-8 w-8 sm:h-9 sm:w-9 border-2 border-primary/20 hover:border-primary/50 transition-all cursor-pointer">
                  <AvatarImage src={profile?.avatar_url} />
                  <AvatarFallback className="bg-primary/5 text-primary text-xs font-bold">
                    {inicialesPersona(profile?.full_name, user?.email)}
                  </AvatarFallback>
                </Avatar>
              </div>
            </div>
          </header>

          {/* ── Main content ───────────────────────────────────────────── */}
          {/* Reserva el alto del bottom nav (h-16) + el home indicator de iOS — antes era un pb-20 fijo que en iPhone se quedaba 18px corto */}
          {/* 39: con la burbuja de Mapi a la vista, el final de cualquier lista sube por encima de ella
              (en celular: barra inferior + burbuja). Ver layouts/cascaronV2.ts. */}
          <main className={`flex-1 p-3 sm:p-4 lg:p-6 overflow-auto w-full max-w-full ${cascaron.main}`}>
            {/* overflow-x-clip (no -hidden): recorta igual, pero -hidden crea un
                contenedor de scroll que no se mueve y ningún `sticky` de adentro se
                pegaba («Guardar lista», pestañas del equipo). El clip va en style:
                un navegador que no lo entiende (iOS < 16) ignora el valor y se
                queda con el overflow-x-hidden de la clase. */}
            <div className="w-full max-w-full overflow-x-hidden" style={{ overflowX: 'clip' }}>
              {/* Aviso de fin del periodo de prueba (contador → bloqueo).
                  Va aquí, en el layout, y no página por página: así ninguna
                  pantalla queda sin el aviso. El componente decide solo si
                  corresponde mostrarlo (rol que decide + escuela en prueba). */}
              <TrialStatusBanner />

              {/* BrandingScope aplica CSS vars de escuela SOLO si:
                  - ruta esta en allowlist (no admin/marketplace/billing)
                  - rol es de escuela (no super_admin)
                  - tier incluye whitelabel (Pro+ via entitlements)
                  Si no aplica, renderiza children sin envolver. */}
              {/* Acudiente V2: toda pantalla interna tiene «Volver». */}
              {/* V2 (acudiente, entrenador, deportista): toda pantalla interna tiene «Volver». */}
              {pestanasV2 && <VolverAcudiente pestanas={pestanasV2} />}

              <BrandingScope>
                <Outlet />
              </BrandingScope>
            </div>
          </main>
        </div>
      </div>
      {/* Entrenador: las listas guardadas sin señal suben solas, esté en la pestaña que esté.
          Va también con la reversa (VITE_ENTRENADOR_V2=false): si se apaga la V2 con
          listas en cola, no se pueden quedar sin subir. Con la cola vacía no hace nada. */}
      {(currentUserRole ?? profile?.role) === 'coach' && <CoachListasSync />}
      <PushPermissionBanner />
      <SupportChatButton />
    </SidebarProvider>
  );
}