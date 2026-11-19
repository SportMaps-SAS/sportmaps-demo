/**
 * Descuento por hermanos escalonado (F2) — piezas compartidas del alta de menor
 * y de la sección «Familia» de la ficha.
 *
 *   · SiblingDiscountChip: lo que devuelve first-payment-preview en `sibling`
 *     ({ pct, rank, amount }) como chip «Hermanos −10 % (3.º hijo)».
 *   · SiblingChildPicker: buscador de un MENOR ya inscrito en la escuela.
 *     Reutiliza studentsAPI.getSchoolView (la misma vista que lista la página
 *     de estudiantes); no hay endpoint nuevo.
 *
 * El cálculo NO vive aquí: el puesto y el % los decide la base (open_month /
 * get_sibling_family) y el BFF (preview). Esto solo los muestra.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Search, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { studentsAPI } from '@/lib/api/students';
import { formatCOP } from '@/lib/prorationUtils';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';

export interface SiblingPreview {
  pct: number;
  rank: number;
  amount: number;
}

/** Propuesta de hermano que devuelve first-payment-preview (por correo/teléfono del acudiente). */
export interface SiblingSuggestion {
  suggested_child_id: string | null;
  suggested_name: string | null;
  matched_by: Array<'email' | 'phone'>;
  ambiguous: boolean;
  candidates: Array<{ child_id: string; full_name: string; matched_by: Array<'email' | 'phone'> }>;
}

/** «el correo», «el teléfono» o «el correo y el teléfono» del acudiente. */
export function siblingMatchText(by: Array<'email' | 'phone'>): string {
  const parts = [by.includes('email') ? 'el correo' : null, by.includes('phone') ? 'el teléfono' : null].filter(Boolean);
  return parts.join(' y ');
}

/** 2 → «2.º». */
export function siblingOrdinal(n: number): string {
  return `${n}.º`;
}

/** «2.º hijo» / «3.º hijo». */
export function siblingRankLabel(rank: number): string {
  return `${siblingOrdinal(rank)} hijo`;
}

const fmtPct = (pct: number) => `${Number(pct).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;

export function SiblingDiscountChip({ sibling, className = '' }: { sibling: SiblingPreview; className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300 ${className}`}
      data-testid="sibling-discount-chip"
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Users className="h-3.5 w-3.5" />
        Hermanos −{fmtPct(sibling.pct)} ({siblingRankLabel(sibling.rank)})
      </span>
      <span className="font-bold">−{formatCOP(sibling.amount)} / mes</span>
    </div>
  );
}

export interface MinorOption {
  id: string;
  full_name: string;
  parent_name?: string | null;
  team_name?: string | null;
}

/**
 * Menores activos de la escuela (athlete_type 'child'), uno por niño aunque
 * tenga varias inscripciones. Carga una vez por escuela mientras `enabled`.
 */
