import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, CheckCircle2, FileText, ImagePlus, Shield, Trash2, Upload } from 'lucide-react';
import { RosterImporter } from '@/components/tournaments/RosterImporter';
import { comprimirParaSubir } from '@/lib/imageCompression';
import { draftToBody, type PlayerDraft, type PlayerDto, type PlayerForm } from '@/lib/tournamentPlayers';
import { useNoIndex } from '@/hooks/usePublicLive';

interface InviteHome {
  tournament: { title: string; sport: string | null; slug: string; event_date: string | null; logo_url: string | null; rules_url: string | null; attachments: Array<{ name: string; url: string }> };
  team: { id: string; name: string; logo_url: string | null; short_name: string | null; colors: { primary?: string; secondary?: string } | null };
  category: { name: string; age_min: number | null; age_max: number | null } | null;
  form: PlayerForm;
  players: PlayerDto[];
  invite: { payment_status: 'not_required' | 'pending' | 'proof_sent' | 'paid'; payment_amount: number | null; roster_target: number | null; completed_at: string | null; has_payment_proof: boolean };
  consent: { version: string; text: string };
}

const MESSAGES: Record<string, string> = {
  link_vencido: 'Este link venció. Pídele uno nuevo al organizador del torneo.',
  link_revocado: 'El organizador desactivó este link. Pídele uno nuevo.',
  link_invalido: 'Este link no es válido. Revisa que lo hayas copiado completo.',
};
const money = (n: number | null) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n ?? 0);

