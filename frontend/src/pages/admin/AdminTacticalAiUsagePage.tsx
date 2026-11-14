/**
 * «Uso de IA de pizarra» — super admin (Gestión Global).
 *
 * Spec docs/specs/pizarra-multideporte-3d-ia.md §6 (2026-10-14): la IA se lanzó
 * para el coach limitada por costo real, sin precio. Este panel es el dato para
 * fijar el precio después: por mes, por escuela y por coach (análisis, caché,
 * tokens, costo real en USD, % del presupuesto, quién topó), totales y costo
 * medio por deporte, y «Dar más cupo» (grant en USD a un coach o a la escuela).
 *
 * BFF: GET/POST /api/v1/admin/tactical-ai/{usage,grant} (solo super_admin).
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Gift, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { AI_METER_UNIT, AI_RECHARGE_STEP, rechargeLabel, rechargeUsdFor } from '@/lib/school/tacticalAi';

export interface AiCoachRow {
  user_id: string; name: string; analyses: number; cache_hits: number; tokens_in: number; tokens_out: number;
  cost_usd: number; budget_usd: number; pct: number; hit_limit: boolean; needs_more_count: number;
}
export interface AiSchoolRow {
  school_id: string; name: string; analyses: number; cache_hits: number; tokens_in: number; tokens_out: number;
  cost_usd: number; ceiling_usd: number; pct: number; hit_limit: boolean; coaches_at_limit: number; coaches: AiCoachRow[];
  /** Cupo ampliado temporal vigente (×N). */
  quota_multiplier?: number;
}
export interface AiSportRow { sport: string; label: string; analyses: number; cache_hits: number; cost_usd: number; avg_cost_usd: number | null }
export interface AiUsageReport {
  period: string;
  totals: { analyses: number; cache_hits: number; tokens_in: number; tokens_out: number; cost_usd: number; schools: number; coaches: number; coaches_at_limit: number };
  by_sport: AiSportRow[];
  schools: AiSchoolRow[];
  truncated_runs?: boolean;
}

