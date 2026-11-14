import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import type { MatchDto, ScorerHomeDto } from '@/lib/tournamentTypes';
import { groupForScorer } from '@/lib/tournamentDisplay';
import { MatchCard } from '@/components/tournaments/TournamentViews';
import { LiveScorer, type ScorerEndpoints } from '@/components/tournaments/LiveScorer';
import { useNoIndex } from '@/hooks/usePublicLive';

const TOKEN_MESSAGES: Record<string, string> = {
  token_vencido: 'Este enlace venció. Pídele a la organización uno nuevo.',
  token_revocado: 'Este enlace fue desactivado por la organización. Pídeles uno nuevo.',
  token_invalido: 'Este enlace no es válido. Revisa que lo hayas copiado completo.',
};

/** Anotador SIN cuenta: el token de la ruta es la credencial. */
export default function TournamentScorerPage() {
  const { token } = useParams<{ token: string }>();
  useNoIndex();
  const [home, setHome] = useState<ScorerHomeDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<MatchDto | null>(null);

  const base = `/api/v1/tournament-live/scorer/${encodeURIComponent(token ?? '')}`;
  const endpoints: ScorerEndpoints = useMemo(() => ({
    actionsUrl: (id) => `${base}/matches/${id}/actions`,
    takeUrl: (id) => `${base}/matches/${id}/take`,
    authMode: 'public',
  }), [base]);

  const load = useCallback(async () => {
    try {
      setHome(await bffClient.get<ScorerHomeDto>(base, undefined, 'public'));
      setProblem(null);
    } catch (e) {
      const err = e as { status?: number; body?: { code?: string } | null; message?: string };
      const code = err.body?.code ?? '';
      if (code in TOKEN_MESSAGES) setProblem(TOKEN_MESSAGES[code]);
      else if (err.status === 401 || err.status === 403 || err.status === 404) setProblem(TOKEN_MESSAGES.token_invalido);
      else setProblem((prev) => prev ?? 'No pudimos cargar los partidos. Revisa tu señal e intenta de nuevo.');
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  if (open && home) {
    return (
      <LiveScorer
        match={open} endpoints={endpoints} queueKey={`torneo-cola:token:${token}`} tournamentTitle={home.event.title}
        onClose={() => { setOpen(null); void load(); }}
      />
    );
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Cargando partidos…</div>;
  if (!home) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Card><CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <AlertCircle className="h-10 w-10 text-muted-foreground" />
          <p className="font-medium" role="alert">{problem ?? TOKEN_MESSAGES.token_invalido}</p>
          <Button variant="outline" onClick={() => { setLoading(true); void load(); }}>Reintentar</Button>
        </CardContent></Card>
      </div>
    );
  }

  const groups = groupForScorer(home.matches);
  return (
    <div className="mx-auto max-w-md space-y-4 p-3">
      <header>
        <h1 className="text-lg font-bold">{home.event.title}</h1>
        <p className="text-sm text-muted-foreground">Anotador · {home.scorekeeper.label}{home.scorekeeper.court ? ` · ${home.scorekeeper.court}` : ''}</p>
      </header>
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No hay partidos para anotar por ahora.</p>}
      {groups.map((g) => (
        <section key={g.court} className="space-y-2">
          <h2 className="text-sm font-semibold">{g.court}</h2>
          {g.matches.map((m) => (
            <MatchCard key={m.id} match={m} action={
              <Button size="sm" disabled={!m.home_team_id || !m.away_team_id || m.status === 'cancelled'} onClick={() => setOpen(m)}>
                {m.status === 'live' ? 'Seguir' : 'Anotar'}
              </Button>
            } />
          ))}
        </section>
      ))}
    </div>
  );
}
