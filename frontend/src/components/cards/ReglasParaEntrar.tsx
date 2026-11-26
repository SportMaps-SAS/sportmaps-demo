/**
 * «Reglas para entrar» (carnet 3D F5, spec §8.2): qué revisa el semáforo al escanear un carnet
 * de esta escuela y con cuántos días de aviso.
 *
 * Tabla school_eligibility_rules (una fila por escuela; sin fila = pagos + inscripción, 7 días).
 * La lee el personal; la cambia SOLO la administración (la RLS lo hace cumplir: un coach
 * recibe 42501 y aquí se le explica).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import type { ReglasParaEntrarProps } from '@/lib/cards/contratos';
import {
  normalizarDiasAviso, reglasDeFila, type ReglasParaEntrar as Reglas,
} from '@/lib/cards/habilitacion';

const CRITERIOS: { clave: Exclude<keyof Reglas, 'dias_aviso'>; titulo: string; ayuda: string }[] = [
  { clave: 'pagos', titulo: 'Pagos al día', ayuda: 'Sin cobros vencidos. Avisa en amarillo si uno vence pronto.' },
  { clave: 'inscripcion', titulo: 'Inscrito', ayuda: 'Inscripción activa en su categoría, o aprobada en el evento.' },
  { clave: 'seguro', titulo: 'Seguro deportivo vigente', ayuda: 'Que tenga cargado el seguro y no esté vencido.' },
  { clave: 'certificado_medico', titulo: 'Certificado médico vigente', ayuda: 'Solo la fecha de vigencia; nunca diagnósticos.' },
  { clave: 'autorizacion_evento', titulo: 'Autorización para eventos', ayuda: 'Firmada por el acudiente. Solo se revisa al verificar para un evento.' },
];

// La tabla aún no está en types.ts (se regenera al final del lote de migraciones).
const tabla = () => supabase.from('school_eligibility_rules' as never);

export function ReglasParaEntrar({ schoolId }: ReglasParaEntrarProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const clave = ['reglas-para-entrar', schoolId];

  const q = useQuery({
    queryKey: clave,
    enabled: !!schoolId,
    queryFn: async () => {
      const { data, error } = await tabla().select('*').eq('school_id' as never, schoolId as never).maybeSingle();
      if (error) throw error;
      return reglasDeFila(data as Partial<Reglas> | null);
    },
  });

  const [form, setForm] = useState<Reglas | null>(null);
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);

  const guardar = useMutation({
    mutationFn: async (r: Reglas) => {
      const fila = { school_id: schoolId, ...r, dias_aviso: normalizarDiasAviso(r.dias_aviso) };
      const { error } = await tabla().upsert(fila as never, { onConflict: 'school_id' });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Reglas guardadas', description: 'Se aplican desde el próximo escaneo.' });
      void queryClient.invalidateQueries({ queryKey: clave });
    },
    onError: (e: unknown) => {
      const code = (e as { code?: string })?.code;
      toast({
        title: 'No se guardó',
        description: code === '42501'
          ? 'Solo la administración del club puede cambiar estas reglas.'
          : 'Intenta de nuevo en un momento.',
        variant: 'destructive',
      });
    },
  });

  if (q.isLoading || !form) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando reglas…
      </div>
    );
  }
  if (q.isError) {
    return <p className="p-4 text-sm text-red-700">No se pudieron cargar las reglas para entrar.</p>;
  }

  const cambiado = JSON.stringify(form) !== JSON.stringify(q.data);

  return (
    <section className="space-y-4" data-testid="reglas-para-entrar">
      <header className="space-y-1">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> Reglas para entrar
        </h3>
        <p className="text-sm text-muted-foreground">
          Al escanear el carnet, el personal ve verde (puede entrar), amarillo (algo vence pronto) o rojo (no puede entrar).
          Elige qué se revisa. Esto nunca aparece en el carnet.
        </p>
      </header>

      <ul className="divide-y rounded-xl border bg-card">
        {CRITERIOS.map((c) => (
          <li key={c.clave} className="flex items-center justify-between gap-4 p-3">
            <div className="min-w-0">
              <Label htmlFor={`regla-${c.clave}`} className="font-medium">{c.titulo}</Label>
              <p className="text-xs text-muted-foreground">{c.ayuda}</p>
            </div>
            <Switch
              id={`regla-${c.clave}`}
              checked={form[c.clave]}
              onCheckedChange={(v) => setForm({ ...form, [c.clave]: v })}
            />
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-4 rounded-xl border bg-card p-3">
        <div className="min-w-0">
          <Label htmlFor="regla-dias" className="font-medium">Avisar con</Label>
          <p className="text-xs text-muted-foreground">Días antes de que algo venza para mostrar amarillo (0 a 60).</p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="regla-dias"
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            className="w-20 text-right"
            value={form.dias_aviso}
            onChange={(e) => setForm({ ...form, dias_aviso: normalizarDiasAviso(e.target.value) })}
          />
          <span className="text-sm text-muted-foreground">días</span>
        </div>
      </div>

      <Button className="w-full gap-2" disabled={!cambiado || guardar.isPending} onClick={() => guardar.mutate(form)}>
        {guardar.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        Guardar reglas
      </Button>
    </section>
  );
}

export default ReglasParaEntrar;
