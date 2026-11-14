import {
  Users,
  Trophy,
  Zap,
  DollarSign,
  Calendar,
  BookOpen,
  FileText,
  BarChart3,
  Bell,
  Send,
  History,
  Dumbbell,
  ShieldCheck,
  MapPin,
  IdCard,
  FileCheck2,
  QrCode,
} from 'lucide-react';

export interface QuickActionCandidate {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
}

/**
 * Candidatos para "Acciones Rápidas" de escuela/school_admin. Ni `NavItem`
 * (navigation.ts) ni `QuickAction` (types/dashboard.ts) tienen un id estable
 * para guardar la preferencia, así que este catálogo vive aparte — misma
 * pantalla de destino que el sidebar, ids propios para no atarse al `label`
 * (texto libre, puede cambiar) ni al `href` (no siempre único).
 */
export const QUICK_ACTIONS_CATALOG_SCHOOL: QuickActionCandidate[] = [
  { id: 'students', label: 'Gestionar Deportistas', icon: Users, href: '/students' },
  { id: 'teams', label: 'Ver Equipos', icon: Trophy, href: '/programs-management' },
  { id: 'offerings', label: 'Ver Planes', icon: Zap, href: '/offerings' },
  { id: 'payments', label: 'Cobros y Pagos', icon: DollarSign, href: '/payments-automation' },
  { id: 'staff', label: 'Agregar Entrenador', icon: Users, href: '/staff' },
  { id: 'calendar', label: 'Calendario', icon: Calendar, href: '/calendar' },
  { id: 'accounting', label: 'Contabilidad', icon: BookOpen, href: '/accounting' },
  { id: 'finances', label: 'Finanzas', icon: DollarSign, href: '/finances' },
  { id: 'reports', label: 'Reportes', icon: FileText, href: '/school-reports' },
  { id: 'reporter_dashboard', label: 'Panel de Reportes', icon: BarChart3, href: '/reporter-dashboard' },
  { id: 'payment_reminders', label: 'Recordatorios', icon: Bell, href: '/payment-reminders' },
  { id: 'invitations', label: 'Invitaciones', icon: Send, href: '/invitations' },
  { id: 'attendance_supervision', label: 'Supervisión de Asistencias', icon: BarChart3, href: '/attendance-supervision' },
  { id: 'attendance_history', label: 'Histórico de Asistencias', icon: History, href: '/attendance-history' },
  { id: 'results', label: 'Resultados', icon: Trophy, href: '/results' },
  { id: 'tournaments', label: 'Mis Torneos', icon: Trophy, href: '/school/tournaments' },
  { id: 'equipment', label: 'Dotación', icon: Dumbbell, href: '/school/equipment' },
  { id: 'access_control', label: 'Control de Acceso', icon: ShieldCheck, href: '/school/access-control' },
  { id: 'branches', label: 'Sedes', icon: MapPin, href: '/branches' },
  { id: 'cards', label: 'Carnets Digitales', icon: IdCard, href: '/cards' },
  { id: 'certificates', label: 'Constancias', icon: FileCheck2, href: '/certificates' },
  { id: 'qr_signup', label: 'QR de Inscripción', icon: QrCode, href: '/qr-signup' },
];

/** Lo que se ve hoy si nadie personalizó nada — cero cambio de comportamiento. */
export const DEFAULT_QUICK_ACTIONS_SCHOOL = ['students', 'teams', 'offerings', 'payments', 'staff'];
