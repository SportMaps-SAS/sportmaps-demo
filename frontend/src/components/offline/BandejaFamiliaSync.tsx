/**
 * Sincronizador de la bandeja de salida para deportista y acudiente (no pinta nada).
 *
 * Sube sola la autoevaluación post-entreno que se contestó sin señal, esté la persona en la pantalla que esté:
 * al abrir, al volver la red, al volver a primer plano y cuando vence la espera del próximo intento.
 * El entrenador tiene el suyo (`CoachListasSync`), que además precarga su día.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { useSincronizadorBandeja } from '@/lib/offline/useBandeja';
import type { EventoBandeja } from '@/lib/offline/bandeja';

export function BandejaFamiliaSync() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const alEnviar = useCallback((eventos: EventoBandeja[]) => {
    for (const ev of eventos) {
      if (ev.type === 'sent') {
        toast.success(`Se envió: ${ev.accion.etiqueta}.`, { id: `bandeja-${ev.accion.id}` });
        // La tarjeta «¿Qué tan duro fue?» y los resúmenes salen de estas lecturas.
        void qc.invalidateQueries({ queryKey: ['athlete-v2-autoeval'] });
        void qc.invalidateQueries({ queryKey: ['post-training-context'] });
      } else if (ev.type === 'rule_error' || ev.type === 'stuck') {
        const motivo = ev.type === 'rule_error' ? ev.message : ev.accion.error ?? ev.message;
        toast.error(`No se pudo enviar «${ev.accion.etiqueta}»: ${motivo}`, { id: `bandeja-${ev.accion.id}`, duration: Infinity, closeButton: true });
      }
    }
  }, [qc]);

  useSincronizadorBandeja(user?.id, alEnviar);
  return null;
}
