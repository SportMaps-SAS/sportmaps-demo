import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, IdCard, Plus, Eye, ShieldOff, Download, ExternalLink, RotateCw, Send, ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSearchParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { AthleteIdCard, type CardData } from '@/components/cards/AthleteIdCard';
import { exportCardPng, exportCardsPdf } from '@/lib/cards/cardExport';
import { slugifyFileName, type PdfLayoutMode } from '@/lib/cards/cardLayout';
import { CardTemplatesManager } from '@/components/cards/CardTemplatesManager';
import { StatFilterBar } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';

type AthleteKind = 'child' | 'profile' | 'unregistered';

type Athlete = {
  kind: AthleteKind;
  athlete_id: string;
  full_name: string;
  avatar_url: string | null;
  doc_type: string | null;
  doc_number: string | null;
  team_id: string | null;
  team_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
  issuable: boolean;
  /** 'active' | 'expired' | null — null es "nunca tuvo carnet". */
  card_status: string | null;
  card_valid_until: string | null;
  has_active_card: boolean;
};

type AthletesPage = {
  rows: Athlete[];
  total: number;
  total_scope: number;
  with_card: number;
  without_card: number;
  not_issuable: number;
  teams: { id: string; name: string }[];
  branches: { id: string; name: string }[];
};

type CardRow = {
  id: string;
  qr_token: string;
  status: string;
  issued_at: string;
  valid_until: string;
  version: number;
  athlete_name: string;
  athlete_photo: string | null;
  doc_number: string | null;
  team_name: string | null;
  branch_name: string | null;
  child_id: string | null;
  profile_id: string | null;
  unregistered_athlete_id?: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  active:  'bg-green-100 text-green-700',
  revoked: 'bg-gray-200 text-gray-700',
  expired: 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Vigente',
  revoked: 'Revocado',
  expired: 'Vencido',
};

const KIND_LABEL: Record<AthleteKind, string> = {
  child: 'Menor',
  profile: 'Adulto',
  unregistered: 'Sin cuenta',
};

const PAGE_SIZE = 50;
/** Tope por llamada de la RPC. Se usa al juntar selecciones o carnets de todas
 *  las páginas, no en el listado normal. */
const FETCH_ALL_CHUNK = 500;

