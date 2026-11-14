import { useParams, useNavigate } from 'react-router-dom';
import { etiquetaAsistencia } from '@/components/account-statement/estadoCuentaModel';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ArrowLeft, Calendar, CheckCircle2, XCircle, Clock, AlertCircle, Dumbbell } from 'lucide-react';


export default function ChildAttendancePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();


  // Fetch child info
  const { data: child, isLoading: loadingChild } = useQuery({
    queryKey: ['child', id],
    queryFn: async () => {

      const { data, error } = await supabase
        .from('children')
        .select('*, teams(name, sport)')
        .eq('id', id)
        .eq('parent_id', user?.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id && !!user?.id,
  });

  // Asistencia del hijo. Sale de `attendance_records`, que es donde el
  // entrenador registra: la tabla legacy `attendance` que se leía acá tiene
  // CERO filas, así que esta pantalla estaba vacía siempre. La habilita la RLS
  // "Parents can view attendance of their children".
  const { data: attendance, isLoading: loadingAttendance } = useQuery({
    queryKey: ['attendance', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance_records')
        .select('id, attendance_date, status, notes')
        .eq('child_id', id)
        .order('attendance_date', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Sesiones PT del hijo
  const { data: ptSessions } = useQuery({
    queryKey: ['child-pt-attendance', id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('trainer_session_plans')
        .select('id, name, status, session_date, trainer_id')
        .eq('client_id', id)
        .in('status', ['completed', 'assigned'])
        .order('session_date', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!id,
  });

  const hasPT = (ptSessions?.length ?? 0) > 0;
  const ptPresent = ptSessions?.filter(s => s.status === 'completed').length ?? 0;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'present':
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case 'absent':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'late':
        return <Clock className="h-5 w-5 text-yellow-500" />;
      case 'excused':
        return <AlertCircle className="h-5 w-5 text-blue-500" />;
      default:
        return <AlertCircle className="h-5 w-5 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'present':
        return <Badge className="bg-green-500">Presente</Badge>;
      case 'absent':
        return <Badge variant="destructive">Ausente</Badge>;
      case 'late':
        return <Badge className="bg-yellow-500">Tardanza</Badge>;
      case 'excused':
        return <Badge className="bg-blue-500">Justificada</Badge>;
      default:
        return <Badge variant="secondary">{etiquetaAsistencia(status).label}</Badge>;
    }
  };

  const stats = {
    total: attendance?.length || 0,
    present: attendance?.filter(a => a.status === 'present').length || 0,
    absent: attendance?.filter(a => a.status === 'absent').length || 0,
    late: attendance?.filter(a => a.status === 'late').length || 0,
    excused: attendance?.filter(a => a.status === 'excused').length || 0,
  };

  // Presente + tardanza, igual que GET /attendance/rate/:teamId del BFF.
  const attendanceRate = stats.total > 0
    ? Math.round(((stats.present + stats.late) / stats.total) * 100)
    : 0;

  if (loadingChild || loadingAttendance) {
    return <LoadingSpinner fullScreen text="Cargando asistencias..." />;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-4 bg-background/50 backdrop-blur-sm p-4 rounded-2xl border border-border/40 shadow-sm sticky top-0 z-10 transition-all">
        <Button variant="ghost" size="icon" onClick={() => navigate('/children')} className="rounded-full hover:bg-primary/10 hover:text-primary transition-all">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-white font-bold text-xl shadow-lg">
            {child?.full_name?.charAt(0)}
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{child?.full_name}</h1>
            <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
              <Badge variant="outline" className="text-[9px] py-0 h-4 border-primary/20 text-primary uppercase">
                {(child as any)?.teams?.sport || 'Deporte'}
              </Badge>
              <span className="opacity-40">•</span>
              <span>Asistencias</span>
            </div>
          </div>
        </div>
      </div>

      {/* Summary Cards Premium */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border-primary/20 shadow-lg shadow-primary/5 overflow-hidden group col-span-1 md:col-span-1">
          <CardContent className="p-5 relative">
            <Calendar className="absolute -right-2 -bottom-2 h-16 w-16 text-primary/5 group-hover:scale-110 transition-transform duration-700" />
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary">
                <Calendar className="h-5 w-5" />
              </div>
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Tasa</p>
            </div>
            <div className="flex items-baseline gap-1">
              <p className="text-4xl font-black text-primary">{attendanceRate}%</p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-green-500/10 via-green-500/5 to-transparent border-green-500/20 shadow-lg shadow-green-500/5 overflow-hidden group">
          <CardContent className="p-5 relative">
            <CheckCircle2 className="absolute -right-2 -bottom-2 h-16 w-16 text-green-500/5 group-hover:scale-110 transition-transform duration-700" />
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-xl bg-green-500/20 flex items-center justify-center text-green-500">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Presente</p>
            </div>
            <p className="text-4xl font-black text-green-600 dark:text-green-500">{stats.present}</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-red-500/10 via-red-500/5 to-transparent border-red-500/20 shadow-lg shadow-red-500/5 overflow-hidden group">
          <CardContent className="p-5 relative">
            <XCircle className="absolute -right-2 -bottom-2 h-16 w-16 text-red-500/5 group-hover:scale-110 transition-transform duration-700" />
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-xl bg-red-500/20 flex items-center justify-center text-red-500">
                <XCircle className="h-5 w-5" />
              </div>
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Ausente</p>
            </div>
            <p className="text-4xl font-black text-red-600 dark:text-red-500">{stats.absent}</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-yellow-500/10 via-yellow-500/5 to-transparent border-yellow-500/20 shadow-lg shadow-yellow-500/5 overflow-hidden group">
          <CardContent className="p-5 relative">
            <Clock className="absolute -right-2 -bottom-2 h-16 w-16 text-yellow-500/5 group-hover:scale-110 transition-transform duration-700" />
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-xl bg-yellow-500/20 flex items-center justify-center text-yellow-500">
                <Clock className="h-5 w-5" />
              </div>
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Tardanza</p>
            </div>
            <p className="text-4xl font-black text-yellow-600 dark:text-yellow-500">{stats.late}</p>
          </CardContent>
        </Card>

        {hasPT && (
          <Card className="bg-gradient-to-br from-indigo-500/10 via-indigo-500/5 to-transparent border-indigo-500/20 shadow-lg overflow-hidden group md:col-span-4">
            <CardContent className="p-4 flex items-center gap-6">
              <div className="h-10 w-10 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-500 shrink-0">
                <Dumbbell className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground/80">Entrenador Personal</p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  <span className="text-2xl font-black text-indigo-500 mr-1">{ptPresent}</span>
                  sesiones completadas de {ptSessions?.length ?? 0} asignadas
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Attendance List Premium */}
      <Card className="border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/30 border-b border-border/40">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Historial de Clases
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border/40">
            {attendance?.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between p-4 bg-card hover:bg-accent/30 transition-all group/row"
              >
                <div className="flex items-center gap-4">
                  <div className={`h-12 w-12 rounded-xl flex items-center justify-center transition-colors ${
                    record.status === 'present' ? 'bg-green-500/10 text-green-500' :
                    record.status === 'absent' ? 'bg-red-500/10 text-red-500' :
                    'bg-yellow-500/10 text-yellow-500'
                  }`}>
                    {getStatusIcon(record.status)}
                  </div>
                  <div>
                    <p className="font-bold text-foreground group-hover/row:text-primary transition-colors capitalize">
                      {new Date(record.attendance_date).toLocaleDateString('es-CO', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                      })}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase font-black tracking-tighter mt-0.5">
                      <Clock className="h-3 w-3" />
                      Año {new Date(record.attendance_date).getFullYear()}
                    </div>
                    {/* Era `justification_reason`, que no existe en
                        attendance_records: la columna es `notes`, y el select ya
                        la traia. La nota nunca se mostraba. */}
                    {record.notes && (
                      <p className="text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded inline-block mt-1 italic">
                        Nota: {record.notes}
                      </p>
                    )}
                  </div>
                </div>
                <div className="scale-90 opacity-80 group-hover/row:scale-100 group-hover/row:opacity-100 transition-all">
                  {getStatusBadge(record.status)}
                </div>
              </div>
            ))}

            {(!attendance || attendance.length === 0) && (
              <div className="text-center py-8">
                <Calendar className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No hay registros de asistencia</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sesiones PT */}
      {hasPT && (
        <Card className="border-border/50 shadow-sm overflow-hidden">
          <CardHeader className="bg-muted/30 border-b border-border/40">
            <CardTitle className="text-lg font-bold flex items-center gap-2">
              <Dumbbell className="h-5 w-5 text-primary" />
              Sesiones de Entrenador Personal
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/40">
              {ptSessions?.map(session => (
                <div
                  key={session.id}
                  className="flex items-center justify-between p-4 bg-card hover:bg-accent/30 transition-all group/row"
                >
                  <div className="flex items-center gap-4">
                    <div className={`h-12 w-12 rounded-xl flex items-center justify-center transition-colors ${
                      session.status === 'completed'
                        ? 'bg-green-500/10 text-green-500'
                        : 'bg-primary/10 text-primary'
                    }`}>
                      {session.status === 'completed'
                        ? <CheckCircle2 className="h-5 w-5" />
                        : <Clock className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="font-bold text-foreground group-hover/row:text-primary transition-colors">
                        {session.name}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase font-black tracking-tighter mt-0.5">
                        <Calendar className="h-3 w-3" />
                        {new Date(session.session_date).toLocaleDateString('es-CO', {
                          weekday: 'long', day: 'numeric', month: 'long',
                        })}
                      </div>
                    </div>
                  </div>
                  <Badge
                    className={session.status === 'completed'
                      ? 'bg-green-500/20 text-green-700 border-green-500/30'
                      : 'bg-primary/10 text-primary border-primary/20'}
                  >
                    {session.status === 'completed' ? '✅ Completada' : '⏳ Pendiente'}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
