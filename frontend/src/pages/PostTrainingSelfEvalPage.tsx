import { useState, type ReactNode } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AlertCircle, Angry, ArrowLeft, Check, ChevronLeft, CircleDot, Footprints, Frown, HandMetal, Laugh,
  Meh, MessageSquare, PartyPopper, Pencil, Shield, Smile, Target as TargetIcon, Zap, type LucideIcon,
} from 'lucide-react';
import {
  BORG_OPTIONS,
  COMPREHENSION_OPTIONS,
  EFFORT_OPTIONS,
  EMPTY_ANSWERS,
  SATISFACTION_OPTIONS,
  TOTAL_QUESTIONS,
  buildPayload,
  sessionDateLabel,
  toggleFocus,
  type EvalAnswers,
} from '@/lib/postEntrenoAutoeval';

/**
 * Autoevaluación post-entrenamiento — spec docs/specs/evaluacion-post-entrenamiento.md §5.1.
 * La llena el acudiente con su hijo (o el deportista adulto) desde el enlace
 * de la notificación que dispara el trigger post_training_notify_on_finalize
 * al cerrar la sesión.
 *
 * Rediseño V2: una pregunta por pantalla, un toque por respuesta (salvo la
 * última, que es opcional y de varias). Colores del tema: se lee igual en
 * claro y en oscuro. El envío NO cambió: submit_post_training_self_eval con
 * el mismo `p_answers` (lib/postEntrenoAutoeval → buildPayload).
 */

const FOCUS_ICONS: Record<string, LucideIcon> = {
  focus_pase_control: HandMetal,
  focus_recepcion_pase: HandMetal,
  focus_remate_gol: TargetIcon,
  focus_remate: TargetIcon,
  focus_comunicacion_cancha: MessageSquare,
  focus_comunicacion_campo: MessageSquare,
  focus_regate: Footprints,
  focus_marca_defensa: Shield,
  focus_acciones_defensivas: Shield,
  focus_intensidad_fisica: Zap,
  focus_intensidad_fisico: Zap,
  focus_toma_decision: TargetIcon,
  focus_liderazgo: HandMetal,
  focus_seguridad_tranquilidad: Shield,
  focus_finta_enganche: Footprints,
  focus_mirar_espalda_levantar: HandMetal,
  focus_presion_tras_perdida: Zap,
};

const SATISFACTION_ICONS: Record<number, LucideIcon> = { 1: Angry, 2: Meh, 3: Laugh, 4: Smile, 5: Frown };

/** Intensidad de la escala 0–10: del verde suave al rojo, con colores que existen en claro y oscuro. */
function borgDot(n: number) {
  if (n <= 3) return 'bg-sky-500';
  if (n <= 6) return 'bg-amber-500';
  if (n <= 8) return 'bg-orange-500';
  return 'bg-red-600';
}

/** Una respuesta de un toque: fila grande, borde y fondo del tema. */
function Opcion({
  selected,
  onClick,
  children,
  leading,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-touch w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-colors motion-safe:active:scale-[0.98]',
        selected
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-card text-card-foreground hover:bg-muted',
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>
  );
}

function Pregunta({ n, titulo, opcional, children }: { n: number; titulo: string; opcional?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">
          Pregunta {n} de {TOTAL_QUESTIONS}
          {opcional && ' · opcional'}
        </p>
        <h2 className="mt-1 text-xl font-semibold md:text-2xl">{titulo}</h2>
      </div>
      {children}
    </div>
  );
}

export default function PostTrainingSelfEvalPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const childIdParam = searchParams.get('child_id');
  // Deportista que responde por su ficha vinculada (Inicio V2 → «¿Qué tan duro fue?»).
  // La RPC verifica que la ficha sea de esta cuenta; aquí solo se elige el sujeto.
  const fichaParam = childIdParam ? null : searchParams.get('ficha');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<EvalAnswers>(EMPTY_ANSWERS);
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [result, setResult] = useState<{ saved: number; streak: number; month_avg_borg: number | null } | null>(null);

  // ── Sesión + equipo + escuela + deporte ────────────────────────────────────
  const { data: ctx, isLoading, isError, refetch } = useQuery({
    queryKey: ['post-training-context', sessionId, childIdParam, fichaParam],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data: session, error: sErr } = await supabase
        .from('attendance_sessions')
        .select('id, school_id, team_id, session_date, finalized, teams(name), schools(category_id)')
        .eq('id', sessionId!)
        .single();
      if (sErr || !session) throw sErr || new Error('Sesión no encontrada');

      const sportCategoryId = (session as any).schools?.category_id ?? null;
      const teamName = (session as any).teams?.name ?? null;

      // Resolver sujeto: child_id de la URL, o buscar entre los hijos del padre
      // presentes en esta sesión, o el propio usuario si es deportista adulto.
      let childId = childIdParam;
      let childName: string | null = null;

      if (childId) {
        const { data: c } = await supabase.from('children').select('id, full_name').eq('id', childId).maybeSingle();
        childName = c?.full_name ?? null;
      } else if (user?.id && !fichaParam) {
        const { data: ownRecord } = await supabase
          .from('attendance_records')
          .select('id')
          .eq('session_id', sessionId!)
          .eq('user_id', user.id)
          .in('status', ['present', 'late'])
          .maybeSingle();

        if (!ownRecord) {
          const { data: kids } = await supabase
            .from('attendance_records')
            .select('child_id, children(id, full_name, parent_id)')
            .eq('session_id', sessionId!)
            .in('status', ['present', 'late'])
            .not('child_id', 'is', null);
          const mine = ((kids ?? []) as any[]).find((k) => k.children?.parent_id === user.id);
          childId = mine?.child_id ?? null;
          childName = mine?.children?.full_name ?? null;
        }
      }

      // Catálogo del deporte (solo lo que usa esta pantalla).
      const { data: metrics } = await supabase
        .from('sport_metric_definitions')
        .select('metric_key, display_name, min_value, max_value, options, is_active, category')
        .eq('sport_category_id', sportCategoryId)
        .eq('is_active', true);

      const focusItems = ((metrics ?? []) as any[])
        .filter((m) => m.metric_key.startsWith('focus_') && !['focus_nada', 'focus_other'].includes(m.metric_key))
        .map((m) => ({ key: m.metric_key as string, label: m.display_name as string }));

      // Contador social: cuántos de los presentes ya respondieron (rpe_borg).
      const { data: present } = await supabase
        .from('attendance_records')
        .select('child_id, user_id')
        .eq('session_id', sessionId!)
        .in('status', ['present', 'late']);

      const totalPresentes = (present ?? []).length;
      let yaRespondieron = 0;
      if (totalPresentes > 0) {
        const { count } = await supabase
          .from('performance_entries')
          .select('id', { count: 'exact', head: true })
          .eq('context_type', 'session')
          .eq('context_id', sessionId as string)
          .eq('metric_key', 'rpe_borg');
        yaRespondieron = count ?? 0;
      }

      return {
        session, teamName, sportCategoryId,
        subjectType: childId ? ('child' as const) : fichaParam ? ('unregistered' as const) : ('profile' as const),
        subjectId: childId || fichaParam || user?.id || null,
        childName,
        focusItems,
        totalPresentes, yaRespondieron,
      };
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (!sessionId || !ctx?.subjectId) throw new Error('Falta información de la sesión.');
      if (ctx.subjectType === 'unregistered') {
        // p_unregistered_athlete_id (migración 20261026155123) aún no está en types.ts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc('submit_post_training_self_eval', {
          p_session_id: sessionId,
          p_child_id: null,
          p_user_id: null,
          p_answers: buildPayload(answers),
          p_unregistered_athlete_id: ctx.subjectId,
        });
        if (error) throw error;
        return data as { saved: number; streak: number; month_avg_borg: number | null };
      }
      const { data, error } = await supabase.rpc('submit_post_training_self_eval', {
        p_session_id: sessionId,
        p_child_id: ctx.subjectType === 'child' ? ctx.subjectId : null,
        p_user_id: ctx.subjectType === 'profile' ? ctx.subjectId : null,
        p_answers: buildPayload(answers),
      });
      if (error) throw error;
      return data as { saved: number; streak: number; month_avg_borg: number | null };
    },
    onSuccess: (data) => {
      setResult(data);
      setStep(6);
    },
    onError: (err: unknown) => {
      toast({
        title: 'No se pudo guardar',
        description: err instanceof Error ? err.message : 'Intenta de nuevo.',
        variant: 'destructive',
      });
    },
  });

  /** Elegir y pasar a la siguiente: un toque por pregunta. */
  const elegir = (patch: Partial<EvalAnswers>, next: number) => {
    setAnswers((a) => ({ ...a, ...patch }));
    setStep(next);
  };

  const salir = () => {
    if (location.key !== 'default' && window.history.length > 1) navigate(-1);
    else navigate('/dashboard');
  };

  const shell = (children: ReactNode) => (
    <div className="min-h-screen-d bg-background text-foreground">
      <div className="mx-auto flex min-h-screen-d w-full max-w-page-narrow flex-col px-gutter pb-nav-safe pt-safe-t">
        {children}
      </div>
    </div>
  );

  if (isLoading) {
    return shell(
      <div role="status" aria-label="Cargando el entreno" className="flex flex-1 flex-col items-center justify-center gap-4 py-10">
        <div className="h-20 w-20 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        <div className="h-6 w-56 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        <div className="h-touch w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      </div>,
    );
  }

  if (isError) {
    return shell(
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden="true" />
        <p className="text-base font-semibold">No pudimos abrir este entreno.</p>
        <p className="max-w-prose-ui text-sm text-muted-foreground">Revisa tu conexión e intenta de nuevo. Si el enlace es viejo, puede que el entreno ya no exista.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button className="min-h-touch" onClick={() => refetch()}>Intentar de nuevo</Button>
          <Button variant="outline" className="min-h-touch" onClick={() => navigate('/dashboard')}>Ir al inicio</Button>
        </div>
      </div>,
    );
  }

  if (!ctx?.subjectId) {
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <p className="text-base font-semibold">No encontramos a qué deportista corresponde este entreno.</p>
        <p className="max-w-prose-ui text-sm text-muted-foreground">Puede que no haya quedado en la lista de ese día. Pregúntale al profe.</p>
        <Button variant="outline" className="min-h-touch" onClick={() => navigate('/dashboard')}>Ir al inicio</Button>
      </div>,
    );
  }

  const nombreCompleto = ctx.childName ?? (ctx.subjectType !== 'child' ? profile?.full_name ?? null : null);
  const nombre = nombreCompleto?.trim().split(/\s+/)[0] || null;
  const fecha = sessionDateLabel(ctx.session.session_date);

  return shell(
    <>
      {/* Barra superior: salir en la portada; pregunta anterior y avance en las preguntas. */}
      {step === 0 && (
        <div className="pt-3">
          <button
            type="button"
            onClick={salir}
            className="inline-flex min-h-touch items-center gap-2 rounded-lg pr-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Volver
          </button>
        </div>
      )}
      {step > 0 && step < 6 && (
        <div className="flex items-center gap-3 pt-3">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            aria-label="Pregunta anterior"
            className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground hover:bg-muted"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div
            className="flex flex-1 gap-1.5"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={TOTAL_QUESTIONS}
            aria-valuenow={step}
            aria-label={`Pregunta ${step} de ${TOTAL_QUESTIONS}`}
          >
            {Array.from({ length: TOTAL_QUESTIONS }, (_, i) => (
              <div key={i} className={cn('h-1.5 flex-1 rounded-full', i < step ? 'bg-primary' : 'bg-muted')} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-1 flex-col py-6">
        {/* Paso 0 — Portada: una frase y un botón */}
        {step === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
            <div
              className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-3xl font-semibold text-primary"
              aria-hidden="true"
            >
              {(nombre ?? 'D').charAt(0).toUpperCase()}
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold md:text-3xl">
                {nombre ? `¿Cómo te fue en el entreno, ${nombre}?` : '¿Cómo te fue en el entreno?'}
              </h1>
              <p className="text-sm text-muted-foreground">
                {[ctx.teamName, fecha].filter(Boolean).join(' · ')}
              </p>
            </div>
            {ctx.totalPresentes > 0 && (
              <span className="inline-flex items-center rounded-full bg-muted px-3 py-1 text-xs font-semibold text-foreground">
                Ya respondieron {ctx.yaRespondieron} de {ctx.totalPresentes} del equipo
              </span>
            )}
            <div className="w-full space-y-2 pt-2">
              <Button size="lg" className="min-h-touch h-12 w-full rounded-xl text-base font-semibold" onClick={() => setStep(1)}>
                Empezar
              </Button>
              <p className="text-xs text-muted-foreground">5 preguntas de un toque. Menos de 30 segundos. Tu profe lo ve para cuidar cuánto entrenas.</p>
            </div>
          </div>
        )}

        {/* Paso 1 — ¿Qué tan duro fue? (0 a 10) */}
        {step === 1 && (
          <Pregunta n={1} titulo="¿Qué tan duro fue el entreno?">
            <div role="radiogroup" aria-label="¿Qué tan duro fue?" className="space-y-1.5">
              {BORG_OPTIONS.map((o) => (
                <Opcion
                  key={o.value}
                  selected={answers.rpe_borg === o.value}
                  onClick={() => elegir({ rpe_borg: o.value }, 2)}
                  leading={
                    <span className="flex w-8 shrink-0 items-center gap-1.5">
                      <span className={cn('h-2.5 w-2.5 rounded-full', borgDot(o.value))} aria-hidden="true" />
                      <span className="text-base font-semibold tabular-nums">{o.value}</span>
                    </span>
                  }
                >
                  {o.label}
                </Opcion>
              ))}
            </div>
          </Pregunta>
        )}

        {/* Paso 2 — Comprensión */}
        {step === 2 && (
          <Pregunta n={2} titulo="¿Entendiste los ejercicios de hoy?">
            <div role="radiogroup" aria-label="¿Entendiste los ejercicios?" className="space-y-2">
              {COMPREHENSION_OPTIONS.map((o) => (
                <Opcion key={o.value} selected={answers.task_comprehension === o.value} onClick={() => elegir({ task_comprehension: o.value }, 3)}>
                  {o.label}
                </Opcion>
              ))}
            </div>
          </Pregunta>
        )}

        {/* Paso 3 — Esfuerzo */}
        {step === 3 && (
          <Pregunta n={3} titulo="¿Cuánto te esforzaste hoy?">
            <div role="radiogroup" aria-label="¿Cuánto te esforzaste?" className="space-y-2">
              {EFFORT_OPTIONS.map((o) => (
                <Opcion
                  key={o.value}
                  selected={answers.self_effort_pct === o.value}
                  onClick={() => elegir({ self_effort_pct: o.value }, 4)}
                  leading={<span className="w-12 shrink-0 text-base font-semibold tabular-nums">{o.value} %</span>}
                >
                  {o.label}
                </Opcion>
              ))}
            </div>
          </Pregunta>
        )}

        {/* Paso 4 — Cómo se sintió */}
        {step === 4 && (
          <Pregunta n={4} titulo="¿Cómo te sentiste al terminar?">
            <div role="radiogroup" aria-label="¿Cómo te sentiste?" className="space-y-2">
              {SATISFACTION_OPTIONS.map((o) => {
                const Icon = SATISFACTION_ICONS[o.value] ?? Meh;
                return (
                  <Opcion
                    key={o.value}
                    selected={answers.satisfaction === o.value}
                    onClick={() => elegir({ satisfaction: o.value }, 5)}
                    leading={<Icon className="h-5 w-5 shrink-0" aria-hidden="true" />}
                  >
                    {o.label}
                  </Opcion>
                );
              })}
            </div>
          </Pregunta>
        )}

        {/* Paso 5 — Qué mejorar (opcional, varias) */}
        {step === 5 && (
          <Pregunta n={5} titulo="¿Qué quieres mejorar la próxima vez?" opcional>
            <p className="-mt-2 text-sm text-muted-foreground">Elige las que quieras, o ninguna.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(ctx.focusItems ?? []).map(({ key, label }) => {
                const Icon = FOCUS_ICONS[key] ?? CircleDot;
                const selected = answers.focus.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setAnswers((a) => toggleFocus(a, key))}
                    className={cn(
                      'flex min-h-touch items-center gap-3 rounded-xl border px-4 py-2.5 text-left text-sm font-medium transition-colors',
                      selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-card-foreground hover:bg-muted',
                    )}
                  >
                    <Icon className={cn('h-5 w-5 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                    <span className="min-w-0 flex-1">{label}</span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={answers.focus.includes('focus_other')}
                onClick={() => {
                  setShowOtherInput(true);
                  setAnswers((a) => (a.focus.includes('focus_other') ? a : { ...a, focus: [...a.focus, 'focus_other'] }));
                }}
                className={cn(
                  'flex min-h-touch items-center justify-center gap-2 rounded-xl border border-dashed px-4 text-sm font-medium sm:col-span-2',
                  answers.focus.includes('focus_other') ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" /> Otra cosa
              </button>
            </div>
            {showOtherInput && answers.focus.includes('focus_other') && (
              <Textarea
                aria-label="¿Qué te gustaría mejorar?"
                placeholder="¿Qué te gustaría mejorar?"
                maxLength={200}
                value={answers.focus_other_text}
                onChange={(e) => setAnswers((a) => ({ ...a, focus_other_text: e.target.value }))}
                className="rounded-xl"
              />
            )}
            <div className="space-y-2 pt-2">
              <Button
                size="lg"
                disabled={submit.isPending}
                className="min-h-touch h-12 w-full rounded-xl text-base font-semibold"
                onClick={() => submit.mutate()}
              >
                {submit.isPending ? 'Guardando…' : 'Terminar'}
              </Button>
              {answers.focus.length > 0 && (
                <Button
                  variant="ghost"
                  className="min-h-touch w-full"
                  onClick={() => {
                    setShowOtherInput(false);
                    setAnswers((a) => ({ ...a, focus: [] }));
                  }}
                >
                  Hoy nada: quitar lo que elegí
                </Button>
              )}
            </div>
          </Pregunta>
        )}

        {/* Paso 6 — Listo */}
        {step === 6 && result && (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary">
              <PartyPopper className="h-9 w-9" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold">¡Listo! Tu profe ya lo ve.</h1>
              {result.streak > 1 && (
                <p className="text-sm text-muted-foreground">Llevas {result.streak} entrenos seguidos respondiendo.</p>
              )}
            </div>
            <div className="grid w-full grid-cols-2 gap-2">
              <div className="rounded-2xl border bg-card p-4 text-card-foreground">
                <p className="text-2xl font-semibold tabular-nums">{answers.rpe_borg} de 10</p>
                <p className="text-xs text-muted-foreground">Qué tan duro fue hoy</p>
              </div>
              <div className="rounded-2xl border bg-card p-4 text-card-foreground">
                <p className="text-2xl font-semibold tabular-nums">{result.month_avg_borg ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Promedio del mes</p>
              </div>
            </div>
            <Button size="lg" className="min-h-touch h-12 w-full rounded-xl text-base font-semibold" onClick={() => navigate('/')}>
              Cerrar
            </Button>
          </div>
        )}
      </div>
    </>,
  );
}
