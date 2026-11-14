import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Copy, Trash2, Link2, AlertCircle, ArrowDown, ArrowUp, Plus } from 'lucide-react';
import type { LiveConfigDto, ScorekeeperCreated, ScorekeeperDto } from '@/lib/tournamentTypes';
import { validateStreamUrl, formatBogota } from '@/lib/tournamentDisplay';
import { resolveConfig, type ScoringConfig, type TiebreakerKey } from '@/lib/tournamentScoring';
import {
  SAME_AS_TOURNAMENT, TIEBREAKER_LABEL, ruleFromConfig, tiebreakersFor, validateRule, withByCategory, type CategoryRuleDraft,
} from '@/lib/tournamentRules';
import { moveItem } from '@/lib/tournamentFormats';

const LIVE_BASE = '/api/v1/tournament-live';
const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Plantilla actualmente guardada: la sugerida si no hay config propia; la que coincida; o «personalizada». */
export function currentPresetKey(cfg: LiveConfigDto): string {
  const { by_category: _byCat, ...saved } = cfg.event.scoring_config ?? {};
  void _byCat;
  if (Object.keys(saved).length === 0) return cfg.suggested_preset;
  // jsonb devuelve las claves en otro orden: se compara con las claves ordenadas, no con JSON.stringify crudo.
  const s = stableStringify(saved);
  const match = cfg.presets.find((p) => stableStringify(p.config) === s);
  if (match) return match.key;
  // Respaldo: la plantilla guardada dice cuál es y su contenido coincide salvo claves nulas/ausentes.
  const named = typeof (saved as { preset?: unknown }).preset === 'string' ? cfg.presets.find((p) => p.key === (saved as { preset: string }).preset) : undefined;
  if (named && stableStringify(dropNulls(named.config)) === stableStringify(dropNulls(saved))) return named.key;
  return '';
}

const dropNulls = (o: unknown): unknown => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined))
  : o);

