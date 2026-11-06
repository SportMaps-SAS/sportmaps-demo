import { useState, useEffect, useCallback } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { HourBankSchoolSection } from '@/components/access/HourBankSchoolSection';
import { DeviceUsersDialog } from '@/components/access/DeviceUsersDialog';
import { useEntitlements } from '@/hooks/useEntitlements';
import { dayToLocalDate } from '@/lib/dateUtils';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DoorOpen,
  DoorClosed,
  Users,
  TrendingUp,
  TrendingDown,
  ShieldX,
  Fingerprint,
  CreditCard,
  User,
  UserPlus,
  Wifi,
  WifiOff,
  RefreshCw,
  Clock,
  Settings,
  Pencil,
  Plus,
} from 'lucide-react';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface AccessStats {
  today: string;
  entries_count: number;
  exits_count: number;
  denied_count: number;
  current_occupancy: number;
}

interface AccessEvent {
  id: string;
  direction: 'entry' | 'exit';
  access_granted: boolean;
  denial_reason?: string;
  policy_warning?: 'day_not_allowed' | null;
  check_in_method: 'fingerprint' | 'card' | 'manual' | 'pin';
  zk_user_id?: number;
  child_id?: string;
  occurred_at: string;
  user_name: string;
  turnstile_devices?: { device_name: string; direction: string };
}

interface TurnstileDevice {
  id: string;
  serial_number: string;
  device_name: string;
  ip_address: string | null;
  direction: 'entry' | 'exit' | 'both';
  location: string;
  is_active: boolean;
  last_seen_at: string | null;
  brand?: string;
  door_drive_time_seconds?: number;
}

interface AssignableMember {
  user_id?: string;
  unregistered_athlete_id?: string;
  child_id?: string;
  full_name: string;
  role: string | null;
  type: 'registered' | 'unregistered' | 'child';
}

// Un evento "desconocido" todavía no tiene usuario mapeado (user_name = ZK#<pin>).
function isUnknownEvent(e: AccessEvent): boolean {
  return typeof e.user_name === 'string' && e.user_name.startsWith('ZK#') && !!e.zk_user_id;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const METHOD_ICON: Record<string, React.ReactNode> = {
  fingerprint: <Fingerprint className="h-3.5 w-3.5" />,
  card:        <CreditCard  className="h-3.5 w-3.5" />,
  manual:      <User        className="h-3.5 w-3.5" />,
  pin:         <User        className="h-3.5 w-3.5" />,
};

const DENIAL_LABEL: Record<string, string> = {
  no_enrollment:      'Sin inscripción',
  payment_overdue:    'Pago vencido',
  enrollment_expired: 'Inscripción vencida',
  unknown_user:       'Usuario desconocido',
  device_error:       'Error en dispositivo',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Bogota',
  });
}

function deviceOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return (Date.now() - new Date(lastSeen).getTime()) < 5 * 60 * 1000; // 5 min
}

// ─── Componente principal ─────────────────────────────────────────────────────

