import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Sparkles, ArrowRight, ArrowLeft, Loader2, Mail, User,
  CheckCircle2, AlertCircle, Baby, Building2, Calendar, Lock, Zap,
  ChevronLeft, ChevronRight, Clock, XCircle,
} from 'lucide-react';
import { startOfMonth, endOfMonth, eachDayOfInterval, isBefore, isToday, startOfDay, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import {
  useAvailableSessions, useBookSession, type BookableSession, collapseOverlappingBlocks,
  useMyBookings, useCancelBooking, type MyBooking, type FlexibleHourGridGroup,
} from '@/hooks/useAthleteSessionBookings';
import { CompactSessionSlot } from '@/components/booking/CompactSessionSlot';
import { HourGridPicker } from '@/components/booking/HourGridPicker';
import { HourBankBalanceCard, type HourBankBalance } from '@/components/access/HourBankBalanceCard';

/**
 * Link público NUEVO y separado de /agendar/:slug (facilities + cortesía,
 * SEG-20) — este es para clases de prueba Y para que un usuario YA
 * REGISTRADO se autentique y agende su clase de plan, sin salir de esta
 * página (decisión de producto: "el mismo link resuelve los dos casos").
 * Ver docs/specs/mis-inscripciones-agenda-clases-prueba.md.
 *
 * Primero se identifica (correo) — recién ahí se decide el camino:
 * ya tiene cuenta → login inline + sus clases de plan (useAthleteSessionBookings,
 * el MISMO hook que usa Mis Inscripciones); si no, clases de prueba (OTP,
 * igual que ya estaba).
 */

const BFF_URL = import.meta.env.VITE_BFF_URL ?? '';

interface TrialCategory {
  id: string;
  name: string;
  description: string | null;
  price: number;
}

interface SchoolInfo {
  school: { id: string; name: string };
  trial_classes_available: boolean;
  trial_categories: TrialCategory[];
  // Ausente en un BFF viejo (despliegue en curso): se trata como encendido.
  trial_link_enabled?: boolean;
}

interface Slot {
  slot_date: string;
  slot_start_time: string;
  slot_end_time: string;
  facility_availability_id: string;
  coach_availability_id: string;
  facility_id: string;
  facility_name: string;
}

interface ChildOption {
  id: string;
  full_name: string;
}

interface NoAccountBooking {
  id: string;
  status: string;
  attendance_sessions: { id: string; session_date: string; start_time: string; end_time: string } | null;
}

type Step =
  | 'welcome' | 'identify' | 'new_details' | 'password' | 'plan_pick_child' | 'plan_sessions' | 'plan_success'
  | 'code' | 'enrolled_choice' | 'book_without_account' | 'category' | 'slots' | 'contact_details' | 'trial_success' | 'not_available' | 'link_disabled';

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BFF_URL}/api/v1/public/booking${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Error'), { body, status: res.status });
  return body;
}

function fmtTime(t: string) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function fmtDate(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'short' });
}

// Reintento del saldo de horas: nunca con link_disabled; resto, 1 reintento
// (igual que el default del QueryClient).
function retryHourBankBalance(failureCount: number, err: any): boolean {
  if (err?.body?.reason === 'link_disabled') return false;
  return failureCount < 1;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-left flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
      <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
      <p className="text-xs text-red-700 dark:text-red-300">{message}</p>
    </div>
  );
}

