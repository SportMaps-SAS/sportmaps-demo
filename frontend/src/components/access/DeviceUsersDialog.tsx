import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Fingerprint, KeyRound, ScanFace, Search, Link2, AlertTriangle } from 'lucide-react';

type AthleteType = 'child' | 'unregistered' | 'adult';
type Billing = 'staff' | 'al_dia' | 'mora' | 'sin_inscripcion' | null;
type Filter = 'all' | 'sin' | 'aso' | 'mora';

interface RosterRow {
  pin: number;
  reader_name: string;
  /** null = no se pudo leer del lector (distinto de «no tiene»). */
  has_face: boolean | null;
  has_fingerprint: boolean | null;
  has_password: boolean;
  athlete: { id: string; type: AthleteType | 'staff'; name: string } | null;
  billing: Billing;
  suggestion: { id: string; type: AthleteType; name: string; score: number } | null;
}

interface RosterResponse {
  simulated: boolean;
  synced_at: string | null;
  summary: { total: number; associated: number; unassociated: number; overdue_associated: number; with_suggestion: number };
  rows: RosterRow[];
  page: number;
  page_size: number;
  total_filtered: number;
}

interface MemberOption {
  child_id?: string;
  unregistered_athlete_id?: string;
  user_id?: string;
  full_name: string;
  type: 'child' | 'unregistered' | 'registered';
  role?: string | null;
  /** Para distinguir homónimos: plan, estado de cobro y fecha de nacimiento. */
  detail?: {
    plan: string | null;
    billing: 'al_dia' | 'mora' | 'sin_inscripcion' | null;
    date_of_birth: string | null;
    created_at?: string | null;
  };
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Dueño', admin: 'Admin', school_admin: 'Admin', coach: 'Entrenador', staff: 'Staff',
  athlete: 'Deportista', parent: 'Acudiente',
};

