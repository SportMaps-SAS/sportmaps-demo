import { NavLink, useLocation } from 'react-router-dom';
import { Home, Calendar, Building, DollarSign, MessageSquare, User, Compass, Users, CreditCard, Baby, Settings, Trophy, Activity, ShoppingBag, MoreHorizontal, ClipboardList, CheckSquare, TrendingUp, IdCard } from 'lucide-react';
import { SHOW_EXPLORE, ACUDIENTE_V2, ENTRENADOR_V2, DEPORTISTA_V2 } from '@/lib/feature-flags';
import { PESTANAS_ACUDIENTE, PESTANAS_ENTRENADOR, PESTANAS_DEPORTISTA, pestanasDeRol } from '@/lib/acudienteTabs';
import { useAuth } from '@/contexts/AuthContext';
import { useRolActivo } from '@/hooks/useRolActivo';
import { cn } from '@/lib/utils';
import { useMySchoolStore } from '@/hooks/useMySchoolStore';
import { BUYER_ROLES } from '@/lib/store/buyerStoreVisibility';

// «Tienda» del comprador: solo si la tienda de SU escuela activa vende
// (useMySchoolStore → store_seller_allowed), nunca por el flag global solo.
const ICONOS_ACUDIENTE: Record<string, typeof Home> = {
  '/dashboard': Home, '/calendar': Calendar, '/children': Baby, '/my-payments': CreditCard, '/mas': MoreHorizontal,
};

// Íconos de las pestañas V2 de entrenador y deportista (por ruta).
const ICONOS_V2: Record<string, typeof Home> = {
  '/dashboard': Home, '/teams': Users, '/training-plans': ClipboardList, '/coach-attendance': CheckSquare,
  '/training': Activity, '/stats': TrendingUp, '/my-cards': IdCard, '/mas': MoreHorizontal,
};

const TIENDA_ITEM = { href: '/mi-tienda', label: 'Tienda', icon: ShoppingBag };

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
  /** Rutas que también encienden la pestaña (las pantallas que viven dentro de ella). */
  also?: string[];
}

const getNavigationItemsForRole = (role: string, showStore = false): NavItem[] => {
  switch (role) {
    // Acudiente V2 (docs/specs/modulos-v2-definicion.md §4): cinco pestañas
    // fijas y la quinta siempre es «Más». Tienda, inscripciones, carnets, salud
    // y ajustes viven dentro de «Más»; Mensajes salió (0 mensajes en la
    // historia: se habla con el club por WhatsApp).
    case 'parent':
      // Con VITE_ACUDIENTE_V2=false vuelve la barra anterior, tal cual.
      if (!ACUDIENTE_V2) {
        return [
          { href: '/dashboard', label: 'Inicio', icon: Home },
          ...(SHOW_EXPLORE ? [{ href: '/explorar', label: 'Explorar', icon: Compass }] : []),
          { href: '/children', label: 'Hijos', icon: Baby },
          { href: '/my-payments', label: 'Pagos', icon: CreditCard },
          ...(showStore ? [TIENDA_ITEM] : []),
          { href: '/messages', label: 'Chat', icon: MessageSquare },
        ];
      }
      // Pestañas y rutas internas: una sola fuente (lib/acudienteTabs), la misma del «Volver».
      return PESTANAS_ACUDIENTE.map((p) => ({ ...p, icon: ICONOS_ACUDIENTE[p.href] ?? Home }));
    case 'school':
      return [
        { href: '/dashboard', label: 'Inicio', icon: Home },
        { href: '/students', label: 'Alumnos', icon: Users },
        { href: '/payments-automation', label: 'Pagos', icon: CreditCard },
        // «Chat» de la escuela = Comunicaciones (/messages). El acceso al WhatsApp
        // de la escuela (o a activarlo) vive dentro de esa pantalla, no en la barra.
        { href: '/messages', label: 'Chat', icon: MessageSquare, also: ['/whatsapp'] },
        { href: '/settings', label: 'Config', icon: Settings },
      ];
    // Dueño de espacios (facility_manager): menú corto de alquiler, sin atletas
    // ni equipos. Mismas cuatro entradas del menú lateral.
    case 'facility_manager':
      return [
        { href: '/venue/dashboard', label: 'Inicio', icon: Home },
        { href: '/facilities', label: 'Canchas', icon: Building },
        { href: '/venue/reservas', label: 'Reservas', icon: Calendar },
        { href: '/venue/cobros', label: 'Cobros', icon: DollarSign },
        { href: '/school-config', label: 'Config', icon: Settings },
      ];
    case 'coach':
      // Entrenador V2: Hoy · Equipos · Sesiones · Asistencia · Más. Con VITE_ENTRENADOR_V2=false, la anterior.
      if (ENTRENADOR_V2) return PESTANAS_ENTRENADOR.map((p) => ({ ...p, icon: ICONOS_V2[p.href] ?? Home }));
      return [
        { href: '/dashboard', label: 'Inicio', icon: Home },
        { href: '/coach-attendance', label: 'Asistencias', icon: Calendar },
        { href: '/teams', label: 'Equipos', icon: Users },
        { href: '/messages', label: 'Chat', icon: MessageSquare },
        { href: '/profile', label: 'Perfil', icon: User },
      ];
    case 'athlete':
      // Deportista V2: Hoy · Entrenos · Progreso · Carnet · Más. Con VITE_DEPORTISTA_V2=false, la anterior.
      if (DEPORTISTA_V2) return PESTANAS_DEPORTISTA.map((p) => ({ ...p, icon: ICONOS_V2[p.href] ?? Home }));
      return [
        { href: '/dashboard', label: 'Inicio', icon: Home },
        { href: '/enrollments', label: 'Mis inscripciones', icon: Trophy },
        { href: '/training', label: 'Entrenamientos', icon: Activity },
        ...(showStore ? [TIENDA_ITEM] : []),
        { href: '/profile', label: 'Perfil', icon: User },
      ];
    default:
      return [
        { href: '/dashboard', label: 'Inicio', icon: Home },
        { href: '/calendar', label: 'Calendario', icon: Calendar },
        { href: '/messages', label: 'Mensajes', icon: MessageSquare },
        { href: '/profile', label: 'Perfil', icon: User },
      ];
  }
};

