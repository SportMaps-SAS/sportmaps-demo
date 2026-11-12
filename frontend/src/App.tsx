import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
// v2.1 — polls, reports, events docs
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { CartProvider } from "@/contexts/CartContext";
import { SchoolProvider } from "@/hooks/useSchoolContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ModuleGate } from "@/components/ModuleGate";
import { StoreGate } from "@/components/store/StoreGate";
import { RequirePersonalTrainer } from "@/components/trainer/RequirePersonalTrainer";
import AuthLayout from "@/layouts/AuthLayout";
import { MobileBottomNav } from "@/components/navigation/MobileBottomNav";
import { CartDrawer } from "@/components/cart/CartDrawer";
import { Suspense, lazy } from "react";
import { ACUDIENTE_V2, ENTRENADOR_V2, DEPORTISTA_V2, SHOW_EXPLORE } from "@/lib/feature-flags";
import { MasSegunRol, EntrenosSegunRol, ProgresoSegunRol, CarnetSegunRol, PagosDeportistaSegunRol, EquiposSegunRol, EvaluarEquipoRuta, SesionesSegunRol, PlanificacionCompleta, AsistenciaSegunRol, EntrenamientosCompletos, EstadisticasCompletas } from "@/components/v2/RutasSegunRol";
const ExplorarProntoPage = lazy(() => import("./pages/ExplorarProntoPage"));
import ErrorBoundary from "@/components/ErrorBoundary";
import { InstallBanner } from "./pwa/InstallBanner";
import { UpdateBanner } from "./pwa/UpdateBanner";
import { IdleTimer } from "@/components/auth/IdleTimer";
import { IdleConfigProvider } from "@/contexts/IdleConfigContext";


// ─── Skeleton de carga global ─────────────────────────────────────────────────
const PageLoader = () => (
  <div className="flex items-center justify-center min-h-screen bg-background">
    <div className="flex flex-col items-center gap-4">
      <div className="h-10 w-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      <p className="text-sm text-muted-foreground animate-pulse">Cargando...</p>
    </div>
  </div>
);

