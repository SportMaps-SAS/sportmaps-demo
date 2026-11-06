/**
 * Route Permission Map — Single Source of Truth
 *
 * Centralizes the mapping between routes, required roles, and permissions.
 * Used by ProtectedRoute to enforce access control and by navigation to filter menus.
 *
 * Principio: "Denegación por Defecto"
 * Si una ruta no está aquí y no es pública, se deniega el acceso.
 */

import { Permission } from '@/lib/permissions';

type UserRole =
    | 'athlete' | 'parent' | 'coach' | 'school' | 'school_admin'
    | 'super_admin' | 'wellness_professional' | 'store_owner'
    | 'admin' | 'organizer' | 'reporter' | 'personal_trainer' | 'accountant' | 'facility_manager';

export interface RoutePermission {
    /** Roles que pueden acceder. Si vacío, cualquier autenticado puede acceder. */
    allowedRoles?: UserRole[];
    /** Permiso requerido (alternativa a roles, se evalúa OR con allowedRoles). */
    requiredPermission?: Permission;
    /** Si true, es ruta pública (no requiere autenticación). */
    public?: boolean;
    /** Descripción para documentación / auditoría. */
    description?: string;
}

// ─── Rutas públicas (sin autenticación) ──────────────────────────────────────
export const PUBLIC_ROUTES: Record<string, RoutePermission> = {
    '/': { public: true, description: 'Landing page' },
    '/explore': { public: true, description: 'Explorar escuelas' },
    '/schools/:id': { public: true, description: 'Detalle de escuela' },
    '/escuela/:id': { public: true, description: 'Perfil público de escuela' },
    '/s/:slug': { public: true, description: 'Perfil público por slug' },
    '/login': { public: true, description: 'Inicio de sesión' },
    '/register': { public: true, description: 'Registro' },
    '/reset-password': { public: true, description: 'Restablecer contraseña' },
    '/terminos-y-condiciones': { public: true, description: 'Términos y condiciones' },
    '/politica-de-privacidad': { public: true, description: 'Política de privacidad' },
    '/payment-result': { public: true, description: 'Resultado de pago (webhook)' },
    '/pagos/confirmacion': { public: true, description: 'Confirmación de pago' },
    '/p/:token': { public: true, description: 'Enlace sin login de un cobro (botón de cobranza por WhatsApp)' },
    '/jugada/:token': { public: true, description: 'Jugada de la pizarra compartida por enlace (solo lectura, sin nombres de deportistas)' },
    '/unauthorized': { public: true, description: 'Página de acceso denegado' },
    '/events': { public: true, description: 'Mapa de eventos públicos' },
    '/event/:slug': { public: true, description: 'Página pública de evento' },
    '/tournaments/:eventId/results': { public: true, description: 'Resultados públicos de torneo/liga interna' },
    '/polls/v/:pollId': { public: true, description: 'Encuesta pública' },
    // Marketplace público
    '/explorar': { public: true, description: 'Explorar global — servicios, eventos, escuelas, productos' },
    '/marketplace': { public: true, description: 'Marketplace (productos y servicios)' },
    '/marketplace/:type/:id': { public: true, description: 'Detalle de producto o servicio' },
    '/vendor/:slug': { public: true, description: 'Perfil público del vendedor' },
};

// ─── Rutas comunes (cualquier rol autenticado) ───────────────────────────────
export const COMMON_ROUTES: Record<string, RoutePermission> = {
    '/dashboard': { description: 'Dashboard principal', requiredPermission: 'dashboard:view' },
    '/profile': { description: 'Perfil del usuario' },
    '/calendar': { description: 'Calendario', requiredPermission: 'calendar:view' },
    '/notifications': { description: 'Notificaciones' },
    '/settings': { description: 'Configuración', requiredPermission: 'settings:view' },
    '/messages': { description: 'Mensajes', requiredPermission: 'messages:view' },
    '/checkout': { description: 'Redirige al carrito (checkout viejo eliminado, tienda v2)' },
    '/checkout/tienda/:vendorProfileId': { description: 'Checkout de una pantalla de la tienda (tienda v2)' },
    '/mis-compras': { description: 'Mis compras en la tienda' },
    '/mis-compras/:orderId': { description: 'Detalle de una compra' },
    '/setup/school': { description: 'Setup inicial de escuela' },
    '/parent-checkout': { description: 'Checkout de padre' },
};