function ageFrom(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(`${dob}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

/** Línea de apoyo bajo el nombre: «Menor · 9 años · plan PGP8x1 · al día». */
function candidateLine(c: MemberOption): { text: string; mora: boolean } {
  const kind = c.type === 'child' ? 'Menor'
    : c.type === 'unregistered' ? 'Sin cuenta'
    : (c.role && ROLE_LABELS[c.role]) || 'Con cuenta';
  const parts = [kind];
  const age = ageFrom(c.detail?.date_of_birth);
  if (age !== null) parts.push(`${age} años`);
  if (c.detail?.plan) parts.push(`plan ${c.detail.plan}`);
  const billing = c.detail?.billing;
  if (billing === 'mora') parts.push('en mora');
  else if (billing === 'al_dia') parts.push('al día');
  else if (billing === 'sin_inscripcion') parts.push('sin inscripción activa');
  // La fecha de alta separa a los homónimos que comparten plan y no tienen fecha de nacimiento.
  if (c.detail?.created_at) {
    const alta = new Date(c.detail.created_at);
    if (!Number.isNaN(alta.getTime())) {
      parts.push(`alta ${alta.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: '2-digit' })}`);
    }
  }
  return { text: parts.join(' · '), mora: billing === 'mora' };
}

const PAGE_SIZE = 25;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'sin', label: 'Sin asociar' },
  { id: 'aso', label: 'Asociados' },
  { id: 'mora', label: 'Con mora' },
];

/** Cuerpo del POST /access/assign-user según el tipo de deportista. */
function assignBody(pin: number, id: string, type: AthleteType | 'staff') {
  if (type === 'child') return { zk_pin: pin, child_id: id };
  if (type === 'unregistered') return { zk_pin: pin, unregistered_athlete_id: id };
  return { zk_pin: pin, user_id: id };
}

function BillingBadge({ billing }: { billing: Billing }) {
  if (!billing) return <span className="text-muted-foreground">—</span>;
  if (billing === 'staff') return <Badge variant="outline" className="text-[11px]">Staff</Badge>;
  if (billing === 'mora') {
    return <Badge variant="outline" className="text-[11px] border-red-200 bg-red-500/10 text-red-600">Mora</Badge>;
  }
  if (billing === 'al_dia') {
    return <Badge variant="outline" className="text-[11px] border-green-200 bg-green-500/10 text-green-600">Al día</Badge>;
  }
  return <Badge variant="outline" className="text-[11px] text-muted-foreground">Sin inscripción</Badge>;
}

function Credentials({ row }: { row: RosterRow }) {
  // null = el lector no entregó ese dato (p. ej. el rostro con pyzk): se muestra «—», no como «no tiene».
  const item = (on: boolean | null, label: string, Icon: typeof Fingerprint) => {
    if (on === null) {
      return (
        <span
          className="flex h-4 w-4 items-center justify-center text-xs text-muted-foreground/60"
          title={`${label}: sin leer`}
          aria-label={`${label}: sin leer`}
        >
          —
        </span>
      );
    }
    return (
      <Icon
        className={`h-4 w-4 ${on ? 'text-foreground' : 'text-muted-foreground/30'}`}
        aria-label={`${label}: ${on ? 'registrada' : 'no registrada'}`}
      >
        <title>{label}: {on ? 'registrada' : 'no registrada'}</title>
      </Icon>
    );
  };
  return (
    <div className="flex items-center gap-2">
      {item(row.has_fingerprint, 'Huella', Fingerprint)}
      {item(row.has_face, 'Rostro', ScanFace)}
      {item(row.has_password, 'Clave', KeyRound)}
    </div>
  );
}

/** Primer nombre del lector («AtheneaCardona» → «Athenea»): precarga la búsqueda de candidatos. */
function firstNameOf(readerName: string): string {
  return (readerName || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim().split(/\s+/)[0] ?? '';
}

function minutesAgo(iso: string | null): string {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DeviceUsersDialog({ open, onClose }: Props) {
  const { toast } = useToast();
  const [data, setData] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [page, setPage] = useState(1);
  const [actingPin, setActingPin] = useState<number | null>(null);

  // Diálogo de asociar a mano
  const [assignRow, setAssignRow] = useState<RosterRow | null>(null);
  const [candQ, setCandQ] = useState('');
  const [candidates, setCandidates] = useState<MemberOption[]>([]);
  const [loadingCand, setLoadingCand] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ filter, page: String(page), page_size: String(PAGE_SIZE) });
      if (qApplied) params.set('q', qApplied);
      const res = await bffClient.get<RosterResponse>(`/api/v1/access/device-users?${params.toString()}`);
      setData(res);
    } catch (err: any) {
      toast({ title: 'No se pudo cargar la lista', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [filter, page, qApplied, toast]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Búsqueda con pequeña espera para no pedir en cada tecla.
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQApplied(q.trim()); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Candidatos del diálogo «Asociar»: reutiliza el listado de miembros sin PIN de Control de acceso.
  useEffect(() => {
    if (!assignRow) return;
    let alive = true;
    const t = setTimeout(async () => {
      setLoadingCand(true);
      try {
        const term = candQ.trim();
        const res = await bffClient.get<{ members: MemberOption[] }>(
          `/api/v1/access/members${term ? `?q=${encodeURIComponent(term)}` : ''}`,
        );
        if (alive) setCandidates(res.members ?? []);
      } catch {
        if (alive) setCandidates([]);
      } finally {
        if (alive) setLoadingCand(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [assignRow, candQ]);

  const assign = async (pin: number, body: Record<string, unknown>, who: string) => {
    setActingPin(pin);
    try {
      await bffClient.post('/api/v1/access/assign-user', body);
      toast({ title: 'PIN asociado', description: `El PIN ${pin} quedó asociado a ${who}.` });
      setAssignRow(null);
      setCandQ('');
      await load();
    } catch (err: any) {
      toast({ title: 'No se pudo asociar', description: err?.message, variant: 'destructive' });
    } finally {
      setActingPin(null);
    }
  };

  const summary = data?.summary;
  const totalPages = data ? Math.max(1, Math.ceil(data.total_filtered / data.page_size)) : 1;

  return (
    <>
      <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>IDs del lector</DialogTitle>
            <DialogDescription>
              Usuarios cargados en el lector, para asociarlos a deportistas de SportMaps.
              {data && ` Actualizado ${minutesAgo(data.synced_at)}.`}
              {' '}Los nombres vienen de la última lectura del lector (se reemplazan en cada actualización) y
              solo sirven para sugerir; la asociación la confirmas tú.
            </DialogDescription>
          </DialogHeader>

          {data?.simulated && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Datos simulados para pruebas: esta escuela no tiene un lector conectado.</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'En el lector', value: summary?.total },
              { label: 'Asociados', value: summary?.associated },
              { label: 'Sin asociar', value: summary?.unassociated },
              { label: 'Asociados con mora', value: summary?.overdue_associated, danger: true },
            ].map(c => (
              <div key={c.label} className="rounded-lg border bg-card px-3 py-2">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={`text-2xl font-semibold ${c.danger && (c.value ?? 0) > 0 ? 'text-red-600' : ''}`}>
                  {c.value ?? '—'}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map(f => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? 'default' : 'outline'}
                className="h-8"
                onClick={() => { setFilter(f.id); setPage(1); }}
              >
                {f.label}
              </Button>
            ))}
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Buscar por PIN o nombre"
                className="h-9 pl-8"
              />
            </div>
          </div>

          {/* min-w-0: sin esto la tabla (más ancha que el celular) estira todo el diálogo en vez de
              desplazarse dentro de su propio contenedor. */}
          <div className="min-w-0 rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">PIN</TableHead>
                  <TableHead>Nombre en el lector</TableHead>
                  <TableHead className="w-28">Credenciales</TableHead>
                  <TableHead>Asociado a</TableHead>
                  <TableHead className="w-28">Cobro</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !data && (
                  [1, 2, 3, 4, 5].map(i => (
                    <TableRow key={i}><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                )}
                {data && data.rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                      {data.summary.total === 0
                        ? 'Todavía no hay usuarios del lector. Se cargan al sincronizar con el lector.'
                        : 'Ningún usuario coincide con el filtro.'}
                    </TableCell>
                  </TableRow>
                )}
                {data?.rows.map(row => (
                  <TableRow key={row.pin}>
                    <TableCell className="font-mono text-sm">{row.pin}</TableCell>
                    <TableCell className="max-w-44 truncate">{row.reader_name || '—'}</TableCell>
                    <TableCell><Credentials row={row} /></TableCell>
                    <TableCell className="max-w-56 truncate">
                      {row.athlete
                        ? row.athlete.name
                        : row.suggestion
                          ? <span className="text-muted-foreground">Sugerido: {row.suggestion.name} · {Math.round(row.suggestion.score * 100)} %</span>
                          : <span className="text-muted-foreground/70">Sin asociar</span>}
                    </TableCell>
                    <TableCell><BillingBadge billing={row.billing} /></TableCell>
                    <TableCell className="text-right">
                      {!row.athlete && row.suggestion && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={actingPin === row.pin}
                          onClick={() => assign(row.pin, assignBody(row.pin, row.suggestion!.id, row.suggestion!.type), row.suggestion!.name)}
                        >
                          Confirmar
                        </Button>
                      )}
                      {!row.athlete && !row.suggestion && (
                        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => { setCandQ(firstNameOf(row.reader_name)); setAssignRow(row); }}>
                          <Link2 className="h-3.5 w-3.5" /> Asociar
                        </Button>
                      )}
                      {!row.athlete && row.suggestion && (
                        <button
                          type="button"
                          className="ml-2 text-xs text-muted-foreground underline"
                          onClick={() => { setCandQ(firstNameOf(row.reader_name)); setAssignRow(row); }}
                        >
                          Otro
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data && data.total_filtered > 0 && (
              <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
                <span>
                  Mostrando {(data.page - 1) * data.page_size + 1}–{Math.min(data.page * data.page_size, data.total_filtered)} de {data.total_filtered}
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Anterior</Button>
                  <span>{page} / {totalPages}</span>
                  <Button size="sm" variant="outline" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Siguiente</Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Credenciales: huella, rostro y clave. Lo atenuado no está registrado en el lector y «—» significa que no se pudo leer. Asociar no envía nada al lector.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog open={!!assignRow} onOpenChange={v => { if (!v) setAssignRow(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Asociar el PIN {assignRow?.pin}</DialogTitle>
            <DialogDescription>
              En el lector figura como «{assignRow?.reader_name || 'sin nombre'}». Elige a quién pertenece.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={candQ} onChange={e => setCandQ(e.target.value)} placeholder="Buscar deportista" className="pl-8" autoFocus />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            {loadingCand && <div className="p-3"><Skeleton className="h-6 w-full" /></div>}
            {!loadingCand && candidates.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">No hay deportistas sin PIN que coincidan.</p>
            )}
            {candidates.map(c => {
              const id = c.child_id ?? c.unregistered_athlete_id ?? c.user_id ?? '';
              return (
                <button
                  key={`${c.type}:${id}`}
                  type="button"
                  disabled={actingPin === assignRow?.pin}
                  className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/50"
                  onClick={() => assignRow && assign(assignRow.pin, {
                    zk_pin: assignRow.pin,
                    ...(c.child_id ? { child_id: c.child_id } : c.unregistered_athlete_id ? { unregistered_athlete_id: c.unregistered_athlete_id } : { user_id: c.user_id }),
                  }, c.full_name)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{c.full_name}</span>
                    <span className={`block truncate text-xs ${candidateLine(c).mora ? 'text-red-600' : 'text-muted-foreground'}`}>
                      {candidateLine(c).text}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
