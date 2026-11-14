/**
 * Aviso para cuentas sin escuela (inicio y «Mis hijos»): «¿Ya tienes escuela?
 * Ingresa su código». También muestra las solicitudes en revisión y, si la
 * persona venía de /unirse?codigo=… antes de registrarse, la lleva de vuelta.
 *
 * Si la RPC falla (p. ej. la migración aún no está aplicada), no muestra nada.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { KeyRound, Clock, XCircle, ChevronRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { schoolJoinApi } from '@/lib/api/schoolJoin';
import { formatJoinCode, joinErrorMessage, readPendingJoinCode } from '@/lib/schoolJoinCode';

export function JoinSchoolCodeBanner({ className = '' }: { className?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const redirected = useRef(false);

  // Venía con un código antes de registrarse/entrar: retomar donde iba.
  useEffect(() => {
    if (!user || redirected.current) return;
    const pending = readPendingJoinCode();
    if (pending) {
      redirected.current = true;
      navigate(`/unirse?codigo=${encodeURIComponent(formatJoinCode(pending))}`);
    }
  }, [user, navigate]);

  const { data } = useQuery({
    queryKey: ['my-school-join-status', user?.id],
    queryFn: () => schoolJoinApi.myStatus(),
    enabled: !!user,
    retry: false,
    staleTime: 60_000,
  });

  if (!data) return null;

  const pending = data.requests.filter((r) => r.status === 'pending');
  const rejected = data.has_school ? [] : data.requests.filter((r) => r.status === 'rejected').slice(0, 1);

  if (data.has_school && pending.length === 0) return null;

  const cancel = async (id: string) => {
    try {
      await schoolJoinApi.cancel(id);
      qc.invalidateQueries({ queryKey: ['my-school-join-status'] });
      toast({ title: 'Solicitud cancelada' });
    } catch (e) {
      toast({ title: 'No se pudo cancelar', description: joinErrorMessage(e), variant: 'destructive' });
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {pending.map((r) => (
        <div key={r.id} className="rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 p-4 flex gap-3">
          <Clock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm">Solicitud enviada a {r.school_name}</p>
            <p className="text-sm text-muted-foreground">
              {r.for_whom === 'child' ? `${r.athlete_name}: ` : ''}
              la escuela te asignará la categoría. Te avisamos cuando lo haga.
            </p>
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => cancel(r.id)}
            >
              Cancelar solicitud
            </button>
          </div>
        </div>
      ))}

      {rejected.map((r) => (
        <div key={r.id} className="rounded-2xl border p-4 flex gap-3">
          <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-semibold text-sm">{r.school_name} no aprobó la solicitud de {r.athlete_name}</p>
            {r.reject_reason && <p className="text-sm text-muted-foreground">Motivo: {r.reject_reason}</p>}
          </div>
        </div>
      ))}

      {!data.has_school && pending.length === 0 && (
        <button
          type="button"
          onClick={() => navigate('/unirse')}
          className="w-full text-left rounded-2xl border-2 border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors p-4 sm:p-5 flex items-center gap-4"
        >
          <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-tight">¿Ya tienes escuela?</p>
            <p className="text-sm text-muted-foreground">Ingresa el código que te dio tu escuela para unirte.</p>
          </div>
          <Button asChild size="sm" variant="ghost" className="shrink-0 pointer-events-none">
            <span><ChevronRight className="h-5 w-5" /></span>
          </Button>
        </button>
      )}
    </div>
  );
}
