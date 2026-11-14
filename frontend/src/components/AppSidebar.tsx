import { NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { roleForNavigation } from '@/lib/navigationRole';
import { esPerfilDeEscuela } from '@/hooks/useRolActivo';
import { LogOut, ChevronDown, Repeat } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
  SidebarHeader
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { inicialesPersona } from '@/lib/iniciales';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { getNavigationByRole, getVendorNavGroup, type NavRole } from '@/config/navigation';
import { UserRole } from '@/types/dashboard';
import { useVendorProfile } from '@/hooks/useVendorProfile';
import { useSchoolStore } from '@/hooks/useSchoolStore';
import { useIsMultiSport } from '@/hooks/useSportVisual';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useStoreEnabled } from '@/hooks/useStoreEnabled';
import { useMySchoolStore } from '@/hooks/useMySchoolStore';
// NOTE: el SchoolSwitcher viejo (src/components/common/SchoolSwitcher.tsx,
// escuela + sede en un solo dropdown) sigue apagado. En su lugar va el
// BranchSelector (multisede S1, docs/specs/multisede-selector-y-sede-del-atleta.md):
// selector segmentado «Todas / Suba / Norte» para el owner/admin GLOBAL, solo
// si la escuela activa tiene más de una sede activa. Llama a
// switchSchool(schoolId, branchId) y todo lo que filtra por activeBranchId se
// reacomoda; recuerda la última sede por usuario y escuela. La sede de un
// atleta sin equipo/ficha con sede (S2) todavía puede salir «Sin sede»: esos
// solo se ven en «Todas».
import { BranchSelector } from './common/BranchSelector';
import Logo from './Logo';

