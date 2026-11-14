import { useState, useMemo, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useTrialClassSelfServiceSettings } from '@/hooks/useTrialClassesSelf';
import { ShareTrialLinkDialog } from '@/components/school/ShareTrialLinkDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel,
    AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
    AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useOfferings, Offering } from '@/hooks/useOfferings';
import { useSchoolFacilities } from '@/hooks/useSchoolData';
import { useToast } from '@/hooks/use-toast';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useQueryClient } from '@tanstack/react-query';
import { EnrollPlanStudentModal } from '@/components/enrollment/EnrollPlanStudentModal';
import { useSportsCatalog } from '@/hooks/useSportsCatalog';
import { getSportVisual } from '@/lib/sportVisuals';
import { Plus, Package, Search, X, ChevronDown, Edit, Minus, DollarSign, Clock, Zap, UserPlus, Trash2, ArrowRight, Copy, Share2 } from 'lucide-react';
import { OfferingCoachesPanel } from './OfferingCoachesPanel';
import { formatFriendlyDuration } from '@/lib/utils';
import { porOrdenDeCreacion, coincide } from '@/lib/planes/ordenPlanes';
import { PlanLevelRulesSection, EMPTY_LEVEL_RULES, levelRulesFromPlan, levelRulesPayload, type PlanLevelRules } from './PlanLevelRulesSection';
import { useLevelProgressionEnabled } from '@/hooks/useLevelProgression';
import { Checkbox } from '@/components/ui/checkbox';
import {
    PAGO_UNICO_NO_ES_PLAN_MSG, PAGOS_UNICOS_AYUDA, bloquearNombreDePlan, esNombreDePagoUnico,
    esTarifaMensualActiva, montoPagoUnico, resumenPagosUnicos,
} from '@/lib/school/pagosUnicos';

const MIN_SEARCH_CHARS = 1;

const OFFERING_TYPE_LABELS: Record<string, string> = {
    membership: 'Membresía',
    session_pack: 'Pack de Clases',
    court_booking: 'Reserva de Cancha',
    tournament: 'Torneo',
    single_session: 'Clase Suelta',
};

const BOOKING_MODE_OPTIONS: { value: 'coach' | 'facility' | 'both'; label: string; description: string }[] = [
    { value: 'coach', label: 'Por entrenador', description: 'Se agenda según la disponibilidad de los entrenadores del plan (o de todos si no hay ninguno asignado).' },
    { value: 'facility', label: 'Por instalación', description: 'Se agenda según la disponibilidad de una instalación específica, sin entrenador fijo.' },
    { value: 'both', label: 'Ambas', description: 'El atleta puede elegir entre un horario de entrenador o uno de instalación.' },
];

const PLAN_DURATION_OPTIONS = [
    { label: 'Semanal (7 días)', value: '7' },
    { label: 'Quincenal (15 días)', value: '15' },
    { label: 'Mensual (30 días)', value: '30' },
    { label: '3 meses (90 días)', value: '90' },
    { label: '6 meses (180 días)', value: '180' },
    { label: '12 meses (365 días)', value: '365' },
    { label: 'Personalizado...', value: 'custom' },
];


const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const HOUR_OPTIONS = [
  '06:00','07:00','08:00','09:00','10:00','11:00',
  '12:00','13:00','14:00','15:00','16:00','17:00',
  '18:00','19:00','20:00','21:00','22:00',
];

interface ScheduleSlot { day: number; time: string }

const formatCurrency = (val: string | number) => {
    if (val === undefined || val === null || val === '') return '';
    const num = typeof val === 'string' ? parseFloat(val.replace(/\./g, '').replace(/,/g, '')) : val;
    if (isNaN(num)) return '';
    return new Intl.NumberFormat('de-DE').format(num); // de-DE uses dots for thousands
};

const parseCurrency = (val: string) => {
    return val.replace(/\./g, '').replace(/,/g, '');
};

