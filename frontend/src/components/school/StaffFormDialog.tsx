import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { z } from 'zod';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Loader2, Pencil, UserPlus } from 'lucide-react';
import { PhoneInput, countryForPhone } from '@/components/ui/phone-input';
import { SportMultiCombobox } from '@/components/common/SportMultiCombobox';
import { TagInput } from '@/components/common/TagInput';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Centinela del Select: Radix no acepta value="" en un SelectItem. */
const NO_BRANCH = '__none__';

/** Niveles de atleta que un entrenador puede dictar (school_staff.taught_levels). */
const TAUGHT_LEVELS = [
  { value: 1, label: 'Nivel 1', hint: 'Principiante' },
  { value: 2, label: 'Nivel 2', hint: 'Intermedio' },
  { value: 3, label: 'Nivel 3', hint: 'Avanzado' },
  { value: 4, label: 'Nivel 4', hint: 'Elite / Alto rendimiento' },
] as const;

/**
 * El PhoneInput siempre deja el indicativo puesto, así que un campo "vacío" llega
 * como "+57". Se cuentan solo los dígitos nacionales para saber si hay número.
 */
function nationalDigits(value?: string | null): string {
  if (!value) return '';
  const country = countryForPhone(value);
  const rest = country ? value.slice(country.value.length) : value;
  return rest.replace(/\D/g, '');
}

function getInitials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

const staffSchema = z.object({
  full_name: z.string().trim().min(2, 'Nombre es requerido'),
  email: z.string().trim().email('Email inválido'),
  phone: z
    .string()
    .optional()
    .refine((v) => {
      const digits = nationalDigits(v);
      return digits.length === 0 || digits.length >= 7;
    }, 'Número incompleto'),
  sports: z.array(z.string()).min(1, 'Selecciona al menos un deporte'),
  // Sin .default([]) en ninguno de los dos arrays: con zodResolver los tipos
  // de input/output divergen y el undefined ya se maneja al leer
  // (field.value || []) y al enviar (?? []).
  taught_levels: z.array(z.number()).optional(),
  branch_id: z.string().optional().nullable(),
  certifications: z.array(z.string()).optional(),
  send_invitation: z.boolean().optional(),
});

type StaffFormData = z.infer<typeof staffSchema>;

export interface StaffFormValues {
  full_name: string;
  email: string;
  phone?: string;
  sports?: string[];
  /** 1=Principiante, 2=Intermedio, 3=Avanzado, 4=Elite/Alto rendimiento. */
  taught_levels?: number[];
  branch_id?: string | null;
  certifications?: string[];
  /** Solo al contratar: dispara la invitación de acceso. */
  send_invitation?: boolean;
}

interface StaffFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Puede devolver una promesa: el modal espera a que resuelva para cerrarse.
   * Si rechaza, se queda abierto con los datos escritos.
   */
  onSubmit: (data: StaffFormValues) => void | Promise<unknown>;
  isLoading?: boolean;
  initialData?: StaffFormValues | null;
  /** Sedes de la escuela. Si viene vacío, la sección de sede no se muestra. */
  branches?: { id: string; name: string; is_main?: boolean }[];
}

