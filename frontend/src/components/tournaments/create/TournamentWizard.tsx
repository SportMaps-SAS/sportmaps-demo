/**
 * Asistente rápido de creación de torneos (estilo Copa Fácil): 4 pasos, una pantalla cada uno,
 * pensado para celular. Sirve al admin de la escuela (complemento Torneos) y al organizador.
 * Crea el torneo en BORRADOR y lleva al detalle; fechas, sede, cobro y equipos (de la escuela o
 * invitados) se completan después.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Check, ChevronRight, Layers, Loader2, Lock, Plus, Trophy, X } from 'lucide-react';
import { TOURNAMENT_SPORTS, WIZARD_FORMATS, presetLabel, type TournamentSport, type WizardFormat } from '@/lib/tournamentSports';
import { useTournamentAccess, type TournamentAccess } from '@/lib/tournaments/tournamentAccess';
import {
  CATEGORY_SUGGESTIONS, createFromWizard, sportsForSchool, validateStep, type WizardAnswers, type WizardKind,
} from './tournamentWizard.logic';

const STEPS = ['Nombre', 'Tipo', 'Deporte', 'Formato'];

interface Props {
  /** Para pruebas / montajes especiales; por defecto se lee con useTournamentAccess(). */
  access?: TournamentAccess;
  onCancel?: () => void;
  /** Deportes de la escuela (texto libre). Por defecto: schools.sports ∪ deporte de sus equipos. */
  schoolSports?: string[];
}

/** schools.sports ∪ teams.sport de la escuela activa (el organizador no tiene escuela: todos los deportes). */
function useSchoolSportTexts(enabled: boolean, override?: string[]): string[] {
  const { schoolId, teams } = useSchoolContext();
  const [schoolSports, setSchoolSports] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || override || !schoolId) return;
    let alive = true;
    void (async () => {
      try {
        const { data } = await supabase.from('schools').select('sports').eq('id', schoolId).maybeSingle();
        if (alive) setSchoolSports(((data as { sports?: string[] | null } | null)?.sports ?? []).filter(Boolean));
      } catch { /* sin deportes conocidos = se muestran todos */ }
    })();
    return () => { alive = false; };
  }, [enabled, override, schoolId]);
  if (override) return override;
  if (!enabled) return [];
  return [...schoolSports, ...(teams ?? []).map((t) => t.sport_type ?? '').filter(Boolean)];
}