// ─── Detalle filtrado de una tarjeta de stats (Entradas/Salidas/Aforo/Denegados) ──
// Inline, no modal — a propósito: el pedido fue "tarjetas filtradas que al
// seleccionar se muestren los datos", no una ventana encima del panel.
function StatCategoryDetail({
  category, events, occupancy, loadingOccupancy,
}: {
  category: 'entries' | 'exits' | 'occupancy' | 'denied';
  events: AccessEvent[];
  occupancy: { name: string; entered_at: string; minutes_inside: number }[];
  loadingOccupancy: boolean;
}) {
  const title = {
    entries:   'Entradas de hoy',
    exits:     'Salidas de hoy',
    occupancy: 'Quién está adentro',
    denied:    'Accesos denegados hoy',
  }[category];

  if (category === 'occupancy') {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold">{title} ({occupancy.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingOccupancy && occupancy.length === 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {[1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : occupancy.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Nadie adentro en este momento.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {occupancy.map((o, i) => {
                const h = Math.floor(o.minutes_inside / 60);
                const m = o.minutes_inside % 60;
                return (
                  <div key={i} className="rounded-lg border bg-card px-3 py-2.5">
                    <p className="text-sm font-semibold truncate">{o.name}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Clock className="h-3 w-3" />
                      {h > 0 ? `${h}h ${m}min` : `${m} min`} dentro
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Entró {formatTime(o.entered_at)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const filtered = events.filter((e) => {
    if (category === 'entries') return e.access_granted && e.direction === 'entry';
    if (category === 'exits')   return e.access_granted && e.direction === 'exit';
    return !e.access_granted; // denied
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-bold">{title} ({filtered.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Sin eventos todavía.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filtered.map((e) => (
              <div key={e.id} className="rounded-lg border bg-card px-3 py-2.5">
                <p className="text-sm font-semibold truncate">{e.user_name}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  {METHOD_ICON[e.check_in_method] ?? <User className="h-3.5 w-3.5" />}
                  {formatTime(e.occurred_at)}
                </p>
                {category === 'denied' && (
                  <div className="flex items-center gap-1.5 flex-wrap mt-1">
                    <span className="text-[10px] text-muted-foreground">
                      {e.direction === 'entry' ? 'Entrada' : 'Salida'}
                    </span>
                    {e.denial_reason && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 py-0 border-destructive/30 text-destructive">
                        {DENIAL_LABEL[e.denial_reason] ?? e.denial_reason}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AccessControlPage() {
  const { toast } = useToast();

  const [stats,        setStats]        = useState<AccessStats | null>(null);
  const [events,       setEvents]       = useState<AccessEvent[]>([]);
  const [devices,      setDevices]      = useState<TurnstileDevice[]>([]);
  const [occupancy,    setOccupancy]    = useState<{ name: string; entered_at: string; minutes_inside: number }[]>([]);
  const [loadingOccupancy, setLoadingOccupancy] = useState(false);
  const [statCategory, setStatCategory] = useState<'entries' | 'exits' | 'occupancy' | 'denied' | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingLog,   setLoadingLog]   = useState(true);
  const [openingEntry, setOpeningEntry] = useState(false);
  const [openingExit,  setOpeningExit]  = useState(false);
  const [lastRefresh,  setLastRefresh]  = useState<Date>(new Date());

  // Asignar usuario a un PIN desconocido
  const [assignPin,     setAssignPin]     = useState<number | null>(null);
  const [memberQuery,   setMemberQuery]   = useState('');
  const [members,       setMembers]       = useState<AssignableMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [assigningId,   setAssigningId]   = useState<string | null>(null);

  // Configurar dispositivos
  const [manageOpen, setManageOpen] = useState(false);
  const [overdueOpen, setOverdueOpen] = useState(false);
  // «IDs del lector»: solo en escuelas con school_settings.access_roster_enabled.
  const { accessRosterEnabled } = useEntitlements();
  const [rosterOpen, setRosterOpen] = useState(false);
  const [overdue, setOverdue] = useState<{
    payment_id: string; name: string; due_date: string; amount: string | number;
    zk_pin: number; blocked: boolean;
  }[]>([]);
  const [loadingOverdue, setLoadingOverdue] = useState(false);
  const [actingPin, setActingPin] = useState<number | null>(null);
  const [overdueSearch, setOverdueSearch] = useState('');

  // Limpiar buscador cuando se cierra el modal
  useEffect(() => {
    if (!overdueOpen) {
      setOverdueSearch('');
    }
  }, [overdueOpen]);

  const [deviceForm, setDeviceForm] = useState<{
    id: string | null; // null = creando nuevo
    serial_number: string;
    device_name: string;
    ip_address: string;
    direction: 'entry' | 'exit' | 'both';
    location: string;
    is_active: boolean;
    brand: string;
    door_drive_time_seconds: number;
  } | null>(null);
  const [savingDevice, setSavingDevice] = useState(false);

  // ── Carga de datos ──────────────────────────────────────────────────────────

  const loadStats = useCallback(async () => {
    try {
      const data = await bffClient.get<AccessStats>('/api/v1/access/stats');
      setStats(data);
    } catch {
      // silencioso en refresh automático
    } finally {
      setLoadingStats(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      // limit=200: las tarjetas filtradas de Entradas/Salidas/Denegados leen de
      // esta misma lista (no piden aparte), así que tiene que cubrir el día
      // completo, no solo el log reciente.
      const data = await bffClient.get<{ events: AccessEvent[] }>(
        `/api/v1/access/events?limit=200&date=${today}`
      );
      setEvents(data.events || []);
      setLastRefresh(new Date());
    } catch {
      // silencioso
    } finally {
      setLoadingLog(false);
    }
  }, []);

  const loadOccupancy = useCallback(async () => {
    setLoadingOccupancy(true);
    try {
      const data = await bffClient.get<{ occupancy: typeof occupancy }>('/api/v1/access/occupancy');
      setOccupancy(data.occupancy || []);
    } catch {
      // silencioso
    } finally {
      setLoadingOccupancy(false);
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const data = await bffClient.get<{ devices: TurnstileDevice[] }>('/api/v1/access/devices');
      setDevices(data.devices || []);
    } catch {
      // silencioso
    }
  }, []);

  const loadOverdue = useCallback(async () => {
    setLoadingOverdue(true);
    try {
      const data = await bffClient.get<{ overdue: any[] }>('/api/v1/access/overdue');
      setOverdue(data.overdue || []);
    } catch {
      // silencioso
    } finally {
      setLoadingOverdue(false);
    }
  }, []);

  // Carga inicial
  useEffect(() => {
    loadStats();
    loadEvents();
    loadDevices();
    loadOverdue();
  }, [loadStats, loadEvents, loadDevices, loadOverdue]);

  // Auto-refresh cada 15 segundos
  useEffect(() => {
    const interval = setInterval(() => {
      loadStats();
      loadEvents();
    }, 15_000);
    return () => clearInterval(interval);
  }, [loadStats, loadEvents]);

  // Aforo es la única tarjeta con su propio endpoint (necesita "hace cuánto
  // entró", que la lista de eventos no da directo) — se pide solo cuando está
  // seleccionada, y se refresca cada 15s mientras lo esté.
  useEffect(() => {
    if (statCategory !== 'occupancy') return;
    loadOccupancy();
    const interval = setInterval(loadOccupancy, 15_000);
    return () => clearInterval(interval);
  }, [statCategory, loadOccupancy]);

  // ── Apertura manual ─────────────────────────────────────────────────────────

  const handleManualOpen = async (direction: 'entry' | 'exit') => {
    const setter = direction === 'entry' ? setOpeningEntry : setOpeningExit;
    setter(true);
    try {
      await bffClient.post('/api/v1/access/manual-open', { direction });
      toast({
        title:       direction === 'entry' ? 'Entrada abierta' : 'Salida abierta',
        description: 'El torniquete abrirá en los próximos segundos.',
      });
      setTimeout(() => { loadStats(); loadEvents(); }, 2000);
    } catch (err: any) {
      const code = err?.code;
      toast({
        title:   'No se pudo abrir',
        description: code === 'NO_IP_CONFIGURED'
          ? 'El dispositivo no tiene IP pública configurada aún. Usa la llave física.'
          : err.message || 'Error al enviar el comando.',
        variant: 'destructive',
      });
    } finally {
      setter(false);
    }
  };

  // ── Asignar usuario a un PIN ──────────────────────────────────────────────────

  const loadMembers = useCallback(async (q: string) => {
    setLoadingMembers(true);
    try {
      const data = await bffClient.get<{ members: AssignableMember[] }>(
        `/api/v1/access/members${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      );
      setMembers(data.members || []);
    } catch {
      setMembers([]);
    } finally {
      setLoadingMembers(false);
    }
  }, []);

  // Al abrir el diálogo o cambiar la búsqueda, recarga miembros (con debounce).
  useEffect(() => {
    if (assignPin === null) return;
    const t = setTimeout(() => loadMembers(memberQuery), 300);
    return () => clearTimeout(t);
  }, [assignPin, memberQuery, loadMembers]);

  const openAssign = (pin: number) => {
    setAssignPin(pin);
    setMemberQuery('');
    setMembers([]);
  };

  const handleAssign = async (member: AssignableMember) => {
    if (assignPin === null) return;
    const key = member.user_id ?? member.unregistered_athlete_id ?? member.child_id!;
    setAssigningId(key);
    try {
      await bffClient.post('/api/v1/access/assign-user', {
        zk_pin:  assignPin,
        user_id: member.user_id,
        unregistered_athlete_id: member.unregistered_athlete_id,
        child_id: member.child_id,
      });
      toast({
        title:       'Usuario asignado',
        description: `${member.full_name} quedó vinculado al PIN ${assignPin}.`,
      });
      setAssignPin(null);
      loadEvents();
    } catch (err: any) {
      toast({
        title:       'No se pudo asignar',
        description: err?.message || 'Error al asignar el usuario.',
        variant:     'destructive',
      });
    } finally {
      setAssigningId(null);
    }
  };

  // ── Gestión de dispositivos ─────────────────────────────────────────────────

  const openNewDevice = () => {
    setDeviceForm({
      id: null, serial_number: '', device_name: '', ip_address: '',
      direction: 'entry', location: '', is_active: true, brand: 'Genérico',
      door_drive_time_seconds: 5,
    });
  };

  const openEditDevice = (device: TurnstileDevice) => {
    setDeviceForm({
      id: device.id,
      serial_number: device.serial_number,
      device_name: device.device_name,
      ip_address: device.ip_address ?? '',
      direction: device.direction,
      location: device.location ?? '',
      is_active: device.is_active,
      brand: device.brand ?? 'Genérico',
      door_drive_time_seconds: device.door_drive_time_seconds ?? 5,
    });
  };

  const handleSaveDevice = async () => {
    if (!deviceForm) return;
    if (!deviceForm.serial_number.trim() || !deviceForm.device_name.trim()) {
      toast({ title: 'Faltan datos', description: 'Serial y nombre son requeridos.', variant: 'destructive' });
      return;
    }
    setSavingDevice(true);
    try {
      const payload = {
        serial_number: deviceForm.serial_number.trim(),
        device_name:   deviceForm.device_name.trim(),
        ip_address:    deviceForm.ip_address.trim() || null,
        direction:     deviceForm.direction,
        location:      deviceForm.location.trim() || null,
        brand:         deviceForm.brand,
        door_drive_time_seconds: deviceForm.door_drive_time_seconds,
        ...(deviceForm.id ? { is_active: deviceForm.is_active } : {}),
      };

      if (deviceForm.id) {
        await bffClient.patch(`/api/v1/access/devices/${deviceForm.id}`, payload);
        toast({ title: 'Dispositivo actualizado' });
      } else {
        await bffClient.post('/api/v1/access/devices', payload);
        toast({ title: 'Dispositivo creado' });
      }

      setDeviceForm(null);
      loadDevices();
    } catch (err: any) {
      toast({
        title: 'No se pudo guardar',
        description: err?.message || 'Error al guardar el dispositivo.',
        variant: 'destructive',
      });
    } finally {
      setSavingDevice(false);
    }
  };

  const handleSetGroup = async (pin: number, group: 1 | 2) => {
    setActingPin(pin);
    try {
      await bffClient.post('/api/v1/access/set-access-group', { pin, group });
      toast({ title: group === 2 ? 'Acceso bloqueado' : 'Acceso restaurado' });
      // Actualizacion optimista: el comando recien encolado queda 'pending'
      // hasta que el lector fisico haga su propio ciclo ADMS y lo confirme
      // ('executed') -- puede tardar varios segundos. Un loadOverdue()
      // inmediato traia ese estado viejo, el boton parecia no responder, y
      // habia que apretarlo varias veces. Reflejamos la intencion del click
      // ya mismo en vez de esperar el viaje de ida y vuelta al dispositivo.
      setOverdue(prev => prev.map(o => (o.zk_pin === pin ? { ...o, blocked: group === 2 } : o)));
    } catch (err: any) {
      toast({ title: 'No se pudo actualizar', description: err?.message, variant: 'destructive' });
    } finally {
      setActingPin(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="container mx-auto py-6 px-4 max-w-5xl space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Control de Acceso</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Torniquetes — actualizado a las {formatTime(lastRefresh.toISOString())}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => { loadStats(); loadEvents(); loadDevices(); loadOverdue(); }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Actualizar
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setManageOpen(true)}
          >
            <Settings className="h-3.5 w-3.5" />
            Configurar
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => { setOverdueOpen(true); loadOverdue(); }}
          >
            <ShieldX className="h-3.5 w-3.5" />
            Vencidos {overdue.length > 0 && `(${overdue.length})`}
          </Button>
          {accessRosterEnabled && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setRosterOpen(true)}
            >
              <Fingerprint className="h-3.5 w-3.5" />
              IDs del lector
            </Button>
          )}
        </div>
      </div>

      {/* Banco de horas (F6) — no renderiza nada si la escuela no tiene atletas con plan de horas */}
      <HourBankSchoolSection />

      {/* Estado de dispositivos */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {devices.length === 0 ? (
          <Skeleton className="h-16 col-span-2" />
        ) : (
          devices.map(device => {
            const online = deviceOnline(device.last_seen_at);
            return (
              <div
                key={device.id}
                className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
              >
                {online
                  ? <Wifi className="h-4 w-4 text-green-500 shrink-0" />
                  : <WifiOff className="h-4 w-4 text-muted-foreground shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{device.device_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {device.brand ?? 'Genérico'} · {device.location || 'Sin ubicación'}
                  </p>
                </div>
                <Badge
                  variant={online ? 'default' : 'outline'}
                  className={`text-[10px] shrink-0 ${online ? 'bg-green-500/10 text-green-600 border-green-200' : ''}`}
                >
                  {online ? 'En línea' : 'Sin señal'}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0"
                  onClick={() => openEditDevice(device)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </div>

      {/* Stats del día — cada tarjeta es un selector, no un número suelto */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {loadingStats ? (
          [1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Card
              onClick={() => setStatCategory(prev => prev === 'entries' ? null : 'entries')}
              className={`cursor-pointer transition-all hover:border-green-300 ${statCategory === 'entries' ? 'ring-2 ring-green-500 border-green-500' : ''}`}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                  <TrendingUp className="h-3.5 w-3.5 text-green-500" />
                  Entradas hoy
                </div>
                <p className="text-3xl font-bold text-green-600">{stats?.entries_count ?? 0}</p>
              </CardContent>
            </Card>

            <Card
              onClick={() => setStatCategory(prev => prev === 'exits' ? null : 'exits')}
              className={`cursor-pointer transition-all hover:border-blue-300 ${statCategory === 'exits' ? 'ring-2 ring-blue-500 border-blue-500' : ''}`}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                  <TrendingDown className="h-3.5 w-3.5 text-blue-500" />
                  Salidas hoy
                </div>
                <p className="text-3xl font-bold text-blue-600">{stats?.exits_count ?? 0}</p>
              </CardContent>
            </Card>

            <Card
              onClick={() => setStatCategory(prev => prev === 'occupancy' ? null : 'occupancy')}
              className={`cursor-pointer transition-all hover:border-primary/50 ${statCategory === 'occupancy' ? 'ring-2 ring-primary border-primary' : ''}`}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                  <Users className="h-3.5 w-3.5 text-primary" />
                  Aforo actual
                </div>
                <p className="text-3xl font-bold">{stats?.current_occupancy ?? 0}</p>
              </CardContent>
            </Card>

            <Card
              onClick={() => setStatCategory(prev => prev === 'denied' ? null : 'denied')}
              className={`cursor-pointer transition-all hover:border-destructive/50 ${statCategory === 'denied' ? 'ring-2 ring-destructive border-destructive' : ''}`}
            >
              <CardContent className="pt-5 pb-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
                  <ShieldX className="h-3.5 w-3.5 text-destructive" />
                  Denegados
                </div>
                <p className="text-3xl font-bold text-destructive">{stats?.denied_count ?? 0}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Detalle filtrado de la tarjeta seleccionada — inline, no modal */}
      {statCategory && (
        <StatCategoryDetail
          category={statCategory}
          events={events}
          occupancy={occupancy}
          loadingOccupancy={loadingOccupancy}
        />
      )}

      {/* Control manual */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Apertura manual</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Abre el torniquete directamente desde aquí sin necesidad de huella o tarjeta.
            Requiere IP pública configurada en el dispositivo.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              className="flex-1 gap-2 h-12"
              onClick={() => handleManualOpen('entry')}
              disabled={openingEntry}
            >
              {openingEntry
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <DoorOpen className="h-4 w-4" />
              }
              Abrir Entrada
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2 h-12"
              onClick={() => handleManualOpen('exit')}
              disabled={openingExit}
            >
              {openingExit
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <DoorClosed className="h-4 w-4" />
              }
              Abrir Salida
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Log de accesos */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Registro de accesos — hoy</CardTitle>
            <Badge variant="outline" className="text-xs">
              {events.length} eventos
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loadingLog ? (
            <div className="p-4 space-y-3">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Sin accesos registrados hoy</p>
              <p className="text-xs mt-1">Los eventos aparecerán aquí en tiempo real</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {events.map((event) => (
                <div
                  key={event.id}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                    !event.access_granted ? 'bg-destructive/5' : ''
                  }`}
                >
                  {/* Ícono dirección — siempre según direction, el tinte destructivo
                      solo avisa que hubo un motivo de negocio en contra (vencido/sin
                      inscripción), sin tapar si fue entrada o salida (ver caso Edna,
                      2026-09-05: "pago vencido" no puede borrar que sí salió). */}
                  <div className={`shrink-0 rounded-full p-1.5 ${
                    !event.access_granted
                      ? 'bg-destructive/10 text-destructive'
                      : event.direction === 'entry'
                        ? 'bg-green-500/10 text-green-600'
                        : 'bg-blue-500/10 text-blue-600'
                  }`}>
                    {event.direction === 'entry'
                      ? <TrendingUp className="h-3.5 w-3.5" />
                      : <TrendingDown className="h-3.5 w-3.5" />
                    }
                  </div>

                  {/* Nombre */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{event.user_name}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">
                        {event.direction === 'entry' ? 'Entrada' : 'Salida'}
                      </span>
                      {!event.access_granted && event.denial_reason && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1 py-0 border-destructive/30 text-destructive">
                          {DENIAL_LABEL[event.denial_reason] ?? event.denial_reason}
                        </Badge>
                      )}
                      {/* F-F (D11b): entró, pero su plan no incluye este día. Solo registro. */}
                      {event.access_granted && event.policy_warning === 'day_not_allowed' && (
                        <Badge
                          variant="outline"
                          className="text-[9px] h-4 px-1 py-0 border-amber-500/40 text-amber-600"
                          title="Ingresó un día que su plan no incluye. El torniquete no lo bloquea: queda registrado."
                        >
                          Día no permitido
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Asignar usuario (solo PIN desconocido) */}
                  {isUnknownEvent(event) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs shrink-0"
                      onClick={() => openAssign(event.zk_user_id as number)}
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Asignar
                    </Button>
                  )}
                  {!event.access_granted && event.denial_reason === 'payment_overdue' && event.zk_user_id && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs shrink-0"
                      onClick={() => bffClient.post('/api/v1/access/set-access-group', { pin: event.zk_user_id, group: 2 })
                        .then(() => toast({ title: 'Bloqueo encolado' }))}
                    >
                      Bloquear ahora
                    </Button>
                  )}

                  {/* Método + hora */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-muted-foreground">
                      {METHOD_ICON[event.check_in_method] ?? METHOD_ICON.fingerprint}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatTime(event.occurred_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Diálogo: asignar usuario a un PIN desconocido */}
      <Dialog open={assignPin !== null} onOpenChange={(open) => { if (!open) setAssignPin(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Asignar usuario al PIN {assignPin}</DialogTitle>
            <DialogDescription>
              Vincula este UID del lector a un miembro de la escuela. Sus accesos
              empezarán a mostrar el nombre y validarán inscripción y pago.
            </DialogDescription>
          </DialogHeader>

          <Input
            placeholder="Buscar miembro por nombre…"
            value={memberQuery}
            onChange={(e) => setMemberQuery(e.target.value)}
            autoFocus
          />

          <div className="max-h-72 overflow-y-auto divide-y divide-border/50 -mx-2">
            {loadingMembers ? (
              <div className="p-3 space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
              </div>
            ) : members.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {memberQuery ? 'Sin coincidencias' : 'Escribe para buscar miembros'}
              </p>
            ) : (
              members.map((m) => (
                <button
                  key={m.user_id ?? m.unregistered_athlete_id ?? m.child_id}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors disabled:opacity-50"
                  onClick={() => handleAssign(m)}
                  disabled={assigningId !== null}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{m.full_name}</p>
                    {m.role && <p className="text-xs text-muted-foreground">{m.role}</p>}
                    {(m.type === 'unregistered' || m.type === 'child') && (
                      <span className="text-[10px] text-amber-600 bg-amber-500/10 px-1 py-0.5 rounded font-medium mt-0.5 inline-block">
                        Sin Login
                      </span>
                    )}
                  </div>
                  {assigningId === (m.user_id ?? m.unregistered_athlete_id ?? m.child_id)
                    ? <RefreshCw className="h-4 w-4 animate-spin shrink-0" />
                    : <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {accessRosterEnabled && <DeviceUsersDialog open={rosterOpen} onClose={() => setRosterOpen(false)} />}

      {/* Diálogo: gestionar dispositivos (lista) */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Dispositivos de acceso</DialogTitle>
            <DialogDescription>
              Torniquetes y lectores configurados para esta escuela.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 max-h-72 overflow-y-auto">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{d.device_name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {d.brand ?? 'Genérico'} · {d.serial_number} · {d.direction} {!d.is_active && '· inactivo'}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => openEditDevice(d)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {devices.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Sin dispositivos configurados.</p>
            )}
          </div>

          <Button variant="outline" className="gap-2 w-full" onClick={openNewDevice}>
            <Plus className="h-3.5 w-3.5" />
            Agregar dispositivo
          </Button>
        </DialogContent>
      </Dialog>

      {/* Diálogo: crear/editar un dispositivo */}
      <Dialog open={deviceForm !== null} onOpenChange={(open) => { if (!open) setDeviceForm(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{deviceForm?.id ? 'Editar dispositivo' : 'Nuevo dispositivo'}</DialogTitle>
            <DialogDescription>
              Serial y dirección deben coincidir con la configuración del lector físico.
            </DialogDescription>
          </DialogHeader>

          {deviceForm && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">Nombre</label>
                <Input
                  value={deviceForm.device_name}
                  onChange={(e) => setDeviceForm({ ...deviceForm, device_name: e.target.value })}
                  placeholder="Lector Entrada"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Número de serie (SN)</label>
                <Input
                  value={deviceForm.serial_number}
                  onChange={(e) => setDeviceForm({ ...deviceForm, serial_number: e.target.value })}
                  placeholder="JJA1254900899"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">IP pública</label>
                <Input
                  value={deviceForm.ip_address}
                  onChange={(e) => setDeviceForm({ ...deviceForm, ip_address: e.target.value })}
                  placeholder="181.63.24.103"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Marca</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background text-foreground px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring dark:bg-slate-900 dark:text-white"
                  value={deviceForm.brand}
                  onChange={(e) => setDeviceForm({ ...deviceForm, brand: e.target.value })}
                >
                  <option value="Genérico" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Genérico</option>
                  <option value="ZKTeco" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">ZKTeco</option>
                  <option value="Hikvision" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Hikvision</option>
                  <option value="Suprema" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Suprema</option>
                  <option value="Came" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Came</option>
                  <option value="Alvarado" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Alvarado</option>
                  <option value="Centurion Systems" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Centurion Systems</option>
                  <option value="Motorline" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Motorline</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Dirección</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background text-foreground px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring dark:bg-slate-900 dark:text-white"
                  value={deviceForm.direction}
                  onChange={(e) => setDeviceForm({ ...deviceForm, direction: e.target.value as 'entry' | 'exit' | 'both' })}
                >
                  <option value="entry" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Entrada</option>
                  <option value="exit" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Salida</option>
                  <option value="both" className="bg-background text-foreground dark:bg-slate-900 dark:text-white">Ambas</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Ubicación</label>
                <Input
                  value={deviceForm.location}
                  onChange={(e) => setDeviceForm({ ...deviceForm, location: e.target.value })}
                  placeholder="Entrada principal"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Tiempo de apertura (segundos)</label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={deviceForm.door_drive_time_seconds}
                  onChange={(e) => setDeviceForm({ ...deviceForm, door_drive_time_seconds: Number(e.target.value) })}
                />
              </div>
              {deviceForm.id && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={deviceForm.is_active}
                    onChange={(e) => setDeviceForm({ ...deviceForm, is_active: e.target.checked })}
                  />
                  Dispositivo activo
                </label>
              )}

              <Button className="w-full gap-2" onClick={handleSaveDevice} disabled={savingDevice}>
                {savingDevice
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : null}
                {deviceForm.id ? 'Guardar cambios' : 'Crear dispositivo'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={overdueOpen} onOpenChange={setOverdueOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Atletas con pago vencido</DialogTitle>
            <DialogDescription>
              Solo se muestran los que tienen huella registrada. Bloquear no borra la huella —
              solo restringe el horario de acceso hasta que se regularice el pago.
            </DialogDescription>
          </DialogHeader>

          {/* Buscador */}
          {!loadingOverdue && overdue.length > 0 && (
            <div className="my-1">
              <Input
                placeholder="Buscar por nombre o PIN..."
                value={overdueSearch}
                onChange={(e) => setOverdueSearch(e.target.value)}
                className="h-9"
              />
            </div>
          )}

          <div className="space-y-2 max-h-96 overflow-y-auto mt-2">
            {loadingOverdue ? (
              [1,2,3].map(i => <Skeleton key={i} className="h-14" />)
            ) : overdue.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Sin pagos vencidos con huella registrada.</p>
            ) : (() => {
              const filtered = overdue.filter(o =>
                o.name.toLowerCase().includes(overdueSearch.toLowerCase()) ||
                String(o.zk_pin).includes(overdueSearch)
              );
              if (filtered.length === 0) {
                return <p className="py-8 text-center text-sm text-muted-foreground">No se encontraron resultados para "{overdueSearch}".</p>;
              }
              return filtered.map((o) => (
                <div key={o.payment_id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{o.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {/* `due_date` es `date`: con `new Date()` vencía un día antes. */}
                      PIN {o.zk_pin} · Vence {dayToLocalDate(o.due_date).toLocaleDateString('es-CO')} · ${Number(o.amount).toLocaleString('es-CO')}
                    </p>
                  </div>
                  {o.blocked ? (
                    <Button
                      variant="outline" size="sm" className="h-7 shrink-0 text-xs"
                      onClick={() => handleSetGroup(o.zk_pin, 1)}
                      disabled={actingPin === o.zk_pin}
                    >
                      {actingPin === o.zk_pin ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Restaurar'}
                    </Button>
                  ) : (
                    <Button
                      variant="destructive" size="sm" className="h-7 shrink-0 text-xs"
                      onClick={() => handleSetGroup(o.zk_pin, 2)}
                      disabled={actingPin === o.zk_pin}
                    >
                      {actingPin === o.zk_pin ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Bloquear'}
                    </Button>
                  )}
                </div>
              ));
            })()}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
