import { BranchChip } from '@/components/common/BranchChip';
import { etiquetaEstadoPago } from '@/components/account-statement/estadoCuentaModel';
import { ENTRENADOR_V2 } from '@/lib/feature-flags';
import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { useAuth } from '@/contexts/AuthContext';
import { AssignSchedulingTeamModal } from '@/components/teams/AssignSchedulingTeamModal';
import { normalizeText } from '@/lib/normalizeText';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { PlanChangeDialog, fetchPlanChangePreview, type PlanChangePreview, type PlanChangeChargeMode } from '@/components/students/PlanChangeDialog';
import { PlanCombobox } from '@/components/students/PlanCombobox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { StatFilterBar, type StatFilterTone } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';
import { UserPlus, FileUp, Search, Send, UserMinus, UserCheck, Edit, Loader2, CheckSquare, MoreVertical, Trophy, Zap, CalendarIcon, User, Phone, Mail, FileText, Download, Heart, MapPin, X, RefreshCw, Clock, Upload, AlertTriangle, CalendarX } from 'lucide-react';
import { HourBankBalanceCard } from '@/components/access/HourBankBalanceCard';
import { formatHourBankMinutes } from '@/lib/hourBank';
import { StudentReportPanel } from '@/components/access/StudentReportPanel';
import { useToast } from '@/hooks/use-toast';
import { useMemberships } from '@/hooks/useMemberships';
import { MembershipBadge } from '@/components/memberships/MembershipBadge';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { CSVImportModal } from '@/components/students/CSVImportModal';
import { StudentTypeSelector } from '@/components/students/StudentTypeSelector';
import { EpsCombobox } from '@/components/common/EpsCombobox';
import { TSHIRT_SIZES, BLOOD_TYPES } from '@/lib/athlete-options';
import { CreateChildModal } from '@/components/students/CreateChildModal';
import { ClasePruebaPanel } from '@/components/students/ClasePruebaPanel';
import { TrialClassSettingsModal } from '@/components/school/TrialClassSettingsModal';
import { useProspectosClasePrueba, type ProspectoClasePrueba } from '@/hooks/useClasePrueba';
import { SiblingFamilySection } from '@/components/students/siblings';
import { EnrollmentFeesSection, NO_FEES_MARKED, cobrarInscripcionSeguro, type FeesMarked } from '@/components/students/EnrollmentFeesSection';
import { ZkPinField } from '@/components/students/ZkPinField';
import { CreateAdultAthleteModal } from '@/components/students/CreateAdultAthleteModal';
import { PorAsignarSection } from '@/components/school-join/PorAsignarSection';
import { useSoportesEstado } from '@/components/soportes/useSoportesEstado';
import { SoportesInsignia, SoportesFiltroToggle } from '@/components/soportes/SoportesInsignia';
import { SoportesPendientesInforme } from '@/components/soportes/SoportesPendientesInforme';
import { BandejaSolicitudesPlan } from '@/components/solicitudes-de-plan';
import { FichaDeportistaExtras } from '@/components/students/FichaDeportistaExtras';
import { llaveSujeto, tipoSujetoDeAtleta } from '@/lib/api/soportes';
import { CobrosYPagosModal } from '@/components/payment/CobrosYPagosModal';
import { isCobrosYPagosEnabled } from '@/lib/cobrosYPagosFlag';
import { canManageCharges } from '@/lib/cobrosYPagos';
import {
  useSchoolContext,
  createStudentWithPendingPayment,
  describirAtletaDuplicado,
  esAtletaDuplicado,
  type AtletaDuplicado,
} from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import PauseAthleteDialog from '@/components/students/PauseAthleteDialog';
import ResolverCobrosAbiertosDialog from '@/components/students/ResolverCobrosAbiertosDialog';
import { fetchCobrosAbiertos, hayAlgoQueResolver, type OrigenVentana } from '@/lib/cobrosAbiertos';
import PauseRequestsInbox from '@/components/students/PauseRequestsInbox';
import {
  useActivePauses,
  usePendingPauseRequests,
  usePauseActions,
  mesLegible,
} from '@/hooks/usePauses';
import { studentsAPI, StudentViewRow } from '@/lib/api/students';
import { getPaymentState, type PaymentState } from '@/lib/studentPaymentState';
import { groupOpenDebtByAthlete, type AthleteOpenDebt } from '@/lib/paymentCartera';
import { chargeLabel } from '@/lib/payment-accounts';
import { MedicalAlertBadge } from '@/components/common/MedicalAlertBadge';
import { useNavigate } from 'react-router-dom';
import { comprimirParaSubir } from '@/lib/imageCompression';
import { fichaVaAlAcudiente, invitacionParaAtleta } from '@/lib/invitations/contactoFicha';
import { fetchCoachTeams } from '@/lib/coachTeamScope';
import { carpetasDocumentosDeportista } from '@/components/parent/v2/hijos/hijosUtils';

const studentSchema = z.object({
  full_name:        z.string().min(2, 'Nombre completo es requerido').max(100),
  date_of_birth:    z.string().optional(),
  parent_email:     z.string().optional(),
  parent_phone:     z.string().optional(),
  team_id:          z.string().optional(),
  offering_plan_id: z.string().optional(),
  team_start_date:   z.string().optional(),
  plan_start_date:   z.string().optional(),
  // Cuotas opcionales: un input numérico vacío llega como NaN; lo normalizamos a
  // undefined para que se pueda dejar VACÍO (p.ej. equipo sin cobro cuando el
  // valor a pagar es el del plan).
  team_monthly_fee:  z.preprocess(
    v => (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v))) ? undefined : v,
    z.number().min(0).optional()),
  plan_monthly_fee:  z.preprocess(
    v => (v === '' || v === null || (typeof v === 'number' && Number.isNaN(v))) ? undefined : v,
    z.number().min(0).optional()),
  fee_is_manual:    z.boolean().optional(),
  fee_reason:       z.string().max(200).optional(),
  discount_type:    z.preprocess(
    v => (v === '' || v === null || v === undefined) ? undefined : v,
    z.enum(['extended_family', 'referral']).optional()),
  medical_info:     z.string().max(1000).optional(),
  notes:            z.string().max(500).optional(),
  tshirt_size:      z.string().optional(),
  blood_type:       z.string().optional(),
  eps_name:         z.string().optional(),
  dorsal:           z.string().max(10).optional(),
  // Documento del menor (RC/TI/CC/CE/PP): la administración puede corregirlo.
  doc_type:         z.string().optional(),
  doc_number:       z.string().max(20).optional(),
  // Documento del acudiente (CC/CE/PP/NIT), solo fichas de menor / sin cuenta.
  guardian_doc_type:   z.string().optional(),
  guardian_doc_number: z.string().max(20).optional(),
  // ID del torniquete (solo escuelas con registrationZkPinEnabled): dígitos, vacío = no tocar.
  zk_pin:           z.string().regex(/^\d{0,8}$/, 'Solo números (hasta 8 dígitos)').optional(),
});

/** ID del lector asociado a un deportista (zk_user_mappings; solo lo lee la administración). */
async function fetchZkPin(
  schoolId: string,
  athleteId: string,
  athleteType: 'child' | 'adult' | 'unregistered',
): Promise<number | null> {
  const col = athleteType === 'child' ? 'child_id'
    : athleteType === 'adult' ? 'user_id'
    : 'unregistered_athlete_id';
  const { data } = await (supabase as any)
    .from('zk_user_mappings')
    .select('zk_pin')
    .eq('school_id', schoolId)
    .eq(col, athleteId)
    .maybeSingle();
  return data?.zk_pin ?? null;
}

/** Fila «ID torniquete» de la ficha (escuelas con registrationZkPinEnabled). */
function ZkPinInfoRow({ schoolId, athleteId, athleteType }: {
  schoolId: string; athleteId: string; athleteType: 'child' | 'adult' | 'unregistered';
}) {
  const { data: pin } = useQuery({
    queryKey: ['zk-pin', schoolId, athleteId],
    queryFn: () => fetchZkPin(schoolId, athleteId, athleteType),
    staleTime: 60_000,
  });
  return <InfoRow label="ID torniquete (ZKTeco)" value={pin != null ? String(pin) : 'Sin asociar'} />;
}

type StudentFormData = z.infer<typeof studentSchema>;

// ── Helpers de filtrado (puros, compartidos por los filtros y los badges) ─────

const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  paid:    'Al día',
  overdue: 'Vencido',
  pending: 'Pendiente',
  none:    'Sin cobro',
  other:   'Otros',
};

// Marca el descuento en `enrollments.fee_reason` (texto libre ya existente,
// sin migración nueva) para poder mostrarlo como badge y reconocer si el
// botón de la Fase 1 ya está aplicado sobre este atleta.
const MILITARY_DISCOUNT_REASON = 'Descuento Fuerza Militar 10%';
const MILITARY_DISCOUNT_RATE = 0.10;

// Descuentos manuales (mig. 20260916101241 + 102444): uno solo por atleta,
// van de la mano de fee_is_manual (el monto ya se pone a mano). discount_type
// es el tag estructurado; estas etiquetas son solo para mostrar/elegir en la
// UI. Hermanos NO vive acá — se calcula solo en open_month.
const DISCOUNT_TYPE_LABELS: Record<'extended_family' | 'referral', { icon: string; label: string; badge: string }> = {
  extended_family: { icon: '👨‍👩‍👧', label: 'Primos / familia extendida', badge: 'Primos' },
  referral:        { icon: '🤝',    label: 'Referido',                    badge: 'Referido' },
};

/** Texto del badge cuando fee_is_manual=true: "Becado" por defecto, o el tipo
 *  manual (primos/referido) si discount_type lo especifica. */
function manualFeeBadge(student: any): string {
  const type = student?.discount_type as 'extended_family' | 'referral' | null | undefined;
  return type && DISCOUNT_TYPE_LABELS[type] ? `${DISCOUNT_TYPE_LABELS[type].icon} ${DISCOUNT_TYPE_LABELS[type].badge}` : '🎓 Becado';
}

const PAYMENT_STATE_TONES: Record<PaymentState, StatFilterTone> = {
  paid:    'emerald',
  overdue: 'rose',
  pending: 'yellow',
  none:    'neutral',
  other:   'blue',
};

// Etiquetas para athlete_documents.document_type (ver CHECK en la migración
// 20260825125806_monster_volley_athlete_intake.sql).
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  athlete_photo:             'Foto del deportista',
  eps_certificate:           'Certificado EPS',
  guardian_id_front:         'Documento de identidad del acudiente',
  guardian_id_back:          'Documento de identidad del acudiente (reverso)',
  athlete_id_front:          'Documento de identidad del deportista',
  athlete_id_back:           'Documento de identidad del deportista (reverso)',
  guardian_signature:        'Firma del acudiente',
  athlete_signature:         'Firma del deportista',
  good_standing_certificate: 'Paz y salvo',
  other:                     'Otro documento',
};

// Los 7 tipos que pide el formulario de afiliación real (ver scripts/monster-volley-suba-import).
const ATHLETE_DOCUMENT_TYPES = [
  'athlete_photo', 'eps_certificate', 'guardian_id_front', 'athlete_id_front',
  'guardian_signature', 'athlete_signature', 'good_standing_certificate',
];

// Etiquetas para las claves de unregistered_athletes.health_screening (ver
// scripts/monster-volley-suba-import/01_extraer.mjs, que es quien las llena).
const HEALTH_SCREENING_LABELS: Record<string, string> = {
  problema_cardiaco:                 'Problema cardíaco reportado',
  dolor_pecho_reposo:                'Dolor de pecho en reposo (último mes)',
  mareo_vertigo_perdida_conciencia:  'Mareo, vértigo o pérdida de conciencia',
  problema_oseo_articular:           'Problema óseo o articular',
  medicamento_tension_corazon:       'Medicamento para tensión o corazón',
  otra_razon_no_actividad_fisica:    'Otra razón para no hacer actividad física',
  medicamento_en_entrenamiento:      'Medicamento requerido en entrenamientos/partidos',
  alergia_alimento:                  'Alergia alimentaria',
};

/**
 * Equipo del atleta tal como se muestra en la tabla: si no hay `team_name` la
 * fila se pinta "Sin asignar", así que tampoco cuenta como equipo para el filtro
 * (children pueden traer `team_id` sin inscripción de equipo activa).
 */
const getTeamKey = (student: any): string | null =>
  student.team_name ? (student.enrolled_team_id || student.team_id || null) : null;

const getPlanKey = (student: any): string | null =>
  student.plan_name ? (student.offering_plan_id || student.plan_name) : null;