// ─── Public pages (lazy) ──────────────────────────────────────────────────────
const Index = lazy(() => import("./pages/Index"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const RegisterPage = lazy(() => import("./pages/RegisterPage"));
const OnboardingRolePage = lazy(() => import("./pages/OnboardingRolePage"));
const ElegirRolPage = lazy(() => import("./pages/ElegirRolPage"));
const JoinTeamPage = lazy(() => import("./pages/JoinTeamPage"));
const JoinPlanPage = lazy(() => import("./pages/JoinPlanPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const AccountDeletionPage = lazy(() => import("./pages/AccountDeletionPage"));
const SchoolDetailPage = lazy(() => import("./pages/SchoolDetailPage"));
const UnauthorizedPage = lazy(() => import("./pages/UnauthorizedPage"));
const NotFound = lazy(() => import("./pages/NotFound"));
const StoreCheckoutPage = lazy(() => import("./pages/StoreCheckoutPage"));
const PedidoInvitadoPage = lazy(() => import("./pages/PedidoInvitadoPage"));
const CarritoPage = lazy(() => import("./pages/CarritoPage"));
const TiendaProductoPage = lazy(() => import("./pages/TiendaProductoPage"));
const MisComprasPage = lazy(() => import("./pages/MisComprasPage"));
const MiCompraDetallePage = lazy(() => import("./pages/MiCompraDetallePage"));
const ParentCheckoutPage = lazy(() => import("./pages/ParentCheckoutPage"));
const PaymentResultPage = lazy(() => import("./pages/PaymentResultPage"));
const PaymentConfirmationPage = lazy(() => import("./pages/PaymentConfirmationPage"));
const PublicSchoolPage = lazy(() => import("./pages/PublicSchoolPage"));
const SchoolProfilePage = lazy(() => import("./pages/SchoolProfilePage"));
const HelpCenterPage = lazy(() => import("./pages/HelpCenterPage"));
const HelpArticlePage = lazy(() => import("./pages/HelpArticlePage"));
const SchoolPublicProfilePage = lazy(() => import("./pages/school/SchoolPublicProfilePage"));
const VendorPublicProfilePage = lazy(() => import("./pages/vendor/VendorPublicProfilePage"));
const MyAppointmentsPage = lazy(() => import("./pages/wellness/MyAppointmentsPage"));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));
const RecepcionPage = lazy(() => import("./pages/recepcion/RecepcionPage"));

// ─── Events (public, lazy) ────────────────────────────────────────────────────
const EventsMapPage = lazy(() => import("./pages/events/EventsMapPage"));
const EventPublicPage = lazy(() => import("./pages/events/EventPublicPage"));
const PublicFacilityBookingPage = lazy(() => import("./pages/booking/PublicFacilityBookingPage"));
const ReservarPage = lazy(() => import("./pages/reservar/ReservarPage"));
const ReservaEstadoPage = lazy(() => import("./pages/reservar/ReservaEstadoPage"));
const PublicTrialClassBookingPage = lazy(() => import("./pages/booking/PublicTrialClassBookingPage"));
const EventIndividualRegisterPage = lazy(() => import("./pages/events/EventIndividualRegisterPage"));
const MyEventRegistrationsPage = lazy(() => import("./pages/events/MyEventRegistrationsPage"));
const TournamentRegisterPage = lazy(() => import("./pages/events/TournamentRegisterPage"));
const TournamentResultsPage = lazy(() => import("./pages/events/TournamentResultsPage"));
const TournamentLivePage = lazy(() => import("./pages/events/TournamentLivePage"));
const TournamentTvPage = lazy(() => import("./pages/events/TournamentTvPage"));
const TournamentMatchPage = lazy(() => import("./pages/events/TournamentMatchPage"));
const TournamentEmbedPage = lazy(() => import("./pages/events/TournamentEmbedPage"));
const TournamentScorerPage = lazy(() => import("./pages/events/TournamentScorerPage"));
const TournamentTeamInvitePage = lazy(() => import("./pages/events/TournamentTeamInvitePage"));
const TournamentCardValidationPage = lazy(() => import("./pages/events/TournamentCardValidationPage"));

// ─── Polls (lazy) ────────────────────────────────────────────────────────────
const PollsPage = lazy(() => import("./pages/polls/PollsPage"));
const PublicPollPage = lazy(() => import("./pages/polls/PublicPollPage"));
const PollResultsPage = lazy(() => import("./pages/polls/PollResultsPage"));

// ─── Dashboard pages (lazy) ───────────────────────────────────────────────────
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const BiomechVolleyballLabPage = lazy(() => import("./pages/BiomechVolleyballLabPage"));
const SchoolSportsPage = lazy(() => import("./pages/SchoolSportsPage"));
const MembershipsPage = lazy(() => import("./pages/MembershipsPage"));
const OfferingsPage = lazy(() => import("./pages/OfferingsPage"));
const MessagesPage = lazy(() => import("./pages/MessagesPage"));
const PerfilSegunRol = lazy(() => import("./components/parent/v2/PerfilSegunRol"));
const MyEnrollmentsPage = lazy(() => import("./pages/MyEnrollmentsPage"));
const ShopPage = lazy(() => import("./pages/ShopPage"));

// ─── Parent pages (lazy) ──────────────────────────────────────────────────────
// Acudiente V2: con VITE_ACUDIENTE_V2=false vuelven las pantallas anteriores (copias intactas).
const MyChildrenPage = lazy(() => ACUDIENTE_V2 ? import("./pages/MyChildrenPage") : import("./pages/MyChildrenPageClassic"));
const ChildProgressPage = lazy(() => import("./pages/ChildProgressPage"));
const ChildAttendancePage = lazy(() => import("./pages/ChildAttendancePage"));
const ChildReportsPage = lazy(() => import("./pages/ChildReportsPage"));
const ChildMatchReportsPage = lazy(() => import("./pages/ChildMatchReportsPage"));
const ChildReportDetailPage = lazy(() => import("./pages/ChildReportDetailPage"));
const ChildPostTrainingReportPage = lazy(() => import("./pages/ChildPostTrainingReportPage"));
const AcademicProgressPage = lazy(() => import("./pages/AcademicProgressPage"));
const AttendancePage = lazy(() => import("./pages/AttendancePage"));
const MyPaymentsPage = lazy(() => ACUDIENTE_V2 ? import("./pages/MyPaymentsPage") : import("./pages/MyPaymentsPageClassic"));
const AccountStatementPage = lazy(() => import("./pages/AccountStatementPage"));
const PostTrainingSelfEvalPage = lazy(() => import("./pages/PostTrainingSelfEvalPage"));
const PostTrainingDayRecapPage = lazy(() => import("./pages/PostTrainingDayRecapPage"));

// ─── Coach pages (lazy) ───────────────────────────────────────────────────────
const CoachCheckInScanPage = lazy(() => import("./pages/CoachCheckInScanPage"));
const CoachPlansPage = lazy(() => import("./pages/CoachPlansPage"));
const ResultsPage = lazy(() => import("./pages/ResultsPage"));
const PartidoPage = lazy(() => import("./pages/PartidoPage"));
const PartidoEnVivoPage = lazy(() => import("./pages/PartidoEnVivoPage"));
const CoachReportsPage = lazy(() => import("./pages/CoachReportsPage"));
const CoachTeamPostTrainingReportPage = lazy(() => import("./pages/CoachTeamPostTrainingReportPage"));
const CoachEvaluationsPage = lazy(() => import("./pages/CoachEvaluationsPage"));
const AnnouncementsPage = lazy(() => import("./pages/AnnouncementsPage"));

// ─── School pages (lazy) ──────────────────────────────────────────────────────
const SchoolStudentsManagementPage = lazy(() => import("./pages/SchoolStudentsManagementPage"));
const MiPlanPage = lazy(() => import("./pages/MiPlanPage"));
const AdminUpgradeRequestsPage = lazy(() => import("./pages/AdminUpgradeRequestsPage"));
const StaffPage = lazy(() => import("./pages/StaffPage"));
const ProgramsManagementPage = lazy(() => import("./pages/ProgramsManagementPage"));
const AttendanceSupervisionPage = lazy(() => import("./pages/AttendanceSupervisionPage"));
const AttendanceHistoryPage = lazy(() => import("./pages/AttendanceHistoryPage"));
const CoachActivityPage = lazy(() => import("./pages/CoachActivityPage"));
const CoachMyEvaluationsPage = lazy(() => import("./pages/CoachMyEvaluationsPage"));
const ResultsOverviewPage = lazy(() => import("./pages/ResultsOverviewPage"));
const FinancesPage = lazy(() => import("./pages/FinancesPage"));
const AccountingPage = lazy(() => import("./pages/AccountingPage"));
const InvoicingStandalonePage = lazy(() => import("./pages/InvoicingStandalonePage"));
const AccountingSuppliersPage = lazy(() => import("./pages/AccountingSuppliersPage"));
const PayrollPage = lazy(() => import("./pages/PayrollPage"));
const AccountingReportsPage = lazy(() => import("./pages/AccountingReportsPage"));
const AccountingBudgetPage = lazy(() => import("./pages/AccountingBudgetPage"));
const PaymentsAutomationPage = lazy(() => import("./pages/PaymentsAutomationPage"));
const PaymentRemindersPage = lazy(() => import("./pages/PaymentRemindersPage"));
const MessageTemplatesPage = lazy(() => import("./pages/MessageTemplatesPage"));
const WhatsAppPage = lazy(() => import("./pages/WhatsAppPage"));
const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const MonthlyReportsPage = lazy(() => import("./pages/MonthlyReportsPage"));
const SchoolFacilitiesPage = lazy(() => import("./pages/SchoolFacilitiesPage"));
// Dueño de espacios (facility_manager, school_type 'venue')
const VenueDashboardPage = lazy(() => import("./pages/venue/VenueDashboardPage"));
const VenueOnboardingPage = lazy(() => import("./pages/venue/VenueOnboardingPage"));
const VenueReservationsPage = lazy(() => import("./pages/venue/VenueReservationsPage"));
const VenuePaymentsPage = lazy(() => import("./pages/venue/VenuePaymentsPage"));
const SchoolBranchesManagementPage = lazy(() => import("./pages/SchoolBranchesManagementPage"));
const SchoolSettingsPage = lazy(() => import("./pages/SchoolSettingsPage"));
const PickupMonitorPage = lazy(() => import("./pages/school/PickupMonitorPage"));
const InvitationsManagementPage = lazy(() => import("./pages/InvitationsManagementPage"));
const ReporterDashboardPage = lazy(() => import("./pages/ReporterDashboardPage"));

// ─── Athlete pages (lazy) ─────────────────────────────────────────────────────
const GoalsPage = lazy(() => import("./pages/GoalsPage"));
const AthleteWellnessPage = lazy(() => import("./pages/AthleteWellnessPage"));

// ─── Store pages (lazy) ───────────────────────────────────────────────────────
const StoreProductsPage = lazy(() => import("./pages/StoreProductsPage"));
const StoreOrdersPage = lazy(() => import("./pages/StoreOrdersPage"));
const StoreInventoryPage = lazy(() => import("./pages/StoreInventoryPage"));

// ─── Wellness pages (lazy) ────────────────────────────────────────────────────
const WellnessSchedulePage = lazy(() => import("./pages/WellnessSchedulePage"));
const NutritionPage = lazy(() => import("./pages/NutritionPage"));
// Profesionales de salud: historia clínica (custodio = el profesional), lesiones,
// ejercicios, y lo que ven familia y escuela. Spec: docs/specs/profesionales-salud-fisioterapia.md
const PatientsPage = lazy(() => import("./pages/clinical/PatientsPage"));
const PatientDetailPage = lazy(() => import("./pages/clinical/PatientDetailPage"));
const PatientRecordPrintPage = lazy(() => import("./pages/clinical/PatientRecordPrintPage"));
const FollowUpsPage = lazy(() => import("./pages/clinical/FollowUpsPage"));
const AvailabilityPage = lazy(() => import("./pages/clinical/AvailabilityPage"));
const ProfessionalReportsPage = lazy(() => import("./pages/clinical/ProfessionalReportsPage"));
const MyHealthPage = lazy(() => import("./pages/clinical/MyHealthPage"));
const ClinicalInviteAcceptPage = lazy(() => import("./pages/clinical/ClinicalInviteAcceptPage"));
const SchoolAvailabilityPage = lazy(() => import("./pages/clinical/SchoolAvailabilityPage"));
const SchoolSetupPage = lazy(() => import("./pages/SchoolSetupPage"));
const SchoolOnboardingPage = lazy(() => import("./pages/SchoolOnboardingPage"));
const AthleteOnboarding = lazy(() => import("./pages/onboarding/AthleteOnboarding"));
const ParentOnboarding = lazy(() => import("./pages/onboarding/ParentOnboarding"));
const CoachOnboarding = lazy(() => import("./pages/onboarding/CoachOnboarding"));
const WellnessOnboarding = lazy(() => import("./pages/onboarding/WellnessOnboarding"));

// ─── Admin pages (lazy) ───────────────────────────────────────────────────────
const AdminPanelPage = lazy(() => import("./pages/AdminPanelPage"));
const AdminAnalyticsPage = lazy(() => import("./pages/AdminAnalyticsPage"));
const AdminUsersPage = lazy(() => import("./pages/AdminUsersPage"));
const AdminSupportInboxPage = lazy(() => import("./pages/AdminSupportInboxPage"));
const AdminClubsPage = lazy(() => import("./pages/AdminClubsPage"));
const AdminSchoolsGlobalPage = lazy(() => import("./pages/AdminSchoolsGlobalPage"));
const AdminEnrollmentIntegrityPage = lazy(() => import("./pages/AdminEnrollmentIntegrityPage"));
const AdminSubscriptionsPage = lazy(() => import("./pages/AdminSubscriptionsPage"));
const SaasInvoiceReceiptPage = lazy(() => import("./pages/SaasInvoiceReceiptPage"));
const AdminActivityLogsPage = lazy(() => import("./pages/AdminActivityLogsPage"));
const PayrollConfigPage = lazy(() => import("./pages/admin/PayrollConfigPage"));
const AdminAccessLogsPage = lazy(() => import("./pages/AdminAccessLogsPage"));
const AdminWhatsAppPlataformaPage = lazy(() => import("./pages/admin/AdminWhatsAppPlataformaPage"));
const AthleteCardPublicPage = lazy(() => import("./pages/AthleteCardPublicPage"));
const CobroPublicoPage = lazy(() => import("./pages/CobroPublicoPage"));
const EstadoCuentaPublicoPage = lazy(() => import("./pages/EstadoCuentaPublicoPage"));
// Pizarra: jugada compartida por enlace (pública) y pizarra libre sin sesión.
const JugadaCompartidaPage = lazy(() => import("./pages/JugadaCompartidaPage"));
const PizarraLibrePage = lazy(() => import("./pages/PizarraLibrePage"));
const SchoolCardsAdminPage = lazy(() => import("./pages/SchoolCardsAdminPage"));
const SchoolCertificatesAdminPage = lazy(() => import("./pages/SchoolCertificatesAdminPage"));
const CertificateTemplatesPage = lazy(() => import("./pages/CertificateTemplatesPage"));
const MyCertificatesPage = lazy(() => import("./pages/MyCertificatesPage"));
const CertificateVerifyPublicPage = lazy(() => import("./pages/CertificateVerifyPublicPage"));
const JoinSchoolPublicPage = lazy(() => import("./pages/JoinSchoolPublicPage"));
const SchoolJoinQRsPage = lazy(() => import("./pages/SchoolJoinQRsPage"));
const SchoolLeadFormPage = lazy(() => import("./pages/SchoolLeadFormPage"));
const JoinSchoolByCodePage = lazy(() => import("./pages/JoinSchoolByCodePage"));

// ─── Vendor/Marketplace pages (lazy) ─────────────────────────────────────────
const MarketplacePage = lazy(() => import("./pages/MarketplacePage"));
const MarketplaceDetailPage = lazy(() => import("./pages/MarketplaceDetailPage"));
const ExplorarGlobalPage = lazy(() => import("./pages/ExplorarGlobalPage"));
const TiendaPublicaPage = lazy(() => import("./pages/TiendaPublicaPage"));
const MiTiendaPage = lazy(() => import("./pages/MiTiendaPage"));
const VendorGuard = lazy(() => import("@/components/vendor/VendorGuard").then(module => ({ default: module.VendorGuard })));
const VendorOnboardingPage = lazy(() => import("./pages/vendor/VendorOnboardingPage"));
const VendorDashboardPage = lazy(() => import("./pages/vendor/VendorDashboardPage"));
const VendorPromotionsPage = lazy(() => import("./pages/vendor/VendorPromotionsPage"));
const VendorServicesPage = lazy(() => import("./pages/vendor/VendorServicesPage"));
const VendorAppointmentsPage = lazy(() => import("./pages/vendor/VendorAppointmentsPage"));
const VendorProductsPage = lazy(() => import("./pages/vendor/VendorProductsPage"));
const ProductWizardPage = lazy(() => import("./components/vendor/product-wizard/ProductWizard").then(m => ({ default: m.ProductWizard })));
const AdminMarketplaceModerationPage = lazy(() => import("./pages/admin/AdminMarketplaceModerationPage"));
const AdminPayoutsPage = lazy(() => import("./pages/admin/AdminPayoutsPage"));
const AdminTacticalAiUsagePage = lazy(() => import("./pages/admin/AdminTacticalAiUsagePage"));
const VendorInboxPage = lazy(() => import("./pages/vendor/VendorInboxPage"));
const VendorPayoutsPage = lazy(() => import("./pages/vendor/VendorPayoutsPage"));
const VendorSubscribersPage = lazy(() => import("./pages/vendor/VendorSubscribersPage"));
const VendorShippingSettingsPage = lazy(() => import("./pages/vendor/VendorShippingSettingsPage"));
// Tu tienda (escuela): cobros, entrega y compartir. Resuelve la tienda por escuela (bug N0).
const SchoolStoreSettingsPage = lazy(() => import("./pages/school/SchoolStoreSettingsPage"));
const SchoolStoreCouponsPage = lazy(() => import("./pages/school/SchoolStoreCouponsPage"));

const OrganizerGuard = lazy(() => import("@/components/organizer/OrganizerGuard").then(module => ({ default: module.OrganizerGuard })));
const OrganizerOnboardingPage = lazy(() => import("./pages/organizer/OrganizerOnboardingPage"));
const OrganizerDashboardPage = lazy(() => import("./pages/organizer/OrganizerDashboardPage"));
const OrganizerProfilePage = lazy(() => import("./pages/organizer/OrganizerProfilePage"));
const CreateEventPage = lazy(() => import("./pages/organizer/CreateEventPage"));
const SchoolTournamentsPage = lazy(() => import("./pages/school/SchoolTournamentsPage"));
const SchoolEquipmentPage = lazy(() => import("./pages/school/SchoolEquipmentPage"));
const CoachEquipmentPage = lazy(() => import("./pages/coach/CoachEquipmentPage"));
const SchoolTournamentDetailPage = lazy(() => import("./pages/school/SchoolTournamentDetailPage"));
const CreateTournamentPage = lazy(() => import("./pages/school/CreateTournamentPage"));
const TournamentWizard = lazy(() => import("./components/tournaments/create/TournamentWizard"));
const EventManagementPage = lazy(() => import("./pages/organizer/EventManagementPage"));
const OrganizerEventsPage = lazy(() => import("./pages/organizer/OrganizerEventsPage"));
const OrganizerFinancesPage = lazy(() => import("./pages/organizer/OrganizerFinancesPage"));
const OrganizerCalendarPage = lazy(() => import("./pages/organizer/OrganizerCalendarPage"));
const OrganizerReportsPage = lazy(() => import("./pages/organizer/OrganizerReportsPage"));
const OrganizerSettingsPage = lazy(() => import("./pages/organizer/OrganizerSettingsPage"));
const EventEnrollmentPage = lazy(() => import("./pages/school/EventEnrollmentPage"));
const SchoolDelegationsPage = lazy(() => import("./pages/school/SchoolDelegationsPage"));
const SchoolDelegationDetailPage = lazy(() => import("./pages/school/SchoolDelegationDetailPage"));
const AccessControlPage = lazy(() => import('./pages/school/AccessControlPage'));
const SchoolRoutines = lazy(() => import("./pages/school/SchoolRoutines"));
const EnrollmentIntakeInboxPage = lazy(() => import("./pages/school/EnrollmentIntakeInboxPage"));

// ─── Trainer pages (lazy) ────────────────────────────────────────────────────
const TrainerOnboarding = lazy(() => import("./pages/trainer/TrainerOnboarding"));
const AttendanceSheetIntakePage = lazy(() => import("./pages/school/AttendanceSheetIntakePage"));
const PlanChangesPage = lazy(() => import("./pages/school/PlanChangesPage"));
const TrainerDashboard = lazy(() => import("./pages/trainer/TrainerDashboard"));
const TrainerClients = lazy(() => import('./pages/trainer/TrainerClients'));
const TrainerRoutines = lazy(() => import('./pages/trainer/TrainerRoutines'));
const TrainerRoutineDetail = lazy(() => import('./pages/trainer/TrainerRoutineDetail'));
const TrainerAvailability = lazy(() => import("./pages/trainer/TrainerAvailability"));
const TrainerPlans = lazy(() => import("./pages/trainer/TrainerPlans"));
const TrainerPayments = lazy(() => import("./pages/trainer/TrainerPayments"));
const TrainerProfileEditor = lazy(() => import("./pages/trainer/TrainerProfileEditor"));
const TrainerPublicProfile = lazy(() => import("./pages/trainer/TrainerPublicProfile"));
const TrainerClientProfile = lazy(() => import("./pages/trainer/TrainerClientProfile"));


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
  },
});