const usd = (n: number, digits = 2) => `US$ ${n.toLocaleString('es-CO', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const int = (n: number) => n.toLocaleString('es-CO');
const pctText = (n: number) => `${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;

function currentPeriod(): string {
  const d = new Date(Date.now() - 5 * 3600 * 1000); // hora de Bogotá
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface GrantTarget { schoolId: string; schoolName: string; userId: string | null; userName: string | null }

/** Recargas que se ofrecen al coach, en la moneda de su medidor («+50 % de IA»). */
const RECHARGE_PRESETS = [AI_RECHARGE_STEP[AI_METER_UNIT], AI_RECHARGE_STEP[AI_METER_UNIT] * 2].map((amount) => ({
  label: rechargeLabel(AI_METER_UNIT, amount),
  usd: rechargeUsdFor({ unit: AI_METER_UNIT, amount }),
}));

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function AdminTacticalAiUsagePage() {
  const { toast } = useToast();
  const [period, setPeriod] = useState(currentPeriod);
  const [data, setData] = useState<AiUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<GrantTarget | null>(null);
  const [amount, setAmount] = useState('1');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await bffClient.get<AiUsageReport>(`/api/v1/admin/tactical-ai/usage?period=${encodeURIComponent(period)}`));
    } catch (err) {
      setData(null);
      setError(err instanceof BFFError ? ((err.body as { error?: string })?.error ?? err.message) : 'No se pudo cargar el uso de IA.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  const openGrant = (t: GrantTarget) => { setGrant(t); setAmount('1'); setNote(''); };

  const submitGrant = async () => {
    if (!grant) return;
    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0.01 || value > 1000) {
      toast({ title: 'Monto inválido', description: 'Entre US$ 0,01 y US$ 1.000.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await bffClient.post('/api/v1/admin/tactical-ai/grant', {
        school_id: grant.schoolId, user_id: grant.userId, amount_usd: value, note: note.trim() || undefined,
      });
      toast({ title: 'Cupo dado', description: `${usd(value)} para ${grant.userName ?? grant.schoolName} este mes.` });
      setGrant(null);
      void load();
    } catch (err) {
      const msg = err instanceof BFFError ? ((err.body as { error?: string })?.error ?? err.message) : 'No se pudo dar el cupo.';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const t = data?.totals;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Sparkles className="h-6 w-6 text-violet-500" /> Uso de IA de pizarra</h1>
          <p className="text-sm text-muted-foreground">
            Costo real por escuela y entrenador. Cupo: US$ 1 por entrenador al mes; techo de la escuela: 10 × eso. Con esto se fija el precio.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="ai-period">Mes</Label>
            <Input id="ai-period" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-40" />
          </div>
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label="Recargar"><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </header>

      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>}
      {error && !loading && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">{error}</div>}

      {data && t && !loading && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Totales del mes">
            <Kpi label="Costo real" value={usd(t.cost_usd)} hint={`${t.schools} escuelas · ${t.coaches} entrenadores`} />
            <Kpi label="Análisis" value={int(t.analyses)} hint={`${int(t.cache_hits)} desde caché (US$ 0)`} />
            <Kpi label="Tokens entrada" value={int(t.tokens_in)} />
            <Kpi label="Tokens salida" value={int(t.tokens_out)} />
            <Kpi label="Toparon el límite" value={int(t.coaches_at_limit)} hint="entrenadores" />
          </section>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Por deporte</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deporte</TableHead>
                    <TableHead className="text-right">Análisis</TableHead>
                    <TableHead className="text-right">Caché</TableHead>
                    <TableHead className="text-right">Costo</TableHead>
                    <TableHead className="text-right">Costo medio</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_sport.map((s) => (
                    <TableRow key={s.sport} data-testid={`ai-sport-${s.sport}`}>
                      <TableCell className="font-medium capitalize">{s.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{int(s.analyses)}</TableCell>
                      <TableCell className="text-right tabular-nums">{int(s.cache_hits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(s.cost_usd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.avg_cost_usd == null ? '—' : usd(s.avg_cost_usd, 3)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Por escuela y entrenador</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              {data.schools.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nadie usó la IA de la pizarra este mes.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Escuela / entrenador</TableHead>
                      <TableHead className="text-right">Análisis</TableHead>
                      <TableHead className="text-right">Caché</TableHead>
                      <TableHead className="text-right">Tokens ent. / sal.</TableHead>
                      <TableHead className="text-right">Costo</TableHead>
                      <TableHead className="text-right">% del cupo</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.schools.map((s) => (
                      <Fragment key={s.school_id}>
                        <TableRow className="bg-muted/40" data-testid={`ai-school-${s.school_id}`}>
                          <TableCell className="font-semibold">
                            {s.name}
                            {s.hit_limit && <Badge variant="destructive" className="ml-2">Topó el techo</Badge>}
                            {s.quota_multiplier && s.quota_multiplier !== 1 && (
                              <Badge variant="secondary" className="ml-2 bg-violet-100 text-violet-900">Cupo ×{String(s.quota_multiplier).replace('.', ',')} temporal</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{int(s.analyses)}</TableCell>
                          <TableCell className="text-right tabular-nums">{int(s.cache_hits)}</TableCell>
                          <TableCell className="text-right tabular-nums">{int(s.tokens_in)} / {int(s.tokens_out)}</TableCell>
                          <TableCell className="text-right tabular-nums">{usd(s.cost_usd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{pctText(s.pct)} de {usd(s.ceiling_usd, 0)}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" className="gap-1"
                              onClick={() => openGrant({ schoolId: s.school_id, schoolName: s.name, userId: null, userName: null })}>
                              <Gift className="h-3.5 w-3.5" /> Dar más cupo
                            </Button>
                          </TableCell>
                        </TableRow>
                        {s.coaches.map((c) => (
                          <TableRow key={`${s.school_id}-${c.user_id}`} data-testid={`ai-coach-${c.user_id}`}>
                            <TableCell className="pl-8">
                              {c.name}
                              {c.hit_limit && <Badge variant="secondary" className="ml-2 bg-amber-100 text-amber-900">Topó ({c.needs_more_count})</Badge>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{int(c.analyses)}</TableCell>
                            <TableCell className="text-right tabular-nums">{int(c.cache_hits)}</TableCell>
                            <TableCell className="text-right tabular-nums">{int(c.tokens_in)} / {int(c.tokens_out)}</TableCell>
                            <TableCell className="text-right tabular-nums">{usd(c.cost_usd)}</TableCell>
                            <TableCell className="text-right tabular-nums">{pctText(c.pct)} de {usd(c.budget_usd)}</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="ghost" className="gap-1"
                                onClick={() => openGrant({ schoolId: s.school_id, schoolName: s.name, userId: c.user_id, userName: c.name })}>
                                <Gift className="h-3.5 w-3.5" /> Dar más cupo
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              )}
              {data.truncated_runs && <p className="mt-2 text-xs text-muted-foreground">Más de 20.000 intentos este mes: el costo medio por deporte es parcial.</p>}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={!!grant} onOpenChange={(o) => { if (!o) setGrant(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dar más cupo de IA</DialogTitle>
            <DialogDescription>
              {grant?.userId
                ? `A ${grant.userName} en ${grant.schoolName}, solo este mes. También sube el techo de la escuela por el mismo monto.`
                : `Sube el techo mensual de ${grant?.schoolName} (no le da más a un entrenador en particular).`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {grant?.userId && (
              <div className="space-y-1">
                <Label>Recarga que pidió el entrenador</Label>
                <div className="flex flex-wrap gap-2">
                  {RECHARGE_PRESETS.map((r) => (
                    <Button key={r.label} type="button" size="sm" variant="outline"
                      onClick={() => { setAmount(String(r.usd)); setNote((n) => n || `Recarga ${r.label}`); }}>
                      {r.label} ({usd(r.usd)})
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="ai-grant-amount">Monto (USD)</Label>
              <Input id="ai-grant-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-grant-note">Nota (opcional)</Label>
              <Input id="ai-grant-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: piloto, pidió por WhatsApp" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGrant(null)}>Cancelar</Button>
            <Button onClick={() => void submitGrant()} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Dar cupo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