export function AppSidebar() {
  const { user, profile, signOut, roleContexts, activeRoleContext } = useAuth();
  const { currentUserRole, isGlobalAdmin, totalBranches, activeBranchId } = useSchoolContext();
  const sidebar = useSidebar();
  const { state, isMobile, setOpenMobile } = sidebar;
  const location = useLocation();
  const [openSubmenus, setOpenSubmenus] = useState<Record<string, boolean>>({});
  const { hasVendorProfile, canSellProducts, canSellServices, verificationStatus } = useVendorProfile();
  const { isOpen: schoolStoreOpen } = useSchoolStore();
  const { hasAddon, hasBilling, isModuleEnabled } = useEntitlements();
  // Flag global de la tienda (fail-closed: false mientras carga o si falla).
  const { enabled: storeEnabled } = useStoreEnabled();

  // En mobile el sidebar siempre muestra contenido expandido (nunca collapsed)
  const isCollapsed = !isMobile && state === 'collapsed';

  // Normalize role for navigation mapping
  // Profile-level platform roles (admin/super_admin/personal_trainer) win over
  // any per-school context role (currentUserRole) — un super-admin que ademas
  // sea miembro de una escuela debe verse SIEMPRE como super-admin.
  // roleForNavigation: una membresía 'admin' es admin DE CLUB y se presenta como
  // 'school_admin'; solo el rol del PERFIL (admin/super_admin) abre el menú de
  // plataforma (ROADMAP UX-8).
  const effectiveRole: string | undefined = roleForNavigation(profile?.role, currentUserRole);
  let navigationRole: NavRole = 'athlete';

  if (effectiveRole) {
    switch (effectiveRole) {
      case 'super_admin':
        navigationRole = 'super_admin';
        break;
      case 'owner':
      case 'school':
        navigationRole = 'school';
        break;
      case 'admin':
        navigationRole = 'admin';
        break;
      case 'school_admin':
        navigationRole = 'school_admin';
        break;
      case 'reporter':
        navigationRole = 'reporter';
        break;
      case 'coach':
      case 'staff':
        navigationRole = 'coach';
        break;
      case 'parent':
        navigationRole = 'parent';
        break;
      case 'athlete':
        navigationRole = 'athlete';
        break;
      case 'personal_trainer':
        navigationRole = 'personal_trainer';
        break;
      case 'facility_manager':
        navigationRole = 'facility_manager';
        break;
      // external_vendor es el rol nuevo que reemplaza al legacy store_owner.
      // Usan exactamente la misma navegacion de vendor.
      case 'external_vendor':
      case 'store_owner':
        navigationRole = 'store_owner';
        break;
      case 'wellness_professional':
        navigationRole = 'wellness_professional';
        break;
      default:
        navigationRole = (effectiveRole as UserRole) || 'athlete';
        break;
    }
  }

  // Comprador (padre / atleta): «Tienda» / «Mis compras» solo si la tienda de
  // SU escuela activa vende (store_seller_allowed), no por el flag global solo.
  const isBuyerNav = navigationRole === 'parent' || navigationRole === 'athlete';
  const { showStore, showMyPurchases } = useMySchoolStore({ enabled: isBuyerNav });
  const baseNavigationGroups = getNavigationByRole(
    navigationRole, hasAddon, isModuleEnabled, storeEnabled, { showStore, showMyPurchases },
    esPerfilDeEscuela(profile?.role),
  );

  // Mi Tienda: grupo ADICIONAL para roles que NO son primariamente vendor
  // pero que decidieron sumarle marketplace a su cuenta.
  //
  // Roles vendor-primarios (external_vendor, wellness_professional,
  // personal_trainer, store_owner) NO ven este grupo porque su sidebar
  // principal ya cubre productos/servicios/pedidos/agenda. Mostrarlo
  // duplica items y confunde con "Verificacion pendiente" mal posicionado.
  //
  // Roles school (school/school_admin/owner) requieren addon `store`
  // explicito (es upgrade pago via /mi-plan).
  //
  // Roles candidatos a ver el grupo: coach (que quiere vender servicios
  // extra), y school CON addon `store` activo.
  const isSchoolRole = effectiveRole === 'school' || effectiveRole === 'school_admin' || effectiveRole === 'owner';
  const isVendorPrimaryRole = (
    effectiveRole === 'external_vendor' ||
    effectiveRole === 'wellness_professional' ||
    effectiveRole === 'personal_trainer' ||
    effectiveRole === 'store_owner'
  );
  // Con la tienda apagada el grupo solo sobrevive si vende servicios (queda
  // como "Mis Servicios": panel, servicios, agenda, verificación).
  // Escuela: «Tu tienda» por ESCUELA (useSchoolStore, bug N0), con el adicional
  // y la tienda prendida en la plataforma. Sin tienda activada, el grupo solo
  // lleva a Ajustes (donde se activa).
  const showSchoolStoreGroup = isSchoolRole && hasAddon('store') && storeEnabled;
  const showVendorGroup = !isSchoolRole && hasVendorProfile && !isVendorPrimaryRole
    && (storeEnabled || canSellServices);
  const navigationGroupsBase = showSchoolStoreGroup
    ? [...baseNavigationGroups, getVendorNavGroup({ canSellProducts, canSellServices, verificationStatus, storeEnabled, isSchool: true, storeOpen: schoolStoreOpen })]
    : showVendorGroup
      ? [...baseNavigationGroups, getVendorNavGroup({ canSellProducts, canSellServices, verificationStatus, storeEnabled })]
      : baseNavigationGroups;

  // ── Escuelas que no cobran por SportMaps (CAR-2) ──────────────────────────
  // Club Carmel y los que vengan igual: las membresías se pagan en el club, así
  // que la cartera no existe y mostrarla es prometer algo que no opera.
  //
  // Se filtra por `href` y no por título: los títulos se repiten («Pagos» es a
  // la vez la cartera de la escuela y el historial del padre) y cambian con el
  // idioma, el href no.
  //
  // NO se toca `/mi-plan`: ese es lo que la escuela nos paga a NOSOTROS, y
  // justamente una escuela sin cartera propia sigue necesitando verlo. Tampoco
  // `/accounting`, que es contabilidad interna (egresos, nómina, proveedores) y
  // tiene su propio addon.
  const RUTAS_DE_COBRO = ['/payments-automation', '/finances', '/payment-reminders', '/my-payments'];

  // ── Deportes y categorías: solo cuando hay más de uno ─────────────────────
  // Una escuela de un solo deporte administra sus categorías dentro de «Crear
  // equipo», que es donde las usa. Darle una pantalla propia para un único
  // deporte es un ítem de menú que nadie abre dos veces.
  const esMultideporte = useIsMultiSport();
  const RUTAS_MULTIDEPORTE = ['/school-sports'];

  // ── Membresías: al revés que los cobros ───────────────────────────────────
  // La pantalla existe para clubes que cobran la membresía POR FUERA de
  // SportMaps (CAR-4), así que se muestra justo cuando los cobros están
  // apagados. Para una escuela que sí factura por acá es un ítem que no aplica.
  //
  // Ojo con el sentido de `hasBilling`: falla ABIERTO (es `true` mientras carga y
  // cuando el dato no llega), así que por defecto esto queda oculto — que es lo
  // correcto para una función de nicho. Se prende desde el super admin al
  // desactivar los cobros de la escuela.
  const RUTAS_DE_MEMBRESIA = ['/memberships'];

  const navigationGroups = useMemo(() => {
    const ocultas = [
      ...(hasBilling ? [] : RUTAS_DE_COBRO),
      ...(esMultideporte ? [] : RUTAS_MULTIDEPORTE),
      ...(hasBilling ? RUTAS_DE_MEMBRESIA : []),
    ];
    if (ocultas.length === 0) return navigationGroupsBase;
    const podar = (items: typeof navigationGroupsBase[number]['items']) =>
      items
        .filter(i => !i.href || !ocultas.includes(i.href))
        .map(i => (i.submenu
          ? { ...i, submenu: i.submenu.filter(s => !s.href || !ocultas.includes(s.href)) }
          : i))
        // Un submenú que se quedó sin hijos no debe seguir ocupando lugar.
        .filter(i => !i.submenu || i.submenu.length > 0);
    return navigationGroupsBase
      .map(g => ({ ...g, items: podar(g.items) }))
      .filter(g => g.items.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationGroupsBase, hasBilling, esMultideporte]);

  // ── Acordeon de grupos (roadmap I5) ──────────────────────────────────
  // Solo un grupo colapsable queda abierto a la vez; el primero ("Principal")
  // queda fijo. El grupo que contiene la ruta activa se abre solo para que el
  // usuario siempre sepa en que modulo esta. El estado se persiste por rol.
  const groupContainsPath = (group: (typeof navigationGroups)[number]) =>
    group.items.some(item =>
      (!!item.href && location.pathname.startsWith(item.href)) ||
      (item.submenu?.some(sub => !!sub.href && location.pathname.startsWith(sub.href)) ?? false)
    );

  const groupStorageKey = `sportmaps_sidebar_group_${navigationRole}`;
  const activeGroupTitle = useMemo(() => {
    const g = navigationGroups.find((grp, idx) => idx !== 0 && groupContainsPath(grp));
    return g?.title ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationGroups, location.pathname]);

  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    try { return localStorage.getItem(groupStorageKey); } catch { return null; }
  });

  // Al navegar a otro modulo, abre el grupo que lo contiene (acordeon).
  useEffect(() => {
    if (activeGroupTitle) setOpenGroup(activeGroupTitle);
  }, [activeGroupTitle]);

  const toggleGroup = (title: string) => {
    setOpenGroup(prev => {
      const next = prev === title ? null : title;
      try {
        if (next) localStorage.setItem(groupStorageKey, next);
        else localStorage.removeItem(groupStorageKey);
      } catch { /* localStorage no disponible */ }
      return next;
    });
  };

  // Misma regla que el avatar de la barra superior (lib/iniciales): nombre + apellido.
  const getUserInitials = () => inicialesPersona(profile.full_name, user?.email);

  const getRoleBadge = () => {
    // Platform-level admins SIEMPRE son Super Admin, sin importar contextos
    if (profile?.role === 'admin' || profile?.role === 'super_admin') {
      return 'Super Admin';
    }
    const roleToShow = effectiveRole;
    if (roleToShow === 'owner') return 'Propietario';
    if (roleToShow === 'reporter') return 'Auditoría';
    if (roleToShow === 'school_admin') {
      return isGlobalAdmin ? 'Admin General' : 'Admin Sede';
    }
    const roleLabels: Record<string, string> = {
      athlete: 'Deportista', parent: 'Acudiente', coach: 'Entrenador',
      school: 'Escuela', staff: 'Staff', wellness_professional: 'Bienestar',
      store_owner: 'Tienda', viewer: 'Visitante',
      personal_trainer: 'Entrenador Personal',
      facility_manager: 'Dueño de espacios',
    };
    return roleLabels[roleToShow as string] || roleToShow;
  };

  if (!profile || !user) return null;

  return (
    <Sidebar
      collapsible="icon"
      className="border-r border-border/40 bg-card/50 backdrop-blur-sm"
    >
      <SidebarHeader className="h-16 flex items-center px-4 overflow-hidden">
        {!isCollapsed ? (
          <div className="flex items-center gap-2 overflow-hidden w-full">
            <Logo size="sm" showName />
          </div>
        ) : (
          <div className="flex justify-center w-full">
            <Logo size="sm" />
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="px-2">
        {/* Avatar — visible siempre en mobile (nunca collapsed), solo en expanded en desktop */}
        {!isCollapsed && (
          <div className="flex flex-col items-center px-2 mb-4 mt-2 animate-in fade-in slide-in-from-top-4 duration-500">
            <Avatar className="h-14 w-14 sm:h-16 sm:w-16 mb-2 border-2 border-primary/20 shadow-lg shadow-primary/5">
              <AvatarImage src={profile.avatar_url || ''} />
              <AvatarFallback className="bg-gradient-to-br from-primary/10 to-primary/30 text-primary font-bold text-xl">
                {getUserInitials()}
              </AvatarFallback>
            </Avatar>
            <div className="text-center w-full overflow-hidden">
              <p className="font-bold text-sm truncate px-1">{profile.full_name || user?.email}</p>
              <div className="flex justify-center mt-1">
                <Badge variant="outline" className="text-[10px] py-0 h-4 border-primary/30 text-primary bg-primary/5 backdrop-blur-md">
                  {getRoleBadge()}
                </Badge>
              </div>
            </div>
            {/* Selector de sede (multisede S1) — ver NOTE junto al import. */}
            <BranchSelector className="mt-3 px-1" />
          </div>
        )}

        {navigationGroups.map((group, groupIdx) => {
          // El primer grupo ("Principal") queda fijo; el resto es acordeon.
          // En modo icono (collapsed) todo se muestra, sin colapsar.
          const isPinned = groupIdx === 0;
          const collapsible = !isPinned && !isCollapsed;
          const groupOpen = !collapsible || openGroup === group.title;
          const groupHasActive = groupContainsPath(group);
          return (
          <SidebarGroup key={groupIdx}>
            {collapsible ? (
              <button
                type="button"
                onClick={() => toggleGroup(group.title)}
                className="flex items-center w-full text-muted-foreground/50 text-[10px] uppercase tracking-widest font-bold px-4 mb-2 py-1 rounded-md hover:text-foreground hover:bg-primary/5 transition-colors cursor-pointer"
              >
                <span className="truncate">{group.title}</span>
                {!groupOpen && groupHasActive && (
                  <span className="ml-2 h-1.5 w-1.5 rounded-full bg-primary shrink-0 animate-in fade-in" />
                )}
                <ChevronDown className={`ml-auto h-3 w-3 shrink-0 transition-transform duration-200 ${groupOpen ? '' : '-rotate-90'}`} />
              </button>
            ) : (
              <SidebarGroupLabel className="text-muted-foreground/50 text-[10px] uppercase tracking-widest font-bold px-4 mb-2">
                {!isCollapsed ? group.title : ''}
              </SidebarGroupLabel>
            )}
            {groupOpen && (
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item, itemIdx) => {
                  // Submenu item — collapsible parent
                  if (item.submenu && item.submenu.length > 0) {
                    const submenuKey = `${groupIdx}-${itemIdx}`;
                    const isSubmenuActive = item.submenu.some(sub => sub.href && location.pathname.startsWith(sub.href));
                    const isOpen = openSubmenus[submenuKey] ?? isSubmenuActive;

                    // En modo icono el acordeon no tiene donde pintar los hijos
                    // (el bloque de abajo esta condicionado a !isCollapsed): el
                    // boton quedaba vivo pero sin efecto. Con la sidebar colapsada
                    // se resuelve con un flyout (DropdownMenu) en vez del toggle.
                    return (
                      <div key={itemIdx}>
                        <SidebarMenuItem>
                          {isCollapsed ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <SidebarMenuButton
                                  tooltip={item.title}
                                  className="group/menu-button transition-all duration-300 hover:bg-primary/5 active:scale-95 cursor-pointer"
                                >
                                  <div className={`flex items-center gap-3 w-full ${isSubmenuActive ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>
                                    <item.icon className={`h-4 w-4 shrink-0 transition-transform duration-300 group-hover/menu-button:scale-110 ${isSubmenuActive ? 'text-primary' : ''}`} />
                                    <span className="sr-only">{item.title}</span>
                                  </div>
                                </SidebarMenuButton>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="right" align="start" className="min-w-48">
                                <DropdownMenuLabel>{item.title}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {item.submenu.map((sub, subIdx) => (
                                  <DropdownMenuItem key={subIdx} asChild>
                                    <NavLink
                                      to={sub.href || '#'}
                                      onClick={() => isMobile && setOpenMobile(false)}
                                      className={({ isActive }) =>
                                        `flex items-center gap-2 w-full cursor-pointer ${isActive ? 'text-primary font-semibold' : ''}`
                                      }
                                    >
                                      <sub.icon className="h-3.5 w-3.5 shrink-0" />
                                      <span className="truncate text-sm">{sub.title}</span>
                                    </NavLink>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <SidebarMenuButton
                              tooltip={item.title}
                              className="group/menu-button transition-all duration-300 hover:bg-primary/5 active:scale-95 cursor-pointer"
                              onClick={() => setOpenSubmenus(prev => ({ ...prev, [submenuKey]: !isOpen }))}
                            >
                              <div className={`flex items-center gap-3 w-full ${isSubmenuActive ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'}`}>
                                <item.icon className={`h-4 w-4 shrink-0 transition-transform duration-300 group-hover/menu-button:scale-110 ${isSubmenuActive ? 'text-primary' : ''}`} />
                                <span className="truncate">{item.title}</span>
                                <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                              </div>
                            </SidebarMenuButton>
                          )}
                        </SidebarMenuItem>
                        {isOpen && !isCollapsed && (
                          <div className="ml-4 pl-3 border-l border-border/30 space-y-0.5 mt-0.5 mb-1 animate-in slide-in-from-top-2 duration-200">
                            {item.submenu.map((sub, subIdx) => (
                              <SidebarMenuItem key={subIdx}>
                                <SidebarMenuButton
                                  asChild
                                  className="group/menu-button transition-all duration-300 hover:bg-primary/5 active:scale-95 h-8"
                                >
                                  <NavLink
                                    to={sub.href || '#'}
                                    onClick={() => isMobile && setOpenMobile(false)}
                                    className={({ isActive }) =>
                                      `flex items-center gap-3 w-full transition-all duration-300 ${isActive ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'}`
                                    }
                                  >
                                    {({ isActive }) => (
                                      <>
                                        <sub.icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-primary' : ''}`} />
                                        <span className="truncate text-sm">{sub.title}</span>
                                        {isActive && (
                                          <div className="absolute right-0 w-1 h-4 bg-primary rounded-l-full animate-in fade-in zoom-in duration-300" />
                                        )}
                                      </>
                                    )}
                                  </NavLink>
                                </SidebarMenuButton>
                              </SidebarMenuItem>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Regular item — NavLink
                  return (
                    <SidebarMenuItem key={itemIdx}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.title}
                        className="group/menu-button transition-all duration-300 hover:bg-primary/5 active:scale-95"
                      >
                        <NavLink
                          to={item.href || '#'}
                          onClick={() => isMobile && setOpenMobile(false)}
                          className={({ isActive }) =>
                            `flex items-center gap-3 w-full transition-all duration-300 ${isActive ? 'text-primary font-semibold' : 'text-muted-foreground hover:text-foreground'
                            }`
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <item.icon className={`h-4 w-4 shrink-0 transition-transform duration-300 group-hover/menu-button:scale-110 ${isActive ? 'text-primary' : ''}`} />
                              <span className={`truncate ${isCollapsed ? 'sr-only' : ''}`}>{item.title}</span>
                              {item.badge && !isCollapsed && (
                                <Badge className="ml-auto h-4 px-1 min-w-[1.2rem] flex items-center justify-center text-[10px] bg-accent/80 hover:bg-accent">
                                  {item.badge}
                                </Badge>
                              )}
                              {isActive && !isCollapsed && (
                                <div className="absolute right-0 w-1 h-5 bg-primary rounded-l-full animate-in fade-in zoom-in duration-300" />
                              )}
                            </>
                          )}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            )}
          </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="p-4 border-t border-border/40">
        {/* Persona multirol: cambiar de rol (spec cambio-de-rol-atleta-acudiente.md). */}
        {roleContexts.length > 0 && (
          <Button
            asChild
            variant="ghost"
            className="w-full justify-start transition-all duration-300"
          >
            <NavLink to="/elegir-rol" onClick={() => isMobile && setOpenMobile(false)}>
              <Repeat className="h-4 w-4 shrink-0" />
              <span className={`ml-3 truncate ${isCollapsed ? 'sr-only' : ''}`}>
                Cambiar de rol{activeRoleContext ? ` · ${activeRoleContext.label}` : ''}
              </span>
            </NavLink>
          </Button>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10 transition-all duration-300"
          onClick={() => signOut()}
        >
          <LogOut className="h-4 w-4 shrink-0 transition-transform" />
          <span className={`ml-3 ${isCollapsed ? 'sr-only' : ''}`}>Cerrar Sesión</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
