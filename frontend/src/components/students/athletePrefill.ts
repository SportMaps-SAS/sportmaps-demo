/** Datos con que abre el alta (p. ej. desde un prospecto de clase de prueba). */
export interface AthletePrefill {
  fullName?: string;
  parentName?: string;
  phone?: string;
}

/** Teléfono guardado en dígitos → como lo muestra el formulario (+57…). */
export function phoneForForm(phone?: string | null): string {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (!d) return '+57';
  if (d.length === 10 && d.startsWith('3')) return `+57${d}`;
  return `+${d}`;
}