/** JSON con las claves de los objetos ordenadas (los arreglos conservan su orden). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface SettingsCategory { id: string; name: string }

export function LiveSettingsPanel({ eventId, config, onChanged, categories = [] }: {
  eventId: string; config: LiveConfigDto; onChanged: () => void; categories?: SettingsCategory[];
}) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}`;
  const [preset, setPreset] = useState(currentPresetKey(config));
  const [stream, setStream] = useState(config.event.stream_url ?? '');
  const [busy, setBusy] = useState(false);
  const [keepers, setKeepers] = useState<ScorekeeperDto[]>([]);
  const [label, setLabel] = useState('');
  const [court, setCourt] = useState('');
  const [hours, setHours] = useState('12');
  const [created, setCreated] = useState<ScorekeeperCreated | null>(null);

  const streamError = useMemo(() => validateStreamUrl(stream), [stream]);

  useEffect(() => { setPreset(currentPresetKey(config)); setStream(config.event.stream_url ?? ''); }, [config]);

  const loadKeepers = useCallback(async () => {
    try { setKeepers(await bffClient.get<ScorekeeperDto[]>(`${base}/scorekeepers`)); }
    catch (e) { toast({ title: 'No se pudieron cargar los anotadores', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, toast]);
  useEffect(() => { void loadKeepers(); }, [loadKeepers]);

  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await bffClient.patch(`${base}/config`, body); toast({ title: ok }); onChanged(); }
    catch (e) { toast({ title: 'No se pudo guardar', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const createKeeper = async () => {
    if (!label.trim()) { toast({ title: 'Ponle una etiqueta al enlace (por ejemplo «Mesa cancha 1»)', variant: 'destructive' }); return; }
    setBusy(true);
    try {
      const r = await bffClient.post<ScorekeeperCreated>(`${base}/scorekeepers`, {
        label: label.trim(), ...(court.trim() ? { court: court.trim() } : {}), expires_hours: Number(hours) || 12,
      });
      setCreated(r); setLabel(''); setCourt('');
      await loadKeepers();
    } catch (e) { toast({ title: 'No se pudo crear el enlace', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast({ title: 'Enlace copiado' }); }
    catch { toast({ title: 'No se pudo copiar', description: 'Selecciona el enlace y cópialo a mano.', variant: 'destructive' }); }
  };

  const revoke = async (k: ScorekeeperDto) => {
    try { await bffClient.delete(`${base}/scorekeepers/${k.id}`); toast({ title: 'Enlace revocado' }); await loadKeepers(); }
    catch (e) { toast({ title: 'No se pudo revocar', description: (e as Error).message, variant: 'destructive' }); }
  };

  const keeperState = (k: ScorekeeperDto) => {
    if (k.revoked_at) return { label: 'Revocado', variant: 'outline' as const };
    if (k.expires_at && Date.parse(k.expires_at) < Date.now()) return { label: 'Vencido', variant: 'outline' as const };
    return { label: 'Activo', variant: 'default' as const };
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Ajustes en vivo</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        {config.global_live_disabled && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>El marcador en vivo está apagado temporalmente en toda la plataforma. Podrás cargar resultados finales, pero no anotar en vivo.</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="live-enabled" className="text-sm font-medium">Marcador en vivo</Label>
            <p className="text-xs text-muted-foreground">Apagado: solo se muestra el resultado final de cada partido.</p>
          </div>
          <Switch id="live-enabled" checked={config.event.live_enabled} disabled={busy}
            onCheckedChange={(v) => patch({ live_enabled: v }, v ? 'Marcador en vivo encendido' : 'Marcador en vivo apagado')} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="live-preset">Plantilla de marcador</Label>
          <div className="flex gap-2">
            <select id="live-preset" className={selectCls} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {preset === '' && <option value="">Personalizada</option>}
              {config.presets.map((p) => (
                <option key={p.key} value={p.key}>{p.label}{p.key === config.suggested_preset ? ' (sugerida)' : ''}</option>
              ))}
            </select>
            <Button variant="outline" disabled={busy || preset === '' || preset === currentPresetKey(config)} onClick={() => patch({ preset }, 'Plantilla guardada')}>Guardar</Button>
          </div>
        </div>

        <TiebreakersEditor config={config} busy={busy}
          onSave={(tiebreakers) => patch({ scoring_config: { ...(config.event.scoring_config ?? {}), tiebreakers } }, 'Desempates guardados')} />

        {categories.length > 0 && (
          <CategoryRulesEditor config={config} categories={categories} busy={busy}
            onSave={(scoring_config) => patch({ scoring_config }, 'Reglas por categoría guardadas')} />
        )}

        <div className="space-y-1.5">
          <Label htmlFor="live-stream">Enlace de la transmisión (opcional)</Label>
          <div className="flex gap-2">
            <Input id="live-stream" inputMode="url" placeholder="https://www.youtube.com/watch?v=…" value={stream} onChange={(e) => setStream(e.target.value)} aria-invalid={!!streamError} />
            <Button variant="outline" disabled={busy || !!streamError || stream.trim() === (config.event.stream_url ?? '')}
              onClick={() => patch({ stream_url: stream.trim() === '' ? null : stream.trim() }, 'Enlace guardado')}>Guardar</Button>
          </div>
          {streamError ? <p role="alert" className="text-xs text-destructive">{streamError}</p>
            : <p className="text-xs text-muted-foreground">YouTube, Facebook, Vimeo o Veo (en Veo: Compartir → copiar el enlace del partido en vivo). En la página pública aparece como «Ver transmisión».</p>}
        </div>

        {/* Anotadores sin cuenta */}
        <div className="space-y-3 border-t pt-4">
          <div>
            <h3 className="text-sm font-semibold">Anotadores sin cuenta</h3>
            <p className="text-xs text-muted-foreground">Enlaces para que la mesa anote desde el celular sin iniciar sesión. Se pueden revocar en cualquier momento.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem_auto]">
            <Input aria-label="Etiqueta del enlace" placeholder="Etiqueta (Mesa cancha 1)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Input aria-label="Cancha" placeholder="Cancha (opcional)" value={court} onChange={(e) => setCourt(e.target.value)} />
            <Input aria-label="Horas de vigencia" type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} title="Horas de vigencia" />
            <Button onClick={createKeeper} disabled={busy}><Link2 className="mr-1 h-4 w-4" /> Crear enlace</Button>
          </div>

          {created && (
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3" data-testid="created-link">
              <p className="text-sm font-medium">Copia este enlace ahora: no volverá a mostrarse.</p>
              <div className="flex gap-2">
                <Input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Enlace del anotador" />
                <Button variant="outline" onClick={() => copy(created.url)}><Copy className="mr-1 h-4 w-4" /> Copiar</Button>
              </div>
              <div className="inline-block rounded bg-white p-2"><QRCodeSVG value={created.url} size={144} level="M" /></div>
              <div><Button variant="ghost" size="sm" onClick={() => setCreated(null)}>Ya lo copié</Button></div>
            </div>
          )}

          {keepers.length === 0 ? <p className="text-sm text-muted-foreground">Aún no hay enlaces.</p> : (
            <ul className="space-y-1.5">
              {keepers.map((k) => {
                const st = keeperState(k);
                return (
                  <li key={k.id} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm">
                    <span className="font-medium">{k.label}</span>
                    {k.court && <span className="text-muted-foreground">· {k.court}</span>}
                    <Badge variant={st.variant}>{st.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {k.expires_at ? `vence ${formatBogota(k.expires_at)}` : ''}{k.last_used_at ? ` · usado ${formatBogota(k.last_used_at)}` : ''}
                    </span>
                    {st.label === 'Activo' && (
                      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => revoke(k)} aria-label={`Revocar ${k.label}`}><Trash2 className="mr-1 h-4 w-4" /> Revocar</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Orden de desempates de la tabla (el primero manda). Se ofrecen los que aplican al modelo del torneo. */
export function TiebreakersEditor({ config, busy, onSave }: { config: LiveConfigDto; busy: boolean; onSave: (t: TiebreakerKey[]) => void }) {
  const effective = resolveConfig(config.event.scoring_config as Partial<ScoringConfig> | null);
  const [list, setList] = useState<TiebreakerKey[]>(effective.tiebreakers);
  const [adding, setAdding] = useState<string>('');
  useEffect(() => { setList(resolveConfig(config.event.scoring_config as Partial<ScoringConfig> | null).tiebreakers); }, [config]);
  const options = tiebreakersFor(effective.model).filter((k) => !list.includes(k));
  const dirty = JSON.stringify(list) !== JSON.stringify(effective.tiebreakers);
  return (
    <div className="space-y-2" data-testid="tiebreakers">
      <div>
        <Label className="text-sm font-medium">Desempates de la tabla</Label>
        <p className="text-xs text-muted-foreground">Si dos equipos empatan, se mira el primero; si siguen empatados, el siguiente.</p>
      </div>
      <ol className="space-y-1">
        {list.map((k, i) => (
          <li key={k} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
            <span className="w-5 text-muted-foreground">{i + 1}.</span>
            <span className="flex-1">{TIEBREAKER_LABEL[k] ?? k}</span>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Subir ${TIEBREAKER_LABEL[k]}`} disabled={i === 0} onClick={() => setList(moveItem(list, i, -1))}><ArrowUp className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Bajar ${TIEBREAKER_LABEL[k]}`} disabled={i === list.length - 1} onClick={() => setList(moveItem(list, i, 1))}><ArrowDown className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label={`Quitar ${TIEBREAKER_LABEL[k]}`} disabled={list.length <= 1} onClick={() => setList(list.filter((x) => x !== k))}><Trash2 className="h-4 w-4" /></Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {options.length > 0 && (
          <div className="flex gap-2">
            <select aria-label="Agregar desempate" className={selectCls + ' w-56'} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Agregar desempate…</option>
              {options.map((k) => <option key={k} value={k}>{TIEBREAKER_LABEL[k]}</option>)}
            </select>
            <Button type="button" variant="outline" aria-label="Agregar" disabled={!adding} onClick={() => { setList([...list, adding as TiebreakerKey]); setAdding(''); }}><Plus className="h-4 w-4" /></Button>
          </div>
        )}
        <Button variant="outline" disabled={busy || !dirty} onClick={() => onSave(list)}>Guardar desempates</Button>
      </div>
    </div>
  );
}

/** Cada categoría puede tener su plantilla y sus sets (p. ej. Mini a 1 set de 15). */
export function CategoryRulesEditor({ config, categories, busy, onSave }: {
  config: LiveConfigDto; categories: SettingsCategory[]; busy: boolean; onSave: (c: Partial<ScoringConfig>) => void;
}) {
  const saved = (config.event.scoring_config ?? null) as Partial<ScoringConfig> | null;
  const catKey = categories.map((c) => c.id).join(',');
  const build = useCallback(() => Object.fromEntries(categories.map((c) => [
    c.id, ruleFromConfig(saved?.by_category?.[c.id] as Partial<ScoringConfig> | undefined, config.presets),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ])), [config, catKey]);
  const [drafts, setDrafts] = useState<Record<string, CategoryRuleDraft>>(build);
  useEffect(() => { setDrafts(build()); }, [build]);
  const set = (id: string, p: Partial<CategoryRuleDraft>) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? SAME_AS_TOURNAMENT), ...p } }));
  const errors = Object.values(drafts).map(validateRule).filter(Boolean) as string[];
  const next = withByCategory(saved, drafts, config.presets);
  const dirty = JSON.stringify(next.by_category ?? {}) !== JSON.stringify(saved?.by_category ?? {});
  const num = (v: number | null, onChange: (n: number | null) => void, label: string, placeholder: string) => (
    <Input type="number" min={1} aria-label={label} placeholder={placeholder} className="h-9 w-20" value={v ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
  );
  return (
    <div className="space-y-2 border-t pt-4" data-testid="category-rules">
      <div>
        <h3 className="text-sm font-semibold">Reglas por categoría</h3>
        <p className="text-xs text-muted-foreground">Deja «Igual que el torneo» o elige otra plantilla. En sets puedes cambiar cuántos y a cuántos puntos (ej. Mini a 1 set de 15).</p>
      </div>
      <ul className="space-y-2">
        {categories.map((c) => {
          const d = drafts[c.id] ?? SAME_AS_TOURNAMENT;
          const entry = withByCategory(saved, { [c.id]: d }, config.presets).by_category?.[c.id];
          const eff = resolveConfig({ ...(saved ?? {}), by_category: entry ? { [c.id]: entry } : undefined } as Partial<ScoringConfig>, c.id);
          return (
            <li key={c.id} className="space-y-2 rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-[8rem] flex-1 text-sm font-medium">{c.name}</span>
                <select aria-label={`Plantilla de ${c.name}`} className={selectCls + ' sm:w-64'} value={d.preset} onChange={(e) => set(c.id, { preset: e.target.value })}>
                  <option value="">Igual que el torneo</option>
                  {d.preset === 'personalizada' && <option value="personalizada">Personalizada</option>}
                  {config.presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              {eff.model === 'sets' && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Sets</span>{num(d.best_of, (n) => set(c.id, { best_of: n }), `Sets de ${c.name}`, String(eff.best_of))}
                  <span>a</span>{num(d.set_points, (n) => set(c.id, { set_points: n }), `Puntos por set de ${c.name}`, String(eff.set_points))}
                  <span>puntos · decisivo a</span>{num(d.deciding_set_points, (n) => set(c.id, { deciding_set_points: n }), `Puntos del set decisivo de ${c.name}`, String(eff.deciding_set_points))}
                </div>
              )}
              <p className="text-xs text-muted-foreground" data-testid={`rule-summary-${c.id}`}>
                {eff.model === 'sets'
                  ? `Al mejor de ${eff.best_of} set${eff.best_of === 1 ? '' : 's'} a ${eff.set_points}${eff.best_of > 1 ? ` (decisivo a ${eff.deciding_set_points})` : ''}`
                  : 'Por goles'}
              </p>
            </li>
          );
        })}
      </ul>
      {errors.length > 0 && <p role="alert" className="text-xs text-destructive">{errors[0]}</p>}
      <Button variant="outline" disabled={busy || !dirty || errors.length > 0} onClick={() => onSave(next)}>Guardar reglas por categoría</Button>
    </div>
  );
}
