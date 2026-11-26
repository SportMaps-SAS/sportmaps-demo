/**
 * Constancias (escuela): aprobar lo que piden las familias, emitir por cuenta
 * propia, descargar, regenerar con los datos al día y anular.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Copy, Download, FileCheck2, FileText, Loader2, Plus, RefreshCw, Search, Settings, ShieldOff, UserRound,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { StatFilterBar } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';
import { estadoEscuela, etiquetaTipo, fraseFaltantes } from '@/lib/constancias';
import { cn } from '@/lib/utils';
import { VolverCarnetsV2 } from '@/components/school/carnets-v2/VolverCarnetsV2';

type Row = {
  id: string;
  folio: string;
  kind: string;
  title: string;
  status: 'pending_payment' | 'pending_review' | 'issued' | 'revoked';
  created_at: string;
  issued_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  pdf_url: string | null;
  qr_verify_token: string;
  template_id: string;
  athlete_name: string;
  template_name: string;
  requested_by_name: string | null;
  created_by_school: boolean;
};

type Counts = { all: number; pending_review: number; issued: number; revoked: number };
type TplOpt = { id: string; name: string; kind: string; is_default: boolean };
type AthleteOpt = { kind: 'child' | 'profile' | 'unregistered'; athlete_id: string; full_name: string; team_name: string | null };

const PAGE = 50;

function fecha(d: string | null) {
  return d ? new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

export default function SchoolCertificatesAdminPage() {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TplOpt[] | null>(null);

  // Anular / no aprobar
  const [revokeTarget, setRevokeTarget] = useState<Row | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);

  // Nueva constancia
  const [newOpen, setNewOpen] = useState(false);
  const [athSearch, setAthSearch] = useState('');
  const [athResults, setAthResults] = useState<AthleteOpt[]>([]);
  const [athLoading, setAthLoading] = useState(false);
  const [athSel, setAthSel] = useState<AthleteOpt | null>(null);
  const [tplSel, setTplSel] = useState('');
  const [emitting, setEmitting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!schoolId) return;
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, debounced, status]);

  useEffect(() => {
    if (!schoolId) return;
    void supabase
      .from('school_certificate_templates' as any)
      .select('id, name, kind, is_default')
      .eq('school_id', schoolId)
      .eq('active', true)
      .order('is_default', { ascending: false })
      .order('name')
      .then(({ data }) => setTemplates(((data as any[]) ?? []) as TplOpt[]));
  }, [schoolId]);

  async function load(offset: number) {
    if (!schoolId) return;
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    const { data, error } = await supabase.rpc('list_athlete_certificates' as any, {
      p_school_id: schoolId,
      p_status: status === 'all' ? null : status,
      p_kind: null,
      p_search: debounced || null,
      p_limit: PAGE,
      p_offset: offset,
    });
    setLoading(false);
    setLoadingMore(false);
    if (error) {
      toast({ title: 'No se pudieron cargar las constancias', description: error.message, variant: 'destructive' });
      if (offset === 0) setRows([]);
      return;
    }
    const d = data as any;
    const nuevas = (d?.rows ?? []) as Row[];
    setRows((prev) => (offset === 0 ? nuevas : [...prev, ...nuevas]));
    setTotal(Number(d?.total ?? 0));
    setCounts((d?.counts ?? null) as Counts | null);
  }

  const reload = () => load(0);

  /** Genera (o regenera) el PDF y cuenta qué datos faltaron en la ficha. */
  async function generarPdf(r: { id: string; folio: string }, actualizarDatos: boolean) {
    const res = await bffClient.post<any>(`/api/v1/certificates/${r.id}/generate-pdf`, { actualizar_datos: actualizarDatos });
    if (!res?.ok) throw new Error(res?.error || 'pdf_failed');
    const faltan = fraseFaltantes(res.faltantes);
    const firma = res.firma_omitida ? ' La imagen de la firma no se pudo usar; revísala en la plantilla.' : '';
    return { faltan, firma };
  }

  async function approve(r: Row) {
    setBusyId(r.id);
    const { error } = await supabase.rpc('issue_athlete_certificate' as any, { p_certificate_id: r.id });
    if (error) {
      setBusyId(null);
      toast({ title: 'No se pudo emitir', description: error.message, variant: 'destructive' });
      return;
    }
    try {
      const { faltan, firma } = await generarPdf(r, false);
      toast({
        title: `Constancia emitida · ${r.folio}`,
        description: faltan
          ? `${faltan} Complétalos en la ficha del deportista y toca «Actualizar datos».${firma}`
          : `La familia ya puede descargarla.${firma}`,
      });
    } catch (e: any) {
      toast({ title: 'Emitida, pero sin PDF', description: `${e?.message || 'Error'} — usa «Actualizar datos» para generarlo.`, variant: 'destructive' });
    } finally {
      setBusyId(null);
      await reload();
    }
  }

  async function regenerate(r: Row) {
    setBusyId(r.id);
    try {
      const { faltan, firma } = await generarPdf(r, true);
      toast({
        title: 'PDF actualizado con los datos de la ficha',
        description: faltan ? `${faltan}${firma}` : `Listo.${firma}`,
      });
      await reload();
    } catch (e: any) {
      toast({ title: 'No se pudo regenerar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function downloadPdf(r: Row) {
    setBusyId(r.id);
    try {
      const res = await bffClient.get<any>(`/api/v1/certificates/${r.id}/signed-url`);
      if (!res?.url) throw new Error(res?.error || 'no_url');
      window.open(res.url, '_blank', 'noopener');
    } catch (e: any) {
      toast({ title: 'No se pudo descargar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function copyLink(r: Row) {
    const url = `${window.location.origin}/cert/${r.qr_verify_token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copiado', description: 'Quien lo abra ve si la constancia es válida.' });
    } catch {
      toast({ title: 'Link de verificación', description: url });
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    const { error } = await supabase.rpc('revoke_athlete_certificate' as any, {
      p_certificate_id: revokeTarget.id,
      p_reason: revokeReason.trim() || null,
    });
    setRevoking(false);
    if (error) {
      toast({ title: 'No se pudo', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: revokeTarget.status === 'issued' ? 'Constancia anulada' : 'Solicitud no aprobada',
      description: 'Le avisamos a la familia.',
    });
    setRevokeTarget(null);
    await reload();
  }

  // ── Nueva constancia ──
  useEffect(() => {
    if (!newOpen || !schoolId) return;
    const q = athSearch.trim();
    const t = setTimeout(async () => {
      setAthLoading(true);
      const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
        p_school_id: schoolId,
        p_search: q || null,
        p_team_id: null,
        p_branch_id: null,
        p_card_filter: 'all',
        p_limit: 20,
        p_offset: 0,
      });
      setAthLoading(false);
      if (error) { setAthResults([]); return; }
      setAthResults((((data as any)?.rows ?? []) as AthleteOpt[]));
    }, 300);
    return () => clearTimeout(t);
  }, [athSearch, newOpen, schoolId]);

  function openNew() {
    setAthSearch('');
    setAthSel(null);
    const def = templates?.find((t) => t.is_default) ?? templates?.[0];
    setTplSel(def?.id ?? '');
    setNewOpen(true);
  }

  async function emitNew() {
    if (!schoolId || !athSel || !tplSel) return;
    setEmitting(true);
    const { data, error } = await supabase.rpc('emitir_constancia_escuela' as any, {
      p_school_id: schoolId,
      p_template_id: tplSel,
      p_child_id: athSel.kind === 'child' ? athSel.athlete_id : null,
      p_profile_id: athSel.kind === 'profile' ? athSel.athlete_id : null,
    });
    if (error) {
      setEmitting(false);
      toast({ title: 'No se pudo emitir', description: error.message, variant: 'destructive' });
      return;
    }
    const cert = data as { id: string; folio: string };
    try {
      const { faltan, firma } = await generarPdf(cert, false);
      toast({
        title: `Constancia emitida · ${cert.folio}`,
        description: faltan
          ? `${faltan} Complétalos en la ficha y toca «Actualizar datos».${firma}`
          : `La familia ya la tiene en su app.${firma}`,
      });
    } catch (e: any) {
      toast({ title: 'Emitida, pero sin PDF', description: `${e?.message || 'Error'} — usa «Actualizar datos».`, variant: 'destructive' });
    } finally {
      setEmitting(false);
      setNewOpen(false);
      await reload();
    }
  }

  const sinPlantillas = templates !== null && templates.length === 0;
  const val = (k: keyof Counts) => (counts ? counts[k] : '—');
  const hayMas = rows.length < total;

  const statItems = useMemo(() => [
    { key: null, label: 'Todas', value: val('all'), tone: 'neutral' as const },
    { key: 'pending_review', label: 'Por aprobar', value: val('pending_review'), tone: 'blue' as const },
    { key: 'issued', label: 'Emitidas', value: val('issued'), tone: 'emerald' as const },
    { key: 'revoked', label: 'Anuladas', value: val('revoked'), tone: 'rose' as const },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [counts]);

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <VolverCarnetsV2 />
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileCheck2 className="h-7 w-7 text-primary" />
            Constancias
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Aprueba lo que piden las familias o emite una tú. Cada constancia sale en PDF con folio único y un QR para verificarla.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/cards/templates/certificates">
            <Button variant="outline" className="gap-2">
              <Settings className="h-4 w-4" />
              Plantillas
            </Button>
          </Link>
          <Button onClick={openNew} disabled={!templates || sinPlantillas} className="gap-2">
            <Plus className="h-4 w-4" />
            Nueva constancia
          </Button>
        </div>
      </header>

      {sinPlantillas && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-sm text-amber-900 flex-1">
              <b>Primero crea una plantilla.</b> Sin plantillas activas, las familias no pueden pedir constancias y tú no puedes emitirlas.
            </p>
            <Link to="/cards/templates/certificates"><Button size="sm">Crear plantillas</Button></Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Solicitudes y constancias</CardTitle></CardHeader>
        <CardContent>
          <div className="relative mb-4 max-w-xl">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por folio o deportista…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <StatFilterBar
            className="mb-4"
            columns={4}
            value={status === 'all' ? null : status}
            onChange={(v) => setStatus(v ?? 'all')}
            items={statItems}
          />

          {loading ? (
            <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              {status === 'pending_review' ? 'No hay solicitudes por aprobar.' : 'Sin constancias en este filtro.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Folio</TableHead>
                    <TableHead>Deportista</TableHead>
                    <TableHead>Constancia</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Fechas</TableHead>
                    <TableHead className="text-right">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const est = estadoEscuela(r.status);
                    const busy = busyId === r.id;
                    const pendiente = r.status === 'pending_review' || r.status === 'pending_payment';
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs font-mono whitespace-nowrap">{r.folio}</TableCell>
                        <TableCell className="text-sm font-medium">{r.athlete_name}</TableCell>
                        <TableCell className="text-xs">
                          <span className="font-medium">{r.template_name || r.title}</span>
                          <span className="block text-muted-foreground">{etiquetaTipo(r.kind)}</span>
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge className={est.cls}>{est.label}</Badge>
                          <span className="block mt-1 text-muted-foreground">
                            {r.created_by_school ? 'La emitió la escuela' : r.requested_by_name ? `Pidió: ${r.requested_by_name}` : ''}
                          </span>
                          {r.status === 'revoked' && r.revocation_reason && (
                            <span className="block text-muted-foreground">Motivo: {r.revocation_reason}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          <span className="block">Pedida: {fecha(r.created_at)}</span>
                          {r.issued_at && <span className="block">Emitida: {fecha(r.issued_at)}</span>}
                          {r.revoked_at && <span className="block">Anulada: {fecha(r.revoked_at)}</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-wrap justify-end gap-1">
                            {pendiente && (
                              <>
                                <Button size="sm" onClick={() => approve(r)} disabled={busy} className="gap-1">
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                                  Emitir
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => { setRevokeTarget(r); setRevokeReason(''); }} disabled={busy}>
                                  No aprobar
                                </Button>
                              </>
                            )}
                            {r.status === 'issued' && (
                              <>
                                {r.pdf_url && (
                                  <Button size="sm" variant="outline" onClick={() => downloadPdf(r)} disabled={busy} className="gap-1">
                                    <Download className="h-3.5 w-3.5" /> PDF
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" onClick={() => regenerate(r)} disabled={busy} className="gap-1" title="Vuelve a tomar los datos de la ficha y regenera el PDF">
                                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                  {r.pdf_url ? 'Actualizar datos' : 'Generar PDF'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => copyLink(r)} aria-label="Copiar link de verificación" title="Copiar link de verificación">
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => { setRevokeTarget(r); setRevokeReason(''); }} className="text-red-600 hover:bg-red-50" aria-label="Anular" title="Anular">
                                  <ShieldOff className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {hayMas && !loading && (
            <div className="flex justify-center pt-3">
              <Button variant="outline" onClick={() => load(rows.length)} disabled={loadingMore} className="gap-2">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Cargar más ({total - rows.length})
              </Button>
            </div>
          )}

          <TableRefreshBar
            className="-mx-6 -mb-6 mt-2 rounded-b-lg"
            onRefresh={reload}
            loading={loading}
            summary={`${rows.length} de ${total} constancia(s)`}
          />
        </CardContent>
      </Card>

      {/* Anular / no aprobar */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revokeTarget?.status === 'issued' ? 'Anular la constancia' : 'No aprobar la solicitud'}</DialogTitle>
            <DialogDescription>
              {revokeTarget?.status === 'issued'
                ? `El folio ${revokeTarget?.folio} queda como ANULADO para quien lo verifique y la familia ya no puede descargarlo.`
                : `La solicitud de ${revokeTarget?.athlete_name} se cierra.`}
              {' '}Le avisamos a la familia con el motivo que escribas.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="motivo">Motivo (opcional)</Label>
            <Textarea id="motivo" value={revokeReason} maxLength={300} onChange={(e) => setRevokeReason(e.target.value)}
              placeholder={revokeTarget?.status === 'issued' ? 'Ej.: datos del documento equivocados' : 'Ej.: el deportista ya no está inscrito'} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>Cancelar</Button>
            <Button onClick={confirmRevoke} disabled={revoking} className="bg-red-600 hover:bg-red-700 gap-2">
              {revoking && <Loader2 className="h-4 w-4 animate-spin" />}
              {revokeTarget?.status === 'issued' ? 'Anular' : 'No aprobar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nueva constancia */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Nueva constancia</DialogTitle>
            <DialogDescription>Elige el deportista y la plantilla. Sale emitida de una vez, con su PDF, y la familia la ve en su app.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ath-search">Deportista</Label>
              {athSel ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <span className="text-sm">
                    <b>{athSel.full_name}</b>
                    {athSel.team_name && <span className="text-muted-foreground"> · {athSel.team_name}</span>}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setAthSel(null)}>Cambiar</Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input id="ath-search" autoFocus className="pl-8" placeholder="Escribe el nombre…" value={athSearch} onChange={(e) => setAthSearch(e.target.value)} />
                  </div>
                  <div className="max-h-60 overflow-y-auto rounded-lg border divide-y">
                    {athLoading ? (
                      <div className="py-6 flex justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
                    ) : athResults.length === 0 ? (
                      <p className="py-4 text-center text-sm text-muted-foreground">Sin resultados.</p>
                    ) : athResults.map((a) => {
                      const sinCuenta = a.kind === 'unregistered';
                      return (
                        <button
                          key={`${a.kind}:${a.athlete_id}`}
                          type="button"
                          disabled={sinCuenta}
                          onClick={() => setAthSel(a)}
                          className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50', sinCuenta && 'opacity-60 cursor-not-allowed')}
                        >
                          <UserRound className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="block truncate font-medium">{a.full_name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {sinCuenta ? 'Ficha sin cuenta: primero invita a la familia' : (a.team_name || 'Sin equipo')}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Plantilla</Label>
              <Select value={tplSel} onValueChange={setTplSel}>
                <SelectTrigger><SelectValue placeholder="Elige una plantilla" /></SelectTrigger>
                <SelectContent>
                  {(templates ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}{t.is_default ? ' · predeterminada' : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setNewOpen(false)}>Cancelar</Button>
            <Button onClick={emitNew} disabled={!athSel || !tplSel || emitting} className="gap-2">
              {emitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Emitir constancia
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
