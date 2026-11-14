import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building, Check, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { construirHorario } from './venueMetrics';
import { SportMapsPaySettings } from '@/components/settings/SportMapsPaySettings';

// Mismos tipos que ofrece el formulario de instalaciones de la escuela
// (FacilityFormDialog.facilityTypes, no exportado). Si allá se agrega uno,
// agregarlo aquí.
const TIPOS_DE_CANCHA = [
  'Cancha de Fútbol',
  'Cancha de Fútbol Sala',
  'Cancha Sintética',
  'Cancha de Baloncesto',
  'Cancha de Tenis',
  'Cancha de Voleibol',
  'Piscina',
  'Gimnasio',
  'Otro',
];

const HORAS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

type Paso = 1 | 2 | 3;

/**
 * Onboarding mínimo del dueño de espacios (facility_manager):
 *   1. Nombre del espacio y ciudad (actualiza la escuela-venue).
 *   2. Primera instalación: nombre, tipo, capacidad, tarifa por hora y horario.
 *   3. Forma de cobro (la misma configuración de recaudo de la escuela).
 * Sin equipos, atletas ni planes. La instalación se guarda con las columnas
 * que ya existen en `facilities` (hourly_rate, rental_*, available_hours); la
 * RLS decide si el dueño puede escribir.
 */
export default function VenueOnboardingPage() {
  const { schoolId, schoolName, loading } = useSchoolContext();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [paso, setPaso] = useState<Paso>(1);
  const [guardando, setGuardando] = useState(false);

  const [nombreEspacio, setNombreEspacio] = useState('');
  const [ciudad, setCiudad] = useState('');

  const [canchaNombre, setCanchaNombre] = useState('');
  const [canchaTipo, setCanchaTipo] = useState('Cancha Sintética');
  const [capacidad, setCapacidad] = useState('10');
  const [tarifa, setTarifa] = useState('');
  const [desde, setDesde] = useState('06:00');
  const [hasta, setHasta] = useState('22:00');

  useEffect(() => {
    if (schoolName && !nombreEspacio) setNombreEspacio(schoolName);
    // Solo precarga el nombre que el registro ya guardó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolName]);

  if (loading) {
    return (
      <div className="min-h-[60dvh] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!schoolId) {
    return (
      <div className="container mx-auto p-6 max-w-lg text-center space-y-3">
        <h1 className="text-xl font-bold">Estamos preparando tu espacio</h1>
        <p className="text-muted-foreground">
          Tu cuenta aún no tiene un espacio asociado. Cierra sesión y vuelve a entrar en unos minutos; si sigue igual, escríbenos a soporte.
        </p>
      </div>
    );
  }

  const guardarEspacio = async () => {
    if (!nombreEspacio.trim()) return;
    setGuardando(true);
    try {
      const { error } = await supabase
        .from('schools')
        .update({ name: nombreEspacio.trim(), city: ciudad.trim() || null })
        .eq('id', schoolId);
      if (error) throw error;
      setPaso(2);
    } catch (e) {
      toast({ title: 'No pudimos guardar tu espacio', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  };

  const guardarCancha = async () => {
    const precio = Number(tarifa.replace(/\D/g, ''));
    const cap = Number(capacidad);
    if (!canchaNombre.trim() || !cap || cap < 1 || !precio || desde >= hasta) {
      toast({
        title: 'Revisa los datos',
        description: 'Nombre, capacidad, tarifa por hora y un horario donde la apertura sea antes del cierre.',
        variant: 'destructive',
      });
      return;
    }
    setGuardando(true);
    try {
      const { error } = await supabase.from('facilities').insert({
        school_id: schoolId,
        name: canchaNombre.trim(),
        type: canchaTipo,
        capacity: cap,
        hourly_rate: precio,
        rental_enabled: true,
        rental_rate: precio,
        booking_enabled: true,
        available_hours: construirHorario({ desde, hasta }),
      });
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ['school-facilities', schoolId] });
      setPaso(3);
    } catch (e) {
      toast({ title: 'No pudimos guardar la instalación', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  };

  const terminar = async () => {
    setGuardando(true);
    // Mejor esfuerzo: si la RLS no deja marcar el onboarding, el panel igual abre
    // (no depende de este estado para un dueño de espacios).
    await supabase.from('schools').update({ onboarding_status: 'completed' }).eq('id', schoolId);
    setGuardando(false);
    navigate('/venue/dashboard', { replace: true });
  };

  return (
    <div className="min-h-[80dvh] flex items-center justify-center p-4">
      <Card className="w-full max-w-xl shadow-lg">
        <CardHeader className="text-center">
          <div className="bg-primary/10 w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-3">
            <Building className="w-7 h-7 text-primary" />
          </div>
          <CardTitle>
            {paso === 1 && 'Tu espacio'}
            {paso === 2 && 'Tu primera cancha'}
            {paso === 3 && '¿Cómo te pagan?'}
          </CardTitle>
          <CardDescription>Paso {paso} de 3. Publica tus canchas y recibe reservas.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {paso === 1 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="venue-nombre">Nombre del espacio o club</Label>
                <Input id="venue-nombre" value={nombreEspacio} onChange={(e) => setNombreEspacio(e.target.value)} placeholder="Ej: Canchas El Campín" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="venue-ciudad">Ciudad</Label>
                <Input id="venue-ciudad" value={ciudad} onChange={(e) => setCiudad(e.target.value)} placeholder="Ej: Bogotá" />
              </div>
              <Button className="w-full" onClick={guardarEspacio} disabled={guardando || !nombreEspacio.trim()}>
                {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Continuar <ArrowRight className="ml-2 h-4 w-4" /></>}
              </Button>
            </>
          )}

          {paso === 2 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="cancha-nombre">Nombre de la cancha</Label>
                <Input id="cancha-nombre" value={canchaNombre} onChange={(e) => setCanchaNombre(e.target.value)} placeholder="Ej: Cancha 1" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Tipo</Label>
                  <Select value={canchaTipo} onValueChange={setCanchaTipo}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIPOS_DE_CANCHA.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cancha-capacidad">Capacidad (personas)</Label>
                  <Input id="cancha-capacidad" inputMode="numeric" value={capacidad} onChange={(e) => setCapacidad(e.target.value.replace(/\D/g, ''))} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cancha-tarifa">Tarifa por hora (COP)</Label>
                <Input id="cancha-tarifa" inputMode="numeric" value={tarifa} onChange={(e) => setTarifa(e.target.value.replace(/\D/g, ''))} placeholder="Ej: 120000" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Abre</Label>
                  <Select value={desde} onValueChange={setDesde}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{HORAS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Cierra</Label>
                  <Select value={hasta} onValueChange={setHasta}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{HORAS.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                El mismo horario aplica todos los días; lo ajustas por día y agregas más canchas después, en Instalaciones.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPaso(1)} disabled={guardando}>Atrás</Button>
                <Button className="flex-1" onClick={guardarCancha} disabled={guardando}>
                  {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Guardar y continuar <ArrowRight className="ml-2 h-4 w-4" /></>}
                </Button>
              </div>
            </>
          )}

          {paso === 3 && (
            <>
              <SportMapsPaySettings />
              <p className="text-xs text-muted-foreground">
                Puedes saltarte este paso y configurarlo luego en Cobros; sin él, las reservas no se pueden pagar en línea.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPaso(2)} disabled={guardando}>Atrás</Button>
                <Button className="flex-1" onClick={terminar} disabled={guardando}>
                  {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-2 h-4 w-4" />Terminar</>}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
