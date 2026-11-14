import {
  Home,
  Calendar,
  Landmark,
  Sparkles,
  PieChart,
  Users,
  Trophy,
  Award,
  BarChart3,
  Settings,
  Bell,
  ShoppingBag,
  Heart,
  Building,
  Activity,
  Target,
  BookOpen,
  MapPin,
  MessageSquare,
  FileText,
  DollarSign,
  Plus,
  Map,
  Ticket,
  Car,
  Send,
  GraduationCap,
  Dumbbell,
  User,
  ClipboardList,
  IdCard,
  FileCheck2,
  QrCode,
  Truck,
  ShieldCheck,
  CreditCard,
  MonitorSpeaker,
  History,
  TrendingUp,
  ShieldAlert,
  Clock,
  ClipboardCheck,
  Tag,
  MoreHorizontal
} from 'lucide-react';
import { UserRole } from '@/types/dashboard';
import { SHOW_EXPLORE, ACUDIENTE_V2, ENTRENADOR_V2, DEPORTISTA_V2 } from '@/lib/feature-flags';
import type { AddonKey } from '@/config/saas-plans';
import type { ModuleKey } from '@/config/module-catalog';
import { BUYER_STORE_HIDDEN, type BuyerStoreVisibility } from '@/lib/store/buyerStoreVisibility';