export function TournamentWizard({ access: accessProp, onCancel, schoolSports: sportsProp }: Props) {
  const hookAccess = useTournamentAccess();
  const access = accessProp ?? hookAccess;
  const navigate = useNavigate();
  const { toast } = useToast();
  const sportTexts = useSchoolSportTexts(access.actor !== 'organizer', sportsProp);
  const sportGroups = useMemo(() => sportsForSchool(TOURNAMENT_SPORTS, sportTexts), [sportTexts.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showOthers, setShowOthers] = useState(false);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WizardKind | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [catDraft, setCatDraft] = useState('');
  const [sport, setSport] = useState<TournamentSport | null>(null);
  const [preset, setPreset] = useState<string>('');
  const [format, setFormat] = useState<WizardFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Escuela de un solo deporte: queda preseleccionado (se puede cambiar en «Ver otros deportes»).
  useEffect(() => {
    if (sport || sportGroups.others.length === 0 || sportGroups.main.length !== 1) return;
    setSport(sportGroups.main[0]);
    setPreset(sportGroups.main[0].defaultPreset);
  }, [sportGroups, sport]);

  const cancel = () => (onCancel ? onCancel() : navigate(-1));

  if (access.loading) {
    return <div className="flex min-h-[60dvh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!access.allowed) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-10 text-center" data-testid="wizard-locked">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted"><Lock className="h-6 w-6 text-muted-foreground" /></div>
        <h1 className="text-xl font-semibold">Complemento Torneos no activo</h1>
        <p className="text-sm text-muted-foreground">{access.reason}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={cancel}>Volver</Button>
          {access.upgradeHref && <Button onClick={() => navigate(access.upgradeHref as string)}>Ir a Mi Plan</Button>}
        </div>
      </div>
    );
  }

  const answers: Partial<WizardAnswers> = { name, kind: kind ?? undefined, categories, sport: sport ?? undefined, preset, format: format ?? undefined };

  const addCategory = (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setCategories((p) => (p.some((x) => x.toLowerCase() === c.toLowerCase()) ? p : [...p, c]));
    setCatDraft('');
    setError(null);
  };

  const next = async () => {
    // Una categoría escrita sin «Agregar» también cuenta.
    const cats = kind === 'categories' && catDraft.trim() ? [...categories, catDraft.trim()] : categories;
    if (cats !== categories) { setCategories(cats); setCatDraft(''); }
    const err = validateStep(step, { ...answers, categories: cats });
    if (err) { setError(err); return; }
    setError(null);
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    setSaving(true);
    try {
      const out = await createFromWizard(access.actor ?? 'school', { ...(answers as WizardAnswers), categories: cats }, {
        post: (u, b) => bffClient.post(u, b),
        patch: (u, b) => bffClient.patch(u, b),
      });
      for (const w of out.warnings) toast({ title: 'Aviso', description: w });
      toast({ title: '¡Torneo creado!', description: 'Quedó como borrador. Ahora agrega los equipos y las fechas.' });
      navigate(out.href);
    } catch (e) {
      setError((e as Error)?.message || 'No se pudo crear el torneo. Intenta de nuevo.');
    } finally {
      setSaving(false);
    }
  };

  const back = () => { setError(null); if (step === 0) cancel(); else setStep(step - 1); };

  const choice = (selected: boolean) =>
    `flex w-full items-center gap-3 rounded-2xl border-2 p-4 text-left transition-colors touch-manipulation ${selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-md flex-col px-4 pt-3" data-testid="tournament-wizard">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={back} aria-label={step === 0 ? 'Cancelar' : 'Paso anterior'}><ArrowLeft className="h-5 w-5" /></Button>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">Paso {step + 1} de {STEPS.length} · {STEPS[step]}</div>
          <div className="mt-1 flex gap-1" aria-hidden>
            {STEPS.map((s, i) => <div key={s} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`} />)}
          </div>
        </div>
      </div>

      <div className="mt-6 flex-1 space-y-4">
        {step === 0 && (
          <>
            <h1 className="text-2xl font-bold">¿Cómo se llama tu torneo?</h1>
            <Label htmlFor="wz-name" className="sr-only">Nombre del torneo</Label>
            <Input
              id="wz-name" autoFocus value={name} maxLength={120} placeholder="Ej. Copa Alto Nivel 2026"
              onChange={(e) => { setName(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void next(); }}
              className="h-14 text-lg"
            />
            <p className="text-sm text-muted-foreground">Lo puedes cambiar después.</p>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="text-2xl font-bold">¿Qué tipo de torneo es?</h1>
            <button type="button" className={choice(kind === 'single')} onClick={() => { setKind('single'); setError(null); }} aria-pressed={kind === 'single'}>
              <Trophy className="h-7 w-7 shrink-0 text-primary" />
              <span className="flex-1"><span className="block font-semibold">Un solo torneo</span><span className="block text-sm text-muted-foreground">Una sola categoría: todos los equipos compiten juntos.</span></span>
              {kind === 'single' && <Check className="h-5 w-5 text-primary" />}
            </button>
            <button type="button" className={choice(kind === 'categories')} onClick={() => { setKind('categories'); setError(null); }} aria-pressed={kind === 'categories'}>
              <Layers className="h-7 w-7 shrink-0 text-primary" />
              <span className="flex-1"><span className="block font-semibold">Con categorías</span><span className="block text-sm text-muted-foreground">Por edad, rama o deporte, cada una con su tabla.</span></span>
              {kind === 'categories' && <Check className="h-5 w-5 text-primary" />}
            </button>
            {kind === 'categories' && (
              <div className="space-y-3 rounded-2xl border p-3" data-testid="wz-categories">
                <div className="flex gap-2">
                  <Label htmlFor="wz-cat" className="sr-only">Nueva categoría</Label>
                  <Input id="wz-cat" value={catDraft} placeholder="Ej. Sub-14 femenino" onChange={(e) => setCatDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(catDraft); } }} className="h-11" />
                  <Button type="button" variant="outline" className="h-11" onClick={() => addCategory(catDraft)} aria-label="Agregar categoría"><Plus className="h-4 w-4" /></Button>
                </div>
                {categories.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {categories.map((c) => (
                      <span key={c} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-sm">
                        {c}
                        <button type="button" aria-label={`Quitar ${c}`} onClick={() => setCategories((p) => p.filter((x) => x !== c))}><X className="h-3.5 w-3.5" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORY_SUGGESTIONS.filter((s) => !categories.includes(s)).map((s) => (
                    <button key={s} type="button" onClick={() => addCategory(s)} className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted">+ {s}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-2xl font-bold">¿Qué deporte?</h1>
            {(() => {
              const tile = (s: TournamentSport) => (
                <button
                  key={s.key} type="button" role="listitem" aria-pressed={sport?.key === s.key}
                  onClick={() => { setSport(s); setPreset(s.defaultPreset); setError(null); }}
                  className={`flex min-h-[5.5rem] flex-col items-center justify-center gap-1 rounded-2xl border-2 p-2 text-center text-xs font-medium touch-manipulation ${sport?.key === s.key ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                >
                  <span className="text-3xl leading-none" aria-hidden>{s.emoji}</span>
                  <span className="line-clamp-2">{s.name}</span>
                </button>
              );
              const { main, others } = sportGroups;
              // Si eligió uno de los plegados, se muestran para que se vea marcado.
              const open = showOthers || others.some((s) => s.key === sport?.key);
              return (
                <>
                  <div className="grid grid-cols-3 gap-2" role="list" data-testid="wz-sports-main">{main.map(tile)}</div>
                  {others.length > 0 && (
                    <>
                      <Button type="button" variant="ghost" className="w-full" onClick={() => setShowOthers((v) => !v)} aria-expanded={open} data-testid="wz-sports-others-toggle">
                        {open ? 'Ocultar otros deportes' : `Ver otros deportes (${others.length})`}
                      </Button>
                      {open && <div className="grid grid-cols-3 gap-2" role="list" data-testid="wz-sports-others">{others.map(tile)}</div>}
                    </>
                  )}
                </>
              );
            })()}
            {sport && sport.mode === 'versus' && sport.presets.length > 1 && (
              <div className="space-y-2" data-testid="wz-presets">
                <div className="text-sm font-medium">Reglas del marcador</div>
                {sport.presets.map((p) => (
                  <button key={p} type="button" className={choice(preset === p)} onClick={() => setPreset(p)} aria-pressed={preset === p}>
                    <span className="flex-1 text-sm">{presetLabel(p)}</span>
                    {preset === p && <Check className="h-5 w-5 text-primary" />}
                  </button>
                ))}
              </div>
            )}
            {sport && sport.mode === 'versus' && sport.presets.length === 1 && (
              <p className="text-sm text-muted-foreground">Reglas: {presetLabel(sport.defaultPreset)}. Las cambias en «Marcador en vivo».</p>
            )}
            {sport?.mode === 'marks' && (
              <p className="rounded-xl bg-muted p-3 text-sm" data-testid="wz-marks-note">
                Atletismo se juega por pruebas con marcas (tiempo, distancia o altura) y puntos por posición. Crea el torneo y
                carga las pruebas en el detalle.
              </p>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-2xl font-bold">¿Cómo se juega?</h1>
            {WIZARD_FORMATS.map((f) => (
              <button key={f.key} type="button" className={choice(format === f.key)} onClick={() => { setFormat(f.key); setError(null); }} aria-pressed={format === f.key}>
                <span className="flex-1"><span className="block font-semibold">{f.label}</span><span className="block text-sm text-muted-foreground">{f.hint}</span></span>
                {format === f.key && <Check className="h-5 w-5 text-primary" />}
              </button>
            ))}
            <p className="text-sm text-muted-foreground">Puedes cambiarlo después, antes de generar el calendario.</p>
            <p className="text-xs text-muted-foreground">Los equipos los agregas en el siguiente paso: de tu escuela o invitados.</p>
          </>
        )}

        {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>

      {/* Pie fijo OPACO: antes el botón flotaba sobre las tarjetas y tapaba la última fila. Con fondo,
          el contenido pasa por debajo y, al final del scroll, la última fila queda por encima del pie
          (el <main> ya reserva la barra inferior y el safe-area). */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3" data-testid="wz-footer">
        <Button className="h-14 w-full text-base" onClick={() => void next()} disabled={saving} data-testid="wz-next">
          {saving ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Creando…</>
            : step < STEPS.length - 1 ? <>Continuar <ChevronRight className="ml-1 h-5 w-5" /></> : <>Crear torneo</>}
        </Button>
      </div>
    </div>
  );
}

export default TournamentWizard;
