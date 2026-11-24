import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { HourBankOverageCharges } from './HourBankOverageCharges';
import { HourBankEventDays } from './HourBankEventDays';

/**
 * F6 — docs/specs/dreamers-banco-de-horas-torniquete.md
 *
 * Bandeja de revisión de visitas `pending_review` del banco de horas (solo
 * owner puede corregir, D-8 — el BFF lo hace cumplir; acá solo se oculta la
 * bandeja si el 403 llega, no se duplica la regla).
 *
 * El saldo por atleta y el reporte de ingresos/salidas se sacaron de acá
 * (2026-08-27) — con 50 estudiantes, un listado plano en Control de Acceso
 * (pantalla de monitoreo operativo del día) no escala y estorba. Ahora viven
 * en el perfil de cada estudiante, en Estudiantes (`HourBankBalanceCard` +
 * `StudentReportPanel`). Esto sí se queda acá: es una bandeja de pendientes
 * por resolver, no un reporte — encaja con el propósito operativo de la
 * pantalla.
 *
 * No renderiza la bandeja si no hay visitas pendientes de revisión. Debajo va
 * la sección de cargos por horas de más (F-E), que se oculta sola si no aplica.
 */

interface PendingVisit {
  id: string;
  enrollment_id: string;
  started_at: string;
  ended_at: string | null;
  auto_closed: boolean;
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CorrectVisitRow({ visit, onDone }: { visit: PendingVisit; onDone: () => void }) {
  const { toast } = useToast();
  // Default a "ahora", no a started_at: si el owner no toca el campo y
  // confirma tal cual, started_at truncado a minuto (el input datetime-local
  // pierde los segundos) quedaba IGUAL o DESPUÉS del started_at real con
  // segundos -- el backend lo rechazaba con "ended_at no puede ser anterior
  // a started_at" en cualquier visita auto-cerrada (ended_at null) que el
  // owner confirmara sin editar la hora, que es el caso normal de uso.
  const [endedAt, setEndedAt] = useState(() => toLocalInputValue(visit.ended_at ?? new Date().toISOString()));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      await bffClient.patch(`/api/v1/access/hour-bank-visits/${visit.id}/correct`, {
        ended_at: new Date(endedAt).toISOString(),
      });
      toast({ title: 'Visita corregida', description: 'Se aplicó el descuento del banco de horas.' });
      onDone();
    } catch (err) {
      toast({
        title: 'No se pudo corregir',
        description: err instanceof BFFError ? err.message : 'Error inesperado',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 py-2 border-b border-border/30 last:border-0">
      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      <span className="text-xs flex-1 min-w-28">
        Entrada: {new Date(visit.started_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
        {visit.auto_closed && <Badge variant="outline" className="ml-2 text-[9px]">auto-cerrada</Badge>}
      </span>
      <Input
        type="datetime-local"
        value={endedAt}
        onChange={(e) => setEndedAt(e.target.value)}
        className="h-8 w-56 text-xs"
      />
      <Button size="sm" className="h-8" disabled={saving} onClick={submit}>
        <Check className="h-3.5 w-3.5 mr-1" /> Confirmar salida
      </Button>
    </div>
  );
}

export function HourBankSchoolSection() {
  const queryClient = useQueryClient();

  // Solo owner tiene permiso (403 para el resto — se oculta sin más, el BFF
  // ya hizo cumplir D-8).
  const { data: pendingData } = useQuery({
    queryKey: ['hour-bank-visits', 'pending_review'],
    queryFn: () => bffClient.get<{ visits: PendingVisit[] }>('/api/v1/access/hour-bank-visits?status=pending_review'),
    staleTime: 30_000,
    retry: false,
  });

  const pending = pendingData?.visits ?? [];

  return (
    <>
    <HourBankEventDays />
    {pending.length > 0 && (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-bold">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Visitas pendientes de revisión ({pending.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {pending.map((v) => (
          <CorrectVisitRow
            key={v.id}
            visit={v}
            onDone={() => {
              queryClient.invalidateQueries({ queryKey: ['hour-bank-visits', 'pending_review'] });
              queryClient.invalidateQueries({ queryKey: ['hour-bank-balances'] });
              // Corregir una visita puede recalcular un cargo sugerido (F-E).
              queryClient.invalidateQueries({ queryKey: ['hour-bank-overage-charges'] });
            }}
          />
        ))}
      </CardContent>
    </Card>
    )}
    <HourBankOverageCharges />
    </>
  );
}