export interface NavItem {
  title: string;
  href?: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  description?: string;
  submenu?: NavItem[];
  /** Si la escuela no tiene este addon, el ítem (o el grupo entero, si queda vacío) se oculta. */
  addon?: AddonKey;
  /**
   * Inverso de `addon`: el ítem se oculta si la escuela SÍ tiene este otro
   * addon. Sirve para no duplicar en el menú una función que ya vive
   * integrada dentro de un módulo más grande (ej. Facturación electrónica
   * standalone se oculta cuando ya hay Contabilidad completa, porque ahí
   * aparece como pestaña).
   */
  hideIfAddon?: AddonKey;
  /**
   * Override UX-only del Super Admin (tabla `school_module_overrides`,
   * catálogo en `module-catalog.ts`). Independiente de `addon`: si el ítem
   * tiene los dos, la visibilidad efectiva es `hasAddon AND isModuleEnabled`.
   */
  moduleKey?: ModuleKey;
  /**
   * Pertenece a la tienda (productos, carrito, pedidos, inventario, envíos,
   * liquidaciones). Se oculta mientras `store_enabled()` sea false — flag
   * global de plataforma, independiente del addon `store` de la escuela.
   * Spec: docs/specs/blindaje-dinero-pagos-tienda-nomina.md §1.3.
   */
  requiresStore?: boolean;
  /**
   * Entrada del COMPRADOR (padre / atleta) a la tienda de SU escuela. No basta
   * el flag global: con el piloto (allowlist) prendido, solo la escuela cuya
   * tienda vende ve «Tienda». 'store' = la escuela vende; 'purchases' = la
   * escuela vende o el usuario ya tiene pedidos. Ver
   * lib/store/buyerStoreVisibility.ts y hooks/useMySchoolStore.ts.
   */
  buyerStore?: 'store' | 'purchases';
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * "Mi Tienda" — grupo de navegación adicional que se renderiza al final
 * del sidebar SOLO para usuarios con vendor_profile activo (cualquier rol).
 * No depende del rol principal. Lo monta AppSidebar.
 */
export function getVendorNavGroup(opts: {
  canSellProducts: boolean;
  canSellServices: boolean;
  verificationStatus: 'pending' | 'verified' | 'rejected' | null;
  /** Flag global de la tienda. Default false (fail-closed). */
  storeEnabled?: boolean;
  /**
   * Tienda de la ESCUELA (owner / school_admin): «Tu tienda», sin términos de
   * vendedor ni marketplace, sin Liquidaciones ni Verificación (la escuela
   * cobra con sus cuentas, D-5, y no se verifica, D-4). `storeOpen=false` =
   * todavía sin activar: solo el acceso a Ajustes, donde se activa.
   */
  isSchool?: boolean;
  storeOpen?: boolean;
}): NavGroup {
  if (opts.isSchool) {
    const schoolItems: NavItem[] = opts.storeOpen
      ? [
          { title: 'Pedidos',            href: '/orders',                 icon: FileText, requiresStore: true },
          { title: 'Productos',          href: '/vendor/products',        icon: ShoppingBag, requiresStore: true },
          { title: 'Inventario',         href: '/inventory',              icon: ClipboardList, requiresStore: true },
          { title: 'Cobros y entrega',   href: '/tienda-escuela/ajustes', icon: DollarSign, requiresStore: true },
          { title: 'Cupones',            href: '/tienda-escuela/cupones', icon: Tag, requiresStore: true },
        ]
      : [{ title: 'Activar tienda', href: '/tienda-escuela/ajustes', icon: ShoppingBag, requiresStore: true }];
    return { title: 'Tu tienda', items: filterByStore(schoolItems, opts.storeEnabled ?? false) };
  }

  const items: NavItem[] = [
    { title: 'Panel Tienda', href: '/vendor/dashboard', icon: ShoppingBag },
  ];

  if (opts.canSellProducts) {
    items.push({ title: 'Productos',  href: '/vendor/products',  icon: ShoppingBag, requiresStore: true });
    items.push({ title: 'Inventario', href: '/inventory',        icon: ClipboardList, requiresStore: true });
  }
  if (opts.canSellServices) {
    items.push({ title: 'Servicios',  href: '/vendor/services',  icon: Activity });
    items.push({ title: 'Agenda',     href: '/vendor/appointments', icon: Calendar });
  }
  items.push({ title: 'Pedidos',         href: '/orders',           icon: FileText, requiresStore: true });
  items.push({ title: 'Inbox',           href: '/vendor/inbox',     icon: MessageSquare, requiresStore: true });
  items.push({ title: 'Liquidaciones',   href: '/vendor/payouts',   icon: DollarSign, requiresStore: true });
  items.push({ title: 'Envíos',          href: '/vendor/shipping',  icon: Truck, requiresStore: true });
  items.push({ title: 'Promociones',     href: '/vendor/promotions', icon: Plus, requiresStore: true });
  items.push({
    title: 'Verificación',
    href:  '/vendor/onboarding',
    icon:  FileCheck2,
    badge: opts.verificationStatus === 'pending' ? 'pendiente'
         : opts.verificationStatus === 'rejected' ? 'revisar'
         : undefined,
  });

  const storeEnabled = opts.storeEnabled ?? false;
  // Con la tienda apagada queda lo de servicios (wellness/coach): panel,
  // servicios, agenda y verificación. AppSidebar decide si el grupo se monta.
  return {
    title: storeEnabled ? 'Mi Tienda' : 'Mis Servicios',
    items: filterByStore(items, storeEnabled),
  };
}

// ── "Gestión Deportiva" (school / school_admin) ─────────────────────────
// Única fuente para las dos: comparten exactamente las mismas rutas, y las
// dos versiones ya habían divergido (a school_admin le faltaba "Métricas y
// Rendimiento" aunque routePermissions.ts sí lo autoriza). "Entrenamiento"
// agrupa Métricas+Rutinas igual que ya hacían "Equipos y Planes" y
// "Asistencias". "Mis Torneos" NO se agrupa con "Resultados": es su propio
// módulo (`MOD-7` en el roadmap — inscripción + bracket + motor de puntaje,
// con rutas propias /school/tournaments, /new, /:id), no un simple listado.
const GESTION_DEPORTIVA_ESCUELA: NavItem[] = [
  // Primero: la pregunta del dueño es "¿mis entrenadores están trabajando?"
  // (spec rediseno-seguimiento-deportivo F4). Solo lectura.
  { title: 'Seguimiento deportivo', href: '/seguimiento-deportivo', icon: ClipboardCheck },
  // Atajo: abre Seguimiento deportivo en modo calificar (sin ruta nueva).
  { title: 'Calificar entrenadores', href: '/seguimiento-deportivo?calificar=1', icon: Award },
  {
    title: 'Equipos y Planes',
    icon: Users,
    moduleKey: 'gestion_deportiva_equipos_planes',
    submenu: [
      { title: 'Mis Equipos', href: '/teams', icon: Users },
      { title: 'Deportes y Categorías', href: '/school-sports', icon: Trophy },
      { title: 'Membresías', href: '/memberships', icon: IdCard },
      { title: 'Mis Planes', href: '/offerings', icon: FileText }
    ]
  },
  { title: 'Calendario', href: '/calendar', icon: Calendar, moduleKey: 'gestion_deportiva_calendario' },
  {
    title: 'Entrenamiento',
    icon: Activity,
    submenu: [
      { title: 'Métricas y Rendimiento', href: '/training-plans', icon: Activity, moduleKey: 'gestion_deportiva_entrenamiento_metricas' },
      { title: 'Gestión de Rutinas', href: '/school/routines', icon: Dumbbell, moduleKey: 'gestion_deportiva_entrenamiento_rutinas' },
    ]
  },
  { title: 'Informe Mensual', href: '/informe-mensual', icon: FileText, moduleKey: 'gestion_deportiva_informe_mensual' },
  {
    title: 'Asistencias',
    icon: BarChart3,
    submenu: [
      { title: 'Supervisión', href: '/attendance-supervision', icon: BarChart3 },
      { title: 'Planillas por revisar', href: '/school/attendance-sheets', icon: ClipboardList },
      { title: 'Histórico', href: '/attendance-history', icon: History },
      { title: 'Encuestas', href: '/dashboard/polls', icon: ClipboardList },
    ],
  },
  // Resultados = los partidos de la escuela (/results): cada uno abre la
  // pantalla del partido. /results-overview (feed de medallas de demostración,
  // pensado para cheer) sale del menú pero la ruta se conserva.
  { title: 'Resultados', href: '/results', icon: Trophy },
  {
    title: 'Torneos', icon: Trophy, addon: 'tournaments',
    submenu: [
      { title: 'Mis Torneos', href: '/school/tournaments', icon: Trophy },
      { title: 'Crear torneo', href: '/school/tournaments/nuevo-rapido', icon: Plus },
    ],
  },
  { title: 'Dotación', href: '/school/equipment', icon: Dumbbell },
  // Solo disponibilidad (disponible / restringido / no disponible) que el
  // profesional de salud y la familia autorizaron compartir; nunca diagnóstico.
  { title: 'Disponibilidad médica', href: '/disponibilidad-medica', icon: Heart },
];

/**
 * Filtra por addon (UX-3): un ítem con `addon` desaparece si la escuela no lo
 * tiene. Si un ítem tenía `submenu` y todos sus hijos quedaron filtrados, el
 * ítem completo se oculta en vez de mostrar un padre sin hijos.
 */
function filterByAddon(items: NavItem[], hasAddon: (key: AddonKey) => boolean): NavItem[] {
  return items
    .filter(item => !item.addon || hasAddon(item.addon))
    .filter(item => !item.hideIfAddon || !hasAddon(item.hideIfAddon))
    .map(item => item.submenu ? { ...item, submenu: filterByAddon(item.submenu, hasAddon) } : item)
    .filter(item => !item.submenu || item.submenu.length > 0);
}

/**
 * Filtra por override de módulo del Super Admin (`school_module_overrides`).
 * Capa independiente de `filterByAddon`, misma poda de submenú huérfano.
 * `isModuleEnabled` ya resuelve "heredado o forzado ON = visible", así que
 * acá solo hace falta preguntar.
 */
function filterByModuleOverride(items: NavItem[], isModuleEnabled: (key: ModuleKey) => boolean): NavItem[] {
  return items
    .filter(item => !item.moduleKey || isModuleEnabled(item.moduleKey))
    .map(item => item.submenu ? { ...item, submenu: filterByModuleOverride(item.submenu, isModuleEnabled) } : item)
    .filter(item => !item.submenu || item.submenu.length > 0);
}

/**
 * Filtra la tienda (flag global `store_enabled()`): con la tienda apagada,
 * todo ítem `requiresStore` desaparece. Misma poda de submenú huérfano.
 */
function filterByStore(items: NavItem[], storeEnabled: boolean): NavItem[] {
  if (storeEnabled) return items;
  return items
    .filter(item => !item.requiresStore)
    .map(item => item.submenu ? { ...item, submenu: filterByStore(item.submenu, storeEnabled) } : item)
    .filter(item => !item.submenu || item.submenu.length > 0);
}

/**
 * Entradas del comprador (`buyerStore`): se ocultan salvo que la escuela activa
 * del usuario venda (o, para «Mis compras», que ya tenga pedidos).
 */
function filterByBuyerStore(items: NavItem[], buyer: BuyerStoreVisibility): NavItem[] {
  return items
    .filter(item =>
      !item.buyerStore
      || (item.buyerStore === 'store' ? buyer.showStore : buyer.showMyPurchases))
    .map(item => item.submenu ? { ...item, submenu: filterByBuyerStore(item.submenu, buyer) } : item)
    .filter(item => !item.submenu || item.submenu.length > 0);
}

/**
 * Returns navigation structure based on user role. `hasAddon` es opcional
 * (default: todo visible) para no romper si algún caller no lo pasa —
 * `AppSidebar.tsx` sí lo pasa siempre, con el `hasAddon` de `useEntitlements()`.
 */
/** Rol de menú: los de `UserRole` más el dueño de espacios (facility_manager). */
export type NavRole = UserRole | 'facility_manager';

export function getNavigationByRole(
  role: NavRole,
  hasAddon: (key: AddonKey) => boolean = () => true,
  isModuleEnabled: (key: ModuleKey) => boolean = () => true,
  /** Flag global de la tienda. Default false: fail-closed, como el hook. */
  storeEnabled: boolean = false,
  /** Tienda de la escuela activa para el comprador. Default: oculta (fail-closed). */
  buyerStore: BuyerStoreVisibility = BUYER_STORE_HIDDEN,
  /** Menú clásico del coach aunque la V2 esté encendida (perfil de escuela que entra a una sede como coach). */
  coachClasico: boolean = false,
): NavGroup[] {
  const baseNav: NavGroup = {
    title: 'Principal',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: Home },
      { title: 'Notificaciones', href: '/notifications', icon: Bell, badge: '3' },
      { title: 'Configuración', href: '/settings', icon: Settings }
    ]
  };

  const roleSpecificNav: Record<NavRole, NavGroup[]> = {
    // Dueño de espacios (facility_manager, escuela school_type 'venue'): menú
    // corto de alquiler. Sin atletas, equipos, asistencia ni planes.
    // Spec: docs/specs/reservas-canchas-plan-unificado-2026-10.md §6.1 y §7.
    facility_manager: [
      {
        title: 'Mi espacio',
        items: [
          { title: 'Inicio', href: '/venue/dashboard', icon: Home },
          { title: 'Instalaciones', href: '/facilities', icon: Building, moduleKey: 'sedes_instalaciones' },
          { title: 'Reservas', href: '/venue/reservas', icon: Calendar },
          { title: 'Cobros', href: '/venue/cobros', icon: DollarSign },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Notificaciones', href: '/notifications', icon: Bell },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/school-config', icon: Settings }
        ]
      }
    ],

    // Deportista V2 (docs/specs/entrenador-deportista-v2.md): las cinco de la
    // barra más la tienda si la escuela vende; lo demás vive en «Más».
    // Con VITE_DEPORTISTA_V2=false vuelve el menú anterior, tal cual.
    athlete: DEPORTISTA_V2 ? [
      {
        title: 'Principal',
        items: [
          { title: 'Hoy', href: '/dashboard', icon: Home },
          { title: 'Entrenos', href: '/training', icon: Activity },
          { title: 'Progreso', href: '/stats', icon: BarChart3 },
          { title: 'Carnet', href: '/my-cards', icon: IdCard },
          { title: 'Tienda', href: '/mi-tienda', icon: ShoppingBag, requiresStore: true, buyerStore: 'store' },
          { title: 'Mis compras', href: '/mis-compras', icon: ClipboardList, requiresStore: true, buyerStore: 'purchases' },
          { title: 'Más', href: '/mas', icon: MoreHorizontal }
        ]
      }
    ] : [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Mi Calendario', href: '/calendar', icon: Calendar },
          { title: 'Mis Pagos', href: '/athlete-payments', icon: DollarSign },
          ...(SHOW_EXPLORE ? [{ title: 'Explorar', href: '/explorar', icon: MapPin }] : []),
        ]
      },
      {
        title: 'Mi Rendimiento',
        items: [
          { title: 'Estadísticas', href: '/stats', icon: BarChart3 },
          { title: 'Objetivos', href: '/goals', icon: Target },
          { title: 'Entrenamientos', href: '/training', icon: Activity }
        ]
      },
      {
        title: 'Actividad Deportiva',
        items: [
          { title: 'Mis Inscripciones', href: '/enrollments', icon: Trophy },
          { title: 'Mis Eventos', href: '/my-event-registrations', icon: Calendar },
        ]
      },
      {
        title: 'Bienestar',
        items: [
          { title: 'Mi Salud', href: '/salud', icon: Heart },
          { title: 'Mis Citas', href: '/wellness/appointments', icon: Calendar },
          { title: 'Explorar Bienestar', href: '/wellness', icon: Activity },
        ]
      },
      {
        // Antes «Catálogo» → /shop (catálogo global de la plataforma, solo con
        // el flag): con el piloto prendido lo veían atletas de todas las
        // escuelas. Ahora, igual que el padre: la tienda de SU escuela.
        title: 'Tienda',
        items: [
          { title: 'Tienda', href: '/mi-tienda', icon: ShoppingBag, requiresStore: true, buyerStore: 'store' },
          { title: 'Mis compras', href: '/mis-compras', icon: ClipboardList, requiresStore: true, buyerStore: 'purchases' },
        ]
      },
      {
        title: 'Documentos',
        items: [
          { title: 'Mis Carnets', href: '/my-cards', icon: IdCard },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          // Sin 'Facturación': /mi-plan es el plan SaaS que la ESCUELA le paga a
          // SportMaps. Un atleta no lo administra y no debe ver ni el tier ni el
          // conteo de alumnos activos de la escuela.
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      },
    ],

    // Acudiente V2 (docs/specs/modulos-v2-definicion.md §4): las mismas cinco
    // entradas de la barra del celular, más la tienda cuando la escuela vende.
    // Nada se pierde: progreso, asistencia e informes viven en Hijos; Mis
    // eventos y la vista de mes en Calendario; mensajes, inscripciones,
    // carnets, constancias, salud, citas y ajustes en Más.
    // Con VITE_ACUDIENTE_V2=false vuelve el menú anterior, tal cual.
    parent: ACUDIENTE_V2 ? [
      {
        title: 'Principal',
        items: [
          { title: 'Inicio', href: '/dashboard', icon: Home },
          { title: 'Calendario', href: '/calendar', icon: Calendar },
          { title: 'Hijos', href: '/children', icon: Users },
          { title: 'Pagos', href: '/my-payments', icon: DollarSign },
          { title: 'Tienda', href: '/mi-tienda', icon: ShoppingBag, requiresStore: true, buyerStore: 'store' },
          { title: 'Mis compras', href: '/mis-compras', icon: ClipboardList, requiresStore: true, buyerStore: 'purchases' },
          { title: 'Más', href: '/mas', icon: MoreHorizontal }
        ]
      }
    ] : [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Mis Hijos', href: '/children', icon: Users },
          { title: 'Calendario Familiar', href: '/calendar', icon: Calendar }
        ]
      },
      ...(SHOW_EXPLORE ? [{
        title: 'Explorar',
        items: [
          { title: 'Explorar', href: '/explorar', icon: MapPin },
        ]
      }] : []),
      {
        title: 'Seguimiento',
        items: [
          { title: 'Progreso Deportivo', href: '/academic-progress', icon: BookOpen },
          { title: 'Asistencias', href: '/parent-attendance', icon: BarChart3 },
          { title: 'Pagos', href: '/my-payments', icon: DollarSign },
          { title: 'Tienda', href: '/mi-tienda', icon: ShoppingBag, requiresStore: true, buyerStore: 'store' },
          { title: 'Mis compras', href: '/mis-compras', icon: ClipboardList, requiresStore: true, buyerStore: 'purchases' }
        ]
      },
      {
        title: 'Mi Actividad',
        items: [
          { title: 'Mensajes', href: '/messages', icon: MessageSquare },
          { title: 'Mis Inscripciones', href: '/enrollments', icon: Trophy },
          { title: 'Mis Eventos', href: '/my-event-registrations', icon: Calendar },
          { title: 'Salud de mis hijos', href: '/salud', icon: Heart },
          { title: 'Mis Citas', href: '/wellness/appointments', icon: Calendar },
          { title: 'Carnets de mis hijos', href: '/my-cards', icon: IdCard },
          { title: 'Mis Constancias', href: '/my-certificates', icon: FileCheck2 },
          // Sin 'Facturación': /mi-plan es el plan SaaS de la escuela, no del padre.
          // Sus propios cobros están en 'Pagos' (/my-payments).
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      }
    ],

    // Entrenador V2 (docs/specs/entrenador-deportista-v2.md): las cinco de la
    // barra; agenda, rutinas, dotación, informes, mensajes… viven en «Más».
    // Con VITE_ENTRENADOR_V2=false vuelve el menú anterior, tal cual.
    coach: ENTRENADOR_V2 && !coachClasico ? [
      {
        title: 'Principal',
        items: [
          { title: 'Hoy', href: '/dashboard', icon: Home },
          { title: 'Equipos', href: '/teams', icon: Users },
          { title: 'Sesiones', href: '/training-plans', icon: Activity },
          { title: 'Asistencia', href: '/coach-attendance', icon: ClipboardCheck },
          { title: 'Más', href: '/mas', icon: MoreHorizontal }
        ]
      }
    ] : [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Mis Equipos', href: '/teams', icon: Users },
          // Sesiones de entrenamiento al frente. Antes vivía solo como Gestión →
          // Entrenamiento → "Métricas y Rendimiento": tres clics con la sección
          // plegada y un nombre que no dice "sesiones". Pedido de Carmel 2026-09-24.
          { title: 'Sesiones de Entrenamiento', href: '/training-plans', icon: Activity },
          // "Mis Planes" es la disponibilidad reservable y las citas del coach
          // (coach_availability / session_bookings). 13 escuelas la usan, así que
          // no se quita: se apaga por escuela desde el Super Admin con este moduleKey.
          { title: 'Mis Planes', href: '/coach-plans', icon: FileText, moduleKey: 'gestion_deportiva_disponibilidad_coach' },
          { title: 'Mi Dotación', href: '/coach/dotacion', icon: Dumbbell },
          { title: 'Mis Deportistas', href: '/students', icon: Users },
          { title: 'Disponibilidad médica', href: '/disponibilidad-medica', icon: Heart },
          { title: 'Calendario', href: '/calendar', icon: Calendar }
        ]
      },
      {
        title: 'Gestión',
        items: [
          // "Métricas y Rendimiento" subió a Principal como "Sesiones de
          // Entrenamiento"; acá queda solo Rutinas, sin submenú de un ítem.
          { title: 'Gestión de Rutinas', href: '/school/routines', icon: Dumbbell },
          {
            title: 'Asistencias',
            icon: BarChart3,
            submenu: [
              { title: 'Supervisión', href: '/coach-attendance', icon: BarChart3 },
              { title: 'Encuestas', href: '/dashboard/polls', icon: ClipboardList },
            ],
          },
          { title: 'Resultados', href: '/results', icon: Trophy },
          { title: 'Reportes', href: '/coach-reports', icon: FileText },
          { title: 'Planillas por revisar', href: '/school/attendance-sheets', icon: ClipboardList },
          { title: 'Informe Mensual', href: '/informe-mensual', icon: FileText },
          { title: 'Mis Evaluaciones', href: '/mis-evaluaciones', icon: Award }
        ]
      },
      {
        title: 'Comunicación',
        items: [
          { title: 'Mensajes', href: '/messages', icon: MessageSquare },
          { title: 'Anuncios', href: '/announcements', icon: Bell },
          // Sin 'Facturación': el coach está asociado a la escuela, no contrata su
          // plan. El entrenador independiente sí ve el suyo — ese es el rol
          // 'personal_trainer', que tiene su propio menú.
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      }
    ],

    school: [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Deportistas', href: '/students', icon: Users },
          // Fotos de hojas de matrícula recibidas por WhatsApp, pendientes de
          // confirmar antes de crear el atleta. Ver
          // docs/specs/alta-atleta-por-foto-hoja-matricula.md (fase 4).
          { title: 'Matrículas por revisar', href: '/school/enrollment-intake', icon: ClipboardList, moduleKey: 'deportistas_matriculas_por_revisar' },
          { title: 'Entrenadores', href: '/staff', icon: Users },
          { title: 'Invitaciones', href: '/invitations', icon: Send },
        ]
      },
      {
        title: 'Gestión Deportiva',
        items: GESTION_DEPORTIVA_ESCUELA
      },
      {
        // Solo operación de dinero: cobrar, recibir en sede, y contabilidad.
        // Los destinos de "mirar reportes" se separaron al grupo "Reportes".
        title: 'Finanzas',
        items: [
          { title: 'Pagos', href: '/payments-automation', icon: DollarSign, moduleKey: 'finanzas_pagos' },
          { title: 'Modo Recepción', href: '/recepcion', icon: MonitorSpeaker, moduleKey: 'finanzas_recepcion' },
          { title: 'Cambios de plan', href: '/school/plan-changes', icon: TrendingUp },
          {
            title: 'Contabilidad',
            icon: BookOpen,
            // Gateado en el GRUPO, no en cada hijo: si la escuela no tiene el
            // addon 'accounting', el submenu entero desaparece de una vez.
            addon: 'accounting',
            moduleKey: 'finanzas_contabilidad',
            submenu: [
              { title: 'Contabilidad', href: '/accounting', icon: BookOpen },
              { title: 'Proveedores', href: '/accounting/suppliers', icon: Truck },
              { title: 'Nómina', href: '/accounting/payroll', icon: Landmark },
              { title: 'Estado de resultados', href: '/accounting/reports', icon: TrendingUp },
              { title: 'Presupuesto', href: '/accounting/budget', icon: PieChart },
            ],
          },
          {
            // Standalone: factura mensualidades/inscripciones/torneos/tienda
            // sin necesitar Contabilidad completa (el motor de emisión ya lee
            // payments/marketplace_transactions/orders directo). Se oculta si
            // la escuela YA tiene 'accounting' para no duplicar el acceso —
            // ahí la misma función vive como pestaña dentro de Contabilidad.
            title: 'Facturación electrónica',
            href: '/facturacion-electronica',
            icon: FileText,
            addon: 'invoicing',
            hideIfAddon: 'accounting',
            moduleKey: 'finanzas_facturacion_electronica',
          },
        ]
      },
      {
        // Antes vivían dentro de "Finanzas" junto a Pagos/Contabilidad — se
        // separan porque son destinos de "ver reportes", no de operar dinero.
        title: 'Reportes',
        items: [
          { title: 'Finanzas', href: '/finances', icon: DollarSign, moduleKey: 'reportes_finanzas' },
          { title: 'Reportes', href: '/school-reports', icon: FileText, moduleKey: 'reportes_reportes' },
          // Antes "Cartera por Estado" en un lado y "📊 Panel de Reportes" en
          // el rol reporter — mismo destino, dos nombres (y un emoji hardcodeado).
          { title: 'Panel de Reportes', href: '/reporter-dashboard', icon: BarChart3, moduleKey: 'reportes_panel' },
        ]
      },
      {
        title: 'Documentos e Identidad',
        items: [
          {
            title: 'Carnets',
            icon: IdCard,
            moduleKey: 'documentos_carnets',
            submenu: [
              { title: 'Carnets Digitales', href: '/cards', icon: IdCard },
              { title: 'Plantillas de Carnets', href: '/cards?tab=templates', icon: FileText },
            ],
          },
          { title: 'Constancias', href: '/certificates', icon: FileCheck2, moduleKey: 'documentos_constancias' },
          { title: 'QR de Inscripción', href: '/qr-signup', icon: QrCode, moduleKey: 'documentos_qr_inscripcion' },
        ]
      },
      {
        // Grupo nuevo. "Recordatorios" y "Plantillas de Mensajes" vivían en
        // "Documentos e Identidad" con un comentario que admitía que estaban ahí
        // por falta de lugar: «son comunicación con la familia, no operación de
        // dinero». Ahora tienen casa, junto con el canal de WhatsApp.
        title: 'Comunicación',
        items: [
          { title: 'WhatsApp', href: '/whatsapp', icon: MessageSquare, moduleKey: 'comunicacion_whatsapp' },
          { title: 'Recordatorios', href: '/payment-reminders', icon: Bell, moduleKey: 'documentos_recordatorios' },
          { title: 'Plantillas de Mensajes', href: '/message-templates', icon: MessageSquare, moduleKey: 'documentos_plantillas_mensajes' },
        ]
      },
      {
        title: 'Sedes e Instalaciones',
        items: [
          { title: 'Sedes', href: '/branches', icon: MapPin, moduleKey: 'sedes_sedes' },
          { title: 'Instalaciones', href: '/facilities', icon: Building, moduleKey: 'sedes_instalaciones' },
          { title: 'Control de Acceso', href: '/school/access-control', icon: ShieldCheck, addon: 'access_control', moduleKey: 'sedes_control_acceso' },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Mi Perfil Público', href: '/school/public-profile', icon: User, moduleKey: 'cuenta_perfil_publico' },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings },
        ]
      }
    ],

    wellness_professional: [
      {
        title: 'Principal',
        items: [
          { title: 'Inicio', href: '/vendor/dashboard', icon: Home },
          { title: 'Agenda', href: '/schedule', icon: Calendar },
          { title: 'Pacientes', href: '/pacientes', icon: Users },
          { title: 'Seguimientos', href: '/historias', icon: Target },
        ]
      },
      {
        title: 'Consulta',
        items: [
          { title: 'Disponibilidad', href: '/disponibilidad', icon: Clock },
          { title: 'Reportes', href: '/wellness-reports', icon: FileText },
        ]
      },
      {
        title: 'Marketplace',
        items: [
          { title: 'Mis Servicios', href: '/vendor/services', icon: Activity },
        ]
      },
      {
        title: 'Perfil',
        items: [
          { title: 'Mi Perfil Público', href: '/vendor/public-profile', icon: User },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings },
        ]
      }
    ],

    store_owner: [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard Vendedor', href: '/vendor/dashboard', icon: Home },
          { title: 'Mis Productos', href: '/vendor/products', icon: ShoppingBag, requiresStore: true },
          { title: 'Pedidos', href: '/orders', icon: ShoppingBag, requiresStore: true },
        ]
      },
      {
        title: 'Inventario',
        items: [
          { title: 'Stock', href: '/inventory', icon: BarChart3, requiresStore: true },
          { title: 'Proveedores', href: '/suppliers', icon: Building, requiresStore: true },
          { title: 'Categorías', href: '/categories', icon: Activity, requiresStore: true }
        ]
      },
      {
        title: 'Ventas',
        items: [
          { title: 'Clientes', href: '/customers', icon: Users, requiresStore: true },
          { title: 'Reportes', href: '/store-reports', icon: FileText, requiresStore: true },
          { title: 'Promociones', href: '/promotions', icon: Trophy, requiresStore: true },
        ]
      },
      {
        title: 'Perfil',
        items: [
          { title: 'Mi Perfil Público', href: '/vendor/public-profile', icon: User },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings },
        ]
      }
    ],

    admin: [
      {
        title: 'Plataforma',
        items: [
          { title: 'Dashboard',           href: '/admin',                icon: Home },
          { title: 'Logs y actividad',    href: '/admin/activity-logs',  icon: BarChart3 },
          { title: 'Analítica',           href: '/admin/analytics',      icon: BarChart3 }
        ]
      },
      {
        title: 'Gestión Global',
        items: [
          { title: 'Escuelas',  href: '/admin/schools', icon: Building },
          { title: 'Integridad de inscripciones', href: '/admin/enrollment-integrity', icon: ShieldAlert },
          { title: 'Suscripciones', href: '/admin/subscriptions', icon: DollarSign },
          { title: 'Usuarios',  href: '/admin/users',   icon: Users },
          { title: 'Reportes',  href: '/admin/reports', icon: FileText }
        ]
      },
      {
        title: 'Sistema',
        items: [
          { title: 'Configuración',     href: '/admin/config',  icon: Settings },
          { title: 'Notificaciones',    href: '/notifications', icon: Bell },
          { title: 'Mensajes',          href: '/messages',      icon: MessageSquare },
          { title: 'Facturación',       href: '/mi-plan',       icon: CreditCard }
        ]
      }
    ],

    super_admin: [
      {
        title: 'Plataforma',
        items: [
          { title: 'Dashboard', href: '/admin', icon: Home },
          { title: 'Logs y actividad', href: '/admin/activity-logs', icon: BarChart3 },
          { title: 'Analítica', href: '/admin/analytics', icon: BarChart3 }
        ]
      },
      {
        title: 'Gestión Global',
        items: [
          { title: 'Escuelas', href: '/admin/schools', icon: Building },
          { title: 'Integridad de inscripciones', href: '/admin/enrollment-integrity', icon: ShieldAlert },
          { title: 'Suscripciones', href: '/admin/subscriptions', icon: DollarSign },
          { title: 'Usuarios', href: '/admin/users', icon: Users },
          { title: 'Uso de IA de pizarra', href: '/admin/ia-pizarra', icon: Sparkles },
          { title: 'Reportes', href: '/admin/reports', icon: FileText }
        ]
      },
      {
        title: 'Moderación',
        items: [
          { title: 'Marketplace',     href: '/admin/marketplace/moderation', icon: ShieldCheck },
          { title: 'Pagos a vendors', href: '/admin/payouts',                icon: DollarSign }
        ]
      },
      {
        title: 'Sistema',
        items: [
          { title: 'Configuración', href: '/admin/config', icon: Settings },
          { title: 'Canal WhatsApp', href: '/admin/whatsapp', icon: MessageSquare },
          { title: 'Parámetros de Nómina', href: '/admin/payroll-config', icon: Landmark },
          { title: 'Notificaciones', href: '/notifications', icon: Bell }
        ]
      }
    ],

    school_admin: [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Deportistas', href: '/students', icon: Users },
          // Fotos de hojas de matrícula recibidas por WhatsApp, pendientes de
          // confirmar antes de crear el atleta. Ver
          // docs/specs/alta-atleta-por-foto-hoja-matricula.md (fase 4).
          { title: 'Matrículas por revisar', href: '/school/enrollment-intake', icon: ClipboardList, moduleKey: 'deportistas_matriculas_por_revisar' },
          { title: 'Entrenadores', href: '/staff', icon: Users },
          { title: 'Invitaciones', href: '/invitations', icon: Send },
        ]
      },
      {
        title: 'Gestión Deportiva',
        items: GESTION_DEPORTIVA_ESCUELA
      },
      {
        // Solo operación de dinero: cobrar, recibir en sede, y contabilidad.
        // Los destinos de "mirar reportes" se separaron al grupo "Reportes".
        title: 'Finanzas',
        items: [
          { title: 'Pagos', href: '/payments-automation', icon: DollarSign, moduleKey: 'finanzas_pagos' },
          { title: 'Modo Recepción', href: '/recepcion', icon: MonitorSpeaker, moduleKey: 'finanzas_recepcion' },
          { title: 'Cambios de plan', href: '/school/plan-changes', icon: TrendingUp },
          {
            title: 'Contabilidad',
            icon: BookOpen,
            // Gateado en el GRUPO, no en cada hijo: si la escuela no tiene el
            // addon 'accounting', el submenu entero desaparece de una vez.
            addon: 'accounting',
            moduleKey: 'finanzas_contabilidad',
            submenu: [
              { title: 'Contabilidad', href: '/accounting', icon: BookOpen },
              { title: 'Proveedores', href: '/accounting/suppliers', icon: Truck },
              { title: 'Nómina', href: '/accounting/payroll', icon: Landmark },
              { title: 'Estado de resultados', href: '/accounting/reports', icon: TrendingUp },
              { title: 'Presupuesto', href: '/accounting/budget', icon: PieChart },
            ],
          },
          {
            // Standalone: factura mensualidades/inscripciones/torneos/tienda
            // sin necesitar Contabilidad completa (el motor de emisión ya lee
            // payments/marketplace_transactions/orders directo). Se oculta si
            // la escuela YA tiene 'accounting' para no duplicar el acceso —
            // ahí la misma función vive como pestaña dentro de Contabilidad.
            title: 'Facturación electrónica',
            href: '/facturacion-electronica',
            icon: FileText,
            addon: 'invoicing',
            hideIfAddon: 'accounting',
            moduleKey: 'finanzas_facturacion_electronica',
          },
        ]
      },
      {
        // Antes vivían dentro de "Finanzas" junto a Pagos/Contabilidad — se
        // separan porque son destinos de "ver reportes", no de operar dinero.
        title: 'Reportes',
        items: [
          { title: 'Finanzas', href: '/finances', icon: DollarSign, moduleKey: 'reportes_finanzas' },
          { title: 'Reportes', href: '/school-reports', icon: FileText, moduleKey: 'reportes_reportes' },
          // Antes "Cartera por Estado" en un lado y "📊 Panel de Reportes" en
          // el rol reporter — mismo destino, dos nombres (y un emoji hardcodeado).
          { title: 'Panel de Reportes', href: '/reporter-dashboard', icon: BarChart3, moduleKey: 'reportes_panel' },
        ]
      },
      {
        title: 'Documentos e Identidad',
        items: [
          {
            title: 'Carnets',
            icon: IdCard,
            moduleKey: 'documentos_carnets',
            submenu: [
              { title: 'Carnets Digitales', href: '/cards', icon: IdCard },
              { title: 'Plantillas de Carnets', href: '/cards?tab=templates', icon: FileText },
            ],
          },
          { title: 'Constancias', href: '/certificates', icon: FileCheck2, moduleKey: 'documentos_constancias' },
          { title: 'QR de Inscripción', href: '/qr-signup', icon: QrCode, moduleKey: 'documentos_qr_inscripcion' },
        ]
      },
      {
        // Espejo del arbol `school`. Este arbol es una copia aparte y el
        // refactor que saco "Recordatorios" y "Plantillas" de "Documentos e
        // Identidad" para juntarlos con WhatsApp solo se aplico alla: el
        // school_admin se quedo sin el canal de WhatsApp, aunque la ruta
        // siempre lo dejo entrar. Si se toca un arbol, tocar el otro.
        title: 'Comunicación',
        items: [
          { title: 'WhatsApp', href: '/whatsapp', icon: MessageSquare, moduleKey: 'comunicacion_whatsapp' },
          { title: 'Recordatorios', href: '/payment-reminders', icon: Bell, moduleKey: 'documentos_recordatorios' },
          { title: 'Plantillas de Mensajes', href: '/message-templates', icon: MessageSquare, moduleKey: 'documentos_plantillas_mensajes' },
        ]
      },
      {
        title: 'Sedes e Instalaciones',
        items: [
          { title: 'Sedes', href: '/branches', icon: MapPin, moduleKey: 'sedes_sedes' },
          { title: 'Instalaciones', href: '/facilities', icon: Building, moduleKey: 'sedes_instalaciones' },
          { title: 'Control de Acceso', href: '/school/access-control', icon: ShieldCheck, addon: 'access_control', moduleKey: 'sedes_control_acceso' },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings },
        ]
      }
    ],

    // Organizador: usa el MISMO motor de torneos que la escuela (/school/tournaments*); su organización es
    // una fila de schools tipo 'event_organizer' (spec organizador-torneos-modulo-aparte §3 y §2.3).
    organizer: [
      {
        title: 'Torneos',
        items: [
          { title: 'Inicio de torneos', href: '/school/tournaments', icon: Home },
          { title: 'Crear torneo', href: '/school/tournaments/nuevo-rapido', icon: Plus },
          { title: 'Torneo avanzado', href: '/school/tournaments/new', icon: Trophy },
          { title: 'Torneos donde participo', href: '/school/delegations', icon: Ticket },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Mi plan', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      }
    ],

    // Contabilidad v2 F0: contador de la escuela. Solo lectura de la
    // contabilidad (la base le niega escribir, pagar y liquidar; las pantallas
    // esconden esos botones). Sin "Registrar gasto"/"Pagar"/"Liquidar".
    accountant: [
      {
        title: 'Contabilidad',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Libro de caja', href: '/accounting', icon: BookOpen },
          { title: 'Proveedores', href: '/accounting/suppliers', icon: Truck },
          { title: 'Nómina', href: '/accounting/payroll', icon: Landmark },
          { title: 'Estado de resultados', href: '/accounting/reports', icon: TrendingUp },
          { title: 'Presupuesto', href: '/accounting/budget', icon: PieChart },
          { title: 'Cambios de plan', href: '/school/plan-changes', icon: TrendingUp },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Notificaciones', href: '/notifications', icon: Bell },
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      }
    ],

    reporter: [
      {
        title: 'Reportes',
        items: [
          { title: 'Dashboard', href: '/dashboard', icon: Home },
          { title: 'Panel de Reportes', href: '/reporter-dashboard', icon: BarChart3 },
          { title: 'Calendario', href: '/calendar', icon: Calendar },
        ]
      },
      {
        title: 'Cuenta',
        items: [
          { title: 'Notificaciones', href: '/notifications', icon: Bell },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings }
        ]
      }
    ],

    personal_trainer: [
      {
        title: 'Principal',
        items: [
          { title: 'Dashboard', href: '/trainer/dashboard', icon: Home },
          { title: 'Mis Clientes', href: '/trainer/clients', icon: Users },
          { title: 'Disponibilidad', href: '/trainer/availability', icon: Calendar },
        ]
      },
      {
        title: 'Negocio',
        items: [
          { title: 'Mis Planes', href: '/trainer/plans', icon: FileText },
          { title: 'Mis Rutinas', href: '/trainer/routines', icon: Dumbbell },
          { title: 'Pagos', href: '/trainer/payments', icon: DollarSign },
        ]
      },
      {
        title: 'Mi Actividad',
        items: [
          { title: 'Mis Inscripciones', href: '/enrollments', icon: Trophy },
        ]
      },
      {
        title: 'Perfil',
        items: [
          { title: 'Mi Perfil Público', href: '/trainer/profile', icon: User },
          { title: 'Facturación', href: '/mi-plan', icon: CreditCard },
          { title: 'Configuración', href: '/settings', icon: Settings },
        ]
      }
    ],
  };

  const groups = roleSpecificNav[role] || [baseNav];
  return groups
    .map(group => ({
      ...group,
      items: filterByBuyerStore(
        filterByStore(filterByModuleOverride(filterByAddon(group.items, hasAddon), isModuleEnabled), storeEnabled),
        buyerStore,
      ),
    }))
    .filter(group => group.items.length > 0);
}
