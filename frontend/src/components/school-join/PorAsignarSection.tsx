/**
 * «Código de la escuela» + bandeja «Por asignar (N)» en Atletas.
 * Spec docs/specs/codigo-de-escuela-union-por-codigo.md — D1 (solo solicitudes
 * por código; los prospectos van en la pestaña «Clase de prueba»), D2 (la sede
 * se elige al asignar), D3 (solo administración), D4 (regla de cobro de la escuela).
 *
 * Asignar NO crea la inscripción en la base por su cuenta: la RPC
 * resolve_school_join_request crea/vincula la ficha y, si falta, la inscripción
 * se hace con POST /api/v1/students/create-one — el mismo alta de «Agregar
 * atleta» (create_enrollment_with_payments) —, y luego se amarra con
 * confirm_school_join_request_enrollment. Si ese paso falla, la solicitud queda
 * en la bandeja como «Falta inscribir» para reintentar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  ChevronDown, ChevronUp, Inbox, Loader2, UserCheck, Link2, XCircle, MessageCircle, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { todayColombia } from '@/lib/dateUtils';
import { schoolJoinApi } from '@/lib/api/schoolJoin';
import {
  ageOn, buildEnrollPayload, buildPorAsignarInbox, joinErrorMessage,
  type JoinRequestRow,
} from '@/lib/schoolJoinCode';
import { SchoolJoinCodeCard } from './SchoolJoinCodeCard';
import { SoportesBloqueoDialog, bloqueoDesdeError, type BloqueoSoportes } from '@/components/soportes/SoportesBloqueoDialog';
import { useReferidoAlta } from '@/components/referidos/ReferidoAlta';

interface TeamOpt { id: string; name: string; branch_id: string | null; price_monthly: number | null }
interface PlanOpt { id: string; name: string; price: number | null; offering_id: string; offering_name: string }
interface BranchOpt { id: string; name: string }

type DialogMode = 'assign' | 'link' | 'enroll';
interface DialogState { mode: DialogMode; row: JoinRequestRow }

const NONE = 'none';

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
        .toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

const waLink = (phone: string | null) => {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits.length === 10 ? `57${digits}` : digits}`;
};

export function PorAsignarSection({
  schoolId, schoolName, branches, prospectos, onVerProspectos,
}: {
  schoolId: string;
  schoolName: string;
  branches: BranchOpt[];
  /** Prospectos abiertos de la pestaña «Clase de prueba» (solo para el enlace). */
  prospectos: number;
  onVerProspectos: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const fromNotification = searchParams.get('bandeja') === 'por-asignar';
  const [open, setOpen] = useState(fromNotification);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [rejecting, setRejecting] = useState<JoinRequestRow | null>(null);
  // La inscripción quedó creada pero la confirmación espera a los soportes (SP001).
  const [bloqueo, setBloqueo] = useState<{ requestId: string; info: BloqueoSoportes } | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const autoOpened = useRef(false);

  const requestsQ = useQuery({
    queryKey: ['school-join-requests', schoolId],
    queryFn: () => schoolJoinApi.list(schoolId),
    enabled: !!schoolId,
    retry: false,
  });
  const teamsQ = useQuery({
    queryKey: ['por-asignar-teams', schoolId],
    queryFn: async (): Promise<TeamOpt[]> => {
      const { data, error } = await supabase
        .from('teams')
        .select('id, name, branch_id, price_monthly, active')
        .eq('school_id', schoolId)
        .order('name');
      if (error) return [];
      return ((data ?? []) as any[]).filter((t) => t.active !== false) as TeamOpt[];
    },
    enabled: !!schoolId && !!dialog,
  });
  const plansQ = useQuery({
    queryKey: ['por-asignar-plans', schoolId],
    queryFn: async (): Promise<PlanOpt[]> => {
      const { data, error } = await (supabase as any)
        .from('offering_plans')
        .select('id, name, price, offering_id, offerings!offering_plans_offering_id_fkey(name)')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .order('name');
      if (error) return [];
      return ((data ?? []) as any[])
        .filter((p) => p.offering_id)
        .map((p) => ({
          id: p.id, name: p.name, price: p.price ?? null,
          offering_id: p.offering_id, offering_name: p.offerings?.name ?? '',
        }));
    },
    enabled: !!schoolId && !!dialog,
  });

  const items = useMemo(() => buildPorAsignarInbox(requestsQ.data), [requestsQ.data]);
  const count = items.length;

  // Se abre sola la primera vez que hay algo por asignar.
  useEffect(() => {
    if (count > 0 && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [count]);

  useEffect(() => {
    if (fromNotification) sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [fromNotification]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['school-join-requests', schoolId] });
    qc.invalidateQueries({ queryKey: ['school-students'] });
  };

  // Sin la migración aplicada (o sin permiso) la sección no aparece: no rompe Atletas.
  if (requestsQ.error) return null;

  const today = todayColombia();

  return (
    <div ref={sectionRef} id="por-asignar">
      <Card>
        <CardHeader className="pb-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={open}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Inbox className="h-5 w-5 text-primary shrink-0" />
              <span className="font-semibold">Por asignar</span>
              <Badge variant={count > 0 ? 'default' : 'secondary'}>{requestsQ.isLoading ? '…' : count}</Badge>
              <span className="hidden sm:inline text-sm text-muted-foreground truncate">
                · Familias que ingresaron el código de la escuela
              </span>
            </div>
            {open ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
          </button>
        </CardHeader>

        {open && (
          <CardContent className="space-y-4">
            <SchoolJoinCodeCard schoolId={schoolId} schoolName={schoolName} />

            {requestsQ.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando solicitudes…
              </div>
            ) : count === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay nadie esperando. Cuando una familia ingrese el código de la escuela, aparecerá aquí.
              </p>
            ) : (
              <ul className="space-y-3">
                {items.map((row) => (
                  <RequestRow
                    key={row.id}
                    row={row}
                    today={today}
                    onAssign={() => setDialog({ mode: 'assign', row })}
                    onLink={() => setDialog({ mode: 'link', row })}
                    onEnroll={() => setDialog({ mode: 'enroll', row })}
                    onReject={() => setRejecting(row)}
                  />
                ))}
              </ul>
            )}

            {prospectos > 0 && (
              <button
                type="button"
                onClick={onVerProspectos}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50"
              >
                <span>
                  {prospectos === 1 ? 'Hay 1 prospecto' : `Hay ${prospectos} prospectos`} de WhatsApp y del formulario
                  en «Clase de prueba».
                </span>
                <ArrowRight className="h-4 w-4 shrink-0" />
              </button>
            )}
          </CardContent>
        )}
      </Card>

      {dialog && (
        <AssignDialog
          state={dialog}
          schoolId={schoolId}
          teams={teamsQ.data ?? []}
          plans={plansQ.data ?? []}
          branches={branches}
          loadingOptions={teamsQ.isLoading || plansQ.isLoading}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); refresh(); }}
          onBloqueo={(b) => { setDialog(null); refresh(); setBloqueo(b); }}
        />
      )}

      {bloqueo && (
        <SoportesBloqueoDialog
          schoolId={schoolId}
          info={bloqueo.info}
          onClose={() => setBloqueo(null)}
          onReintentar={() => schoolJoinApi.confirmEnrollment(bloqueo.requestId)}
          onConfirmado={() => {
            toast({ title: 'Listo', description: `${bloqueo.info.athleteName} quedó confirmado. La familia recibe un aviso.` });
            setBloqueo(null);
            refresh();
          }}
        />
      )}

      {rejecting && (
        <RejectDialog
          row={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => { setRejecting(null); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Filas ───────────────────────────────────────────────────────────────────

function RequestRow({
  row, today, onAssign, onLink, onEnroll, onReject,
}: {
  row: JoinRequestRow;
  today: string;
  onAssign: () => void;
  onLink: () => void;
  onEnroll: () => void;
  onReject: () => void;
}) {
  const age = ageOn(row.birth_date, today);
  const wa = waLink(row.requester_phone);
  const pending = row.status === 'pending';
  const { toast } = useToast();
  const qc = useQueryClient();
  const [vinculando, setVinculando] = useState<string | null>(null);
  const exactas = pending ? (row.exact_matches ?? []) : [];

  // Vincula por documento o correo EXACTOS (el servidor lo vuelve a exigir). Nunca por nombre.
  const vincular = async (m: NonNullable<JoinRequestRow['exact_matches']>[number]) => {
    setVinculando(m.id);
    try {
      const res = await schoolJoinApi.vincular({ requestId: row.id, fichaId: m.id, source: m.source });
      toast({ title: 'Ficha vinculada', description: `${res.athlete_name} quedó con su familia, con su equipo y sus cobros.` });
      qc.invalidateQueries({ queryKey: ['school-join-requests'] });
      qc.invalidateQueries({ queryKey: ['school-students'] });
    } catch (e) {
      toast({ title: 'No se pudo vincular', description: joinErrorMessage(e), variant: 'destructive' });
    } finally {
      setVinculando(null);
    }
  };
  return (
    <li className="rounded-lg border p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium leading-tight">
            {row.athlete_name}
            {age !== null && <span className="text-muted-foreground font-normal"> · {age} años</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {row.for_whom === 'child'
              ? <>Acudiente: {row.requester_name || row.requester_email || 'sin nombre'}</>
              : <>Se inscribe con su propia cuenta</>}
            {' · '}pidió el {fmtDate(row.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">Por código</Badge>
          {!pending && <Badge variant="destructive">Falta inscribir</Badge>}
        </div>
      </div>

      {pending && (
        <p className="text-xs text-muted-foreground">
          Documento que escribió la familia:{' '}
          {row.athlete_doc_number
            ? <strong className="font-mono">{row.athlete_doc_type ? `${row.athlete_doc_type} ` : ''}{row.athlete_doc_number}</strong>
            : <span className="text-amber-700 dark:text-amber-400">no lo tenía a la mano — pídaselo antes de vincular.</span>}
        </p>
      )}
      {exactas.map((m) => (
        <div key={m.id} className="rounded-md border border-emerald-600/40 bg-emerald-50/50 dark:bg-emerald-950/20 p-2 space-y-1.5">
          <p className="text-sm">
            Coincide por <strong>{m.basis === 'documento' ? 'documento' : 'correo'}</strong> con la ficha{' '}
            <strong>{m.full_name}</strong>{m.team_name ? ` (${m.team_name})` : ''}.
          </p>
          {m.basis === 'correo' && (
            <p className="text-xs text-muted-foreground">
              Es el correo de la cuenta, no el documento. Confírmelo con la familia si tiene dudas.
            </p>
          )}
          <Button size="sm" disabled={!!vinculando} onClick={() => void vincular(m)} className="gap-1.5">
            {vinculando === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Vincular con esta ficha
          </Button>
        </div>
      ))}
      {row.suggested_category && (
        <p className="text-sm">Categoría que sugiere la familia: <strong>{row.suggested_category}</strong></p>
      )}
      {!pending && row.team_name && (
        <p className="text-sm">Asignado a <strong>{row.team_name}</strong>. Falta crear la inscripción y su cobro.</p>
      )}
      {pending && row.candidates.length > 0 && (
        <p className="text-xs flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          Hay fichas con un nombre parecido ({row.candidates.map((c) => c.full_name).join(', ')}). Es solo una pista: no se vincula por nombre.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <Button size="sm" onClick={onAssign} className="gap-1.5">
              <UserCheck className="h-4 w-4" /> Asignar
            </Button>
            {row.for_whom === 'child' && row.candidates.length > 0 && (
              <Button size="sm" variant="outline" onClick={onLink} className="gap-1.5">
                <Link2 className="h-4 w-4" /> Ya tiene ficha
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onReject} className="gap-1.5 text-destructive">
              <XCircle className="h-4 w-4" /> Rechazar
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onEnroll} className="gap-1.5">
            <UserCheck className="h-4 w-4" /> {row.has_enrollment ? 'Marcar como inscrito' : 'Inscribir'}
          </Button>
        )}
        {wa && (
          <Button asChild size="sm" variant="ghost" className="gap-1.5">
            <a href={wa} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 text-emerald-600" /> WhatsApp</a>
          </Button>
        )}
      </div>
    </li>
  );
}

// ─── Asignar / vincular / inscribir ──────────────────────────────────────────

function AssignDialog({
  state, schoolId, teams, plans, branches, loadingOptions, onClose, onDone, onBloqueo,
}: {
  state: DialogState;
  schoolId: string;
  teams: TeamOpt[];
  plans: PlanOpt[];
  branches: BranchOpt[];
  loadingOptions: boolean;
  onClose: () => void;
  onDone: () => void;
  onBloqueo: (b: { requestId: string; info: BloqueoSoportes }) => void;
}) {
  const { toast } = useToast();
  const referido = useReferidoAlta(schoolId);
  const { mode, row } = state;
  const [teamId, setTeamId] = useState<string>(mode === 'enroll' ? (row.assigned_team_id ?? '') : '');
  const [branchId, setBranchId] = useState<string>(mode === 'enroll' ? (row.assigned_branch_id ?? '') : '');
  const [planId, setPlanId] = useState<string>(NONE);
  const [startDate, setStartDate] = useState<string>(todayColombia());
  const [childId, setChildId] = useState<string>(row.candidates[0]?.id ?? '');
  const [saving, setSaving] = useState(false);

  const team = teams.find((t) => t.id === teamId) ?? null;
  const plan = plans.find((p) => p.id === planId) ?? null;
  const onlyConfirm = mode === 'enroll' && row.has_enrollment;
  const teamRequired = mode !== 'link';

  // La sede por defecto es la del equipo (D2: se elige al asignar).
  useEffect(() => {
    if (mode !== 'enroll' && team?.branch_id) setBranchId(team.branch_id);
  }, [team?.branch_id, mode]);

  const title =
    mode === 'assign' ? `Asignar a ${row.athlete_name}`
    : mode === 'link' ? `Vincular a ${row.athlete_name} con su ficha`
    : onlyConfirm ? `Marcar a ${row.athlete_name} como inscrito` : `Inscribir a ${row.athlete_name}`;

  const canSave =
    !saving &&
    (!teamRequired || !!teamId) &&
    (mode !== 'link' || !!childId) &&
    /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  const submit = async () => {
    setSaving(true);
    let step: 'resolve' | 'enroll' = 'resolve';
    try {
      let target = {
        childId: row.child_id,
        userId: row.for_whom === 'self' ? row.requester_profile_id : null,
      };
      let needsEnrollment = mode === 'enroll' ? !row.has_enrollment : false;

      if (mode !== 'enroll') {
        const res = await schoolJoinApi.resolve({
          requestId: row.id,
          action: mode,
          teamId: teamId || null,
          branchId: branchId || null,
          childId: mode === 'link' ? childId : null,
        });
        target = { childId: res.child_id ?? null, userId: res.user_id ?? target.userId };
        needsEnrollment = !!res.needs_enrollment;
      }

      if (needsEnrollment && teamId) {
        step = 'enroll';
        await schoolJoinApi.enrollViaCreateOne(schoolId, buildEnrollPayload({
          forWhom: row.for_whom,
          childId: target.childId,
          userId: target.userId,
          teamId,
          branchId: branchId || null,
          startDate,
          plan: plan ? { id: plan.id, offeringId: plan.offering_id, price: plan.price } : null,
          teamPrice: team?.price_monthly ?? null,
        }));
      }
      // Referido: DESPUÉS de crear la inscripción. Un fallo aquí no deshace el alta.
      const sujetoAlta = target.childId
        ? { tipo: 'child' as const, id: target.childId }
        : target.userId ? { tipo: 'profile' as const, id: target.userId } : null;
      if (teamId && sujetoAlta) await referido.registrarTras({ ...sujetoAlta, nombre: row.athlete_name });

      if (teamId) {
        try {
          await schoolJoinApi.confirmEnrollment(row.id);
        } catch (err) {
          // Antes se tragaba todo. El bloqueo por soportes (SP001) SÍ se muestra:
          // la inscripción ya existe, solo la confirmación espera. Lo demás sigue
          // como antes (la solicitud queda en la bandeja para reintentar).
          const b = bloqueoDesdeError(err, row.athlete_name, sujetoAlta);
          if (b) {
            toast({
              title: 'Inscripción creada, falta confirmar',
              description: 'Faltan soportes del deportista. Súbelos y confirma desde el aviso.',
            });
            onBloqueo({ requestId: row.id, info: b });
            return;
          }
        }
      }

      toast({
        title: mode === 'link' ? 'Ficha vinculada' : 'Listo',
        description: teamId
          ? `${row.athlete_name} quedó en ${team?.name ?? 'el equipo'}. La familia recibe un aviso.`
          : `${row.athlete_name} quedó vinculado a su familia.`,
      });
      onDone();
    } catch (e) {
      if (step === 'enroll') {
        toast({
          title: 'Quedó asignado, pero falta la inscripción',
          description: `${joinErrorMessage(e)} Reintenta desde «Por asignar» → Inscribir.`,
          variant: 'destructive',
        });
        onDone();
      } else {
        toast({ title: 'No se pudo completar', description: joinErrorMessage(e), variant: 'destructive' });
        setSaving(false);
      }
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === 'link'
              ? 'La cuenta de la familia queda como acudiente de la ficha que ya existe. No se crea otra.'
              : 'El entrenador es el del equipo. La inscripción y el primer cobro siguen la regla de cobro de la escuela, igual que en «Agregar atleta».'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === 'link' && (
            <div className="space-y-2">
              <Label>¿Cuál es su ficha?</Label>
              <RadioGroup value={childId} onValueChange={setChildId} className="space-y-2">
                {row.candidates.map((c) => (
                  <label key={c.id} className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
                    <RadioGroupItem value={c.id} className="mt-0.5" />
                    <span className="text-sm">
                      <span className="font-medium">{c.full_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {c.date_of_birth ? `Nació el ${fmtDate(c.date_of_birth)}` : 'Sin fecha de nacimiento'}
                        {c.team_name ? ` · ${c.team_name}` : ''}
                      </span>
                      {c.same_birth_date && <Badge variant="secondary" className="mt-1">Misma fecha de nacimiento</Badge>}
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <p className="text-xs text-muted-foreground">
                La familia dijo: nació el {fmtDate(row.birth_date)}.
              </p>
            </div>
          )}

          {!onlyConfirm && (
            <>
              <div className="space-y-2">
                <Label>Equipo (categoría){teamRequired ? ' *' : ' — opcional'}</Label>
                <Select value={teamId || NONE} onValueChange={(v) => setTeamId(v === NONE ? '' : v)} disabled={mode === 'enroll'}>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingOptions ? 'Cargando equipos…' : 'Elige el equipo'} />
                  </SelectTrigger>
                  <SelectContent>
                    {!teamRequired && <SelectItem value={NONE}>Sin equipo por ahora</SelectItem>}
                    {teamRequired && !teamId && <SelectItem value={NONE} disabled>Elige el equipo</SelectItem>}
                    {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    {mode === 'enroll' && row.assigned_team_id && !teams.some((t) => t.id === row.assigned_team_id) && (
                      <SelectItem value={row.assigned_team_id}>{row.team_name ?? 'Equipo asignado'}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {row.suggested_category && (
                  <p className="text-xs text-muted-foreground">La familia sugiere: {row.suggested_category}</p>
                )}
              </div>

              {branches.length > 1 && (
                <div className="space-y-2">
                  <Label>Sede</Label>
                  <Select value={branchId || NONE} onValueChange={(v) => setBranchId(v === NONE ? '' : v)} disabled={mode === 'enroll'}>
                    <SelectTrigger><SelectValue placeholder="Elige la sede" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sin sede</SelectItem>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {!!teamId && (
                <>
                  {plans.length > 0 && (
                    <div className="space-y-2">
                      <Label>Plan — opcional</Label>
                      <Select value={planId} onValueChange={setPlanId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Sin plan (cuota del equipo)</SelectItem>
                          {plans.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.offering_name ? `${p.offering_name} · ` : ''}{p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label>Fecha de inicio</Label>
                    <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </div>
                </>
              )}
            </>
          )}

          {onlyConfirm && (
            <p className="text-sm text-muted-foreground">
              Ya tiene una inscripción activa en la escuela. Solo falta sacarlo de la bandeja; no se crea otro cobro.
            </p>
          )}

          {/* Solo con la campaña de referidos activa; se registra tras crear la inscripción. */}
          {!onlyConfirm && mode !== 'link' && !!teamId && referido.campo}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {mode === 'link' ? 'Vincular' : onlyConfirm ? 'Marcar inscrito' : mode === 'enroll' ? 'Inscribir' : 'Asignar'}
          </Button>
        </DialogFooter>
      </DialogContent>
      {referido.dialogo}
    </Dialog>
  );
}

function RejectDialog({
  row, onClose, onDone,
}: {
  row: JoinRequestRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await schoolJoinApi.resolve({ requestId: row.id, action: 'reject', reason: reason.trim() || null });
      toast({ title: 'Solicitud rechazada', description: 'La familia recibe un aviso.' });
      onDone();
    } catch (e) {
      toast({ title: 'No se pudo rechazar', description: joinErrorMessage(e), variant: 'destructive' });
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rechazar la solicitud de {row.athlete_name}</DialogTitle>
          <DialogDescription>La familia verá el motivo, si lo escribes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Motivo — opcional</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            rows={3}
            placeholder="Ej.: no tenemos cupo en esa categoría este semestre."
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Rechazar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
