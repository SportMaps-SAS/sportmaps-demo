/**
 * «Enviar al acudiente» (solo la escuela).
 *
 * Primero SIMULA (no escribe nada): dice a qué correo llegaría, qué deportistas
 * incluye y cuánto dura el enlace. Solo si la escuela confirma se envía de verdad.
 * Los motivos por los que no se puede enviar (sin correo, fuera de horario de
 * cobranza, ya se envió hoy, la familia ya fue contactada hoy…) se muestran tal
 * como los dice el servidor, y si ya se envió hoy se ofrece «Reenviar» como una
 * acción aparte y consciente.
 *
 * El correo se muestra enmascarado (c••••@gmail.com): confirma a dónde llega sin
 * exponerlo entero en pantalla.
 */
import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { enviarEstadoCuenta, type PedidoEnvioEstado, type RespuestaEnvio } from '@/lib/api/estadoCuentaEnlace';

type Fase =
  | { fase: 'reposo' }
  | { fase: 'simulando' }
  | { fase: 'confirmar'; reenviar: boolean; vista: Extract<RespuestaEnvio, { ok: true }> }
  | { fase: 'enviando'; reenviar: boolean }
  | { fase: 'enviado'; destino: string }
  | { fase: 'no'; reenviar: boolean; motivo: string; mensaje: string }
  | { fase: 'error' };

export interface EnviarAlAcudienteProps {
  atleta: PedidoEnvioEstado['atleta'];
}

export function EnviarAlAcudiente({ atleta }: EnviarAlAcudienteProps) {
  const { toast } = useToast();
  const [estado, setEstado] = useState<Fase>({ fase: 'reposo' });

  const simular = async (reenviar: boolean) => {
    setEstado({ fase: 'simulando' });
    try {
      const r = await enviarEstadoCuenta({ atleta, aplicar: false, reenviar });
      // `=== false` y no `!r.ok`: el proyecto no usa strictNullChecks y sin eso la unión no se estrecha.
      setEstado(r.ok === false ? { fase: 'no', reenviar, motivo: r.motivo, mensaje: r.mensaje } : { fase: 'confirmar', reenviar, vista: r });
    } catch {
      setEstado({ fase: 'error' });
    }
  };

  const enviar = async (reenviar: boolean) => {
    setEstado({ fase: 'enviando', reenviar });
    try {
      const r = await enviarEstadoCuenta({ atleta, aplicar: true, reenviar });
      if (r.ok === false) {
        setEstado({ fase: 'no', reenviar, motivo: r.motivo, mensaje: r.mensaje });
      } else {
        setEstado({ fase: 'enviado', destino: r.destino });
        toast({ title: 'Estado de cuenta enviado', description: `Le llegará a ${r.destino}.` });
      }
    } catch {
      setEstado({ fase: 'error' });
    }
  };

  if (estado.fase === 'reposo') {
    return (
      <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => void simular(false)}>
        <Send className="mr-2 h-4 w-4" aria-hidden="true" />
        Enviar al acudiente
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border bg-card p-3 text-sm" role="status" aria-live="polite">
      {estado.fase === 'simulando' && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Revisando a quién llegaría…
        </p>
      )}

      {estado.fase === 'confirmar' && (
        <>
          <p>
            Se enviará por correo a <strong>{estado.vista.destino}</strong> el estado de cuenta de{' '}
            <strong>{estado.vista.atletas.join(', ')}</strong>. El enlace funciona {estado.vista.vigenciaDias} días.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-touch rounded-xl" onClick={() => void enviar(estado.reenviar)}>
              {estado.reenviar ? 'Reenviar' : 'Enviar'}
            </Button>
            <Button variant="ghost" className="min-h-touch rounded-xl" onClick={() => setEstado({ fase: 'reposo' })}>Cancelar</Button>
          </div>
        </>
      )}

      {estado.fase === 'enviando' && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Enviando…
        </p>
      )}

      {estado.fase === 'enviado' && (
        <>
          <p className="font-semibold text-emerald-700 dark:text-emerald-400">Enviado a {estado.destino}.</p>
          <Button variant="ghost" size="sm" onClick={() => setEstado({ fase: 'reposo' })}>Listo</Button>
        </>
      )}

      {estado.fase === 'no' && (
        <>
          <p role="alert">{estado.mensaje}</p>
          <div className="flex flex-wrap gap-2">
            {estado.motivo === 'ya_enviado_hoy' && !estado.reenviar && (
              <Button variant="outline" className="min-h-touch rounded-xl" onClick={() => void simular(true)}>Reenviar</Button>
            )}
            <Button variant="ghost" className="min-h-touch rounded-xl" onClick={() => setEstado({ fase: 'reposo' })}>Cerrar</Button>
          </div>
        </>
      )}

      {estado.fase === 'error' && (
        <>
          <p role="alert">No se pudo completar. Revisa tu conexión e inténtalo de nuevo.</p>
          <Button variant="ghost" className="min-h-touch rounded-xl" onClick={() => setEstado({ fase: 'reposo' })}>Cerrar</Button>
        </>
      )}
    </div>
  );
}
