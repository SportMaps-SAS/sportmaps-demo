/**
 * Gestión de Pagos → «Saldos a favor»: lo que cada familia pagó de más y todavía
 * no se ha descontado. Fuente: RPC saldos_a_favor_escuela (valida el alcance de
 * finanzas sobre ESTA escuela). Solo lectura.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/utils';

interface Fila {
  dueno: string;
  nombre: string;
  generado: number;
  consumido: number;
  disponible: number;
  ultimo_movimiento: string | null;
}

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Bogota' }) : '—';

export function SaldosAFavorTab({ schoolId }: { schoolId: string }) {
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let vivo = true;
    setFilas(null);
    setError(null);
    (async () => {
      const { data, error: e } = await (supabase as any).rpc('saldos_a_favor_escuela', { p_school_id: schoolId });
      if (!vivo) return;
      if (e) { setError('No se pudo cargar el saldo a favor.'); return; }
      setFilas(((data as Fila[]) ?? []).map((f) => ({
        ...f, generado: Number(f.generado), consumido: Number(f.consumido), disponible: Number(f.disponible),
      })));
    })();
    return () => { vivo = false; };
  }, [schoolId]);

  const visibles = useMemo(
    () => (filas ?? []).filter((f) => f.nombre.toLowerCase().includes(q.trim().toLowerCase())),
    [filas, q],
  );
  const totalDisponible = (filas ?? []).reduce((s, f) => s + f.disponible, 0);
  const conSaldo = (filas ?? []).filter((f) => f.disponible > 0).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saldos a favor</CardTitle>
        <CardDescription>
          Lo que cada atleta pagó de más. Se descuenta solo del siguiente cobro pendiente.
          {filas && filas.length > 0 && <> · <strong>{conSaldo}</strong> con saldo · <strong>{formatCurrency(totalDisponible)}</strong> disponible</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {filas === null && !error && <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {filas && filas.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">Todavía no hay saldos a favor en esta escuela.</p>
        )}
        {filas && filas.length > 0 && (
          <>
            <Input placeholder="Buscar atleta…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Atleta</TableHead>
                    <TableHead className="text-right">Pagó de más</TableHead>
                    <TableHead className="text-right">Ya descontado</TableHead>
                    <TableHead className="text-right">Disponible</TableHead>
                    <TableHead>Último movimiento</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibles.map((f) => (
                    <TableRow key={f.dueno}>
                      <TableCell className="font-medium">{f.nombre}</TableCell>
                      <TableCell className="text-right">{formatCurrency(f.generado)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(f.consumido)}</TableCell>
                      <TableCell className="text-right font-bold">{formatCurrency(f.disponible)}</TableCell>
                      <TableCell>{fecha(f.ultimo_movimiento)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
