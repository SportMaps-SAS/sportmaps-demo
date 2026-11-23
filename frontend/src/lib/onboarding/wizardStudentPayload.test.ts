import { describe, expect, it } from 'vitest';
import { planWizardStudentCreation, type WizardStudentInput } from './wizardStudentPayload';

const PLAN = '6f1c2b3a-1111-4a2b-8c3d-000000000001';
const OFFERING = '6f1c2b3a-1111-4a2b-8c3d-000000000002';
const TEAM = '6f1c2b3a-1111-4a2b-8c3d-000000000003';

const menor: WizardStudentInput = {
  fullName: 'Atleta Ficticio',
  isAdult: false,
  parentName: 'Acudiente Ficticio',
  parentEmail: ' Acudiente@Example.invalid ',
  parentPhone: '300 000 0000',
  target: { kind: 'plan', planId: PLAN, offeringId: OFFERING },
  startDate: '2026-11-23',
};

describe('planWizardStudentCreation (hallazgo F)', () => {
  it('sin plan ni equipo conserva el alta simple de antes', () => {
    expect(planWizardStudentCreation({ ...menor, target: null })).toEqual({ mode: 'simple' });
  });

  it('menor con plan: va por create-one con plan, inscripción y acudiente normalizado', () => {
    const r = planWizardStudentCreation(menor);
    expect(r.mode).toBe('create-one');
    if (r.mode !== 'create-one') return;
    expect(r.payload).toMatchObject({
      type: 'child',
      offering_plan_id: PLAN,
      offering_id: OFFERING,
      start_date: '2026-11-23',
      full_name: 'Atleta Ficticio',
      parent_name: 'Acudiente Ficticio',
      parent_email: 'acudiente@example.invalid',
      parent_phone: '3000000000',
    });
    expect(r.payload).not.toHaveProperty('team_id');
  });

  it('con equipo manda team_id y no manda campos de plan', () => {
    const r = planWizardStudentCreation({ ...menor, target: { kind: 'team', teamId: TEAM } });
    expect(r.mode).toBe('create-one');
    if (r.mode !== 'create-one') return;
    expect(r.payload.team_id).toBe(TEAM);
    expect(r.payload).not.toHaveProperty('offering_plan_id');
    expect(r.payload).not.toHaveProperty('offering_id');
  });

  it('no manda monthly_fee: el precio lo toma el servidor del plan o del equipo', () => {
    const r = planWizardStudentCreation(menor);
    if (r.mode !== 'create-one') throw new Error('se esperaba create-one');
    expect(r.payload).not.toHaveProperty('monthly_fee');
  });

  it('adulto con plan: unregistered_adult, sin pedir datos de acudiente', () => {
    const r = planWizardStudentCreation({ ...menor, isAdult: true, parentName: '', parentEmail: '', parentPhone: '' });
    expect(r.mode).toBe('create-one');
    if (r.mode !== 'create-one') return;
    expect(r.payload).toMatchObject({ type: 'unregistered_adult', email: null, phone: null, send_invite: false });
    expect(r.payload).not.toHaveProperty('parent_name');
  });

  it('menor con plan sin datos del acudiente: avisa qué falta, no llama al servidor', () => {
    expect(planWizardStudentCreation({ ...menor, parentName: ' ' })).toMatchObject({ mode: 'invalid' });
    expect(planWizardStudentCreation({ ...menor, parentPhone: '12345' })).toMatchObject({ mode: 'invalid' });
    expect(planWizardStudentCreation({ ...menor, parentEmail: '' })).toMatchObject({ mode: 'invalid' });
  });

  it('rechaza ids que no son uuid', () => {
    expect(planWizardStudentCreation({ ...menor, target: { kind: 'team', teamId: 'no-es-uuid' } })).toMatchObject({ mode: 'invalid' });
  });

  it('nombre muy corto es inválido, con o sin plan', () => {
    expect(planWizardStudentCreation({ ...menor, fullName: 'A' })).toMatchObject({ mode: 'invalid' });
    expect(planWizardStudentCreation({ ...menor, fullName: ' ', target: null })).toMatchObject({ mode: 'invalid' });
  });
});
