import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, Pencil } from 'lucide-react';
import { NumberStepper } from '@/components/ui/number-stepper';
import { useEffect } from 'react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { LIMITES_UBICACION, errorEnlaceMaps, useUbicacionCanchaDisponible } from '@/components/school/canchaUbicacion';

const facilitySchema = z.object({
  name: z.string().min(2, 'Nombre es requerido'),
  type: z.string().min(1, 'Tipo es requerido'),
  capacity: z.string().min(1, 'Capacidad es requerida'),
  description: z.string().optional(),
  min_booking_advance_hours: z.string().optional(),
  min_cancellation_hours: z.string().optional(),
  // Cómo llegar (lo manda el bot al agendar la clase de prueba). Solo si la base tiene las columnas.
  address: z.string().max(LIMITES_UBICACION.address, 'La dirección es muy larga').optional(),
  maps_url: z.string().optional().refine((v) => !errorEnlaceMaps(v), { message: 'Pega el enlace completo (empieza por https://).' }),
  indicaciones: z.string().max(LIMITES_UBICACION.indicaciones, 'Las indicaciones son muy largas').optional(),
});

type FacilityFormData = z.infer<typeof facilitySchema>;

interface FacilityFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    name: string;
    type: string;
    capacity: number;
    description?: string;
    min_booking_advance_hours?: number;
    min_cancellation_hours?: number;
    /** undefined = la base todavía no tiene las columnas: no se mandan. */
    address?: string;
    maps_url?: string;
    indicaciones?: string;
  }) => void;
  isLoading?: boolean;
  facility?: {
    id: string;
    name: string;
    type: string;
    capacity: number;
    description: string | null;
    min_booking_advance_hours: number | null;
    min_cancellation_hours: number | null;
    address?: string | null;
    maps_url?: string | null;
    indicaciones?: string | null;
  } | null;
}

const facilityTypes = [
  'Cancha de Fútbol',
  'Cancha de Fútbol Sala',
  'Cancha de Baloncesto',
  'Cancha de Tenis',
  'Cancha de Voleibol',
  'Piscina',
  'Gimnasio',
  'Pista de Atletismo',
  'Sala de Artes Marciales',
  'Cancha Sintética',
  'Otro',
];

