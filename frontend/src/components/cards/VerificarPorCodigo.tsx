/**
 * «Verificar por código» (spec §5.3, D4): alguien digita el código impreso
 * `SM-AAAA-NNNNN` y la RPC pública verificar_carnet_por_codigo responde solo
 * válido / no válido + nombre enmascarado + club. El nombre completo solo
 * sale por el QR (token).
 */
import { useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, Search, XCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import type { VerificacionPorCodigo } from '@/lib/cards/contratos';
import { cn } from '@/lib/utils';

export const CODIGO_RE = /^SM-\d{4}-\d{5}$/;

/**
 * Lo que la persona digitó → `SM-AAAA-NNNNN`, o null si no se puede armar.
 * Acepta minúsculas, espacios, sin guiones o sin el «SM»: «sm 2026 00012»,
 * «2026-12» (completa con ceros a la izquierda).
 */
export function normalizarCodigo(entrada: string): string | null {
  const limpio = String(entrada ?? '').toUpperCase().replace(/\s+/g, '').replace(/^SM-?/, '');
  const m = limpio.match(/^(\d{4})-?(\d{1,5})$/);
  if (!m) return null;
  const codigo = `SM-${m[1]}-${m[2].padStart(5, '0')}`;
  return CODIGO_RE.test(codigo) ? codigo : null;
}

export type Veredicto = { tono: 'ok' | 'alerta' | 'error'; titulo: string; detalle: string | null };

export function veredictoCodigo(r: VerificacionPorCodigo | null | undefined): Veredicto {
  if (!r) return { tono: 'error', titulo: 'No pudimos verificar el código', detalle: 'Revisa tu conexión e inténtalo de nuevo.' };
  if (!r.found) {
    if (r.motivo === 'formato') return { tono: 'error', titulo: 'Ese código no tiene el formato correcto', detalle: 'Se escribe así: SM-2026-00123.' };
    return { tono: 'error', titulo: 'Ese código no corresponde a ningún carnet', detalle: 'Revisa que esté bien escrito.' };
  }
  const quien = [r.nombre, r.club?.name].filter(Boolean).join(' · ') || null;
  if (r.valido && r.estado === 'active') return { tono: 'ok', titulo: 'Carnet válido', detalle: quien };
  if (r.estado === 'revoked') return { tono: 'alerta', titulo: 'Carnet no válido: fue anulado', detalle: quien };
  if (r.estado === 'expired') return { tono: 'alerta', titulo: 'Carnet no válido: está vencido', detalle: quien };
  return { tono: 'alerta', titulo: 'Carnet no válido', detalle: quien };
}

export function VerificarPorCodigo({ codigoInicial = '', className }: { codigoInicial?: string; className?: string }) {
  const [texto, setTexto] = useState(codigoInicial);
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<{ codigo: string; veredicto: Veredicto; logo: string | null } | null>(null);
  const [errorFormato, setErrorFormato] = useState(false);

  async function verificar(e?: FormEvent) {
    e?.preventDefault();
    const codigo = normalizarCodigo(texto);
    if (!codigo) {
      setErrorFormato(true);
      setResultado(null);
      return;
    }
    setErrorFormato(false);
    setTexto(codigo);
    setCargando(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc('verificar_carnet_por_codigo' as any, { p_codigo: codigo });
      const r = error ? null : (data as VerificacionPorCodigo);
      setResultado({ codigo, veredicto: veredictoCodigo(r), logo: r?.club?.logo_url ?? null });
    } catch {
      setResultado({ codigo, veredicto: veredictoCodigo(null), logo: null });
    } finally {
      setCargando(false);
    }
  }

  const v = resultado?.veredicto;
  const Icono = v?.tono === 'ok' ? CheckCircle2 : v?.tono === 'alerta' ? AlertTriangle : XCircle;

  return (
    <div className={cn('w-full space-y-3', className)}>
      <form onSubmit={verificar} className="space-y-2" noValidate>
        <Label htmlFor="codigo-carnet" className="text-sm font-semibold">Código del carnet</Label>
        <div className="flex gap-2">
          <Input
            id="codigo-carnet"
            value={texto}
            onChange={(e) => { setTexto(e.target.value); setErrorFormato(false); }}
            placeholder="SM-2026-00123"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            aria-invalid={errorFormato}
            aria-describedby="codigo-carnet-ayuda"
            className="h-12 rounded-xl font-mono text-base tracking-wider"
          />
          <Button type="submit" disabled={cargando || texto.trim() === ''} className="h-12 min-h-touch shrink-0 gap-2 rounded-xl px-4">
            {cargando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />}
            Verificar
          </Button>
        </div>
        <p id="codigo-carnet-ayuda" className={cn('text-xs', errorFormato ? 'text-destructive' : 'text-muted-foreground')}>
          {errorFormato ? 'Escríbelo así: SM-2026-00123.' : 'Está impreso en el carnet, debajo del nombre.'}
        </p>
      </form>

      {v && resultado && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-2xl border p-4',
            v.tono === 'ok' && 'border-green-200 bg-green-50 text-green-800',
            v.tono === 'alerta' && 'border-amber-200 bg-amber-50 text-amber-800',
            v.tono === 'error' && 'border-red-200 bg-red-50 text-red-800',
          )}
        >
          {resultado.logo
            ? <img src={resultado.logo} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-white object-contain" />
            : <Icono className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />}
          <div className="min-w-0">
            <p className="font-semibold">{v.titulo}</p>
            {v.detalle && <p className="break-words text-sm">{v.detalle}</p>}
            <p className="mt-1 font-mono text-xs opacity-80">{resultado.codigo}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default VerificarPorCodigo;