export function useSchoolMinors(schoolId: string | null | undefined, enabled: boolean) {
  const [minors, setMinors] = useState<MinorOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !schoolId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    studentsAPI.getSchoolView(schoolId, { includeInactive: false })
      .then((rows: any[]) => {
        if (cancelled) return;
        const byId = new Map<string, MinorOption>();
        for (const r of rows ?? []) {
          if (r?.athlete_type && r.athlete_type !== 'child') continue;
          if (!r?.id || byId.has(r.id)) continue;
          byId.set(r.id, {
            id: r.id,
            full_name: r.full_name ?? 'Sin nombre',
            parent_name: r.parent_name ?? r.display_parent_name ?? null,
            team_name: r.team_name ?? null,
          });
        }
        setMinors([...byId.values()].sort((a, b) => a.full_name.localeCompare(b.full_name, 'es')));
      })
      .catch((e: any) => { if (!cancelled) setError(e?.message || 'No se pudo cargar la lista de atletas.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [schoolId, enabled]);

  return { minors, loading, error };
}

interface PickerProps {
  schoolId: string;
  value: string | null;
  onChange: (childId: string | null) => void;
  /** Niños que no se pueden elegir (el mismo atleta, hermanos ya vinculados). */
  excludeIds?: string[];
  enabled?: boolean;
  testIdPrefix?: string;
}

/** Buscador de un menor ya inscrito. Muestra hasta 8 coincidencias. */
export function SiblingChildPicker({ schoolId, value, onChange, excludeIds = [], enabled = true, testIdPrefix = 'sibling-picker' }: PickerProps) {
  const { minors, loading, error } = useSchoolMinors(schoolId, enabled);
  const [q, setQ] = useState('');

  const selected = value ? minors.find(m => m.id === value) ?? null : null;
  const matches = useMemo(() => {
    const term = q.trim().toLocaleLowerCase('es');
    const excluded = new Set(excludeIds);
    return minors
      .filter(m => !excluded.has(m.id))
      .filter(m => !term || m.full_name.toLocaleLowerCase('es').includes(term) || (m.parent_name ?? '').toLocaleLowerCase('es').includes(term))
      .slice(0, 8);
  }, [minors, q, excludeIds]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" data-testid={`${testIdPrefix}-selected`}>
        <span>
          <span className="font-medium">{selected?.full_name ?? 'Atleta seleccionado'}</span>
          {selected?.parent_name && <span className="text-xs text-muted-foreground"> · acudiente {selected.parent_name}</span>}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onChange(null)} aria-label="Quitar hermano">
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Busca al hermano por nombre o por el acudiente"
          value={q}
          onChange={e => setQ(e.target.value)}
          data-testid={`${testIdPrefix}-search`}
        />
      </div>
      {loading && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Cargando atletas…
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!loading && !error && (
        <div className="max-h-48 overflow-y-auto rounded-md border divide-y" data-testid={`${testIdPrefix}-list`}>
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No hay menores inscritos que coincidan.</p>
          ) : matches.map(m => (
            <button
              key={m.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => { onChange(m.id); setQ(''); }}
              data-testid={`${testIdPrefix}-option-${m.id}`}
            >
              <span className="font-medium">{m.full_name}</span>
              {(m.parent_name || m.team_name) && (
                <span className="block text-xs text-muted-foreground">
                  {[m.parent_name ? `Acudiente: ${m.parent_name}` : null, m.team_name].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sección «Familia» de la ficha de un menor ─────────────────────────────────

export interface SiblingFamilyMember {
  child_id: string;
  full_name: string;
  via: 'acudiente' | 'vinculo' | 'self';
  active: boolean;
  rank: number | null;
  since: string | null;
  pct: number | null;
}

export function parseSiblingFamily(data: unknown): SiblingFamilyMember[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r: any) => r && typeof r.child_id === 'string')
    .map((r: any): SiblingFamilyMember => ({
      child_id: r.child_id,
      full_name: r.full_name ?? 'Sin nombre',
      via: r.via === 'acudiente' || r.via === 'vinculo' ? r.via : 'self',
      active: r.active !== false,
      rank: r.rank != null ? Number(r.rank) : null,
      since: r.since ?? null,
      pct: r.pct != null ? Number(r.pct) : null,
    }))
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.full_name.localeCompare(b.full_name, 'es'));
}

/** «2.º hijo · −5 %», «1.º hijo · paga completo», «Inactivo». */
export function siblingRankText(m: SiblingFamilyMember): string {
  if (!m.active) return 'Inactivo';
  if (m.rank == null) return '';
  if (m.rank <= 1) return '1.º hijo · paga completo';
  const pct = m.pct ?? 0;
  return pct > 0 ? `${siblingRankLabel(m.rank)} · −${fmtPct(pct)}` : `${siblingRankLabel(m.rank)} · sin descuento`;
}

/**
 * Lista get_sibling_family + «Vincular hermano» (link_siblings) y «Desvincular»
 * (unlink_sibling, solo filas via='vinculo'). Solo admin/owner: el caller
 * decide si se monta; la base vuelve a exigirlo (42501).
 */
export function SiblingFamilySection({ schoolId, childId }: { schoolId: string; childId: string }) {
  const { toast } = useToast();
  const [family, setFamily] = useState<SiblingFamilyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_sibling_family', { p_school_id: schoolId, p_child_id: childId });
    if (error) {
      toast({ title: 'No se pudo cargar la familia', description: getUserFriendlyError(error), variant: 'destructive' });
      setFamily([]);
    } else {
      setFamily(parseSiblingFamily(data));
    }
    setLoading(false);
  }, [schoolId, childId, toast]);

  useEffect(() => { if (schoolId && childId) load(); }, [schoolId, childId, load]);

  const handleLink = async () => {
    if (!pickedId) return;
    setLinking(true);
    const { error } = await supabase.rpc('link_siblings', { p_school_id: schoolId, p_child_ids: [childId, pickedId] });
    setLinking(false);
    if (error) {
      toast({ title: 'No se pudo vincular', description: getUserFriendlyError(error), variant: 'destructive' });
      return;
    }
    toast({ title: 'Hermanos vinculados', description: 'El descuento se aplica desde el próximo cobro.' });
    setPickedId(null);
    setPickerOpen(false);
    load();
  };

  const handleUnlink = async (m: SiblingFamilyMember) => {
    setUnlinkingId(m.child_id);
    const { data, error } = await supabase.rpc('unlink_sibling', { p_school_id: schoolId, p_child_id: m.child_id });
    setUnlinkingId(null);
    if (error) {
      toast({ title: 'No se pudo desvincular', description: getUserFriendlyError(error), variant: 'destructive' });
      return;
    }
    const removed = (data as { removed?: boolean } | null)?.removed !== false;
    toast(removed
      ? { title: `${m.full_name} quedó desvinculado`, description: 'El cambio se refleja desde el próximo cobro.' }
      : { title: 'No había vínculo que quitar', description: 'Puede que alguien más ya lo haya quitado.' });
    load();
  };

  const excludeIds = [childId, ...family.map(f => f.child_id)];
  const others = family.filter(f => f.via !== 'self');
  const self = family.find(f => f.via === 'self');

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="sibling-family-section">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4 text-muted-foreground" />
        Familia
      </div>
      <p className="text-xs text-muted-foreground">
        Para hermanos cuyo acudiente aún no tiene cuenta. El descuento se aplica desde el próximo cobro.
      </p>

      {loading ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Cargando familia…
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="sibling-family-list">
          {self && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-sm" data-testid={`sibling-family-row-${self.child_id}`}>
              <span><span className="font-medium">{self.full_name}</span> <span className="text-xs text-muted-foreground">(este atleta)</span></span>
              <span className="text-xs text-muted-foreground">{siblingRankText(self)}</span>
            </div>
          )}
          {others.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="sibling-family-empty">No tiene hermanos registrados en esta escuela.</p>
          ) : others.map(m => {
            const rt = siblingRankText(m);
            return (
              <div key={m.child_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm" data-testid={`sibling-family-row-${m.child_id}`}>
                <span className="min-w-0">
                  <span className="font-medium">{m.full_name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {rt}{rt ? ' · ' : ''}{m.via === 'acudiente' ? 'mismo acudiente' : 'vinculado a mano'}
                  </span>
                </span>
                {m.via === 'vinculo' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    disabled={unlinkingId === m.child_id}
                    onClick={() => handleUnlink(m)}
                    data-testid={`sibling-family-unlink-${m.child_id}`}
                  >
                    {unlinkingId === m.child_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Desvincular'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!pickerOpen ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} data-testid="sibling-family-link-open">
          Vincular hermano
        </Button>
      ) : (
        <div className="space-y-2">
          <SiblingChildPicker
            schoolId={schoolId}
            value={pickedId}
            onChange={setPickedId}
            excludeIds={excludeIds}
            testIdPrefix="sibling-family-picker"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={!pickedId || linking} onClick={handleLink} data-testid="sibling-family-link-confirm">
              {linking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Vincular
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setPickerOpen(false); setPickedId(null); }}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