const format12h = (time24: string) => {
    if (!time24) return '';
    const [h24, m] = time24.split(':');
    const h = parseInt(h24, 10);
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${String(h12).padStart(2, '0')}:${m} ${period}`;
};

// ═══════════════════════════════════════════════════════════════════
// CSS to hide number spinners
// ═══════════════════════════════════════════════════════════════════
const hideSpinnersCSS = `
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input[type="number"] {
    -moz-appearance: textfield;
  }
`;

// ═══════════════════════════════════════════════════════════════════
// Number Stepper — Input numérico con botones +/-
// ═══════════════════════════════════════════════════════════════════

function NumberStepper({
    id, value, onChange, placeholder, min = 0, step = 1, prefix, unit, label, isCurrency = false, disabled = false,
}: {
    id: string; value: string; onChange: (v: string) => void;
    placeholder?: string; min?: number; step?: number; prefix?: string; unit?: string; label?: string;
    isCurrency?: boolean; disabled?: boolean;
}) {
    const rawVal = isCurrency ? parseCurrency(value) : value;
    const numVal = rawVal ? parseFloat(rawVal) : 0;

    const decrease = () => onChange(String(Math.max(min, numVal - step)));
    const increase = () => onChange(String(numVal + step));

    return (
        <div className="space-y-1.5">
            <style>{hideSpinnersCSS}</style>
            {label && <Label htmlFor={id} className="text-sm font-medium">{label}</Label>}
            <div className="flex items-center gap-0">
                <button
                    type="button"
                    onClick={decrease}
                    disabled={disabled || numVal <= min}
                    className="h-9 w-9 flex items-center justify-center rounded-l-md border border-r-0 bg-muted/60 hover:bg-muted text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                    <Minus className="h-3.5 w-3.5" />
                </button>
                <div className="relative flex-1">
                    {prefix && (
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">{prefix}</span>
                    )}
                    {unit && (
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium pointer-events-none">{unit}</span>
                    )}
                    <Input
                        id={id}
                        placeholder={placeholder}
                        type={isCurrency ? "text" : "number"}
                        disabled={disabled}
                        className={`rounded-none border-x-0 h-9 text-center ${prefix ? 'pl-6' : ''} ${unit ? 'pr-10' : ''}`}
                        value={isCurrency ? formatCurrency(value) : value}
                        onChange={(e) => {
                            const val = e.target.value;
                            if (isCurrency) {
                                const clean = parseCurrency(val);
                                if (/^\d*$/.test(clean)) {
                                    onChange(clean);
                                }
                            } else {
                                onChange(val);
                            }
                        }}
                    />
                </div>
                <button
                    type="button"
                    onClick={increase}
                    disabled={disabled}
                    className="h-9 w-9 flex items-center justify-center rounded-r-md border border-l-0 bg-muted/60 hover:bg-muted text-foreground transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════
// Schedule Picker Component
// ═══════════════════════════════════════════════════════════════════

function SchedulePicker({
  value,
  onChange,
}: {
  value: ScheduleSlot[];
  onChange: (slots: ScheduleSlot[]) => void;
}) {
  const [selectedDay, setSelectedDay] = useState<number>(1);
  const [selectedTime, setSelectedTime] = useState<string>('08:00');

  const handleAdd = () => {
    const exists = value.some(s => s.day === selectedDay && s.time === selectedTime);
    if (exists) return;
    onChange([...value, { day: selectedDay, time: selectedTime }]);
  };

  const handleRemove = (day: number, time: string) => {
    onChange(value.filter(s => !(s.day === day && s.time === time)));
  };

  const grouped = useMemo(() => {
    const g: Record<number, string[]> = {};
    value.forEach(s => {
      if (!g[s.day]) g[s.day] = [];
      g[s.day].push(s.time);
    });
    return g;
  }, [value]);

  return (
    <div className="space-y-3">
      {/* Selector de día */}
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">Día</Label>
        <div className="flex gap-1 flex-wrap">
          {DAY_LABELS.map((label, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSelectedDay(i)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-all ${
                selectedDay === i
                  ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground hover:bg-primary/5'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Selector de hora + botón agregar */}
      <div className="flex gap-2 items-end">
        <div className="flex-1 space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Hora</Label>
          <Select value={selectedTime} onValueChange={setSelectedTime}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOUR_OPTIONS.map(h => (
                <SelectItem key={h} value={h}>{format12h(h)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleAdd}
          className="h-9 gap-1.5 shrink-0 border-primary/30 text-primary hover:bg-primary/5"
        >
          <Plus className="h-3.5 w-3.5" /> Agregar
        </Button>
      </div>

      {/* Slots configurados */}
      {value.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border/60 overflow-hidden">
          {Object.entries(grouped)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([day, times]) => (
              <div key={day} className="px-3 py-2 flex items-center gap-3">
                <span className="text-xs font-bold text-foreground/70 w-9 shrink-0">
                  {DAY_LABELS[Number(day)]}
                </span>
                <div className="flex flex-wrap gap-1.5 flex-1">
                  {times.sort().map(time => (
                    <span
                      key={time}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold border border-primary/25"
                    >
                      {format12h(time)}
                      <button
                        type="button"
                        onClick={() => handleRemove(Number(day), time)}
                        className="hover:text-destructive transition-colors"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {value.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2.5 border border-dashed border-border rounded-lg bg-muted/30">
          Agrega al menos un horario
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Sport Search Combobox
// ═══════════════════════════════════════════════════════════════════

function SportSearchCombobox({
    values,
    onChange,
}: {
    values: string[];
    onChange: (sports: string[]) => void;
}) {
    const [query, setQuery] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Catalogo de deportes desde la BD; la constante queda de respaldo.

    const { sports: catalogo } = useSportsCatalog();

    const allSports = catalogo;

    const results = useMemo(() => {
        if (!query.trim()) return [];
        const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return allSports.filter((s: any) => {
            const name = s.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const nameEn = (s.nombreIngles || "").toLowerCase();
            return (name.includes(q) || nameEn.includes(q)) && !values.includes(s.nombre);
        }).slice(0, 10);
    }, [query, values, allSports]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleAdd = (sportName: string) => {
        onChange([sportName]); // Currently OfferingsManagement seems to expect single sport per offering
        setQuery('');
        setIsOpen(false);
    };

    const handleRemove = () => {
        onChange([]);
    };

    return (
        <div ref={containerRef} className="space-y-2">
            {values.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                    {values.map((name) => {
                        const sport = allSports.find((s: any) => s.nombre === name);
                        const visual = getSportVisual(sport?.nombre?.toLowerCase() || 'default');
                        return (
                            <div key={name} className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-primary/30 bg-primary/10 shadow-sm animate-in fade-in zoom-in-95">
                                <span className="text-base">{visual.icon}</span>
                                <span className="text-xs font-bold text-foreground">{name}</span>
                                <button
                                    type="button"
                                    onClick={handleRemove}
                                    className="p-0.5 hover:bg-red-500/10 hover:text-red-400 rounded-full transition-colors"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="relative group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
                <Input
                    placeholder={values.length > 0 ? 'Cambiar deporte...' : 'Buscar deporte (ej: Fútbol, Tenis)...'}
                    value={query}
                    onChange={(e) => { 
                        setQuery(e.target.value); 
                        setIsOpen(e.target.value.trim().length > 0); 
                    }}
                    onFocus={() => { if (query.trim().length > 0) setIsOpen(true); }}
                    className="pl-10 h-11 rounded-xl text-sm transition-all focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/15"
                />
                
                {isOpen && results.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-popover text-popover-foreground border border-border rounded-xl shadow-lg z-[100] overflow-hidden animate-in fade-in slide-in-from-top-2">
                        <div className="max-h-60 overflow-y-auto py-1">
                            {results.map((sport: any) => {
                                const visual = getSportVisual(sport.nombre.toLowerCase());
                                return (
                                    <button
                                        key={sport.id}
                                        type="button"
                                        className="group/item w-full flex items-center gap-3 px-4 py-3 hover:bg-accent focus-visible:bg-accent text-left transition-colors border-b border-border/60 last:border-0"
                                        onClick={() => handleAdd(sport.nombre)}
                                    >
                                        <span className="text-xl">{visual.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-semibold text-foreground truncate">{sport.nombre}</p>
                                            <p className="text-xs text-muted-foreground truncate">{sport.federacion_internacional || sport.federacion}</p>
                                        </div>
                                        <ArrowRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover/item:opacity-100 transition-opacity" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {isOpen && query.trim() && results.length === 0 && (
                    <div className="absolute top-full left-0 right-0 mt-2 bg-popover text-popover-foreground border border-border rounded-xl p-6 text-center z-[100] animate-in fade-in slide-in-from-top-2">
                        <p className="text-xs text-muted-foreground">No se encontraron resultados para "{query}"</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════

export function OfferingsManagement() {
    const { toast } = useToast();
    const { schoolId, schoolName, schoolSettings } = useSchoolContext();
    // Piloto: solo escuelas con el flag ven el selector de booking_mode
    // (Dreamers + Academia Superior Bogotá, ver school_settings_booking_mode_toggle_flag).
    const bookingModeToggleEnabled = !!schoolSettings?.booking_mode_toggle_enabled;
    const queryClient = useQueryClient();
    const { settings: ssSettings } = useTrialClassSelfServiceSettings();
    const [schoolSlug, setSchoolSlug] = useState<string | null>(null);
    const [shareOpen, setShareOpen] = useState(false);

    useEffect(() => {
        if (!schoolId) return;
        (supabase.from('schools') as any)
            .select('slug')
            .eq('id', schoolId)
            .maybeSingle()
            .then(({ data }: any) => { if (data?.slug) setSchoolSlug(data.slug); });
    }, [schoolId]);

    const trialPublicUrl = schoolSlug ? `${window.location.origin}/agendar-clase/${schoolSlug}` : '';
    // Para sugerir categorías al crear un plan. `SportSearchCombobox` también lo
    // llama, pero es otro componente: su `allSports` no está en este alcance, y
    // dar por hecho que sí fue justo el error de acá abajo.
    const { sports: catalogoDeportes } = useSportsCatalog();
    const { facilities } = useSchoolFacilities();

    const {
        offerings, 
        isLoading,
        createOffering,
        updateOffering,
        deleteOffering,
        createPlan,
        updatePlan,
        deletePlan,
        applyOneTimeFees,
    } = useOfferings();

    // Programas y tarifas en orden de creación (casi todas las escuelas tienen sort_order = 0
    // y sin desempate salían revueltos). El buscador muestra el programa entero si coincide
    // su nombre, o solo las tarifas que coinciden.
    const [busquedaPlanes, setBusquedaPlanes] = useState('');
    const offeringsVisibles = useMemo(() =>
        [...offerings].sort(porOrdenDeCreacion).flatMap((o) => {
            const planes = [...(o.offering_plans ?? [])].sort(porOrdenDeCreacion);
            if (coincide(o.name, busquedaPlanes)) return [{ ...o, offering_plans: planes }];
            const coinciden = planes.filter((p) => coincide(p.name, busquedaPlanes));
            return coinciden.length ? [{ ...o, offering_plans: coinciden }] : [];
        }),
    [offerings, busquedaPlanes]);

    const isCreatingOffering = createOffering.isPending;
    const isUpdatingOffering = updateOffering.isPending;
    const isCreatingPlan = createPlan.isPending;
    const isUpdatingPlan = updatePlan.isPending;
    const isDeletingOffering = deleteOffering.isPending;
    const isDeletingPlan = deletePlan.isPending;

    // Enroll state
    const [enrollModal, setEnrollModal] = useState<{
        open: boolean;
        plan: any | null;
        offering: Offering | null;
    }>({
        open: false,
        plan: null,
        offering: null,
    });

    const [showCreate, setShowCreate] = useState(false);
    const [showCreatePlan, setShowCreatePlan] = useState<string | null>(null);
    const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
    const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
    const [enrollPlanId, setEnrollPlanId] = useState<string | null>(null);

    // -- Deletion State --
    const [planToDelete, setPlanToDelete] = useState<{ planId: string; offeringId: string } | null>(null);
    const [offeringToDelete, setOfferingToDelete] = useState<string | null>(null);

    const [newOffering, setNewOffering] = useState({
        name: '', description: '', offering_type: 'membership' as string, sport: '' as string,
        booking_mode: 'coach' as 'coach' | 'facility' | 'both',
        facility_id: '' as string,
    });

    const [newPlan, setNewPlan] = useState({
        name: '', max_sessions: '', max_secondary_sessions: '0',
        secondary_session_label: '', duration_days: '30', price: '', auto_renew: false,
        schedule_type: 'general' as 'general' | 'specific',
        schedule: [] as ScheduleSlot[],
        // Banco de horas (docs/specs/dreamers-banco-de-horas-torniquete.md) — mutuamente
        // excluyente con "máx. sesiones" a nivel de UI (el negocio nunca usa los dos a la vez,
        // aunque el esquema no lo impida).
        is_hours_plan: false,
        included_minutes_per_period: '',
        // Niveles por horas (docs/specs/dreamers-niveles-por-horas-y-progresion.md, D1/D2/D17):
        // bloque de sesión y días/semana propios del plan, y cobro de inscripción único.
        // Los tres vacíos = NULL = comportamiento actual (hereda de la escuela / sin cobro).
        session_block_minutes: '',
        included_sessions_per_week: '',
        registration_fee: '',
        // Seguro de accidentes (F-B): cobro único en el alta, dedupe 365 días por atleta.
        insurance_fee: '',
    });

    // Pagos únicos: nombre con el que se abrió el formulario (null = creando). Un plan
    // viejo llamado «Seguro» se puede seguir guardando si no se le cambia el nombre.
    const [planOriginalName, setPlanOriginalName] = useState<string | null>(null);
    const [offeringOriginalName, setOfferingOriginalName] = useState<string | null>(null);
    // Aviso «la inscripción y el seguro no son planes» (origen: tarifa u oferta/plan).
    const [nombreBloqueado, setNombreBloqueado] = useState<'tarifa' | 'plan' | null>(null);
    const pagosUnicosRef = useRef<HTMLDivElement>(null);
    // «Aplicar a todos los planes»
    const [showAplicarTodos, setShowAplicarTodos] = useState(false);
    const [bulkFees, setBulkFees] = useState({ registration_fee: '', insurance_fee: '' });
    const [bulkPlanIds, setBulkPlanIds] = useState<string[]>([]);

    const [isCustomDays, setIsCustomDays] = useState(false);
    const [customDays, setCustomDays] = useState('30');

    // "Ascenso y días" (F-F) — estado aparte de newPlan a propósito: el payload
    // solo lleva lo que cambió respecto de cómo se abrió el formulario.
    const [levelRules, setLevelRules] = useState<PlanLevelRules>(EMPTY_LEVEL_RULES);
    const [levelRulesInitial, setLevelRulesInitial] = useState<PlanLevelRules>(EMPTY_LEVEL_RULES);
    const { enabled: levelProgressionEnabled } = useLevelProgressionEnabled();

    const resetOfferingForm = () => {
        setNewOffering({ name: '', description: '', offering_type: 'membership', sport: '', booking_mode: 'coach', facility_id: '' });
        setEditingOfferingId(null);
        setOfferingOriginalName(null);
    };

    const resetPlanForm = () => {
        setNewPlan({ name: '', max_sessions: '', max_secondary_sessions: '0', secondary_session_label: '', duration_days: '30', price: '', auto_renew: false, schedule_type: 'general', schedule: [], is_hours_plan: false, included_minutes_per_period: '', session_block_minutes: '', included_sessions_per_week: '', registration_fee: '', insurance_fee: '' });
        setIsCustomDays(false);
        setCustomDays('30');
        setEditingPlanId(null);
        setPlanOriginalName(null);
        setLevelRules(EMPTY_LEVEL_RULES);
        setLevelRulesInitial(EMPTY_LEVEL_RULES);
    };

    // Tarifas mensuales activas de planes activos, sin las que ya se llaman
    // «Inscripción»/«Seguro» (ponerles inscripción encima no tiene sentido).
    const tarifasMensuales = useMemo(() =>
        offerings
            .filter((o) => o.is_active !== false && !esNombreDePagoUnico(o.name))
            .flatMap((o) => (o.offering_plans ?? [])
                .filter((p) => esTarifaMensualActiva(p) && !esNombreDePagoUnico(p.name))
                .map((p) => ({ plan: p, offeringName: o.name }))),
        [offerings]);

    const abrirAplicarTodos = () => {
        // Prellenar con el valor si todas las tarifas ya comparten el mismo.
        const comun = (campo: 'registration_fee' | 'insurance_fee') => {
            const vals = new Set(tarifasMensuales.map(({ plan }) => Number(plan[campo] ?? 0)));
            const unico = vals.size === 1 ? [...vals][0] : 0;
            return unico > 0 ? String(unico) : '';
        };
        setBulkFees({ registration_fee: comun('registration_fee'), insurance_fee: comun('insurance_fee') });
        setBulkPlanIds(tarifasMensuales.map(({ plan }) => plan.id));
        setShowAplicarTodos(true);
    };

    const handleAplicarTodos = () => {
        if (bulkPlanIds.length === 0) return;
        applyOneTimeFees.mutate({
            plan_ids: bulkPlanIds,
            registration_fee: montoPagoUnico(bulkFees.registration_fee),
            insurance_fee: montoPagoUnico(bulkFees.insurance_fee),
        }, {
            onSuccess: (r) => {
                toast({ title: 'Pagos únicos actualizados ✓', description: `Se aplicaron a ${r.updated} tarifa${r.updated === 1 ? '' : 's'}.` });
                setShowAplicarTodos(false);
            },
            onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
        });
    };

    const enfocarPagosUnicos = () => {
        setTimeout(() => {
            pagosUnicosRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            document.getElementById('plan-registration-fee')?.focus();
        }, 50);
    };

    // Botón del aviso: lleva a los campos Inscripción / Seguro.
    const irAPagosUnicos = () => {
        const origen = nombreBloqueado;
        setNombreBloqueado(null);
        if (origen === 'tarifa') {
            enfocarPagosUnicos();
            return;
        }
        // Desde «Nuevo Plan»: los pagos únicos van en las tarifas mensuales.
        setShowCreate(false);
        resetOfferingForm();
        if (tarifasMensuales.length > 0) {
            abrirAplicarTodos();
        } else {
            toast({
                title: 'Primero crea el plan mensual',
                description: 'Crea el plan con su tarifa mensual y llena ahí los campos «Inscripción» y «Seguro».',
            });
        }
    };


    const handleSaveOffering = () => {
        if (bloquearNombreDePlan(newOffering.name, editingOfferingId ? offeringOriginalName : null)) {
            setNombreBloqueado('plan');
            return;
        }
        const payload = {
            name: newOffering.name,
            offering_type: newOffering.offering_type as Offering['offering_type'],
            description: newOffering.description || undefined,
            sport: newOffering.sport || undefined,
            booking_mode: newOffering.booking_mode,
            facility_id: newOffering.booking_mode === 'coach' ? null : (newOffering.facility_id || null),
            metadata: {}, // Assuming metadata for multiple sports is no longer needed with single `sport` field
        };

        if (editingOfferingId) {
            updateOffering.mutate({ id: editingOfferingId, ...payload }, {
                onSuccess: () => { toast({ title: 'Plan actualizado ✓' }); setShowCreate(false); resetOfferingForm(); },
                onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
            });
        } else {
            createOffering.mutate(payload, {
                onSuccess: () => { toast({ title: 'Plan creado exitosamente ✓' }); setShowCreate(false); resetOfferingForm(); },
                onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
            });
        }
    };

    const handleSavePlan = (offeringId: string) => {
        if (bloquearNombreDePlan(newPlan.name, editingPlanId ? planOriginalName : null)) {
            setNombreBloqueado('tarifa');
            return;
        }
        const durationValue = newPlan.duration_days === 'custom'
            ? parseInt(customDays)
            : parseInt(newPlan.duration_days);

        const payload = {
            name: newPlan.name,
            // "Máx. sesiones" no se limpia cuando el plan es por horas: puede
            // quedar como etiqueta informativa ("480 min ≈ 4 clases de 2h"), no
            // es un tope aparte — el único límite real es included_minutes_per_period.
            // 0 o vacío = sin tope (∞): el BFF exige un entero positivo, así que 0 se manda como null.
            max_sessions: Number.parseInt(newPlan.max_sessions, 10) > 0 ? Number.parseInt(newPlan.max_sessions, 10) : null,
            included_minutes_per_period: newPlan.is_hours_plan
                ? (parseInt(newPlan.included_minutes_per_period) || null)
                : null,
            max_secondary_sessions: parseInt(newPlan.max_secondary_sessions) || 0,
            duration_days: durationValue || 30,
            price: parseFloat(newPlan.price) || 0,
            auto_renew: newPlan.auto_renew,
            // Niveles por horas (D1/D2) y cobro de inscripción (D17) — vacío = NULL,
            // comportamiento actual (hereda bloque de escuela / sin cobro de inscripción).
            session_block_minutes: newPlan.session_block_minutes ? parseInt(newPlan.session_block_minutes) : null,
            included_sessions_per_week: newPlan.included_sessions_per_week ? parseInt(newPlan.included_sessions_per_week) : null,
            // Pagos únicos: '' y 0 → null (no se cobra). emit_enrollment_fees ya trata
            // NULL y 0 igual (COALESCE(x,0) > 0); null deja la base sin ambigüedad.
            registration_fee: montoPagoUnico(newPlan.registration_fee),
            insurance_fee: montoPagoUnico(newPlan.insurance_fee),
            metadata: {
                secondary_session_label: newPlan.secondary_session_label || undefined,
                schedule_type: newPlan.schedule_type,
                schedule: newPlan.schedule_type === 'specific' ? newPlan.schedule : [],
            }
        };

        if (editingPlanId) {
            updatePlan.mutate({ offeringId, planId: editingPlanId, ...payload, ...levelRulesPayload(levelRules, levelRulesInitial) }, {
                onSuccess: () => { toast({ title: 'Tarifa actualizada ✓' }); setShowCreatePlan(null); resetPlanForm(); },
                onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
            });
        } else {
            createPlan.mutate({ offeringId, ...payload, ...levelRulesPayload(levelRules, levelRulesInitial) }, {
                onSuccess: () => { toast({ title: 'Tarifa creada ✓' }); setShowCreatePlan(null); resetPlanForm(); },
                onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
            });
        }
    };

    const handleEditOffering = (offering: Offering) => {
        setNewOffering({
            name: offering.name,
            description: offering.description || '',
            offering_type: offering.offering_type,
            sport: offering.sport || '',
            booking_mode: offering.booking_mode || 'coach',
            facility_id: offering.facility_id || '',
        });
        setEditingOfferingId(offering.id);
        setOfferingOriginalName(offering.name);
        setShowCreate(true);
    };

    const handleEditPlan = (offeringId: string, planId: string) => {
        const offering = offerings.find((o) => o.id === offeringId);
        const plan = offering?.offering_plans?.find((p) => p.id === planId);
        if (plan) {
            setEditingPlanId(planId);
            setPlanOriginalName(plan.name);
            const durationStr = plan.duration_days?.toString() || '30';
            const isPreset = ['7', '15', '30', '90', '180', '365'].includes(durationStr);
            setNewPlan({
                name: plan.name,
                max_sessions: plan.max_sessions?.toString() || '',
                max_secondary_sessions: plan.max_secondary_sessions?.toString() || '0',
                secondary_session_label: (plan.metadata?.secondary_session_label as string) || '',
                duration_days: isPreset ? durationStr : 'custom',
                price: plan.price?.toString() || '',
                auto_renew: plan.auto_renew || false,
                schedule_type: (plan.metadata?.schedule_type as 'general' | 'specific') || 'general',
                schedule: (plan.metadata?.schedule as ScheduleSlot[]) || [],
                is_hours_plan: plan.included_minutes_per_period != null,
                included_minutes_per_period: plan.included_minutes_per_period?.toString() || '',
                session_block_minutes: plan.session_block_minutes?.toString() || '',
                included_sessions_per_week: plan.included_sessions_per_week?.toString() || '',
                registration_fee: plan.registration_fee?.toString() || '',
                insurance_fee: plan.insurance_fee?.toString() || '',
            });
            setIsCustomDays(!isPreset);
            setCustomDays(!isPreset ? durationStr : '30');
            setLevelRules(levelRulesFromPlan(plan));
            setLevelRulesInitial(levelRulesFromPlan(plan));
            setShowCreatePlan(offeringId);
        }
    };


    const handleOpenEnroll = (offering: Offering, plan: any) => {
        setEnrollModal({
            open: true,
            offering,
            plan,
        });
    };

    const handleEnrollStudent = (planId: string) => {
        setEnrollPlanId(planId);
    };

    const handleDeletePlan = () => {
        if (!planToDelete) return;
        deletePlan.mutate(planToDelete, {
            onSuccess: () => {
                toast({ title: '✅ Tarifa eliminada', description: 'La tarifa ha sido eliminada exitosamente.' });
                setPlanToDelete(null);
            },
            onError: (err: any) => {
                const code = err?.body?.code || err?.code;
                const msg = code === 'PLAN_HAS_ACTIVE_ENROLLMENTS'
                    ? 'No puedes eliminar una tarifa con deportistas activos. Cancela las inscripciones primero.'
                    : err?.body?.error || err?.message || 'No se pudo eliminar la tarifa.';
                toast({ title: '❌ Error al eliminar tarifa', description: msg, variant: 'destructive' });
                setPlanToDelete(null);
            }
        });
    };

    const handleDeleteOffering = () => {
        if (!offeringToDelete) return;
        deleteOffering.mutate(offeringToDelete, {
            onSuccess: () => {
                toast({ title: '✅ Plan eliminado', description: 'El plan y sus tarifas han sido eliminados.' });
                setOfferingToDelete(null);
            },
            onError: (err: any) => {
                const code = err?.body?.code || err?.code;
                const msg = code === 'OFFERING_HAS_ACTIVE_ENROLLMENTS'
                    ? 'No puedes eliminar un plan con deportistas activos. Cancela las inscripciones primero.'
                    : err?.body?.error || err?.message || 'No se pudo eliminar el plan.';
                toast({ title: '❌ Error al eliminar plan', description: msg, variant: 'destructive' });
                setOfferingToDelete(null);
            }
        });
    };

    if (isLoading) {
        return (
            <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                    <div key={i} className="h-28 bg-muted/40 animate-pulse rounded-xl border border-border/30" />
                ))}
            </div>
        );
    }

    const isSavingOffering = isCreatingOffering || isUpdatingOffering;
    const isSavingPlan = isCreatingPlan || isUpdatingPlan;

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold tracking-tight">Planes y Membresías</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        {offerings.length > 0 ? `${offerings.length} plan${offerings.length !== 1 ? 'es' : ''} configurado${offerings.length !== 1 ? 's' : ''}` : 'Configura los planes para tus deportistas'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {ssSettings?.self_service_enabled && (
                        <Button
                            onClick={() => setShareOpen(true)}
                            disabled={!schoolSlug}
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                        >
                            <Share2 className="h-4 w-4" /> Compartir link
                        </Button>
                    )}
                    {tarifasMensuales.length > 0 && (
                        <Button
                            onClick={abrirAplicarTodos}
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            title="Fijar la misma inscripción y el mismo seguro en todas las tarifas mensuales"
                        >
                            <DollarSign className="h-4 w-4" /> Inscripción y seguro
                        </Button>
                    )}
                    <Button onClick={() => { resetOfferingForm(); setShowCreate(true); }} size="sm" className="gap-1.5 shadow-sm">
                        <Plus className="h-4 w-4" /> Nuevo Plan
                    </Button>
                </div>
            </div>

            {/* Empty state */}
            {offerings.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-16">
                        <div className="rounded-full bg-muted/60 p-4 mb-4">
                            <Package className="h-10 w-10 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium mb-1">Sin planes configurados</p>
                        <p className="text-xs text-muted-foreground mb-5">Crea tu primer plan o membresía para comenzar</p>
                        <Button onClick={() => { resetOfferingForm(); setShowCreate(true); }} size="sm" className="gap-1.5">
                            <Plus className="h-3.5 w-3.5" /> Crear primer plan
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={busquedaPlanes}
                            onChange={(e) => setBusquedaPlanes(e.target.value)}
                            placeholder="Buscar plan o tarifa..."
                            className="pl-9 pr-9"
                        />
                        {busquedaPlanes && (
                            <button
                                type="button"
                                onClick={() => setBusquedaPlanes('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                aria-label="Limpiar búsqueda"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    {offeringsVisibles.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-6">No hay planes ni tarifas con «{busquedaPlanes}».</p>
                    )}
                    {offeringsVisibles.map((offering) => (
                        <OfferingCard
                            key={offering.id}
                            offering={offering}
                            onEditOffering={() => handleEditOffering(offering)}
                            onAddPlan={() => { resetPlanForm(); setShowCreatePlan(offering.id); }}
                            onEditPlan={(planId) => handleEditPlan(offering.id, planId)}
                            onEnroll={handleOpenEnroll}
                            onDeleteOffering={() => setOfferingToDelete(offering.id)}
                            onDeletePlan={(planId) => setPlanToDelete({ offeringId: offering.id, planId })}
                            onCopyJoinLink={(planId, planName) => {
                                const link = `${window.location.origin}/join-plan/${planId}`;
                                const waText = encodeURIComponent(`Accede al plan ${planName} en SportMaps: ${link}`);
                                toast({
                                    title: `🔗 Invitar al plan ${planName}`,
                                    description: (
                                        <div className="flex gap-2 mt-2 flex-wrap">
                                            <a
                                                href={`https://wa.me/?text=${waText}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-[#25D366] text-white hover:bg-[#1ebe59] transition-colors"
                                            >
                                                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" xmlns="http://www.w3.org/2000/svg"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                                                WhatsApp
                                            </a>
                                            <button
                                                onClick={() => navigator.clipboard.writeText(link)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-background hover:bg-muted transition-colors"
                                            >
                                                <Copy className="h-3.5 w-3.5" />
                                                Copiar
                                            </button>
                                        </div>
                                    ) as any,
                                });
                            }}
                        />
                    ))}
                </div>
            )}

            {/* ══════ Create / Edit Offering Modal ══════ */}
            <Dialog open={showCreate} onOpenChange={(o) => { if (!o) { setShowCreate(false); resetOfferingForm(); } }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-bold">
                            {editingOfferingId ? '✏️ Editar Plan' : '✨ Nuevo Plan'}
                        </DialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {editingOfferingId ? 'Modifica los detalles de este plan.' : 'Crea un plan o membresía para ofrecer a tus deportistas.'}
                        </p>
                    </DialogHeader>

                    <div className="space-y-5 py-2 max-h-[70vh] overflow-y-auto pr-1">
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">Nombre del Plan</Label>
                            <Input
                                placeholder="Ej: Membresía Elite, Pack 10 Clases"
                                value={newOffering.name}
                                onChange={(e) => setNewOffering((prev) => ({ ...prev, name: e.target.value }))}
                            />
                            {bloquearNombreDePlan(newOffering.name, editingOfferingId ? offeringOriginalName : null) && (
                                <p className="text-[11px] text-destructive leading-snug">{PAGO_UNICO_NO_ES_PLAN_MSG}</p>
                            )}
                        </div>

                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Tipo de Oferta</Label>
                                <Select
                                    value={newOffering.offering_type}
                                    onValueChange={(v: any) => setNewOffering((prev) => ({ ...prev, offering_type: v }))}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder="Seleccionar tipo" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(OFFERING_TYPE_LABELS).map(([val, label]) => (
                                            <SelectItem key={val} value={val}>{label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Deporte</Label>
                                <SportSearchCombobox
                                    values={newOffering.sport ? [newOffering.sport] : []}
                                    onChange={(sports) => setNewOffering((prev) => ({ ...prev, sport: sports[0] || '' }))}
                                />
                            </div>
                        </div>

                        {/* Modo de agendamiento — instalación / entrenador / ambas — piloto */}
                        {bookingModeToggleEnabled && (
                        <div className="space-y-2">
                            <Label className="text-sm font-medium">¿Cómo se agenda este plan?</Label>
                            <div className="flex gap-1 p-0.5 bg-muted/60 rounded-lg border border-border/30">
                                {BOOKING_MODE_OPTIONS.map((opt) => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => setNewOffering((prev) => ({ ...prev, booking_mode: opt.value }))}
                                        className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                            newOffering.booking_mode === opt.value
                                                ? 'bg-background text-foreground shadow-sm border border-border/40'
                                                : 'text-muted-foreground hover:text-foreground'
                                        }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                                {BOOKING_MODE_OPTIONS.find((o) => o.value === newOffering.booking_mode)?.description}
                            </p>

                            {newOffering.booking_mode !== 'coach' && (
                                <div className="pt-1 animate-in fade-in slide-in-from-top-1 duration-200 space-y-1.5">
                                    <Label className="text-sm font-medium">
                                        Instalación <span className="text-destructive">*</span>
                                    </Label>
                                    <Select
                                        value={newOffering.facility_id}
                                        onValueChange={(v) => setNewOffering((prev) => ({ ...prev, facility_id: v }))}
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder="Seleccionar instalación..." />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {facilities.length === 0 ? (
                                                <div className="px-3 py-2 text-[11px] text-muted-foreground">
                                                    No hay instalaciones registradas.
                                                </div>
                                            ) : (
                                                facilities.map((f: any) => (
                                                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                                                ))
                                            )}
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                        </div>
                        )}

                        <div className="space-y-2">
                            <Label className="text-sm font-medium flex items-center justify-between">
                                Descripción (Opcional)
                                <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Atractivo para el cliente</span>
                            </Label>
                            <Textarea
                                placeholder="Describe qué beneficios incluye esta membresía o paquete..."
                                value={newOffering.description}
                                onChange={(e) => setNewOffering((prev) => ({ ...prev, description: e.target.value }))}
                                rows={3}
                            />
                        </div>

                        {editingOfferingId && (
                            <div className="pt-2 border-t border-border/40">
                                <OfferingCoachesPanel offeringId={editingOfferingId} />
                            </div>
                        )}
                    </div>

                    <DialogFooter className="gap-2 sm:gap-0 pt-2">
                        <Button variant="outline" onClick={() => { setShowCreate(false); resetOfferingForm(); }} size="sm">Cancelar</Button>
                        <Button
                            onClick={handleSaveOffering}
                            disabled={!newOffering.name || isSavingOffering || (newOffering.booking_mode !== 'coach' && !newOffering.facility_id)}
                            size="sm"
                            className="gap-1.5"
                        >
                            {isSavingOffering
                                ? (editingOfferingId ? 'Actualizando...' : 'Creando...')
                                : (editingOfferingId ? '💾 Guardar Cambios' : '🚀 Crear Plan')
                            }
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ══════ Create / Edit Plan (Tarifa) Modal ══════ */}
            <Dialog open={!!showCreatePlan} onOpenChange={(o) => { if (!o) { setShowCreatePlan(null); resetPlanForm(); } }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-xl font-bold">
                            {editingPlanId ? '✏️ Editar Tarifa' : '💰 Nueva Tarifa'}
                        </DialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {editingPlanId ? 'Modifica los detalles de esta tarifa.' : 'Agrega una tarifa o nivel de precios.'}
                        </p>
                    </DialogHeader>

                    <div className="space-y-5 py-2 max-h-[70vh] overflow-y-auto pr-1">
                        <div className="space-y-2">
                            <Label htmlFor="plan-name" className="text-sm font-medium">
                                Nombre de la tarifa <span className="text-destructive">*</span>
                            </Label>
                            <Input id="plan-name" placeholder="Ej: Básico, Premium, 2 veces/semana" value={newPlan.name} onChange={(e) => setNewPlan((prev) => ({ ...prev, name: e.target.value }))} className="h-9" />
                            {bloquearNombreDePlan(newPlan.name, editingPlanId ? planOriginalName : null) && (
                                <p className="text-[11px] text-destructive leading-snug">
                                    {PAGO_UNICO_NO_ES_PLAN_MSG}{' '}
                                    <button type="button" onClick={enfocarPagosUnicos} className="underline font-medium">
                                        Ir a Inscripción y Seguro
                                    </button>
                                </p>
                            )}

                            {/* Suggested Categories logic */}
                            {(() => {
                                const parentOffering = offerings.find(o => o.id === (showCreatePlan || editingPlanId));
                                const sportName = parentOffering?.sport;
                                if (!sportName) return null;
                                
                                // Era `SPORTS_CATALOG`, una constante cuyo import se quitó al pasar
                                // el catálogo a la base: quedó un nombre inexistente, y este bloque
                                // reventaba al abrir el formulario de plan de una oferta con deporte.
                                const sport = catalogoDeportes.find((s: any) => s.nombre.toLowerCase() === sportName.toLowerCase());
                                if (!sport || !sport.categoriasCompetencia) return null;
                                
                                const cats: string[] = [];
                                if (sport.categoriasCompetencia) {
                                  Object.values(sport.categoriasCompetencia).forEach((val: any) => {
                                      if (Array.isArray(val)) cats.push(...val);
                                  });
                                }
                                const uniqueCats = Array.from(new Set(cats)).slice(0, 12);
                                
                                if (uniqueCats.length === 0) return null;

                                return (
                                    <div className="pt-1.5">
                                        <p className="text-[10px] text-muted-foreground mb-1.5 uppercase font-bold tracking-tight">Sugerencias {sport.nombre}:</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {uniqueCats.map(cat => (
                                                <button
                                                    key={cat}
                                                    type="button"
                                                    onClick={() => setNewPlan(prev => ({ ...prev, name: cat }))}
                                                    className="px-2 py-0.5 text-[10px] rounded-full border border-border bg-muted/50 hover:bg-primary/10 hover:border-primary/30 transition-all text-muted-foreground hover:text-foreground"
                                                >
                                                    {cat}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Precio (mensualidad) */}
                        <div className="space-y-2">
                            <Label className="text-sm font-medium flex items-center gap-1.5">
                                <DollarSign className="h-3.5 w-3.5 text-green-500" /> Precio <span className="text-destructive">*</span>
                            </Label>
                            <NumberStepper
                                id="plan-price"
                                value={newPlan.price}
                                onChange={(v) => setNewPlan((prev) => ({ ...prev, price: v }))}
                                placeholder="0"
                                prefix="$"
                                step={5000}
                                isCurrency={true}
                            />
                        </div>

                        {/* Pagos únicos al inscribirse: NO son planes aparte (regla de producto). */}
                        <div ref={pagosUnicosRef} id="pagos-unicos" className="space-y-3 rounded-lg border border-orange-200/60 bg-orange-50/30 dark:bg-orange-500/5 p-3">
                            <div className="space-y-0.5">
                                <p className="text-sm font-semibold">Pagos únicos al inscribirse</p>
                                <p className="text-[11px] text-muted-foreground leading-snug">{PAGOS_UNICOS_AYUDA}</p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-1.5">
                                    <Label htmlFor="plan-registration-fee" className="text-sm font-medium flex items-center gap-1.5">
                                        <DollarSign className="h-3.5 w-3.5 text-orange-500" /> Inscripción
                                    </Label>
                                    <NumberStepper
                                        id="plan-registration-fee"
                                        value={newPlan.registration_fee}
                                        onChange={(v) => setNewPlan((prev) => ({ ...prev, registration_fee: v }))}
                                        placeholder="Sin cobro"
                                        prefix="$"
                                        step={5000}
                                        isCurrency={true}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="plan-insurance-fee" className="text-sm font-medium flex items-center gap-1.5">
                                        <DollarSign className="h-3.5 w-3.5 text-sky-500" /> Seguro
                                    </Label>
                                    <NumberStepper
                                        id="plan-insurance-fee"
                                        value={newPlan.insurance_fee}
                                        onChange={(v) => setNewPlan((prev) => ({ ...prev, insurance_fee: v }))}
                                        placeholder="Sin cobro"
                                        prefix="$"
                                        step={5000}
                                        isCurrency={true}
                                    />
                                </div>
                            </div>
                            {(newPlan.registration_fee || newPlan.insurance_fee) && (
                                <button
                                    type="button"
                                    onClick={() => setNewPlan((prev) => ({ ...prev, registration_fee: '', insurance_fee: '' }))}
                                    className="text-[11px] text-muted-foreground underline hover:text-foreground"
                                >
                                    Quitar los dos (no cobrar inscripción ni seguro)
                                </button>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label className="text-sm font-medium flex items-center gap-1.5">
                                <Clock className="h-3.5 w-3.5 text-blue-500" /> Duración
                            </Label>
                            <Select
                                    value={newPlan.duration_days}
                                    onValueChange={(v) => {
                                        setNewPlan((prev) => ({ ...prev, duration_days: v }));
                                        setIsCustomDays(v === 'custom');
                                    }}
                                >
                                    <SelectTrigger className="h-9">
                                        <SelectValue placeholder="Seleccionar duración" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {PLAN_DURATION_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                        </div>

                        {isCustomDays && (
                            <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                                <Label className="text-sm font-medium flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5 text-blue-500" /> Días de duración <span className="text-destructive">*</span>
                                </Label>
                                <div className="flex items-center gap-2">
                                    <NumberStepper
                                        id="custom-duration-days"
                                        value={customDays}
                                        onChange={(v) => setCustomDays(v)}
                                        placeholder="30"
                                        min={1}
                                        step={1}
                                    />
                                    <span className="text-sm text-muted-foreground font-medium">días</span>
                                </div>
                            </div>
                        )}

                        {/* Banco de horas — mutuamente excluyente con "máx. sesiones" */}
                        <div className="flex items-center justify-between rounded-lg border p-3">
                            <div className="space-y-0.5">
                                <Label className="text-sm font-medium flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5 text-primary" /> Plan por horas (banco de horas)
                                </Label>
                                <p className="text-[10px] text-muted-foreground">
                                    En vez de contar clases, cuenta minutos que el atleta consume libremente vía torniquete.
                                </p>
                            </div>
                            <Switch
                                checked={newPlan.is_hours_plan}
                                onCheckedChange={(checked) => setNewPlan((prev) => ({ ...prev, is_hours_plan: checked }))}
                            />
                        </div>

                        {newPlan.is_hours_plan && (
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Minutos incluidos por período</Label>
                                <NumberStepper
                                    id="plan-hours-minutes"
                                    value={newPlan.included_minutes_per_period}
                                    onChange={(v) => setNewPlan((prev) => ({ ...prev, included_minutes_per_period: v }))}
                                    placeholder="480"
                                    step={30}
                                    // "unit" es un <span> decorativo dentro del input (no se
                                    // mezcla con el parser de digitos de handleChange), a
                                    // diferencia de formatValue que SI reescribe el texto
                                    // editable -- por eso este es el prop correcto para mostrar
                                    // las horas al lado sin romper la edicion en minutos. Sin
                                    // parentesis: el badge es mayuscula compacta (ver "kg"/"min"
                                    // en otros usos de NumberStepper), "(16h)" quedaba largo.
                                    unit={
                                        newPlan.included_minutes_per_period !== ''
                                            ? `${(parseInt(newPlan.included_minutes_per_period) / 60).toFixed(parseInt(newPlan.included_minutes_per_period) % 60 === 0 ? 0 : 1)}h`
                                            : undefined
                                    }
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    Ej: 480 min = 8 horas al mes. El período lo define el ciclo de facturación de la escuela.
                                </p>
                            </div>
                        )}

                        {/* Niveles por horas (D1/D2): bloque de sesión propio del plan + días/semana
                            informativo — para vender "3 días × 2h" sin depender del valor global de la
                            escuela. Vacío = NULL = hereda school_settings.hours_session_block_minutes. */}
                        {newPlan.is_hours_plan && (
                            <div className="grid grid-cols-2 gap-3">
                                <div className="space-y-2">
                                    <Label className="text-sm font-medium">Minutos por sesión (bloque)</Label>
                                    <NumberStepper
                                        id="plan-session-block-minutes"
                                        value={newPlan.session_block_minutes}
                                        onChange={(v) => setNewPlan((prev) => ({ ...prev, session_block_minutes: v }))}
                                        placeholder="Hereda de la escuela"
                                        step={15}
                                        unit={
                                            newPlan.session_block_minutes !== ''
                                                ? `${(parseInt(newPlan.session_block_minutes) / 60).toFixed(parseInt(newPlan.session_block_minutes) % 60 === 0 ? 0 : 1)}h`
                                                : undefined
                                        }
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        Vacío = usa el bloque general de la escuela. Para tener 2h/3h/4h a la vez, cada nivel necesita su propio valor.
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-sm font-medium">Días de entrenamiento/semana</Label>
                                    <NumberStepper
                                        id="plan-sessions-per-week"
                                        value={newPlan.included_sessions_per_week}
                                        onChange={(v) => setNewPlan((prev) => ({ ...prev, included_sessions_per_week: v }))}
                                        placeholder="Ej: 3"
                                        step={1}
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        Solo informativo — la fuente de verdad de horas sigue siendo los minutos incluidos.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Sessions row */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label className="text-sm font-medium flex items-center gap-1.5">
                                    <Zap className="h-3.5 w-3.5 text-amber-500" /> Máx. sesiones
                                </Label>
                                <NumberStepper
                                    id="plan-sessions"
                                    value={newPlan.max_sessions}
                                    onChange={(v) => setNewPlan((prev) => ({ ...prev, max_sessions: v }))}
                                    placeholder="∞"
                                    step={1}
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    {newPlan.is_hours_plan
                                        ? 'Con banco de horas activo, esto es solo una etiqueta ("480 min ≈ 4 clases de 2h") — no bloquea nada, el único tope real son los minutos.'
                                        : 'Vacío o 0 = ilimitado'}
                                </p>
                            </div>
                            <div className="space-y-2">
                                <Label className="text-sm font-medium">Nombre de clase secundaria</Label>
                                <Input
                                    placeholder="Ej: Cortesía, Bono, etc."
                                    value={newPlan.secondary_session_label}
                                    onChange={(e) => setNewPlan((prev) => ({ ...prev, secondary_session_label: e.target.value }))}
                                    className="h-9"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-sm font-medium">Sesiones secundarias</Label>
                            <NumberStepper
                                id="plan-secondary"
                                value={newPlan.max_secondary_sessions}
                                onChange={(v) => setNewPlan((prev) => ({ ...prev, max_secondary_sessions: v }))}
                                placeholder="0"
                                step={1}
                            />
                        </div>

                        {/* ── Horario de Clases ─────────────────────────────────────────────── */}
                        <div className="space-y-3 rounded-lg border border-border/50 p-4">
                            <div className="flex items-center justify-between">
                                <Label className="text-sm font-medium flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5 text-blue-500" /> Horario de Clases
                                </Label>
                                {/* Toggle General | Específico */}
                                <div className="flex gap-1 p-0.5 bg-muted/60 rounded-lg border border-border/30">
                                    {(['general', 'specific'] as const).map((type) => (
                                        <button
                                            key={type}
                                            type="button"
                                            onClick={() => setNewPlan(prev => ({ ...prev, schedule_type: type, schedule: [] }))}
                                            className={`px-3 py-1 rounded-md text-[11px] font-bold transition-all ${
                                                newPlan.schedule_type === type
                                                    ? 'bg-background text-foreground shadow-sm border border-border/40'
                                                    : 'text-muted-foreground hover:text-foreground'
                                                }`}
                                        >
                                            {type === 'general' ? 'General' : 'Específico'}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {newPlan.schedule_type === 'general' ? (
                                <p className="text-[11px] text-muted-foreground bg-muted/30 rounded-lg px-3 py-2 border border-border/30">
                                    Los atletas pueden agendar en cualquier sesión disponible del programa.
                                </p>
                            ) : (
                                <SchedulePicker
                                    value={newPlan.schedule}
                                    onChange={(slots) => setNewPlan(prev => ({ ...prev, schedule: slots }))}
                                />
                            )}
                        </div>

                        {/* ── Ascenso y días (F-F) ─────────────────────────────────────────── */}
                        <PlanLevelRulesSection
                            value={levelRules}
                            onChange={setLevelRules}
                            progressionEnabled={levelProgressionEnabled}
                        />
                    </div>

                    <DialogFooter className="gap-2 sm:gap-0 pt-2">
                        <Button variant="outline" onClick={() => { setShowCreatePlan(null); resetPlanForm(); }} size="sm">Cancelar</Button>
                        <Button
                            onClick={() => showCreatePlan && handleSavePlan(showCreatePlan)}
                            disabled={!newPlan.name || !newPlan.price || isSavingPlan}
                            size="sm"
                            className="gap-1.5"
                        >
                            {isSavingPlan
                                ? (editingPlanId ? 'Actualizando...' : 'Creando...')
                                : (editingPlanId ? '💾 Guardar Cambios' : '🚀 Crear Tarifa')
                            }
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Modal de Inscripción */}
            <EnrollPlanStudentModal
                open={enrollModal.open}
                onClose={() => setEnrollModal({ open: false, offering: null, plan: null })}
                onSuccess={() => {
                    queryClient.invalidateQueries({ queryKey: ['offerings', schoolId] });
                }}
                schoolId={schoolId || ''}
                plan={enrollModal.plan}
                offeringName={enrollModal.offering?.name || ''}
            />

            {enrollPlanId && (
                <EnrollPlanStudentModal
                    open={!!enrollPlanId}
                    plan={offerings.flatMap(o => o.offering_plans ?? []).find(p => p.id === enrollPlanId)}
                    onClose={() => setEnrollPlanId(null)}
                    onSuccess={() => {
                        queryClient.invalidateQueries({ queryKey: ['offerings', schoolId] });
                    }}
                    schoolId={schoolId || ''}
                    offeringName={offerings.find(o => o.offering_plans?.some(p => p.id === enrollPlanId))?.name || ''}
                />
            )}

            {/* -- Aviso: la inscripción y el seguro no son planes -- */}
            <AlertDialog open={!!nombreBloqueado} onOpenChange={(o) => !o && setNombreBloqueado(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>No se puede guardar con ese nombre</AlertDialogTitle>
                        <AlertDialogDescription>{PAGO_UNICO_NO_ES_PLAN_MSG}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cambiar el nombre</AlertDialogCancel>
                        <AlertDialogAction onClick={irAPagosUnicos}>
                            {nombreBloqueado === 'tarifa' ? 'Ir a Inscripción y Seguro' : 'Configurar inscripción y seguro'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* -- Aplicar Inscripción / Seguro a todas las tarifas mensuales -- */}
            <Dialog open={showAplicarTodos} onOpenChange={(o) => { if (!o) setShowAplicarTodos(false); }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-bold">Pagos únicos al inscribirse</DialogTitle>
                        <p className="text-sm text-muted-foreground">{PAGOS_UNICOS_AYUDA}</p>
                    </DialogHeader>
                    <div className="space-y-4 py-1 max-h-[65vh] overflow-y-auto pr-1">
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="bulk-registration-fee" className="text-sm font-medium">Inscripción</Label>
                                <NumberStepper
                                    id="bulk-registration-fee"
                                    value={bulkFees.registration_fee}
                                    onChange={(v) => setBulkFees((prev) => ({ ...prev, registration_fee: v }))}
                                    placeholder="Sin cobro"
                                    prefix="$"
                                    step={5000}
                                    isCurrency={true}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="bulk-insurance-fee" className="text-sm font-medium">Seguro</Label>
                                <NumberStepper
                                    id="bulk-insurance-fee"
                                    value={bulkFees.insurance_fee}
                                    onChange={(v) => setBulkFees((prev) => ({ ...prev, insurance_fee: v }))}
                                    placeholder="Sin cobro"
                                    prefix="$"
                                    step={5000}
                                    isCurrency={true}
                                />
                            </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            Se reemplazan los valores de las tarifas marcadas. Un campo vacío quita ese cobro en esas tarifas.
                            Solo afecta a los atletas que se inscriban de aquí en adelante.
                        </p>
                        <div className="space-y-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Tarifas mensuales activas ({bulkPlanIds.length}/{tarifasMensuales.length})
                            </p>
                            <div className="rounded-lg border border-border/50 divide-y divide-border/30">
                                {tarifasMensuales.map(({ plan, offeringName }) => {
                                    const checked = bulkPlanIds.includes(plan.id);
                                    const actual = resumenPagosUnicos(plan);
                                    return (
                                        <label key={plan.id} className="flex items-start gap-2.5 px-3 py-2 text-xs cursor-pointer hover:bg-muted/30">
                                            <Checkbox
                                                checked={checked}
                                                onCheckedChange={(c) => setBulkPlanIds((prev) =>
                                                    c ? [...prev, plan.id] : prev.filter((id) => id !== plan.id))}
                                                className="mt-0.5"
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="font-medium break-words">{offeringName} · {plan.name}</span>
                                                <span className="block text-[10px] text-muted-foreground">
                                                    {actual || 'Hoy sin inscripción ni seguro'}
                                                </span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0 pt-2">
                        <Button variant="outline" size="sm" onClick={() => setShowAplicarTodos(false)}>Cancelar</Button>
                        <Button
                            size="sm"
                            onClick={handleAplicarTodos}
                            disabled={bulkPlanIds.length === 0 || applyOneTimeFees.isPending}
                        >
                            {applyOneTimeFees.isPending
                                ? 'Aplicando...'
                                : `Aplicar a ${bulkPlanIds.length} tarifa${bulkPlanIds.length === 1 ? '' : 's'}`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* -- Deletion Confirmation Dialogs -- */}
            <AlertDialog open={!!planToDelete} onOpenChange={(o) => !o && setPlanToDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>¿Eliminar tarifa?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Esta acción eliminará la tarifa permanentemente. 
                            Solo posible si no hay inscripciones activas.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDeletePlan}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={isDeletingPlan}
                        >
                            {isDeletingPlan ? 'Eliminando...' : 'Eliminar Tarifa'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={!!offeringToDelete} onOpenChange={(o) => !o && setOfferingToDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>¿Eliminar plan completo?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Se eliminará el plan y todas sus tarifas. 
                            Solo posible si no hay deportistas inscritos.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDeleteOffering}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={isDeletingOffering}
                        >
                            {isDeletingOffering ? 'Eliminando...' : 'Eliminar Plan'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {trialPublicUrl && (
                <ShareTrialLinkDialog
                    open={shareOpen}
                    onOpenChange={setShareOpen}
                    publicUrl={trialPublicUrl}
                    schoolName={schoolName}
                />
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════
// Offering Card — Diseño mejorado
// ═══════════════════════════════════════════════════════════════════

function OfferingCard({
    offering,
    onEditOffering,
    onAddPlan,
    onEditPlan,
    onEnroll,
    onDeleteOffering,
    onDeletePlan,
    onCopyJoinLink,
}: {
    offering: Offering;
    onEditOffering: () => void;
    onAddPlan: () => void;
    onEditPlan?: (planId: string) => void;
    onEnroll?: (offering: Offering, plan: any) => void;
    onDeleteOffering?: () => void;
    onDeletePlan?: (planId: string) => void;
    onCopyJoinLink?: (planId: string, planName: string) => void;
}) {
    const plans = offering.offering_plans ?? [];
    const sportVisual = offering.sport ? getSportVisual(offering.sport.toLowerCase()) : null;

    return (
        <Card className="overflow-hidden border-border/60 hover:border-border transition-colors">
            {/* Card Header */}
            <CardHeader className="pb-2 pt-4 px-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-primary/5 flex items-center justify-center shrink-0 border border-primary/10">
                            {sportVisual ? (
                                <span className="text-xl">{sportVisual.icon}</span>
                            ) : (
                                <Zap className="h-5 w-5 text-primary" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <CardTitle className="text-sm font-bold leading-tight break-words">{offering.name}</CardTitle>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                <Badge variant="secondary" className="text-[10px] h-4.5 px-1.5 py-0 bg-primary/5 text-primary border-primary/10 font-medium">
                                    {OFFERING_TYPE_LABELS[offering.offering_type] ?? offering.offering_type}
                                </Badge>
                                {offering.sport && (
                                    <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 py-0 font-normal border-border/50 whitespace-normal break-words">
                                        {offering.sport}
                                    </Badge>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {onDeleteOffering && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteOffering();
                                }}
                                className="h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive rounded-md"
                                title="Eliminar plan"
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onEditOffering}
                            className="h-8 w-8 p-0 hover:bg-primary/10 hover:text-primary rounded-md"
                            title="Editar configuración"
                        >
                            <Edit className="h-4 w-4" />
                        </Button>
                        <Badge
                            variant={offering.is_active ? 'default' : 'secondary'}
                            className={`text-[9px] h-5 uppercase tracking-wider font-bold ${offering.is_active ? 'bg-green-600/90' : ''}`}
                        >
                            {offering.is_active ? 'Activo' : 'Inactivo'}
                        </Badge>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="px-4 pb-3 space-y-3">
                {offering.description && (
                    <p className="text-xs text-muted-foreground leading-relaxed">{offering.description}</p>
                )}

                {/* Tarifas list */}
                {plans.length > 0 && (
                    <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Tarifas ({plans.length})
                        </p>
                        <div className="rounded-lg border border-border/50 divide-y divide-border/30 overflow-hidden">
                            {plans.map((plan) => (
                                <div key={plan.id} className="flex items-center justify-between text-xs px-3 py-3 hover:bg-muted/30 transition-colors gap-2 group/row">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <div className="font-semibold text-xs text-foreground/90">{plan.name}</div>
                                            {plan.current_students > 0 && (
                                                <Badge
                                                    variant="secondary"
                                                    className="text-[9px] h-4 px-1 py-0 bg-green-50 text-green-700 border-green-200"
                                                >
                                                    {plan.current_students} {plan.current_students === 1 ? 'inscrito' : 'inscritos'}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 flex-wrap text-muted-foreground mt-0.5 font-medium">
                                            <span className="flex items-center gap-0.5">
                                                {plan.included_minutes_per_period ? (
                                                    <>
                                                        <Clock className="h-3 w-3 text-primary" />
                                                        {Math.floor(plan.included_minutes_per_period / 60)}h banco
                                                    </>
                                                ) : (
                                                    <>
                                                        <Zap className="h-3 w-3 text-amber-500" />
                                                        {plan.max_sessions ? `${plan.max_sessions} ses.` : '∞ ses.'}
                                                    </>
                                                )}
                                            </span>
                                            {plan.max_secondary_sessions > 0 && (
                                                <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 bg-blue-50 text-blue-700 border-blue-200">
                                                    +{plan.max_secondary_sessions} {(plan.metadata?.secondary_session_label as string) || 'Sec.'}
                                                </Badge>
                                            )}
                                            <span className="text-foreground/80 flex items-center gap-0.5">
                                                <Clock className="h-3 w-3" />
                                                {formatFriendlyDuration(plan.duration_days)}
                                            </span>
                                            {/* Niveles por horas (D1/D2) — bloque de sesión propio × días/semana,
                                                para diferenciar 2h/3h/4h a la vez en la misma escuela. */}
                                            {plan.session_block_minutes && (
                                                <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 bg-purple-50 text-purple-700 border-purple-200">
                                                    {(plan.session_block_minutes / 60).toFixed(plan.session_block_minutes % 60 === 0 ? 0 : 1)}h/clase
                                                </Badge>
                                            )}
                                            {plan.included_sessions_per_week && (
                                                <Badge variant="secondary" className="text-[9px] h-4 px-1 py-0 bg-purple-50 text-purple-700 border-purple-200">
                                                    {plan.included_sessions_per_week} días/sem
                                                </Badge>
                                            )}
                                            <span className="font-bold text-primary ml-1">
                                                ${formatCurrency(plan.price)}
                                            </span>
                                        </div>
                                        {/* Pagos únicos al inscribirse (inscripción + seguro), aparte de la mensualidad. */}
                                        {resumenPagosUnicos(plan) && (
                                            <div
                                                className="mt-1 text-[10px] font-medium text-orange-700 dark:text-orange-300"
                                                title="Se cobran una sola vez al inscribir al atleta. El seguro, máximo una vez cada 12 meses."
                                            >
                                                {resumenPagosUnicos(plan)}
                                            </div>
                                        )}

                                    </div>
                                    <div className="flex items-center gap-1">
                                        {onEnroll && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => onEnroll(offering, plan)}
                                                className="shrink-0 h-8 px-2 hover:bg-green-50 hover:text-green-600 border border-transparent hover:border-green-100 transition-all gap-1.5"
                                                title="Inscribir deportista"
                                            >
                                                <UserPlus className="h-3.5 w-3.5" />
                                                <span className="hidden sm:inline text-[10px]">Inscribir</span>
                                            </Button>
                                        )}
                                        {onCopyJoinLink && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => onCopyJoinLink(plan.id, plan.name)}
                                                className="shrink-0 h-8 px-2 hover:bg-blue-50 hover:text-blue-600 border border-transparent hover:border-blue-100 transition-all gap-1.5"
                                                title="Copiar link de invitacion al plan"
                                            >
                                                <Copy className="h-3.5 w-3.5" />
                                                <span className="hidden sm:inline text-[10px]">Invitar</span>
                                            </Button>
                                        )}
                                        {onEditPlan && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => onEditPlan(plan.id)}
                                                className="shrink-0 h-8 w-8 p-0 hover:bg-primary/5 hover:text-primary"
                                                title="Editar tarifa"
                                            >
                                                <Edit className="h-3.5 w-3.5" />
                                            </Button>
                                        )}
                                        {onDeletePlan && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => onDeletePlan(plan.id)}
                                                className="shrink-0 h-8 w-8 p-0 hover:bg-destructive/10 hover:text-destructive"
                                                title="Eliminar tarifa"
                                            >
                                                <Trash2 className="h-3 w-3" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Add tarifa button */}
                <Button variant="outline" size="sm" onClick={onAddPlan} className="w-full h-8 text-xs gap-1.5 border-dashed hover:border-solid hover:border-primary/40 hover:text-primary transition-all">
                    <Plus className="h-3 w-3" /> Agregar Tarifa
                </Button>
            </CardContent>
        </Card>
    );
}