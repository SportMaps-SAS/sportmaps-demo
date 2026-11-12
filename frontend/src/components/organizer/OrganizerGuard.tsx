import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';

/**
 * El organizador tiene ENTIDAD: una fila de `schools` con school_type 'event_organizer' de la que es
 * dueño (spec organizador-torneos-modulo-aparte §3). Antes el guard miraba `event_organizers`, una
 * tabla que ningún organizador llegó a llenar (el BFF lo rechazaba), y todos caían en un onboarding roto.
 *
 *  - sin organización, o con el onboarding sin terminar → /organizer/onboarding
 *  - con la organización lista y entrando al onboarding → directo a sus torneos
 */
type OrgStatus = 'loading' | 'missing' | 'incomplete' | 'ready' | 'error';

export function OrganizerGuard() {
  const { user, profile, loading: authLoading } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<OrgStatus>('loading');

  useEffect(() => {
    let isMounted = true;

    async function check() {
      if (!user?.id || profile?.role !== 'organizer') {
        if (isMounted) setStatus('loading');
        return;
      }
      try {
        const { data, error } = await supabase
          .from('schools')
          .select('id, onboarding_status')
          .eq('owner_id', user.id)
          .eq('school_type', 'event_organizer')
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (!isMounted) return;
        if (error) {
          console.error('Error leyendo la organización del organizador:', error);
          setStatus('error');
          return;
        }
        if (!data) setStatus('missing');
        else setStatus(data.onboarding_status === 'completed' ? 'ready' : 'incomplete');
      } catch (err) {
        console.error('Check organizer status error:', err);
        if (isMounted) setStatus('error');
      }
    }

    if (!authLoading) check();
    return () => { isMounted = false; };
  }, [user, profile, authLoading]);

  if (authLoading || status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Si no está autenticado o no es organizador, lo sacamos
  if (!user || profile?.role !== 'organizer') {
    return <Navigate to="/dashboard" replace />;
  }

  const isOnboardingRoute = location.pathname.includes('/organizer/onboarding');

  if ((status === 'missing' || status === 'incomplete') && !isOnboardingRoute) {
    return <Navigate to="/organizer/onboarding" replace />;
  }
  if (status === 'ready' && isOnboardingRoute) {
    return <Navigate to="/school/tournaments" replace />;
  }

  return (
    <div className="flex flex-col min-h-screen w-full">
      <div className="flex-1 w-full bg-background/50">
        <Outlet />
      </div>
    </div>
  );
}

/** /organizer/event/:id (pantalla vieja) → el detalle del torneo en el motor nuevo. */
export function OrganizerEventRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/school/tournaments/${id}` : '/school/tournaments'} replace />;
}