/** Inscripción del equipo por link, SIN cuenta: logo y colores, nómina, reglamento, datos y pago. */
export default function TournamentTeamInvitePage() {
  const { token } = useParams<{ token: string }>();
  useNoIndex();
  const base = `/api/v1/tournament-live/invite/${encodeURIComponent(token ?? '')}`;
  const [home, setHome] = useState<InviteHome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [primary, setPrimary] = useState('#1E40AF');
  const [secondary, setSecondary] = useState('#FFFFFF');
  const [shortName, setShortName] = useState('');
  const [rules, setRules] = useState(false);
  const [consent, setConsent] = useState(false);
  const [wantsApp, setWantsApp] = useState(false);
  const [proofPath, setProofPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ prefill: Record<string, string | null> | null } | null>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const proofRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const h = await bffClient.get<InviteHome>(base, undefined, 'public');
      setHome(h); setProblem(null);
      setPrimary(h.team.colors?.primary ?? '#1E40AF'); setSecondary(h.team.colors?.secondary ?? '#FFFFFF'); setShortName(h.team.short_name ?? '');
    } catch (e) {
      const err = e as { status?: number; body?: { code?: string } | null };
      setProblem(MESSAGES[err.body?.code ?? ''] ?? (err.status && err.status < 500 ? MESSAGES.link_invalido : 'No pudimos cargar la inscripción. Revisa tu señal e intenta de nuevo.'));
    }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const upload = async (kind: 'logo' | 'proof', file: File) => {
    const f = kind === 'logo' ? await comprimirParaSubir(file, 'logo') : (file.type === 'application/pdf' ? file : await comprimirParaSubir(file, 'documento'));
    const up = await bffClient.post<{ bucket: string; path: string; token: string; public_url: string | null }>(`${base}/upload-url`, { kind, mime: f.type || 'image/jpeg' }, undefined, 'public');
    const { error } = await supabase.storage.from(up.bucket).uploadToSignedUrl(up.path, up.token, f);
    if (error) throw new Error('No se pudo subir el archivo');
    return up;
  };

  const saveTeam = async (logoFile?: File) => {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { colors: { primary, secondary }, short_name: shortName || null };
      if (logoFile) body.logo_url = (await upload('logo', logoFile)).public_url;
      await bffClient.patch(`${base}/team`, body, undefined, 'public');
      await load(); setMsg('Equipo guardado');
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const savePlayers = async (drafts: PlayerDraft[]) => {
    await bffClient.post(`${base}/players`, { players: drafts.map(draftToBody) }, undefined, 'public');
    await load();
  };
  const removePlayer = async (p: PlayerDto) => {
    if (!window.confirm(`¿Quitar a ${p.full_name}?`)) return;
    await bffClient.delete(`${base}/players/${p.id}`, undefined, 'public'); await load();
  };
  const readPhoto = (b64: string, mime: string) => bffClient.post<{ players: Array<{ full_name: string }> }>(`${base}/roster-photo`, { image_base64: b64, mime }, undefined, 'public');

  const sendProof = async (file: File) => {
    setBusy(true); setMsg(null);
    try { setProofPath((await upload('proof', file)).path); setMsg('Comprobante listo: se envía con la inscripción.'); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!home) return;
    setBusy(true); setMsg(null);
    try {
      const r = await bffClient.post<{ signup_prefill: Record<string, string | null> | null }>(`${base}/submit`, {
        rules_accepted: rules, consent, consent_version: home.consent.version, payment_proof_path: proofPath, wants_sportmaps: wantsApp,
      }, undefined, 'public');
      setDone({ prefill: r.signup_prefill });
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (problem) return (
    <div className="mx-auto max-w-md px-4 py-10"><Card><CardContent className="flex flex-col items-center gap-3 py-10 text-center">
      <AlertCircle className="h-10 w-10 text-muted-foreground" /><p className="font-medium">{problem}</p>
    </CardContent></Card></div>
  );
  if (!home) return <div className="mx-auto max-w-md px-4 py-10 text-center text-sm text-muted-foreground">Cargando…</div>;

  if (done) {
    const p = done.prefill;
    const signup = `/register?role=school${p?.email ? `&email=${encodeURIComponent(p.email)}` : ''}${p?.club_name ? `&school_name=${encodeURIComponent(p.club_name)}` : ''}&ref=torneo`;
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-10">
        <Card><CardContent className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle2 className="h-12 w-12 text-green-600" />
          <p className="text-lg font-semibold">¡{home.team.name} quedó inscrito!</p>
          <p className="text-sm text-muted-foreground">El organizador de «{home.tournament.title}» ya ve tu nómina. Cada jugador tendrá su carné con QR.</p>
          {home.invite.payment_status !== 'not_required' && home.invite.payment_status !== 'paid' && <p className="text-sm">El organizador confirmará tu pago.</p>}
        </CardContent></Card>
        <Card className="border-primary/40"><CardContent className="space-y-3 py-6 text-center">
          <p className="font-semibold">¿Quieres manejar tu club en SportMaps?</p>
          <p className="text-sm text-muted-foreground">Asistencia, cobros, carnés y torneos en un solo lugar. Prueba gratis con los datos que ya cargaste.</p>
          <Button asChild><a href={signup}>Prueba gratis</a></Button>
        </CardContent></Card>
      </div>
    );
  }

  const needsPay = home.invite.payment_status === 'pending' || home.invite.payment_status === 'proof_sent';
  const cat = home.category;
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 pt-6 pb-[calc(7rem+env(safe-area-inset-bottom))]" data-testid="invite-form">
      <div className="flex items-center gap-3">
        {home.tournament.logo_url ? <img src={home.tournament.logo_url} alt="" className="h-12 w-12 rounded-full border object-cover" /> : <Shield className="h-10 w-10 text-primary" />}
        <div>
          <h1 className="text-xl font-bold">{home.tournament.title}</h1>
          <p className="text-sm text-muted-foreground">Inscripción de <strong>{home.team.name}</strong>{cat ? ` · ${cat.name}` : ''}{cat?.age_min != null || cat?.age_max != null ? ` (edades ${cat?.age_min ?? '—'} a ${cat?.age_max ?? '—'})` : ''}</p>
        </div>
      </div>
      {home.invite.completed_at && <p className="rounded bg-green-50 p-2 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-300">Ya enviaste la inscripción. Puedes corregir la nómina hasta que empiece el torneo.</p>}

      <Card>
        <CardHeader><CardTitle className="text-base">1. Tu equipo</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            {home.team.logo_url ? <img src={home.team.logo_url} alt="Logo del equipo" className="h-16 w-16 rounded-full border object-cover" />
              : <span className="flex h-16 w-16 items-center justify-center rounded-full border bg-muted"><ImagePlus className="h-6 w-6 text-muted-foreground" /></span>}
            <Button variant="outline" disabled={busy} onClick={() => logoRef.current?.click()}><Upload className="mr-1 h-4 w-4" /> Subir logo</Button>
            <input ref={logoRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Logo del equipo" onChange={(e) => { const f = e.target.files?.[0]; if (f) void saveTeam(f); e.target.value = ''; }} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="c1">Color principal</Label><input id="c1" type="color" className="h-10 w-16 rounded border" value={primary} onChange={(e) => setPrimary(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="c2">Color secundario</Label><input id="c2" type="color" className="h-10 w-16 rounded border" value={secondary} onChange={(e) => setSecondary(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="sigla">Sigla</Label><Input id="sigla" className="w-20" maxLength={4} value={shortName} onChange={(e) => setShortName(e.target.value.toUpperCase())} /></div>
            <Button variant="outline" disabled={busy} onClick={() => saveTeam()}>Guardar</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">2. Nómina · Total: {home.players.length}{home.invite.roster_target ? ` de ${home.invite.roster_target}` : ''}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {home.players.length > 0 && (
            <ul className="divide-y rounded border text-sm" data-testid="invite-players">
              {home.players.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="w-8 text-muted-foreground">{p.shirt_number ?? ''}</span>
                  <span className="flex-1">{p.full_name}</span>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Quitar a ${p.full_name}`} onClick={() => removePlayer(p)}><Trash2 className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
          <RosterImporter form={home.form} onSave={savePlayers} readPhoto={readPhoto} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">3. Reglamento</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {[...(home.tournament.rules_url ? [{ name: 'Reglamento del torneo', url: home.tournament.rules_url }] : []), ...home.tournament.attachments].map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-primary underline"><FileText className="h-4 w-4" /> {a.name}</a>
          ))}
          <label className="flex items-start gap-2"><input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} className="mt-1" /> Leí y acepto el reglamento del torneo.</label>
        </CardContent>
      </Card>

      {needsPay && (
        <Card>
          <CardHeader><CardTitle className="text-base">4. Pago por transferencia · {money(home.invite.payment_amount)}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">Haz la transferencia con los datos que te dio el organizador y sube aquí el comprobante (foto o PDF).</p>
            <Button variant="outline" disabled={busy} onClick={() => proofRef.current?.click()}><Upload className="mr-1 h-4 w-4" /> {proofPath || home.invite.has_payment_proof ? 'Cambiar comprobante' : 'Subir comprobante'}</Button>
            <input ref={proofRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden" aria-label="Comprobante de pago" onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendProof(f); e.target.value = ''; }} />
            {proofPath && <p className="text-green-700 dark:text-green-300">Comprobante cargado. Termina abajo con «{home.invite.completed_at ? 'Actualizar inscripción' : 'Enviar inscripción'}».</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{needsPay ? '5' : '4'}. Tus datos</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" aria-label="Autorizo el tratamiento de datos" /> <span>{home.consent.text}</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={wantsApp} onChange={(e) => setWantsApp(e.target.checked)} className="mt-1" /> Quiero que SportMaps me cuente cómo manejar mi club (opcional).</label>
        </CardContent>
      </Card>

      {msg && <p role="status" className="text-sm">{msg}</p>}
      <Button className="w-full" size="lg" disabled={busy || !rules || !consent || home.players.length === 0} onClick={submit}>
        {busy ? 'Enviando…' : home.invite.completed_at ? 'Actualizar inscripción' : 'Enviar inscripción'}
      </Button>
      {(!rules || !consent || home.players.length === 0) && (
        <p className="text-center text-xs text-muted-foreground">Para enviar: al menos un jugador, aceptar el reglamento y autorizar el tratamiento de datos.</p>
      )}
    </div>
  );
}