export default function SchoolCardsAdminPage() {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();

  // ?tab=templates llega desde el menú "Plantillas de Carnets"; antes ese ítem
  // mandaba a las plantillas de CONSTANCIAS (otra página) y este editor no tenía enlace.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<'athletes' | 'cards' | 'templates'>(
    tabParam === 'cards' || tabParam === 'templates' ? tabParam : 'athletes'
  );
  const [templates, setTemplates] = useState<{ id: string; name: string; is_default: boolean }[]>([]);
  const [issueTemplate, setIssueTemplate] = useState<string>('default');
  // La emisión masiva tiene su propio selector: antes reutilizaba en silencio
  // lo último que se eligió en el diálogo individual.
  const [bulkTemplate, setBulkTemplate] = useState<string>('default');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [page, setPage] = useState<AthletesPage>({
    rows: [], total: 0, total_scope: 0, with_card: 0, without_card: 0, not_issuable: 0, teams: [], branches: [],
  });
  const [athleteOffset, setAthleteOffset] = useState(0);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [cardsTotal, setCardsTotal] = useState(0);
  const [cardCounts, setCardCounts] = useState<{ active: number; revoked: number; expired: number; all: number }>({ active: 0, revoked: 0, expired: 0, all: 0 });
  const [cardsOffset, setCardsOffset] = useState(0);
  const [loadingAthletes, setLoadingAthletes] = useState(false);
  const [loadingCards, setLoadingCards] = useState(false);

  const [issueOpen, setIssueOpen] = useState(false);
  const [issueTarget, setIssueTarget] = useState<Athlete | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<CardRow | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [validUntil, setValidUntil] = useState<string>(
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [issuing, setIssuing] = useState(false);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<CardData | null>(null);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewFace, setPreviewFace] = useState<'front' | 'back'>('front');
  const previewRef = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  // Emisión masiva + filtros. La selección guarda el tipo de atleta porque la
  // RPC de emisión necesita saber si va por child_id o por profile_id, y con
  // paginación el atleta seleccionado puede no estar ya en pantalla.
  const [selected, setSelected] = useState<Map<string, Athlete>>(new Map());
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [cardFilter, setCardFilter] = useState<'all' | 'with' | 'without'>('all');
  const [bulkIssuing, setBulkIssuing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);

  // Descarga PDF por equipo (encarpetado)
  const [pdfTeam, setPdfTeam] = useState<string>('all');
  const [pdfMode, setPdfMode] = useState<PdfLayoutMode>('duplex');
  const [pdfCutMarks, setPdfCutMarks] = useState(true);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<{ done: number; total: number } | null>(null);
  // Catálogo de equipos/sedes de la escuela. Antes salía solo de la respuesta
  // de la pestaña "Emitir nuevo": abriendo /cards?tab=cards directo, el
  // selector de equipo del PDF quedaba vacío.
  const [catalog, setCatalog] = useState<{ teams: { id: string; name: string }[]; branches: { id: string; name: string }[] }>({ teams: [], branches: [] });

  const publicCardOrigin = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/c`;
  }, []);

  // El buscador dispara una consulta al servidor; sin esta espera se manda una
  // por tecla y las respuestas se pisan entre sí.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(id);
  }, [search]);

  const loadAthletes = useCallback(async (offset = athleteOffset) => {
    if (!schoolId) return;
    setLoadingAthletes(true);
    const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
      p_school_id: schoolId,
      p_search: debouncedSearch || null,
      p_team_id: teamFilter === 'all' ? null : teamFilter,
      p_branch_id: branchFilter === 'all' ? null : branchFilter,
      p_card_filter: cardFilter,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setPage((p) => ({ ...p, rows: [] }));
    } else {
      const d = data as any;
      setPage({
        rows: (d?.rows ?? []) as Athlete[],
        total: Number(d?.total ?? 0),
        total_scope: Number(d?.total_scope ?? 0),
        with_card: Number(d?.with_card ?? 0),
        without_card: Number(d?.without_card ?? 0),
        not_issuable: Number(d?.not_issuable ?? 0),
        teams: (d?.teams ?? []) as { id: string; name: string }[],
        branches: (d?.branches ?? []) as { id: string; name: string }[],
      });
      if ((d?.teams ?? []).length || (d?.branches ?? []).length) {
        setCatalog({ teams: d?.teams ?? [], branches: d?.branches ?? [] });
      }
    }
    setLoadingAthletes(false);
  }, [schoolId, debouncedSearch, teamFilter, branchFilter, cardFilter, athleteOffset, toast]);

  const loadCards = useCallback(async (offset = cardsOffset) => {
    if (!schoolId) return;
    setLoadingCards(true);
    const { data, error } = await supabase.rpc('list_athlete_id_cards' as any, {
      p_school_id: schoolId,
      p_status: statusFilter === 'all' ? null : statusFilter,
      p_search: debouncedSearch || null,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setCards([]);
    } else {
      const d = data as any;
      setCards((d?.rows ?? []) as CardRow[]);
      setCardsTotal(Number(d?.total ?? 0));
      setCardCounts({
        active: Number(d?.counts?.active ?? 0),
        revoked: Number(d?.counts?.revoked ?? 0),
        expired: Number(d?.counts?.expired ?? 0),
        all: Number(d?.counts?.all ?? 0),
      });
    }
    setLoadingCards(false);
  }, [schoolId, statusFilter, debouncedSearch, cardsOffset, toast]);

  // Cualquier cambio de filtro vuelve a la primera página: quedarse en el
  // offset viejo con menos resultados dejaba la tabla vacía sin explicación.
  useEffect(() => { setAthleteOffset(0); }, [debouncedSearch, teamFilter, branchFilter, cardFilter]);
  useEffect(() => { setCardsOffset(0); }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    if (!schoolId) return;
    if (tab === 'athletes') void loadAthletes(athleteOffset);
    else if (tab === 'cards') void loadCards(cardsOffset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, tab, debouncedSearch, statusFilter, teamFilter, branchFilter, cardFilter, athleteOffset, cardsOffset]);

  // Catálogo de equipos al abrir la página, sin depender de la pestaña activa.
  useEffect(() => {
    if (!schoolId) return;
    let cancelled = false;
    void supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
      p_school_id: schoolId, p_search: null, p_team_id: null, p_branch_id: null,
      p_card_filter: 'all', p_limit: 1, p_offset: 0,
    }).then(({ data }) => {
      if (cancelled || !data) return;
      const d = data as any;
      setCatalog({ teams: d?.teams ?? [], branches: d?.branches ?? [] });
    });
    return () => { cancelled = true; };
  }, [schoolId]);

  // Plantillas activas (para elegir cuál usar al emitir).
  useEffect(() => {
    if (!schoolId) return;
    supabase
      .from('athlete_id_card_templates')
      .select('id, name, is_default')
      .eq('school_id', schoolId)
      .eq('active', true)
      .order('is_default', { ascending: false })
      .then(({ data }) => setTemplates((data as any) || []));
  }, [schoolId, tab]);

  // Resuelve el template_id a usar al emitir. 'default' antes mandaba null y la
  // RPC no buscaba la predeterminada → carnet sin plantilla. Ahora se resuelve
  // acá (y la RPC también cae a la predeterminada si llega null, mig 20261010201231).
  const defaultTemplate = templates.find((t) => t.is_default) || null;
  const resolveTemplateId = (choice: string) => (choice === 'default' ? defaultTemplate?.id ?? null : choice);

  /** Recorre todas las páginas del filtro actual. Se usa para "seleccionar
   *  todos" y para el PDF: sin esto ambas cosas operaban solo sobre lo visible. */
  async function fetchAllAthletes(
    cardFilterOverride: 'all' | 'with' | 'without',
    scope?: { teamId: string | null; branchId: string | null; search: string | null },
  ): Promise<Athlete[]> {
    if (!schoolId) return [];
    const out: Athlete[] = [];
    let offset = 0;
    const teamId = scope ? scope.teamId : (teamFilter === 'all' ? null : teamFilter);
    const branchId = scope ? scope.branchId : (branchFilter === 'all' ? null : branchFilter);
    const search = scope ? scope.search : (debouncedSearch || null);
    for (;;) {
      const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
        p_school_id: schoolId,
        p_search: search,
        p_team_id: teamId,
        p_branch_id: branchId,
        p_card_filter: cardFilterOverride,
        p_limit: FETCH_ALL_CHUNK,
        p_offset: offset,
      });
      if (error) throw error;
      const rows = ((data as any)?.rows ?? []) as Athlete[];
      out.push(...rows);
      const total = Number((data as any)?.total ?? 0);
      offset += FETCH_ALL_CHUNK;
      if (out.length >= total || rows.length === 0) break;
    }
    return out;
  }

  const pageSelectable = page.rows.filter((a) => a.issuable && !a.has_active_card);
  const selectedCount = selected.size;

  function toggleSelect(a: Athlete) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(a.athlete_id)) next.delete(a.athlete_id); else next.set(a.athlete_id, a);
      return next;
    });
  }
  function selectPage() {
    setSelected((prev) => {
      const next = new Map(prev);
      pageSelectable.forEach((a) => next.set(a.athlete_id, a));
      return next;
    });
  }
  function clearSelection() { setSelected(new Map()); }

  async function selectAllWithoutCard() {
    setSelectingAll(true);
    try {
      const all = await fetchAllAthletes('without');
      const next = new Map<string, Athlete>();
      all.filter((a) => a.issuable).forEach((a) => next.set(a.athlete_id, a));
      setSelected(next);
      const skipped = all.length - next.size;
      toast({
        title: `${next.size} atleta(s) seleccionados`,
        description: skipped > 0 ? `${skipped} sin cuenta ni ficha de menor quedaron fuera: no se les puede emitir.` : undefined,
      });
    } catch (e: any) {
      toast({ title: 'No se pudo seleccionar todo', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setSelectingAll(false);
    }
  }

  async function bulkIssue() {
    if (!schoolId) return;
    const targets = Array.from(selected.values()).filter((a) => a.issuable && !a.has_active_card);
    if (targets.length === 0) {
      toast({ title: 'Nada que emitir', description: 'Selecciona atletas sin carnet.' });
      return;
    }
    setBulkIssuing(true);
    setBulkProgress({ done: 0, total: targets.length });
    let ok = 0; let fail = 0;
    for (const a of targets) {
      const { error } = await supabase.rpc('issue_athlete_id_card' as any, {
        p_school_id: schoolId,
        p_child_id: a.kind === 'child' ? a.athlete_id : null,
        p_profile_id: a.kind === 'profile' ? a.athlete_id : null,
        p_unregistered_athlete_id: a.kind === 'unregistered' ? a.athlete_id : null,
        p_template_id: resolveTemplateId(bulkTemplate),
        p_valid_until: validUntil,
        p_photo_url: null,
      });
      if (error) fail++; else ok++;
      setBulkProgress({ done: ok + fail, total: targets.length });
    }
    setBulkIssuing(false);
    setBulkProgress(null);
    clearSelection();
    toast({
      title: `Emitidos ${ok} carnet(s)`,
      description: fail ? `${fail} fallaron — revisa e inténtalo de nuevo.` : 'Todos correctos.',
      variant: fail ? 'destructive' : 'default',
    });
    void loadAthletes(athleteOffset);
  }

  // Equipos para el PDF: del catálogo de la escuela, no de la página cargada.
  const cardTeamOptions = catalog.teams;

  /** Trae TODOS los carnets vigentes que cumplen el filtro, no solo la página. */
  async function fetchAllActiveCards(): Promise<CardRow[]> {
    if (!schoolId) return [];
    const out: CardRow[] = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await supabase.rpc('list_athlete_id_cards' as any, {
        p_school_id: schoolId,
        p_status: 'active',
        p_search: debouncedSearch || null,
        p_limit: FETCH_ALL_CHUNK,
        p_offset: offset,
      });
      if (error) throw error;
      const rows = ((data as any)?.rows ?? []) as CardRow[];
      out.push(...rows);
      const total = Number((data as any)?.total ?? 0);
      offset += FETCH_ALL_CHUNK;
      if (out.length >= total || rows.length === 0) break;
    }
    return out;
  }

  /** Datos completos de cada carnet (marca, plantilla, foto, campos). De a 6 en
   *  paralelo: uno por uno, un equipo de 30 tardaba más que la propia captura. */
  async function fetchCardDatas(target: CardRow[], onEach?: () => void): Promise<{ data: CardData; token: string }[]> {
    const out: ({ data: CardData; token: string } | null)[] = new Array(target.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < target.length) {
        const i = next++;
        const { data } = await supabase.rpc('verify_athlete_id_card_public' as any, { p_qr_token: target[i].qr_token });
        if (data && (data as CardData).found && (data as CardData).status === 'active') {
          out[i] = { data: data as CardData, token: target[i].qr_token };
        }
        onEach?.();
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, target.length) }, worker));
    return out.filter((x): x is { data: CardData; token: string } => !!x);
  }

  // PDF CR80 exacto (53,98 × 85,6 mm) con frente Y reverso: hoja de frentes +
  // hoja de reversos en espejo (doble cara), o frente y reverso juntos.
  async function downloadCardsPdf() {
    if (!schoolId) return;
    setPdfBusy(true);
    setPdfProgress({ done: 0, total: 0 });
    try {
      const teamName = pdfTeam === 'all' ? null : cardTeamOptions.find((t) => t.id === pdfTeam)?.name || null;
      const all = await fetchAllActiveCards();
      let target = all;
      if (pdfTeam !== 'all') {
        // Filtro por id de equipo, no por nombre: dos equipos con el mismo
        // nombre en sedes distintas se mezclaban.
        const members = await fetchAllAthletes('with', { teamId: pdfTeam, branchId: null, search: null });
        const ids = new Set(members.map((m) => m.athlete_id));
        target = all.filter((c) => ids.has(c.child_id || '') || ids.has(c.profile_id || '') || ids.has(c.unregistered_athlete_id || ''));
      }
      if (target.length === 0) {
        toast({ title: 'Sin carnets', description: 'No hay carnets vigentes para ese equipo.' });
        return;
      }
      let loaded = 0;
      setPdfProgress({ done: 0, total: target.length });
      const datas = await fetchCardDatas(target, () => { loaded++; setPdfProgress({ done: loaded, total: target.length }); });
      const slug = teamName ? slugifyFileName(teamName) : 'todos';
      const n = await exportCardsPdf(
        datas.map((d) => ({ data: d.data, publicUrl: `${publicCardOrigin}/${d.token}` })),
        {
          mode: pdfMode,
          cutMarks: pdfCutMarks,
          fileName: `carnets-${slug}-${pdfMode === 'duplex' ? 'doble-cara' : 'frente-y-reverso'}.pdf`,
          onProgress: (done, total) => setPdfProgress({ done, total }),
        },
      );
      toast({
        title: 'PDF generado',
        description: pdfMode === 'duplex'
          ? `${n} carnet(s) · tamaño CR80 real. Imprime a doble cara volteando por el borde largo, al 100 %.`
          : `${n} carnet(s) · frente y reverso juntos, tamaño CR80 real. Imprime al 100 %.`,
      });
    } catch (e: any) {
      toast({ title: 'No se pudo generar el PDF', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setPdfBusy(false);
      setPdfProgress(null);
    }
  }

  function openIssueDialog(a: Athlete) {
    setIssueTarget(a);
    setIssueOpen(true);
  }

  async function confirmIssue() {
    if (!schoolId || !issueTarget) return;
    setIssuing(true);
    const { data, error } = await supabase.rpc('issue_athlete_id_card' as any, {
      p_school_id: schoolId,
      p_child_id:   issueTarget.kind === 'child'   ? issueTarget.athlete_id : null,
      p_profile_id: issueTarget.kind === 'profile' ? issueTarget.athlete_id : null,
      p_unregistered_athlete_id: issueTarget.kind === 'unregistered' ? issueTarget.athlete_id : null,
      // Antes iba null fijo: la plantilla elegida en este mismo diálogo se
      // ignoraba y todos los carnets salían con la predeterminada.
      p_template_id: resolveTemplateId(issueTemplate),
      p_valid_until: validUntil,
      p_photo_url: null,
    });
    setIssuing(false);
    if (error) {
      toast({ title: 'Error al emitir', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Carnet emitido', description: `Versión ${(data as any)?.version || 1}` });
    setIssueOpen(false);
    setIssueTarget(null);
    void loadAthletes(athleteOffset);

    const token = (data as any)?.qr_token;
    if (token) await openPreview(token);
  }

  function revoke(card: CardRow) {
    setRevokeTarget(card);
    setRevokeReason('');
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    const { error } = await supabase.rpc('revoke_athlete_id_card' as any, {
      p_card_id: revokeTarget.id,
      p_reason: revokeReason.trim() || null,
    });
    setRevoking(false);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Carnet revocado' });
    setRevokeTarget(null);
    void loadCards(cardsOffset);
  }

  // Comparte el link público del carnet con el padre (WhatsApp o share nativo).
  function shareCard(qrToken: string, name?: string | null) {
    const url = `${window.location.origin}/c/${qrToken}`;
    const text = `Carnet deportivo de ${name || 'tu deportista'} — valida y consúltalo aquí: ${url}`;
    const nav = navigator as any;
    if (nav.share) {
      nav.share({ title: 'Carnet deportivo', text, url }).catch(() => {});
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
  }

  async function openPreview(qrToken: string) {
    setPreviewToken(qrToken);
    setPreviewData(null);
    setPreviewFace('front');
    setPreviewOpen(true);
    const { data, error } = await supabase.rpc('verify_athlete_id_card_public' as any, {
      p_qr_token: qrToken,
    });
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }
    setPreviewData(data as CardData);
  }

  // PNG con frente Y reverso, a resolución de impresión.
  async function downloadPreview() {
    if (!previewData || !previewToken) return;
    setDownloading(true);
    try {
      await exportCardPng(
        { data: previewData, publicUrl: `${publicCardOrigin}/${previewToken}` },
        `carnet-${slugifyFileName(previewData.athlete?.full_name, previewToken.slice(0, 8))}`,
      );
    } catch (e: any) {
      toast({ title: 'No se pudo descargar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  }

  const coveragePct = page.total_scope ? Math.round((page.with_card / page.total_scope) * 100) : 0;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <IdCard className="h-7 w-7 text-primary" />
            Carnets digitales
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Emite y gestiona carnets de tus atletas con QR público para validación.
          </p>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => { setTab(v as any); setSearchParams(v === 'athletes' ? {} : { tab: v }, { replace: true }); }}>
        <TabsList>
          <TabsTrigger value="athletes">Emitir nuevo</TabsTrigger>
          <TabsTrigger value="cards">Carnets emitidos</TabsTrigger>
          <TabsTrigger value="templates">Plantillas</TabsTrigger>
        </TabsList>

        <TabsContent value="athletes">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <CardTitle>Atletas</CardTitle>
                {/* Cobertura — sobre el total filtrado, no sobre la página */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Cobertura</span>
                  <div className="w-28 h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${coveragePct}%` }} />
                  </div>
                  <span className="font-bold tabular-nums">{page.with_card}/{page.total_scope}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Filtros */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="relative flex-1 min-w-48">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar por nombre o documento…"
                    className="pl-8"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Select value={teamFilter} onValueChange={setTeamFilter}>
                  <SelectTrigger className="w-auto min-w-36"><SelectValue placeholder="Equipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los equipos</SelectItem>
                    {page.teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={branchFilter} onValueChange={setBranchFilter}>
                  <SelectTrigger className="w-auto min-w-32"><SelectValue placeholder="Sede" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas las sedes</SelectItem>
                    {page.branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <StatFilterBar
                className="mb-4"
                columns={3}
                value={cardFilter === 'all' ? null : cardFilter}
                onChange={(v) => setCardFilter((v as 'with' | 'without') ?? 'all')}
                items={[
                  { key: null, label: 'Todos', value: page.total_scope, tone: 'neutral' },
                  { key: 'with', label: 'Con carnet', value: page.with_card, tone: 'emerald' },
                  { key: 'without', label: 'Sin carnet', value: page.without_card, tone: 'yellow' },
                ]}
              />

              {page.not_issuable > 0 && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    {page.not_issuable} atleta(s) figuran sin cuenta ni ficha de menor. Aparecen en la lista para que el total cuadre,
                    pero no se les puede emitir carnet hasta que se registren o se vinculen a un perfil.
                  </span>
                </div>
              )}

              {/* Barra de selección masiva */}
              {(pageSelectable.length > 0 || selectedCount > 0) && (
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
                  <div className="text-sm">
                    <span className="font-semibold text-primary">{selectedCount} seleccionado(s)</span>
                    {pageSelectable.length > 0 && (
                      <button className="ml-2 text-primary underline underline-offset-2" onClick={selectPage}>
                        Seleccionar esta página ({pageSelectable.length})
                      </button>
                    )}
                    {page.without_card > 0 && (
                      <button
                        className="ml-2 text-primary underline underline-offset-2 disabled:opacity-50"
                        onClick={selectAllWithoutCard}
                        disabled={selectingAll}
                      >
                        {selectingAll ? 'Buscando…' : `Seleccionar los ${page.without_card} sin carnet`}
                      </button>
                    )}
                    {selectedCount > 0 && (
                      <button className="ml-2 text-muted-foreground underline underline-offset-2" onClick={clearSelection}>
                        Limpiar
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {templates.length > 0 && (
                      <>
                        <Label className="text-xs text-muted-foreground">Plantilla</Label>
                        <Select value={bulkTemplate} onValueChange={setBulkTemplate}>
                          <SelectTrigger className="h-8 w-auto min-w-40" data-testid="bulk-template-select"><SelectValue placeholder="Plantilla" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">
                              Predeterminada{defaultTemplate ? ` (${defaultTemplate.name})` : ' (diseño base)'}
                            </SelectItem>
                            {templates.map((t) => (
                              <SelectItem key={t.id} value={t.id}>{t.name}{t.is_default ? ' ★' : ''}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </>
                    )}
                    <Label className="text-xs text-muted-foreground">Vence</Label>
                    <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-8 w-40" />
                    <Button size="sm" disabled={bulkIssuing || selectedCount === 0} onClick={bulkIssue} className="gap-1">
                      {bulkIssuing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      {bulkIssuing && bulkProgress
                        ? `Emitiendo ${bulkProgress.done}/${bulkProgress.total}…`
                        : `Emitir seleccionados (${selectedCount})`}
                    </Button>
                  </div>
                </div>
              )}

              {loadingAthletes ? (
                <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : page.rows.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">No se encontraron atletas con esos filtros.</p>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          aria-label="Seleccionar los de esta página"
                          className="h-4 w-4 accent-primary align-middle"
                          checked={pageSelectable.length > 0 && pageSelectable.every((a) => selected.has(a.athlete_id))}
                          onChange={(e) => e.target.checked ? selectPage() : clearSelection()}
                        />
                      </TableHead>
                      <TableHead>Atleta</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead>Equipo / Sede</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.rows.map((a) => (
                      <TableRow key={`${a.kind}-${a.athlete_id}`} className={selected.has(a.athlete_id) ? 'bg-primary/5' : ''}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${a.full_name}`}
                            className="h-4 w-4 accent-primary align-middle disabled:opacity-40"
                            checked={selected.has(a.athlete_id)}
                            disabled={!a.issuable || a.has_active_card}
                            title={!a.issuable ? 'Sin cuenta ni ficha de menor' : a.has_active_card ? 'Ya tiene carnet vigente' : undefined}
                            onChange={() => toggleSelect(a)}
                          />
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          <div className="flex items-center gap-2">
                            <span>{a.full_name}</span>
                            {a.kind !== 'child' && (
                              <Badge variant="outline" className="text-[10px] font-normal">{KIND_LABEL[a.kind]}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {a.doc_number ? `${a.doc_type || ''} ${a.doc_number}`.trim() : '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {a.team_name || '—'}{a.branch_name ? ` · ${a.branch_name}` : ''}
                        </TableCell>
                        <TableCell>
                          {a.card_status === 'active' ? (
                            <Badge className="bg-green-100 text-green-700">Con carnet vigente</Badge>
                          ) : a.card_status === 'expired' ? (
                            <Badge className="bg-red-100 text-red-700">Carnet vencido</Badge>
                          ) : (
                            <Badge variant="outline">Sin carnet</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            onClick={() => openIssueDialog(a)}
                            disabled={!a.issuable}
                            title={!a.issuable ? 'Necesita cuenta o ficha de menor para emitirle carnet' : undefined}
                            className="gap-1"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {a.card_status === 'active' ? 'Reemitir' : a.card_status === 'expired' ? 'Renovar' : 'Emitir'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}

              <Pager
                offset={athleteOffset}
                pageCount={page.rows.length}
                total={page.total}
                busy={loadingAthletes}
                onChange={setAthleteOffset}
              />

              <TableRefreshBar
                className="-mx-6 -mb-6 mt-2 rounded-b-lg"
                onRefresh={() => loadAthletes(athleteOffset)}
                loading={loadingAthletes}
                summary={`${page.total} atleta(s) con los filtros actuales · ${page.total_scope} en la escuela`}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="cards">
          <Card>
            <CardHeader>
              <CardTitle>Carnets emitidos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="relative flex-1 min-w-44">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Buscar atleta…"
                    className="pl-8"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                {/* Descarga por equipo (encarpetado) */}
                <div className="flex flex-wrap items-center gap-2 ml-auto">
                  <Select value={pdfTeam} onValueChange={setPdfTeam}>
                    <SelectTrigger className="w-auto min-w-40" data-testid="pdf-team-select"><SelectValue placeholder="Equipo" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos los equipos</SelectItem>
                      {cardTeamOptions.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={pdfMode} onValueChange={(v) => setPdfMode(v as PdfLayoutMode)}>
                    <SelectTrigger className="w-auto min-w-44" data-testid="pdf-mode-select" aria-label="Formato de impresión"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="duplex" data-testid="pdf-mode-duplex">Doble cara (frentes y reversos)</SelectItem>
                      <SelectItem value="together" data-testid="pdf-mode-together">Frente y reverso juntos</SelectItem>
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={pdfCutMarks}
                      onChange={(e) => setPdfCutMarks(e.target.checked)}
                    />
                    Marcas de corte
                  </label>
                  <Button size="sm" variant="outline" disabled={pdfBusy} onClick={downloadCardsPdf} className="gap-1">
                    {pdfBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {pdfBusy && pdfProgress ? `Generando ${pdfProgress.done}/${pdfProgress.total}…` : 'Descargar PDF'}
                  </Button>
                </div>
              </div>

              <StatFilterBar
                className="mb-4"
                columns={4}
                value={statusFilter === 'all' ? null : statusFilter}
                onChange={(v) => setStatusFilter(v ?? 'all')}
                items={[
                  { key: null, label: 'Todos', value: cardCounts.all, tone: 'neutral' },
                  { key: 'active', label: 'Vigentes', value: cardCounts.active, tone: 'emerald' },
                  { key: 'revoked', label: 'Revocados', value: cardCounts.revoked, tone: 'rose' },
                  { key: 'expired', label: 'Vencidos', value: cardCounts.expired, tone: 'yellow' },
                ]}
              />

              {loadingCards ? (
                <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
              ) : cards.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground">Sin carnets emitidos.</p>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Atleta</TableHead>
                      <TableHead>Documento</TableHead>
                      <TableHead>Emitido</TableHead>
                      <TableHead>Vence</TableHead>
                      <TableHead>v</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cards.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-sm font-medium">{c.athlete_name}</TableCell>
                        <TableCell className="text-xs tabular-nums">{c.doc_number || '—'}</TableCell>
                        <TableCell className="text-xs">{new Date(c.issued_at).toLocaleDateString('es-CO')}</TableCell>
                        <TableCell className="text-xs">{new Date(c.valid_until).toLocaleDateString('es-CO')}</TableCell>
                        <TableCell className="text-xs">{c.version}</TableCell>
                        <TableCell>
                          <Badge className={STATUS_BADGE[c.status] || ''}>{STATUS_LABEL[c.status] || c.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button size="sm" variant="outline" onClick={() => openPreview(c.qr_token)} className="gap-1">
                            <Eye className="h-3.5 w-3.5" />
                            Ver
                          </Button>
                          {c.status === 'active' && (
                            <Button size="sm" variant="outline" onClick={() => shareCard(c.qr_token, c.athlete_name)} className="gap-1">
                              <Send className="h-3.5 w-3.5" />
                              Enviar
                            </Button>
                          )}
                          {c.status === 'active' && (
                            <Button size="sm" variant="outline" onClick={() => revoke(c)} className="gap-1 text-red-600 hover:bg-red-50">
                              <ShieldOff className="h-3.5 w-3.5" />
                              Revocar
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}

              <Pager
                offset={cardsOffset}
                pageCount={cards.length}
                total={cardsTotal}
                busy={loadingCards}
                onChange={setCardsOffset}
              />

              <TableRefreshBar
                className="-mx-6 -mb-6 mt-2 rounded-b-lg"
                onRefresh={() => loadCards(cardsOffset)}
                loading={loadingCards}
                summary={`${cardsTotal} carnet(s)`}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="templates">
          <CardTemplatesManager schoolId={schoolId} />
        </TabsContent>
      </Tabs>

      {/* Issue dialog */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Emitir carnet</DialogTitle>
            <DialogDescription>
              {issueTarget?.card_status === 'active'
                ? `Esto revocará el carnet vigente de ${issueTarget?.full_name} y emitirá uno nuevo.`
                : issueTarget?.card_status === 'expired'
                  ? `${issueTarget?.full_name} tiene un carnet vencido: se reemplaza por una versión nueva.`
                  : `Se generará un nuevo carnet para ${issueTarget?.full_name}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {issueTarget && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                <div><span className="font-medium text-foreground">{KIND_LABEL[issueTarget.kind]}</span>
                  {issueTarget.doc_number ? ` · ${issueTarget.doc_type || ''} ${issueTarget.doc_number}`.trimEnd() : ' · sin documento registrado'}
                </div>
                <div>{issueTarget.team_name || 'Sin equipo'}{issueTarget.branch_name ? ` · ${issueTarget.branch_name}` : ''}</div>
              </div>
            )}
            {templates.length > 0 && (
              <div>
                <Label>Plantilla</Label>
                <Select value={issueTemplate} onValueChange={setIssueTemplate}>
                  <SelectTrigger><SelectValue placeholder="Plantilla" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      Predeterminada de la escuela{defaultTemplate ? ` (${defaultTemplate.name})` : ' (diseño base)'}
                    </SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}{t.is_default ? ' ★' : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="valid_until">Vence el</Label>
              <Input
                id="valid_until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueOpen(false)}>Cancelar</Button>
            <Button onClick={confirmIssue} disabled={issuing}>
              {issuing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Emitir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke dialog */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revocar carnet</DialogTitle>
            <DialogDescription>
              El carnet de <strong>{revokeTarget?.athlete_name}</strong> quedará inválido y el QR mostrará "revocado". Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="revoke_reason">Motivo (opcional)</Label>
            <Input
              id="revoke_reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="Ej: reportado como perdido"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && !revoking) void confirmRevoke(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revoking}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmRevoke} disabled={revoking} className="gap-1">
              {revoking && <Loader2 className="h-4 w-4 animate-spin" />}
              Revocar carnet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        {/* max-w-lg y pie que se parte en líneas: con los tres botones en una fila el
            pie medía más que el diálogo, ensanchaba la grilla y recortaba el carnet. */}
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Vista previa del carnet</DialogTitle>
            <DialogDescription>QR público escaneable. Estado en tiempo real.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4">
            {!previewData ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : (
              <AthleteIdCard
                ref={previewRef}
                data={previewData}
                face={previewFace}
                publicUrl={`${publicCardOrigin}/${previewToken}`}
              />
            )}
            {previewData && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreviewFace((f) => (f === 'front' ? 'back' : 'front'))}
                className="gap-1"
              >
                <RotateCw className="h-3.5 w-3.5" />
                {previewFace === 'front' ? 'Ver reverso' : 'Ver frente'}
              </Button>
            )}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-between sm:space-x-0">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => previewToken && window.open(`/c/${previewToken}`, '_blank')}
                className="gap-1"
                disabled={!previewToken}
              >
                <ExternalLink className="h-4 w-4" />
                Abrir
              </Button>
              <Button
                variant="outline"
                onClick={() => previewToken && shareCard(previewToken, previewData?.athlete?.full_name)}
                className="gap-1"
                disabled={!previewToken}
              >
                <Send className="h-4 w-4" />
                Enviar al padre
              </Button>
            </div>
            <Button onClick={downloadPreview} disabled={downloading || !previewData} className="gap-1">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Descargar PNG
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/** Paginador simple: rango visible + anterior/siguiente. */
function Pager({ offset, pageCount, total, busy, onChange }: {
  offset: number;
  pageCount: number;
  total: number;
  busy: boolean;
  onChange: (offset: number) => void;
}) {
  if (total <= PAGE_SIZE) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + pageCount;
  return (
    <div className="flex items-center justify-between gap-3 pt-3">
      <span className="text-xs text-muted-foreground tabular-nums">
        {from}–{to} de {total}
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={busy || offset === 0}
          onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Anterior
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={busy || to >= total}
          onClick={() => onChange(offset + PAGE_SIZE)}
        >
          Siguiente
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
