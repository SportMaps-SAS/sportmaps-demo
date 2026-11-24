/**
 * Banda global de «lo que falta por enviar» (Fase 2 del modo offline).
 *
 * Discreta, solo para el entrenador y solo cuando hay algo: «Sin señal · 3 pendientes»,
 * «Enviando 2 pendientes…» o «1 con problema · toca para ver». Lleva a /pendientes.
 * No se muestra en la propia pantalla de Pendientes ni con la cola vacía.
 */
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, CloudOff, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePendientes } from '@/lib/offline/useBandeja';
import { resumenBanda } from '@/lib/offline/pendientesModel';
import { cn } from '@/lib/utils';

export const RUTA_PENDIENTES = '/pendientes';

export function BandaPendientes() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { vistas, enLinea } = usePendientes(user?.id);
  const r = resumenBanda(vistas, enLinea);
  if (!r.texto || pathname === RUTA_PENDIENTES) return null;
  const Icono = r.tono === 'alerta' ? AlertTriangle : enLinea ? RefreshCw : CloudOff;
  return (
    <Link
      to={RUTA_PENDIENTES}
      role="status"
      data-testid="banda-pendientes"
      className={cn(
        'fixed inset-x-0 top-0 z-40 flex min-h-[2rem] items-center justify-center gap-2 px-3 pb-1 pt-[max(0.25rem,env(safe-area-inset-top))] text-xs font-medium shadow-sm',
        r.tono === 'alerta'
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-muted text-foreground',
      )}
    >
      <Icono className={cn('h-3.5 w-3.5 shrink-0', enLinea && r.tono === 'info' && 'animate-spin')} aria-hidden="true" />
      <span className="truncate">{r.texto}</span>
    </Link>
  );
}
