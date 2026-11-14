import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent } from '@/components/ui/card';
import { CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { useNoIndex } from '@/hooks/usePublicLive';

interface Validation {
  tournament: { title: string; logo_url: string | null };
  player: { first_name: string; photo_url: string | null; shirt_number: number | null };
  team: { name: string; logo_url: string | null };
  category: string | null;
  status: 'habilitado' | 'no_habilitado';
  reasons: string[];
  checked_at: string;
}

/** Validación en cancha del carné (QR): lo mínimo para evitar suplantaciones, sin datos privados. */
export default function TournamentCardValidationPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  useNoIndex();
  const [v, setV] = useState<Validation | null>(null);
  const [bad, setBad] = useState(false);

  useEffect(() => {
    bffClient.get<Validation>(`/api/v1/tournament-live/public/${encodeURIComponent(slug ?? '')}/validate/${encodeURIComponent(token ?? '')}`, undefined, 'public')
      .then(setV).catch(() => setBad(true));
  }, [slug, token]);

  if (bad) return (
    <div className="mx-auto max-w-sm px-4 py-10"><Card><CardContent className="flex flex-col items-center gap-3 py-10 text-center" data-testid="card-invalid">
      <ShieldAlert className="h-12 w-12 text-destructive" /><p className="text-lg font-semibold">Carné no válido</p>
      <p className="text-sm text-muted-foreground">Este QR no corresponde a ningún carné del torneo. Pide un documento de identidad.</p>
    </CardContent></Card></div>
  );
  if (!v) return <div className="py-10 text-center text-sm text-muted-foreground">Validando…</div>;

  const ok = v.status === 'habilitado';
  return (
    <div className="mx-auto max-w-sm px-4 py-8">
      <Card className={ok ? 'border-green-600' : 'border-destructive'}>
        <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-xs text-muted-foreground">{v.tournament.title}</p>
          {v.player.photo_url
            ? <img src={v.player.photo_url} alt="" className="h-32 w-32 rounded-full border-4 object-cover" style={{ borderColor: ok ? '#16a34a' : '#dc2626' }} />
            : <span className="flex h-24 w-24 items-center justify-center rounded-full bg-muted text-3xl font-bold">{v.player.first_name.slice(0, 1)}</span>}
          <p className="text-2xl font-bold">{v.player.first_name}{v.player.shirt_number != null ? ` · #${v.player.shirt_number}` : ''}</p>
          <p className="text-sm">{v.team.name}{v.category ? ` · ${v.category}` : ''}</p>
          <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-lg font-semibold text-white ${ok ? 'bg-green-600' : 'bg-destructive'}`} data-testid="card-status">
            {ok ? <CheckCircle2 className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}{ok ? 'Habilitado' : 'No habilitado'}
          </div>
          {v.reasons.length > 0 && <ul className="text-sm text-destructive">{v.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          <p className="text-xs text-muted-foreground">Consultado {new Date(v.checked_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
        </CardContent>
      </Card>
    </div>
  );
}