export default function PublicTrialClassBookingPage() {
  const { slug } = useParams<{ slug: string }>();

  const [loadingSchool, setLoadingSchool] = useState(true);
  const [schoolInfo, setSchoolInfo] = useState<SchoolInfo | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [step, setStepRaw] = useState<Step>('welcome');
  const [stepHistory, setStepHistory] = useState<Step[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<TrialCategory | null>(null);
  // Solo bienvenida/copy — no se manda al backend, no decide nada por sí sola
  // (mismo patrón que PublicFacilityBookingPage.tsx).
  const [returningHint, setReturningHint] = useState<'returning' | 'new' | null>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [bookingToken, setBookingToken] = useState<string | null>(null);
  const [resolvedKind, setResolvedKind] = useState<'new' | 'enrolled_unregistered' | null>(null);

  // "Agendar sin crear cuenta" (enrolled_unregistered que no quiere
  // registrarse) — reusa /available-for-enrollment y /book-for-enrollment,
  // el mismo motor de bloques/banco de horas que "Mis Inscripciones", solo
  // que resuelto por bookingToken en vez de sesión de Supabase.
  const [noAccountSessions, setNoAccountSessions] = useState<BookableSession[]>([]);
  const [noAccountFlexibleGrid, setNoAccountFlexibleGrid] = useState<FlexibleHourGridGroup[]>([]);
  const [loadingNoAccountSessions, setLoadingNoAccountSessions] = useState(false);
  const [noAccountDate, setNoAccountDate] = useState<string | null>(null);
  const [confirmingNoAccountSession, setConfirmingNoAccountSession] = useState<BookableSession | null>(null);
  const [bookingNoAccount, setBookingNoAccount] = useState(false);
  const [noAccountBooked, setNoAccountBooked] = useState<BookableSession | null>(null);
  // Dos ejes DISTINTOS, igual que "Mis Inscripciones" — no se mezclan:
  //  · Personal/Grupal: TIPO de clase (quién cabe en el cupo).
  //  · Por bloque/Personalizada: cuántas horas agendar, elegido ANTES de ver
  //    la lista (no solo dentro del diálogo de confirmación).
  const [noAccountBookingModeChoice, setNoAccountBookingModeChoice] = useState<'block' | 'custom' | null>(null);
  const [noAccountClassTypeFilter, setNoAccountClassTypeFilter] = useState<'all' | 'personal' | 'group'>('all');
  // Selector dentro del diálogo de confirmación — permite extender la
  // duración de un bloque puntual sin tener que cambiar el modo de arriba.
  const [noAccountBookingMode, setNoAccountBookingMode] = useState<'block' | 'custom'>('block');
  const [noAccountDurationMinutes, setNoAccountDurationMinutes] = useState<number | null>(null);

  // "Cancelar una clase" sin cuenta — mismo toggle Agendar/Cancelar que
  // "Mis Inscripciones" (planTopAction), reusando la MISMA regla de
  // cancelación del servidor (tope de horas, reembolso de banco/crédito,
  // reversión de bloques estirados) vía cancelSessionBooking.
  const [noAccountTopAction, setNoAccountTopAction] = useState<'book' | 'cancel'>('book');
  const [noAccountBookings, setNoAccountBookings] = useState<NoAccountBooking[]>([]);
  const [loadingNoAccountBookings, setLoadingNoAccountBookings] = useState(false);
  const [cancellingNoAccountBooking, setCancellingNoAccountBooking] = useState<NoAccountBooking | null>(null);
  const [cancellingNoAccountInFlight, setCancellingNoAccountInFlight] = useState(false);

  useEffect(() => {
    setNoAccountBookingMode('block');
    setNoAccountDurationMinutes(confirmingNoAccountSession?.default_minutes ?? null);
  }, [confirmingNoAccountSession]);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

  const [whatsapp, setWhatsapp] = useState('+57 ');
  const [isMinor, setIsMinor] = useState(false);
  const [childName, setChildName] = useState('');

  // ── Camino "ya tiene cuenta" — login inline + sus clases de PLAN ─────────
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [planChildren, setPlanChildren] = useState<ChildOption[]>([]);
  const [planChildId, setPlanChildId] = useState<string | undefined>(undefined);
  const [planIsAthleteSelf, setPlanIsAthleteSelf] = useState(false);
  const { data: planSessions, isLoading: loadingPlanSessions } = useAvailableSessions(
    step === 'plan_sessions' ? planChildId : undefined,
  );
  const { mutateAsync: bookPlanSession, isPending: bookingPlan } = useBookSession(planChildId);
  const [bookedPlanSession, setBookedPlanSession] = useState<BookableSession | null>(null);
  // Piloto "agendamiento flexible de banco de horas" — confirmación antes de
  // agendar (este paso agendaba directo al clic) con selector de sesión
  // personalizada, igual que en "Mis Inscripciones".
  const [confirmingPlanSession, setConfirmingPlanSession] = useState<BookableSession | null>(null);
  const [planDurationMinutes, setPlanDurationMinutes] = useState<number | null>(null);
  const [planBookingMode, setPlanBookingMode] = useState<'block' | 'custom'>('block');
  // Igual que en "Mis Inscripciones": Por bloque / Personalizada se
  // pregunta como paso previo, antes de mostrar el calendario — no queda
  // escondido dentro del diálogo de confirmación de cada horario.
  const [planBookingModeChoice, setPlanBookingModeChoice] = useState<'block' | 'custom' | null>(null);
  // Tercera opción del link, junto a "Por bloque" y "Personalizada": el
  // atleta también puede cancelar una clase ya agendada sin tener que ir a
  // "Mis Inscripciones" aparte.
  const [planTopAction, setPlanTopAction] = useState<'book' | 'cancel'>('book');
  const { data: planBookings, isLoading: loadingPlanBookings } = useMyBookings(planChildId);
  const { mutate: cancelPlanBooking, isPending: cancellingPlanBooking } = useCancelBooking(planChildId);
  const [cancellingBooking, setCancellingBooking] = useState<MyBooking | null>(null);
  useEffect(() => {
    setPlanDurationMinutes(confirmingPlanSession?.default_minutes ?? null);
    setPlanBookingMode(planBookingModeChoice ?? 'block');
  }, [confirmingPlanSession, planBookingModeChoice]);
  useEffect(() => {
    setPlanBookingModeChoice(null);
    setPlanTopAction('book');
  }, [planChildId]);
  // Calendario tipo mes (mismo patrón que "Mis Inscripciones" / PT booking)
  // para elegir día antes de ver los horarios de ese día.
  const [planCalendarDate, setPlanCalendarDate] = useState(new Date());
  const [selectedPlanDate, setSelectedPlanDate] = useState<string | null>(null);
  const [planClassTypeFilter, setPlanClassTypeFilter] = useState<'all' | 'personal' | 'group'>('all');

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Solo para el aviso link_disabled: ¿hay sesión de Supabase activa?
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    if (step !== 'link_disabled') return;
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
  }, [step]);
  // La ficha es de un menor: el backend no deja crear cuenta desde aquí
  // (409 minor_requires_guardian_invite). Se reinicia al cambiar el token o
  // al volver a los pasos de identificación.
  const [registerBlockedForMinor, setRegisterBlockedForMinor] = useState(false);
  useEffect(() => {
    setRegisterBlockedForMinor(false);
  }, [bookingToken]);
  useEffect(() => {
    if (step === 'welcome' || step === 'identify' || step === 'code') setRegisterBlockedForMinor(false);
  }, [step]);
  const [successInfo, setSuccessInfo] = useState<{ price: number; is_first: boolean } | null>(null);

  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        const data = await api(`/schools/${slug}`);
        setSchoolInfo(data);
        bffClient.setSchoolId(data.school.id);
        if (data.trial_link_enabled === false) setStepRaw('link_disabled');
      } catch {
        setNotFound(true);
      } finally {
        setLoadingSchool(false);
      }
    })();
  }, [slug]);

  const slotsByDate = useMemo(() => {
    const groups: Record<string, Slot[]> = {};
    for (const s of slots) {
      groups[s.slot_date] = groups[s.slot_date] ?? [];
      groups[s.slot_date].push(s);
    }
    return groups;
  }, [slots]);

  // Este link es de UNA escuela (schoolInfo.school.id, resuelto por :slug) —
  // useAvailableSessions trae TODAS las escuelas donde el atleta tiene
  // inscripción activa (igual que en "Mis Inscripciones", donde eso es
  // correcto). Sin este filtro, agendar desde el link de Academia Superior
  // mostraba coaches de OTRA escuela completamente distinta mezclados en la
  // misma lista — no era un tema de bloques, era de alcance.
  const planSessionsForThisSchool = useMemo(
    () => (planSessions?.sessions ?? []).filter((s) => s.school_id === schoolInfo?.school?.id),
    [planSessions, schoolInfo],
  );

  // Para mostrar "cuántas horas le quedan" (HourBankBalanceCard) — la
  // inscripción de banco de horas de esta escuela, si tiene una (default_minutes
  // solo viene poblado en sesiones de un plan de horas con el piloto flexible).
  const planHourBankEnrollmentId = useMemo(
    () => planSessionsForThisSchool.find((s) => s.default_minutes != null)?.enrollment_id ?? null,
    [planSessionsForThisSchool],
  );

  // Mismo criterio de alcance para "Cancelar una clase" — solo las de ESTA
  // escuela, activas y todavía no pasadas.
  const cancellablePlanBookings = useMemo(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    return (planBookings ?? [])
      .filter((b) => b.school_id === schoolInfo?.school?.id)
      .filter((b) => b.status === 'confirmed')
      .filter((b) => (b.attendance_sessions?.session_date ?? '') >= todayStr)
      .sort((a, b) => {
        const da = a.attendance_sessions?.session_date ?? '';
        const db = b.attendance_sessions?.session_date ?? '';
        if (da !== db) return da.localeCompare(db);
        return (a.attendance_sessions?.start_time ?? '').localeCompare(b.attendance_sessions?.start_time ?? '');
      });
  }, [planBookings, schoolInfo]);

  const planSessionsByDate = useMemo(() => {
    const groups: Record<string, BookableSession[]> = {};
    for (const s of planSessionsForThisSchool) {
      groups[s.session_date] = groups[s.session_date] ?? [];
      groups[s.session_date].push(s);
    }
    // "Por bloque" colapsa a inicios fijos sin solapar; "Personalizada" (o
    // sin elegir aún) muestra todas las horas de inicio — mismo criterio
    // que "Mis Inscripciones".
    if (planBookingModeChoice === 'block') {
      Object.keys(groups).forEach((date) => {
        groups[date] = collapseOverlappingBlocks(groups[date]).sort((a, b) => a.start_time.localeCompare(b.start_time));
      });
    }
    return groups;
  }, [planSessionsForThisSchool, planBookingModeChoice]);

  const availablePlanDates = useMemo(
    () => new Set(Object.keys(planSessionsByDate)),
    [planSessionsByDate],
  );

  // Mismo criterio que "Mis Inscripciones": agrupar por horario exacto para
  // que dos coaches con la misma disponibilidad no salgan como dos filas
  // idénticas — CompactSessionSlot deja elegir entre ellos.
  const groupedPlanSessionsForDay = useMemo(() => {
    const sessions = (selectedPlanDate ? (planSessionsByDate[selectedPlanDate] ?? []) : [])
      .filter((s) => {
        if (planClassTypeFilter === 'all') return true;
        if (planClassTypeFilter === 'personal') return s.available_for_personal_classes === true;
        if (planClassTypeFilter === 'group') return s.available_for_group_classes === true && s.max_capacity > 1;
        return true;
      });
    const groups: Record<string, BookableSession[]> = {};
    sessions.forEach((s) => {
      // Unificamos por hora Y tipo — Personal y Grupal ahora pueden compartir
      // el mismo horario (ambos se bundlean a 2h+ en el piloto flexible), así
      // que agrupar solo por hora los mezclaba en una sola tarjeta.
      const key = `${s.start_time}-${s.end_time}-${s.available_for_personal_classes ? 'p' : 'g'}`;
      groups[key] = groups[key] ?? [];
      groups[key].push(s);
    });
    return Object.values(groups).sort((a, b) => a[0].start_time.localeCompare(b[0].start_time));
  }, [planSessionsByDate, selectedPlanDate, planClassTypeFilter]);

  // "Personalizada" no elige entre bloques ya armados — arma su propio
  // bloque tocando horas sueltas, con la grilla atómica real del coach.
  const flexiblePlanHourGridForDay = useMemo(() => {
    if (!selectedPlanDate) return [];
    return (planSessions?.flexible_hour_grid ?? [])
      .filter((g) => g.session_date === selectedPlanDate && g.school_id === schoolInfo?.school?.id);
  }, [planSessions, selectedPlanDate, schoolInfo]);

  // ── Navegación: pila de pasos, para poder "Volver" en cualquier punto ───
  const goTo = (next: Step) => {
    setStepHistory((h) => [...h, step]);
    setErrorMsg(null);
    setStepRaw(next);
  };

  const goBack = () => {
    setStepHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setErrorMsg(null);
      // Limpiar campos que quedarían "adelante" y podrían quedar obsoletos.
      if (prev === 'identify' || prev === 'new_details') {
        setPassword('');
        setCode('');
      }
      if (prev === 'category' || prev === 'code') {
        setSelectedSlot(null);
      }
      setStepRaw(prev);
      return h.slice(0, -1);
    });
  };

  const canGoBack = stepHistory.length > 0
    && step !== 'trial_success' && step !== 'plan_success' && step !== 'link_disabled';

  // Errores de la API pública del link: si la escuela apagó el link (422
  // reason 'link_disabled') se pasa al aviso y se limpia el historial; el
  // resto se muestra como banner de error.
  const handleApiError = useCallback((err: any) => {
    if (err?.body?.reason === 'link_disabled') {
      setStepHistory([]);
      setErrorMsg(null);
      setStepRaw('link_disabled');
      return;
    }
    setErrorMsg(err?.body?.error || err?.message);
  }, []);

  // ── Paso 0: bienvenida — nuevo o antiguo (mismo filtro que /agendar/:slug) ──
  const handleWelcomeChoice = (hint: 'returning' | 'new') => {
    setReturningHint(hint);
    goTo('identify');
  };

  // ── Paso 1: identificarse (correo, siempre primero) ─────────────────────
  const handleStartVerification = async () => {
    if (!schoolInfo || !email.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await api('/trial-start-verification', {
        method: 'POST',
        body: JSON.stringify({ school_id: schoolInfo.school.id, email: email.trim(), full_name: fullName.trim() || undefined }),
      });

      if (data.scenario === 'already_registered') {
        goTo('password');
      } else if (data.scenario === 'new_needs_name') {
        goTo('new_details');
      } else {
        setVerificationId(data.verification_id);
        setMaskedEmail(data.masked_email);
        setResolvedKind(data.scenario);
        if (data.debug_code) {
          // Modo debug local (PUBLIC_BOOKING_DEBUG_OTP=true, solo dev) — nos
          // saltamos el paso de código y verificamos de una vez, igual que
          // PublicFacilityBookingPage.tsx.
          console.log('🔑 DEBUG — código OTP auto-verificado:', data.debug_code);
          await verifyCode(data.verification_id, data.debug_code);
        } else {
          goTo('code');
        }
      }
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (verifId: string, codeValue: string) => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await api('/verify-otp', { method: 'POST', body: JSON.stringify({ verification_id: verifId, code: codeValue }) });
      setBookingToken(data.booking_token);
      setResolvedKind(data.scenario);
      // "enrolled_unregistered": la escuela ya lo conoce (puede tener un plan
      // real pagado) — antes de mandarlo directo a clase de prueba, se le
      // pregunta si prefiere crear su cuenta para ver SUS clases reales.
      if (data.scenario === 'enrolled_unregistered') {
        goTo('enrolled_choice');
        return;
      }
      if (!schoolInfo?.trial_categories.length) {
        setErrorMsg('Esta escuela no tiene categorías de prueba disponibles.');
        return;
      }
      goTo('category');
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!verificationId || !code.trim()) return;
    await verifyCode(verificationId, code.trim());
  };

  // ── "enrolled_unregistered" → crear cuenta real, conservando el historial
  // (plan, banco de horas, pagos) ya migrado por el backend. El correo ya
  // quedó probado con el OTP, así que esto entra directo con un magic link
  // — nada de contraseña ni segundo correo.
  const handleRegisterUnregistered = async () => {
    if (!bookingToken) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await api('/register-unregistered', {
        method: 'POST',
        body: JSON.stringify({ booking_token: bookingToken }),
      });
      window.location.href = data.magic_link;
    } catch (err: any) {
      if (err?.body?.reason === 'minor_requires_guardian_invite') {
        setErrorMsg(null);
        setRegisterBlockedForMinor(true);
      } else {
        handleApiError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  // ── "Agendar sin crear cuenta" — reusa el mismo motor de disponibilidad/
  // reserva que "Mis Inscripciones" (listAvailableSessions/bookSession en el
  // BFF), resuelto por bookingToken. Trae las sesiones disponibles y la
  // grilla de horas para la modalidad personalizada, además del modo "por
  // bloque".
  const fetchNoAccountSessions = async () => {
    if (!bookingToken) return;
    setLoadingNoAccountSessions(true);
    setErrorMsg(null);
    try {
      const data = await api(`/available-for-enrollment?token=${encodeURIComponent(bookingToken)}`);
      setNoAccountSessions(data.sessions ?? []);
      setNoAccountFlexibleGrid(data.flexible_hour_grid ?? []);
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setLoadingNoAccountSessions(false);
    }
  };

  const handleBookWithoutAccount = async (session: BookableSession, durationMinutes?: number) => {
    if (!bookingToken) return;
    setBookingNoAccount(true);
    setErrorMsg(null);
    try {
      await api('/book-for-enrollment', {
        method: 'POST',
        body: JSON.stringify({
          booking_token: bookingToken,
          session_id: session.id,
          enrollment_id: session.enrollment_id,
          duration_minutes: durationMinutes ?? session.default_minutes,
        }),
      });
      setNoAccountBooked(session);
      setConfirmingNoAccountSession(null);
      fetchNoAccountBookings();
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setBookingNoAccount(false);
    }
  };

  const fetchNoAccountBookings = async () => {
    if (!bookingToken) return;
    setLoadingNoAccountBookings(true);
    try {
      const data = await api(`/my-bookings-for-enrollment?token=${encodeURIComponent(bookingToken)}`);
      setNoAccountBookings(data ?? []);
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setLoadingNoAccountBookings(false);
    }
  };

  const handleCancelNoAccountBooking = async () => {
    if (!bookingToken || !cancellingNoAccountBooking) return;
    setCancellingNoAccountInFlight(true);
    setErrorMsg(null);
    try {
      await api('/cancel-for-enrollment', {
        method: 'POST',
        body: JSON.stringify({ booking_token: bookingToken, booking_id: cancellingNoAccountBooking.id }),
      });
      setCancellingNoAccountBooking(null);
      await fetchNoAccountBookings();
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setCancellingNoAccountInFlight(false);
    }
  };

  useEffect(() => {
    if (step === 'book_without_account') {
      fetchNoAccountSessions();
      fetchNoAccountBookings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Mismo criterio de agrupación que "Mis Inscripciones" — por hora Y tipo,
  // así dos coaches con la misma disponibilidad no salen como filas
  // idénticas (CompactSessionSlot deja elegir entre ellos). Agrupa las
  // sesiones por fecha; en modo "por bloque" las colapsa a bloques fijos.
  const noAccountSessionsByDate = useMemo(() => {
    const groups: Record<string, BookableSession[]> = {};
    for (const s of noAccountSessions) {
      groups[s.session_date] = groups[s.session_date] ?? [];
      groups[s.session_date].push(s);
    }
    // "Por bloque" colapsa a inicios fijos sin solapar; "Personalizada" (o sin
    // elegir aún) muestra todas las horas de inicio — mismo criterio que
    // "Mis Inscripciones" (planSessionsByDate).
    if (noAccountBookingModeChoice === 'block') {
      Object.keys(groups).forEach((date) => {
        groups[date] = collapseOverlappingBlocks(groups[date]).sort((a, b) => a.start_time.localeCompare(b.start_time));
      });
    }
    return groups;
  }, [noAccountSessions, noAccountBookingModeChoice]);

  const noAccountDates = useMemo(
    () => Object.keys(noAccountSessionsByDate).sort(),
    [noAccountSessionsByDate],
  );

  useEffect(() => {
    if (!noAccountDate && noAccountDates.length) setNoAccountDate(noAccountDates[0]);
  }, [noAccountDates, noAccountDate]);

  const groupedNoAccountSessionsForDay = useMemo(() => {
    const sessions = (noAccountDate ? (noAccountSessionsByDate[noAccountDate] ?? []) : [])
      .filter((s) => {
        if (noAccountClassTypeFilter === 'all') return true;
        if (noAccountClassTypeFilter === 'personal') return s.available_for_personal_classes === true;
        if (noAccountClassTypeFilter === 'group') return s.available_for_group_classes === true && s.max_capacity > 1;
        return true;
      });
    const groups: Record<string, BookableSession[]> = {};
    sessions.forEach((s) => {
      const key = `${s.start_time}-${s.end_time}-${s.available_for_personal_classes ? 'p' : 'g'}`;
      groups[key] = groups[key] ?? [];
      groups[key].push(s);
    });
    return Object.values(groups).sort((a, b) => a[0].start_time.localeCompare(b[0].start_time));
  }, [noAccountSessionsByDate, noAccountDate, noAccountClassTypeFilter]);

  const noAccountFlexibleHourGridForDay = useMemo(() => {
    if (!noAccountDate) return [];
    return noAccountFlexibleGrid.filter((g) => g.session_date === noAccountDate);
  }, [noAccountFlexibleGrid, noAccountDate]);

  // Mismo criterio que planHourBankEnrollmentId, para "cuántas horas le
  // quedan" sin cuenta.
  const noAccountHourBankEnrollmentId = useMemo(
    () => noAccountSessions.find((s) => s.default_minutes != null)?.enrollment_id ?? null,
    [noAccountSessions],
  );

  const fetchNoAccountHourBankBalance = useCallback(async (): Promise<HourBankBalance> => {
    if (!bookingToken || !noAccountHourBankEnrollmentId) return { has_hours_plan: false };
    // El paso a link_disabled queda en el fetcher; es seguro porque
    // retryHourBankBalance evita reintentar ese error (sin segunda llamada).
    try {
      return await api(`/hour-bank-balance-for-enrollment?token=${encodeURIComponent(bookingToken)}&enrollment_id=${noAccountHourBankEnrollmentId}`);
    } catch (err: any) {
      if (err?.body?.reason === 'link_disabled') handleApiError(err);
      throw err;
    }
  }, [bookingToken, noAccountHourBankEnrollmentId, handleApiError]);

  // ── Camino "ya registrado": login inline + sus clases de plan ───────────
  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error || !data.session) {
        setErrorMsg('Correo o contraseña incorrectos.');
        return;
      }

      setLoadingChildren(true);
      const { data: { user } } = await supabase.auth.getUser();
      const { data: children } = await supabase
        .from('children')
        .select('id, full_name')
        .eq('parent_id', user?.id ?? '');
      setLoadingChildren(false);

      if (children && children.length > 0) {
        setPlanChildren(children);
        goTo('plan_pick_child');
      } else {
        setPlanIsAthleteSelf(true);
        setPlanChildId(undefined);
        setSelectedPlanDate(null);
        setPlanCalendarDate(new Date());
        goTo('plan_sessions');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'No se pudo iniciar sesión.');
    } finally {
      setBusy(false);
    }
  };

  const handlePickPlanChild = (c: ChildOption) => {
    setPlanChildId(c.id);
    setPlanIsAthleteSelf(false);
    setSelectedPlanDate(null);
    setPlanCalendarDate(new Date());
    goTo('plan_sessions');
  };

  const handleBookPlanSession = async (s: BookableSession, durationMinutes?: number) => {
    if (!s.enrollment_id) {
      setErrorMsg('No encontramos una inscripción activa para esta clase.');
      return;
    }
    try {
      await bookPlanSession({ session_id: s.id, enrollment_id: s.enrollment_id, duration_minutes: durationMinutes });
      setBookedPlanSession(s);
      setConfirmingPlanSession(null);
      goTo('plan_success');
    } catch (err: any) {
      setErrorMsg(err.message || 'No se pudo agendar la clase.');
    }
  };

  // ── Camino "clase de prueba" (OTP) ───────────────────────────────────────
  const handlePickCategory = async (c: TrialCategory) => {
    setSelectedCategory(c);
    setSelectedSlot(null);
    setLoadingSlots(true);
    setErrorMsg(null);
    try {
      const from = new Date().toISOString().split('T')[0];
      const toDate = new Date();
      toDate.setDate(toDate.getDate() + 14);
      const to = toDate.toISOString().split('T')[0];
      const params = new URLSearchParams({ token: bookingToken || '', category_id: c.id, from, to });
      const data = await api(`/trial-slots?${params.toString()}`);
      setSlots(data);
      goTo('slots');
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setLoadingSlots(false);
    }
  };

  const handleSlotContinue = () => {
    if (!selectedSlot) return;
    if (resolvedKind === 'new') {
      goTo('contact_details');
    } else {
      handleConfirmTrial();
    }
  };

  const handleConfirmTrial = async () => {
    if (!selectedSlot || !bookingToken || !selectedCategory) return;
    if (resolvedKind === 'new' && (!whatsapp.trim() || (isMinor && !childName.trim()))) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const data = await api('/trial-confirm', {
        method: 'POST',
        body: JSON.stringify({
          token: bookingToken,
          category_id: selectedCategory.id,
          facility_availability_id: selectedSlot.facility_availability_id,
          coach_availability_id: selectedSlot.coach_availability_id,
          date: selectedSlot.slot_date,
          start_time: selectedSlot.slot_start_time,
          end_time: selectedSlot.slot_end_time,
          ...(resolvedKind === 'new' ? { prospect_whatsapp: whatsapp.trim(), is_minor: isMinor, child_name: isMinor ? childName.trim() : undefined } : {}),
        }),
      });
      setSuccessInfo({ price: data.price, is_first: data.is_first });
      goTo('trial_success');
    } catch (err: any) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loadingSchool) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Skeleton className="h-64 w-full max-w-md rounded-2xl" />
      </div>
    );
  }

  if (notFound || !schoolInfo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 text-center">
        <div>
          <AlertCircle className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-semibold">No encontramos esta escuela.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/20 flex items-start justify-center p-4 py-10">
      <Card className="w-full max-w-md border-border/40 shadow-lg">
        <CardContent className="p-6 space-y-6">
          <div className="text-center space-y-1">
            <div className="flex justify-center">
              <div className="bg-primary/10 p-3 rounded-full"><Sparkles className="h-6 w-6 text-primary" /></div>
            </div>
            <h1 className="text-lg font-bold">{schoolInfo.school.name}</h1>
            <p className="text-xs text-muted-foreground">Agenda tu clase</p>
          </div>

          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Volver
            </button>
          )}

          {errorMsg && <ErrorBanner message={errorMsg} />}

          {/* ── Paso 0: bienvenida — nuevo o antiguo (solo copy, no decide nada) ── */}
          {step === 'welcome' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <p className="text-xs text-center text-muted-foreground">
                Para darte la mejor experiencia, cuéntanos un poco de ti
              </p>
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={() => handleWelcomeChoice('returning')}
                  className="p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left flex items-center gap-3"
                >
                  <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                  <div>
                    <p className="font-semibold text-sm">Ya soy parte de {schoolInfo.school.name}</p>
                    <p className="text-xs text-muted-foreground">Tengo un plan o ya me conocen acá</p>
                  </div>
                </button>
                <button
                  onClick={() => handleWelcomeChoice('new')}
                  className="p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left flex items-center gap-3"
                >
                  <Sparkles className="h-5 w-5 text-amber-500 shrink-0" />
                  <div>
                    <p className="font-semibold text-sm">Es mi primera vez acá</p>
                    <p className="text-xs text-muted-foreground">Quiero conocer la escuela</p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ── Paso 1: identificarse ── */}
          {step === 'identify' && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Tu correo</Label>
                <div className="relative">
                  <Mail className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@ejemplo.com" className="pl-9 h-11" />
                </div>
              </div>
              <Button onClick={handleStartVerification} disabled={!email.trim() || busy} className="w-full">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Continuar <ArrowRight className="h-4 w-4 ml-1" /></>}
              </Button>
              <p className="text-[11px] text-center text-muted-foreground">
                {returningHint === 'new'
                  ? 'Verifiquemos tu correo — si es tu primera vez, agendas una clase de prueba 🎉'
                  : 'Si ya tienes cuenta, te pedimos tu contraseña acá mismo. Si no, agendas una clase de prueba.'}
              </p>
            </div>
          )}

          {step === 'new_details' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-2">
                <Label className="text-xs font-semibold">No te tenemos registrado — ¿cuál es tu nombre completo?</Label>
                <div className="relative">
                  <User className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Nombre completo" className="pl-9 h-11" />
                </div>
              </div>
              <Button onClick={handleStartVerification} disabled={!fullName.trim() || busy} className="w-full">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enviar código de verificación'}
              </Button>
            </div>
          )}

          {/* ── Ya registrado: login inline, sin salir de la página ── */}
          {step === 'password' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs text-muted-foreground">Ya tienes cuenta con <strong>{email}</strong> — inicia sesión para agendar tu clase.</p>
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Contraseña</Label>
                <div className="relative">
                  <Lock className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="pl-9 h-11" onKeyDown={(e) => e.key === 'Enter' && handleLogin()} />
                </div>
              </div>
              <Button onClick={handleLogin} disabled={!password || busy || loadingChildren} className="w-full">
                {busy || loadingChildren ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Iniciar sesión y agendar'}
              </Button>
            </div>
          )}

          {step === 'plan_pick_child' && (
            <div className="space-y-3 animate-in fade-in slide-in-from-right-4 duration-300">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">¿Para quién agendas?</Label>
              {planChildren.map((c) => (
                <button key={c.id} onClick={() => handlePickPlanChild(c)} className="w-full text-left rounded-xl border-2 border-border/50 hover:border-primary/40 p-4 transition-all flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" /> <span className="font-semibold text-sm">{c.full_name}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'plan_sessions' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5" />
                {planIsAthleteSelf ? 'Tus clases disponibles' : `Clases de ${planChildren.find((c) => c.id === planChildId)?.full_name ?? 'tu hijo/a'}`}
              </p>

              {planHourBankEnrollmentId && <HourBankBalanceCard enrollmentId={planHourBankEnrollmentId} />}

              {/* Tercera opción del link: agendar (por bloque o personalizada,
                  eso se elige un paso más adelante) o cancelar una clase ya
                  agendada — sin tener que salir a "Mis Inscripciones". */}
              <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit mx-auto">
                {([
                  { key: 'book', label: 'Agendar' },
                  { key: 'cancel', label: 'Cancelar una clase' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPlanTopAction(key)}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${planTopAction === key
                        ? 'bg-background text-foreground shadow-sm border border-border/40'
                        : 'text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {planTopAction === 'cancel' ? (
                loadingPlanBookings ? (
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                ) : cancellablePlanBookings.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-6">No tienes clases agendadas para cancelar en esta escuela.</p>
                ) : (
                  <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                    {cancellablePlanBookings.map((b) => {
                      const s = b.attendance_sessions;
                      return (
                        <div key={b.id} className="w-full text-left text-xs rounded-lg border-2 border-border/50 p-3 flex items-center justify-between gap-2">
                          <span>
                            <span className="font-bold">
                              {s?.session_date ? fmtDate(s.session_date) : ''}
                            </span>
                            <span className="text-muted-foreground ml-2">
                              {s ? `${fmtTime(s.start_time)} — ${fmtTime(s.end_time)}` : ''}
                            </span>
                          </span>
                          <Button
                            variant="ghost" size="sm"
                            disabled={cancellingPlanBooking}
                            onClick={() => setCancellingBooking(b)}
                            className="h-8 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <XCircle className="h-3.5 w-3.5 mr-1" /> Cancelar
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )
              ) : loadingPlanSessions ? (
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
              ) : Object.keys(planSessionsByDate).length === 0 ? (
                <p className="text-xs text-center text-muted-foreground py-6">No hay clases disponibles para agendar en este momento.</p>
              ) : (() => {
                const planFlexibleSession = planSessionsForThisSchool.find((s) => s.default_minutes != null);
                if (planFlexibleSession && planBookingModeChoice === null) {
                  const blockMins = planFlexibleSession.default_minutes as number;
                  const blockLabel = blockMins % 60 === 0 ? `${blockMins / 60}h` : `${blockMins} min`;
                  return (
                    <div className="space-y-3 py-2">
                      <p className="text-center text-xs text-muted-foreground font-semibold px-4">
                        ¿Cómo quieres agendar tu clase?
                      </p>
                      <button
                        type="button"
                        onClick={() => setPlanBookingModeChoice('block')}
                        className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
                      >
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Zap className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black uppercase tracking-tight">Por bloque ({blockLabel})</p>
                          <p className="text-xs text-muted-foreground">La duración estándar de tu plan, directo.</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanBookingModeChoice('custom')}
                        className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
                      >
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
                          <Clock className="h-5 w-5 text-indigo-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black uppercase tracking-tight">Sesión personalizada</p>
                          <p className="text-xs text-muted-foreground">Elige cuántas horas agendar — útil si tienes horas acumuladas por vencer.</p>
                        </div>
                      </button>
                    </div>
                  );
                }
                return (
                <>
                  {planFlexibleSession && (
                    <div className="flex items-center justify-between px-1">
                      <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                        {planBookingModeChoice === 'custom' ? '⏱️ Sesión personalizada' : `⚡ Por bloque (${(planFlexibleSession.default_minutes as number) % 60 === 0 ? `${(planFlexibleSession.default_minutes as number) / 60}h` : `${planFlexibleSession.default_minutes} min`})`}
                      </p>
                      <button type="button" onClick={() => setPlanBookingModeChoice(null)} className="text-[10px] font-bold text-primary hover:underline">
                        Cambiar
                      </button>
                    </div>
                  )}
                  {/* Calendario tipo mes: primero se elige el día, después se
                      despliegan los horarios de ese día. */}
                  <div className="rounded-xl border border-border/40 overflow-hidden bg-muted/10">
                    <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
                      <button
                        type="button"
                        onClick={() => setPlanCalendarDate((d) => new Date(d.getFullYear(), d.getMonth() - 1))}
                        className="p-1 rounded-md hover:bg-muted/60 transition-colors"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <p className="text-xs font-black uppercase tracking-wider capitalize">
                        {format(planCalendarDate, 'MMMM yyyy', { locale: es })}
                      </p>
                      <button
                        type="button"
                        onClick={() => setPlanCalendarDate((d) => new Date(d.getFullYear(), d.getMonth() + 1))}
                        className="p-1 rounded-md hover:bg-muted/60 transition-colors"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-7 text-center border-b border-border/20">
                      {['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map((d) => (
                        <div key={d} className="py-1.5 text-[9px] font-black text-muted-foreground uppercase">{d}</div>
                      ))}
                    </div>

                    <div className="grid grid-cols-7 p-1">
                      {(() => {
                        const monthStart = startOfMonth(planCalendarDate);
                        const monthEnd = endOfMonth(planCalendarDate);
                        const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
                        const startPad = (monthStart.getDay() + 6) % 7;
                        const todayDate = startOfDay(new Date());

                        return (
                          <>
                            {Array.from({ length: startPad }).map((_, i) => <div key={`p${i}`} />)}
                            {days.map((day) => {
                              const dateStr = format(day, 'yyyy-MM-dd');
                              const isPast = isBefore(day, todayDate);
                              const isToday_ = isToday(day);
                              const isSelected = selectedPlanDate === dateStr;
                              const isAvailable = availablePlanDates.has(dateStr);

                              return (
                                <button
                                  key={dateStr}
                                  type="button"
                                  disabled={isPast || !isAvailable}
                                  onClick={() => setSelectedPlanDate(isSelected ? null : dateStr)}
                                  className={`relative flex flex-col items-center justify-center py-1.5 mx-0.5 my-0.5 text-[11px] font-semibold rounded-lg transition-all
                                    ${isSelected ? 'bg-primary text-primary-foreground shadow-md'
                                      : (isAvailable && !isPast) ? 'bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
                                        : 'text-muted-foreground/30 cursor-default'}
                                    ${isToday_ && !isSelected ? 'ring-1 ring-primary/50' : ''}`}
                                >
                                  {format(day, 'd')}
                                  {isAvailable && !isPast && !isSelected && (
                                    <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-primary/40" />
                                  )}
                                </button>
                              );
                            })}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {planSessionsForThisSchool.some((s) => s.available_for_personal_classes || s.available_for_group_classes) && (
                    <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit mx-auto">
                      {[
                        { key: 'all', label: 'Todas' },
                        { key: 'personal', label: '👤 Personal' },
                        { key: 'group', label: '👥 Grupal' },
                      ].map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setPlanClassTypeFilter(key as any)}
                          className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${planClassTypeFilter === key
                              ? 'bg-background text-foreground shadow-sm border border-border/40'
                              : 'text-muted-foreground hover:text-foreground'
                            }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}

                  {!selectedPlanDate ? (
                    <div className="py-6 text-center text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border/40">
                      <Calendar className="h-6 w-6 mx-auto mb-2 opacity-20" />
                      <p className="text-xs font-medium">Selecciona un día con horarios disponibles</p>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                      <p className="text-[11px] font-bold uppercase text-primary capitalize">{fmtDate(selectedPlanDate)}</p>
                      {planBookingModeChoice === 'custom' ? (
                        <HourGridPicker
                          groups={flexiblePlanHourGridForDay}
                          noCredits={false}
                          isBooking={bookingPlan}
                          onBook={setConfirmingPlanSession}
                        />
                      ) : (
                        groupedPlanSessionsForDay.map((group) => (
                          <CompactSessionSlot
                            key={group[0].id}
                            sessions={group}
                            noCredits={false}
                            isBooking={bookingPlan}
                            onBook={setConfirmingPlanSession}
                          />
                        ))
                      )}
                    </div>
                  )}
                </>
                );
              })()}
            </div>
          )}

          {step === 'plan_success' && bookedPlanSession && (
            <div className="text-center space-y-4 animate-in fade-in duration-300">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <div>
                <p className="font-bold">¡Clase agendada!</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {fmtDate(bookedPlanSession.session_date)} · {fmtTime(bookedPlanSession.start_time)}
                </p>
              </div>
            </div>
          )}

          {/* ── Clase de prueba: OTP ── */}
          {step === 'code' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs text-muted-foreground">Te enviamos un código a {maskedEmail}.</p>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" maxLength={6} className="h-12 text-center text-2xl tracking-[0.5em]" />
              <Button onClick={handleVerifyCode} disabled={code.length !== 6 || busy} className="w-full">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verificar'}
              </Button>
            </div>
          )}

          {step === 'enrolled_choice' && (
            <div className="space-y-3 animate-in fade-in slide-in-from-right-4 duration-300 py-2">
              <p className="text-center text-xs text-muted-foreground font-semibold px-4">
                Ya tienes matrícula en esta escuela. ¿Qué quieres hacer?
              </p>
              {registerBlockedForMinor && (
                <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 text-xs text-foreground/80 font-medium">
                  Esta ficha es de un menor de edad. Para crear la cuenta, pídele a la escuela que invite a su acudiente. Mientras tanto, puedes agendar sin crear cuenta.
                </div>
              )}
              {!registerBlockedForMinor && (
              <button
                type="button"
                disabled={busy}
                onClick={handleRegisterUnregistered}
                className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left disabled:opacity-50"
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  {busy ? <Loader2 className="h-5 w-5 text-primary animate-spin" /> : <User className="h-5 w-5 text-primary" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-black uppercase tracking-tight">Crear mi cuenta y ver mis clases</p>
                  <p className="text-xs text-muted-foreground">Accede directo a tu plan real — agenda por bloque, personalizada, o cancela una clase.</p>
                </div>
              </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => goTo('book_without_account')}
                className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left disabled:opacity-50"
              >
                <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-indigo-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-black uppercase tracking-tight">Agendar sin crear cuenta</p>
                  <p className="text-xs text-muted-foreground">Solo esta vez — agenda tu clase del plan y listo.</p>
                </div>
              </button>
            </div>
          )}

          {step === 'book_without_account' && (
            <div className="space-y-3 animate-in fade-in slide-in-from-right-4 duration-300 py-2">
              <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit mx-auto">
                {([
                  { key: 'book', label: 'Agendar' },
                  { key: 'cancel', label: 'Cancelar una clase' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setNoAccountTopAction(key)}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                      noAccountTopAction === key
                        ? 'bg-background text-foreground shadow-sm border border-border/40'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {noAccountHourBankEnrollmentId && (
                <HourBankBalanceCard enrollmentId={noAccountHourBankEnrollmentId} fetcher={fetchNoAccountHourBankBalance} retry={retryHourBankBalance} />
              )}

              {noAccountTopAction === 'cancel' ? (
                loadingNoAccountBookings ? (
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                ) : noAccountBookings.length === 0 ? (
                  <p className="text-xs text-center text-muted-foreground py-6">No tienes clases agendadas para cancelar.</p>
                ) : (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {noAccountBookings.map((b) => (
                      <div key={b.id} className="w-full text-left text-xs rounded-lg border-2 border-border/50 p-3 flex items-center justify-between gap-2">
                        <span>
                          <span className="font-bold capitalize">
                            {b.attendance_sessions?.session_date ? fmtDate(b.attendance_sessions.session_date) : ''}
                          </span>
                          <span className="text-muted-foreground ml-2">
                            {b.attendance_sessions ? `${fmtTime(b.attendance_sessions.start_time)} — ${fmtTime(b.attendance_sessions.end_time)}` : ''}
                          </span>
                        </span>
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => setCancellingNoAccountBooking(b)}
                          className="h-8 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Cancelar
                        </Button>
                      </div>
                    ))}
                  </div>
                )
              ) : noAccountBooked ? (
                <div className="text-center py-8 space-y-3">
                  <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
                  <p className="text-sm font-black uppercase tracking-tight">¡Clase agendada!</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDate(noAccountBooked.session_date)} a las {fmtTime(noAccountBooked.start_time)}
                  </p>
                </div>
              ) : loadingNoAccountSessions ? (
                <div className="py-10 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : noAccountDates.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border/40">
                  <Calendar className="h-6 w-6 mx-auto mb-2 opacity-20" />
                  <p className="text-xs font-medium">No hay horarios disponibles por ahora.</p>
                </div>
              ) : (() => {
                // Eje 1: "¿Cómo quieres agendar tu clase?" — Por bloque
                // (duración fija del plan) vs Personalizada (armar tu propio
                // rango de horas) — se elige ANTES de ver la lista, igual
                // que en "Mis Inscripciones". Distinto del tipo de clase
                // (Personal/Grupal), que es un filtro aparte más abajo.
                const noAccountFlexibleSession = noAccountSessions.find((s) => s.default_minutes != null);
                if (noAccountFlexibleSession && noAccountBookingModeChoice === null) {
                  const blockMins = noAccountFlexibleSession.default_minutes as number;
                  const blockLabel = blockMins % 60 === 0 ? `${blockMins / 60}h` : `${blockMins} min`;
                  return (
                    <div className="space-y-3 py-2">
                      <p className="text-center text-xs text-muted-foreground font-semibold px-4">
                        ¿Cómo quieres agendar tu clase?
                      </p>
                      <button
                        type="button"
                        onClick={() => setNoAccountBookingModeChoice('block')}
                        className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
                      >
                        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Zap className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black uppercase tracking-tight">Por bloque ({blockLabel})</p>
                          <p className="text-xs text-muted-foreground">La duración estándar de tu plan, directo.</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setNoAccountBookingModeChoice('custom')}
                        className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
                      >
                        <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
                          <Clock className="h-5 w-5 text-indigo-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black uppercase tracking-tight">Sesión personalizada</p>
                          <p className="text-xs text-muted-foreground">Elige cuántas horas agendar — útil si tienes horas acumuladas por vencer.</p>
                        </div>
                      </button>
                    </div>
                  );
                }
                return (
                  <>
                    {noAccountFlexibleSession && (
                      <div className="flex items-center justify-between px-1">
                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                          {noAccountBookingModeChoice === 'custom' ? '⏱️ Sesión personalizada' : `⚡ Por bloque (${(noAccountFlexibleSession.default_minutes as number) % 60 === 0 ? `${(noAccountFlexibleSession.default_minutes as number) / 60}h` : `${noAccountFlexibleSession.default_minutes} min`})`}
                        </p>
                        <button type="button" onClick={() => setNoAccountBookingModeChoice(null)} className="text-[10px] font-bold text-primary hover:underline">
                          Cambiar
                        </button>
                      </div>
                    )}

                    {/* Eje 2: TIPO de clase (Personal/Grupal) — quién cabe en
                        el cupo, independiente del modo de arriba. */}
                    {noAccountSessions.some((s) => s.available_for_personal_classes || s.available_for_group_classes) && (
                      <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit mx-auto">
                        {[
                          { key: 'all', label: 'Todas' },
                          { key: 'personal', label: '👤 Personal' },
                          { key: 'group', label: '👥 Grupal' },
                        ].map(({ key, label }) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setNoAccountClassTypeFilter(key as any)}
                            className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                              noAccountClassTypeFilter === key
                                ? 'bg-background text-foreground shadow-sm border border-border/40'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {noAccountDates.map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setNoAccountDate(d)}
                          className={`shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase whitespace-nowrap transition-all ${
                            noAccountDate === d
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                          }`}
                        >
                          {fmtDate(d)}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                      {noAccountBookingModeChoice === 'custom' ? (
                        <HourGridPicker
                          groups={noAccountFlexibleHourGridForDay}
                          noCredits={false}
                          isBooking={bookingNoAccount}
                          onBook={setConfirmingNoAccountSession}
                        />
                      ) : (
                        groupedNoAccountSessionsForDay.map((group) => (
                          <CompactSessionSlot
                            key={group[0].id}
                            sessions={group}
                            noCredits={false}
                            isBooking={bookingNoAccount}
                            onBook={setConfirmingNoAccountSession}
                          />
                        ))
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          <AlertDialog open={!!confirmingNoAccountSession} onOpenChange={(o) => { if (!o) setConfirmingNoAccountSession(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirmar clase</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-3 text-sm">
                    <div className="rounded-lg border p-3 space-y-1 bg-muted/20">
                      <p className="font-semibold text-foreground capitalize">
                        {confirmingNoAccountSession ? fmtDate(confirmingNoAccountSession.session_date) : ''}
                      </p>
                      <p className="text-muted-foreground">
                        {confirmingNoAccountSession ? fmtTime(confirmingNoAccountSession.start_time) : ''} — {confirmingNoAccountSession ? fmtTime(confirmingNoAccountSession.end_time) : ''}
                      </p>
                      {confirmingNoAccountSession?.coach && (confirmingNoAccountSession.coach.full_name || confirmingNoAccountSession.coach.name) && (
                        <p className="text-muted-foreground text-xs">Coach: {confirmingNoAccountSession.coach.full_name || confirmingNoAccountSession.coach.name}</p>
                      )}
                    </div>

                    {confirmingNoAccountSession?.default_minutes != null && confirmingNoAccountSession?.max_bookable_minutes != null && (
                      <div className="rounded-lg border p-3 space-y-2 bg-primary/5 border-primary/20">
                        <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit">
                          {([
                            { key: 'block', label: `Por bloque (${confirmingNoAccountSession.default_minutes % 60 === 0 ? `${confirmingNoAccountSession.default_minutes / 60}h` : `${Math.floor(confirmingNoAccountSession.default_minutes / 60)}h ${confirmingNoAccountSession.default_minutes % 60}m`})` },
                            { key: 'custom', label: 'Personalizada' },
                          ] as const).map(({ key, label }) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                setNoAccountBookingMode(key);
                                setNoAccountDurationMinutes(confirmingNoAccountSession.default_minutes as number);
                              }}
                              className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all ${
                                noAccountBookingMode === key
                                  ? 'bg-background text-foreground shadow-sm border border-border/40'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {noAccountBookingMode === 'custom' && (
                          confirmingNoAccountSession.max_bookable_minutes > confirmingNoAccountSession.default_minutes ? (
                            <>
                              <p className="text-xs font-semibold text-foreground">¿Cuántas horas quieres agendar?</p>
                              <div className="flex flex-wrap gap-2">
                                {Array.from(
                                  { length: Math.floor((confirmingNoAccountSession.max_bookable_minutes - confirmingNoAccountSession.default_minutes) / 60) + 1 },
                                  (_, i) => (confirmingNoAccountSession.default_minutes as number) + i * 60,
                                ).map((mins) => (
                                  <button
                                    key={mins}
                                    type="button"
                                    onClick={() => setNoAccountDurationMinutes(mins)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                                      noAccountDurationMinutes === mins
                                        ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                                        : 'border-border/50 text-muted-foreground hover:border-primary/40'
                                    }`}
                                  >
                                    {mins % 60 === 0 ? `${mins / 60}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
                                  </button>
                                ))}
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                Sesión personalizada — útil si tienes horas acumuladas por vencer.
                              </p>
                            </>
                          ) : (
                            <p className="text-[11px] text-muted-foreground">
                              No hay más horas seguidas disponibles con este entrenador a partir de este horario — se agendará el bloque de {confirmingNoAccountSession.default_minutes % 60 === 0 ? `${confirmingNoAccountSession.default_minutes / 60}h` : `${confirmingNoAccountSession.default_minutes} min`}.
                            </p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={bookingNoAccount}>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  disabled={bookingNoAccount}
                  onClick={(e) => {
                    e.preventDefault();
                    if (confirmingNoAccountSession) handleBookWithoutAccount(confirmingNoAccountSession, noAccountDurationMinutes ?? undefined);
                  }}
                >
                  {bookingNoAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirmar'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={!!cancellingNoAccountBooking} onOpenChange={(o) => { if (!o) setCancellingNoAccountBooking(null); }}>
            <AlertDialogContent className="rounded-2xl border-0 shadow-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                  <XCircle className="h-5 w-5" />
                  Cancelar reserva
                </AlertDialogTitle>
                <AlertDialogDescription>
                  ¿Estás seguro de cancelar tu reserva del{' '}
                  <span className="font-bold text-foreground">
                    {cancellingNoAccountBooking?.attendance_sessions?.session_date ? fmtDate(cancellingNoAccountBooking.attendance_sessions.session_date) : ''}
                    {cancellingNoAccountBooking?.attendance_sessions?.start_time ? ` · ${fmtTime(cancellingNoAccountBooking.attendance_sessions.start_time)}` : ''}
                  </span>
                  ? El cupo se liberará y el crédito o las horas se devolverán a tu plan automáticamente.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={cancellingNoAccountInFlight}>Volver</AlertDialogCancel>
                <AlertDialogAction
                  disabled={cancellingNoAccountInFlight}
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={handleCancelNoAccountBooking}
                >
                  {cancellingNoAccountInFlight ? 'Cancelando...' : 'Sí, cancelar'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {step === 'category' && (
            <div className="space-y-3 animate-in fade-in duration-300">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">¿Qué quieres probar?</Label>
              {schoolInfo.trial_categories.map((c) => (
                <button
                  key={c.id}
                  disabled={loadingSlots}
                  onClick={() => handlePickCategory(c)}
                  className="w-full text-left rounded-xl border-2 border-border/50 hover:border-primary/40 p-4 transition-all disabled:opacity-50"
                >
                  <p className="font-bold text-sm">{c.name}</p>
                  {c.description && <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>}
                  <p className="text-xs font-bold text-emerald-600 mt-1">{c.price > 0 ? `$${c.price.toLocaleString('es-CO')} COP` : 'Sin costo'}</p>
                </button>
              ))}
            </div>
          )}

          {step === 'slots' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" /> Elige un horario
              </p>
              {loadingSlots ? (
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
              ) : Object.keys(slotsByDate).length === 0 ? (
                <p className="text-xs text-center text-muted-foreground py-6">No hay horarios disponibles en los próximos días.</p>
              ) : (
                <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                  {Object.entries(slotsByDate).map(([date, daySlots]) => (
                    <div key={date} className="space-y-1.5">
                      <p className="text-[11px] font-bold uppercase text-primary capitalize">{fmtDate(date)}</p>
                      <div className="grid grid-cols-2 gap-2">
                        {daySlots.map((s) => {
                          const isSel = selectedSlot === s;
                          return (
                            <button
                              key={`${s.facility_availability_id}-${s.coach_availability_id}-${s.slot_start_time}`}
                              onClick={() => setSelectedSlot(s)}
                              className={`text-xs rounded-lg border-2 p-2 text-left transition-all ${isSel ? 'border-primary bg-primary/5' : 'border-border/50'}`}
                            >
                              <p className="font-bold">{fmtTime(s.slot_start_time)}</p>
                              <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Building2 className="h-2.5 w-2.5" />{s.facility_name}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Button onClick={handleSlotContinue} disabled={!selectedSlot || busy} className="w-full">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Continuar'}
              </Button>
            </div>
          )}

          {step === 'contact_details' && (
            <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Tu WhatsApp</Label>
                <Input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+57 300 000 0000" className="h-11" />
              </div>
              <button type="button" onClick={() => setIsMinor(!isMinor)} className="flex items-center gap-2 text-xs">
                <Baby className="h-4 w-4" /> Es para un hijo/a menor de edad
                <span className={`ml-auto w-9 h-5 rounded-full transition-colors ${isMinor ? 'bg-primary' : 'bg-muted'}`}>
                  <span className={`block w-4 h-4 rounded-full bg-white transition-transform mt-0.5 ${isMinor ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </span>
              </button>
              {isMinor && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold">Nombre del hijo/a</Label>
                  <Input value={childName} onChange={(e) => setChildName(e.target.value)} placeholder="Nombre completo" className="h-11" />
                </div>
              )}
              <Button onClick={handleConfirmTrial} disabled={!whatsapp.trim() || (isMinor && !childName.trim()) || busy} className="w-full">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirmar clase de prueba'}
              </Button>
            </div>
          )}

          {step === 'link_disabled' && (
            <div className="text-center space-y-4 animate-in fade-in duration-300">
              <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto" />
              <p className="text-sm font-semibold">
                Esta escuela no tiene activo el agendamiento por este link. Escríbele a la escuela.
              </p>
              <Button asChild variant="outline" className="w-full">
                {hasSession
                  ? <Link to="/enrollments">Ir a Mis Inscripciones</Link>
                  : <Link to="/login">Iniciar sesión</Link>}
              </Button>
            </div>
          )}

          {step === 'trial_success' && successInfo && (
            <div className="text-center space-y-4 animate-in fade-in duration-300">
              <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
              <div>
                <p className="font-bold">¡Clase de prueba agendada!</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {successInfo.price > 0 ? `Costo: $${successInfo.price.toLocaleString('es-CO')} COP` : 'Sin costo'} · Te llegó un correo de confirmación.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Piloto "agendamiento flexible de banco de horas" — este paso agendaba
          directo al clic; ahora confirma primero, igual que "Mis Inscripciones",
          y ofrece sesión personalizada cuando hay margen consecutivo real. */}
      <AlertDialog open={!!confirmingPlanSession} onOpenChange={(o) => { if (!o) setConfirmingPlanSession(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar clase</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border p-3 space-y-1 bg-muted/20">
                  <p className="font-bold text-foreground">
                    {confirmingPlanSession?.team?.name ?? (planIsAthleteSelf ? 'Tu clase' : planChildren.find((c) => c.id === planChildId)?.full_name)}
                  </p>
                  <p className="text-muted-foreground capitalize text-xs">
                    {confirmingPlanSession?.session_date ? fmtDate(confirmingPlanSession.session_date) : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {confirmingPlanSession ? fmtTime(confirmingPlanSession.start_time) : ''} — {confirmingPlanSession ? fmtTime(confirmingPlanSession.end_time) : ''}
                  </p>
                  {confirmingPlanSession?.coach && (confirmingPlanSession.coach.full_name || confirmingPlanSession.coach.name) && (
                    <p className="text-muted-foreground text-xs">Coach: {confirmingPlanSession.coach.full_name || confirmingPlanSession.coach.name}</p>
                  )}
                </div>
                {confirmingPlanSession?.default_minutes != null && confirmingPlanSession?.max_bookable_minutes != null && (
                  <div className="rounded-lg border p-3 space-y-2 bg-primary/5 border-primary/20">
                    <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit">
                      {([
                        { key: 'block', label: `Por bloque (${confirmingPlanSession.default_minutes % 60 === 0 ? `${confirmingPlanSession.default_minutes / 60}h` : `${Math.floor(confirmingPlanSession.default_minutes / 60)}h ${confirmingPlanSession.default_minutes % 60}m`})` },
                        { key: 'custom', label: 'Personalizada' },
                      ] as const).map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setPlanBookingMode(key);
                            setPlanDurationMinutes(confirmingPlanSession.default_minutes as number);
                          }}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-all ${
                            planBookingMode === key
                              ? 'bg-background text-foreground shadow-sm border border-border/40'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {planBookingMode === 'custom' && (
                      confirmingPlanSession.max_bookable_minutes > confirmingPlanSession.default_minutes ? (
                        <>
                          <p className="text-xs font-semibold text-foreground">¿Cuántas horas quieres agendar?</p>
                          <div className="flex flex-wrap gap-2">
                            {Array.from(
                              { length: Math.floor((confirmingPlanSession.max_bookable_minutes - confirmingPlanSession.default_minutes) / 60) + 1 },
                              (_, i) => (confirmingPlanSession.default_minutes as number) + i * 60,
                            ).map((mins) => (
                              <button
                                key={mins}
                                type="button"
                                onClick={() => setPlanDurationMinutes(mins)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                                  planDurationMinutes === mins
                                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                                    : 'border-border/50 text-muted-foreground hover:border-primary/40'
                                }`}
                              >
                                {mins % 60 === 0 ? `${mins / 60}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
                              </button>
                            ))}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            Sesión personalizada — útil si tienes horas acumuladas por vencer.
                          </p>
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          No hay más horas seguidas disponibles con este entrenador a partir de este horario — se agendará el bloque de {confirmingPlanSession.default_minutes % 60 === 0 ? `${confirmingPlanSession.default_minutes / 60}h` : `${confirmingPlanSession.default_minutes} min`}.
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={bookingPlan}
              onClick={() => {
                if (!confirmingPlanSession) return;
                handleBookPlanSession(confirmingPlanSession, planDurationMinutes ?? undefined);
              }}
            >
              {bookingPlan ? 'Agendando...' : 'Confirmar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!cancellingBooking} onOpenChange={(o) => { if (!o) setCancellingBooking(null); }}>
        <AlertDialogContent className="rounded-2xl border-0 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Cancelar reserva
            </AlertDialogTitle>
            <AlertDialogDescription>
              ¿Estás seguro de cancelar tu reserva del{' '}
              <span className="font-bold text-foreground">
                {cancellingBooking?.attendance_sessions?.session_date ? fmtDate(cancellingBooking.attendance_sessions.session_date) : ''}
                {cancellingBooking?.attendance_sessions?.start_time ? ` · ${fmtTime(cancellingBooking.attendance_sessions.start_time)}` : ''}
              </span>
              ? El cupo se liberará y el crédito o las horas se devolverán a tu plan automáticamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancellingPlanBooking}
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (!cancellingBooking) return;
                cancelPlanBooking(cancellingBooking.id, { onSuccess: () => setCancellingBooking(null) });
              }}
            >
              {cancellingPlanBooking ? 'Cancelando...' : 'Sí, cancelar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
