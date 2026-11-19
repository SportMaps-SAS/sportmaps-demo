/**
 * Saldo a favor del acudiente / atleta adulto (RPC mi_saldo_a_favor: solo lo propio).
 * No pinta nada si no hay saldo, así que puede ir fijo en Mis Pagos.
 */
import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/utils';

interface MiSaldo {
  school_id: string;
  escuela: string;
  dueno: string;
  nombre: string;
  disponible: number;
}

export function MiSaldoAFavorCard() {
  const [saldos, setSaldos] = useState<MiSaldo[]>([]);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const { data, error } = await (supabase as any).rpc('mi_saldo_a_favor');
      if (error || !vivo) return; // sin saldo o sin acceso: la tarjeta simplemente no aparece
      setSaldos(((data as MiSaldo[]) ?? []).map((s) => ({ ...s, disponible: Number(s.disponible) })));
    })();
    return () => { vivo = false; };
  }, []);

  if (saldos.length === 0) return null;

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
        <Wallet className="h-4 w-4" /> Saldo a favor
      </div>
      <ul className="space-y-1">
        {saldos.map((s) => (
          <li key={`${s.school_id}:${s.dueno}`} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-foreground">{s.nombre} · <span className="text-muted-foreground">{s.escuela}</span></span>
            <span className="font-bold text-emerald-700 dark:text-emerald-300">{formatCurrency(s.disponible)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Se descuenta solo de tu próximo cobro: no tienes que hacer nada.
      </p>
    </div>
  );
}
