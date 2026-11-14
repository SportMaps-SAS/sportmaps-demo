/**
 * Paso opcional del onboarding de acudiente y deportista: «¿Ya tienes escuela?
 * Ingresa su código». Solo captura el código; al terminar el onboarding se
 * continúa en /unirse?codigo=…, que muestra la escuela y envía la solicitud.
 */
import { Input } from '@/components/ui/input';
import { KeyRound } from 'lucide-react';
import { formatJoinCode, isJoinCodeShape } from '@/lib/schoolJoinCode';

export function OnboardingSchoolCodeField({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const showShapeHint = value.trim().length >= 7 && !isJoinCodeShape(value);
  return (
    <div className="rounded-xl border bg-muted/30 p-4 space-y-2 text-left">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold">¿Ya tienes escuela? Ingresa su código</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Opcional. Si tu escuela te dio un código (por ejemplo BES-4K7Q), escríbelo y te unimos al terminar.
      </p>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        onBlur={() => value && isJoinCodeShape(value) && onChange(formatJoinCode(value))}
        placeholder="BES-4K7Q"
        autoCapitalize="characters"
        autoComplete="off"
        maxLength={12}
        className="font-mono tracking-widest text-center text-[16px] sm:text-base"
      />
      {showShapeHint && (
        <p className="text-xs text-destructive">Revisa el código: son 3 letras y 4 caracteres.</p>
      )}
    </div>
  );
}
