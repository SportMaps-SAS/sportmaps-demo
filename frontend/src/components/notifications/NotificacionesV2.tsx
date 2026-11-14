/**
 * Notificaciones del acudiente V2 (/notifications): solo presentación.
 * Toda la lógica (marcar leída, marcar todas, eliminar, con sus toasts de
 * error — lib/notifications/markRead.ts) sigue en NotificationsPage y llega
 * por props: aquí no se escribe nada en la base.
 *
 * Una frase («Tienes 3 sin leer») y un botón («Marcar todas como leídas»).
 * Las notificaciones viejas pueden traer voseo guardado en la base: se
 * muestran tal cual llegaron.
 */
import { AlertTriangle, Gift, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface NotificacionV2 {
  id: string;
  title: string;
  message: string;
  created_at: string;
  read: boolean;
  link?: string | null;
  /** Tipo de la notificación (`referral_won` = referido ganado). */
  type?: string | null;
}

export interface NotificacionesV2Props {
  notifications: NotificacionV2[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  filter: 'all' | 'unread';
  onFilter: (f: 'all' | 'unread') => void;
  timeAgo: (iso: string) => string;
  onOpen: (n: NotificacionV2) => void;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
  onMarkAll: () => void;
}

export function resumenNoLeidas(n: number): string {
  if (n === 0) return 'Estás al día.';
  return n === 1 ? 'Tienes 1 sin leer.' : `Tienes ${n} sin leer.`;
}

export function NotificacionesV2({
  notifications, isLoading, isError, onRetry, filter, onFilter, timeAgo, onOpen, onMarkRead, onDelete, onMarkAll,
}: NotificacionesV2Props) {
  const unread = notifications.filter((n) => !n.read).length;
  const visibles = filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;
  const listo = !isLoading && !isError;

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 pb-6">
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Notificaciones</h1>
          {listo && <p className="text-base text-muted-foreground">{resumenNoLeidas(unread)}</p>}
        </div>
        {listo && unread > 0 && (
          <Button variant="outline" className="min-h-touch w-full sm:w-auto" onClick={onMarkAll}>
            Marcar todas como leídas
          </Button>
        )}
        {listo && notifications.length > 0 && (
          <div role="tablist" aria-label="Filtrar notificaciones" className="flex gap-1 rounded-xl bg-muted p-1">
            {([['all', 'Todas'], ['unread', 'Sin leer']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => onFilter(value)}
                className={cn(
                  'min-h-touch flex-1 rounded-lg text-sm transition-colors',
                  filter === value ? 'bg-background font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground',
                )}
              >
                {label}{value === 'unread' && unread > 0 ? ` (${unread})` : ''}
              </button>
            ))}
          </div>
        )}
      </header>

      {isLoading && (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando tus notificaciones">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
          <Skeleton className="h-20 w-full rounded-2xl" />
        </div>
      )}

      {isError && !isLoading && (
        <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            No pudimos cargar tus notificaciones
          </p>
          <p className="text-sm text-muted-foreground">Revisa tu conexión e inténtalo de nuevo.</p>
          <Button variant="outline" className="min-h-touch" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      )}

      {listo && visibles.length === 0 && (
        <div className="rounded-2xl border bg-card p-6 text-center">
          <p className="font-semibold">{filter === 'unread' ? 'Ya leíste todo' : 'No tienes notificaciones'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filter === 'unread' ? 'No te queda nada pendiente por leer.' : 'Aquí te avisamos de cobros, clases y novedades del club.'}
          </p>
        </div>
      )}

      {listo && visibles.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border bg-card" aria-label="Notificaciones">
          {visibles.map((n, i) => {
            const contenido = (
              <>
                <span className="flex items-start gap-2">
                  <span
                    className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-primary')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    {n.type === 'referral_won' && (
                      <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                        <Gift className="h-3 w-3" aria-hidden="true" />
                        Referido ganado
                      </span>
                    )}
                    <span className={cn('block text-base', n.read ? 'font-medium' : 'font-semibold')}>
                      {n.title}
                      {!n.read && <span className="sr-only"> (sin leer)</span>}
                    </span>
                    <span className={cn('mt-0.5 block text-sm text-muted-foreground', n.type !== 'referral_won' && 'line-clamp-3')}>{n.message}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{timeAgo(n.created_at)}</span>
                  </span>
                </span>
              </>
            );
            return (
              <li key={n.id} className={cn('flex items-start gap-1 pr-1', i > 0 && 'border-t', !n.read && 'bg-primary/5')}>
                {n.link ? (
                  <button type="button" onClick={() => onOpen(n)} className="min-h-touch min-w-0 flex-1 px-4 py-3 text-left hover:bg-muted/50">
                    {contenido}
                  </button>
                ) : (
                  <div className="min-w-0 flex-1 px-4 py-3">
                    {contenido}
                    {!n.read && (
                      <button
                        type="button"
                        onClick={() => onMarkRead(n.id)}
                        className="ml-4 mt-1 min-h-touch text-sm font-medium text-primary"
                      >
                        Marcar como leída
                      </button>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(n.id)}
                  aria-label={`Eliminar «${n.title}»`}
                  className="mt-1 flex h-touch w-touch shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