export function MobileBottomNav() {
  const { profile } = useAuth();
  const rolActivo = useRolActivo();
  const location = useLocation();
  const { showStore } = useMySchoolStore({ enabled: !!profile && BUYER_ROLES.has(profile.role) });

  if (!profile) {
    return null;
  }

  // No mostrar en páginas de auth, landing o durante el onboarding/setup
  if (
    ['/', '/login', '/register', '/demo-welcome', '/recepcion'].includes(location.pathname) ||
    location.pathname.includes('/onboarding') ||
    location.pathname.includes('/setup') ||
    // Tienda (vitrina, ficha, carrito, checkout): pantallas de compra con su
    // propia barra fija abajo (carrito / Comprar / Pagar). La barra de la app
    // encima tapaba el botón de pagar en móvil (informe tienda-baseline §1.5).
    location.pathname.startsWith('/tienda/') ||
    location.pathname.startsWith('/checkout') ||
    location.pathname === '/carrito' ||
    // Páginas públicas del torneo (en vivo, partido, link del delegado,
    // validar carné) y el anotador: la barra del rol tapaba sus botones.
    location.pathname.startsWith('/torneo/') ||
    location.pathname.startsWith('/anotador/')
  ) {
    return null;
  }

  // Multirol: el rol activo, el mismo con el que decide el Inicio y el «Volver».
  // useRolActivo devuelve la membresía ('owner') para un perfil que no es de
  // escuela: el dueño de espacios conserva su rol de perfil o vería la barra genérica.
  const rol = ((profile.role as string) === 'facility_manager' ? 'facility_manager' : (rolActivo ?? profile.role)) as typeof profile.role;
  const navigationItems = getNavigationItemsForRole(rol, showStore);
  // Barras V2 (cinco pestañas que se reparten el ancho y se encogen con el zoom).
  const compacta = !!pestanasDeRol(rol);

  return (
    <nav data-testid="mobile-bottom-nav" className="fixed bottom-0 left-0 right-0 z-30 bg-background border-t border-border md:hidden safe-area-bottom">
      <div className="flex items-center justify-around h-16 px-2">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          // El href puede traer query (?tab=…): se compara solo la ruta.
          const ruta = item.href.split('?')[0];
          const isActive = location.pathname === ruta ||
            (ruta !== '/dashboard' && location.pathname.startsWith(ruta)) ||
            !!item.also?.some((r) => location.pathname.startsWith(r));

          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={cn(
                'flex flex-col items-center justify-center gap-1 py-2 rounded-lg transition-all duration-200',
                // Acudiente V2: cinco pestañas que se reparten el ancho y se
                // encogen con el zoom (a 200 % «Más» quedaba fuera de la pantalla).
                // Los demás roles conservan su medida de siempre.
                compacta ? 'min-w-0 flex-1 px-1' : 'px-3 min-w-14',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <div className={cn(
                'relative p-1.5 rounded-full transition-all duration-200',
                isActive && 'bg-primary/10'
              )}>
                <Icon className={cn(
                  'h-5 w-5 transition-transform',
                  isActive && 'scale-110'
                )} />
                {isActive && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#FB9F1E] rounded-full" />
                )}
              </div>
              <span className={cn(
                'text-[10px] font-poppins font-medium',
                compacta && 'max-w-full truncate',
                isActive && 'font-semibold'
              )}>
                {item.label}
              </span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
