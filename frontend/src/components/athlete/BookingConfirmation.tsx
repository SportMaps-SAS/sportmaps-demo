import { useState } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import { SlotPicker } from './SlotPicker';
import { TrialConfirmation } from './TrialConfirmation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar, MapPin, Clock, CreditCard, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

type BookingStep = 'select_slot' | 'confirm_trial' | 'confirm_program' | 'success';

interface BookingConfirmationProps {
  teamId: string;
  teamName: string;
  programPrice: number;
  sport: string;
  schoolId: string;
  schoolName: string;
  schoolAddress?: string;
  bookingType: 'trial' | 'program';
  onComplete: () => void;
  onBack: () => void;
}

interface SelectedSlotData {
  id: string;
  start_time: string;
  end_time: string;
  scheduledDate: string;
}

export function BookingConfirmation({
  teamId,
  teamName,
  programPrice,
  sport,
  schoolId,
  schoolName,
  schoolAddress,
  bookingType,
  onComplete,
  onBack,
}: BookingConfirmationProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<BookingStep>('select_slot');
  const [selectedSlot, setSelectedSlot] = useState<SelectedSlotData | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const handleSlotSelected = (slot: any, date: string) => {
    setSelectedSlot({
      id: slot.id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      scheduledDate: date,
    });

    if (bookingType === 'trial') {
      setStep('confirm_trial');
    } else {
      setStep('confirm_program');
    }
  };

  const handleProgramEnrollment = async () => {
    if (!user || !selectedSlot) return;

    try {
      setEnrolling(true);

      // 1. Create the booking
      const { error: bookingError } = await supabase
        .from('bookings')
        .insert({
          athlete_id: user.id,
          // bookings no tiene team_id (el equipo sale del cupo): mandarlo
          // hacía fallar el insert con «column not found».
          availability_slot_id: selectedSlot.id,
          booking_type: 'program',
          status: 'pending', // Will be 'confirmed' after payment
          scheduled_at: `${selectedSlot.scheduledDate}T${selectedSlot.start_time}`,
        });

      if (bookingError) throw bookingError;

      // 2. Create a pending payment record
      const { error: paymentError } = await supabase
        .from('athlete_payments')
        .insert({
          athlete_id: user.id,
          amount_cents: programPrice * 100,
          currency: 'COP',
          status: 'pending',
          due_date: todayColombia(),
        });

      if (paymentError) throw paymentError;

      // 3. Release the hold
      await supabase
        .from('booking_holds')
        .delete()
        .eq('athlete_id', user.id)
        .eq('availability_slot_id', selectedSlot.id);

      setStep('success');

      toast({
        title: '¡Inscripción iniciada!',
        description: 'Completa el pago para confirmar tu inscripción.',
      });

      setTimeout(() => onComplete(), 2000);

    } catch (err) {
      console.error('Error enrolling:', err);
      toast({
        title: 'Error en la inscripción',
        description: 'Hubo un problema al procesar tu solicitud. Intenta nuevamente.',
        variant: 'destructive',
      });
    } finally {
      setEnrolling(false);
    }
  };

  // ─── Step: Select Slot ────────────────────────────────────
  if (step === 'select_slot') {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Volver al programa
        </Button>
        <SlotPicker
          teamId={teamId}
          schoolId={schoolId}
          bookingType={bookingType}
          onSlotSelected={handleSlotSelected}
        />
      </div>
    );
  }

  // ─── Step: Confirm Trial ──────────────────────────────────
  if (step === 'confirm_trial' && selectedSlot) {
    return (
      <TrialConfirmation
        teamId={teamId}
        teamName={teamName}
        schoolName={schoolName}
        schoolAddress={schoolAddress}
        slotId={selectedSlot.id}
        scheduledDate={selectedSlot.scheduledDate}
        startTime={selectedSlot.start_time}
        endTime={selectedSlot.end_time}
        onConfirmed={onComplete}
        onCancel={() => {
          setSelectedSlot(null);
          setStep('select_slot');
        }}
      />
    );
  }

  // ─── Step: Confirm Program (with payment) ─────────────────
  if (step === 'confirm_program' && selectedSlot) {
    const formattedDate = new Date(selectedSlot.scheduledDate).toLocaleDateString('es-CO', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Confirmar inscripción
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Program summary */}
          <div className="rounded-xl bg-muted/50 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-lg">{teamName}</h4>
              <Badge variant="secondary">{sport}</Badge>
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
                <span>{selectedSlot.start_time.slice(0, 5)} — {selectedSlot.end_time.slice(0, 5)}</span>
              </div>
            </div>
          </div>

          {/* Price breakdown */}
          <div className="rounded-xl border-2 border-primary/20 p-5">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mensualidad</span>
              <span className="text-2xl font-bold text-primary">
                ${programPrice.toLocaleString('es-CO')} <span className="text-sm font-normal text-muted-foreground">COP/mes</span>
              </span>
            </div>
          </div>

          {/* Payment notice */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
            <strong>Pago pendiente:</strong> Tu inscripción quedará en estado pendiente hasta que se procese el pago. 
            Podrás completarlo desde tu panel de pagos.
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setSelectedSlot(null);
                setStep('select_slot');
              }}
              disabled={enrolling}
            >
              Cambiar horario
            </Button>
            <Button
              className="flex-1"
              onClick={handleProgramEnrollment}
              disabled={enrolling}
            >
              {enrolling ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Procesando...
                </>
              ) : (
                <>
                  <CreditCard className="h-4 w-4 mr-2" />
                  Inscribirme
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ─── Step: Success ────────────────────────────────────────
  if (step === 'success') {
    return (
      <Card className="border-emerald-200 bg-emerald-50/50">
        <CardContent className="p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-600" />
          </div>
          <h3 className="text-xl font-bold text-emerald-800 mb-2">¡Inscripción registrada!</h3>
          <p className="text-emerald-700">
            Tu solicitud ha sido procesada. Completa el pago para confirmar tu lugar.
          </p>
        </CardContent>
      </Card>
    );
  }

  return null;
}
