import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { CheckCircle2, Calendar, MapPin, Clock, Loader2, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface TrialConfirmationProps {
  teamId: string;
  teamName: string;
  schoolName: string;
  schoolAddress?: string;
  slotId: string;
  scheduledDate: string;
  startTime: string;
  endTime: string;
  onConfirmed: () => void;
  onCancel: () => void;
}

export function TrialConfirmation({
  teamId,
  teamName,
  schoolName,
  schoolAddress,
  slotId,
  scheduledDate,
  startTime,
  endTime,
  onConfirmed,
  onCancel,
}: TrialConfirmationProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState('');

  const formattedDate = new Date(scheduledDate).toLocaleDateString('es-CO', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const handleConfirm = async () => {
    if (!user) return;

    try {
      setConfirming(true);

      // 1. Create the trial booking — NO payment involved
      const { data, error } = await supabase
        .from('bookings')
        .insert({
          athlete_id: user.id,
          // bookings no tiene team_id (el equipo sale del cupo): mandarlo
          // hacía fallar el insert con «column not found».
          availability_slot_id: slotId,
          booking_type: 'trial',
          status: 'trial_confirmed',
          scheduled_at: `${scheduledDate}T${startTime}`,
          notes: notes || null,
        })
        .select()
        .single();

      if (error) throw error;

      // 2. Release the hold
      await supabase
        .from('booking_holds')
        .delete()
        .eq('athlete_id', user.id)
        .eq('availability_slot_id', slotId);

      setConfirmed(true);

      toast({
        title: '¡Clase de prueba confirmada! 🎉',
        description: `Tu prueba en ${schoolName} ha sido agendada.`,
      });

      // Slight delay before callback for visual feedback
      setTimeout(() => onConfirmed(), 1500);

    } catch (err) {
      console.error('Error confirming trial:', err);
      toast({
        title: 'Error al confirmar',
        description: 'No se pudo agendar tu prueba. Intenta nuevamente.',
        variant: 'destructive',
      });
    } finally {
      setConfirming(false);
    }
  };

  if (confirmed) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/50">
        <CardContent className="p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          </div>
          <h3 className="text-xl font-bold text-emerald-800 mb-2">¡Prueba Agendada!</h3>
          <p className="text-emerald-700">
            Te esperamos el <strong>{formattedDate}</strong> a las <strong>{startTime.slice(0, 5)}</strong>
          </p>
          <p className="text-sm text-emerald-600 mt-2">
            Recibirás un recordatorio antes de tu sesión.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Confirmar clase de prueba
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary */}
        <div className="rounded-xl bg-muted/50 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-lg">{teamName}</h4>
            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border-emerald-200">
              Gratis
            </Badge>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 flex-shrink-0" />
              <span>{schoolName}{schoolAddress ? ` — ${schoolAddress}` : ''}</span>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 flex-shrink-0" />
              <span className="capitalize">{formattedDate}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 flex-shrink-0" />
              <span>{startTime.slice(0, 5)} — {endTime.slice(0, 5)}</span>
            </div>
          </div>
        </div>

        {/* Notes (optional) */}
        <div>
          <label className="text-sm font-medium mb-2 block">
            Notas adicionales <span className="text-muted-foreground">(opcional)</span>
          </label>
          <Textarea
            placeholder="¿Algo que debamos saber? (lesiones, experiencia previa, etc.)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>

        {/* Info box */}
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-700">
          <strong>Sin compromiso:</strong> Esta es una sesión de prueba gratuita. 
          No se te cobrará nada. Si te gusta, podrás inscribirte al programa completo después.
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onCancel}
            disabled={confirming}
          >
            Cancelar
          </Button>
          <Button
            className="flex-1"
            onClick={handleConfirm}
            disabled={confirming}
          >
            {confirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Confirmando...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Confirmar prueba
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
