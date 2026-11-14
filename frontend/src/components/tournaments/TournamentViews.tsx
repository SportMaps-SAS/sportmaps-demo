import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { StandingRow, StandingsDto } from '@/lib/tournamentTypes';
import {
  buildBracket, currentSetText, formatBogota, formatSetsLine, scoreText, standingColumns, stageLabel, STATUS_LABEL, teamName,
  type DisplayMatch,
} from '@/lib/tournamentDisplay';

/** Tarjeta de un partido (solo lectura). `action` permite poner un botón (p. ej. «Anotar»). */
export function MatchCard({ match, large = false, action }: { match: DisplayMatch; large?: boolean; action?: ReactNode }) {
  const live = match.status === 'live';
  const setsLine = match.model === 'sets' ? formatSetsLine(match.sets) : '';
  const curSet = match.model === 'sets' && live ? currentSetText(match.sets) : null;
  if (match.is_bye) {
    return (
      <div className="rounded-md border border-dashed p-2 text-sm text-muted-foreground" data-testid="match-bye">
        {teamName(match, 'home') === 'Pasa directo' ? teamName(match, 'away') : teamName(match, 'home')} · Pasa directo
      </div>
    );
  }
  const text = large ? 'text-2xl' : 'text-sm';
  return (
    <div className={`rounded-md border p-2 ${live ? 'border-primary bg-primary/5' : ''}`} data-testid="match-card">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{stageLabel(match)}</span>
        {match.court && <span>· {match.court}</span>}
        <span>· {formatBogota(match.scheduled_at)}</span>
        <Badge variant={live ? 'default' : 'outline'} className="ml-auto">{STATUS_LABEL[match.status]}</Badge>
      </div>
      {/* Nombres y marcador en su fila; las acciones van debajo en móvil y a la derecha desde sm (390 px no les deja espacio). */}
      <div className={`mt-1 flex flex-col gap-1 ${action ? 'sm:flex-row sm:items-center sm:gap-2' : ''}`}>
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${text}`}>
          <span className="min-w-0 flex-1 break-words text-right font-medium">{teamName(match, 'home')}</span>
          <span className="min-w-[3.5rem] text-center font-bold tabular-nums">{scoreText(match)}</span>
          <span className="min-w-0 flex-1 break-words font-medium">{teamName(match, 'away')}</span>
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center justify-end gap-1" data-testid="match-card-actions">{action}</div>}
      </div>
      {(setsLine || curSet) && (
        <div className={`mt-0.5 text-center text-muted-foreground ${large ? 'text-lg' : 'text-xs'}`}>
          {setsLine}{curSet && <span className="ml-2 font-semibold text-foreground">{curSet}</span>}
        </div>
      )}
    </div>
  );
}

export function StandingsTable({ rows, model }: { rows: StandingRow[]; model: 'goals' | 'sets' }) {
  const cols = standingColumns(model);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Sin equipos ni partidos aún.</p>;
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader><TableRow>
          <TableHead>Equipo</TableHead>
          {cols.map((c) => <TableHead key={c.key} className={c.strong ? 'font-bold' : ''}>{c.label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.team_id}>
              <TableCell className="font-medium">{i + 1}. {r.team_name}</TableCell>
              {cols.map((c) => <TableCell key={c.key} className={c.strong ? 'font-bold' : ''}>{c.value(r)}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Liga = una tabla; grupos = una tabla por grupo. */
export function StandingsView({ data }: { data: Pick<StandingsDto, 'model' | 'standings' | 'groups'> | null | undefined }) {
  if (!data) return <p className="text-sm text-muted-foreground">Sin posiciones aún.</p>;
  const groups = data.groups ? Object.entries(data.groups).sort(([a], [b]) => a.localeCompare(b)) : [];
  if (groups.length > 0) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map(([label, rows]) => (
          <div key={label} className="space-y-1">
            <h4 className="text-sm font-semibold">Grupo {label}</h4>
            <StandingsTable rows={rows} model={data.model} />
          </div>
        ))}
      </div>
    );
  }
  return <StandingsTable rows={data.standings} model={data.model} />;
}

/** Cuadro de fase final por rondas. Si el equipo aún no está definido muestra su referencia («1.º Grupo A»). */
export function BracketView({ matches, large = false, renderAction }: { matches: DisplayMatch[]; large?: boolean; renderAction?: (m: DisplayMatch) => ReactNode }) {
  const { rounds, thirdPlace } = buildBracket(matches);
  if (rounds.length === 0 && !thirdPlace) return <p className="text-sm text-muted-foreground">La fase final aparecerá cuando se genere el calendario.</p>;
  return (
    <div className="space-y-4">
      <div className="flex gap-4 overflow-x-auto pb-2">
        {rounds.map((r) => (
          <div key={r.round} className="min-w-[16rem] flex-1 space-y-2">
            <h4 className="text-sm font-semibold">{r.name}</h4>
            {r.matches.map((m) => <MatchCard key={m.id} match={m} large={large} action={renderAction?.(m)} />)}
          </div>
        ))}
      </div>
      {thirdPlace && (
        <div className="max-w-sm space-y-2">
          <h4 className="text-sm font-semibold">Tercer puesto</h4>
          <MatchCard match={thirdPlace} large={large} action={renderAction?.(thirdPlace)} />
        </div>
      )}
    </div>
  );
}
