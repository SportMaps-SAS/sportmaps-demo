import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import { formatHourBankMinutes as formatMinutes } from '@/lib/hourBank';

/**
 * F6 — docs/specs/dreamers-banco-de-horas-torniquete.md
 *
 * Muestra el saldo del banco de horas de UNA inscripción (incluidas /
 * reservadas / consumidas / disponibles). No renderiza NADA si la inscripción
 * no tiene un plan de horas (`has_hours_plan: false`) — así es seguro montarlo
 * en cualquier vista de cualquier escuela sin afectar a las que no usan esto.
 *
 * `showHistory` (default false): agrega un toggle "Ver histórico" con los
 * períodos (meses) anteriores — "validación de gastos por el mes" del perfil
 * del estudiante. Apagado por defecto para no meterle ruido a la vista del
 * padre/atleta (MyEnrollmentsPage), que solo necesita el saldo de hoy.
 */

export interface HourBankBalance {
  has_hours_plan: boolean;
  period_id?: string;
  period_start?: string;
  period_end?: string;
  included_minutes?: number;
  reserved_minutes?: number;
  consumed_minutes?: number;
  available_minutes?: number;
}

interface HourBankPeriod {
  id: string;
  period_start: string;
  period_end: string;
  included_minutes: number;
  reserved_minutes: number;
  consumed_minutes: number;
  available_minutes: number;
}

function fmtDate(d?: string): string {
  if (!d) return '';
  return format(parseISO(d), "d 'de' MMM", { locale: es });
}

function HistoryPanel({ enrollmentId }: { enrollmentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['hour-bank-periods', enrollmentId],
    queryFn: () => bffClient.get<{ periods: HourBankPeriod[] }>(`/api/v1/access/hour-bank-periods/${enrollmentId}`),
    staleTime: 60_000,
  });

  if (isLoading) return <p className="text-xs text-muted-foreground py-2">Cargando histórico...</p>;

  const periods = data?.periods ?? [];
  if (periods.length === 0) return <p className="text-xs text-muted-foreground py-2">Sin períodos todavía.</p>;

  return (
    <div className="pt-2 border-t border-border/20 space-y-1">
      {periods.map((p) => {
        const over = p.available_minutes < 0;
        return (
          <div key={p.id} className="flex items-center justify-between text-xs py-1">
            <span className="text-muted-foreground">{fmtDate(p.period_start)} — {fmtDate(p.period_end)}</span>
            <span className={`font-semibold ${over ? 'text-red-600' : ''}`}>
              {formatMinutes(p.consumed_minutes + p.reserved_minutes)} / {formatMinutes(p.included_minutes)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function HourBankBalanceCard({ enrollmentId, showHistory = false, fetcher, retry }: {
  enrollmentId: string;
  showHistory?: boolean;
  // Quien agenda sin cuenta desde el link público no tiene sesión de Supabase
  // — no puede pegarle a /api/v1/access (requireAuth). Pasar un fetcher
  // reemplaza SOLO cómo se trae el dato; el resto de la tarjeta (formato,
  // colores, barra de progreso) es idéntico en los dos casos.
  fetcher?: () => Promise<HourBankBalance>;
  // Opcional: política de reintento propia de la consulta. Sin ella se usa el
  // default del QueryClient (comportamiento anterior intacto). El link público
  // la usa para no reintentar cuando la escuela apagó el link (422).
  retry?: (failureCount: number, error: unknown) => boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['hour-bank-balance', enrollmentId, fetcher ? 'public' : 'auth'],
    queryFn: fetcher ?? (() => bffClient.get<HourBankBalance>(`/api/v1/access/hour-bank-balance/${enrollmentId}`)),
    enabled: !!enrollmentId,
    staleTime: 60_000,
    ...(retry ? { retry } : {}),
  });

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }

  // La consulta falló de verdad (red, permisos, 500) — esto es distinto de "no
  // tiene plan de horas" y antes se veían exactamente igual (nada), sin pista
  // de que algo se rompió. Ahora se avisa en vez de desaparecer en silencio.
  if (isError) {
    return (
      <p className="text-xs text-destructive/80 py-2">
        No se pudo cargar el banco de horas{error instanceof BFFError ? `: ${error.message}` : ''}.
      </p>
    );
  }

  // Sin plan de horas (el caso normal para casi todas las escuelas) — no
  // renderizar nada, no un estado vacío.
  if (!data?.has_hours_plan) return null;

  const included = data.included_minutes ?? 0;
  const reserved = data.reserved_minutes ?? 0;
  const consumed = data.consumed_minutes ?? 0;
  const available = data.available_minutes ?? 0;

  const usedPct = included > 0 ? Math.min(100, ((reserved + consumed) / included) * 100) : 0;
  const isLow = available <= included * 0.15;
  const isOver = available < 0;

  return (
    <Card className="border-l-4" style={{ borderLeftColor: isOver ? '#ef4444' : isLow ? '#f59e0b' : '#22c55e' }}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-bold">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Banco de horas
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className={`text-2xl font-black ${isOver ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-foreground'}`}>
            {formatMinutes(available)}
          </span>
          <span className="text-xs text-muted-foreground">disponibles</span>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full ${isOver ? 'bg-red-500' : isLow ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${usedPct}%` }}
          />
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Incluidas: {formatMinutes(included)}</span>
          {reserved > 0 && <span>Reservadas: {formatMinutes(reserved)}</span>}
          <span>Consumidas: {formatMinutes(consumed)}</span>
        </div>

        {data.period_start && data.period_end && (
          <p className="text-[10px] text-muted-foreground">
            Período: {fmtDate(data.period_start)} — {fmtDate(data.period_end)}
          </p>
        )}

        {isOver && (
          <p className="text-[11px] font-medium text-red-600">
            Saldo excedido — habla con la escuela para completar horas.
          </p>
        )}

        {showHistory && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-0 text-[11px] text-muted-foreground"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
              Ver histórico de meses
            </Button>
            {historyOpen && <HistoryPanel enrollmentId={enrollmentId} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