// ─── Rutas por rol ───────────────────────────────────────────────────────────
export const ROLE_ROUTES: Record<string, RoutePermission> = {
    // ── Athlete ──
    '/teams': { description: 'Equipos', requiredPermission: 'teams:view' },
    '/stats': { description: 'Estadísticas', requiredPermission: 'stats:view' },
    '/goals': { allowedRoles: ['athlete'], description: 'Objetivos del atleta' },
    '/training': { allowedRoles: ['athlete'], description: 'Entrenamientos' },
    '/enrollments': { allowedRoles: ['athlete', 'parent'], description: 'Inscripciones' },
    '/shop': { description: 'Tienda deportiva' },
    '/wellness': { allowedRoles: ['athlete'], description: 'Bienestar del atleta' },
    '/athlete-payments': { allowedRoles: ['athlete'], description: 'Pagos del atleta' },

    // ── Parent ──
    '/children': { allowedRoles: ['parent'], description: 'Mis hijos' },
    '/my-payments': { allowedRoles: ['parent', 'athlete'], description: 'Mis pagos' },
    '/tournaments/:eventId/register': { allowedRoles: ['parent', 'athlete'], description: 'Inscripción y pago de torneo/liga interna' },
    '/children/:id/progress': { allowedRoles: ['parent'], description: 'Progreso del hijo' },
    '/children/:id/attendance': { allowedRoles: ['parent'], description: 'Asistencia del hijo' },
    '/academic-progress': { allowedRoles: ['parent'], description: 'Progreso deportivo' },
    '/parent-attendance': { allowedRoles: ['parent'], description: 'Asistencias (padre)' },

    // ── Coach ──
    '/coach-attendance': { allowedRoles: ['coach'], requiredPermission: 'calendar:edit', description: 'Asistencias (coach)' },
    '/coach-attendance/scan': { allowedRoles: ['coach'], requiredPermission: 'calendar:edit', description: 'Check-in por QR de carnet (coach)' },
    '/coach-plans': { allowedRoles: ['coach'], description: 'Planes del coach' },
    '/pizarra': { allowedRoles: ['coach', 'school', 'school_admin', 'admin', 'super_admin'], description: 'Pizarra táctica libre (sin sesión): Mis jugadas o agregar a una sesión' },
    '/results': { allowedRoles: ['coach', 'school', 'admin', 'school_admin', 'super_admin'], description: 'Resultados (partidos de la escuela)' },
    '/partidos/:matchId': { allowedRoles: ['coach', 'school', 'admin', 'school_admin', 'super_admin'], description: 'Pantalla del partido: programar, convocar, resultado, evaluar y reporte' },
    '/training-plans': { allowedRoles: ['coach', 'school', 'admin', 'school_admin', 'super_admin'], description: 'Métricas y rendimiento' },
    '/coach-reports': { allowedRoles: ['coach'], requiredPermission: 'reports:create', description: 'Reportes (coach)' },
    '/evaluations': { allowedRoles: ['coach'], description: 'Evaluaciones' },
    '/announcements': { allowedRoles: ['coach'], description: 'Anuncios' },

    // ── Polls ──
    '/dashboard/polls': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'coach'], description: 'Encuestas' },
    '/dashboard/polls/:pollId/results': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'coach'], description: 'Resultados de encuesta' },

    // ── School / Admin ──
    '/school/enroll/:eventId': { allowedRoles: ['school', 'admin', 'school_admin'], description: 'Inscripción a evento' },
    '/school/delegations': { allowedRoles: ['school', 'admin', 'school_admin'], description: 'Delegaciones de escuela' },
    '/school/delegations/:id': { allowedRoles: ['school', 'admin', 'school_admin'], description: 'Detalle de delegación' },
    '/school/routines': { allowedRoles: ['school', 'school_admin', 'admin', 'super_admin', 'coach'], description: 'Biblioteca de rutinas del gimnasio' },
    '/students': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'coach'], requiredPermission: 'students:view', description: 'Gestión de deportistas' },
    '/invitations': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'coach'], description: 'Gestión de invitaciones' },
    '/staff': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Gestión de entrenadores' },
    '/offerings': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Planes y ofertas' },
    '/programs-management': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Gestión de programas' },
    '/attendance-supervision': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Supervisión de asistencias' },
    '/attendance-history': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Histórico de asistencias' },
    '/seguimiento-deportivo': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Seguimiento deportivo (actividad de entrenadores)' },
    '/mis-evaluaciones': { allowedRoles: ['coach'], description: 'Evaluaciones publicadas del entrenador' },
    '/results-overview': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Resumen de resultados' },
    '/finances': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'finances:view', description: 'Finanzas' },
    '/accounting': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'accountant'], requiredPermission: 'finances:view', description: 'Contabilidad' },
    '/accounting/suppliers': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'accountant'], requiredPermission: 'finances:view', description: 'Proveedores y cuentas por pagar' },
    '/accounting/payroll': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'accountant'], requiredPermission: 'finances:view', description: 'Nómina' },
    '/accounting/reports': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'accountant'], requiredPermission: 'finances:view', description: 'Estado de resultados' },
    '/accounting/budget': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'accountant'], requiredPermission: 'finances:view', description: 'Presupuesto' },
    '/facturacion-electronica': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'finances:view', description: 'Facturación electrónica' },
    '/payments-automation': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'finances:manage', description: 'Automatización de pagos' },
    '/payment-reminders': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'finances:manage', description: 'Recordatorios de pago' },
    '/whatsapp': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Canal de WhatsApp' },
    '/message-templates': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Plantillas de mensaje' },
    '/school-reports': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'reports:view', description: 'Reportes escolares' },
    '/facilities': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin', 'facility_manager'], description: 'Instalaciones' },
    // ── Dueño de espacios (facility_manager, school_type 'venue') ──
    '/venue/onboarding': { allowedRoles: ['facility_manager'], description: 'Onboarding del dueño de espacios' },
    '/venue/dashboard': { allowedRoles: ['facility_manager'], description: 'Inicio del dueño de espacios' },
    '/venue/reservas': { allowedRoles: ['facility_manager'], description: 'Reservas de las instalaciones' },
    '/venue/cobros': { allowedRoles: ['facility_manager'], description: 'Forma de cobro del dueño de espacios' },
    '/branches': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], description: 'Gestión de sedes' },
    '/school-config': { allowedRoles: ['school', 'admin', 'school_admin', 'super_admin'], requiredPermission: 'settings:edit', description: 'Configuración de escuela' },
    '/pickup': { allowedRoles: ['school', 'admin'], description: 'Monitor de salida segura' },
    '/reporter-dashboard': { allowedRoles: ['reporter', 'school', 'school_admin', 'admin', 'super_admin'], description: 'Panel de reportes — cartera por estado (pagado/pendiente/vencido) con exportación CSV' },

    // ── Wellness ──
    '/athletes': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Atletas (bienestar)' },
    '/schedule': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Agenda (bienestar)' },
    '/evaluations/new': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Nueva evaluación' },
    '/medical-history': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Historial médico' },
    '/follow-ups': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Seguimientos' },
    '/nutrition': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], description: 'Planes nutricionales' },
    '/wellness-reports': { allowedRoles: ['wellness_professional', 'admin', 'super_admin', 'school', 'school_admin'], requiredPermission: 'reports:view', description: 'Reportes de bienestar' },

    // ── Store ──
    '/products': { allowedRoles: ['store_owner', 'admin', 'school', 'school_admin', 'super_admin'], description: 'Productos' },
    '/orders': { allowedRoles: ['store_owner', 'admin', 'school', 'school_admin', 'super_admin'], description: 'Pedidos' },
    '/inventory': { allowedRoles: ['store_owner', 'admin', 'school', 'school_admin', 'super_admin'], description: 'Inventario' },
    '/suppliers': { allowedRoles: ['store_owner', 'admin'], description: 'Proveedores' },
    '/categories': { allowedRoles: ['store_owner', 'admin'], description: 'Categorías' },
    '/customers': { allowedRoles: ['store_owner', 'admin'], description: 'Clientes' },
    '/promotions': { allowedRoles: ['store_owner', 'admin'], description: 'Promociones' },
    '/store-reports': { allowedRoles: ['store_owner', 'admin'], requiredPermission: 'reports:view', description: 'Reportes de tienda' },

    // ── Vendor (guarded by VendorGuard) ──
    '/vendor/onboarding': { allowedRoles: ['wellness_professional', 'store_owner'], description: 'Onboarding del vendedor' },
    '/vendor/dashboard': { allowedRoles: ['wellness_professional', 'store_owner'], description: 'Dashboard del vendedor' },
    '/vendor/services': { allowedRoles: ['wellness_professional'], requiredPermission: 'services:view', description: 'Gestión de servicios' },
    '/vendor/appointments': { allowedRoles: ['wellness_professional'], requiredPermission: 'appointments:manage', description: 'Gestión de citas' },
    '/vendor/products': { allowedRoles: ['store_owner'], requiredPermission: 'products:view', description: 'Gestión de productos (vendor)' },
    '/vendor/finances': { allowedRoles: ['wellness_professional', 'store_owner'], requiredPermission: 'finances:view', description: 'Finanzas del vendedor' },
    '/vendor/reviews': { allowedRoles: ['wellness_professional', 'store_owner'], description: 'Reseñas del vendedor' },
    '/vendor/disputes': { allowedRoles: ['wellness_professional', 'store_owner'], description: 'Disputas del vendedor' },
    '/vendor/shipping': { allowedRoles: ['store_owner'], description: 'Configuración de envíos' },

    // ── Organizer (guarded by OrganizerGuard) ──
    '/organizer/onboarding': { allowedRoles: ['organizer'], description: 'Onboarding del organizador' },
    '/organizer/dashboard': { allowedRoles: ['organizer'], description: 'Dashboard del organizador' },
    '/organizer/profile': { allowedRoles: ['organizer'], description: 'Perfil del organizador' },
    '/organizer/create-event': { allowedRoles: ['organizer'], requiredPermission: 'events:create', description: 'Crear evento' },
    '/organizer/event/:id': { allowedRoles: ['organizer'], requiredPermission: 'events:edit', description: 'Gestión de evento' },
    '/organizer/events': { allowedRoles: ['organizer'], requiredPermission: 'events:view', description: 'Mis eventos' },
    '/organizer/finances': { allowedRoles: ['organizer'], requiredPermission: 'finances:view', description: 'Finanzas del organizador' },
    '/organizer/calendar': { allowedRoles: ['organizer'], requiredPermission: 'calendar:view', description: 'Calendario del organizador' },
    '/organizer/reports': { allowedRoles: ['organizer'], requiredPermission: 'reports:view', description: 'Reportes del organizador' },
    '/organizer/settings': { allowedRoles: ['organizer'], requiredPermission: 'settings:view', description: 'Configuración del organizador' },

    // ── Admin ──
    '/admin/users': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:users', description: 'Gestión de usuarios' },
    '/admin/clubs': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:all', description: 'Gestión de clubes' },
    '/admin/schools': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:all', description: 'Vista global de escuelas' },
    '/admin/enrollment-integrity': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:all', description: 'Atletas activos sin inscripción vigente (cross-escuela)' },
    '/admin/reports': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:all', description: 'Reportes admin' },
    '/admin/analytics': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:all', description: 'Analytics admin' },
    '/admin/config': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:system', description: 'Configuración admin' },
    '/admin/payroll-config': { allowedRoles: ['super_admin'], requiredPermission: 'admin:system', description: 'Parámetros de nómina (Colombia)' },
    '/admin/logs': { allowedRoles: ['admin', 'super_admin'], requiredPermission: 'admin:system', description: 'Logs del sistema' },
};

/**
 * Busca la configuración de permisos para una ruta dada.
 * Soporta rutas con parámetros dinámicos (ej: /children/:id/progress).
 */
export function getRoutePermission(pathname: string): RoutePermission | null {
    // 1. Buscar match exacto
    const allRoutes = { ...PUBLIC_ROUTES, ...COMMON_ROUTES, ...ROLE_ROUTES };
    if (allRoutes[pathname]) return allRoutes[pathname];

    // 2. Buscar match con parámetros dinámicos
    for (const [pattern, config] of Object.entries(allRoutes)) {
        const regex = new RegExp(
            '^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$'
        );
        if (regex.test(pathname)) return config;
    }

    return null;
}

/**
 * Verifica si una ruta es pública (no requiere autenticación).
 */
export function isPublicRoute(pathname: string): boolean {
    const config = getRoutePermission(pathname);
    return config?.public === true;
}
