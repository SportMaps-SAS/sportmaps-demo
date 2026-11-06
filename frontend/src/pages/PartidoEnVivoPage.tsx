/**
 * /partido-en-vivo/:matchId — pantalla de cancha del Partido en vivo (F2-b).
 * Gate: flag `live_match_enabled` de la escuela (vía entitlements) Y rol staff/coach. Las RPC revalidan adentro.
 */
import { Navigate, useParams } from 'react-router-dom';
import { useLiveMatchEnabled } from '@/hooks/useLiveMatchEnabled';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { LiveMatchScreen } from '@/components/partido-vivo/LiveMatchScreen';
import { EmptyNote, SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import { PUEDEN_LLEVAR_EN_VIVO } from '@/components/partido-vivo/liveAccess';

export default function PartidoEnVivoPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const { currentUserRole, schoolId } = useSchoolContext();
  const flag = useLiveMatchEnabled();

  if (!matchId) return <Navigate to="/results" replace />;
  if (!schoolId || !currentUserRole) return <div className="p-4"><SectionSkeleton rows={3} label="Cargando" /></div>;
  if (!PUEDEN_LLEVAR_EN_VIVO.includes(currentUserRole)) {
    return <div className="p-4"><EmptyNote><p className="font-semibold text-foreground">Solo la dirección y los entrenadores llevan el partido en vivo.</p></EmptyNote></div>;
  }
  if (!flag) {
    return (
      <div className="p-4">
        <EmptyNote>
          <p className="font-semibold text-foreground">El partido en vivo no está habilitado para tu escuela.</p>
          <p className="mt-1">Escríbele a SportMaps si quieres activarlo.</p>
        </EmptyNote>
      </div>
    );
  }
  return <LiveMatchScreen key={matchId} matchId={matchId} />;
}
