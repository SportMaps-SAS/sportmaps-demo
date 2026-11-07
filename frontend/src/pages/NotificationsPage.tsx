import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/useDashboardStats';
import { markNotificationRead, markAllNotificationsRead, deleteNotification } from '@/lib/notifications/markRead';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { esAcudienteV2 } from '@/lib/vistaAcudiente';
import { NotificacionesV2, type NotificacionV2 } from '@/components/notifications/NotificacionesV2';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Bell,
  CheckCircle,
  AlertCircle,
  Info,
  Gift,
  Trash2,
  Check,
  Filter,
  ChevronRight
} from 'lucide-react';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  created_at: string;
  read: boolean;
  action?: {
    label: string;
    href: string;
  };
}

// Notification interface is handled by useNotifications hook result

export default function NotificationsPage() {
  const { user, profile } = useAuth();
  const { currentUserRole } = useSchoolContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: notifications = [], isLoading, isError, refetch } = useNotifications();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const unreadCount = notifications.filter((n: any) => !n.read).length;

  // `type` en la interfaz de arriba es un union cerrado, pero la tabla real
  // en Supabase acepta cualquier string ('payment_reminder', etc.) y esta
  // página lo consume vía `any` — un tipo no mapeado acá dejaba `Icon`
  // undefined y React tiraba "Element type is invalid", tumbando toda la
  // página (bug 2026-09-18). Bell/texto por defecto para lo no mapeado.
  const getIcon = (type: Notification['type']) => {
    const icons: Record<string, typeof Bell> = {
      success: CheckCircle,
      warning: AlertCircle,
      error: AlertCircle,
      info: Info,
      referral_won: Gift
    };
    return icons[type] ?? Bell;
  };

  const getIconColor = (type: Notification['type']) => {
    const colors: Record<string, string> = {
      success: 'text-green-600',
      warning: 'text-orange-500',
      error: 'text-red-600',
      info: 'text-primary',
      referral_won: 'text-primary'
    };
    return colors[type] ?? 'text-muted-foreground';
  };

  // Antes los errores se tragaban en console.error y un UPDATE filtrado por
  // RLS (0 filas, sin error) se veía como éxito: el contador no bajaba y nadie
  // se enteraba (bug 2026-10-24). Ver lib/notifications/markRead.ts.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markAsRead = async (id: string) => {
    if (!user) return;
    try {
      await markNotificationRead(user.id, id);
    } catch (error) {
      console.error('Error marking notification as read:', error);
      toast.error('No se pudo marcar como leída. Intenta de nuevo.');
    } finally {
      refresh();
    }
  };

  const markAllAsRead = async () => {
    if (!user) return;
    try {
      await markAllNotificationsRead(user.id, unreadCount);
    } catch (error) {
      console.error('Error marking all as read:', error);
      toast.error('No se pudieron marcar como leídas. Intenta de nuevo.');
    } finally {
      refresh();
    }
  };

  const removeNotification = async (id: string) => {
    if (!user) return;
    try {
      await deleteNotification(user.id, id);
    } catch (error) {
      console.error('Error deleting notification:', error);
      toast.error('No se pudo eliminar la notificación. Intenta de nuevo.');
    } finally {
      refresh();
    }
  };

  const getTimeAgo = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: es });
    } catch (e) {
      return 'Hace un momento';
    }
  };

  const filteredNotifications = filter === 'unread'
    ? notifications.filter((n: any) => !n.read)
    : notifications;

  // Acudiente V2: misma lógica (arriba), otra presentación. Los demás roles no cambian.
  if (esAcudienteV2(currentUserRole ?? profile?.role)) {
    return (
      <NotificacionesV2
        notifications={notifications as NotificacionV2[]}
        isLoading={isLoading}
        isError={isError}
        onRetry={() => { void refetch(); }}
        filter={filter}
        onFilter={setFilter}
        timeAgo={getTimeAgo}
        onOpen={(n) => {
          if (!n.read) void markAsRead(n.id);
          if (n.link) navigate(n.link);
        }}
        onMarkRead={(id) => { void markAsRead(id); }}
        onDelete={(id) => { void removeNotification(id); }}
        onMarkAll={() => { void markAllAsRead(); }}
      />
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Bell className="h-8 w-8 text-primary" />
            Notificaciones
            {unreadCount > 0 && (
              <Badge variant="destructive" className="text-sm">
                {unreadCount}
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground mt-1">
            Mantente al día con todas tus actualizaciones
          </p>
        </div>
        {unreadCount > 0 && (
          <Button onClick={markAllAsRead} variant="outline" className="gap-2">
            <Check className="h-4 w-4" />
            Marcar todas como leídas
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Filtros</CardTitle>
            <div className="flex gap-2">
              <Button
                variant={filter === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter('all')}
              >
                Todas ({notifications.length})
              </Button>
              <Button
                variant={filter === 'unread' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter('unread')}
              >
                No leídas ({unreadCount})
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Notifications List */}
      <div className="space-y-3">
        {filteredNotifications.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Bell className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No hay notificaciones</h3>
              <p className="text-muted-foreground">
                {filter === 'unread'
                  ? 'Has leído todas tus notificaciones'
                  : 'No tienes notificaciones en este momento'
                }
              </p>
            </CardContent>
          </Card>
        ) : (
          filteredNotifications.map((notification, index) => {
            const Icon = getIcon(notification.type as any);
            // Igual que la campana (GlobalNotificationBell): tocar la tarjeta
            // marca leída y navega al `link` que trae la notificación (p.ej.
            // /my-payments en un cobro). Antes esta página no llevaba a ningún
            // lado: el padre leía "tienes un cobro" y tenía que buscarlo solo.
            const link: string | undefined = (notification as any).link || undefined;
            const open = () => {
              if (!notification.read) void markAsRead(notification.id);
              if (link) navigate(link);
            };
            return (
              <Card
                key={notification.id}
                onClick={link ? open : undefined}
                role={link ? 'link' : undefined}
                tabIndex={link ? 0 : undefined}
                onKeyDown={link ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}
                className={`transition-all hover:shadow-md animate-in slide-in-from-left ${!notification.read ? 'border-primary/50 bg-primary/5' : ''
                  } ${link ? 'cursor-pointer' : ''}`}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className={`p-2 rounded-full bg-background ${getIconColor(notification.type as any)}`}>
                      <Icon className="h-5 w-5" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h3 className="font-semibold text-sm">
                          {notification.title}
                          {!notification.read && (
                            <span className="ml-2 inline-block w-2 h-2 rounded-full bg-primary" />
                          )}
                        </h3>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {getTimeAgo(notification.created_at)}
                        </span>
                      </div>

                      <p className="text-sm text-muted-foreground mb-3">
                        {notification.message}
                      </p>

                      <div className="flex items-center gap-2">
                        {link && (
                          <Button size="sm" variant="secondary" className="gap-1" onClick={(e) => { e.stopPropagation(); open(); }}>
                            Ver
                            <ChevronRight className="h-3 w-3" />
                          </Button>
                        )}
                        {!notification.read && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); markAsRead(notification.id); }}
                            className="gap-1"
                          >
                            <Check className="h-3 w-3" />
                            Marcar como leída
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); void removeNotification(notification.id); }}
                          className="gap-1 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                          Eliminar
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
