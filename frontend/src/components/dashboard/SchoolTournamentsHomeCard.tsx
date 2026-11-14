import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { bffClient } from '@/lib/api/bffClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, IdCard, Plus, Radio, Trophy, Users } from 'lucide-react';

interface Row { id: string; title: string; event_date: string | null; status: string; slug: string }

const STATUS: Record<string, string> = { draft: 'Borrador', active: 'Publicado', closed: 'Cerrado', completed: 'Finalizado' };

/**
 * Inicio del admin de la escuela: sus torneos con accesos directos (equipos, calendario, en vivo,
 * carnés) y «Crear torneo». Se oculta solo si no es admin o la escuela no tiene el módulo Torneos.
 */
export function SchoolTournamentsHomeCard() {
  const { profile } = useAuth();
  const { hasAddon, isLoading } = useEntitlements();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const isAdmin = profile?.role === 'school' || (profile?.role as string) === 'school_admin';
  const enabled = isAdmin && !isLoading && hasAddon('tournaments');

  useEffect(() => {
    if (!enabled) return;
    bffClient.get<Row[]>('/api/v1/events/school-tournaments').then(setRows).catch(() => setRows([]));
  }, [enabled]);

  if (!enabled || rows === null) return null;
  const list = rows.filter((r) => r.status !== 'cancelled').slice(0, 3);
  const go = (id: string, tab: string) => navigate(`/school/tournaments/${id}?tab=${tab}`);

  return (
    <Card data-testid="school-tournaments-home">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-semibold"><Trophy className="h-4 w-4 text-primary" /> Torneos</p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => navigate('/school/tournaments')}>Ver todos</Button>
            <Button size="sm" onClick={() => navigate('/school/tournaments/nuevo-rapido')}><Plus className="mr-1 h-4 w-4" /> Crear torneo</Button>
          </div>
        </div>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">Organiza tu primer torneo: equipos propios y rivales sin cuenta, calendario, marcador en vivo y carnés.</p>
        ) : list.map((t) => (
          <div key={t.id} className="space-y-2 rounded-md border p-2">
            <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => go(t.id, 'info')}>
              <span className="truncate font-medium">{t.title}</span>
              <Badge variant="outline">{STATUS[t.status] ?? t.status}</Badge>
            </button>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className="h-8" onClick={() => go(t.id, 'inscritos')}><Users className="mr-1 h-3.5 w-3.5" /> Equipos</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => go(t.id, 'resultados')}><CalendarDays className="mr-1 h-3.5 w-3.5" /> Calendario y en vivo</Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => go(t.id, 'carnes')}><IdCard className="mr-1 h-3.5 w-3.5" /> Carnés</Button>
              {t.status !== 'draft' && (
                <Button size="sm" variant="ghost" className="h-8" asChild><a href={`/torneo/${t.slug}/en-vivo`} target="_blank" rel="noreferrer"><Radio className="mr-1 h-3.5 w-3.5" /> Página pública</a></Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