export default function SchoolStudentsManagementPage() {
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { coachCanCreateAthletes, coachHideFinancialInfo, coachCanEditCategories, militaryDiscountEnabled, coachCanUploadEnrollmentForms, registrationZkPinEnabled } = useEntitlements();
  // ID del lector que ya tiene el deportista que se está editando (para no reenviarlo igual).
  const [currentZkPin, setCurrentZkPin] = useState<number | null>(null);

  // Alta de deportistas: SOLO admin/owner. El coach de escuela es solo lectura
  // (ve/gestiona los atletas de sus equipos, pero no los da de alta) — esto NO
  // cambia: sigue gateando CSV, inactivar/reactivar (el RPC exige
  // is_school_admin sin importar el flag) y carga de documentos.
  const canManageStudents = profile?.role !== 'coach';

  // Excepción activada por la escuela (school_settings.coach_can_create_athletes
  // — caso Carmel Club): SOLO alta 1x1 y edición de perfil. Nunca CSV ni
  // inactivar/reactivar — el BFF tampoco los habilita bajo este flag.
  const canCreateOrEditStudents = canManageStudents || coachCanCreateAthletes || coachCanEditCategories;

  // Dar de ALTA (nunca solo-categoría): coach_can_edit_categories NO habilita
  // crear atletas nuevos, solo reasignar la categoría de uno que ya existe.
  const canCreateStudents = canManageStudents || coachCanCreateAthletes;

  // Excepción de alcance MÁS ACOTADO (school_settings.coach_can_edit_categories
  // — caso Besser): el coach solo puede reasignar la categoría (equipo) del
  // atleta, nunca su perfil ni dinero. Si la escuela además activó
  // coach_can_create_athletes, esa excepción más amplia manda y el formulario
  // se muestra completo, igual que hoy para Carmel.
  const isCategoryOnlyCoach = profile?.role === 'coach' && !coachCanCreateAthletes && coachCanEditCategories;

  // Coach que SUBE la foto de la hoja de matrícula (school_settings.coach_can_upload_enrollment_forms,
  // Dynasty 2026-10-05). Solo sube: la ficha la revisa y aprueba el admin.
  const coachUploadsEnrollmentForms = profile?.role === 'coach' && coachCanUploadEnrollmentForms;

  // Besser: el coach no ve mensualidad ni estado de pago en ninguna pantalla.
  // Entrenador V2 (decisión 10-25): ningún coach ve montos, solo al día /
  // pendiente / vencido en su app. 0 coaches registraron o aprobaron pagos en
  // los últimos 90 días, así que no se pierde un flujo en uso.
  // Con VITE_ENTRENADOR_V2=false vuelve a depender solo de la escuela.
  const hideFinancials = profile?.role === 'coach' && (coachHideFinancialInfo || ENTRENADOR_V2);

  // «Estado de cuenta»: registrar desde el listado un pago que la familia hizo
  // por fuera de la app (efectivo o transferencia directa). Es el mismo modal de
  // Gestión de Pagos → Registrar pago, abierto con el deportista ya elegido.
  // Solo administración: el coach no registra dinero.
  // Con «Cobros y pagos» encendido (docs/specs/cobros-multiples.md, Q21) el gate
  // es el rol EN LA ESCUELA: owner/admin/school_admin. El BFF lo vuelve a exigir.
  const { currentUserRole: schoolRole } = useSchoolContext();
  const cobrosYPagosOn = isCobrosYPagosEnabled();
  const canRegisterPayments = canManageStudents && !hideFinancials && (!cobrosYPagosOn || canManageCharges(schoolRole));
  const [accountStudentId, setAccountStudentId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Atleta que ya existe en la escuela y coincide con el que se está creando.
  // Mientras esté acá, el alta NO se hizo.
  const [dupAviso, setDupAviso] = useState<AtletaDuplicado | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [showCreateChildModal, setShowCreateChildModal] = useState(false);
  const [showCreateAdultModal, setShowCreateAdultModal] = useState(false);
  // ?q= precarga la búsqueda (p. ej. "Cambiar plan" desde Ascensos, F-F).
  const [searchQuery, setSearchQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [activeTab, setActiveTab] = useState('active');
  // Pestaña «Clase de prueba»: prospecto que se está pasando a deportista por el alta normal.
  const [prospectoEnAlta, setProspectoEnAlta] = useState<ProspectoClasePrueba | null>(null);
  const [configPruebaOpen, setConfigPruebaOpen] = useState(false);
  // Filtros del listado. 'all' = sin filtrar.
  //   teamFilter:    'all' | 'none' (sin equipo) | <team_id>
  //   planFilter:    'all' | 'with' (con plan) | 'none' (sin plan) | <offering_plan_id>
  //   paymentFilter: 'all' | 'paid' | 'pending' | 'overdue' | 'none' | 'other'
  const [teamFilter, setTeamFilter] = useState('all');
  const [planFilter, setPlanFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [viewingStudent, setViewingStudent] = useState<(StudentViewRow & { display_parent_name?: string | null, display_parent_phone?: string | null }) | null>(null);
  const [showStudentAccessReport, setShowStudentAccessReport] = useState(false);
  const [editingStudent, setEditingStudent] = useState<StudentViewRow | null>(null);
  const [editingAthleteType, setEditingAthleteType] = useState<'child' | 'adult' | 'unregistered' | null>(null);
  // Cambio de plan con pago previo en escuelas con banco de horas: el admin elige
  // pago parcial o completo antes de guardar (ver PlanChangeDialog).
  const [planChangePrompt, setPlanChangePrompt] = useState<{ preview: PlanChangePreview; data: StudentFormData } | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [studentDocs, setStudentDocs] = useState<{ id?: string; document_type?: string; storage_path?: string; name: string; url: string }[]>([]);
  const [uploadingDocType, setUploadingDocType] = useState<string | null>(null);
  const [studentDocInfo, setStudentDocInfo] = useState<{
    doc_type?: string | null;
    doc_number?: string | null;
    tshirt_size?: string | null;
    blood_type?: string | null;
    eps_name?: string | null;
    guardian_full_name?: string | null;
    guardian_phone?: string | null;
    guardian_email?: string | null;
    health_screening?: Record<string, string | null> | null;
    intake_form_data?: Record<string, string | null> | null;
  }>({});
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [studentPlanInfo, setStudentPlanInfo] = useState<{
    plan_name: string;
    offering_name?: string;
    start_date?: string | null;
    end_date?: string | null;
    status?: string;
  } | null>(null);
  const [loadingPlanInfo, setLoadingPlanInfo] = useState(false);

  const { schoolId, schoolName, teams, branches, activeBranchId, activeBranchName, totalBranches, defaultMonthlyFee, schoolSettings, loading: schoolLoading } = useSchoolContext();
  const { prospectos: prospectosPrueba, cerrar: cerrarProspecto } = useProspectosClasePrueba(schoolId);
  // Soportes (solo se ven si la escuela los tiene activos): insignia X/7 y filtro «Faltan soportes».
  const soportes = useSoportesEstado(schoolId, canManageCharges(schoolRole));
  const [soloFaltanSoportes, setSoloFaltanSoportes] = useState(false);

  // Estable mientras el alta está abierta: los modales lo aplican al abrir.
  const prefillProspecto = useMemo(() => prospectoEnAlta ? {
    fullName: prospectoEnAlta.full_name,
    parentName: prospectoEnAlta.guardian_name ?? undefined,
    phone: prospectoEnAlta.phone,
  } : null, [prospectoEnAlta]);

  /** Alta normal terminada desde un prospecto: sale de «Clase de prueba» amarrado a su inscripción. */
  const cerrarProspectoInscrito = (result: any) => {
    const p = prospectoEnAlta;
    setProspectoEnAlta(null);
    if (!p) return;
    cerrarProspecto.mutate({
      leadId: p.id,
      estado: 'converted',
      childId: result?.child_id ?? null,
      userId: result?.user_id ?? null,
      unregisteredId: result?.unregistered_athlete_id ?? null,
    });
  };

  // Pausa por vacaciones/lesión: opt-in por escuela (D7). Con el flag apagado
  // no se muestra nada — es el mismo patrón que `militaryDiscountEnabled`.
  const pauseEnabled = schoolSettings?.pause_enabled === true;

  // Piloto "agendar por equipo" (Dreamers, Academia Superior Bogotá) — mismo
  // patrón de flag por escuela.
  const teamSchedulingEnabled = schoolSettings?.team_scheduling_enabled === true;
  const [assigningTeamStudent, setAssigningTeamStudent] = useState<any>(null);

  // «Cobros abiertos»: anular meses que no vino / llevar al valor nuevo tras un
  // cambio de plan. Va por RPC con is_school_admin, así que solo owner/admin.
  const [cobrosAbiertosDe, setCobrosAbiertosDe] = useState<
    { enrollmentId: string; nombre: string; origen: OrigenVentana } | null
  >(null);
  const { byEnrollment: pauseByEnrollment } = useActivePauses(pauseEnabled ? schoolId : null);
  const { data: pauseRequests } = usePendingPauseRequests(
    pauseEnabled && canManageStudents ? schoolId : null
  );
  const { preview: previewPause, pausar, reactivar, aprobar, rechazar } = usePauseActions(schoolId);
  const [pausingStudent, setPausingStudent] = useState<any | null>(null);

  const { data: offeringPlans = [] } = useQuery({
    queryKey: ['offering-plans', schoolId],
    queryFn: async () => {
      if (!schoolId) return [];
      const { data, error } = await (supabase as any)
        .from('offering_plans')
        .select('id, name, price, offering_id, offerings!offering_plans_offering_id_fkey(name)')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .order('sort_order')
        .order('created_at');
      if (error) return [];
      return (data || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        price: p.price || 0,
        offering_name: p.offerings?.name || '',
      }));
    },
    enabled: !!schoolId,
  });

  const [coachId, setCoachId] = useState<string | undefined>(undefined);
  const [coachIdResolved, setCoachIdResolved] = useState(false);
  useEffect(() => {
    if (profile?.role === 'coach' && schoolId) {
      // Por coach_auth_id y, si la ficha no está vinculada, por correo sin
      // distinguir mayúsculas (antes: `eq('email')` exacto). Sin ficha el coach
      // NO cae a la lista de toda la escuela: ver isCoachSinFicha abajo.
      fetchCoachTeams(schoolId).then(({ staffId }) => {
        if (staffId) setCoachId(staffId);
        setCoachIdResolved(true);
      });
    } else {
      setCoachIdResolved(true);
    }
  }, [profile?.role, profile?.email, schoolId]);

  const loadUnregisteredAthleteDocs = async (studentId: string) => {
    const { data: rows, error } = await (supabase as any)
      .from('athlete_documents')
      .select('id, document_type, storage_path')
      .eq('unregistered_athlete_id', studentId)
      .order('uploaded_at', { ascending: false });
    if (error || !rows) { setStudentDocs([]); return; }
    const docs = await Promise.all(
      rows.map(async (row: any) => {
        const { data } = await supabase.storage
          .from('identity-documents')
          .createSignedUrl(row.storage_path, 300);
        return {
          id: row.id,
          document_type: row.document_type,
          storage_path: row.storage_path,
          name: DOCUMENT_TYPE_LABELS[row.document_type] || row.document_type,
          url: data?.signedUrl || '',
        };
      })
    );
    setStudentDocs(docs.filter((d) => d.url));
  };

  /** Sube (o reemplaza) un documento de un unregistered_athlete. Espeja el patrón de
   * scripts/monster-volley-suba-import/02b_subir_documento.mjs + 02c_subir_avatar.mjs:
   * identity-documents (privado) para el registro, y además avatars (público) +
   * avatar_url cuando el tipo es athlete_photo. */
  const handleUploadAthleteDocument = async (documentType: string, file: File) => {
    if (!viewingStudent || !schoolId) return;
    const athleteId = viewingStudent.id;

    if (file.size > 15 * 1024 * 1024) {
      toast({ title: 'Archivo muy grande', description: 'Máximo 15 MB', variant: 'destructive' });
      return;
    }
    if (!/\.(pdf|jpg|jpeg|png)$/i.test(file.name)) {
      toast({ title: 'Formato no permitido', description: 'Sube un PDF o imagen (JPG/PNG)', variant: 'destructive' });
      return;
    }

    setUploadingDocType(documentType);
    try {
      // Reemplazo: si ya había un documento de este tipo, se borra (storage + fila)
      // antes de subir el nuevo, para no dejar duplicados/huérfanos.
      const previous = studentDocs.find((d) => d.document_type === documentType);
      if (previous?.id) {
        if (previous.storage_path) {
          await supabase.storage.from('identity-documents').remove([previous.storage_path]);
        }
        await (supabase as any).from('athlete_documents').delete().eq('id', previous.id);
      }

      const timestamp = Date.now();
      const docC = await comprimirParaSubir(file, documentType === 'athlete_photo' ? 'foto' : 'documento');
      const ext = docC.name.split('.').pop()?.toLowerCase() || 'bin';
      const safeName = file.name.replace(/\.[a-zA-Z0-9]{2,5}$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      const storagePath = `unregistered_athletes/${athleteId}/docs/${documentType}-${timestamp}-${safeName}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('identity-documents')
        .upload(storagePath, docC, { cacheControl: '3600', upsert: false, contentType: docC.type || undefined });
      if (uploadError) throw uploadError;

      const { error: insertError } = await (supabase as any).from('athlete_documents').insert({
        school_id: schoolId,
        unregistered_athlete_id: athleteId,
        document_type: documentType,
        storage_path: storagePath,
      });
      if (insertError) throw insertError;

      if (documentType === 'athlete_photo') {
        const avatarC = await comprimirParaSubir(file, 'avatar');
        const avatarExt = avatarC.name.split('.').pop()?.toLowerCase() || ext;
        const avatarPath = `unregistered_athletes/${athleteId}/${timestamp}.${avatarExt}`;
        const { error: avatarUploadError } = await supabase.storage
          .from('avatars')
          .upload(avatarPath, avatarC, { cacheControl: '3600', upsert: false, contentType: avatarC.type || undefined });
        if (!avatarUploadError) {
          const { data: pub } = supabase.storage.from('avatars').getPublicUrl(avatarPath);
          await (supabase as any)
            .from('unregistered_athletes')
            .update({ avatar_url: pub.publicUrl })
            .eq('id', athleteId);
          queryClient.invalidateQueries({ queryKey: ['school-students'] });
        }
      }

      toast({ title: '✅ Subido', description: `${DOCUMENT_TYPE_LABELS[documentType] || documentType} cargado` });
      await loadUnregisteredAthleteDocs(athleteId);
    } catch (err: any) {
      toast({ title: 'Error al subir', description: err.message, variant: 'destructive' });
    } finally {
      setUploadingDocType(null);
    }
  };

  useEffect(() => {
    setShowStudentAccessReport(false);
    if (!viewingStudent) {
      setStudentDocs([]);
      setStudentDocInfo({});
      setStudentPlanInfo(null);
      return;
    }
    const studentId = viewingStudent.id;

    const athleteTypeForDocs = getAthleteType(viewingStudent);

    if (athleteTypeForDocs === 'child') {
      (supabase as any)
        .from('children')
        .select('doc_type, doc_number, tshirt_size, blood_type, eps_name')
        .eq('id', studentId)
        .maybeSingle()
        .then(({ data }: { data: any }) => {
          setStudentDocInfo({
            doc_type:    data?.doc_type    || null,
            doc_number:  data?.doc_number  || null,
            tshirt_size: data?.tshirt_size || null,
            blood_type:  data?.blood_type  || null,
            eps_name:    data?.eps_name    || null,
          });
        });
    } else if (athleteTypeForDocs === 'unregistered') {
      (supabase as any)
        .from('unregistered_athletes')
        .select('doc_type, doc_number, blood_type, eps_name, guardian_full_name, guardian_phone, guardian_email, health_screening, intake_form_data')
        .eq('id', studentId)
        .maybeSingle()
        .then(({ data }: { data: any }) => {
          setStudentDocInfo({
            doc_type:           data?.doc_type           || null,
            doc_number:         data?.doc_number         || null,
            blood_type:         data?.blood_type          || null,
            eps_name:           data?.eps_name            || null,
            guardian_full_name: data?.guardian_full_name   || null,
            guardian_phone:     data?.guardian_phone       || null,
            guardian_email:     data?.guardian_email       || null,
            health_screening:   data?.health_screening     || null,
            intake_form_data:   data?.intake_form_data      || null,
          });
        });
    } else {
      setStudentDocInfo({});
    }

    setLoadingDocs(true);
    if (athleteTypeForDocs === 'unregistered') {
      // unregistered_athletes no tiene la convención vieja de storage.list()
      // ('children/{id}/docs') — sus documentos se registran en athlete_documents
      // desde el import (scripts/monster-volley-suba-import), así que se listan
      // desde ahí en vez de storage.list().
      loadUnregisteredAthleteDocs(studentId).finally(() => setLoadingDocs(false));
    } else {
      // children/adult: sin fila en athlete_documents (esa tabla es nueva, ver
      // migración 20260825125806). Se leen DOS carpetas (B2):
      //   · children/{id}/docs           — la convención vieja.
      //   · children/{acudiente}/{id}/docs — donde sube la familia desde Hijos V2
      //     (la única que el bucket le deja escribir: foldername[2] = auth.uid()).
      // Antes solo se miraba la vieja y la escuela no veía lo que subía la familia.
      // No se mueve ningún archivo.
      (async () => {
        let parentId: string | null = null;
        if (athleteTypeForDocs === 'child') {
          const { data } = await (supabase as any)
            .from('children').select('parent_id').eq('id', studentId).maybeSingle();
          parentId = data?.parent_id ?? null;
        }
        const carpetas = carpetasDocumentosDeportista(studentId, parentId);
        const listados = await Promise.all(
          carpetas.map(async (carpeta) => {
            const { data: files, error } = await supabase.storage
              .from('identity-documents')
              .list(carpeta, { limit: 100 });
            if (error || !files) return [] as { carpeta: string; name: string }[];
            // list() también devuelve subcarpetas (sin id): no son archivos.
            return files.filter((f) => f.id).map((f) => ({ carpeta, name: f.name }));
          }),
        );
        const docs = await Promise.all(
          listados.flat().map(async ({ carpeta, name }) => {
            const { data } = await supabase.storage
              .from('identity-documents')
              .createSignedUrl(`${carpeta}/${name}`, 300);
            return { name, url: data?.signedUrl || '' };
          }),
        );
        setStudentDocs(docs.filter(d => d.url));
      })()
        .catch(() => setStudentDocs([]))
        .finally(() => setLoadingDocs(false));
    }

    setLoadingPlanInfo(true);
    setStudentPlanInfo(null);

    const athleteType = getAthleteType(viewingStudent);

    let planQuery = (supabase as any)
      .from('enrollments')
      .select(`
        status,
        start_date,
        end_date,
        expires_at,
        offering_plans!enrollments_offering_plan_id_fkey (
          name,
          offerings!offering_plans_offering_id_fkey ( name )
        )
      `)
      .eq('status', 'active')
      .not('offering_plan_id', 'is', null)
      .order('start_date', { ascending: false })
      .limit(1);

    if (athleteType === 'child') {
      planQuery = planQuery.eq('child_id', studentId);
    } else if (athleteType === 'adult') {
      planQuery = planQuery.eq('user_id', studentId);
    } else {
      planQuery = planQuery.eq('unregistered_athlete_id', studentId);
    }

    planQuery
      .maybeSingle()
      .then(({ data: planRow }: { data: any }) => {
        if (planRow?.offering_plans) {
          setStudentPlanInfo({
            plan_name:     planRow.offering_plans.name,
            offering_name: planRow.offering_plans.offerings?.name,
            start_date:    planRow.start_date,
            end_date:      planRow.end_date ?? planRow.expires_at,
            status:        planRow.status,
          });
        } else {
          setStudentPlanInfo(null);
        }
      })
      .finally(() => setLoadingPlanInfo(false));
  }, [viewingStudent]);

  // Días de gracia de la escuela: el badge «Vencido» y el filtro esperan lo mismo que el motor de mora.
  const { data: graceDays = 0 } = useQuery({
    queryKey: ['school-payment-grace-days', schoolId],
    enabled: !!schoolId,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from('school_settings').select('payment_grace_days').eq('school_id', schoolId!).maybeSingle();
      return Math.max(0, Number((data as { payment_grace_days?: number } | null)?.payment_grace_days) || 0);
    },
  });

  const { data: students = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['school-students', schoolId, activeBranchId, coachId],
    queryFn: async () => {
      if (!schoolId) return [];
      let data;
      // Falla cerrado: un coach sin ficha de staff en esta escuela no ve a
      // nadie (antes caía al else y cargaba TODA la escuela con contactos).
      if (profile?.role === 'coach' && !coachId) return [];
      if (coachId) {
        const [{ data: legacyTeams }, { data: junctionTeams }] = await Promise.all([
          supabase.from('teams').select('id').eq('school_id', schoolId).eq('coach_id', coachId),
          supabase.from('team_coaches').select('team_id').eq('coach_id', coachId),
        ]);
        const teamIds = [...new Set([
          ...(legacyTeams || []).map(t => t.id),
          ...(junctionTeams || []).map(t => t.team_id),
        ])];
        const { data: athletes } = await supabase
          .from('school_athletes' as any)
          .select('*')
          .eq('school_id', schoolId)
          .in('enrolled_team_id', teamIds.length ? teamIds : ['']);
        data = athletes ?? [];
      } else {
        data = await studentsAPI.getSchoolView(schoolId, { branchId: activeBranchId, includeInactive: true });
      }

      // school_athletes no trae los datos del acudiente de unregistered_athletes —
      // se completa acá con un solo query bulk (no se toca la vista).
      //
      // En la vista, parent_email/parent_phone de una ficha son los del ATLETA
      // (unregistered_athletes.email/phone). Se conservan aparte en
      // athlete_email/athlete_phone y, si la ficha es de un MENOR, la columna
      // "acudiente" pasa a ser el acudiente de verdad (guardian_*), sin caer al
      // contacto del niño. De esto depende a quién se invita (H-03/H-04 del
      // informe Monster) y a dónde se le escribe a la familia (H-06).
      const unregisteredIds = (data as any[])
        .filter(s => s.athlete_type === 'unregistered')
        .map(s => s.id);
      if (unregisteredIds.length > 0) {
        const { data: guardians } = await supabase
          .from('unregistered_athletes')
          .select('id, guardian_full_name, guardian_phone, guardian_email')
          .in('id', unregisteredIds);
        const guardianMap = Object.fromEntries((guardians || []).map((g: any) => [g.id, g]));
        data = (data as any[]).map(s => {
          if (s.athlete_type !== 'unregistered') return s;
          const g = guardianMap[s.id] || {};
          const conAcudiente = {
            ...s,
            athlete_email: s.parent_email ?? null,
            athlete_phone: s.parent_phone ?? null,
            guardian_full_name: g.guardian_full_name ?? null,
            guardian_email: g.guardian_email ?? null,
            guardian_phone: g.guardian_phone ?? null,
          };
          if (!fichaVaAlAcudiente(conAcudiente)) return conAcudiente;
          return {
            ...conAcudiente,
            parent_name: g.guardian_full_name || s.parent_name,
            parent_phone: g.guardian_phone || '',
            parent_email: g.guardian_email || '',
          };
        });
      }

      return data as StudentViewRow[];
    },
    enabled: !!schoolId && coachIdResolved,
  });

  const form = useForm<z.input<typeof studentSchema>>({
    resolver: zodResolver(studentSchema),
    defaultValues: {
      full_name: '',
      date_of_birth: '',
      parent_email: '',
      parent_phone: '',
      team_id: '',
      offering_plan_id: '',
      team_monthly_fee: Number(defaultMonthlyFee) || 0,
      plan_monthly_fee: 0,
      medical_info: '',
      notes: '',
    },
  });

  const createStudentMutation = useMutation({
    mutationFn: async (data: StudentFormData & { allowDuplicate?: boolean }) => {
      const selectedTeam = teams.find(p => p.id === data.team_id);
      if (schoolId) {
        const result = await createStudentWithPendingPayment({
          fullName: data.full_name,
          dateOfBirth: data.date_of_birth,
          allowDuplicate: data.allowDuplicate,
          parentEmail: data.parent_email,
          parentPhone: data.parent_phone,
          parentName: data.parent_email.split('@')[0],
          schoolId,
          branchId: selectedTeam?.branch_id || activeBranchId || undefined,
          teamId: data.team_id,
          teamName: selectedTeam?.name || 'Equipo',
          // Cuota efectiva: el plan manda si hay plan; si no, la del equipo.
          monthlyFee: (data.offering_plan_id && Number(data.plan_monthly_fee) > 0)
            ? Number(data.plan_monthly_fee)
            : (Number(data.team_monthly_fee) || Number(data.plan_monthly_fee) || 0),
          // Con plan, el cobro lo emite POST /api/v1/enrollments (emitPlanCharge)
          // acá abajo. Si además lo emitiera el alta, el atleta nacía con DOS
          // cobros del mismo valor en meses distintos (el del alta con período del
          // mes siguiente, el del plan con período del mes de entrada), y como
          // caían en períodos distintos el índice único no los frenaba.
          // Sin plan (solo equipo) no hay segunda emisión: sigue cobrando acá.
          emitirCobro: !data.offering_plan_id,
          medicalInfo: data.medical_info,
          notes: data.notes,
        });
        if (result.success && result.childId && data.offering_plan_id) {
          try {
            const { bffClient } = await import('@/lib/api/bffClient');
            await bffClient.post('/api/v1/enrollments', {
              child_id:         result.childId,
              offering_plan_id: data.offering_plan_id,
              school_id:        schoolId,
              status:           'active',
            });
          } catch (enrollErr) {
            console.error('Error al inscribir en plan:', enrollErr);
            toast({
              title: '⚠️ Atleta creado, pero no se inscribió al plan',
              // El cobro del plan lo emite esta llamada: si falló, el atleta quedó
              // creado y SIN mensualidad. Hay que decirlo, no solo que falta el plan.
              description: 'Quedó sin inscripción y sin cobro del plan. Inscríbelo desde Mis Planes.',
            });
          }
        }
        if (result.success) {
          toast({ title: '✅ Atleta registrado', description: `${data.full_name} asociado a ${schoolName}` });
        }
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['school-students'] });
      setDupAviso(null);
      setDialogOpen(false);
      form.reset();
    },
    // Sin onError el alta fallaba en silencio: el diálogo quedaba abierto y el
    // staff volvía a darle "Agregar Atleta". Un duplicado se muestra en el
    // formulario (con quién coincide) en vez de crear la segunda identidad.
    onError: (error: any) => {
      if (esAtletaDuplicado(error)) {
        setDupAviso(error.duplicado);
        return;
      }
      toast({
        title: '❌ Error al registrar',
        description: error?.message || 'Ocurrió un error inesperado',
        variant: 'destructive',
      });
    },
  });

  // Inscripción / seguro marcados en la ficha: se cobran al guardar (después del PUT).
  const [feesMarked, setFeesMarked] = useState<FeesMarked>(NO_FEES_MARKED);

  const updateStudentMutation = useMutation({
    mutationFn: async (data: StudentFormData & { plan_change_charge?: PlanChangeChargeMode }) => {
      if (!editingStudent || !schoolId) return [] as string[];

      const guardianDocNumber = (data.guardian_doc_number || '').trim();
      const sendsGuardianDoc = editingAthleteType === 'child' || editingAthleteType === 'unregistered';
      if (sendsGuardianDoc && guardianDocNumber && !/^[A-Za-z0-9-]{4,20}$/.test(guardianDocNumber)) {
        throw new Error('Documento del acudiente inválido: usa de 4 a 20 caracteres (letras, números o guion).');
      }

      const { bffClient } = await import('@/lib/api/bffClient');
      const putStudent = (allowDuplicate: boolean) => bffClient.put<{ warnings?: string[] }>(`/api/v1/students/${editingStudent.id}`, {
        athlete_type: editingAthleteType,
        ...(allowDuplicate ? { allow_duplicate: true } : {}),
        // ID del torniquete: solo si cambió; vacío = no tocar (quitarlo se hace en Control de acceso).
        ...(registrationZkPinEnabled && data.zk_pin && Number(data.zk_pin) !== currentZkPin
          ? { zk_pin: Number(data.zk_pin) }
          : {}),
        profile: {
          full_name:     data.full_name,
          date_of_birth: data.date_of_birth     || null,
          medical_info:  data.medical_info       || null,
          tshirt_size:   data.tshirt_size        || null,
          blood_type:    data.blood_type         || null,
          eps_name:      data.eps_name           || null,
          dorsal:        data.dorsal             || null,
          doc_type:      data.doc_type           || null,
          doc_number:    data.doc_number         || null,
          parent_email:  data.parent_email       || null,
          parent_phone:  data.parent_phone       || null,
          ...(sendsGuardianDoc ? {
            guardian_doc_type:   guardianDocNumber ? (data.guardian_doc_type || 'CC') : null,
            guardian_doc_number: guardianDocNumber || null,
          } : {}),
        },
        enrollment: {
          team_id:          data.team_id            || null,
          offering_plan_id: data.offering_plan_id   || null,
          team_start_date:  data.team_start_date    || null,
          plan_start_date:  data.plan_start_date    || null,
          // Campo vacío en la cuota de equipo = "equipo sin cobro" → 0 explícito.
          // Con null el backend no tocaba nada y la vista volvía a heredar
          // teams.price_monthly, así que el valor reaparecía tras guardar.
          team_monthly_fee: data.team_monthly_fee   ?? 0,
          // En el plan, vacío = usar el precio del plan (no forzar 0).
          plan_monthly_fee: data.plan_monthly_fee   ?? null,
          // Becado / cuota negociada: manda tal cual sin caer al precio del
          // plan/equipo el mes siguiente (ver migración fee_is_manual).
          fee_is_manual:    !!data.fee_is_manual,
          fee_reason:       data.fee_reason || null,
          discount_type:    data.discount_type || null,
          // Solo viaja cuando el admin eligió en el diálogo de cambio de plan.
          ...(data.plan_change_charge ? { plan_change_charge: data.plan_change_charge } : {}),
        },
      });
      let saved: { warnings?: string[] };
      try {
        saved = await putStudent(false);
      } catch (e: any) {
        // Mismo documento en otro deportista: se avisa y la administración decide.
        if (e?.status === 409 && e?.body?.code === 'DOC_DUPLICADO'
          && window.confirm(`${e.message}

¿Guardar de todos modos?`)) {
          saved = await putStudent(true);
        } else {
          throw e;
        }
      }

      // Inscripción / seguro marcados en la ficha: el atleta ya quedó guardado; si el
      // cobro falla se avisa aparte (guardar de nuevo no duplica: el BFF no repite).
      if ((feesMarked.inscripcion || feesMarked.seguro) && editingAthleteType) {
        try {
          await cobrarInscripcionSeguro(editingStudent.id, editingAthleteType, feesMarked);
        } catch (e: any) {
          toast({
            title: 'El atleta se guardó, pero no se pudo cobrar',
            description: e?.message || 'Intenta de nuevo desde la ficha.',
            variant: 'destructive',
          });
        }
      }
      return saved?.warnings ?? [];
    },
    onSuccess: (warnings, variables) => {
      // ¿Cambió el plan, el equipo o la cuota? Entonces puede haber cobros abiertos
      // con el valor anterior (o meses atrasados): se le ofrece resolverlos ya.
      // Mismos valores con que handleEditStudent llenó el formulario.
      const antes: any = editingStudent;
      const teamFeeAntes = antes?.offering_plan_id ? 0 : Number(antes?.team_monthly_fee || 0);
      const cambioCobro = !!antes && (
        (variables.offering_plan_id || '') !== (antes.offering_plan_id || '')
        || (variables.team_id || '') !== (antes.enrolled_team_id || antes.team_id || '')
        || Number(variables.plan_monthly_fee || 0) !== Number(antes.plan_monthly_fee || 0)
        || Number(variables.team_monthly_fee || 0) !== teamFeeAntes
      );
      if (cambioCobro && canManageStudents && antes?.enrollment_id) {
        const enrollmentId: string = antes.enrollment_id;
        const nombre: string = variables.full_name || antes.full_name || '';
        fetchCobrosAbiertos(enrollmentId)
          .then((r) => { if (hayAlgoQueResolver(r)) setCobrosAbiertosDe({ enrollmentId, nombre, origen: 'cambio_plan' }); })
          .catch(() => { /* sin la ventana el guardado igual quedó bien */ });
      }
      queryClient.invalidateQueries({ queryKey: ['school-students'] });
      setFeesMarked(NO_FEES_MARKED);
      setPlanChangePrompt(null);
      setDialogOpen(false);
      setEditingStudent(null);
      setEditingAthleteType(null);
      toast({ title: '✅ Atleta actualizado' });
      // Avisos del BFF (p. ej. el cobro del plan nuevo no se pudo emitir): antes se
      // perdían y el admin creía que todo había salido bien.
      if (warnings?.length) {
        toast({
          title: 'Revisa los cobros de este atleta',
          description: warnings.join(' '),
          variant: 'destructive',
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: '❌ Error al actualizar',
        description: error?.message || 'Ocurrió un error inesperado',
        variant: 'destructive',
      });
    },
  });

  // El atleta que se está editando está inactivo: se le corrigen los datos, pero
  // no se le asigna equipo ni plan (el plan es lo que genera los cobros).
  const editingIsInactive = !!editingStudent && (editingStudent as any).is_active === false;

  const onSubmit = async (input: z.input<typeof studentSchema>) => {
    const data = studentSchema.parse(input);
    if (editingStudent) {
      // Cambio de plan sobre un atleta que ya tenía otro: en escuelas con banco de
      // horas el BFF devuelve una vista previa y, si ya pagó el período, el admin
      // decide parcial o completo antes de guardar.
      const previousPlanId = (editingStudent as any).offering_plan_id || '';
      if (data.offering_plan_id && previousPlanId && data.offering_plan_id !== previousPlanId && editingAthleteType) {
        const identity = editingAthleteType === 'child'
          ? { child_id: editingStudent.id }
          : editingAthleteType === 'adult'
            ? { user_id: editingStudent.id }
            : { unregistered_athlete_id: editingStudent.id };
        const preview = await fetchPlanChangePreview(identity, data.offering_plan_id);
        if (preview) {
          setPlanChangePrompt({ preview, data });
          return;
        }
      }
      updateStudentMutation.mutate(data);
    } else {
      setDupAviso(null);
      createStudentMutation.mutate(data);
    }
  };

  /** El staff confirmó que el homónimo es otra persona: se crea con la misma
   *  data del formulario, ahora con la excepción explícita. */
  const crearIgualPeseAlDuplicado = () => {
    const data = studentSchema.parse(form.getValues());
    createStudentMutation.mutate({ ...data, allowDuplicate: true });
  };

  const handleCreateStudent = () => setShowTypeSelector(true);

  const getAthleteType = (student: any): 'child' | 'adult' | 'unregistered' => {
    if (student.athlete_type) return student.athlete_type;
    if (student.parent_id || student.parent_email_temp) return 'child';
    if (student.user_id) return 'adult';
    return 'unregistered';
  };

  const handleEditStudent = async (student: any) => {
    const athleteType = getAthleteType(student);
    setEditingStudent(student);
    setEditingAthleteType(athleteType);
    setFeesMarked(NO_FEES_MARKED);
    let extraFields = { tshirt_size: '', blood_type: '', eps_name: '' };
    let docFields = { doc_type: '', doc_number: '' };
    let guardianDoc = { guardian_doc_type: 'CC', guardian_doc_number: '' };
    if (athleteType === 'child' || athleteType === 'unregistered') {
      // Lectura aparte y tolerante: si la columna aún no existe no se rompe el resto de la ficha.
      try {
        const { data } = await (supabase as any)
          .from(athleteType === 'child' ? 'children' : 'unregistered_athletes')
          .select('guardian_doc_type, guardian_doc_number').eq('id', student.id).maybeSingle();
        if (data) guardianDoc = { guardian_doc_type: data.guardian_doc_type || 'CC', guardian_doc_number: data.guardian_doc_number || '' };
      } catch { /* sin dato: queda vacío */ }
    }
    if (athleteType === 'child') {
      const { data } = await (supabase as any).from('children').select('tshirt_size, blood_type, eps_name, doc_type, doc_number').eq('id', student.id).maybeSingle();
      if (data) {
        extraFields = { tshirt_size: data.tshirt_size || '', blood_type: data.blood_type || '', eps_name: data.eps_name || '' };
        docFields = { doc_type: data.doc_type || '', doc_number: data.doc_number || '' };
      }
    } else if (athleteType === 'unregistered') {
      const { data } = await (supabase as any).from('unregistered_athletes').select('doc_type, doc_number').eq('id', student.id).maybeSingle();
      if (data) docFields = { doc_type: data.doc_type || '', doc_number: data.doc_number || '' };
    }
    // ID del torniquete: lo lee solo la administración (RLS); un coach lo ve vacío.
    let zkPinNow: number | null = null;
    if (registrationZkPinEnabled && schoolId) {
      try { zkPinNow = await fetchZkPin(schoolId, student.id, athleteType); } catch { /* sin permiso: vacío */ }
    }
    setCurrentZkPin(zkPinNow);
    const teamStartDate: string = (student as any).enrollment_start_date || '';
    const planStartDate: string  = (student as any).plan_start_date       || '';
    // Con plan activo el equipo es SOLO roster y no cobra: la cuota de equipo se
    // muestra en 0 aunque la fila (fusionada equipo+plan) comparta el monthly_fee
    // del plan. Sin plan, se respeta la cuota real del equipo.
    const hasPlan: boolean       = !!(student.offering_plan_id);
    const teamFee: number        = hasPlan ? 0 : ((student as any).team_monthly_fee || 0);
    const planFee: number        = (student as any).plan_monthly_fee      || 0;
    form.reset({
      full_name:        student.full_name,
      date_of_birth:    student.date_of_birth   || '',
      parent_email:     student.parent_email     || '',
      parent_phone:     student.parent_phone     || '',
      team_id:          student.enrolled_team_id || student.team_id || '',
      offering_plan_id: student.offering_plan_id || '',
      team_start_date:  teamStartDate,
      plan_start_date:  planStartDate,
      team_monthly_fee: teamFee,
      plan_monthly_fee: planFee,
      fee_is_manual:    !!(student as any).fee_is_manual,
      fee_reason:       (student as any).fee_reason || '',
      discount_type:    (student as any).discount_type || undefined,
      medical_info:     student.medical_info     || '',
      notes:            student.notes            || '',
      tshirt_size:      extraFields.tshirt_size,
      blood_type:       extraFields.blood_type,
      eps_name:         extraFields.eps_name,
      dorsal:           (student as any).dorsal || '',
      doc_type:         docFields.doc_type,
      doc_number:       docFields.doc_number,
      guardian_doc_type:   guardianDoc.guardian_doc_type,
      guardian_doc_number: guardianDoc.guardian_doc_number,
      zk_pin:           zkPinNow != null ? String(zkPinNow) : '',
    });
    setDialogOpen(true);
  };

  const bulkInviteMutation = useMutation({
    mutationFn: async (studentIds: string[]) => {
      const selectedStudents = students.filter(s => studentIds.includes(s.id));
      const results = { created: 0, failed: 0, skipped: 0, sent: 0, sendFailed: 0, aborted: false, message: '' };
      const inviteIds: string[] = [];

      // 1. Crear/refrescar las invitaciones (sin mandar correo todavía)
      //
      // FIX 2026-10-05 (informe Monster H-03/H-04): de una ficha sin cuenta se
      // manda SIEMPRE su id (p_unregistered_athlete_id): al aceptar, la ficha se
      // adopta —misma inscripción, mismos cobros— en vez de nacer un hijo nuevo
      // que se cobra aparte. Ficha de MENOR → se invita a su acudiente (rol
      // parent, guardian_email); ficha de ADULTO → al propio atleta (rol
      // athlete). Quien ya tiene cuenta no se reinvita. Los argumentos van
      // todos con nombre e incluyen el id: con los 7 de antes la llamada era
      // ambigua (42725) contra la sobrecarga vieja y la masiva fallaba entera.
      for (const student of selectedStudents) {
        const inv = invitacionParaAtleta({ ...(student as any), athlete_type: getAthleteType(student) });
        if (!inv || !inv.email) { results.skipped++; continue; }
        try {
          const { data: inviteId, error } = await (supabase.rpc as any)('create_invitation', {
            p_email: inv.email, p_role: inv.role, p_child_name: inv.childName,
            p_team_id: (student as any).enrolled_team_id || student.team_id || null,
            p_monthly_fee: student.price_monthly || Number(defaultMonthlyFee) || 0,
            p_parent_phone: inv.phone,
            p_branch_id: student.branch_id || activeBranchId || null,
            p_offering_plan_id: (student as any).offering_plan_id || null,
            p_unregistered_athlete_id: inv.unregisteredId,
          });
          if (error) throw error;
          if (inviteId) inviteIds.push(inviteId as string);
          results.created++;
        } catch (err) {
          console.error(`Error inviting ${student.full_name}:`, err);
          results.failed++;
        }
      }

      // 2. Enviar los correos en UNA sola pasada por el BFF.
      //    Antes se disparaba un fetch por atleta sin await: Resend devolvía 429
      //    a la mayoría (rate limit) y el contador los daba por enviados igual.
      //    Ahora el BFF agrupa de a 100, reintenta y deja registro en email_sends.
      if (inviteIds.length > 0) {
        const { bffClient } = await import('@/lib/api/bffClient');
        const sendResult = await bffClient.post<{ sent: number; failed: number; aborted: boolean; message: string }>(
          '/api/v1/invitations/bulk-send',
          { invitation_ids: inviteIds }
        );
        results.sent = sendResult.sent;
        results.sendFailed = sendResult.failed;
        results.aborted = sendResult.aborted;
        results.message = sendResult.message;
      }

      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ['school-students'] });
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      setSelectedStudentIds([]);
      const problemas = results.failed + results.sendFailed > 0 || results.aborted;
      toast({
        title: problemas ? '⚠️ Invitaciones con incidencias' : '✅ Invitaciones enviadas',
        description: results.aborted
          ? results.message
          : `Correos enviados: ${results.sent}` +
            (results.sendFailed ? ` · Fallidos: ${results.sendFailed}` : '') +
            (results.failed ? ` · Invitaciones con error: ${results.failed}` : '') +
            (results.skipped ? ` · Saltadas sin email: ${results.skipped}` : ''),
        variant: problemas ? 'destructive' : undefined,
      });
    },
    onError: (error) => {
      toast({ title: '❌ Error en envío masivo', description: error instanceof Error ? error.message : 'Ocurrió un error inesperado', variant: 'destructive' });
    }
  });

  const toggleSelectAll = () => {
    if (selectedStudentIds.length === filteredStudents.length && filteredStudents.length > 0) setSelectedStudentIds([]);
    else setSelectedStudentIds(filteredStudents.map(s => s.id));
  };

  const toggleSelectStudent = (id: string) => {
    setSelectedStudentIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);
  };

  // Inactivar/reactivar pasa por el RPC set_school_athlete_status: además del
  // estado, al inactivar CANCELA la inscripción activa y ANULA los cobros
  // pendientes. Antes esto se hacía client-side tocando solo la tabla base, así
  // que el atleta dado de baja conservaba su plan `active` y el generador mensual
  // (open_month, que solo mira enrollments.status) le seguía emitiendo cuotas.
  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, status, athlete_type, school_id }: { id: string, status: 'active' | 'inactive', athlete_type: 'child' | 'adult' | 'unregistered', school_id: string }) => {
      const { data, error } = await (supabase.rpc as any)('set_school_athlete_status', {
        p_school_id:    school_id,
        p_athlete_type: athlete_type,
        p_athlete_id:   id,
        p_active:       status === 'active',
      });
      if (error) throw error;
      return data as { enrollments_cancelled: number; payments_cancelled: number } | null;
    },
    onSuccess: (result, vars) => {
      queryClient.invalidateQueries({ queryKey: ['school-students'] });
      queryClient.invalidateQueries({ queryKey: ['school-payments'] });
      const cancelled = Number(result?.payments_cancelled ?? 0);
      toast({
        title: vars.status === 'inactive' ? '✅ Atleta inactivado' : '✅ Atleta reactivado',
        description: vars.status === 'inactive'
          ? `Se canceló su plan${cancelled ? ` y se anularon ${cancelled} cobro(s) pendiente(s)` : ''}.`
          : 'Vuelve a asignarle equipo y plan para que genere cobros.',
      });
    },
    onError: (error: any) => {
      toast({
        title: '❌ No se pudo cambiar el estado',
        description: error?.message || 'Ocurrió un error inesperado',
        variant: 'destructive',
      });
    },
  });

  const handleToggleStatus = (student: any) => {
    toggleStatusMutation.mutate({
      id: student.id,
      status: student.status === 'inactive' ? 'active' : 'inactive',
      athlete_type: getAthleteType(student),
      // El RPC autoriza contra p_school_id (is_school_admin), así que manda la
      // escuela del contexto: la del atleta puede apuntar a otra en el caso
      // multi-escuela de menores.
      school_id: schoolId || student.school_id,
    });
  };


  // ── Helper: construye los params de navegación a /invitations ─────────────
  // FIX 2026-10-05 (informe Monster H-04): antes TODA ficha sin cuenta iba con
  // role=athlete, aunque fuera de una niña de 9 años, y al aceptarla el perfil
  // de la mamá quedaba "atleta" y las hermanas se fundían en un solo cobro.
  // Ahora: ficha de MENOR → se invita al acudiente (role=parent + id de la
  // ficha, que se adopta como su hijo); ficha de ADULTO → role=athlete + id.
  // El equipo va en `program`, que es lo que lee InvitationsManagementPage
  // (`team` nunca llegaba precargado).
  const buildInviteParams = (student: any) => {
    const athleteType = getAthleteType(student);
    const inv = invitacionParaAtleta({ ...student, athlete_type: athleteType });
    const params = new URLSearchParams({
      email:      inv?.email ?? (student.parent_email || ''),
      child:      student.full_name       || '',
      program:    student.enrolled_team_id || student.team_id || '',
      phone:      inv?.phone ?? (student.parent_phone || ''),
      branch:     student.branch_id       || '',
      planId:     student.offering_plan_id || '',
    });
    if (athleteType === 'unregistered') {
      params.set('role', inv?.role ?? (fichaVaAlAcudiente(student) ? 'parent' : 'athlete'));
      params.set('unregisteredId', student.id);
    } else {
      params.set('role', 'parent');
    }
    return params.toString();
  };

  /** Rótulo del botón de invitar: a quién le llega de verdad la invitación. */
  const inviteLabel = (student: any) =>
    getAthleteType(student) === 'unregistered' && !fichaVaAlAcudiente(student)
      ? 'Invitar Atleta'
      : 'Invitar Acudiente';

  // Estado de Cuenta: misma identidad desarmada que el resto de las RPCs de
  // pagos (child_id / user_id / unregistered_athlete_id).
  const buildAccountStatementParams = (student: any) => {
    const athleteType = getAthleteType(student);
    const params = new URLSearchParams();
    if (athleteType === 'child') params.set('child_id', student.id);
    else if (athleteType === 'adult') params.set('user_id', student.user_id || student.id);
    else params.set('unregistered_athlete_id', student.id);
    return params.toString();
  };

  const enhancedStudents = useMemo(() => students.map(student => {
    const emergencyContact = student.emergency_contact || '';
    const hasEmergencyContactParts = emergencyContact.includes(' - ');
    const fallbackParentName = hasEmergencyContactParts ? emergencyContact.split(' - ')[0] : emergencyContact;
    const fallbackParentPhone = hasEmergencyContactParts ? emergencyContact.split(' - ')[1] : '';
    
    // Normalizar status en base a is_active de la vista
    const status: 'active' | 'inactive' | 'suspended' = student.is_active ? 'active' : 'inactive';

    return {
      ...student,
      status,
      display_parent_name: student.parent_name || (fallbackParentName ? fallbackParentName.trim() : null),
      display_parent_phone: student.parent_phone || (fallbackParentPhone ? fallbackParentPhone.trim() : null),
    };
  }), [students]);

  // Atletas de la pestaña activa (antes de filtros): base para las opciones de
  // los selects, así solo se ofrecen equipos/planes/estados que existen aquí.
  const tabStudents = useMemo(() => enhancedStudents.filter(student =>
    activeTab === 'todos' || (activeTab === 'active' ? student.status !== 'inactive' : student.status === 'inactive')
  ), [enhancedStudents, activeTab]);

  const filterOptions = useMemo(() => {
    const teamMap = new Map<string, { label: string; count: number }>();
    const planMap = new Map<string, { label: string; count: number }>();
    const paymentCounts = new Map<PaymentState, number>();
    let noTeam = 0, noPlan = 0;

    const bump = (map: Map<string, { label: string; count: number }>, key: string, label: string) => {
      const prev = map.get(key);
      if (prev) prev.count++;
      else map.set(key, { label, count: 1 });
    };

    for (const s of tabStudents as any[]) {
      const teamKey = getTeamKey(s);
      if (teamKey) bump(teamMap, teamKey, s.team_name); else noTeam++;
      const planKey = getPlanKey(s);
      if (planKey) bump(planMap, planKey, s.plan_name); else noPlan++;
      const pState = getPaymentState(s, graceDays);
      paymentCounts.set(pState, (paymentCounts.get(pState) || 0) + 1);
    }

    const toSortedList = (map: Map<string, { label: string; count: number }>) =>
      [...map.entries()]
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => a.label.localeCompare(b.label, 'es'));

    const order: PaymentState[] = ['paid', 'pending', 'overdue', 'none', 'other'];

    return {
      teams:    toSortedList(teamMap),
      plans:    toSortedList(planMap),
      payments: order.filter(p => paymentCounts.has(p)).map(p => ({ id: p, count: paymentCounts.get(p)! })),
      noTeam,
      noPlan,
      withPlan: tabStudents.length - noPlan,
    };
  }, [tabStudents, graceDays]);

  // Membresias del club (CAR-4). Solo se pinta la insignia si esa persona TIENE
  // membresia: asi el listado de las escuelas que no usan la funcion queda igual
  // que antes, sin un «sin membresia» en cada fila. Si la migracion no esta
  // aplicada la consulta falla y el mapa queda vacio — no rompe el listado.
  const { porSujeto: membresiasPorSujeto } = useMemberships();

  // Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md) — un solo
  // request para TODA la escuela, igual que useMemberships arriba: en la tabla
  // de 50 estudiantes no se puede pedir el saldo fila por fila. Si la escuela
  // no usa esto, `balances` sale vacío y el badge simplemente no aparece.
  const { data: hourBankBalancesData } = useQuery({
    queryKey: ['hour-bank-balances', schoolId],
    queryFn: () => bffClient.get<{ balances: { enrollment_id: string; available_minutes: number }[] }>('/api/v1/access/hour-bank-balances'),
    staleTime: 60_000,
    enabled: !!schoolId,
  });
  const hourBankByEnrollment = new Map(
    (hourBankBalancesData?.balances ?? []).map((b) => [b.enrollment_id, b.available_minutes])
  );

  // Lo que debe cada atleta, cobro por cobro. El badge de la vista
  // `school_athletes` es UN estado (el del cobro más urgente) y la columna de al
  // lado es la mensualidad: con un alta que emite inscripción + seguro + mes, la
  // escuela leía «Pendiente · $245.000» y la inscripción y el seguro no
  // aparecían en ninguna parte de la ficha (Dreamers, 2026-10-10). Un solo
  // request para toda la escuela, igual que el banco de horas. La llave cuelga
  // de 'school-students' para refrescarse con cada alta.
  const { data: openDebtByAthlete } = useQuery({
    queryKey: ['school-students', 'open-debt', schoolId],
    queryFn: async (): Promise<Map<string, AthleteOpenDebt>> => {
      const rows: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await (supabase.from('payments') as any)
          .select('id, child_id, user_id, unregistered_athlete_id, amount, amount_paid, status, payment_category, payment_type, concept')
          .eq('school_id', schoolId)
          .in('status', ['pending', 'overdue', 'partial'])
          .order('due_date', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      return groupOpenDebtByAthlete(rows.map((r) => ({ ...r, label: chargeLabel(r) })));
    },
    staleTime: 60_000,
    enabled: !!schoolId && !hideFinancials,
  });
  const openDebtOf = (studentId: string): AthleteOpenDebt | undefined => openDebtByAthlete?.get(studentId);
  const debtDetail = (d: AthleteOpenDebt) => d.items.map((i) => `${i.label} ${formatCurrency(i.amount)}`).join(' · ');

  const soporteDe = (st: any) =>
    soportes.activo ? soportes.indice.get(llaveSujeto(tipoSujetoDeAtleta(getAthleteType(st)), st.id)) : undefined;

  const filteredStudents = tabStudents.filter(student => {
    const q = normalizeText(searchQuery);
    if (q && !(
      normalizeText(student.full_name).includes(q) ||
      normalizeText(student.display_parent_name).includes(q)
    )) return false;

    if (teamFilter !== 'all') {
      const teamKey = getTeamKey(student);
      if (teamFilter === 'none' ? !!teamKey : teamKey !== teamFilter) return false;
    }

    if (planFilter !== 'all') {
      const planKey = getPlanKey(student);
      if (planFilter === 'none') { if (planKey) return false; }
      else if (planFilter === 'with') { if (!planKey) return false; }
      else if (planKey !== planFilter) return false;
    }

    if (paymentFilter !== 'all' && getPaymentState(student, graceDays) !== paymentFilter) return false;

    if (soloFaltanSoportes && soportes.activo) {
      const d = soporteDe(student);
      if (!d || d.complete) return false;
    }

    return true;
  });

  const activeFilterCount =
    (teamFilter !== 'all' ? 1 : 0) + (planFilter !== 'all' ? 1 : 0) + (paymentFilter !== 'all' ? 1 : 0) +
    (soloFaltanSoportes && soportes.activo ? 1 : 0);

  const clearFilters = () => {
    setTeamFilter('all');
    setPlanFilter('all');
    setPaymentFilter('all');
    setSoloFaltanSoportes(false);
  };

  // Si cambia la pestaña, un equipo/plan seleccionado puede no existir ahí:
  // se limpia para no dejar un listado vacío sin explicación.
  useEffect(() => {
    const teamStillThere =
      teamFilter === 'all' ? true
      : teamFilter === 'none' ? filterOptions.noTeam > 0
      : filterOptions.teams.some(t => t.id === teamFilter);
    if (!teamStillThere) setTeamFilter('all');

    const planStillThere =
      planFilter === 'all' ? true
      : planFilter === 'none' ? filterOptions.noPlan > 0
      : planFilter === 'with' ? filterOptions.withPlan > 0
      : filterOptions.plans.some(p => p.id === planFilter);
    if (!planStillThere) setPlanFilter('all');

    if (paymentFilter !== 'all' && !filterOptions.payments.some(p => p.id === paymentFilter))
      setPaymentFilter('all');
  }, [activeTab, filterOptions]);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(amount);

  const getPaymentBadge = (student: any) => {
    switch (getPaymentState(student, graceDays)) {
      case 'none':    return <Badge variant="secondary" className="text-xs bg-muted text-muted-foreground">Sin cobro</Badge>;
      case 'paid':    return <Badge className="bg-green-500 dark:bg-green-600 text-xs text-white">Al día</Badge>;
      case 'overdue': return <Badge variant="destructive" className="text-xs">Vencido</Badge>;
      case 'pending': return <Badge variant="secondary" className="text-xs bg-yellow-50 dark:bg-yellow-950/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-500/40">Pendiente</Badge>;
      default:        return <Badge variant="secondary" className="text-xs">{etiquetaEstadoPago(student.payment_status).label}</Badge>;
    }
  };

  const calculateAge = (dateOfBirth?: string | null) => {
    if (!dateOfBirth) return '-';
    const birthDate = new Date(dateOfBirth);
    if (isNaN(birthDate.getTime())) return '-';
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    return `${age} años`;
  };

  // unregistered_athletes no tiene athlete_type='adult' (siempre es 'unregistered',
  // sin importar la edad) — a diferencia de children/profiles, acá la única señal
  // real de mayoría de edad es la fecha de nacimiento.
  const isAdultByBirthdate = (dateOfBirth?: string | null): boolean => {
    if (!dateOfBirth) return false;
    const birthDate = new Date(dateOfBirth);
    if (isNaN(birthDate.getTime())) return false;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    return age >= 18;
  };

  // Botón de editar: con permiso de registrar pagos se abre en dos opciones
  // (deportista / estado de cuenta); si no, edita directo como antes.
  const EditStudentButton = ({ student, trigger }: { student: any; trigger: React.ReactElement }) => {
    if (!canRegisterPayments || student.status === 'inactive') {
      return <span onClick={() => handleEditStudent(student)}>{trigger}</span>;
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleEditStudent(student)}>
            <User className="h-4 w-4 mr-2" /> Editar deportista
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAccountStudentId(student.id)}>
            <FileText className="h-4 w-4 mr-2" /> {cobrosYPagosOn ? 'Cobros y pagos' : 'Editar estado de cuenta'}
          </DropdownMenuItem>
          {/* En escritorio este es el único menú por fila: sin esto, «No asistió»
              solo se alcanzaba desde las tarjetas (< lg). */}
          {canManageStudents && student.enrollment_id && (
            <DropdownMenuItem onClick={() => setCobrosAbiertosDe({
              enrollmentId: student.enrollment_id, nombre: student.full_name, origen: 'no_asistio',
            })}>
              <CalendarX className="h-4 w-4 mr-2" /> No asistió / cobros abiertos
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  // ── PATCH: label del item "Invitar" cambia según tipo de atleta ───────────
  const StudentActions = ({ student }: { student: any }) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost" size="sm"
          className="h-8 w-8 p-0 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          title="Más acciones"
          aria-label={`Más acciones para ${student.full_name}`}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setViewingStudent(student)}>Ver Perfil</DropdownMenuItem>
        {canCreateOrEditStudents && (
          <DropdownMenuItem onClick={() => handleEditStudent(student)}>Editar deportista</DropdownMenuItem>
        )}
        {canRegisterPayments && student.status !== 'inactive' && (
          <DropdownMenuItem onClick={() => setAccountStudentId(student.id)}>{cobrosYPagosOn ? 'Cobros y pagos' : 'Registrar pago'}</DropdownMenuItem>
        )}
        {/* Inactivar cancela el plan y anula la cartera pendiente: es acción de
            owner/admin (el RPC exige is_school_admin), no del coach. */}
        {canManageStudents && (
          <DropdownMenuItem onClick={() => handleToggleStatus(student)}>
            {student.status === 'inactive' ? 'Reactivar' : 'Inactivar'}
          </DropdownMenuItem>
        )}
        {/* Pausa por vacaciones/lesión. Mismo nivel de permiso que inactivar
            (la RPC exige is_school_admin: aprobar una pausa exime de pagar) y
            gateada por el opt-in de la escuela. */}
        {pauseEnabled && canManageStudents && student.status !== 'inactive' && (
          pauseByEnrollment.has(student.enrollment_id)
            ? (
              <DropdownMenuItem onClick={() => reactivar.mutate({ enrollmentId: student.enrollment_id })}>
                Reactivar de la pausa
              </DropdownMenuItem>
            )
            : (
              <DropdownMenuItem onClick={() => setPausingStudent(student)}>
                🏖️ Vacaciones / pausa
              </DropdownMenuItem>
            )
        )}
        {/* Meses que no vino / cobros con el valor del plan anterior. No depende
            del opt-in de la Pausa: anular un mes pasado no es una pausa. */}
        {canManageStudents && student.enrollment_id && student.status !== 'inactive' && (
          <DropdownMenuItem onClick={() => setCobrosAbiertosDe({
            enrollmentId: student.enrollment_id, nombre: student.full_name, origen: 'no_asistio',
          })}>
            No asistió / cobros abiertos
          </DropdownMenuItem>
        )}
        {/* PATCH: label y params según tipo de atleta */}
        <DropdownMenuItem onClick={() => navigate(`/invitations?${buildInviteParams(student)}`)}>
          {inviteLabel(student)}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate(`/estado-cuenta?${buildAccountStatementParams(student)}`)}>
          Ver estado de cuenta
        </DropdownMenuItem>
        {/* Piloto "agendar por equipo" — solo tiene sentido si el estudiante
            tiene una inscripción de plan (offering_plan_id) que agendar. */}
        {teamSchedulingEnabled && student.enrollment_id && student.offering_plan_id && (
          <DropdownMenuItem onClick={() => setAssigningTeamStudent(student)}>
            Equipo de agendamiento
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (isLoading || schoolLoading) return <LoadingSpinner fullScreen text="Cargando deportistas..." />;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Atletas</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {totalBranches > 1 ? (
              // Multisede (S1): deja claro qué sede está mirando el selector del menú.
              <>
                Mostrando <strong>{activeBranchId ? activeBranchName : 'todas las sedes'}</strong>
                {' · '}{filteredStudents.length} deportista{filteredStudents.length !== 1 ? 's' : ''}
                {filteredStudents.length !== tabStudents.length && ` de ${tabStudents.length}`}
              </>
            ) : (
              <>
                {filteredStudents.length} atleta{filteredStudents.length !== 1 ? 's' : ''}
                {filteredStudents.length !== tabStudents.length && ` de ${tabStudents.length}`} en <strong>{schoolName}</strong>
              </>
            )}
          </p>
        </div>
        {(canManageStudents || canCreateOrEditStudents || coachUploadsEnrollmentForms) && (
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Actualizar</span>
            </Button>
            {/* CSV es carga masiva: nunca se habilita para coach, ni con el flag. */}
            {canManageStudents && (
              <Button variant="outline" size="sm" onClick={() => setShowImportModal(true)}>
                <FileUp className="mr-2 h-4 w-4" />
                <span className="hidden sm:inline">Importar CSV</span>
                <span className="sm:hidden">CSV</span>
              </Button>
            )}
            {coachUploadsEnrollmentForms && (
              <Button variant="outline" size="sm" onClick={() => navigate('/school/enrollment-intake')}>
                <Upload className="mr-2 h-4 w-4" />
                <span className="hidden sm:inline">Subir hoja de matrícula</span>
                <span className="sm:hidden">Hoja</span>
              </Button>
            )}
            {canCreateStudents && (
              <Button size="sm" onClick={handleCreateStudent}>
                <UserPlus className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Agregar Atleta</span>
                <span className="sm:hidden">Agregar</span>
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Bandeja de solicitudes de pausa. Se auto-oculta si no hay ninguna. */}
      {pauseEnabled && canManageStudents && (
        <PauseRequestsInbox
          requests={pauseRequests ?? []}
          // Contra la lista COMPLETA, no contra `tabStudents`: si no, una
          // solicitud de alguien que no está en la pestaña abierta se
          // mostraría como "Atleta" sin nombre.
          nameByEnrollment={new Map(
            enhancedStudents
              .filter((st: any) => st.enrollment_id)
              .map((st: any) => [st.enrollment_id, st.full_name])
          )}
          onApprove={(args) => aprobar.mutate(args)}
          onReject={(args) => rechazar.mutate(args)}
          isBusy={aprobar.isPending || rechazar.isPending}
        />
      )}

      {/* Código de la escuela + bandeja «Por asignar» (solo solicitudes por
          código; los prospectos van en «Clase de prueba»). Solo administración:
          asignar crea inscripción y cobro (D3, spec codigo-de-escuela-union-por-codigo). */}
      {schoolId && canManageCharges(schoolRole) && (
        <PorAsignarSection
          schoolId={schoolId}
          schoolName={schoolName}
          branches={branches ?? []}
          prospectos={prospectosPrueba.length}
          onVerProspectos={() => setActiveTab('prueba')}
        />
      )}

      {/* Informe «Soportes pendientes»: no pinta nada si la escuela no tiene soportes activos. */}
      {schoolId && canManageCharges(schoolRole) && <SoportesPendientesInforme schoolId={schoolId} />}
      {/* Retiros, pausas y reactivaciones pedidas por las familias (app y WhatsApp). Va con el mismo ajuste que la pausa. */}
      {schoolId && canManageCharges(schoolRole) && pauseEnabled && <BandejaSolicitudesPlan schoolId={schoolId} />}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="active">Activos</TabsTrigger>
          <TabsTrigger value="inactive">Inactivos</TabsTrigger>
          <TabsTrigger value="todos">Todos</TabsTrigger>
          <TabsTrigger value="prueba">
            Clase de prueba{prospectosPrueba.length > 0 ? ` (${prospectosPrueba.length})` : ''}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab === 'prueba' && schoolId && (
        <ClasePruebaPanel
          schoolId={schoolId}
          onConfigurar={() => setConfigPruebaOpen(true)}
          onCompletar={(p) => {
            setProspectoEnAlta(p);
            if (p.guardian_name) setShowCreateChildModal(true);
            else setShowCreateAdultModal(true);
          }}
        />
      )}

      {activeTab !== 'prueba' && <Card>
        <CardHeader className="pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input placeholder="Buscar por nombre o acudiente..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10" />
          </div>

          {/* Filtros dinámicos: las opciones se derivan de los atletas de la pestaña */}
          <div className="mt-3 flex flex-col sm:flex-row gap-2">
            <Select value={teamFilter} onValueChange={setTeamFilter}>
              <SelectTrigger className="sm:w-56">
                <SelectValue placeholder="Equipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los equipos</SelectItem>
                {filterOptions.noTeam > 0 && (
                  <SelectItem value="none">Sin equipo ({filterOptions.noTeam})</SelectItem>
                )}
                {filterOptions.teams.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.label} ({t.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={planFilter} onValueChange={setPlanFilter}>
              <SelectTrigger className="sm:w-56">
                <SelectValue placeholder="Plan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los planes</SelectItem>
                {filterOptions.withPlan > 0 && (
                  <SelectItem value="with">Con plan ({filterOptions.withPlan})</SelectItem>
                )}
                {filterOptions.noPlan > 0 && (
                  <SelectItem value="none">Sin plan ({filterOptions.noPlan})</SelectItem>
                )}
                {filterOptions.plans.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.label} ({p.count})</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {soportes.activo && soportes.estado && (
              <SoportesFiltroToggle activo={soloFaltanSoportes} onChange={setSoloFaltanSoportes} faltan={soportes.estado.resumen.incompletos} />
            )}

            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="sm:self-center text-muted-foreground">
                <X className="h-4 w-4 mr-1" />
                Limpiar filtro{activeFilterCount !== 1 ? 's' : ''}
              </Button>
            )}
          </div>

          {/* Estado de pago en tarjetas: es el filtro que más se usa acá y en
              un selector quedaba escondido detrás de equipo y plan. Oculto
              para el coach cuando la escuela no quiere que vea dinero. */}
          {!hideFinancials && (
            <StatFilterBar
              className="mt-4"
              columns={5}
              value={paymentFilter === 'all' ? null : paymentFilter}
              onChange={(v) => setPaymentFilter(v ?? 'all')}
              items={[
                { key: null, label: 'Todos', value: tabStudents.length, tone: 'neutral' },
                ...filterOptions.payments.map(p => ({
                  key: p.id,
                  label: PAYMENT_STATE_LABELS[p.id],
                  value: p.count,
                  tone: PAYMENT_STATE_TONES[p.id],
                })),
              ]}
            />
          )}

          {selectedStudentIds.length > 0 && (
            <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg animate-in fade-in slide-in-from-top-1">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <CheckSquare className="h-4 w-4" />
                {selectedStudentIds.length} seleccionado{selectedStudentIds.length !== 1 ? 's' : ''}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="default" onClick={() => bulkInviteMutation.mutate(selectedStudentIds)} disabled={bulkInviteMutation.isPending}>
                  {bulkInviteMutation.isPending ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Send className="mr-2 h-3 w-3" />}
                  Invitar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedStudentIds([])} disabled={bulkInviteMutation.isPending}>Cancelar</Button>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0 sm:p-6">
          {filteredStudents.length === 0 && tabStudents.length > 0 ? (
            /* Hay atletas, pero los filtros/búsqueda no dejan ninguno */
            <div className="p-6">
              <EmptyState
                icon={Search}
                title="Ningún atleta coincide"
                description="Ajusta la búsqueda o los filtros de equipo, plan y estado de pago."
                {...(activeFilterCount > 0 ? { actionLabel: "Limpiar filtros", onAction: clearFilters } : {})}
              />
            </div>
          ) : filteredStudents.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={UserPlus}
                title="No hay atletas"
                description={canManageStudents
                  ? "Agrega atletas manualmente o importa desde un archivo CSV"
                  : canCreateStudents
                  ? "Agrega atletas manualmente a tus equipos."
                  : "Aún no hay atletas en tus equipos. El alta la realiza la escuela."}
                {...(canCreateStudents ? { actionLabel: "+ Agregar Atleta", onAction: handleCreateStudent } : {})}
              />
            </div>
          ) : (
            <>
              {/* Mobile */}
              <div className="grid grid-cols-1 gap-3 p-4 lg:hidden">
                {filteredStudents.map((student) => (
                  <div key={student.id} className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${selectedStudentIds.includes(student.id) ? 'bg-primary/5 border-primary/30' : 'bg-card border-border'}`}>
                    <Checkbox checked={selectedStudentIds.includes(student.id)} onCheckedChange={() => toggleSelectStudent(student.id)} className="mt-1" />
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                      {student.full_name.substring(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <p className="font-semibold text-sm truncate">{student.full_name}</p>
                        <MedicalAlertBadge medicalInfo={student.medical_info} />
                        <SoportesInsignia d={soporteDe(student)} />
                        {membresiasPorSujeto.get(student.id) && (
                          <MembershipBadge membresia={membresiasPorSujeto.get(student.id)} compacto />
                        )}
                      </div>
                      <div className="flex gap-1 flex-wrap mt-1">
                        {student.team_name && <Badge variant="outline" className="text-[10px] bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/40 py-0 h-5"><Trophy className="h-2.5 w-2.5 mr-1" /> {student.team_name}</Badge>}
                        {(student as any).plan_name && <Badge variant="outline" className="text-[10px] bg-purple-50 dark:bg-purple-950/20 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-500/40 py-0 h-5"><Zap className="h-2.5 w-2.5 mr-1" /> {(student as any).plan_name}</Badge>}
                        {student.enrollment_id && hourBankByEnrollment.has(student.enrollment_id) && (
                          <Badge variant="outline" className={`text-[10px] py-0 h-5 ${hourBankByEnrollment.get(student.enrollment_id)! < 0 ? 'bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/40' : 'bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/40'}`}>
                            <Clock className="h-2.5 w-2.5 mr-1" /> {formatHourBankMinutes(hourBankByEnrollment.get(student.enrollment_id)!)}
                          </Badge>
                        )}
                        {student.enrollment_id && pauseByEnrollment.has(student.enrollment_id) && (
                          <Badge variant="outline" className="text-[10px] bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/40 py-0 h-5">
                            🏖️ {pauseByEnrollment.get(student.enrollment_id)!.vigente
                              ? `En pausa hasta ${mesLegible(pauseByEnrollment.get(student.enrollment_id)!.month_to)}`
                              : `Pausa desde ${mesLegible(pauseByEnrollment.get(student.enrollment_id)!.month_from)}`}
                          </Badge>
                        )}
                        {!student.team_name && !(student as any).plan_name && <span className="text-xs text-muted-foreground">Sin asignar</span>}
                        <BranchChip branchId={student.branch_id} name={student.branch_name} branches={branches} className="ml-1" />
                      </div>
                      {!hideFinancials && (
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {(student as any).fee_is_manual ? (
                            <Badge variant="outline" className="text-[10px] bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/40 py-0 h-5">
                              {manualFeeBadge(student)}
                            </Badge>
                          ) : (
                            <>
                              <span className="text-xs font-semibold text-primary">{(student as any).price_monthly > 0 ? formatCurrency((student as any).price_monthly) : '-'}</span>
                              {(student as any).fee_reason === MILITARY_DISCOUNT_REASON && (
                                <Badge variant="outline" className="text-[10px] bg-slate-50 dark:bg-slate-950/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-500/40 py-0 h-5">
                                  🪖 -10%
                                </Badge>
                              )}
                            </>
                          )}
                          {getPaymentBadge(student)}
                          {openDebtOf(student.id) && (
                            <span className="text-[11px] font-medium text-red-600">
                              Debe {formatCurrency(openDebtOf(student.id)!.total)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {canCreateOrEditStudents && (
                        <EditStudentButton student={student} trigger={
                          <Button
                            variant="outline" size="sm"
                            className="h-8 px-2 text-xs gap-1"
                            aria-label={`Editar a ${student.full_name}`}
                          >
                            <Edit className="h-3.5 w-3.5" /> Editar
                          </Button>
                        } />
                      )}
                      <StudentActions student={student} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop */}
              <div className="hidden lg:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox checked={filteredStudents.length > 0 && selectedStudentIds.length === filteredStudents.length} onCheckedChange={() => toggleSelectAll()} />
                      </TableHead>
                      <TableHead>Nombre</TableHead>
                      <TableHead>Edad</TableHead>
                      <TableHead>Equipo / Plan</TableHead>
                      <TableHead>Sede</TableHead>
                      <TableHead>Acudiente</TableHead>
                      {!hideFinancials && (
                        <>
                          <TableHead>Mensualidad</TableHead>
                          <TableHead>Estado Pago</TableHead>
                        </>
                      )}
                      <TableHead>Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStudents.map((student) => (
                      <TableRow key={student.id} className={selectedStudentIds.includes(student.id) ? "bg-primary/5" : ""}>
                        <TableCell><Checkbox checked={selectedStudentIds.includes(student.id)} onCheckedChange={() => toggleSelectStudent(student.id)} /></TableCell>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span>{student.full_name}</span>
                            <MedicalAlertBadge medicalInfo={student.medical_info} />
                            <SoportesInsignia d={soporteDe(student)} />
                            {membresiasPorSujeto.get(student.id) && (
                              <MembershipBadge membresia={membresiasPorSujeto.get(student.id)} compacto />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{calculateAge(student.date_of_birth)}</TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            {student.team_name && <Badge variant="outline" className="text-xs bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/40 w-fit"><Trophy className="h-3 w-3 mr-1" /> {student.team_name}</Badge>}
                            {(student as any).plan_name && <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-950/20 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-500/40 w-fit"><Zap className="h-3 w-3 mr-1" /> {(student as any).plan_name}</Badge>}
                            {student.enrollment_id && hourBankByEnrollment.has(student.enrollment_id) && (
                              <Badge variant="outline" className={`text-xs w-fit ${hourBankByEnrollment.get(student.enrollment_id)! < 0 ? 'bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/40' : 'bg-blue-50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-500/40'}`}>
                                <Clock className="h-3 w-3 mr-1" /> {formatHourBankMinutes(hourBankByEnrollment.get(student.enrollment_id)!)}
                              </Badge>
                            )}
                            {student.enrollment_id && pauseByEnrollment.has(student.enrollment_id) && (
                              <Badge variant="outline" className="text-xs w-fit bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-500/40">
                                🏖️ {pauseByEnrollment.get(student.enrollment_id)!.vigente
                                  ? `En pausa hasta ${mesLegible(pauseByEnrollment.get(student.enrollment_id)!.month_to)}`
                                  : `Pausa desde ${mesLegible(pauseByEnrollment.get(student.enrollment_id)!.month_from)}`}
                              </Badge>
                            )}
                            {!student.team_name && !(student as any).plan_name && <span className="text-xs text-muted-foreground">Sin asignar</span>}
                          </div>
                        </TableCell>
                        <TableCell><BranchChip branchId={student.branch_id} name={student.branch_name} branches={branches} /></TableCell>
                        <TableCell>{(student as any).athlete_type === 'adult' || isAdultByBirthdate((student as any).date_of_birth) ? '—' : (student.display_parent_name || student.parent_name || '-')}</TableCell>
                        {!hideFinancials && (
                          <>
                            <TableCell className="font-semibold text-primary">
                              {(student as any).fee_is_manual ? (
                                <Badge variant="outline" className="text-xs bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/40 w-fit">
                                  {manualFeeBadge(student)}
                                </Badge>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <span>{(student as any).price_monthly > 0 ? formatCurrency((student as any).price_monthly) : '-'}</span>
                                  {(student as any).fee_reason === MILITARY_DISCOUNT_REASON && (
                                    <Badge variant="outline" className="text-[10px] bg-slate-50 dark:bg-slate-950/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-500/40 w-fit">
                                      🪖 -10%
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              {getPaymentBadge(student)}
                              {openDebtOf(student.id) && (
                                <span className="block text-[11px] font-medium text-red-600 mt-0.5" title={debtDetail(openDebtOf(student.id)!)}>
                                  Debe {formatCurrency(openDebtOf(student.id)!.total)}
                                  {openDebtOf(student.id)!.items.length > 1 && ` (${openDebtOf(student.id)!.items.length} cobros)`}
                                </span>
                              )}
                            </TableCell>
                          </>
                        )}
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setViewingStudent(student)}>Ver</Button>
                            {canCreateOrEditStudents && (
                              <EditStudentButton student={student} trigger={
                                <Button variant="ghost" size="sm" aria-label={`Editar a ${student.full_name}`}><Edit className="h-4 w-4 text-primary" /></Button>
                              } />
                            )}
                            {canManageStudents && (
                              <Button
                                variant="ghost" size="sm"
                                disabled={toggleStatusMutation.isPending}
                                title={student.status === 'inactive'
                                  ? 'Reactivar atleta'
                                  : 'Inactivar: cancela su plan y anula sus cobros pendientes'}
                                onClick={() => handleToggleStatus(student)}
                              >
                                {student.status === 'inactive' ? <UserCheck className="h-4 w-4 text-green-500" /> : <UserMinus className="h-4 w-4 text-orange-500" />}
                              </Button>
                            )}
                            {/* PATCH: usa buildInviteParams para pasar el unregisteredId cuando aplica */}
                            <Button
                              variant="outline" size="sm"
                              className="text-primary border-primary/20 hover:bg-primary/5"
                              onClick={() => navigate(`/invitations?${buildInviteParams(student)}`)}
                            >
                              <Send className="w-3 h-3 mr-1" />
                              Invitar
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          <TableRefreshBar
            className="sm:-mx-6 sm:-mb-6 mt-2 sm:rounded-b-lg"
            onRefresh={refetch}
            loading={isFetching}
            summary={
              filteredStudents.length === tabStudents.length
                ? `${filteredStudents.length} atleta(s)`
                : `${filteredStudents.length} de ${tabStudents.length} atleta(s)`
            }
          />
        </CardContent>
      </Card>}

      {/* Dialogs — sin cambios respecto al original */}
      <PlanChangeDialog
        preview={planChangePrompt?.preview ?? null}
        open={!!planChangePrompt}
        submitting={updateStudentMutation.isPending}
        onCancel={() => setPlanChangePrompt(null)}
        onConfirm={(mode) => {
          if (planChangePrompt) updateStudentMutation.mutate({ ...planChangePrompt.data, plan_change_charge: mode });
        }}
      />

      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) setDupAviso(null); setDialogOpen(o); }}>
        <DialogContent className="w-[95vw] max-w-2xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingStudent ? `Editar ${editingAthleteType === 'child' ? 'Menor' : 'Atleta'} — ${editingStudent.full_name}` : 'Agregar Nuevo Atleta'}</DialogTitle>
            <DialogDescription>
              {editingStudent ? (editingAthleteType === 'child' ? 'Actualiza la información del menor y su acudiente.' : editingAthleteType === 'adult' ? 'Actualiza la información del atleta. El email se gestiona desde su cuenta.' : 'Actualiza la información del atleta registrado manualmente.') : <>Registra al atleta. Quedará asociado a <strong>{schoolName}</strong>.</>}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit as any)} className="space-y-6">
            {/* ── Datos del atleta ── */}
            {/* Coach con permiso acotado (solo categoría, Besser): nunca edita
                perfil, solo la sección de Inscripción más abajo. */}
            {!isCategoryOnlyCoach && (
            <div className="space-y-4">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Datos del atleta</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="full_name">Nombre completo *</Label>
                  <Input id="full_name" {...form.register('full_name')} />
                  {form.formState.errors.full_name && <p className="text-xs text-destructive">{form.formState.errors.full_name.message as string}</p>}
                </div>
                <div className="space-y-2">
                  <Label>Fecha de nacimiento</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={cn('w-full pl-3 text-left font-normal', !form.watch('date_of_birth') && 'text-muted-foreground')}
                      >
                        {form.watch('date_of_birth')
                          ? format(new Date(form.watch('date_of_birth')! + 'T12:00:00'), 'PPP', { locale: es })
                          : <span>Seleccionar fecha</span>}
                        <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={form.watch('date_of_birth') ? new Date(form.watch('date_of_birth')! + 'T12:00:00') : undefined}
                        onSelect={(date) => {
                          if (date) {
                            const y = date.getFullYear();
                            const m = String(date.getMonth() + 1).padStart(2, '0');
                            const d = String(date.getDate()).padStart(2, '0');
                            form.setValue('date_of_birth', `${y}-${m}-${d}`);
                          }
                        }}
                        captionLayout="dropdown-buttons"
                        fromYear={1920}
                        toYear={new Date().getFullYear()}
                        disabled={(date) => date > new Date() || date < new Date('1900-01-01')}
                        initialFocus
                        locale={es}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              {editingStudent && editingAthleteType !== 'adult' && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Tipo de documento</Label>
                    <Select
                      value={form.watch('doc_type') || '__none__'}
                      onValueChange={(val) => form.setValue('doc_type', val === '__none__' ? '' : val, { shouldDirty: true })}
                    >
                      <SelectTrigger id="doc_type"><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sin especificar</SelectItem>
                        <SelectItem value="RC">RC — Registro civil</SelectItem>
                        <SelectItem value="TI">TI — Tarjeta de identidad</SelectItem>
                        <SelectItem value="CC">CC — Cédula de ciudadanía</SelectItem>
                        <SelectItem value="CE">CE — Cédula de extranjería</SelectItem>
                        <SelectItem value="PP">Pasaporte</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="doc_number">Número de documento</Label>
                    <Input id="doc_number" inputMode="text" maxLength={20} placeholder="Ej: 1012345678" {...form.register('doc_number')} />
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="medical_info">Información médica</Label>
                <Textarea id="medical_info" {...form.register('medical_info')} rows={2} />
              </div>
              {registrationZkPinEnabled ? (
                // Al editar: ID del torniquete en lugar del dorsal. El alta (legacy, sin
                // dorsal) no lo muestra: las altas van por los formularios de menor/adulto.
                editingStudent && (
                  <ZkPinField
                    id="zk_pin"
                    value={form.watch('zk_pin') ?? ''}
                    onChange={v => form.setValue('zk_pin', v, { shouldDirty: true })}
                    currentPin={currentZkPin}
                  />
                )
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="dorsal">Dorsal</Label>
                  <Input id="dorsal" placeholder="Ej: 10" maxLength={10} {...form.register('dorsal')} />
                </div>
              )}
              {(!editingStudent || editingAthleteType === 'child') && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Campos opcionales</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="tshirt_size">Talla camiseta</Label>
                      <Select
                        value={form.watch('tshirt_size') || '__none__'}
                        onValueChange={(val) => form.setValue('tshirt_size', val === '__none__' ? '' : val)}
                      >
                        <SelectTrigger id="tshirt_size"><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sin especificar</SelectItem>
                          {TSHIRT_SIZES.map(o => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="blood_type">Tipo de sangre</Label>
                      <Select
                        value={form.watch('blood_type') || '__none__'}
                        onValueChange={(val) => form.setValue('blood_type', val === '__none__' ? '' : val)}
                      >
                        <SelectTrigger id="blood_type"><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sin especificar</SelectItem>
                          {BLOOD_TYPES.map(o => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="eps_name">EPS</Label>
                      <EpsCombobox
                        value={form.watch('eps_name')}
                        onChange={(val) => form.setValue('eps_name', val)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
            )}

            {/* ── Contacto (acudiente o deportista) ── */}
            {!isCategoryOnlyCoach && (() => {
              const isChildMode = !editingStudent || editingAthleteType === 'child';
              const isAdultMode = editingAthleteType === 'adult';

              return (
                <div className="space-y-4">
                  <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                    {isChildMode ? 'Contacto del acudiente' : 'Contacto del deportista'}
                  </h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="parent_email">
                        {isChildMode ? 'Email del acudiente' : 'Email'}
                      </Label>
                      <Input
                        id="parent_email"
                        type="email"
                        {...form.register('parent_email')}
                        disabled={isAdultMode}
                        placeholder={isAdultMode ? 'Gestionado desde su cuenta de usuario' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="parent_phone">Teléfono</Label>
                      <Input
                        id="parent_phone"
                        type="tel"
                        placeholder="+57 300..."
                        {...form.register('parent_phone')}
                      />
                    </div>
                    {editingStudent && (editingAthleteType === 'child' || editingAthleteType === 'unregistered') && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="guardian_doc_type">Tipo de documento del acudiente</Label>
                          <Select
                            value={form.watch('guardian_doc_type') || 'CC'}
                            onValueChange={(val) => form.setValue('guardian_doc_type', val, { shouldDirty: true })}
                          >
                            <SelectTrigger id="guardian_doc_type"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {['CC', 'CE', 'PP', 'NIT'].map(d => (
                                <SelectItem key={d} value={d}>{d}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="guardian_doc_number">Número de documento del acudiente</Label>
                          <Input id="guardian_doc_number" inputMode="text" maxLength={20} placeholder="Ej: 1012345678" {...form.register('guardian_doc_number')} />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Inscripción ── */}
            <div className="space-y-4">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Inscripción</h3>
              {/* Atleta inactivo: sus datos se pueden corregir, pero no se le
                  asigna equipo ni plan — el plan es lo que dispara los cobros.
                  El BFF lo rechaza igual (409); esto evita el viaje en vano. */}
              {editingIsInactive && (
                <p className="text-xs rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-orange-700 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300">
                  Este atleta está inactivo: no se le puede asignar equipo ni plan. Reactívalo primero.
                </p>
              )}
              <div className="grid gap-6 sm:grid-cols-2">
                {/* Columna Equipo */}
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Equipo</Label>
                    <Select
                      disabled={editingIsInactive}
                      value={form.watch('team_id') || '__none__'}
                      onValueChange={(val) => {
                        const v = val === '__none__' ? '' : val;
                        form.setValue('team_id', v);
                        const t = teams.find(t => t.id === v);
                        // Con plan activo el equipo no cobra (plan manda); sin
                        // plan, la cuota es el precio del equipo (0 si no tiene).
                        form.setValue('team_monthly_fee' as any,
                          form.getValues('offering_plan_id') ? 0 : (t?.monthly_fee ?? 0));
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="Sin equipo" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Sin equipo</SelectItem>
                        {teams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Fecha de inscripción</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className={cn('w-full pl-3 text-left font-normal', !form.watch('team_start_date') && 'text-muted-foreground')}
                        >
                          {form.watch('team_start_date')
                            ? format(new Date(form.watch('team_start_date')! + 'T12:00:00'), 'PPP', { locale: es })
                            : <span>Seleccionar fecha</span>}
                          <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={form.watch('team_start_date') ? new Date(form.watch('team_start_date')! + 'T12:00:00') : undefined}
                          onSelect={(date) => {
                            if (date) {
                              const y = date.getFullYear();
                              const m = String(date.getMonth() + 1).padStart(2, '0');
                              const d = String(date.getDate()).padStart(2, '0');
                              form.setValue('team_start_date', `${y}-${m}-${d}`);
                            }
                          }}
                          captionLayout="dropdown-buttons"
                          fromYear={2020}
                          toYear={new Date().getFullYear() + 2}
                          initialFocus
                          locale={es}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  {/* Besser (coach solo-categoría): nunca ve ni edita la cuota. */}
                  {!isCategoryOnlyCoach && (
                  <div className="space-y-1">
                    <Label htmlFor="team_monthly_fee" className="text-xs text-muted-foreground">Mensualidad equipo (COP)</Label>
                    <Input id="team_monthly_fee" type="number" step={1}
                      disabled={editingIsInactive || !!form.watch('offering_plan_id') || !!form.watch('fee_is_manual')}
                      {...form.register('team_monthly_fee', { valueAsNumber: true })} />
                    {form.watch('offering_plan_id') ? (
                      <p className="text-[11px] text-muted-foreground">El plan define el cobro; el equipo no cobra (queda en 0).</p>
                    ) : null}
                  </div>
                  )}
                </div>
                {/* Columna Plan — nunca para el coach solo-categoría: asignar
                    plan es dinero, no categoría. */}
                {!isCategoryOnlyCoach && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Plan</Label>
                    <PlanCombobox
                      plans={offeringPlans}
                      noneValue="__none__"
                      disabled={editingIsInactive}
                      value={form.watch('offering_plan_id') || '__none__'}
                      onChange={(val) => {
                        const v = val === '__none__' ? '' : val;
                        form.setValue('offering_plan_id', v);
                        const p = offeringPlans.find(p => p.id === v);
                        form.setValue('plan_monthly_fee' as any, v ? (p?.price ?? 0) : 0);
                        // El plan define el cobro: el equipo pasa a ser roster y
                        // su cuota baja a 0. Al quitar el plan, vuelve el precio
                        // del equipo.
                        if (v) {
                          form.setValue('team_monthly_fee' as any, 0);
                        } else {
                          const t = teams.find(t => t.id === form.getValues('team_id'));
                          form.setValue('team_monthly_fee' as any, t?.monthly_fee ?? 0);
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Fecha de inscripción</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className={cn('w-full pl-3 text-left font-normal', !form.watch('plan_start_date') && 'text-muted-foreground')}
                        >
                          {form.watch('plan_start_date')
                            ? format(new Date(form.watch('plan_start_date')! + 'T12:00:00'), 'PPP', { locale: es })
                            : <span>Seleccionar fecha</span>}
                          <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={form.watch('plan_start_date') ? new Date(form.watch('plan_start_date')! + 'T12:00:00') : undefined}
                          onSelect={(date) => {
                            if (date) {
                              const y = date.getFullYear();
                              const m = String(date.getMonth() + 1).padStart(2, '0');
                              const d = String(date.getDate()).padStart(2, '0');
                              form.setValue('plan_start_date', `${y}-${m}-${d}`);
                            }
                          }}
                          captionLayout="dropdown-buttons"
                          fromYear={2020}
                          toYear={new Date().getFullYear() + 2}
                          initialFocus
                          locale={es}
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="plan_monthly_fee" className="text-xs text-muted-foreground">Mensualidad plan (COP)</Label>
                    <Input id="plan_monthly_fee" type="number" step={1}
                      disabled={editingIsInactive || !!form.watch('fee_is_manual')}
                      {...form.register('plan_monthly_fee', { valueAsNumber: true })} />
                  </div>
                </div>
                )}
              </div>
              {!isCategoryOnlyCoach && militaryDiscountEnabled && (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="text-sm">
                  <p className="font-medium">🪖 Descuento Fuerza Militar (10%)</p>
                  <p className="text-[11px] text-muted-foreground">
                    Aplica el 10% sobre la mensualidad vigente del equipo o el plan seleccionado.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={form.watch('fee_reason') === MILITARY_DISCOUNT_REASON ? 'secondary' : 'outline'}
                  disabled={editingIsInactive || !!form.watch('fee_is_manual')}
                  onClick={() => {
                    const active = form.getValues('fee_reason') === MILITARY_DISCOUNT_REASON;
                    const planId = form.getValues('offering_plan_id');
                    if (planId) {
                      const p = offeringPlans.find(p => p.id === planId);
                      const base = p?.price ?? 0;
                      form.setValue('plan_monthly_fee' as any,
                        active ? base : Math.round(base * (1 - MILITARY_DISCOUNT_RATE)));
                    } else {
                      const t = teams.find(t => t.id === form.getValues('team_id'));
                      const base = t?.monthly_fee ?? 0;
                      form.setValue('team_monthly_fee' as any,
                        active ? base : Math.round(base * (1 - MILITARY_DISCOUNT_RATE)));
                    }
                    form.setValue('fee_reason' as any, active ? '' : MILITARY_DISCOUNT_REASON);
                  }}
                >
                  {form.watch('fee_reason') === MILITARY_DISCOUNT_REASON ? 'Quitar descuento' : 'Aplicar 10%'}
                </Button>
              </div>
              )}
              {!isCategoryOnlyCoach && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="fee_is_manual"
                    checked={!!form.watch('fee_is_manual')}
                    disabled={editingIsInactive}
                    onCheckedChange={(checked) => {
                      const isBecado = !!checked;
                      form.setValue('fee_is_manual' as any, isBecado);
                      // Becado = cuota exenta: en 0 y sin caer al precio del
                      // plan/equipo el mes siguiente (open_month respeta
                      // fee_is_manual). Al destildar, vuelve a valer el precio
                      // vigente del plan/equipo seleccionado.
                      if (isBecado) {
                        form.setValue('team_monthly_fee' as any, 0);
                        form.setValue('plan_monthly_fee' as any, 0);
                      } else {
                        form.setValue('fee_reason' as any, '');
                        form.setValue('discount_type' as any, undefined);
                        const t = teams.find(t => t.id === form.getValues('team_id'));
                        const p = offeringPlans.find(p => p.id === form.getValues('offering_plan_id'));
                        form.setValue('team_monthly_fee' as any, form.getValues('offering_plan_id') ? 0 : (t?.monthly_fee ?? 0));
                        form.setValue('plan_monthly_fee' as any, p?.price ?? 0);
                      }
                    }}
                  />
                  <Label htmlFor="fee_is_manual" className="text-sm font-medium cursor-pointer">
                    🎓 Becado / cuota exenta (no genera cobros)
                  </Label>
                </div>
                {form.watch('fee_is_manual') && (
                  <div className="space-y-3 pl-6">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Tipo (opcional — uno solo por atleta)</Label>
                      <div className="flex gap-2 flex-wrap">
                        {(Object.keys(DISCOUNT_TYPE_LABELS) as Array<keyof typeof DISCOUNT_TYPE_LABELS>).map(key => {
                          const meta = DISCOUNT_TYPE_LABELS[key];
                          const active = form.watch('discount_type') === key;
                          return (
                            <Button
                              key={key}
                              type="button"
                              size="sm"
                              variant={active ? 'secondary' : 'outline'}
                              disabled={editingIsInactive}
                              onClick={() => form.setValue('discount_type' as any, active ? undefined : key)}
                            >
                              {meta.icon} {active ? `Quitar ${meta.badge}` : meta.label}
                            </Button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Deja sin marcar si es una beca sin categoría particular. El descuento de hermanos NO se marca acá — se aplica solo si está prendido en Ajustes de pagos.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="fee_reason" className="text-xs text-muted-foreground">Motivo (opcional)</Label>
                      <Input id="fee_reason" placeholder="Ej. Beca deportiva, convenio, primos"
                        {...form.register('fee_reason')} />
                      <p className="text-[11px] text-muted-foreground">
                        Este atleta no generará cobros mensuales aunque el plan o el equipo tengan precio.
                      </p>
                    </div>
                  </div>
                )}
              </div>
              )}
            </div>

            {/* Inscripción y seguro del plan: se cobran después del alta si no se marcaron
                (o se desmarcaron por error). Solo administración; el BFF vuelve a exigirlo. */}
            {editingStudent && editingAthleteType && schoolId && !editingIsInactive
              && profile?.role !== 'coach' && canManageCharges(schoolRole) && (
              <EnrollmentFeesSection
                athleteId={editingStudent.id}
                athleteType={editingAthleteType}
                marked={feesMarked}
                onMarkedChange={setFeesMarked}
                disabled={updateStudentMutation.isPending}
              />
            )}

            {/* F2 hermanos: familia del menor (vínculo manual para acudientes sin
                cuenta). Solo administración; la RPC vuelve a exigirlo. */}
            {editingStudent && editingAthleteType === 'child' && schoolId
              && profile?.role !== 'coach' && canManageCharges(schoolRole) && (
              <SiblingFamilySection schoolId={schoolId} childId={editingStudent.id} />
            )}

            {!editingStudent && dupAviso && (
              <div className="rounded-md border border-amber-400 bg-amber-50 p-3 space-y-2 dark:bg-amber-950/30">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Este atleta ya podría existir
                    </p>
                    <p className="text-xs text-amber-900/90 dark:text-amber-200/90">
                      {describirAtletaDuplicado(dupAviso)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-6">
                  <Button type="button" size="sm" variant="outline" onClick={() => setDupAviso(null)}>
                    Corregir los datos
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={createStudentMutation.isPending}
                    onClick={crearIgualPeseAlDuplicado}
                  >
                    Es otra persona — crear igual
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button
                type="submit"
                disabled={createStudentMutation.isPending || updateStudentMutation.isPending || (!editingStudent && !!dupAviso)}
              >
                {createStudentMutation.isPending || updateStudentMutation.isPending ? 'Guardando...' : (editingStudent ? 'Guardar Cambios' : 'Agregar Atleta')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── View Athlete Dialog (read-only) ────────────────────────────
          Muestra datos personales, médico, equipo, plan, acudiente
          y documentos cargados. Funciona para child / adult / unregistered.
          ─────────────────────────────────────────────────────────────── */}
      <Dialog open={!!viewingStudent} onOpenChange={(o) => !o && setViewingStudent(null)}>
        <DialogContent className="w-[95vw] max-w-3xl max-h-[90dvh] overflow-y-auto">
          {viewingStudent && (() => {
            const s = viewingStudent;
            const athleteType = getAthleteType(s);
            const age = calculateAge(s.date_of_birth);
            const isChild = athleteType === 'child';
            const isAdult = athleteType === 'adult';
            const isUnregistered = athleteType === 'unregistered';

            const typeBadge = isChild
              ? <Badge className="bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30">Menor</Badge>
              : isAdult
                ? <Badge className="bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/30">Adulto</Badge>
                : <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">Sin cuenta</Badge>;

            const statusBadge = s.status === 'inactive'
              ? <Badge variant="outline" className="text-muted-foreground">Inactivo</Badge>
              : <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30">Activo</Badge>;

            // Plan manda (igual que la vista y el motor de cobros): nunca suma
            // equipo + plan; si hay plan, ese es el valor.
            const monthlyFee = Number((s as any).price_monthly)
              || Number((s as any).plan_monthly_fee)
              || Number((s as any).team_monthly_fee)
              || Number(s.monthly_fee) || 0;

            return (
              <>
                <DialogHeader>
                  <div className="flex items-start gap-4">
                    {/* Avatar del atleta: foto si subió, ícono genérico si no */}
                    {s.avatar_url ? (
                      <img
                        src={s.avatar_url}
                        alt={s.full_name}
                        className="w-16 h-16 rounded-full object-cover flex-shrink-0 ring-2 ring-primary/20"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <User className="w-8 h-8 text-primary" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <DialogTitle className="text-xl break-words">{s.full_name}</DialogTitle>
                      <DialogDescription asChild>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {typeBadge}
                          {statusBadge}
                          {age != null && <span className="text-sm text-muted-foreground">{age} años</span>}
                          {s.date_of_birth && (
                            <span className="text-sm text-muted-foreground">
                              · {format(new Date(s.date_of_birth + 'T12:00:00'), 'dd MMM yyyy', { locale: es })}
                            </span>
                          )}
                        </div>
                      </DialogDescription>
                    </div>
                  </div>
                </DialogHeader>

                <div className="space-y-6 mt-2">
                  {/* ── Sección: Datos personales ───────────────────── */}
                  <section>
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                      <User className="w-4 h-4" /> Datos personales
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <InfoRow label="Documento" value={
                        studentDocInfo.doc_type && studentDocInfo.doc_number
                          ? `${studentDocInfo.doc_type.toUpperCase()} ${studentDocInfo.doc_number}`
                          : null
                      } />
                      {registrationZkPinEnabled && schoolId
                        ? <ZkPinInfoRow schoolId={schoolId} athleteId={s.id} athleteType={athleteType} />
                        : <InfoRow label="Dorsal" value={s.dorsal} />}
                      <InfoRow label="Talla camiseta" value={studentDocInfo.tshirt_size} />
                      <InfoRow label="Tipo de sangre" value={studentDocInfo.blood_type} />
                      <InfoRow label="EPS" value={studentDocInfo.eps_name} />
                      {s.emergency_contact && (
                        <InfoRow label="Contacto emergencia" value={s.emergency_contact} />
                      )}
                      {!isChild && s.parent_email && (
                        <InfoRow label="Email" value={s.parent_email} icon={<Mail className="w-3 h-3" />} />
                      )}
                      {!isChild && s.parent_phone && (
                        <InfoRow label="Teléfono" value={s.parent_phone} icon={<Phone className="w-3 h-3" />} />
                      )}
                      {isUnregistered && studentDocInfo.guardian_phone && (
                        <InfoRow label="Teléfono acudiente" value={studentDocInfo.guardian_phone} icon={<Phone className="w-3 h-3" />} />
                      )}
                      {isUnregistered && studentDocInfo.guardian_email && (
                        <InfoRow label="Correo acudiente" value={studentDocInfo.guardian_email} icon={<Mail className="w-3 h-3" />} />
                      )}
                    </div>
                    {/* Cuestionario de salud autorreportado (no es historia clínica) —
                        solo se muestra lo que respondió "Sí", para no llenar la
                        pantalla de negativos. */}
                    {isUnregistered && studentDocInfo.health_screening && (() => {
                      const avisos = Object.entries(studentDocInfo.health_screening)
                        .filter(([, v]) => typeof v === 'string' && v.trim().toLowerCase() === 'sí');
                      return avisos.length > 0 ? (
                        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                          <p className="font-medium text-amber-700 dark:text-amber-400 mb-1">Cuestionario de afiliación — respuestas a revisar</p>
                          <ul className="list-disc pl-4 space-y-0.5 text-amber-700/90 dark:text-amber-400/90">
                            {avisos.map(([k]) => <li key={k}>{HEALTH_SCREENING_LABELS[k] || k}</li>)}
                          </ul>
                        </div>
                      ) : (
                        <p className="mt-3 text-xs text-muted-foreground italic">Cuestionario de afiliación sin antecedentes reportados</p>
                      );
                    })()}
                  </section>

                  {/* ── Sección: Información médica ─────────────────── */}
                  {s.medical_info && (
                    <section>
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                        <Heart className="w-4 h-4 text-red-500" /> Información médica
                      </h3>
                      <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-500/40 rounded-lg p-3 text-sm whitespace-pre-wrap break-words">
                        {(() => {
                          try {
                            const parsed = JSON.parse(s.medical_info);
                            if (parsed.has_allergies) {
                              return (
                                <div className="space-y-1 text-red-900 dark:text-red-200">
                                  <p className="font-semibold text-red-700 dark:text-red-400">⚠️ Tiene alergias</p>
                                  {parsed.allergy_type && <p><strong>Tipo:</strong> {parsed.allergy_type}</p>}
                                  {parsed.allergy_severity && <p><strong>Severidad:</strong> {parsed.allergy_severity}</p>}
                                  {parsed.allergy_treatment && <p><strong>Tratamiento:</strong> {parsed.allergy_treatment}</p>}
                                  {parsed.notes && <p className="mt-2"><strong>Notas:</strong> {parsed.notes}</p>}
                                </div>
                              );
                            }
                            return <span className="text-muted-foreground">Sin alergias reportadas{parsed.notes ? ` · ${parsed.notes}` : ''}</span>;
                          } catch {
                            return s.medical_info;
                          }
                        })()}
                      </div>
                    </section>
                  )}

                  {/* ── Sección: Equipo, sede y plan ─────────────────── */}
                  <section>
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                      <Trophy className="w-4 h-4 text-orange-500" /> Equipo y plan
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <InfoRow label="Equipo" value={s.team_name} />
                      <InfoRow label="Deporte" value={s.team_sport || s.sport} />
                      <InfoRow label="Sede" value={s.branch_name} icon={<MapPin className="w-3 h-3" />} />
                      {!hideFinancials && (
                        <InfoRow label="Mensualidad" value={monthlyFee > 0 ? formatCurrency(monthlyFee) : null} />
                      )}
                    </div>

                    {/* Saldo pendiente: todos los cobros abiertos, no solo la
                        mensualidad (inscripción y seguro del alta son filas aparte). */}
                    {!hideFinancials && openDebtOf(s.id) && (
                      <div className="mt-3 rounded-lg border border-red-200 bg-red-50/40 dark:bg-red-950/10 p-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                          Saldo pendiente · <span className="font-semibold text-red-600">{formatCurrency(openDebtOf(s.id)!.total)}</span>
                        </p>
                        <ul className="space-y-1 text-sm">
                          {openDebtOf(s.id)!.items.map((item, idx) => (
                            <li key={idx} className="flex justify-between gap-3">
                              <span>{item.label}</span>
                              <span className="font-medium">{formatCurrency(item.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Plan activo */}
                    <div className="mt-3 rounded-lg border bg-muted/30 p-3">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2">
                        <Zap className="w-3 h-3 text-purple-500" /> Plan activo
                      </p>
                      {loadingPlanInfo ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="w-4 h-4 animate-spin" /> Cargando plan...
                        </div>
                      ) : studentPlanInfo ? (
                        <div className="space-y-1 text-sm">
                          <p className="font-semibold">{studentPlanInfo.plan_name}</p>
                          {studentPlanInfo.offering_name && <p className="text-muted-foreground text-xs">{studentPlanInfo.offering_name}</p>}
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
                            {studentPlanInfo.start_date && (
                              <span>Inicio: {format(new Date(studentPlanInfo.start_date + 'T12:00:00'), 'dd MMM yyyy', { locale: es })}</span>
                            )}
                            {studentPlanInfo.end_date && (
                              <span>Vence: {format(new Date(studentPlanInfo.end_date + 'T12:00:00'), 'dd MMM yyyy', { locale: es })}</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">Sin plan activo</p>
                      )}
                    </div>
                  </section>

                  {/* ── Sección: Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md) ──
                      Gateada por hourBankByEnrollment (piloto Dreamers): antes solo
                      HourBankBalanceCard se ocultaba sin plan, pero el título y el
                      botón "Ver reporte" quedaban visibles igual en cualquier escuela. */}
                  {s.enrollment_id && hourBankByEnrollment.has(s.enrollment_id) && (
                    <section>
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-primary" /> Banco de horas
                      </h3>
                      <HourBankBalanceCard enrollmentId={s.enrollment_id} showHistory />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-0 mt-2 text-xs text-muted-foreground"
                        onClick={() => setShowStudentAccessReport((v) => !v)}
                      >
                        {showStudentAccessReport ? 'Ocultar' : 'Ver'} reporte de ingresos/salidas
                      </Button>
                      {showStudentAccessReport && <StudentReportPanel enrollmentId={s.enrollment_id} />}
                    </section>
                  )}

                  {/* ── Sección: Acudiente (solo child) ──────────────── */}
                  {isChild && (s.display_parent_name || s.parent_name || s.parent_email || s.parent_phone) && (
                    <section>
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                        <User className="w-4 h-4" /> Acudiente
                      </h3>
                      <div className="flex items-start gap-4">
                        {/* Avatar del acudiente */}
                        {s.parent_avatar ? (
                          <img
                            src={s.parent_avatar}
                            alt={s.display_parent_name || s.parent_name || 'Acudiente'}
                            className="w-12 h-12 rounded-full object-cover flex-shrink-0 ring-1 ring-border"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                            <User className="w-6 h-6 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <InfoRow label="Nombre" value={s.display_parent_name || s.parent_name} />
                          <InfoRow label="Email" value={s.parent_email} icon={<Mail className="w-3 h-3" />} />
                          <InfoRow label="Teléfono" value={s.parent_phone} icon={<Phone className="w-3 h-3" />} />
                        </div>
                      </div>
                    </section>
                  )}

                  {/* ── Sección: Acudiente (unregistered — viene del formulario de afiliación) ──
                       Solo para menores: un mayor de edad no tiene acudiente aunque el intake
                       haya guardado un nombre (heurística de nombre de archivo de Drive, ver
                       02b_subir_documento.mjs — para adultos ese "acudiente" es la propia persona). */}
                  {isUnregistered && !isAdultByBirthdate(s.date_of_birth) && (studentDocInfo.guardian_full_name || studentDocInfo.guardian_phone || studentDocInfo.guardian_email || studentDocInfo.intake_form_data) && (
                    <section>
                      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                        <User className="w-4 h-4" /> Acudiente
                      </h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <InfoRow label="Nombre" value={studentDocInfo.guardian_full_name} />
                        <InfoRow label="Teléfono" value={studentDocInfo.guardian_phone} icon={<Phone className="w-3 h-3" />} />
                        <InfoRow label="Email" value={studentDocInfo.guardian_email} icon={<Mail className="w-3 h-3" />} />
                        <InfoRow label="Ocupación" value={studentDocInfo.intake_form_data?.guardian_occupation} />
                      </div>
                      {(studentDocInfo.intake_form_data?.address || studentDocInfo.intake_form_data?.locality || studentDocInfo.intake_form_data?.neighborhood) && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm mt-3">
                          <InfoRow label="Dirección" value={studentDocInfo.intake_form_data?.address} />
                          <InfoRow label="Localidad / Barrio" value={
                            [studentDocInfo.intake_form_data?.locality, studentDocInfo.intake_form_data?.neighborhood].filter(Boolean).join(' — ') || null
                          } />
                        </div>
                      )}
                    </section>
                  )}

                  {/* ── Sección: Documentos cargados ─────────────────── */}
                  <section>
                    <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                      <FileText className="w-4 h-4" /> Documentos cargados
                    </h3>
                    {loadingDocs ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" /> Cargando documentos...
                      </div>
                    ) : isUnregistered ? (
                      <div className="space-y-2">
                        {ATHLETE_DOCUMENT_TYPES.map((docType) => {
                          const doc = studentDocs.find((d) => d.document_type === docType);
                          const isUploading = uploadingDocType === docType;
                          return (
                            <div
                              key={docType}
                              className="flex items-center gap-3 rounded-lg border bg-card p-3"
                            >
                              <FileText className={`w-5 h-5 flex-shrink-0 ${doc ? 'text-muted-foreground' : 'text-muted-foreground/40'}`} />
                              <span className="flex-1 text-sm truncate">{DOCUMENT_TYPE_LABELS[docType]}</span>
                              {doc ? (
                                <a href={doc.url} target="_blank" rel="noopener noreferrer">
                                  <Button variant="ghost" size="sm" className="h-7 px-2">
                                    <Download className="w-3.5 h-3.5" />
                                  </Button>
                                </a>
                              ) : (
                                <Badge variant="outline" className="text-xs text-muted-foreground">Sin cargar</Badge>
                              )}
                              {canManageStudents && (
                                <label>
                                  <input
                                    type="file"
                                    accept=".pdf,.jpg,.jpeg,.png"
                                    className="hidden"
                                    disabled={isUploading}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleUploadAthleteDocument(docType, file);
                                      e.target.value = '';
                                    }}
                                  />
                                  <Button asChild variant="outline" size="sm" className="h-7 px-2 cursor-pointer" disabled={isUploading}>
                                    <span>
                                      {isUploading ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <Upload className="w-3.5 h-3.5" />
                                      )}
                                    </span>
                                  </Button>
                                </label>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : studentDocs.length === 0 ? (
                      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                        Sin documentos cargados
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {studentDocs.map((doc) => (
                          <a
                            key={doc.name}
                            href={doc.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 rounded-lg border bg-card p-3 hover:bg-accent/50 transition-colors"
                          >
                            <FileText className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                            <span className="flex-1 text-sm truncate">{doc.name}</span>
                            <Download className="w-4 h-4 text-primary flex-shrink-0" />
                          </a>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Soportes y «referido por»: solo se pintan con la función activa en la escuela. */}
                  {schoolId && (
                    <FichaDeportistaExtras
                      schoolId={schoolId}
                      athleteId={s.id}
                      athleteType={athleteType}
                      enrollmentId={s.enrollment_id}
                      puedeAdministrar={canManageCharges(schoolRole)}
                    />
                  )}
                </div>

                <DialogFooter className="flex-col-reverse sm:flex-row gap-2 mt-6">
                  <Button variant="outline" onClick={() => setViewingStudent(null)}>
                    Cerrar
                  </Button>
                  {canCreateOrEditStudents && (
                    <Button onClick={() => {
                      const stored = s;
                      setViewingStudent(null);
                      handleEditStudent(stored);
                    }}>
                      <Edit className="w-4 h-4 mr-2" />
                      Editar
                    </Button>
                  )}
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <PauseAthleteDialog
        open={!!pausingStudent}
        onOpenChange={(o) => { if (!o) setPausingStudent(null); }}
        athleteName={pausingStudent?.full_name ?? ''}
        enrollmentId={pausingStudent?.enrollment_id ?? null}
        onPreview={previewPause}
        isSubmitting={pausar.isPending}
        onConfirm={(args) => pausar.mutate(args, { onSuccess: () => setPausingStudent(null) })}
      />

      <ResolverCobrosAbiertosDialog
        open={!!cobrosAbiertosDe}
        onOpenChange={(o) => { if (!o) setCobrosAbiertosDe(null); }}
        enrollmentId={cobrosAbiertosDe?.enrollmentId ?? null}
        athleteName={cobrosAbiertosDe?.nombre ?? ''}
        origen={cobrosAbiertosDe?.origen ?? 'no_asistio'}
      />

      <CSVImportModal open={showImportModal} onClose={() => setShowImportModal(false)}
        onSuccess={() => { setShowImportModal(false); toast({ title: "Importación completada", description: "La lista de atletas se ha actualizado." }); queryClient.invalidateQueries({ queryKey: ['school-students'] }); }}
        schoolId={schoolId ?? ''} schoolName={schoolName} branchId={activeBranchId} students={students} teams={teams} branches={branches} />
      {teamSchedulingEnabled && (
        <AssignSchedulingTeamModal
          open={!!assigningTeamStudent}
          onOpenChange={(o) => { if (!o) setAssigningTeamStudent(null); }}
          enrollmentId={assigningTeamStudent?.enrollment_id ?? null}
          studentName={assigningTeamStudent?.full_name ?? ''}
          schoolId={schoolId || ''}
          onSuccess={() => setAssigningTeamStudent(null)}
        />
      )}
      <StudentTypeSelector open={showTypeSelector} onClose={() => setShowTypeSelector(false)} onSelectChild={() => setShowCreateChildModal(true)} onSelectAdult={() => setShowCreateAdultModal(true)} />
      {canRegisterPayments && (
        <CobrosYPagosModal
          open={!!accountStudentId}
          onOpenChange={(o) => { if (!o) setAccountStudentId(null); }}
          initialAthleteId={accountStudentId ?? undefined}
          onViewOperations={() => navigate('/payments-automation?tab=operaciones')}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['school-students'] });
            queryClient.invalidateQueries({ queryKey: ['school-payments'] });
          }}
        />
      )}
      <CreateChildModal
        open={showCreateChildModal}
        onClose={() => { setShowCreateChildModal(false); setProspectoEnAlta(null); }}
        onSuccess={(result) => { queryClient.invalidateQueries({ queryKey: ['school-students'] }); setShowCreateChildModal(false); cerrarProspectoInscrito(result); }}
        schoolId={schoolId || ''}
        canWaiveFees={schoolRole !== 'coach'}
        prefill={prefillProspecto}
      />
      <CreateAdultAthleteModal
        open={showCreateAdultModal}
        onClose={() => { setShowCreateAdultModal(false); setProspectoEnAlta(null); }}
        onSuccess={(result) => { queryClient.invalidateQueries({ queryKey: ['school-students'] }); setShowCreateAdultModal(false); cerrarProspectoInscrito(result); }}
        schoolId={schoolId || ''}
        canWaiveFees={schoolRole !== 'coach'}
        prefill={prefillProspecto}
      />
      <TrialClassSettingsModal open={configPruebaOpen} onOpenChange={setConfigPruebaOpen} />
    </div>
  );
}

// ─── Helper: fila de info "Label — Value" usada en el View Dialog ───────────────
function InfoRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null | undefined;
  icon?: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium break-words flex items-center gap-1.5">
        {icon}
        {value || <span className="text-muted-foreground font-normal italic">—</span>}
      </p>
    </div>
  );
}
