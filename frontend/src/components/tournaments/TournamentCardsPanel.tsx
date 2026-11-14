import { useCallback, useEffect, useMemo, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AthleteIdCard } from '@/components/cards/AthleteIdCard';
import { exportCardsPdf } from '@/lib/cards/cardExport';
import { IdCard, ListChecks, Plus, Trash2 } from 'lucide-react';
import type { TeamDto } from '@/lib/tournamentTypes';
import { BASE_LABEL, type BaseField, type CustomField, type PlayerForm } from '@/lib/tournamentPlayers';
import { CARD_FIELD_LABEL, toCardData, type CardField, type TournamentCard, type TournamentCardConfig } from '@/lib/tournamentPrint';
import { LIVE_BASE } from './FixtureGeneratorDialog';

const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const OPTIONAL_BASE: BaseField[] = ['photo_url', 'nickname', 'position', 'shirt_number', 'document_number', 'birth_date', 'phone'];
const TYPE_LABEL: Record<CustomField['type'], string> = { text: 'Texto', date: 'Fecha', bool: 'Sí / no', select: 'Lista' };

/** Formulario de jugador del torneo (campos base obligatorios + campos propios). */
export function PlayerFormEditor({ eventId }: { eventId: string }) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}`;
  const [form, setForm] = useState<PlayerForm | null>(null);
  const [opts, setOpts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { bffClient.get<PlayerForm>(`${base}/player-form`).then((f) => { setForm(f); setOpts(Object.fromEntries(f.custom.map((c, i) => [i, (c.options ?? []).join(', ')]))); }).catch(() => setForm({ required: ['full_name'], custom: [] })); }, [base]);
  if (!form) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  const toggleReq = (k: BaseField) => setForm({ ...form, required: form.required.includes(k) ? form.required.filter((x) => x !== k) : [...form.required, k] });
  const setCustom = (i: number, p: Partial<CustomField>) => setForm({ ...form, custom: form.custom.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const save = async () => {
    setBusy(true);
    try {
      const body = { required: form.required, custom: form.custom.map((c, i) => ({ ...c, options: c.type === 'select' ? (opts[i] ?? '').split(',').map((o) => o.trim()).filter(Boolean) : undefined })) };
      const f = await bffClient.put<PlayerForm>(`${base}/player-form`, body);
      setForm(f); toast({ title: 'Formulario guardado', description: 'Lo usan el alta de jugadores, la planilla y el link del delegado.' });
    } catch (e) { toast({ title: 'No se pudo guardar', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3" data-testid="player-form-editor">
      <div className="space-y-1">
        <p className="text-sm font-medium">Campos base (marca los obligatorios)</p>
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-1.5 text-muted-foreground"><input type="checkbox" checked disabled /> Nombre</label>
          {OPTIONAL_BASE.map((k) => (
            <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={form.required.includes(k)} onChange={() => toggleReq(k)} aria-label={`${BASE_LABEL[k]} obligatorio`} /> {BASE_LABEL[k]}</label>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Campos propios</p>
        {form.custom.map((c, i) => (
          <div key={i} className="grid items-center gap-2 rounded border p-2 sm:grid-cols-[1fr_8rem_1fr_auto_auto]">
            <Input aria-label={`Nombre del campo ${i + 1}`} maxLength={40} value={c.label} onChange={(e) => setCustom(i, { label: e.target.value })} placeholder="EPS" />
            <select aria-label={`Tipo del campo ${i + 1}`} className={selectCls} value={c.type} onChange={(e) => setCustom(i, { type: e.target.value as CustomField['type'] })}>
              {(Object.keys(TYPE_LABEL) as CustomField['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            {c.type === 'select'
              ? <Input aria-label={`Opciones del campo ${i + 1}`} value={opts[i] ?? ''} onChange={(e) => setOpts({ ...opts, [i]: e.target.value })} placeholder="S, M, L, XL" />
              : <span />}
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!c.required} onChange={(e) => setCustom(i, { required: e.target.checked })} /> Obligatorio</label>
            <Button size="icon" variant="ghost" aria-label={`Quitar campo ${i + 1}`} onClick={() => setForm({ ...form, custom: form.custom.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        {form.custom.length < 15 && (
          <Button size="sm" variant="outline" onClick={() => setForm({ ...form, custom: [...form.custom, { key: '', label: '', type: 'text', required: false }] })}><Plus className="mr-1 h-4 w-4" /> Agregar campo</Button>
        )}
      </div>
      <Button onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar formulario'}</Button>
    </div>
  );
}

/** Diseño del carné (mismo motor de Carnets Digitales) y descarga en PDF, 9 por hoja. */
export function TournamentCardsPanel({ eventId, tournament }: { eventId: string; tournament: { id: string; title: string; logo_url: string | null } }) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}`;
  const [cfg, setCfg] = useState<TournamentCardConfig | null>(null);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [teamId, setTeamId] = useState('');
  const [cards, setCards] = useState<TournamentCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // Campos propios de la ficha (EPS, talla…): van al reverso del carné.
  const [custom, setCustom] = useState<CustomField[]>([]);
  useEffect(() => { bffClient.get<PlayerForm>(`${base}/player-form`).then((f) => setCustom(f.custom ?? [])).catch(() => setCustom([])); }, [base]);

  const loadCards = useCallback(async (tid: string) => {
    try {
      const r = await bffClient.get<{ config: TournamentCardConfig; cards: TournamentCard[] }>(`${base}/cards${tid ? `?team_id=${tid}` : ''}`);
      setCards(r.cards); setCfg((c) => c ?? r.config);
    } catch (e) { toast({ title: 'No se pudieron cargar los carnés', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, toast]);
  useEffect(() => { bffClient.get<TeamDto[]>(`${base}/teams`).then(setTeams).catch(() => setTeams([])); }, [base]);
  useEffect(() => { void loadCards(teamId); }, [teamId, loadCards]);

  const sample: TournamentCard = useMemo(() => cards[0] ?? {
    player: { id: 'x', team_id: 'x', full_name: 'Nombre Jugador', nickname: 'Apodo', position: 'Armadora', shirt_number: 7, document_number: '1020304050', birth_date: null, phone: '3001234567', photo_url: null, extra: {}, suspended: false, suspended_reason: null, from_school: false },
    team_name: 'Equipo', team_logo_url: null, token: 'muestra', validate_url: `${window.location.origin}/torneo/muestra/validar/muestra`,
  }, [cards]);

  if (!cfg) return <Card><CardContent className="py-6 text-sm text-muted-foreground">Cargando carnés…</CardContent></Card>;

  const toggleField = (f: CardField) => {
    const on = cfg.fields.includes(f);
    if (!on && cfg.fields.length >= 3) { toast({ title: 'Elige hasta 3 campos' }); return; }
    setCfg({ ...cfg, fields: on ? cfg.fields.filter((x) => x !== f) : [...cfg.fields, f] });
  };
  const save = async () => {
    setBusy(true);
    try { setCfg(await bffClient.put<TournamentCardConfig>(`${base}/card-config`, cfg)); toast({ title: 'Diseño del carné guardado' }); }
    catch (e) { toast({ title: 'No se pudo guardar', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (cards.length === 0) { toast({ title: 'Aún no hay jugadores para imprimir' }); return; }
    setBusy(true);
    try {
      const items = cards.map((c) => ({ data: toCardData(c, cfg, tournament, custom), publicUrl: c.validate_url }));
      const team = teams.find((t) => t.id === teamId)?.name;
      await exportCardsPdf(items, { mode: 'together', cutMarks: true, fileName: `carnes-${(team ?? tournament.title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, onProgress: (d, t) => setProgress(`${d}/${t}`) });
    } catch (e) { toast({ title: 'No se pudo generar el PDF', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); setProgress(null); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-4 w-4" /> Formulario de jugador</CardTitle>
          <p className="text-sm text-muted-foreground">Qué se pide de cada jugador: lo usan el alta, la planilla y el link del delegado.</p></CardHeader>
        <CardContent><PlayerFormEditor eventId={eventId} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><IdCard className="h-4 w-4" /> Carné de jugador</CardTitle>
          <p className="text-sm text-muted-foreground">Cada carné trae un QR que abre la validación en cancha: el árbitro ve si está habilitado.</p></CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="space-y-1.5"><Label htmlFor="card-sub">Subtítulo</Label><Input id="card-sub" maxLength={60} placeholder="Carné de jugador" value={cfg.subtitle ?? ''} onChange={(e) => setCfg({ ...cfg, subtitle: e.target.value || null })} /></div>
            <div className="space-y-1.5"><Label htmlFor="card-color">Color</Label>
              <input id="card-color" type="color" className="h-10 w-20 rounded border" value={cfg.color ?? '#1E40AF'} onChange={(e) => setCfg({ ...cfg, color: e.target.value })} /></div>
            <div className="space-y-1"><p className="text-sm font-medium">Datos en el carné (hasta 3)</p>
              <div className="flex flex-wrap gap-3 text-sm">
                {(Object.keys(CARD_FIELD_LABEL) as CardField[]).map((f) => (
                  <label key={f} className="flex items-center gap-1.5"><input type="checkbox" checked={cfg.fields.includes(f)} onChange={() => toggleField(f)} /> {CARD_FIELD_LABEL[f]}</label>
                ))}
              </div></div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="card-photo" className="text-sm">Mostrar la foto al validar el QR</Label>
              <Switch id="card-photo" checked={cfg.public_photo} onCheckedChange={(v) => setCfg({ ...cfg, public_photo: v })} />
            </div>
            <Button variant="outline" onClick={save} disabled={busy}>Guardar diseño</Button>

            <div className="space-y-2 border-t pt-3">
              <Label htmlFor="card-team">Imprimir carnés de</Label>
              <select id="card-team" className={selectCls} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">Todos los equipos</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <Button onClick={download} disabled={busy}>{progress ? `Generando ${progress}…` : `Descargar PDF (${cards.length})`}</Button>
              <p className="text-xs text-muted-foreground">Tamaño tarjeta (CR80), 9 por hoja con marcas de corte. Si un carné se pierde, «reemitir» desde Jugadores invalida el QR viejo.</p>
            </div>
          </div>
          <div className="mx-auto w-[340px] max-w-full" data-testid="card-preview">
            <AthleteIdCard data={toCardData(sample, cfg, tournament, custom)} publicUrl={sample.validate_url} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
