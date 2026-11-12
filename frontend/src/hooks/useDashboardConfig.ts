import { useMemo } from 'react';
import { DashboardConfig, UserRole } from '@/types/dashboard';
import { DashboardStats } from './useDashboardStats';
import { QUICK_ACTIONS_CATALOG_SCHOOL, DEFAULT_QUICK_ACTIONS_SCHOOL } from '@/config/quickActionsCatalog';
import {
  Users,
  Calendar,
  Trophy,
  BarChart3,
  Clock,
  Target,
  TrendingUp,
  Bell,
  ShoppingBag,
  Heart,
  Building,
  Activity,
  Plus,
  Shield,
  UserCircle,
  Award,
  Circle,
  CheckCircle2,
  ArrowRight,
  DollarSign
} from 'lucide-react';

/**
 * Custom hook that returns dashboard configuration based on user role
 * Centralizes all role-specific data and layouts
 */
export function useDashboardConfig(
  role: UserRole,
  statsData?: DashboardStats,
  savedQuickActionIds?: string[],
): DashboardConfig {
  return useMemo(() => {
    // Resuelve los ids guardados contra el catálogo; ids que ya no existan
    // (pantalla removida/renombrada) se ignoran en vez de romper el render.
    // Sin nada guardado, son los mismos 5 que ya estaban hardcodeados — cero
    // cambio de comportamiento para quien no personalizó nada.
    const schoolQuickActions = (
      savedQuickActionIds && savedQuickActionIds.length > 0 ? savedQuickActionIds : DEFAULT_QUICK_ACTIONS_SCHOOL
    )
      .map(id => QUICK_ACTIONS_CATALOG_SCHOOL.find(c => c.id === id))
      .filter((c): c is typeof QUICK_ACTIONS_CATALOG_SCHOOL[number] => !!c)
      .map((c, idx) => ({ label: c.label, icon: c.icon, href: c.href, variant: idx === 0 ? 'default' as const : 'outline' as const }));

    // Default empty stats if not provided
    const stats = statsData || {
      children: 0,
      teams: 0,
      products: 0,
      orders: 0,
      appointments: 0,
      evaluations: 0,
      programs: 0,
      activePrograms: 0,
      notifications: 0,
      unreadNotifications: 0,
      payments: 0,
      pendingPayments: 0,
      totalStudents: 0,
      totalRevenue: 0,
      activeEnrollments: 0,
      upcomingEvents: 0,
      completedActivities: 0,
      attendanceRate: 0,
      activeTeams: 0
    };

    const onboardingConfigs: Record<string, any[]> = {
      school: [
        { id: 'create_school', title: 'Crea tu Academia', description: 'Registra los datos básicos de tu escuela.', icon: Building, href: '/school-config', completed: false },
        { id: 'add_staff', title: 'Equipo de Trabajo', description: 'Registra entrenadores o administrativos.', icon: Users, href: '/staff', completed: false },
        { id: 'create_program', title: 'Oferta Deportiva', description: 'Crea niveles o clases (ej. Porrismo Nivel 1).', icon: Award, href: '/programs-management', completed: false },
        { id: 'invite_students', title: 'Invita Deportistas', description: 'Registra y envía invitaciones.', icon: Users, href: '/students', completed: false }
      ],
      parent: [
        { id: 'add_child', title: 'Vincular Hijo', description: 'Registra el perfil de tus deportistas.', icon: Users, href: '/children', completed: false },
        { id: 'medical_info', title: 'Ficha Médica', description: 'Completa datos de salud y EPS.', icon: Activity, href: '/children', completed: false },
        { id: 'accept_invite', title: 'Aceptar Invitación', description: 'Vincula a tu hijo a una academia.', icon: Bell, href: '/notifications', completed: false },
        { id: 'validate_data', title: 'Validar Datos', description: 'Confirma documentos y contactos.', icon: Shield, href: '/profile', completed: false },
        { id: 'subscriptions', title: 'Suscripciones', description: 'Revisa pagos y mensualidades.', icon: TrendingUp, href: '/my-payments', completed: false }
      ],
      coach: [
        { id: 'complete_profile', title: 'Perfil Profesional', description: 'Sube tu experiencia y certificaciones.', icon: UserCircle, href: '/profile', completed: false },
        { id: 'join_school', title: 'Vincular Escuela', description: 'Acepta la invitación de tu academia.', icon: Building, href: '/notifications', completed: false }
      ],
      athlete: [
        { id: 'complete_profile', title: 'Completar Perfil', description: 'Asegúrate de que tus datos estén al día.', icon: UserCircle, href: '/profile', completed: false },
        { id: 'enroll_program', title: 'Inscribirse en Equipo', description: 'Busca una academia y únete.', icon: Trophy, href: '/explore', completed: false }
      ],
      wellness_professional: [
        { id: 'complete_profile', title: 'Perfil Profesional', description: 'Tarjeta profesional, especialidad y datos.', icon: Heart, href: '/vendor/onboarding', completed: false },
        { id: 'set_availability', title: 'Tu disponibilidad', description: 'Define tus horarios de atención.', icon: Clock, href: '/disponibilidad', completed: false },
        { id: 'add_patient', title: 'Primer paciente', description: 'Registra un paciente y su consentimiento.', icon: Users, href: '/pacientes', completed: false }
      ],
      store_owner: [
        { id: 'create_store', title: 'Configurar Tienda', description: 'Nombre y detalles de tu comercio.', icon: ShoppingBag, href: '/settings', completed: false },
        { id: 'add_product', title: 'Primer Producto', description: 'Sube artículos al catálogo.', icon: Plus, href: '/products', completed: false }
      ],
      organizer: [
        { id: 'complete_profile', title: 'Perfil de Organizador', description: 'Datos fiscales y de contacto.', icon: UserCircle, href: '/profile', completed: false },
        { id: 'create_event', title: 'Primer Evento', description: 'Organiza tu primera competencia.', icon: Calendar, href: '/school/tournaments/nuevo-rapido', completed: false }
      ]
    };

    switch (role) {
      case 'athlete':
        return {
          role: 'athlete',
          title: 'Mi Dashboard',
          description: 'Resumen de tu actividad deportiva',
          stats: [
            {
              title: 'Entrenamientos',
              value: stats.completedActivities || 0,
              description: 'Este mes',
              icon: Activity,
              href: '/training'
            },
            {
              title: 'Nivel actual',
              value: stats.activeEnrollments > 0 ? 'Activo' : 'Sin nivel',
              description: stats.activeEnrollments > 0 ? 'En progreso' : 'Inscríbete para empezar',
              icon: TrendingUp,
              href: '/stats'
            },
            {
              title: 'Próxima sesión',
              value: stats.upcomingEvents > 0 ? `${stats.upcomingEvents}` : '—',
              description: stats.upcomingEvents > 0 ? 'Eventos esta semana' : 'Sin sesiones programadas',
              icon: Calendar,
              href: '/enrollments'
            },
            {
              title: 'Pagos pendientes',
              value: stats.pendingPayments || 0,
              description: stats.pendingPayments === 0 ? 'Al día ✓' : 'Requieren atención',
              icon: TrendingUp,
              href: '/athlete-payments'
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Entrenamientos', icon: Activity, href: '/training', variant: 'default' },
            { label: 'Mi Calendario', icon: Calendar, href: '/calendar', variant: 'outline' },
            { label: 'Mis Inscripciones', icon: Trophy, href: '/enrollments', variant: 'outline' },
            { label: 'Estadísticas', icon: BarChart3, href: '/stats', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.athlete
        };

      case 'parent':
        return {
          role: 'parent',
          title: 'Panel de Padre/Madre',
          description: 'Sigue el progreso de tus hijos',
          stats: [
            {
              title: 'Hijos Registrados',
              value: stats.children,
              description: stats.children === 0 ? 'Aún no has agregado hijos' : 'Registrados',
              icon: Users
            },
            {
              title: 'Asistencia Promedio',
              value: '0%',
              description: 'Últimos 30 días',
              icon: Activity
            },
            {
              title: 'Pagos Pendientes',
              value: stats.pendingPayments,
              description: stats.pendingPayments === 0 ? 'Al día' : 'Mensualidades',
              icon: TrendingUp,
              href: '/my-payments'
            },
            {
              title: 'Notificaciones',
              value: stats.unreadNotifications,
              description: 'Sin leer',
              icon: Bell
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Mis Pagos', icon: TrendingUp, href: '/my-payments', variant: 'default' },
            { label: 'Agregar Hijo', icon: Users, href: '/children', variant: 'outline' },
            { label: 'Ver Equipos', icon: Activity, href: '/explore', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.parent
        };

      case 'coach':
        return {
          role: 'coach',
          title: 'Panel de Entrenador',
          description: 'Gestiona tus equipos y deportistas',
          stats: [
            {
              title: 'Deportistas Total',
              value: stats.totalStudents || 0,
              description: 'En todos los equipos',
              icon: Users
            },
            {
              title: 'Equipos',
              value: stats.teams,
              description: stats.teams === 0 ? 'Aún no tienes equipos' : 'Asignados',
              icon: Users
            },
            {
              title: 'Próximos Eventos',
              value: stats.upcomingEvents,
              description: 'Esta semana',
              icon: Calendar
            },
            {
              title: 'Asistencia Promedio',
              value: `${stats.attendanceRate}%`,
              description: 'Sin registros aún',
              icon: TrendingUp
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Ver Calendario', icon: Calendar, href: '/calendar', variant: 'default' },
            { label: 'Marcar Asistencia', icon: Users, href: '/coach-attendance', variant: 'outline' },
            { label: 'Registrar Resultado', icon: Trophy, href: '/results', variant: 'outline' }
          ],
          notifications: [],
          onboardingSteps: onboardingConfigs.coach
        };

      // 'school_admin' compartía este case por accidente con el 'default'
      // (dashboard vacío tipo athlete) — DashboardPage.tsx sí trata a
      // school_admin como rol de escuela en todos los demás usos, solo a este
      // switch le faltaba el case.
      case 'school':
      case 'school_admin':
        return {
          role: 'school',
          title: 'Panel de Escuela',
          description: 'Gestión completa de tu centro deportivo',
          stats: [
            {
              title: 'Deportistas Activos',
              value: stats.totalStudents,
              description: stats.totalStudents === 0 ? 'Aún no tienes deportistas' : 'Total matriculados',
              icon: Users
            },
            {
              title: 'Equipos',
              value: stats.programs,
              description: stats.programs === 0 ? 'Crea tu primer equipo' : `${stats.activePrograms} activos`,
              icon: Trophy
            },
            {
              title: 'Entrenadores',
              value: stats.activeTeams,
              description: stats.activeTeams === 0 ? 'Sin entrenadores aún' : 'Equipo técnico',
              icon: Users
            },
            {
              // "del Mes" y no "Mensuales": esta tarjeta es SOLO el mes en curso.
              // El acumulado histórico vive en Gestión de Pagos → Ingresos Totales,
              // y verlos distintos confundía (uno es global, este no).
              title: 'Ingresos del Mes',
              value: `$${stats.totalRevenue || 0}`,
              description: 'Solo este mes',
              icon: DollarSign
            }
          ],
          activities: [],
          quickActions: schoolQuickActions,
          onboardingSteps: onboardingConfigs.school
        };

      case 'wellness_professional':
        return {
          role: 'wellness_professional',
          title: 'Panel del Profesional',
          description: 'Tus pacientes, tu agenda y tus tratamientos',
          stats: [
            {
              title: 'Pacientes activos',
              value: stats.activePatients ?? 0,
              description: 'En tu lista',
              icon: Users,
              href: '/pacientes'
            },
            {
              title: 'Citas hoy',
              value: stats.appointmentsToday ?? 0,
              description: 'Agendadas para hoy',
              icon: Calendar,
              href: '/schedule'
            },
            {
              title: 'Solicitudes por confirmar',
              value: stats.pendingRequests ?? 0,
              description: (stats.pendingRequests ?? 0) > 0 ? 'Requieren tu respuesta' : 'Todo al día',
              icon: Bell,
              href: '/schedule'
            },
            {
              title: 'Tratamientos abiertos',
              value: stats.openEpisodes ?? 0,
              description: 'Episodios en curso',
              icon: Heart,
              href: '/pacientes'
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Ver agenda', icon: Calendar, href: '/schedule', variant: 'default' },
            { label: 'Pacientes', icon: Users, href: '/pacientes', variant: 'outline' },
            { label: 'Disponibilidad', icon: Clock, href: '/disponibilidad', variant: 'outline' },
            { label: 'Reportes', icon: BarChart3, href: '/wellness-reports', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.wellness_professional
        };

      case 'store_owner':
        return {
          role: 'store_owner',
          title: 'Panel de Tienda',
          description: 'Gestiona tu inventario y ventas',
          stats: [
            {
              title: 'Productos Activos',
              value: stats.products,
              description: stats.products === 0 ? 'Crea tu primer producto' : 'En catálogo',
              icon: ShoppingBag
            },
            {
              title: 'Ventas (30 días)',
              value: `$${Math.round(stats.totalRevenue || 0).toLocaleString('es-CO')}`,
              description: 'Pedidos pagados',
              icon: TrendingUp,
              href: '/vendor/dashboard'
            },
            {
              title: 'Pedidos pagados',
              value: stats.orders,
              description: 'Últimos 30 días',
              icon: Clock,
              href: '/orders'
            },
            {
              title: 'Ticket promedio',
              value: `$${Math.round(stats.storeAvgTicket || 0).toLocaleString('es-CO')}`,
              description: 'Por pedido pagado',
              icon: DollarSign
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Ver Productos', icon: ShoppingBag, href: '/products', variant: 'default' },
            { label: 'Ver Pedidos', icon: Clock, href: '/orders', variant: 'outline' },
            { label: 'Inventario', icon: BarChart3, href: '/inventory', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.store_owner
        };

      case 'admin':
        return {
          role: 'admin',
          title: 'Panel de Administración Global',
          description: 'Vista general del conglomerado de sedes',
          stats: [
            {
              title: 'Total Deportistas',
              value: stats.totalStudents || 0,
              description: 'Suma de todas las sedes',
              icon: Users
            },
            {
              title: 'Sedes Activas',
              value: stats.teams || 0, // En Global, admin mapea programs/teams como clubs si no se trae count exacto
              description: 'En el sistema',
              icon: Building
            },
            {
              title: 'Total Entrenadores',
              value: stats.activeTeams || 0,
              description: 'Asignados',
              icon: Users
            },
            {
              title: 'Ingresos Totales',
              value: `$${stats.totalRevenue || 0}`,
              description: 'Este mes',
              icon: TrendingUp
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Gestionar Deportistas', icon: Users, href: '/students', variant: 'default' },
            { label: 'Gestionar Sedes', icon: Building, href: '/branches', variant: 'outline' },
            { label: 'Reportes Globales', icon: BarChart3, href: '/school-reports', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.school
        };

      case 'organizer':
        return {
          role: 'organizer',
          title: 'Panel de Organizador',
          description: 'Gestiona tus eventos deportivos',
          stats: [
            {
              title: 'Eventos Activos',
              value: 0,
              description: 'En curso',
              icon: Trophy
            },
            {
              title: 'Participantes',
              value: 0,
              description: 'Inscritos totales',
              icon: Users
            },
            {
              title: 'Recaudación',
              value: '$0',
              description: 'Este mes',
              icon: TrendingUp
            },
            {
              title: 'Notificaciones',
              value: stats.unreadNotifications,
              description: 'Sin leer',
              icon: Bell
            }
          ],
          activities: [],
          quickActions: [
            { label: 'Crear torneo', icon: Plus, href: '/school/tournaments/nuevo-rapido', variant: 'default' },
            { label: 'Mis torneos', icon: Trophy, href: '/school/tournaments', variant: 'outline' }
          ],
          onboardingSteps: onboardingConfigs.organizer
        };

      case 'accountant':
        return {
          role: 'accountant' as UserRole,
          title: 'Panel del Contador',
          description: 'Contabilidad de la escuela — solo lectura',
          stats: [
            { title: 'Libro de caja', value: '→', description: 'Ingresos y egresos del mes', icon: DollarSign },
            { title: 'Estado de resultados', value: '→', description: 'Resultado del año', icon: BarChart3 },
            { title: 'Acceso', value: 'Solo Lectura', description: 'Sin registrar ni pagar', icon: Shield },
            { title: 'Notificaciones', value: stats.unreadNotifications, description: 'Sin leer', icon: Bell },
          ],
          activities: [],
          quickActions: [
            { label: 'Libro de caja', icon: DollarSign, href: '/accounting', variant: 'default' },
            { label: 'Estado de resultados', icon: BarChart3, href: '/accounting/reports', variant: 'outline' },
            { label: 'Nómina', icon: Users, href: '/accounting/payroll', variant: 'outline' },
          ],
          onboardingSteps: []
        };

      case 'reporter':
        return {
          role: 'reporter' as UserRole,
          title: 'Panel de Auditoría',
          description: 'Vista consolidada de solo lectura',
          stats: [
            {
              title: 'Panel de Reportes',
              value: '📊',
              description: 'Ver reportes completos',
              icon: BarChart3
            },
            {
              title: 'Acceso',
              value: 'Solo Lectura',
              description: 'Sin permisos de edición',
              icon: Shield
            },
            {
              title: 'Notificaciones',
              value: stats.unreadNotifications,
              description: 'Sin leer',
              icon: Bell
            },
            {
              title: 'Calendario',
              value: '→',
              description: 'Ver agenda',
              icon: Calendar
            }
          ],
          activities: [],
          quickActions: [
            { label: '📊 Abrir Panel de Reportes', icon: BarChart3, href: '/reporter-dashboard', variant: 'default' },
            { label: 'Calendario', icon: Calendar, href: '/calendar', variant: 'outline' },
            { label: 'Configuración', icon: Circle, href: '/settings', variant: 'outline' }
          ],
          onboardingSteps: []
        };

      default:
        return {
          role: 'athlete',
          title: 'Dashboard',
          description: 'Bienvenido a SportMaps',
          stats: [],
          onboardingSteps: []
        };
    }
  }, [role, statsData, savedQuickActionIds]);
}
