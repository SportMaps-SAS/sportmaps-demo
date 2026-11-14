import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { AlertTriangle, Loader2, Lock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  BLACKOUT_KIND_LABEL,
  blackoutErrorMessage,
  deleteBlackout,
  listBlackouts,
  type Blackout,
} from './reservasApi';

interface Props {
  facilities: Array<{ id: string; name: string }>;
}

/** Bloqueos próximos (90 días) de una instalación, con «Quitar bloqueo». Todo por el BFF. */
export function BlackoutsPanel({ facilities }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState<string>('');
  const selected = facilityId || facilities[0]?.id || '';

  const query = useQuery({
    queryKey: ['reservas-blackouts', selected],
    enabled: !!selected,
    staleTime: 30_000,
    queryFn: () => {
      const now = new Date();
      return listBlackouts({
        facility_id: selected,
        from: now.toISOString(),
        to: addDays(now, 90).toISOString(),
      });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteBlackout(id),
    onSuccess: () => {
      toast({ title: '✅ Bloqueo quitado' });
      queryClient.invalidateQueries({ queryKey: ['reservas-blackouts'] });
      queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
    },
    onError: (e: unknown) => {
      toast({ title: 'No se pudo quitar el bloqueo', description: blackoutErrorMessage(e), variant: 'destructive' });
    },
  });

  if (facilities.length === 0) return null;
  const rows: Blackout[] = query.data ?? [];

  return (
    <Card className="p-4 space-y-3" data-testid="blackouts-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <Lock className="h-4 w-4 text-amber-600" /> Bloqueos próximos
        </h2>
        <Select value={selected} onValueChange={setFacilityId}>
          <SelectTrigger className="h-9 w-56" aria-label="Instalación de los bloqueos"><SelectValue /></SelectTrigger>
          <SelectContent>
            {facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {query.isLoading && <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />Cargando…</p>}
      {query.isError && (
        <p className="text-xs text-destructive flex items-start gap-2" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" />{blackoutErrorMessage(query.error)}
        </p>
      )}
      {!query.isLoading && !query.isError && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">No hay bloqueos en los próximos 90 días.</p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border/40" data-testid="blackouts-list">
          {rows.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-semibold capitalize">
                  {format(new Date(b.starts_at), "EEE d MMM, HH:mm", { locale: es })} – {format(new Date(b.ends_at), 'HH:mm', { locale: es })}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  <Badge variant="outline" className="mr-2">{BLACKOUT_KIND_LABEL[b.kind as keyof typeof BLACKOUT_KIND_LABEL] ?? 'Otro'}</Badge>
                  {/* texto de usuario: siempre como texto, nunca HTML */}
                  {b.reason ?? ''}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={remove.isPending}
                onClick={() => remove.mutate(b.id)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Quitar bloqueo
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