export function FacilityFormDialog({ open, onOpenChange, onSubmit, isLoading, facility }: FacilityFormDialogProps) {
  const { schoolId } = useSchoolContext();
  const conUbicacion = useUbicacionCanchaDisponible(schoolId, open);
  const form = useForm<FacilityFormData>({
    resolver: zodResolver(facilitySchema),
    defaultValues: {
      name: '',
      type: '',
      capacity: '',
      description: '',
      min_booking_advance_hours: '0',
      min_cancellation_hours: '0',
      address: '',
      maps_url: '',
      indicaciones: '',
    },
  });

  // Effect to populate form when facility changes
  useEffect(() => {
    if (open) {
      if (facility) {
        form.reset({
          name: facility.name,
          type: facility.type,
          capacity: String(facility.capacity),
          description: facility.description || '',
          min_booking_advance_hours: String(facility.min_booking_advance_hours ?? 0),
          min_cancellation_hours: String(facility.min_cancellation_hours ?? 0),
          address: facility.address ?? '',
          maps_url: facility.maps_url ?? '',
          indicaciones: facility.indicaciones ?? '',
        });
      } else {
        form.reset({
          name: '',
          type: '',
          capacity: '',
          description: '',
          min_booking_advance_hours: '0',
          min_cancellation_hours: '0',
          address: '',
          maps_url: '',
          indicaciones: '',
        });
      }
    }
  }, [facility, form, open]);

  const handleSubmit = (data: FacilityFormData) => {
    onSubmit({
      name: data.name,
      type: data.type,
      capacity: parseInt(data.capacity),
      description: data.description || undefined,
      min_booking_advance_hours: data.min_booking_advance_hours ? parseInt(data.min_booking_advance_hours) : 0,
      min_cancellation_hours: data.min_cancellation_hours ? parseInt(data.min_cancellation_hours) : 0,
      ...(conUbicacion ? { address: data.address ?? '', maps_url: data.maps_url ?? '', indicaciones: data.indicaciones ?? '' } : {}),
    });
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {facility ? <Pencil className="h-5 w-5" /> : <Building2 className="h-5 w-5" />}
            {facility ? 'Editar Instalación' : 'Agregar Instalación'}
          </DialogTitle>
          <DialogDescription>
            {facility ? 'Actualiza los detalles del espacio deportivo' : 'Registra un nuevo espacio deportivo'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Nombre de la Instalación *</Label>
            <Input
              id="name"
              placeholder="Ej: Cancha Principal, Gimnasio A"
              {...form.register('name')}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Tipo de Instalación *</Label>
            <Select 
              onValueChange={(value) => form.setValue('type', value)}
              value={form.watch('type')}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecciona el tipo" />
              </SelectTrigger>
              <SelectContent>
                {facilityTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.type && (
              <p className="text-sm text-destructive">{form.formState.errors.type.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="capacity">Capacidad *</Label>
            <NumberStepper
              value={form.watch('capacity') === '' ? '' : parseInt(form.watch('capacity'))}
              onChange={(val) => form.setValue('capacity', String(val), { shouldValidate: true })}
              min={1}
            />
            {form.formState.errors.capacity && (
              <p className="text-sm text-destructive">{form.formState.errors.capacity.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Número máximo de personas
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="min_booking_advance_hours">Anticipación Reserva (horas)</Label>
              <NumberStepper
                value={form.watch('min_booking_advance_hours') === '' ? 0 : parseInt(form.watch('min_booking_advance_hours') || '0')}
                onChange={(val) => form.setValue('min_booking_advance_hours', String(val))}
                min={0}
              />
              <p className="text-[10px] text-muted-foreground">Mínimo horas previas para reservar</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="min_cancellation_hours">Ventana Cancelación (horas)</Label>
              <NumberStepper
                value={form.watch('min_cancellation_hours') === '' ? 0 : parseInt(form.watch('min_cancellation_hours') || '0')}
                onChange={(val) => form.setValue('min_cancellation_hours', String(val))}
                min={0}
              />
              <p className="text-[10px] text-muted-foreground">Límite de horas para cancelar</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción</Label>
            <Textarea
              id="description"
              placeholder="Descripción y reglas de uso..."
              {...form.register('description')}
              rows={3}
            />
          </div>

          {conUbicacion && (
            <fieldset className="space-y-3 rounded-lg border border-border/60 p-3" data-testid="cancha-como-llegar">
              <legend className="px-1 text-sm font-semibold">Cómo llegar</legend>
              <p className="text-xs text-muted-foreground">El bot de WhatsApp lo manda cuando agenda una clase de prueba aquí.</p>
              <div className="space-y-2">
                <Label htmlFor="address">Dirección</Label>
                <Input id="address" placeholder="Ej: Calle 152 # 58-50, Suba" maxLength={LIMITES_UBICACION.address} {...form.register('address')} />
                {form.formState.errors.address && (
                  <p className="text-sm text-destructive">{form.formState.errors.address.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="maps_url">Enlace de Google Maps</Label>
                <Input id="maps_url" inputMode="url" placeholder="https://maps.app.goo.gl/…" {...form.register('maps_url')} />
                {form.formState.errors.maps_url && (
                  <p className="text-sm text-destructive">{form.formState.errors.maps_url.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="indicaciones">Indicaciones (por dónde se entra, qué pasa si llueve)</Label>
                <Textarea
                  id="indicaciones"
                  placeholder="Ej: Entrada de deportistas por la puerta 2. Si llueve, la clase se reprograma y les avisamos por WhatsApp."
                  maxLength={LIMITES_UBICACION.indicaciones}
                  rows={3}
                  {...form.register('indicaciones')}
                />
              </div>
            </fieldset>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Guardando...' : facility ? 'Actualizar Instalación' : 'Crear Instalación'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
