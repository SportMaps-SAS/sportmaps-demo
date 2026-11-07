import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PhoneInput, isValidPhone } from '@/components/ui/phone-input';
import { Loader2, UserCog, AlertCircle, Calendar as CalendarIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface EditClientModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  clientId: string;
  clientType: 'adult' | 'child' | 'unregistered';
  initialData: {
    full_name?: string;
    email?: string;
    phone?: string;
    date_of_birth?: string;
    gender?: string;
    doc_type?: string;
    doc_number?: string;
    grade?: string;
    /** Documento del acudiente (child/unregistered). */
    guardian_doc_type?: string | null;
    guardian_doc_number?: string | null;
    /** Documento del perfil del adulto con cuenta: solo lectura. */
    profile_doc_type?: string | null;
    profile_doc_number?: string | null;
  };
}

/** Mismo formato que valida el BFF para el documento del acudiente. */
export const GUARDIAN_DOC_REGEX = /^[A-Za-z0-9-]{4,20}$/;
const GUARDIAN_DOC_TYPES = ['CC', 'CE', 'PP', 'NIT'];

const BFF_URL = import.meta.env.VITE_BFF_URL || 'http://localhost:3000';

export function EditClientModal({
  open, onClose, onSuccess,
  clientId, clientType, initialData,
}: EditClientModalProps) {
  const { session } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [fullName, setFullName]       = useState('');
  const [email, setEmail]             = useState('');
  const [phone, setPhone]             = useState('');
  const [dob, setDob]                 = useState('');
  const [gender, setGender]           = useState('');
  const [docType, setDocType]         = useState('CC');
  const [docNumber, setDocNumber]     = useState('');
  const [grade, setGrade]             = useState('');
  const [guardianDocType, setGuardianDocType]     = useState('CC');
  const [guardianDocNumber, setGuardianDocNumber] = useState('');

  // Poblar con datos actuales cuando se abre
  useEffect(() => {
    if (open && initialData) {
      setFullName(initialData.full_name   || '');
      setEmail(initialData.email          || '');
      setPhone(initialData.phone          || '');
      setDob(initialData.date_of_birth    || '');
      setGender(initialData.gender        || '');
      setDocType(initialData.doc_type     || (clientType === 'child' ? 'TI' : 'CC'));
      setDocNumber(initialData.doc_number || '');
      setGrade(initialData.grade          || '');
      setGuardianDocType(initialData.guardian_doc_type     || 'CC');
      setGuardianDocNumber(initialData.guardian_doc_number || '');
    }
  }, [open, initialData, clientType]);

  const handleSave = async () => {
    if (!fullName.trim()) {
      toast({ title: 'El nombre es obligatorio', variant: 'destructive' });
      return;
    }

    if (clientType !== 'child' && phone && !isValidPhone(phone)) {
      toast({ title: 'Teléfono incompleto', description: 'Revisa el número de teléfono.', variant: 'destructive' });
      return;
    }

    const guardianNumber = guardianDocNumber.trim();
    if (clientType !== 'adult' && guardianNumber && !GUARDIAN_DOC_REGEX.test(guardianNumber)) {
      toast({
        title: 'Documento del acudiente inválido',
        description: 'Usa de 4 a 20 caracteres: letras, números o guion.',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, any> = { full_name: fullName.trim() };

      if (clientType === 'unregistered') {
        payload.email        = email || null;
        payload.phone        = phone || null;
        payload.date_of_birth = dob  || null;
        payload.gender       = gender || null;
        payload.doc_type     = docType;
        payload.doc_number   = docNumber || null;
      } else if (clientType === 'child') {
        payload.date_of_birth = dob    || null;
        payload.gender        = gender || null;
        payload.doc_type      = docType;
        payload.doc_number    = docNumber || null;
        payload.grade         = grade  || null;
      } else if (clientType === 'adult') {
        payload.phone         = phone  || null;
        payload.date_of_birth = dob    || null;
        payload.gender        = gender || null;
      }

      if (clientType !== 'adult') {
        payload.guardian_doc_type   = guardianNumber ? guardianDocType : null;
        payload.guardian_doc_number = guardianNumber || null;
      }

      const putClient = (allowDuplicate: boolean) => fetch(
        `${BFF_URL}/api/v1/trainer/clients/${clientId}?type=${clientType}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify(allowDuplicate ? { ...payload, allow_duplicate: true } : payload),
        }
      );

      let res = await putClient(false);

      // Mismo documento en otra persona: se avisa y quien edita decide.
      if (res.status === 409) {
        const dup = await res.json().catch(() => ({} as any));
        if (dup?.code === 'DOC_DUPLICADO'
          && window.confirm(`${dup.error || 'Ya existe otra persona con ese documento.'}

¿Guardar de todos modos?`)) {
          res = await putClient(true);
        } else {
          throw new Error(dup?.error || 'Error al guardar');
        }
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err.error || 'Error al guardar');
      }

      toast({ title: '✅ Datos actualizados correctamente' });
      onSuccess();
      onClose();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const docTypeOptions =
    clientType === 'child'
      ? ['RC', 'TI', 'CC', 'CE', 'PP']
      : ['CC', 'CE', 'PP'];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            Editar Datos del Cliente
          </DialogTitle>
          <DialogDescription>
            Corrige la información registrada. Los cambios se aplican de inmediato.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">

          {/* Aviso para adultos con cuenta */}
          {clientType === 'adult' && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                El email no es editable porque está vinculado a la cuenta de autenticación del atleta.
              </AlertDescription>
            </Alert>
          )}

          {/* Nombre */}
          <div className="space-y-1.5">
            <Label>Nombre Completo *</Label>
            <Input
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Carlos Martínez"
            />
          </div>

          {/* Documento — no disponible para adultos con cuenta */}
          {clientType !== 'adult' && (
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Tipo Doc.</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {docTypeOptions.map(d => (
                      <SelectItem key={d} value={d}>{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label>Número de Documento</Label>
                <Input
                  value={docNumber}
                  onChange={e => setDocNumber(e.target.value)}
                  placeholder="1020304050"
                />
              </div>
            </div>
          )}

          {/* Documento del acudiente — menores y no registrados */}
          {clientType !== 'adult' && (
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">Documento del acudiente</Label>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>Tipo Doc.</Label>
                  <Select value={guardianDocType} onValueChange={setGuardianDocType}>
                    <SelectTrigger aria-label="Tipo de documento del acudiente"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GUARDIAN_DOC_TYPES.map(d => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <Label>Número</Label>
                  <Input
                    aria-label="Número de documento del acudiente"
                    value={guardianDocNumber}
                    onChange={e => setGuardianDocNumber(e.target.value)}
                    maxLength={20}
                    placeholder="1020304050"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Documento del adulto con cuenta — solo lectura */}
          {clientType === 'adult' && (initialData.profile_doc_number || initialData.doc_number) && (
            <div className="space-y-1.5">
              <Label>Documento</Label>
              <Input
                readOnly
                disabled
                value={`${initialData.profile_doc_type || initialData.doc_type || ''} ${initialData.profile_doc_number || initialData.doc_number || ''}`.trim()}
              />
              <p className="text-xs text-muted-foreground">Vinculado a su cuenta; no se edita aquí.</p>
            </div>
          )}

          {/* Email — solo para no registrados */}
          {clientType === 'unregistered' && (
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="ejemplo@correo.com"
              />
            </div>
          )}

          {/* Teléfono — no para menores */}
          {clientType !== 'child' && (
            <div className="space-y-1.5">
              <Label>Teléfono</Label>
              <PhoneInput value={phone} onChange={setPhone} />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {/* Fecha de nacimiento */}
            <div className="space-y-1.5 flex flex-col">
              <Label className="mb-1.5">Fecha de Nacimiento</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant={"outline"}
                    className={cn(
                      "w-full pl-3 text-left font-normal",
                      !dob && "text-muted-foreground"
                    )}
                  >
                    {dob ? (
                      format(new Date(dob + 'T12:00:00'), "PPP", { locale: es })
                    ) : (
                      <span>Seleccionar fecha</span>
                    )}
                    <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dob ? new Date(dob + 'T12:00:00') : undefined}
                    onSelect={(date) => {
                      if (date) {
                        const year = date.getFullYear();
                        const month = String(date.getMonth() + 1).padStart(2, '0');
                        const day = String(date.getDate()).padStart(2, '0');
                        setDob(`${year}-${month}-${day}`);
                      }
                    }}
                    captionLayout="dropdown-buttons"
                    fromYear={1920}
                    toYear={new Date().getFullYear()}
                    disabled={(date) =>
                      date > new Date() || date < new Date("1900-01-01")
                    }
                    initialFocus
                    locale={es}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Género */}
            <div className="space-y-1.5">
              <Label>Género</Label>
              <Select value={gender || 'unset'} onValueChange={v => setGender(v === 'unset' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">Sin especificar</SelectItem>
                  <SelectItem value="male">Masculino</SelectItem>
                  <SelectItem value="female">Femenino</SelectItem>
                  <SelectItem value="other">Otro</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Grado — solo para menores */}
          {clientType === 'child' && (
            <div className="space-y-1.5">
              <Label>Grado Escolar</Label>
              <Input
                value={grade}
                onChange={e => setGrade(e.target.value)}
                placeholder="Ej: 6A, Primaria"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Guardando...</>
              : 'Guardar Cambios'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
