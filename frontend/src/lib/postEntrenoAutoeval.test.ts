import { describe, it, expect } from 'vitest';
import {
  BORG_OPTIONS,
  COMPREHENSION_OPTIONS,
  EFFORT_OPTIONS,
  EMPTY_ANSWERS,
  SATISFACTION_OPTIONS,
  buildPayload,
  isAnswered,
  plazoAutoeval,
  sessionDateLabel,
  toggleFocus,
} from './postEntrenoAutoeval';

describe('autoevaluación post-entreno · valores que guarda la RPC', () => {
  it('no cambia los valores de cada pregunta', () => {
    expect(BORG_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(COMPREHENSION_OPTIONS.map((o) => o.value)).toEqual([1, 2, 3, 4]);
    expect(EFFORT_OPTIONS.map((o) => o.value).sort((a, b) => a - b)).toEqual([50, 60, 70, 80, 90, 100]);
    expect(SATISFACTION_OPTIONS.map((o) => o.value).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('los textos son neutros en género', () => {
    const all = [...BORG_OPTIONS, ...COMPREHENSION_OPTIONS, ...EFFORT_OPTIONS, ...SATISFACTION_OPTIONS].map((o) => o.label).join(' ');
    expect(all).not.toMatch(/satisfecha|cansada|contenta/i);
  });

  it('arma el p_answers igual que antes del rediseño', () => {
    const a = { ...EMPTY_ANSWERS, rpe_borg: 7, task_comprehension: 1, self_effort_pct: 90, satisfaction: 3 };
    expect(buildPayload(a)).toEqual({ rpe_borg: 7, task_comprehension: 1, self_effort_pct: 90, satisfaction: 3 });

    const conFoco = { ...a, focus: ['focus_regate', 'focus_other'], focus_other_text: '  la zurda  ' };
    expect(buildPayload(conFoco)).toEqual({
      rpe_borg: 7, task_comprehension: 1, self_effort_pct: 90, satisfaction: 3,
      focus: ['focus_regate', 'focus_other'],
      focus_other_text: 'la zurda',
    });

    // «Otro» sin texto: va el foco, no el texto vacío.
    expect(buildPayload({ ...a, focus: ['focus_other'], focus_other_text: '  ' })).not.toHaveProperty('focus_other_text');
  });

  it('las preguntas 1–4 exigen respuesta; la 5 es opcional', () => {
    expect(isAnswered(1, EMPTY_ANSWERS)).toBe(false);
    expect(isAnswered(1, { ...EMPTY_ANSWERS, rpe_borg: 0 })).toBe(true); // 0 es una respuesta válida
    expect(isAnswered(5, EMPTY_ANSWERS)).toBe(true);
  });

  it('marca y desmarca un foco', () => {
    const uno = toggleFocus(EMPTY_ANSWERS, 'focus_regate');
    expect(uno.focus).toEqual(['focus_regate']);
    expect(toggleFocus(uno, 'focus_regate').focus).toEqual([]);
  });

  it('la fecha del entreno no se corre un día', () => {
    expect(sessionDateLabel('2026-07-31')).toMatch(/^Viernes 31 de julio$/);
    expect(sessionDateLabel(null)).toBe('');
  });
});

describe('plazo para responder (misma regla que post_training_plazo_respuesta)', () => {
  it('se responde hasta el final del día siguiente al cierre, en hora de Bogotá', () => {
    // Cerrada el 29 a las 23:55 COT (04:55 UTC del 30) → todo el 30.
    expect(plazoAutoeval('2026-10-30T04:55:00Z', null)?.toISOString()).toBe('2026-10-31T05:00:00.000Z');
    // Cerrada el 29 a las 00:10 COT → también hasta el final del 30.
    expect(plazoAutoeval('2026-10-29T05:10:00Z', null)?.toISOString()).toBe('2026-10-31T05:00:00.000Z');
  });

  it('el cierre automático cuenta desde updated_at, no desde la hora del entreno', () => {
    // Besser 10-24: finalized_at = 24 a las 23:59, cerrada de verdad el 28 a las 23:55.
    expect(plazoAutoeval('2026-10-25T04:59:00Z', '2026-10-29T04:55:00Z')?.toISOString()).toBe('2026-10-30T05:00:00.000Z');
  });

  it('sin fechas no hay plazo', () => {
    expect(plazoAutoeval(null, null)).toBeNull();
    expect(plazoAutoeval(undefined, 'no-es-fecha')).toBeNull();
  });
});
