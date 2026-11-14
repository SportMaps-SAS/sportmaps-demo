import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImageUpload } from '@/components/common/ImageUpload';
import { ArrowDown, ArrowUp, Handshake, Plus, Trash2 } from 'lucide-react';
import type { SponsorDto, SponsorTier } from '@/lib/tournamentTypes';
import { LIVE_BASE } from './FixtureGeneratorDialog';

const selectCls = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const TIER_LABEL: Record<SponsorTier, string> = { principal: 'Principal', oficial: 'Oficial', aliado: 'Aliado' };

/** Valida el enlace del patrocinador antes de enviarlo (el BFF exige https). */
export function sponsorUrlError(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try { return new URL(v).protocol === 'https:' ? null : 'El enlace debe empezar por https://'; }
  catch { return 'El enlace no es válido'; }
}

/** Patrocinadores del torneo: aparecen en la página pública, ordenados por categoría (principal → aliado). */
export function TournamentSponsorsPanel({ eventId, schoolId }: { eventId: string; schoolId: string | null }) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}/sponsors`;
  const [list, setList] = useState<SponsorDto[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [tier, setTier] = useState<SponsorTier>('aliado');
  const [logo, setLogo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploadPath = schoolId ? `logos/${schoolId}/torneos/${eventId}/patrocinadores` : undefined;
  const urlErr = sponsorUrlError(url);

  const load = useCallback(async () => {
    try { setList(await bffClient.get<SponsorDto[]>(base)); }
    catch (e) { toast({ title: 'No se pudieron cargar los patrocinadores', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, toast]);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!name.trim()) { toast({ title: 'Escribe el nombre del patrocinador', variant: 'destructive' }); return; }
    if (urlErr) return;
    setBusy(true);
    try {
      await bffClient.post(base, { name: name.trim(), tier, url: url.trim() || null, logo_url: logo });
      setName(''); setUrl(''); setLogo(null); setTier('aliado');
      toast({ title: 'Patrocinador agregado' });
      await load();
    } catch (e) { toast({ title: 'No se pudo agregar', description: (e as Error).message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const patch = async (s: SponsorDto, body: Partial<SponsorDto>) => {
    try { await bffClient.patch(`${base}/${s.id}`, body); await load(); }
    catch (e) { toast({ title: 'No se pudo guardar', description: (e as Error).message, variant: 'destructive' }); }
  };

  /** Intercambia el orden con el vecino dentro de la misma categoría. */
  const move = async (i: number, delta: -1 | 1) => {
    const a = list[i], b = list[i + delta];
    if (!a || !b || a.tier !== b.tier) return;
    const oa = a.sort_order ?? i, ob = b.sort_order ?? i + delta;
    await Promise.all([
      bffClient.patch(`${base}/${a.id}`, { sort_order: ob === oa ? oa + delta : ob }),
      bffClient.patch(`${base}/${b.id}`, { sort_order: oa }),
    ]).catch((e) => toast({ title: 'No se pudo reordenar', description: (e as Error).message, variant: 'destructive' }));
    await load();
  };

  const remove = async (s: SponsorDto) => {
    if (!window.confirm(`¿Quitar a «${s.name}»?`)) return;
    try { await bffClient.delete(`${base}/${s.id}`); await load(); }
    catch (e) { toast({ title: 'No se pudo quitar', description: (e as Error).message, variant: 'destructive' }); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Handshake className="h-4 w-4" /> Patrocinadores</CardTitle>
        <p className="text-sm text-muted-foreground">Salen en la página en vivo del torneo. Los principales van primero y más grandes.</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.length === 0 ? <p className="text-sm text-muted-foreground">Aún no hay patrocinadores.</p> : (
          <ul className="divide-y rounded-md border">
            {list.map((s, i) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-2 py-2 text-sm">
                {s.logo_url ? <img src={s.logo_url} alt="" className="h-9 w-9 shrink-0 rounded border object-contain" /> : <span className="h-9 w-9 shrink-0 rounded border bg-muted" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.name}</p>
                  {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-xs text-muted-foreground underline">{s.url}</a>}
                </div>
                <select aria-label={`Categoría de ${s.name}`} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-0 text-sm leading-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-32" value={s.tier} onChange={(e) => patch(s, { tier: e.target.value as SponsorTier })}>
                  {(Object.keys(TIER_LABEL) as SponsorTier[]).map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                </select>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Subir ${s.name}`} disabled={i === 0 || list[i - 1].tier !== s.tier} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Bajar ${s.name}`} disabled={i === list.length - 1 || list[i + 1].tier !== s.tier} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Quitar ${s.name}`} onClick={() => remove(s)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">Agregar patrocinador</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1"><Label htmlFor="sp-name">Nombre</Label><Input id="sp-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bebidas El Nevado" /></div>
            <div className="space-y-1"><Label htmlFor="sp-tier">Categoría</Label>
              <select id="sp-tier" className={selectCls} value={tier} onChange={(e) => setTier(e.target.value as SponsorTier)}>
                {(Object.keys(TIER_LABEL) as SponsorTier[]).map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select></div>
          </div>
          <div className="space-y-1"><Label htmlFor="sp-url">Sitio web o red social (opcional)</Label>
            <Input id="sp-url" inputMode="url" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://instagram.com/…" aria-invalid={!!urlErr} />
            {urlErr && <p role="alert" className="text-xs text-destructive">{urlErr}</p>}</div>
          <div className="space-y-1"><Label>Logo (opcional)</Label>
            {uploadPath ? <ImageUpload compact value={logo} path={uploadPath} onChange={setLogo} onRemove={() => setLogo(null)} />
              : <p className="text-xs text-muted-foreground">No se pudo resolver la escuela para subir el logo.</p>}
          </div>
          <Button onClick={add} disabled={busy || !!urlErr}><Plus className="mr-1 h-4 w-4" /> {busy ? 'Agregando…' : 'Agregar'}</Button>
          {list.length > 0 && <p className="text-xs text-muted-foreground"><Badge variant="outline" className="mr-1">{list.length}</Badge>de 30 posibles.</p>}
        </div>
      </CardContent>
    </Card>
  );
}