export function StaffFormDialog({
  open,
  onOpenChange,
  onSubmit,
  isLoading,
  initialData,
  branches = [],
}: StaffFormDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const emptyValues = useMemo<StaffFormData>(
    () => ({
      full_name: '',
      email: '',
      phone: '',
      sports: [],
      taught_levels: [],
      branch_id: NO_BRANCH,
      certifications: [],
      send_invitation: true,
    }),
    [],
  );

  const form = useForm<StaffFormData>({
    resolver: zodResolver(staffSchema),
    defaultValues: emptyValues,
  });

  // Update form when initialData changes or dialog opens
  useEffect(() => {
    if (open) {
      setSubmitError(null);
      form.reset({
        full_name: initialData?.full_name || '',
        email: initialData?.email || '',
        phone: initialData?.phone || '',
        sports: initialData?.sports || [],
        taught_levels: initialData?.taught_levels || [],
        branch_id: initialData?.branch_id || NO_BRANCH,
        certifications: initialData?.certifications || [],
        // Al editar no aplica: la invitación se manda solo al contratar.
        send_invitation: !initialData,
      });
    }
  }, [open, initialData, form]);

  const isEditing = !!initialData;
  const busy = isLoading || form.formState.isSubmitting;
  const hasBranches = branches.length > 0;
  const initials = getInitials(form.watch('full_name') || '');

  const handleSubmit = async (data: StaffFormData) => {
    setSubmitError(null);
    try {
      // Antes se cerraba el modal sin esperar la respuesta: si el POST fallaba,
      // el usuario perdía lo escrito y solo veía un toast rojo.
      await onSubmit({
        full_name: data.full_name,
        email: data.email,
        phone: nationalDigits(data.phone) ? data.phone : undefined,
        sports: data.sports ?? [],
        taught_levels: data.taught_levels ?? [],
        branch_id: data.branch_id && data.branch_id !== NO_BRANCH ? data.branch_id : null,
        certifications: data.certifications ?? [],
        ...(isEditing ? {} : { send_invitation: data.send_invitation ?? true }),
      });
      form.reset(emptyValues);
      onOpenChange(false);
    } catch (err: any) {
      setSubmitError(err?.message || 'No se pudo guardar. Revisa los datos e intenta de nuevo.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center">
              {initials ? (
                <span className="text-sm font-bold text-primary tracking-wide">{initials}</span>
              ) : isEditing ? (
                <Pencil className="h-5 w-5 text-primary" />
              ) : (
                <UserPlus className="h-5 w-5 text-primary" />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle>{isEditing ? 'Editar Entrenador' : 'Contratar Entrenador'}</DialogTitle>
              <DialogDescription>
                {isEditing
                  ? 'Actualiza los datos del entrenador.'
                  : 'Suma un entrenador al staff técnico de tu academia.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          {/* ── Datos de contacto ───────────────────────────────────────────── */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Datos de contacto
            </h3>

            <div className="space-y-2">
              <Label htmlFor="full_name">Nombre Completo *</Label>
              <Input
                id="full_name"
                autoComplete="name"
                placeholder="Ej: Juan Carlos Pérez"
                {...form.register('full_name')}
              />
              {form.formState.errors.full_name && (
                <p className="text-sm text-destructive">{form.formState.errors.full_name.message}</p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email">Correo Electrónico *</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="email@ejemplo.com"
                  {...form.register('email')}
                />
                {form.formState.errors.email && (
                  <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">
                  Teléfono <span className="font-normal text-muted-foreground">(opcional)</span>
                </Label>
                <Controller
                  name="phone"
                  control={form.control}
                  render={({ field }) => (
                    <PhoneInput
                      id="phone"
                      value={field.value || ''}
                      onChange={field.onChange}
                      placeholder="300 123 4567"
                      disabled={busy}
                      className="h-10 rounded-md border-input bg-background"
                    />
                  )}
                />
                {form.formState.errors.phone && (
                  <p className="text-sm text-destructive">{form.formState.errors.phone.message}</p>
                )}
              </div>
            </div>
          </section>

          {/* ── Rol en la academia ──────────────────────────────────────────── */}
          <section className="space-y-4 border-t pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Rol en la academia
            </h3>

            <div className="space-y-2">
              <Label htmlFor="sports">Deportes que dicta *</Label>
              <Controller
                name="sports"
                control={form.control}
                render={({ field }) => (
                  <SportMultiCombobox
                    id="sports"
                    value={field.value}
                    onChange={field.onChange}
                    disabled={busy}
                    invalid={!!form.formState.errors.sports}
                    placeholder="Selecciona uno o más deportes"
                  />
                )}
              />
              {form.formState.errors.sports && (
                <p className="text-sm text-destructive">{form.formState.errors.sports.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>
                Niveles que dicta <span className="font-normal text-muted-foreground">(opcional)</span>
              </Label>
              <Controller
                name="taught_levels"
                control={form.control}
                render={({ field }) => {
                  const selected = field.value ?? [];
                  const toggle = (v: number) =>
                    field.onChange(
                      selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v],
                    );
                  return (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {TAUGHT_LEVELS.map((lvl) => (
                        <button
                          key={lvl.value}
                          type="button"
                          disabled={busy}
                          onClick={() => toggle(lvl.value)}
                          className={`rounded-md border px-2 py-2 text-center text-xs transition-colors ${
                            selected.includes(lvl.value)
                              ? 'border-primary bg-primary/10 text-primary font-semibold'
                              : 'border-input bg-background hover:bg-muted/50'
                          }`}
                        >
                          <div className="font-semibold">{lvl.label}</div>
                          <div className="text-muted-foreground">({lvl.hint})</div>
                        </button>
                      ))}
                    </div>
                  );
                }}
              />
            </div>

            {hasBranches && (
              <div className="space-y-2">
                <Label htmlFor="branch_id">
                  Sede <span className="font-normal text-muted-foreground">(opcional)</span>
                </Label>
                <Controller
                  name="branch_id"
                  control={form.control}
                  render={({ field }) => (
                    <Select
                      value={field.value || NO_BRANCH}
                      onValueChange={field.onChange}
                      disabled={busy}
                    >
                      <SelectTrigger id="branch_id">
                        <SelectValue placeholder="Sin sede asignada" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_BRANCH}>Sin sede asignada</SelectItem>
                        {branches.map((branch) => (
                          <SelectItem key={branch.id} value={branch.id}>
                            {branch.name}
                            {branch.is_main ? ' · principal' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="certifications">
                Certificaciones <span className="font-normal text-muted-foreground">(opcional)</span>
              </Label>
              <Controller
                name="certifications"
                control={form.control}
                render={({ field }) => (
                  <TagInput
                    id="certifications"
                    value={field.value || []}
                    onChange={field.onChange}
                    disabled={busy}
                    placeholder="Ej: Licencia B UEFA, RCP"
                  />
                )}
              />
            </div>
          </section>

          {/* ── Acceso a la plataforma ──────────────────────────────────────
              Sin esto el registro es invisible para el entrenador: el POST solo
              escribe en school_staff y nadie le avisa. */}
          {!isEditing && (
            <section className="space-y-3 border-t pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Acceso a la plataforma
              </h3>
              <Controller
                name="send_invitation"
                control={form.control}
                render={({ field }) => (
                  <div className="rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <Label htmlFor="send_invitation" className="cursor-pointer">
                          Enviar invitación por correo
                        </Label>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {field.value
                            ? 'Recibirá un correo para crear su cuenta y quedar vinculado a la academia. Si ya tiene cuenta SportMaps, se vincula automáticamente.'
                            : 'Registro interno: quedará en tu staff pero sin acceso a la plataforma. Puedes invitarlo después desde Invitaciones.'}
                        </p>
                      </div>
                      <Switch
                        id="send_invitation"
                        checked={field.value ?? true}
                        onCheckedChange={field.onChange}
                        disabled={busy}
                      />
                    </div>
                  </div>
                )}
              />
            </section>
          )}

          {submitError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-sm text-destructive">{submitError}</p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {busy ? 'Guardando...' : isEditing ? 'Guardar Cambios' : 'Contratar Entrenador'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
