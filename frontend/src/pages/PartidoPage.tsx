/**
 * /partidos/:matchId  ·  /partidos/nuevo?equipo=<teamId>
 *
 * Envoltorio de ruta de la pantalla del partido (PartidoFlujo). Al crear uno
 * nuevo se reemplaza la URL por la del partido para que «atrás» y recargar
 * sigan funcionando.
 */
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PartidoFlujo } from '@/components/partidos/PartidoFlujo';
import { PASOS, type PasoPartido } from '@/components/partidos/partidoFlujoLogic';

const esPaso = (v: string | null): v is PasoPartido => !!v && PASOS.some((p) => p.id === v);

export default function PartidoPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const nuevo = !matchId || matchId === 'nuevo';
  const paso = params.get('paso');

  return (
    <div className="px-0 py-2 sm:px-2">
      <PartidoFlujo
        key={nuevo ? `nuevo:${params.get('equipo') ?? ''}` : matchId}
        matchId={nuevo ? null : matchId!}
        teamId={params.get('equipo')}
        pasoPedido={esPaso(paso) ? paso : null}
        onCreado={(id, siguiente) => navigate(`/partidos/${encodeURIComponent(id)}?paso=${siguiente}`, { replace: true })}
        onVolver={() => (window.history.length > 1 ? navigate(-1) : navigate('/results'))}
      />
    </div>
  );
}
