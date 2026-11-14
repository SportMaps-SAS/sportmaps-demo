import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, Trophy, Share2, Rocket, Link2, AlertCircle, Plus, Trash2, Save, UserPlus, Radio, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/common/ImageUpload';
import { TournamentTeamsPanel } from '@/components/tournaments/TournamentTeamsPanel';
import { TournamentSponsorsPanel } from '@/components/tournaments/TournamentSponsorsPanel';
import { TournamentContentPanel } from '@/components/tournaments/TournamentContentPanel';
import { TournamentCardsPanel } from '@/components/tournaments/TournamentCardsPanel';
import { getIndividualRegistrations, assignTeams, IndividualRegistration } from '@/lib/api/tournaments';
import { RegisterAthleteDialog } from '@/components/school/RegisterAthleteDialog';
import { TournamentResultsPanel } from '@/components/tournaments/TournamentResultsPanel';
import { CobroTorneoFields } from '@/components/school/CobroTorneoFields';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { mediosDeCobroDeLaEscuela, soloEfectivo } from '@/lib/tournaments/mediosDeCobro';

interface Category {
  /** Id de la categoría guardada: se manda para que el BFF la actualice sin cambiarle el id. */
  id?: string;
  division: string; level: string; category: string; rama: string;
  age_min: number | null; age_max: number | null; team_min: number | null; team_max: number | null;
}
interface Phase {
  phase_name: string; valid_until: string; deposit_percent: number;
  price_solo: number; price_pkg1: number;
}
interface Delegation {
  id: string; status: string; total_owed: number; total_paid: number;
  contact_name: string | null; submitted_at: string | null; created_at: string;
  school: { id: string; name: string; city: string | null } | null;
  teams: { count: number }[]; members: { count: number }[];
  payments?: { id: string; amount: number; status: string; payment_method: string; proof_url: string | null; created_at: string }[];
}
interface Detail {
  id: string; title: string; sport: string; description: string | null; slug: string;
  status: string; visibility: 'public' | 'invited_only' | 'school_only';
  tournament_scope: 'internal' | 'external' | null; payer_mode: 'school' | 'parent' | 'flexible' | null;
  event_date: string; start_time: string; end_time: string | null;
  address: string; city: string; capacity: number | null;
  registration_deadline: string | null;
  /** false = torneo gratis (sin cobro). Solo aplica a internos. */
  is_paid?: boolean; payment_methods?: string[] | null;
  categories?: any[]; phases?: any[];
  live_enabled?: boolean;
  // Identidad pública (página en vivo). banner_url = portada.
  logo_url?: string | null; banner_url?: string | null; end_date?: string | null;
  venue_name?: string | null; venue_maps_url?: string | null; rules_url?: string | null; organizer_name?: string | null;
  attachments?: Array<{ name: string; url: string }> | null;
}

/** Link propio del torneo: minúsculas, números y guiones (mismo criterio que el BFF). */
export function slugError(v: string): string | null {
  return /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/.test(v) ? null : 'Usa de 3 a 60 minúsculas, números o guiones (sin tildes ni espacios).';
}

/** Enlaces opcionales de la ficha: vacío o https. */
export function httpsFieldError(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  try { return new URL(t).protocol === 'https:' ? null : 'Debe empezar por https://'; } catch { return 'El enlace no es válido'; }
}

const STATUS_LABEL: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  draft: { label: 'Borrador', variant: 'outline' }, active: { label: 'Publicado', variant: 'default' },
  closed: { label: 'Cerrado', variant: 'secondary' }, cancelled: { label: 'Cancelado', variant: 'destructive' },
  completed: { label: 'Finalizado', variant: 'secondary' },
};
const SCOPE_LABEL: Record<string, string> = { internal: 'Interno', external: 'Externo' };
const VIS_LABEL: Record<string, string> = { public: 'Público', invited_only: 'Por invitación', school_only: 'Solo mi escuela' };
const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const emptyCat = (): Category => ({ division: 'General', level: '1', category: 'Open', rama: 'Mixto', age_min: null, age_max: null, team_min: 1, team_max: 30 });
const emptyPhase = (): Phase => ({ phase_name: 'Preventa', valid_until: '', deposit_percent: 30, price_solo: 0, price_pkg1: 0 });

