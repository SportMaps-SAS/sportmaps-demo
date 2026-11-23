import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { DoorOpen, DoorClosed, ShieldX } from 'lucide-react';
import { formatHourBankMinutes } from '@/lib/hourBank';

/**
 * Reporte de ingresos/salidas de un estudiante — log crudo del torniquete +
 * visitas del banco de horas si la inscripción tiene plan de horas. Inline,
 * no modal. Usado desde el perfil del estudiante (SchoolStudentsManagementPage)
 * y desde cualquier otro lugar que necesite auditar el acceso de una persona.
 */

interface StudentReportEvent {
  direction: 'entry' | 'exit';
  access_granted: boolean;
  denial_reason: string | null;
  check_in_method: string;
  occurred_at: string;
}
interface StudentReportVisit {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  billed_minutes: number | null;
  auto_closed: boolean;
  /** Horas devueltas (día de evento o «No descontar»). Migración 20261123083815. */
  waived_minutes?: number | null;
  waive_reason?: string | null;
}
interface StudentReport {
  athlete_name: string;
  range: { from: string; to: string };
  no_turnstile_data: boolean;
  events: StudentReportEvent[];
  hour_bank: { has_hours_plan: boolean; visits?: StudentReportVisit[]; can_waive?: boolean };
}

const DENIAL_LABEL: Record<string, string> = {
  no_enrollment:      'Sin inscripción',
  payment_overdue:    'Pago vencido',
  enrollment_expired: 'Inscripción vencida',
  unknown_user:       'Usuario desconocido',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });
}

const ESTADO_VISITA: Record<string, string> = {
  open: 'en curso',
  closed: 'cerrada',
  corrected: 'corregida',
  pending_review: 'pendiente revisión',
};

export function StudentReportPanel({ enrollmentId }: { enrollmentId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // «No descontar»: la visita que se está devolviendo y su motivo.
  const [devolviendo, setDevolviendo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const devolver = async (visitId: string) => {
    setGuardando(true);
    try {
      const r = await bffClient.post<{ minutes: number; overage_confirmed: boolean }>(
        `/api/v1/access/hour-bank-visits/${visitId}/waive`, { reason: motivo.trim() });
      toast({
        title: 'Horas devueltas',
        description: `Se devolvieron ${formatHourBankMinutes(r.minutes)} al plan.`
          + (r.overage_confirmed ? ' Ojo: ya hay un cobro de horas de más generado; revísalo en Cobros.' : ''),
      });
      setDevolviendo(null);
      setMotivo('');
      queryClient.invalidateQueries({ queryKey: ['student-report', enrollmentId] });
      queryClient.invalidateQueries({ queryKey: ['hour-bank-balances'] });
      queryClient.invalidateQueries({ queryKey: ['hour-bank-balance'] });
      queryClient.invalidateQueries({ queryKey: ['hour-bank-overage-charges'] });
    } catch (err) {
      toast({ title: 'No se pudo devolver', description: err instanceof BFFError ? err.message : 'Intenta de nuevo', variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['student-report', enrollmentId],
    queryFn: () => bffClient.get<StudentReport>(`/api/v1/access/student-report/${enrollmentId}`),
    staleTime: 30_000,
  });

  if (isLoading) return <p className="text-xs text-muted-foreground py-3">Cargando reporte...</p>;
  if (!data) return <p className="text-xs text-muted-foreground py-3">No se pudo cargar el reporte.</p>;

  return (
    <div className="py-3 space-y-3 border-t border-border/30 mt-2">
      <p className="text-[10px] text-muted-foreground">
        Últimos 30 días ({data.range.from} — {data.range.to})
      </p>

      {data.no_turnstile_data ? (
        <p className="text-xs text-muted-foreground italic">
          Esta inscripción es de un menor sin cuenta propia (`children`) — el circuito de torniquete no lo trackea, sin datos de ingreso/salida acá.
        </p>
      ) : data.events.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sin eventos de torniquete en el rango.</p>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {data.events.map((e, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              {!e.access_granted
                ? <ShieldX className="h-3 w-3 text-destructive shrink-0" />
                : e.direction === 'entry'
                  ? <DoorOpen className="h-3 w-3 text-green-500 shrink-0" />
                  : <DoorClosed className="h-3 w-3 text-blue-500 shrink-0" />
              }
              <span className="text-muted-foreground">{fmtDateTime(e.occurred_at)}</span>
              <span>{e.direction === 'entry' ? 'Entrada' : 'Salida'}</span>
              {!e.access_granted && e.denial_reason && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 py-0 border-destructive/30 text-destructive">
                  {DENIAL_LABEL[e.denial_reason] ?? e.denial_reason}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {data.hour_bank.has_hours_plan && (data.hour_bank.visits?.length ?? 0) > 0 && (
        <div className="pt-2 border-t border-border/20">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Visitas del banco de horas
          </p>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {data.hour_bank.visits!.map((v) => {
              const devuelta = (v.waived_minutes ?? 0) > 0;
              const puedeDevolver = !!data.hour_bank.can_waive && !devuelta
                && (v.billed_minutes ?? 0) > 0 && (v.status === 'closed' || v.status === 'corrected');
              return (
                <div key={v.id} className="text-xs" data-testid={`hb-visita-${v.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">
                      {fmtDateTime(v.started_at)}{v.ended_at ? ` — ${fmtDateTime(v.ended_at)}` : ' (en curso)'}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {devuelta
                        ? <span className="font-semibold text-emerald-700 dark:text-emerald-400">No descontó horas</span>
                        : v.billed_minutes != null && <span className="font-semibold">{formatHourBankMinutes(v.billed_minutes)}</span>}
                      <Badge variant="outline" className="text-[9px] h-4 px-1 py-0">
                        {ESTADO_VISITA[v.status] ?? v.status}
                      </Badge>
                      {puedeDevolver && devolviendo !== v.id && (
                        <Button
                          size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                          onClick={() => { setDevolviendo(v.id); setMotivo(''); }}
                        >
                          No descontar
                        </Button>
                      )}
                    </span>
                  </div>
                  {devuelta && v.waive_reason && (
                    <p className="text-[11px] text-muted-foreground">Motivo: {v.waive_reason}</p>
                  )}
                  {devolviendo === v.id && (
                    <div className="flex flex-wrap items-center gap-2 py-1.5">
                      <Input
                        autoFocus value={motivo} maxLength={120} className="h-8 flex-1 min-w-40 text-xs"
                        aria-label="Motivo para no descontar" placeholder="Motivo (ej.: celebración de Halloween)"
                        onChange={(e) => setMotivo(e.target.value)}
                      />
                      <Button size="sm" className="h-8" disabled={guardando || motivo.trim().length < 3} onClick={() => devolver(v.id)}>
                        Devolver {formatHourBankMinutes(v.billed_minutes ?? 0)}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8" disabled={guardando} onClick={() => setDevolviendo(null)}>
                        Cancelar
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
