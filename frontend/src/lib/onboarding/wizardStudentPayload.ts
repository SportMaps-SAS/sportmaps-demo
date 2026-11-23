// ============================================================================
// Alta del primer deportista desde el asistente de la academia (hallazgo F).
//
// Antes el asistente insertaba directo en `children` (con el primer equipo como
// única referencia) y nunca creaba inscripción: sin inscripción no nace ningún
// cobro, y la academia terminaba el asistente sin ver su primer resultado.
//
// Ahora, si la academia escoge un plan o un equipo, el alta va por el MISMO
// endpoint que «Agregar atleta» (POST /api/v1/students/create-one), que crea el
// deportista, la inscripción y el cobro en una transacción y toma el precio del
// plan o del equipo. Sin plan ni equipo se conserva el alta simple de antes: no
// se bloquea a quien aún no tiene nada creado.
// ============================================================================

export type WizardEnrollTarget =
  | { kind: 'plan'; planId: string; offeringId: string }
  | { kind: 'team'; teamId: string };

export interface WizardStudentInput {
  fullName: string;
  isAdult: boolean;
  parentName: string;
  parentEmail: string;
  parentPhone: string;
  target: WizardEnrollTarget | null;
  /** yyyy-mm-dd, día de hoy en Colombia (lo pone quien llama). */
  startDate: string;
}

export type WizardStudentPlan =
  | { mode: 'simple' }
  | { mode: 'create-one'; payload: Record<string, unknown> }
  | { mode: 'invalid'; message: string };

const digits = (v: string) => v.replace(/\D/g, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function planWizardStudentCreation(input: WizardStudentInput): WizardStudentPlan {
  const fullName = input.fullName.trim();
  if (fullName.length < 2) return { mode: 'invalid', message: 'Ingresa el nombre del atleta' };

  const target = input.target;
  if (!target) return { mode: 'simple' };

  const targetFields: Record<string, unknown> =
    target.kind === 'plan'
      ? { offering_plan_id: target.planId, offering_id: target.offeringId }
      : { team_id: target.teamId };
  const ids = target.kind === 'plan' ? [target.planId, target.offeringId] : [target.teamId];
  if (!ids.every((id) => UUID.test(id))) {
    return { mode: 'invalid', message: 'El plan o equipo elegido no es válido. Elígelo de nuevo.' };
  }

  const base = { ...targetFields, start_date: input.startDate };
  const email = input.parentEmail.trim().toLowerCase();
  const phone = digits(input.parentPhone);

  if (input.isAdult) {
    return {
      mode: 'create-one',
      payload: {
        type: 'unregistered_adult',
        ...base,
        full_name: fullName,
        email: email || null,
        phone: phone || null,
        send_invite: false,
      },
    };
  }

  // Menor con plan: el cobro necesita a quién dirigirse.
  if (input.parentName.trim().length < 2) {
    return { mode: 'invalid', message: 'Para inscribirlo con plan, escribe el nombre del acudiente' };
  }
  if (phone.length < 10) {
    return { mode: 'invalid', message: 'Para inscribirlo con plan, escribe el WhatsApp del acudiente (10 dígitos)' };
  }
  if (!email) {
    return { mode: 'invalid', message: 'Para inscribirlo con plan, escribe el correo del acudiente' };
  }

  return {
    mode: 'create-one',
    payload: {
      type: 'child',
      ...base,
      doc_type: 'TI',
      full_name: fullName,
      parent_name: input.parentName.trim(),
      parent_email: email,
      parent_phone: phone,
      send_invite: true,
    },
  };
}