export default function SchoolTournamentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [t, setT] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  // ?tab=inscritos|resultados|carnes|contenido: los accesos directos del inicio y del menú abren la pestaña.
  const [params] = useSearchParams();
  const TABS = ['info', 'cats', 'inscritos', 'resultados', 'contenido', 'carnes'];
  const initialTab = TABS.includes(params.get('tab') ?? '') ? String(params.get('tab')) : 'info';
  const { schoolSettings, schoolId } = useSchoolContext();
  // Solo los medios que la escuela ya tiene configurados.
  const medios = mediosDeCobroDeLaEscuela(schoolSettings);

  // editores
  const [info, setInfo] = useState<Partial<Detail>>({});
  const [cats, setCats] = useState<Category[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [tpls, setTpls] = useState<any[]>([]);
  const [savingInfo, setSavingInfo] = useState(false);
  const [savingCats, setSavingCats] = useState(false);

  // inscritos (externo: delegaciones)
  const [dels, setDels] = useState<Delegation[]>([]);
  const [delsLoaded, setDelsLoaded] = useState(false);

  // inscritos (interno: individuales + armado de equipos)
  const [regs, setRegs] = useState<IndividualRegistration[]>([]);
  const [regsLoaded, setRegsLoaded] = useState(false);
  const [teamNameDraft, setTeamNameDraft] = useState<Record<string, string>>({});
  const [selectedRegIds, setSelectedRegIds] = useState<Record<string, string[]>>({});
  const [creatingTeam, setCreatingTeam] = useState<string | null>(null);

  // resultados (liga)

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await bffClient.get<Detail>(`/api/v1/events/school-tournaments/${id}`);
      setT(d);
      setInfo({
        title: d.title, description: d.description, event_date: d.event_date, start_time: d.start_time,
        end_time: d.end_time, address: d.address, city: d.city, capacity: d.capacity,
        visibility: d.visibility, payer_mode: d.payer_mode, registration_deadline: d.registration_deadline,
        is_paid: d.is_paid !== false, payment_methods: d.payment_methods ?? [],
        logo_url: d.logo_url ?? null, banner_url: d.banner_url ?? null, end_date: d.end_date ?? null,
        venue_name: d.venue_name ?? null, venue_maps_url: d.venue_maps_url ?? null, rules_url: d.rules_url ?? null,
        organizer_name: d.organizer_name ?? null, attachments: d.attachments ?? [], slug: d.slug,
      });
      setCats((d.categories ?? []).map((c: any) => ({
        id: c.id, division: c.division, level: c.level, category: c.category, rama: c.rama,
        age_min: c.age_min, age_max: c.age_max, team_min: c.team_min, team_max: c.team_max,
      })));
      setPhases((d.phases ?? []).map((p: any) => ({
        phase_name: p.phase_name, valid_until: p.valid_until, deposit_percent: p.deposit_percent,
        price_solo: p.price_solo, price_pkg1: p.price_pkg1,
      })));
      try {
        const tp = await bffClient.get<any[]>(`/api/v1/events/category-templates?sport=${encodeURIComponent(d.sport || '')}`);
        setTpls(tp);
      } catch { /* sin plantillas para este deporte */ }
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'No se pudo cargar.', variant: 'destructive' });
    } finally { setLoading(false); }
  }, [id, toast]);

  useEffect(() => { void load(); }, [load]);

  const loadDelegations = useCallback(async () => {
    try {
      const d = await bffClient.get<Delegation[]>(`/api/v1/events/school-tournaments/${id}/delegations`);
      setDels(d); setDelsLoaded(true);
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'No se pudieron cargar los inscritos.', variant: 'destructive' });
    }
  }, [id, toast]);

  const loadIndividualRegistrations = useCallback(async () => {
    try {
      const r = await getIndividualRegistrations(String(id));
      setRegs(r); setRegsLoaded(true);
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'No se pudieron cargar los inscritos.', variant: 'destructive' });
    }
  }, [id, toast]);

  // Abrir directo en Inscritos (acceso del inicio) también carga la lista.
  useEffect(() => {
    if (initialTab !== 'inscritos' || !t) return;
    if (t.tournament_scope === 'internal') { if (!regsLoaded) void loadIndividualRegistrations(); }
    else if (!delsLoaded) void loadDelegations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id]);

  const createTeam = async (catId: string) => {
    const teamName = (teamNameDraft[catId] ?? '').trim();
    const ids = selectedRegIds[catId] ?? [];
    if (!teamName) { toast({ title: 'Ponle nombre al equipo', variant: 'destructive' }); return; }
    if (ids.length === 0) { toast({ title: 'Selecciona al menos un inscrito', variant: 'destructive' }); return; }
    setCreatingTeam(catId);
    try {
      const r = await assignTeams(String(id), catId, [{ team_name: teamName, registration_ids: ids }]);
      toast({ title: 'Equipo armado', description: `${r.members_assigned} atleta(s) asignado(s).` });
      setTeamNameDraft((p) => ({ ...p, [catId]: '' }));
      setSelectedRegIds((p) => ({ ...p, [catId]: [] }));
      await loadIndividualRegistrations();
    } catch (e: any) {
      toast({ title: 'No se pudo armar el equipo', description: e?.message, variant: 'destructive' });
    } finally {
      setCreatingTeam(null);
    }
  };

  const recordPayment = async (d: Delegation) => {
    const remaining = Math.max(Number(d.total_owed || 0) - Number(d.total_paid || 0), 0);
    const raw = window.prompt('Monto recibido (COP):', String(remaining || ''));
    if (raw == null) return;
    const amount = Number(raw);
    if (!amount || amount <= 0) { toast({ title: 'Monto inválido', variant: 'destructive' }); return; }
    try {
      await bffClient.post(`/api/v1/events/school-tournaments/${id}/delegations/${d.id}/record-payment`, { amount, payment_method: 'cash' });
      toast({ title: 'Pago registrado' }); await loadDelegations();
    } catch (e: any) { toast({ title: 'Error', description: e?.message, variant: 'destructive' }); }
  };
  const approveDel = async (d: Delegation) => {
    try {
      await bffClient.patch(`/api/v1/events/school-tournaments/${id}/delegations/${d.id}`, { action: 'approve' });
      toast({ title: 'Delegación aprobada' }); await loadDelegations();
    } catch (e: any) { toast({ title: 'No se pudo aprobar', description: e?.message, variant: 'destructive' }); }
  };
  const rejectDel = async (d: Delegation) => {
    const reason = window.prompt('Motivo del rechazo (opcional):') ?? undefined;
    try {
      await bffClient.patch(`/api/v1/events/school-tournaments/${id}/delegations/${d.id}`, { action: 'reject', rejection_reason: reason });
      toast({ title: 'Delegación rechazada' }); await loadDelegations();
    } catch (e: any) { toast({ title: 'Error', description: e?.message, variant: 'destructive' }); }
  };
  const verifyPayment = async (d: Delegation, payId: string, action: 'verify' | 'reject') => {
    try {
      await bffClient.patch(`/api/v1/events/school-tournaments/${id}/delegations/${d.id}/payments/${payId}`, { action });
      toast({ title: action === 'verify' ? 'Pago verificado' : 'Pago rechazado' }); await loadDelegations();
    } catch (e: any) { toast({ title: 'Error', description: e?.message, variant: 'destructive' }); }
  };

  const fmt = (d?: string | null) => d ? new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const money = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n || 0);
  const publicUrl = t ? `${window.location.origin}/event/${t.slug}` : '';
  const liveUrl = t ? `${window.location.origin}/torneo/${t.slug}/en-vivo` : '';
  const infoErrors = [
    httpsFieldError(info.venue_maps_url), httpsFieldError(info.rules_url),
    ...(info.attachments ?? []).map((a) => (!a.name.trim() ? 'Ponle nombre a cada adjunto' : httpsFieldError(a.url) ?? (a.url.trim() ? null : `Falta el enlace de «${a.name}»`))),
    info.slug != null ? slugError(info.slug) : null,
  ].filter(Boolean) as string[];
  const endBeforeStart = !!(info.end_date && info.event_date && info.end_date < info.event_date);

  const saveInfo = async () => {
    if (infoErrors.length || endBeforeStart) { toast({ title: 'Revisa los datos', description: endBeforeStart ? 'La fecha de cierre no puede ser antes de la fecha de inicio.' : infoErrors[0], variant: 'destructive' }); return; }
    setSavingInfo(true);
    const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
    const body = {
      ...info,
      end_date: info.end_date || null, venue_name: blank(info.venue_name), venue_maps_url: blank(info.venue_maps_url),
      rules_url: blank(info.rules_url), organizer_name: blank(info.organizer_name),
      attachments: (info.attachments ?? []).map((a) => ({ name: a.name.trim(), url: a.url.trim() })),
      ...(info.slug && info.slug !== t?.slug ? { slug: info.slug } : { slug: undefined }),
    };
    try { await bffClient.patch(`/api/v1/events/school-tournaments/${id}`, body); toast({ title: 'Guardado' }); await load(); }
    catch (e: any) { toast({ title: 'Error', description: e?.message, variant: 'destructive' }); }
    finally { setSavingInfo(false); }
  };
  const saveCatsAndPhases = async () => {
    setSavingCats(true);
    try {
      await bffClient.put(`/api/v1/events/school-tournaments/${id}/categories`, { categories: cats });
      await bffClient.put(`/api/v1/events/school-tournaments/${id}/price-phases`, { phases });
      toast({ title: 'Categorías y precios guardados' });
      await load();
    } catch (e: any) { toast({ title: 'Error', description: e?.message, variant: 'destructive' }); }
    finally { setSavingCats(false); }
  };
  const publish = async () => {
    setPublishing(true);
    try { await bffClient.post(`/api/v1/events/school-tournaments/${id}/publish`, {}); toast({ title: 'Torneo publicado' }); await load(); }
    catch (e: any) { toast({ title: 'Error al publicar', description: e?.message, variant: 'destructive' }); }
    finally { setPublishing(false); }
  };
  const shareUrl = async (url: string, copied: string) => {
    try { if (navigator.share) await navigator.share({ title: t?.title, url }); else { await navigator.clipboard.writeText(url); toast({ title: copied }); } } catch { /* cancelado */ }
  };
  const share = () => shareUrl(publicUrl, 'Enlace de inscripción copiado');
  const shareLive = () => shareUrl(liveUrl, 'Enlace de la página en vivo copiado');
  const copyLive = async () => {
    try { await navigator.clipboard.writeText(liveUrl); toast({ title: 'Enlace copiado' }); }
    catch { toast({ title: 'No se pudo copiar', description: 'Selecciona el enlace y cópialo a mano.', variant: 'destructive' }); }
  };

  if (loading) return <div className="mx-auto max-w-4xl px-4 py-6 space-y-4"><Skeleton className="h-8 w-40" /><Skeleton className="h-40 w-full" /></div>;
  if (!t) return (
    <div className="mx-auto max-w-2xl px-4 py-10"><Card><CardContent className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle className="h-10 w-10 text-muted-foreground" /><p className="font-medium">Torneo no encontrado</p>
      <Button variant="outline" onClick={() => navigate('/school/tournaments')}><ArrowLeft className="mr-1 h-4 w-4" /> Volver a Mis Torneos</Button>
    </CardContent></Card></div>
  );

  const st = STATUS_LABEL[t.status] ?? { label: t.status, variant: 'outline' as const };
  const isDraft = t.status === 'draft';
  const isActive = t.status === 'active';
  const isInternal = t.tournament_scope === 'internal';
  const savedCats = t.categories ?? [];
  const savedPhases = t.phases ?? [];
  // Un torneo GRATIS (interno o externo, p. ej. el del asistente) no tiene tarifa: no exige fase de precio.
  // Mismo criterio que el BFF: is_paid === false ⇒ gratis.
  const esGratis = t.is_paid === false;
  const canPublish = savedCats.length > 0 && (esGratis || savedPhases.length > 0);
  const isShareable = isActive && t.visibility !== 'school_only';
  // La página en vivo existe si el torneo no es privado, o si es interno pero con el marcador en vivo encendido.
  const isLiveShareable = !isDraft && t.status !== 'cancelled' && (t.visibility !== 'school_only' || !!t.live_enabled);

  const payStatus = (d: Delegation) => {
    const owed = Number(d.total_owed || 0), paid = Number(d.total_paid || 0);
    if (owed > 0 && paid >= owed) return { label: 'Pagado', variant: 'default' as const };
    if (paid > 0) return { label: 'Parcial', variant: 'secondary' as const };
    return { label: 'Pendiente', variant: 'outline' as const };
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      {isInternal && (
        <RegisterAthleteDialog
          open={registerOpen}
          onOpenChange={setRegisterOpen}
          eventId={String(id)}
          categorias={savedCats.map((c: any) => ({ id: c.id, etiqueta: `${c.division} · ${c.category} (${c.rama})` }))}
          isPaid={t.is_paid !== false}
          soloEfectivo={soloEfectivo(t.payment_methods)}
          inscritos={regs}
          onRegistered={() => void loadIndividualRegistrations()}
        />
      )}
      <button onClick={() => navigate('/school/tournaments')} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Volver a Mis Torneos
      </button>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {t.logo_url
            ? <img src={t.logo_url} alt={`Logo de ${t.title}`} className="h-11 w-11 shrink-0 rounded-lg border bg-white object-contain" data-testid="tournament-header-logo" />
            : <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10"><Trophy className="h-6 w-6 text-primary" /></div>}
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{t.title}</h1><Badge variant={st.variant}>{st.label}</Badge></div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge variant="secondary">{t.sport}</Badge>
              {t.tournament_scope && <Badge variant="outline">{SCOPE_LABEL[t.tournament_scope]}</Badge>}
              <Badge variant="outline">{VIS_LABEL[t.visibility]}</Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDraft && (
            <Button onClick={publish} disabled={publishing || !canPublish} title={!canPublish ? (esGratis ? 'Agrega al menos 1 categoría' : 'Agrega al menos 1 categoría y 1 fase de precio') : ''}>
              <Rocket className="mr-1 h-4 w-4" /> {publishing ? 'Publicando…' : 'Publicar'}
            </Button>
          )}
          {isShareable && <Button variant="outline" onClick={share} title="Enlace para inscribirse"><Share2 className="mr-1 h-4 w-4" /> Compartir inscripción</Button>}
          {isLiveShareable && <Button variant="outline" onClick={shareLive}><Radio className="mr-1 h-4 w-4" /> Compartir página en vivo</Button>}
          {isLiveShareable && <Button variant="ghost" onClick={() => setQrOpen(true)} aria-label="Ver QR de la página en vivo">QR</Button>}
        </div>
      </div>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Página en vivo</DialogTitle>
            <DialogDescription>Imprímelo o muéstralo en el coliseo: las familias ven posiciones, partidos y marcador sin iniciar sesión.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <div className="rounded bg-white p-3" data-testid="live-qr"><QRCodeSVG value={liveUrl} size={208} level="M" /></div>
            <div className="flex w-full gap-2">
              <Input readOnly value={liveUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Enlace de la página en vivo" />
              <Button variant="outline" onClick={copyLive} aria-label="Copiar enlace"><Copy className="h-4 w-4" /></Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {isDraft && !canPublish && (
        <Card className="mb-6 border-amber-300/50 bg-amber-50/50 dark:bg-amber-950/20"><CardContent className="flex items-start gap-3 py-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          {esGratis
            ? <p>Para <strong>publicar</strong> necesitas al menos <strong>1 categoría</strong> (pestaña Categorías y Precios). El torneo es gratis: no hace falta precio.</p>
            : <p>Para <strong>publicar</strong> necesitas al menos <strong>1 categoría</strong> y <strong>1 fase de precio</strong> (pestaña Categorías y Precios).</p>}
        </CardContent></Card>
      )}

      <Tabs defaultValue={initialTab} onValueChange={(v) => {
        if (v === 'inscritos') {
          if (isInternal && !regsLoaded) void loadIndividualRegistrations();
          if (!isInternal && !delsLoaded) void loadDelegations();
        }
      }}>
        <TabsList className="flex h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="cats">Categorías y Precios</TabsTrigger>
          <TabsTrigger value="inscritos">Inscritos</TabsTrigger>
          <TabsTrigger value="resultados">Resultados</TabsTrigger>
          <TabsTrigger value="contenido">Contenido</TabsTrigger>
          <TabsTrigger value="carnes">Carnés</TabsTrigger>
        </TabsList>

        {/* ─── INFO (editable) ─── */}
        <TabsContent value="info" className="mt-4">
          <Card><CardContent className="grid gap-4 py-5 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2"><Label>Título</Label><Input value={info.title ?? ''} onChange={(e) => setInfo({ ...info, title: e.target.value })} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Descripción</Label><Textarea rows={3} value={info.description ?? ''} onChange={(e) => setInfo({ ...info, description: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Fecha</Label><Input type="date" value={info.event_date ?? ''} onChange={(e) => setInfo({ ...info, event_date: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Cierre inscripciones</Label><Input type="date" value={info.registration_deadline ?? ''} onChange={(e) => setInfo({ ...info, registration_deadline: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Hora inicio</Label><Input type="time" value={info.start_time ?? ''} onChange={(e) => setInfo({ ...info, start_time: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Hora fin</Label><Input type="time" value={info.end_time ?? ''} onChange={(e) => setInfo({ ...info, end_time: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Dirección</Label><Input value={info.address ?? ''} onChange={(e) => setInfo({ ...info, address: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Ciudad</Label><Input value={info.city ?? ''} onChange={(e) => setInfo({ ...info, city: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Cupo</Label><Input type="number" min={1} value={info.capacity ?? ''} onChange={(e) => setInfo({ ...info, capacity: e.target.value ? Number(e.target.value) : null })} /></div>
            <div className="space-y-1.5"><Label>Último día (si dura varios días)</Label>
              <Input type="date" min={info.event_date ?? undefined} value={info.end_date ?? ''} onChange={(e) => setInfo({ ...info, end_date: e.target.value || null })} aria-invalid={endBeforeStart} />
              {endBeforeStart && <p role="alert" className="text-xs text-destructive">No puede ser antes de la fecha de inicio.</p>}</div>

            <div className="border-t pt-4 sm:col-span-2"><p className="text-sm font-semibold">Página en vivo</p>
              <p className="text-xs text-muted-foreground">Así se ve el torneo en /torneo/{t.slug}/en-vivo.</p></div>
            <div className="space-y-1.5"><Label>Logo del torneo</Label>
              {schoolId
                ? <ImageUpload compact value={info.logo_url ?? null} path={`logos/${schoolId}/torneos/${t.id}`} onChange={(url) => setInfo({ ...info, logo_url: url })} onRemove={() => setInfo({ ...info, logo_url: null })} />
                : <p className="text-xs text-muted-foreground">Cargando tu escuela…</p>}</div>
            <div className="space-y-1.5"><Label>Portada</Label>
              {schoolId
                ? <ImageUpload value={info.banner_url ?? null} path={`covers/${schoolId}/torneos/${t.id}`} onChange={(url) => setInfo({ ...info, banner_url: url })} onRemove={() => setInfo({ ...info, banner_url: null })} className="h-32" />
                : <p className="text-xs text-muted-foreground">Cargando tu escuela…</p>}</div>
            <div className="space-y-1.5"><Label>Sede (nombre del coliseo o cancha)</Label><Input maxLength={120} placeholder="Coliseo Iván de Bedout" value={info.venue_name ?? ''} onChange={(e) => setInfo({ ...info, venue_name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Enlace del mapa (opcional)</Label>
              <Input inputMode="url" placeholder="https://maps.app.goo.gl/…" value={info.venue_maps_url ?? ''} onChange={(e) => setInfo({ ...info, venue_maps_url: e.target.value })} aria-invalid={!!httpsFieldError(info.venue_maps_url)} />
              {httpsFieldError(info.venue_maps_url) ? <p role="alert" className="text-xs text-destructive">{httpsFieldError(info.venue_maps_url)}</p>
                : <p className="text-xs text-muted-foreground">Si lo dejas vacío, se arma con la dirección.</p>}</div>
            <div className="space-y-1.5"><Label>Reglamento (enlace, opcional)</Label>
              <Input inputMode="url" placeholder="https://drive.google.com/…" value={info.rules_url ?? ''} onChange={(e) => setInfo({ ...info, rules_url: e.target.value })} aria-invalid={!!httpsFieldError(info.rules_url)} />
              {httpsFieldError(info.rules_url) && <p role="alert" className="text-xs text-destructive">{httpsFieldError(info.rules_url)}</p>}</div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Link propio del torneo</Label>
              <div className="flex items-center gap-1 text-sm"><span className="text-muted-foreground">{window.location.host}/torneo/</span>
                <Input className="max-w-xs" value={info.slug ?? ''} onChange={(e) => setInfo({ ...info, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })} aria-invalid={!!(info.slug && slugError(info.slug))} aria-label="Link propio del torneo" /></div>
              {info.slug && slugError(info.slug) ? <p role="alert" className="text-xs text-destructive">{slugError(info.slug)}</p>
                : <p className="text-xs text-muted-foreground">Si lo cambias, los links que ya compartiste dejan de funcionar.</p>}</div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Adjuntos públicos (reglamento, programación en PDF…)</Label>
              {(info.attachments ?? []).map((a, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Nombre del adjunto ${i + 1}`} placeholder="Programación" value={a.name} onChange={(e) => setInfo({ ...info, attachments: (info.attachments ?? []).map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input aria-label={`Enlace del adjunto ${i + 1}`} inputMode="url" placeholder="https://drive.google.com/…" value={a.url} onChange={(e) => setInfo({ ...info, attachments: (info.attachments ?? []).map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                  <Button size="icon" variant="ghost" aria-label={`Quitar adjunto ${i + 1}`} onClick={() => setInfo({ ...info, attachments: (info.attachments ?? []).filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              ))}
              {(info.attachments ?? []).length < 20 && <Button size="sm" variant="outline" onClick={() => setInfo({ ...info, attachments: [...(info.attachments ?? []), { name: '', url: '' }] })}><Plus className="mr-1 h-4 w-4" /> Agregar adjunto</Button>}
            </div>
            <div className="space-y-1.5"><Label>Organiza (opcional)</Label><Input maxLength={120} placeholder="Si lo dejas vacío, sale el nombre de tu escuela" value={info.organizer_name ?? ''} onChange={(e) => setInfo({ ...info, organizer_name: e.target.value })} /></div>
            {isInternal && (
              <div className="sm:col-span-2">
                <CobroTorneoFields
                  isPaid={info.is_paid !== false}
                  onIsPaid={(v) => setInfo({ ...info, is_paid: v })}
                  metodos={info.payment_methods ?? []}
                  onMetodos={(m) => setInfo({ ...info, payment_methods: m })}
                  medios={medios}
                />
                {info.is_paid !== false && (
                  <p className="mt-2 text-xs text-muted-foreground">El valor de la inscripción se define en la pestaña Categorías y Precios.</p>
                )}
              </div>
            )}
            {!isInternal && (
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3 sm:col-span-2">
                <div>
                  <Label htmlFor="ext-is-paid" className="cursor-pointer">El torneo tiene costo</Label>
                  <p className="text-xs text-muted-foreground">Apagado = torneo gratis: se publica sin fase de precio y los equipos no deben nada.</p>
                </div>
                <Switch id="ext-is-paid" checked={info.is_paid !== false} onCheckedChange={(v) => setInfo({ ...info, is_paid: v })} />
              </div>
            )}
            {!isInternal && info.is_paid !== false && (
              <div className="space-y-1.5"><Label>¿Quién paga?</Label>
                <select className={selectCls} value={info.payer_mode ?? 'school'} onChange={(e) => setInfo({ ...info, payer_mode: e.target.value as any })}>
                  <option value="school">La escuela recauda</option><option value="parent">Cada familia paga</option><option value="flexible">Flexible</option>
                </select>
              </div>
            )}
            <div className="sm:col-span-2"><Button onClick={saveInfo} disabled={savingInfo}><Save className="mr-1 h-4 w-4" /> {savingInfo ? 'Guardando…' : 'Guardar cambios'}</Button></div>
          </CardContent></Card>
          <div className="mt-6"><TournamentSponsorsPanel eventId={String(id)} schoolId={schoolId} /></div>
        </TabsContent>

        {/* ─── CATEGORÍAS Y PRECIOS ─── */}
        <TabsContent value="cats" className="mt-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Categorías</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setCats([...cats, emptyCat()])}><Plus className="mr-1 h-4 w-4" /> Agregar</Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {tpls.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 p-2">
                  <span className="text-xs font-medium text-muted-foreground">Sugeridas para {t.sport}:</span>
                  {tpls.map((tp, k) => (
                    <Button key={k} size="sm" variant="secondary" className="h-7"
                      onClick={() => setCats([...cats, {
                        division: tp.division, level: tp.level ?? '1', category: tp.category, rama: tp.rama,
                        age_min: tp.age_min, age_max: tp.age_max, team_min: tp.team_min, team_max: tp.team_max,
                      }])}>
                      + {tp.category}{tp.rama !== 'Mixto' ? ` ${tp.rama[0]}` : ''}
                    </Button>
                  ))}
                </div>
              )}
              {cats.length === 0 && <p className="text-sm text-muted-foreground">Sin categorías. Agrega una sugerida o crea la tuya para poder publicar.</p>}
              {cats.map((c, i) => (
                <div key={i} className="grid items-end gap-2 rounded-lg border p-3 sm:grid-cols-7">
                  <div className="space-y-1 sm:col-span-2"><Label className="text-xs text-muted-foreground">Grupo (ej. General)</Label>
                    <Input placeholder="General" value={c.division} onChange={(e) => setCats(cats.map((x, j) => j === i ? { ...x, division: e.target.value } : x))} /></div>
                  <div className="space-y-1 sm:col-span-2"><Label className="text-xs text-muted-foreground">Categoría (ej. Sub 12)</Label>
                    <Input placeholder="Sub 12" value={c.category} onChange={(e) => setCats(cats.map((x, j) => j === i ? { ...x, category: e.target.value } : x))} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Rama</Label>
                    <select className={selectCls} value={c.rama} onChange={(e) => setCats(cats.map((x, j) => j === i ? { ...x, rama: e.target.value } : x))}>
                      <option>Mixto</option><option>Masculino</option><option>Femenino</option>
                    </select></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Edad mín.</Label>
                    <Input type="number" placeholder="—" value={c.age_min ?? ''} onChange={(e) => setCats(cats.map((x, j) => j === i ? { ...x, age_min: e.target.value ? Number(e.target.value) : null } : x))} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Edad máx.</Label>
                    <div className="flex gap-1">
                      <Input type="number" placeholder="—" value={c.age_max ?? ''} onChange={(e) => setCats(cats.map((x, j) => j === i ? { ...x, age_max: e.target.value ? Number(e.target.value) : null } : x))} />
                      <Button size="icon" variant="ghost" title="Quitar categoría" onClick={() => setCats(cats.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div></div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Fases de precio</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setPhases([...phases, isInternal ? { ...emptyPhase(), phase_name: 'Inscripción' } : emptyPhase()])}><Plus className="mr-1 h-4 w-4" /> Agregar</Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {esGratis ? (
                <p className="text-sm text-muted-foreground">Este torneo es <strong>gratis</strong>: no necesita precio. Si quieres cobrar, activa «El torneo tiene costo» en la pestaña Info.</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {phases.length === 0 ? 'Agrega al menos una fase con el valor de la inscripción. ' : ''}
                  Cada fase tiene un valor y una fecha hasta la que aplica (ej. «Preventa» más barata hasta el 10, luego «Inscripción»).
                </p>
              )}
              {phases.map((p, i) => (
                <div key={i} className={`grid items-end gap-2 rounded-lg border p-3 ${isInternal ? 'sm:grid-cols-[2fr_1fr_1.3fr_auto]' : 'sm:grid-cols-[2fr_1fr_1.3fr_1fr_auto]'}`}>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Nombre de la fase</Label>
                    <Input placeholder="Inscripción" value={p.phase_name} onChange={(e) => setPhases(phases.map((x, j) => j === i ? { ...x, phase_name: e.target.value } : x))} /></div>
                  <div className="space-y-1"><Label className="text-xs text-muted-foreground">Válida hasta</Label>
                    <Input type="date" value={p.valid_until} onChange={(e) => setPhases(phases.map((x, j) => j === i ? { ...x, valid_until: e.target.value } : x))} /></div>
                  <div className="space-y-1"><Label className="whitespace-nowrap text-xs text-muted-foreground">Valor por atleta{p.price_solo > 0 ? ` · ${money(p.price_solo)}` : ' (COP)'}</Label>
                    <Input type="number" placeholder="50000" value={p.price_solo || ''} onChange={(e) => setPhases(phases.map((x, j) => j === i ? { ...x, price_solo: Number(e.target.value) } : x))} /></div>
                  {!isInternal && (
                    <div className="space-y-1"><Label className="text-xs text-muted-foreground">% de anticipo</Label>
                      <Input type="number" placeholder="30" value={p.deposit_percent || ''} onChange={(e) => setPhases(phases.map((x, j) => j === i ? { ...x, deposit_percent: Number(e.target.value) } : x))} /></div>
                  )}
                  <Button size="icon" variant="ghost" title="Quitar fase" onClick={() => setPhases(phases.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="flex justify-end"><Button onClick={saveCatsAndPhases} disabled={savingCats}><Save className="mr-1 h-4 w-4" /> {savingCats ? 'Guardando…' : 'Guardar categorías y precios'}</Button></div>
        </TabsContent>

        {/* ─── INSCRITOS ─── */}
        <TabsContent value="inscritos" className="mt-4 space-y-4">
          <TournamentTeamsPanel
            eventId={String(id)} schoolId={schoolId} tournamentTitle={t.title}
            categories={savedCats.map((c: any) => ({ id: c.id, name: `${c.division} · ${c.category} (${c.rama})` }))}
          />
          {isInternal && savedCats.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {isActive || t.status === 'closed'
                  ? 'Inscribe a un atleta de tu escuela sin esperar a que la familia lo haga.'
                  : 'Publica el torneo para poder inscribir atletas.'}
              </p>
              <Button onClick={() => setRegisterOpen(true)} disabled={!(isActive || t.status === 'closed')}>
                <UserPlus className="mr-1 h-4 w-4" /> Inscribir atleta
              </Button>
            </div>
          )}
          {isInternal && regsLoaded && regs.length === 0 && savedCats.length > 0 && (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
              Aún no hay inscritos. Inscribe atletas desde aquí o comparte el torneo con las familias.
            </CardContent></Card>
          )}
          {isInternal ? (
            !regsLoaded ? (
              <Skeleton className="h-24 w-full" />
            ) : savedCats.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">
                Primero agrega categorías (pestaña Categorías y Precios).
              </CardContent></Card>
            ) : (
              savedCats.map((cat: any) => {
                const catRegs = regs.filter((r) => r.category_id === cat.id);
                if (catRegs.length === 0) return null;
                const unassigned = catRegs.filter((r) => !r.team_id);
                const teams = new Map<string, IndividualRegistration[]>();
                catRegs.filter((r) => r.team_id).forEach((r) => {
                  const key = r.team?.team_name ?? r.team_id!;
                  teams.set(key, [...(teams.get(key) ?? []), r]);
                });
                const sel = selectedRegIds[cat.id] ?? [];
                return (
                  <Card key={cat.id}>
                    <CardHeader><CardTitle className="text-base">{cat.division} · {cat.category} ({cat.rama})</CardTitle></CardHeader>
                    <CardContent className="space-y-3">
                      {Array.from(teams.entries()).map(([teamName, members]) => (
                        <div key={teamName} className="rounded-md border p-2">
                          <p className="mb-1 text-sm font-medium">⚽ {teamName}</p>
                          <div className="flex flex-wrap gap-1">
                            {members.map((m) => (
                              <Badge key={m.id} variant="secondary">
                                {m.participant_name}
                                {m.payment && m.payment.status !== 'paid' && <span className="ml-1 text-amber-600">· pago pendiente</span>}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}

                      {unassigned.length > 0 && (
                        <div className="space-y-2 rounded-md border border-dashed p-3">
                          <p className="text-sm font-medium">Sin equipo ({unassigned.length})</p>
                          <div className="space-y-1">
                            {unassigned.map((r) => (
                              <label key={r.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={sel.includes(r.id)}
                                  onChange={(e) => setSelectedRegIds((p) => {
                                    const cur = p[cat.id] ?? [];
                                    return { ...p, [cat.id]: e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id) };
                                  })}
                                />
                                <span>{r.participant_name}</span>
                                <Badge variant="outline" className="text-[10px]">
                                  {!r.payment ? 'Sin cobro' : r.payment.status === 'paid' ? 'Pagado' : 'Pendiente'}
                                </Badge>
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <Input
                              placeholder="Nombre del equipo"
                              value={teamNameDraft[cat.id] ?? ''}
                              onChange={(e) => setTeamNameDraft((p) => ({ ...p, [cat.id]: e.target.value }))}
                            />
                            <Button size="sm" disabled={creatingTeam === cat.id} onClick={() => createTeam(cat.id)}>
                              {creatingTeam === cat.id ? 'Armando…' : 'Crear equipo'}
                            </Button>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })
            )
          ) : (
          <Card>
            <CardHeader><CardTitle className="text-base">Delegaciones inscritas</CardTitle></CardHeader>
            <CardContent>
              {!delsLoaded ? (
                <Skeleton className="h-24 w-full" />
              ) : dels.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aún no hay academias inscritas.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Academia</TableHead><TableHead>Equipos</TableHead><TableHead>Atletas</TableHead>
                      <TableHead>Adeudado</TableHead><TableHead>Pagado</TableHead><TableHead>Pago</TableHead><TableHead>Estado</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {dels.map((d) => {
                        const ps = payStatus(d);
                        return (
                          <TableRow key={d.id}>
                            <TableCell className="font-medium">{d.school?.name ?? d.contact_name ?? '—'}</TableCell>
                            <TableCell>{d.teams?.[0]?.count ?? 0}</TableCell>
                            <TableCell>{d.members?.[0]?.count ?? 0}</TableCell>
                            <TableCell>{money(Number(d.total_owed))}</TableCell>
                            <TableCell>{money(Number(d.total_paid))}</TableCell>
                            <TableCell><Badge variant={ps.variant}>{ps.label}</Badge></TableCell>
                            <TableCell><Badge variant="outline">{d.status}</Badge></TableCell>
                            <TableCell className="text-right">
                              <div className="flex flex-col items-end gap-1">
                                {(d.payments ?? []).filter((p) => p.status === 'pending').map((p) => (
                                  <div key={p.id} className="flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs dark:bg-amber-950/30">
                                    <span className="text-amber-700 dark:text-amber-400">Comprobante {money(Number(p.amount))}</span>
                                    {p.proof_url && <a href={p.proof_url} target="_blank" rel="noreferrer" className="underline">ver</a>}
                                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => verifyPayment(d, p.id, 'verify')}>✓</Button>
                                    <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => verifyPayment(d, p.id, 'reject')}>✕</Button>
                                  </div>
                                ))}
                                {['submitted', 'draft', 'pending_payment'].includes(d.status) ? (
                                  <div className="flex justify-end gap-1">
                                    <Button size="sm" variant="outline" onClick={() => recordPayment(d)}>Pago</Button>
                                    <Button size="sm" onClick={() => approveDel(d)}>Aprobar</Button>
                                    <Button size="sm" variant="ghost" onClick={() => rejectDel(d)}>Rechazar</Button>
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
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
            </CardContent>
          </Card>
          )}
        </TabsContent>

        {/* ─── CONTENIDO: fotos, videos, noticias, comentarios y MVP ─── */}
        <TabsContent value="contenido" className="mt-4">
          <TournamentContentPanel eventId={String(id)} slug={t.slug} />
        </TabsContent>

        {/* ─── CARNÉS: formulario de jugador, diseño del carné y PDF ─── */}
        <TabsContent value="carnes" className="mt-4">
          <TournamentCardsPanel eventId={String(id)} tournament={{ id: t.id, title: t.title, logo_url: t.logo_url ?? null }} />
        </TabsContent>

        {/* ─── RESULTADOS: calendario por formato, tablas, cuadro y marcador en vivo ─── */}
        <TabsContent value="resultados" className="mt-4">
          <TournamentResultsPanel
            eventId={id!}
            categories={savedCats.map((c: any) => ({ id: c.id, division: c.division, category: c.category, rama: c.rama }))}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