const EnvironmentBanner = () => {
  const env = import.meta.env.VITE_APP_ENV;
  if (!env || env === 'production') return null;

  const colors: Record<string, string> = {
    staging: 'bg-amber-500',
    development: 'bg-blue-500',
    demo: 'bg-purple-600',
  };

  const bgColor = colors[env] || 'bg-slate-700';

  return (
    <div className={`${bgColor} text-white text-center text-[10px] py-1 font-bold uppercase tracking-widest sticky top-0 z-[9999] shadow-md border-b border-white/10 sticky-safe`}>
      Ambiente de {env === 'demo' ? 'Demostración' : env}
    </div>
  );
};

// ─── Layout autenticado ───────────────────────────────
// Removemos el SchoolProvider de aquí porque ThemeProvider y ProtectedRoute 
// necesitan el contexto de la escuela (para colores y roles) ANTES de llegar aquí.
const AuthenticatedLayout = () => (
  <AuthLayout />
);

// Guard que require que el usuario sea entrenador personal.
// Definido en @/components/trainer/RequirePersonalTrainer (importado arriba).

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <IdleConfigProvider>
        <AuthProvider>
          <IdleTimer />
          <SchoolProvider>

          <ThemeProvider>
            <ErrorBoundary>
              <CartProvider>
                <Toaster />
                <Sonner />
                <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <EnvironmentBanner />
                <UpdateBanner />
                <InstallBanner />
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    {/* Public routes */}
                    <Route path="/" element={<Index />} />
                    <Route path="/explore" element={<Navigate to="/explorar?category=schools" replace />} />
                    <Route path="/schools/:id" element={<SchoolDetailPage />} />
                    <Route path="/escuela/:id" element={<SchoolProfilePage />} />
                    <Route path="/ayuda" element={<HelpCenterPage />} />
                    <Route path="/ayuda/:slug" element={<HelpArticlePage />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/reset-password" element={<ResetPasswordPage />} />
                    <Route path="/register" element={<RegisterPage />} />
                    <Route path="/onboarding/role" element={
                      <ProtectedRoute skipOnboardingCheck><OnboardingRolePage /></ProtectedRoute>
                    } />
                    {/* Personas multirol: elegir con qué rol entrar (no usa AuthLayout). */}
                    <Route path="/elegir-rol" element={
                      <ProtectedRoute><ElegirRolPage /></ProtectedRoute>
                    } />
                    <Route path="/join-team/:teamId" element={<JoinTeamPage />} />
                    <Route path="/join-plan/:planId" element={<JoinPlanPage />} />
                    <Route path="/c/:qrToken" element={<AthleteCardPublicPage />} />
                    {/* Enlace sin login de UN cobro: botón de las plantillas de cobranza de WhatsApp
                        (sportmaps.co/p/* redirige aquí desde la landing). El token es la credencial. */}
                    <Route path="/p/:token" element={<CobroPublicoPage />} />
                    {/* Estado de cuenta de una familia, sin login: botón del correo «Ver mi estado de cuenta». El token es la credencial. */}
                    <Route path="/e/:token" element={<EstadoCuentaPublicoPage />} />
                    {/* Jugada de la pizarra compartida por WhatsApp: solo lectura, sin login. */}
                    <Route path="/jugada/:token" element={<JugadaCompartidaPage />} />
                    <Route path="/cert/:folio" element={<CertificateVerifyPublicPage />} />
                    <Route path="/join/:slug" element={<JoinSchoolPublicPage />} />
                    <Route path="/inscripcion/:slug" element={<SchoolLeadFormPage />} />
                    {/* Código de escuela: cuenta existente → bandeja «Por asignar». La página maneja la sesión (guarda el código si no hay). */}
                    <Route path="/unirse" element={<JoinSchoolByCodePage />} />
                    <Route path="/agendar/:slug" element={<PublicFacilityBookingPage />} />
                    <Route path="/reservar/:slug" element={<ReservarPage />} />
                    <Route path="/r/:token" element={<ReservaEstadoPage />} />
                    <Route path="/agendar-clase/:slug" element={<PublicTrialClassBookingPage />} />
                    <Route path="/terminos-y-condiciones" element={<TermsPage />} />
                    <Route path="/terms" element={<Navigate to="/terminos-y-condiciones" replace />} />
                    <Route path="/politica-de-privacidad" element={<PrivacyPage />} />
                    <Route path="/privacy" element={<Navigate to="/politica-de-privacidad" replace />} />
                    {/* Publica a proposito: Google Play exige una URL de eliminacion de
                        cuenta accesible sin instalar la app ni iniciar sesion. Se declara
                        en Play Console -> Contenido de la app -> Eliminacion de datos. */}
                    <Route path="/eliminar-cuenta" element={<AccountDeletionPage />} />
                    <Route path="/delete-account" element={<Navigate to="/eliminar-cuenta" replace />} />
                    {/* Tienda v2: el checkout viejo (/checkout) se eliminó; se paga una tienda a la vez. */}
                    <Route path="/checkout" element={<Navigate to="/carrito" replace />} />
                    <Route path="/carrito" element={<StoreGate><CarritoPage /></StoreGate>} />
                    {/* Sin ProtectedRoute: sin sesión la página ofrece iniciar sesión o comprar sin cuenta (mig. 20261013170553). */}
                    <Route path="/checkout/tienda/:vendorProfileId" element={<StoreGate><StoreCheckoutPage /></StoreGate>} />
                    {/* Pedido sin cuenta: el token del correo es la credencial. Sin StoreGate: un pedido
                        pagado se tiene que poder ver aunque la tienda se apague después. */}
                    <Route path="/pedido/:token" element={<PedidoInvitadoPage />} />
                    <Route path="/onboarding/school" element={
                      <ProtectedRoute><SchoolOnboardingPage /></ProtectedRoute>
                    } />
                    <Route path="/onboarding/athlete" element={
                      <ProtectedRoute><AthleteOnboarding /></ProtectedRoute>
                    } />
                    <Route path="/onboarding/parent" element={
                      <ProtectedRoute><ParentOnboarding /></ProtectedRoute>
                    } />
                    <Route path="/onboarding/coach" element={
                      <ProtectedRoute><CoachOnboarding /></ProtectedRoute>
                    } />
                    <Route path="/onboarding/wellness" element={
                      <ProtectedRoute><WellnessOnboarding /></ProtectedRoute>
                    } />
                    <Route path="/setup/school" element={
                      <ProtectedRoute><SchoolSetupPage /></ProtectedRoute>
                    } />
                    <Route path="/parent-checkout" element={
                      <ProtectedRoute><ParentCheckoutPage /></ProtectedRoute>
                    } />
                    <Route path="/post-entreno/:sessionId" element={
                      <ProtectedRoute><PostTrainingSelfEvalPage /></ProtectedRoute>
                    } />
                    <Route path="/post-entreno/:sessionId/resultado" element={
                      <ProtectedRoute><PostTrainingDayRecapPage /></ProtectedRoute>
                    } />
                    <Route path="/payment-result" element={<PaymentResultPage />} />
                    <Route path="/pagos/confirmacion" element={<PaymentConfirmationPage />} />
                    <Route path="/unauthorized" element={<UnauthorizedPage />} />

                    {/* Public Events routes */}
                    <Route path="/events" element={<Navigate to="/explorar?category=events" replace />} />
                    <Route path="/event/:slug" element={<EventPublicPage />} />
                    <Route path="/event/:eventId/register" element={<EventIndividualRegisterPage />} />
                    <Route path="/my-event-registrations" element={<MyEventRegistrationsPage />} />
                    <Route path="/tournaments/:eventId/results" element={<TournamentResultsPage />} />
                    <Route path="/torneo/:slug/en-vivo" element={<TournamentLivePage />} />
                    <Route path="/torneo/:slug/tv" element={<TournamentTvPage />} />
                    <Route path="/torneo/:slug/partido/:matchId" element={<TournamentMatchPage />} />
                    <Route path="/torneo/:slug/embed" element={<TournamentEmbedPage />} />
                    <Route path="/anotador/:token" element={<TournamentScorerPage />} />
                    <Route path="/torneo/:slug/equipo/:token" element={<TournamentTeamInvitePage />} />
                    <Route path="/torneo/:slug/validar/:token" element={<TournamentCardValidationPage />} />
                    <Route path="/s/:slug" element={<PublicSchoolPage />} />
                    <Route path="/polls/v/:pollId" element={<PublicPollPage />} />

                    {/* Public Marketplace routes */}
                    {/* Explorar apagado para todos hasta terminar su rediseño (SHOW_EXPLORE). */}
                    <Route path="/explorar" element={SHOW_EXPLORE ? <ExplorarGlobalPage /> : <ExplorarProntoPage />} />
                    <Route path="/marketplace" element={<MarketplacePage />} />
                    {/* Detalle de PRODUCTO = tienda; el de servicio (/marketplace/service/:id) sigue abierto. */}
                    <Route path="/marketplace/product/:id" element={<StoreGate><MarketplaceDetailPage /></StoreGate>} />
                    <Route path="/marketplace/:type/:id" element={<MarketplaceDetailPage />} />
                    <Route path="/tienda/:slug" element={<StoreGate><TiendaPublicaPage /></StoreGate>} />
                    <Route path="/tienda/:slug/p/:productId" element={<StoreGate><TiendaProductoPage /></StoreGate>} />

                    {/* Public trainer profile — no auth required */}
                    <Route path="/entrenador/:userId" element={<TrainerPublicProfile />} />

                    {/* Modo Recepción (F-R) — kiosko full-screen para el admin/recepción.
                        No usa AuthLayout (sin chrome). SchoolProvider ya vive en la raíz. */}
                    <Route path="/recepcion" element={
                      <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'reporter']}>
                        <ModuleGate moduleKey="finanzas_recepcion">
                          <RecepcionPage />
                        </ModuleGate>
                      </ProtectedRoute>
                    } />

                    {/* ── Rutas autenticadas — SchoolProvider vive aquí ── */}
                    <Route element={
                      <ProtectedRoute>
                        <AuthenticatedLayout />  {/* ← SchoolProvider wrappea AuthLayout */}
                      </ProtectedRoute>
                    }>
                      <Route path="dashboard" element={<DashboardPage />} />
                      {/* El acudiente V2 tiene una sola «Mi cuenta» (/settings); los demás roles, su perfil de siempre. */}
                      <Route path="profile" element={<PerfilSegunRol />} />
                      <Route path="calendar" element={
                        <ModuleGate moduleKey="gestion_deportiva_calendario">
                          <CalendarPage />
                        </ModuleGate>
                      } />
                      <Route path="notifications" element={<NotificationsPage />} />
                      {/* Pizarra libre: dibujar sin sesión y luego guardar en Mis jugadas o agregar a una sesión. */}
                      <Route path="pizarra" element={
                        <ProtectedRoute allowedRoles={['coach', 'school', 'school_admin', 'admin', 'super_admin']}>
                          <PizarraLibrePage />
                        </ProtectedRoute>
                      } />
                      <Route path="settings" element={<SettingsPage />} />
                      <Route path="messages" element={<MessagesPage />} />

                      {/* Athlete routes */}
                      <Route path="teams" element={
                        <ModuleGate moduleKey="gestion_deportiva_equipos_planes">
                          <EquiposSegunRol />
                        </ModuleGate>
                      } />
                      {/* Entrenador V2: evaluar al equipo en una pantalla. */}
                      {ENTRENADOR_V2 && (
                        <Route path="coach/evaluar/:sessionId" element={
                          <ProtectedRoute allowedRoles={['coach', 'school', 'school_admin', 'admin', 'super_admin']}>
                            <EvaluarEquipoRuta />
                          </ProtectedRoute>
                        } />
                      )}
                      {/* Deportes y categorias: util sobre todo en multideporte.
                          El item del menu se muestra condicionado (AppSidebar). */}
                      <Route path="school-sports" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="gestion_deportiva_equipos_planes">
                            <SchoolSportsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      {/* Membresias del club (CAR-4): para clubes que cobran la
                          membresia por fuera. El item del menu solo aparece cuando
                          la escuela NO cobra por SportMaps (AppSidebar). */}
                      <Route path="memberships" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="gestion_deportiva_equipos_planes">
                            <MembershipsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="offerings" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="gestion_deportiva_equipos_planes">
                            <OfferingsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      {/* /stats, /training, /my-cards, /athlete-payments y /mas: pantalla V2 según el rol (RutasSegunRol). */}
                      <Route path="stats" element={<ProgresoSegunRol />} />
                      <Route path="goals" element={<GoalsPage />} />
                      <Route path="training" element={<EntrenosSegunRol />} />
                      {DEPORTISTA_V2 && <Route path="training/todo" element={<EntrenamientosCompletos />} />}
                      {DEPORTISTA_V2 && <Route path="stats/todo" element={<EstadisticasCompletas />} />}
                      <Route path="enrollments" element={<MyEnrollmentsPage />} />
                      <Route path="shop" element={<StoreGate><ShopPage /></StoreGate>} />
                      <Route path="wellness" element={<AthleteWellnessPage />} />
                      <Route path="athlete-payments" element={
                        <ProtectedRoute allowedRoles={['athlete']}>
                          <PagosDeportistaSegunRol />
                        </ProtectedRoute>
                      } />

                      {/* Parent routes */}
                      <Route path="children" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <MyChildrenPage />
                        </ProtectedRoute>
                      } />
                      <Route path="my-payments" element={
                        <ProtectedRoute allowedRoles={['parent', 'athlete']}>
                          <MyPaymentsPage />
                        </ProtectedRoute>
                      } />
                      {/* «Más» del acudiente V2: quinta pestaña de la barra. Con la reversa no existe. */}
                      {(ACUDIENTE_V2 || ENTRENADOR_V2 || DEPORTISTA_V2) && (
                        <Route path="mas" element={
                          <ProtectedRoute allowedRoles={[
                            ...(ACUDIENTE_V2 ? ['parent' as const] : []),
                            ...(DEPORTISTA_V2 ? ['athlete' as const] : []),
                            ...(ENTRENADOR_V2 ? ['coach' as const] : []),
                          ]}>
                            <MasSegunRol />
                          </ProtectedRoute>
                        } />
                      )}
                      <Route path="tournaments/:eventId/register" element={
                        <ProtectedRoute allowedRoles={['parent', 'athlete']}>
                          <TournamentRegisterPage />
                        </ProtectedRoute>
                      } />
                      {/* Estado de Cuenta: misma RPC/pantalla para admin (viendo
                          cualquier atleta) y para el padre/adulto (viendo el
                          suyo propio) — el gate lo resuelve la RPC, no la ruta. */}
                      <Route path="estado-cuenta" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'parent', 'athlete']}>
                          <AccountStatementPage />
                        </ProtectedRoute>
                      } />
                      <Route path="mi-tienda" element={
                        <ProtectedRoute allowedRoles={['parent', 'athlete']}>
                          <StoreGate><MiTiendaPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      {/* Mis compras (tienda v2 §2.1): cualquier usuario con sesión que compre. */}
                      <Route path="mis-compras" element={
                        <ProtectedRoute><StoreGate><MisComprasPage /></StoreGate></ProtectedRoute>
                      } />
                      <Route path="mis-compras/:orderId" element={
                        <ProtectedRoute><StoreGate><MiCompraDetallePage /></StoreGate></ProtectedRoute>
                      } />

                      <Route path="children/:id/progress" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <AcademicProgressPage />
                        </ProtectedRoute>
                      } />
                      <Route path="children/:id/attendance" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <AttendancePage />
                        </ProtectedRoute>
                      } />
                      <Route path="children/:id/partidos" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <ChildMatchReportsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="children/:id/reports" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <ChildReportsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="children/:id/reports/:reportId" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <ChildReportDetailPage />
                        </ProtectedRoute>
                      } />
                      {/* Informe grupal de Evaluación Post-Entrenamiento, vista
                          del padre — spec evaluacion-post-entrenamiento.md §5.3:
                          el agregado del equipo con el dato de su hija resaltado
                          encima, sin nombres de otras deportistas. */}
                      <Route path="children/:id/post-entreno-informe" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <ChildPostTrainingReportPage />
                        </ProtectedRoute>
                      } />
                      <Route path="academic-progress" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <AcademicProgressPage />
                        </ProtectedRoute>
                      } />
                      <Route path="parent-attendance" element={
                        <ProtectedRoute allowedRoles={['parent']}>
                          <AttendancePage />
                        </ProtectedRoute>
                      } />

                      {/* Coach routes */}
                      <Route path="coach-attendance" element={<AsistenciaSegunRol />} />
                      <Route path="coach-attendance/scan" element={<CoachCheckInScanPage />} />
                      <Route path="coach-plans" element={
                        <ModuleGate moduleKey="gestion_deportiva_disponibilidad_coach" roles={['coach']}>
                          <CoachPlansPage />
                        </ModuleGate>
                      } />
                      <Route path="results" element={<ResultsPage />} />
                      {/* Pantalla del partido: Programar → Convocar → Resultado → Evaluar → Reporte.
                          Sin ProtectedRoute, igual que /results: un entrenador multirol puede no tener
                          profile.role='coach'. El gate real son la RLS y las RPC (user_staff_school_ids). */}
                      <Route path="partidos/:matchId" element={<PartidoPage />} />
                      {/* Partido en vivo (F2-b): pantalla de cancha. La página gatea por flag live_match_enabled + rol staff/coach;
                          las RPC revalidan adentro (director, alcance, flag). */}
                      <Route path="partido-en-vivo/:matchId" element={<PartidoEnVivoPage />} />
                      <Route path="training-plans" element={
                        <ModuleGate moduleKey="gestion_deportiva_entrenamiento_metricas">
                          <SesionesSegunRol />
                        </ModuleGate>
                      } />
                      {/* La planificación completa (crear/editar sesiones y plan del mes), igual que siempre. Con la reversa no existe. */}
                      {ENTRENADOR_V2 && (
                        <Route path="training-plans/planificar" element={
                          <ModuleGate moduleKey="gestion_deportiva_entrenamiento_metricas">
                            <PlanificacionCompleta />
                          </ModuleGate>
                        } />
                      )}
                      <Route path="coach-reports" element={<CoachReportsPage />} />
                      <Route path="coach-reports/entreno-equipo" element={<CoachTeamPostTrainingReportPage />} />
                      <Route path="evaluations" element={<CoachEvaluationsPage />} />
                      <Route path="announcements" element={<AnnouncementsPage />} />

                      {/* Polls routes */}
                      <Route path="dashboard/polls" element={<PollsPage />} />
                      <Route path="dashboard/polls/:pollId/results" element={<PollResultsPage />} />

                      {/* School routes (role-guarded) */}
                      <Route path="school/enroll/:eventId" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <EventEnrollmentPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/delegations" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolDelegationsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/tournaments" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolTournamentsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/tournaments/new" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <CreateTournamentPage />
                        </ProtectedRoute>
                      } />
                      {/* Asistente rápido de torneo (4 pasos, celular). */}
                      <Route path="school/tournaments/nuevo-rapido" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <TournamentWizard />
                        </ProtectedRoute>
                      } />
                      <Route path="school/tournaments/:id" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolTournamentDetailPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/equipment" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolEquipmentPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/dotacion" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolEquipmentPage />
                        </ProtectedRoute>
                      } />
                      <Route path="coach/voleibol-pose" element={
                        <ProtectedRoute allowedRoles={['coach', 'school', 'admin', 'school_admin']}>
                          <BiomechVolleyballLabPage />
                        </ProtectedRoute>
                      } />
                      <Route path="coach/dotacion" element={
                        <ProtectedRoute allowedRoles={['coach', 'school', 'admin', 'school_admin']}>
                          <CoachEquipmentPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/delegations/:id" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin']}>
                          <SchoolDelegationDetailPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/routines" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <ModuleGate moduleKey="gestion_deportiva_entrenamiento_rutinas">
                            <SchoolRoutines />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="school/routines/:routineId" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <ModuleGate moduleKey="gestion_deportiva_entrenamiento_rutinas">
                            <TrainerRoutineDetail />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="students" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <SchoolStudentsManagementPage />
                        </ProtectedRoute>
                      } />
                      {/* Inbox de revisión de hojas de matrícula por foto (WhatsApp + OCR).
                          Revisar y dar de alta sigue siendo solo de admin. El coach entra
                          SOLO a subir la foto, y solo si su escuela lo activó
                          (school_settings.coach_can_upload_enrollment_forms; la página
                          le muestra únicamente el botón y el BFF es el gate real). */}
                      <Route path="school/enrollment-intake" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <ModuleGate moduleKey="deportistas_matriculas_por_revisar">
                            <EnrollmentIntakeInboxPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      {/* El plan lo ve SOLO quien lo paga. Estar asociado a una entidad no
                          alcanza: 'parent', 'athlete' y 'coach' estaban en esta lista y podían
                          abrir la facturación de la escuela — un padre veía el tier, los precios
                          y los 397 alumnos activos del club de sus hijos.
                          'personal_trainer' se queda: es dueño de su propia entidad y ve SU plan.
                          El filtro fino vive en MiPlanPage (rol dentro de la entidad activa);
                          esta lista es solo el primer tamiz. */}
                      <Route path="mi-plan" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'wellness_professional', 'store_owner', 'organizer', 'reporter', 'personal_trainer', 'facility_manager']}>
                          <MiPlanPage />
                        </ProtectedRoute>
                      } />
                      {/* Planillas de asistencia por foto (WhatsApp + OCR): revisar y guardar. El coach ve solo lo suyo (el BFF filtra). */}
                      <Route path="school/attendance-sheets" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <AttendanceSheetIntakePage />
                        </ProtectedRoute>
                      } />
                      {/* Cambios de plan por clases tomadas (modo sombra): solo dinero → dueño/admin/contador; el BFF es el gate real. */}
                      <Route path="school/plan-changes" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <PlanChangesPage />
                        </ProtectedRoute>
                      } />
                      <Route path="invitations" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          <InvitationsManagementPage />
                        </ProtectedRoute>
                      } />
                      <Route path="staff" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <StaffPage />
                        </ProtectedRoute>
                      } />
                      <Route path="programs-management" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ProgramsManagementPage />
                        </ProtectedRoute>
                      } />
                      <Route path="attendance-supervision" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <AttendanceSupervisionPage />
                        </ProtectedRoute>
                      } />
                      <Route path="attendance-history" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <AttendanceHistoryPage />
                        </ProtectedRoute>
                      } />
                      {/* Seguimiento deportivo (F4): actividad semanal por entrenador, solo lectura */}
                      <Route path="seguimiento-deportivo" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <CoachActivityPage />
                        </ProtectedRoute>
                      } />
                      {/* Evaluación de entrenadores (D5): el coach ve solo las publicadas */}
                      <Route path="mis-evaluaciones" element={
                        <ProtectedRoute allowedRoles={['coach']}>
                          <CoachMyEvaluationsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="results-overview" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ResultsOverviewPage />
                        </ProtectedRoute>
                      } />
                      <Route path="finances" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="reportes_finanzas">
                            <FinancesPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="accounting" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <ModuleGate moduleKey="finanzas_contabilidad">
                            <AccountingPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="accounting/suppliers" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <ModuleGate moduleKey="finanzas_contabilidad">
                            <AccountingSuppliersPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="accounting/payroll" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <ModuleGate moduleKey="finanzas_contabilidad">
                            <PayrollPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="accounting/reports" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <ModuleGate moduleKey="finanzas_contabilidad">
                            <AccountingReportsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="accounting/budget" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'accountant']}>
                          <ModuleGate moduleKey="finanzas_contabilidad">
                            <AccountingBudgetPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="facturacion-electronica" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="finanzas_facturacion_electronica">
                            <InvoicingStandalonePage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="payments-automation" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="finanzas_pagos">
                            <PaymentsAutomationPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="cards" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_carnets">
                            <SchoolCardsAdminPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="certificates" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_constancias">
                            <SchoolCertificatesAdminPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="cards/templates/certificates" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_constancias">
                            <CertificateTemplatesPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="my-certificates" element={
                        <ProtectedRoute>
                          <MyCertificatesPage />
                        </ProtectedRoute>
                      } />
                      <Route path="my-cards" element={
                        <ProtectedRoute>
                          <CarnetSegunRol />
                        </ProtectedRoute>
                      } />
                      <Route path="facturacion/recibo/:invoiceId" element={
                        <ProtectedRoute>
                          <SaasInvoiceReceiptPage />
                        </ProtectedRoute>
                      } />
                      <Route path="qr-signup" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_qr_inscripcion">
                            <SchoolJoinQRsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="payment-reminders" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_recordatorios">
                            <PaymentRemindersPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="whatsapp" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="comunicacion_whatsapp">
                            <WhatsAppPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="message-templates" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="documentos_plantillas_mensajes">
                            <MessageTemplatesPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="reporter-dashboard" element={
                        <ProtectedRoute allowedRoles={['reporter', 'school', 'school_admin', 'admin', 'super_admin']}>
                          <ModuleGate moduleKey="reportes_panel">
                            <ReporterDashboardPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="informe-mensual" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'coach']}>
                          {/* roles explícitos: con el default (solo school/school_admin)
                              el coach entraba aunque la escuela apagara el módulo. */}
                          <ModuleGate moduleKey="gestion_deportiva_informe_mensual" roles={['school', 'school_admin', 'coach']}>
                            <MonthlyReportsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="school-reports" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="reportes_reportes">
                            <ReportsPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      {/* Dueño de espacios: solo el perfil facility_manager (menú propio, sin módulos de escuela). */}
                      <Route path="venue/onboarding" element={
                        <ProtectedRoute allowedRoles={['facility_manager']}>
                          <VenueOnboardingPage />
                        </ProtectedRoute>
                      } />
                      <Route path="venue/dashboard" element={
                        <ProtectedRoute allowedRoles={['facility_manager']}>
                          <VenueDashboardPage />
                        </ProtectedRoute>
                      } />
                      <Route path="venue/reservas" element={
                        <ProtectedRoute allowedRoles={['facility_manager']}>
                          <VenueReservationsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="venue/cobros" element={
                        <ProtectedRoute allowedRoles={['facility_manager']}>
                          <VenuePaymentsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="facilities" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'facility_manager']}>
                          <ModuleGate moduleKey="sedes_instalaciones">
                            <SchoolFacilitiesPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="branches" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="sedes_sedes">
                            <SchoolBranchesManagementPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="school-config" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin', 'facility_manager']}>
                          <SchoolSettingsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="school/public-profile" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="cuenta_perfil_publico">
                            <SchoolPublicProfilePage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="school/access-control" element={
                        <ProtectedRoute allowedRoles={['school', 'admin', 'school_admin', 'super_admin']}>
                          <ModuleGate moduleKey="sedes_control_acceso">
                            <AccessControlPage />
                          </ModuleGate>
                        </ProtectedRoute>
                      } />
                      <Route path="vendor/public-profile" element={
                        <ProtectedRoute allowedRoles={['wellness_professional', 'store_owner']}>
                          <VendorPublicProfilePage />
                        </ProtectedRoute>
                      } />
                      <Route path="wellness/appointments" element={
                        <ProtectedRoute>
                          <MyAppointmentsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="pickup" element={
                        <ProtectedRoute allowedRoles={['school', 'admin']}>
                          <PickupMonitorPage />
                        </ProtectedRoute>
                      } />

                      {/* Profesionales de salud */}
                      <Route path="pacientes" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <PatientsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="pacientes/:patientId" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <PatientDetailPage />
                        </ProtectedRoute>
                      } />
                      <Route path="pacientes/:patientId/imprimir" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <PatientRecordPrintPage />
                        </ProtectedRoute>
                      } />
                      <Route path="historias" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <FollowUpsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="disponibilidad" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <AvailabilityPage />
                        </ProtectedRoute>
                      } />
                      <Route path="schedule" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <WellnessSchedulePage />
                        </ProtectedRoute>
                      } />
                      <Route path="wellness-reports" element={
                        <ProtectedRoute allowedRoles={['wellness_professional']}>
                          <ProfessionalReportsPage />
                        </ProtectedRoute>
                      } />
                      {/* Rutas viejas del profesional: eran pantallas vacías o rotas. */}
                      <Route path="athletes" element={<Navigate to="/pacientes" replace />} />
                      <Route path="evaluations/new" element={<Navigate to="/pacientes" replace />} />
                      <Route path="medical-history" element={<Navigate to="/historias" replace />} />
                      <Route path="follow-ups" element={<Navigate to="/historias" replace />} />
                      <Route path="nutrition" element={
                        <ProtectedRoute allowedRoles={['wellness_professional', 'admin', 'super_admin']}>
                          <NutritionPage />
                        </ProtectedRoute>
                      } />
                      {/* Lado del paciente / acudiente y de la escuela */}
                      <Route path="salud" element={
                        <ProtectedRoute>
                          <MyHealthPage />
                        </ProtectedRoute>
                      } />
                      <Route path="salud/invitacion/:token" element={
                        <ProtectedRoute>
                          <ClinicalInviteAcceptPage />
                        </ProtectedRoute>
                      } />
                      <Route path="disponibilidad-medica" element={
                        <ProtectedRoute allowedRoles={['school', 'school_admin', 'coach', 'admin', 'super_admin']}>
                          <SchoolAvailabilityPage />
                        </ProtectedRoute>
                      } />

                      {/* Store routes */}
                      <Route path="products" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin', 'school', 'school_admin', 'super_admin']}>
                          <StoreGate><StoreProductsPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="orders" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin', 'school', 'school_admin', 'super_admin']}>
                          <StoreGate><StoreOrdersPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="inventory" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin', 'school', 'school_admin', 'super_admin']}>
                          <StoreGate><StoreInventoryPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="suppliers" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin']}>
                          <StoreGate><StoreInventoryPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="categories" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin']}>
                          <StoreGate><StoreProductsPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="customers" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin']}>
                          <StoreGate><StoreOrdersPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="promotions" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin']}>
                          <StoreGate><StoreProductsPage /></StoreGate>
                        </ProtectedRoute>
                      } />
                      <Route path="store-reports" element={
                        <ProtectedRoute allowedRoles={['store_owner', 'admin']}>
                          <StoreGate><ReportsPage /></StoreGate>
                        </ProtectedRoute>
                      } />

                      {/* Tu tienda (escuela / gimnasio): ajustes de cobros y entrega.
                          Fuera de VendorGuard: la tienda es de la ESCUELA, no del usuario. */}
                      <Route path="tienda-escuela" element={<Navigate to="/tienda-escuela/ajustes" replace />} />
                      <Route path="tienda-escuela/ajustes" element={
                        <ProtectedRoute allowedRoles={['school', 'school_admin', 'admin', 'super_admin']}>
                          <SchoolStoreSettingsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="tienda-escuela/cupones" element={
                        <ProtectedRoute allowedRoles={['school', 'school_admin', 'admin', 'super_admin']}>
                          <StoreGate><SchoolStoreCouponsPage /></StoreGate>
                        </ProtectedRoute>
                      } />

                      {/* Vendor routes */}
                      <Route element={<VendorGuard />}>
                        <Route path="vendor/onboarding" element={<VendorOnboardingPage />} />
                        <Route path="vendor/dashboard" element={<VendorDashboardPage />} />
                        <Route path="vendor/services" element={<VendorServicesPage />} />
                        <Route path="vendor/appointments" element={<VendorAppointmentsPage />} />
                        <Route path="vendor/products" element={<StoreGate><VendorProductsPage /></StoreGate>} />
                        <Route path="vendor/products/new" element={<StoreGate><ProductWizardPage /></StoreGate>} />
                        <Route path="vendor/products/:id/edit" element={<StoreGate><ProductWizardPage /></StoreGate>} />
                        <Route path="vendor/inbox" element={<StoreGate><VendorInboxPage /></StoreGate>} />
                        <Route path="vendor/payouts" element={<StoreGate><VendorPayoutsPage /></StoreGate>} />
                        <Route path="vendor/subscribers" element={<VendorSubscribersPage />} />
                        <Route path="vendor/shipping" element={<StoreGate><VendorShippingSettingsPage /></StoreGate>} />
                        <Route path="vendor/promotions" element={<StoreGate><VendorPromotionsPage /></StoreGate>} />
                      </Route>

                      {/* Organizer routes */}
                      <Route element={<OrganizerGuard />}>
                        <Route path="organizer/onboarding" element={<OrganizerOnboardingPage />} />
                        <Route path="organizer/dashboard" element={<OrganizerDashboardPage />} />
                        <Route path="organizer/profile" element={<OrganizerProfilePage />} />
                        <Route path="organizer/create-event" element={<CreateEventPage />} />
                        <Route path="organizer/torneo-rapido" element={<TournamentWizard />} />
                        <Route path="organizer/event/:id" element={<EventManagementPage />} />
                        <Route path="organizer/events" element={<OrganizerEventsPage />} />
                        <Route path="organizer/finances" element={<OrganizerFinancesPage />} />
                        <Route path="organizer/calendar" element={<OrganizerCalendarPage />} />
                        <Route path="organizer/reports" element={<OrganizerReportsPage />} />
                        <Route path="organizer/settings" element={<OrganizerSettingsPage />} />
                      </Route>

                      {/* Trainer onboarding — accesible si estás autenticado aunque aún no seas trainer "completo" */}
                      <Route path="trainer/onboarding" element={<TrainerOnboarding />} />

                      {/* Trainer workspace — guard RequirePersonalTrainer */}
                      <Route element={<RequirePersonalTrainer />}>
                        <Route path="trainer/dashboard" element={<TrainerDashboard />} />
                        <Route path="trainer/clients" element={<TrainerClients />} />
                        <Route path="trainer/clients/:clientId" element={<TrainerClientProfile />} />
                        <Route path="trainer/routines" element={<TrainerRoutines />} />
                        <Route path="trainer/routines/:routineId" element={<TrainerRoutineDetail />} />
                        <Route path="trainer/availability" element={<TrainerAvailability />} />
                        <Route path="trainer/plans" element={<TrainerPlans />} />
                        <Route path="trainer/payments" element={<TrainerPayments />} />
                        <Route path="trainer/profile" element={<TrainerProfileEditor />} />
                      </Route>


                      {/* Admin routes — TODAS con strictRoleCheck (solo plataforma). Una
                          escuela no entra a /admin/* por URL; sus pantallas viven en
                          /students, /staff, /finances, /settings, etc. */}
                      <Route path="admin" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminPanelPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/users" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminUsersPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/support" element={
                        <ProtectedRoute allowedRoles={['super_admin']} strictRoleCheck>
                          <AdminSupportInboxPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/clubs" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminClubsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/schools" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminSchoolsGlobalPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/enrollment-integrity" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminEnrollmentIntegrityPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/upgrade-requests" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminUpgradeRequestsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/subscriptions" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminSubscriptionsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/reports" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <ReportsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/analytics" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminAnalyticsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/config" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <SettingsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/payroll-config" element={
                        <ProtectedRoute allowedRoles={['super_admin']} strictRoleCheck>
                          <PayrollConfigPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/logs" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <NotificationsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/activity-logs" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminActivityLogsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/access-logs" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminAccessLogsPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/whatsapp" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminWhatsAppPlataformaPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/marketplace/moderation" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminMarketplaceModerationPage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/ia-pizarra" element={
                        <ProtectedRoute allowedRoles={['super_admin']} strictRoleCheck>
                          <AdminTacticalAiUsagePage />
                        </ProtectedRoute>
                      } />
                      <Route path="admin/payouts" element={
                        <ProtectedRoute allowedRoles={['admin', 'super_admin']} strictRoleCheck>
                          <AdminPayoutsPage />
                        </ProtectedRoute>
                      } />
                    </Route>

                    {/* Catch-all */}
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>

                <MobileBottomNav />
                <StoreGate fallback={null}><CartDrawer /></StoreGate>
              </BrowserRouter>
            </CartProvider>
          </ErrorBoundary>
        </ThemeProvider>
      </SchoolProvider>
        </AuthProvider>
      </IdleConfigProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;