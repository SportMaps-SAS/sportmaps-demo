/**
 * Desde M1 (20261030123543) `school_signup_leads` tiene DOS FK a `school_trial_slots`
 * (`trial_slot_id` = agendada, `cupo_separado_slot_id` = separada esperando el
 * comprobante). Un embed sin pista —`school_trial_slots(…)` o `school_trial_slots!inner(…)`—
 * es ambiguo: PostgREST responde PGRST201 y el código que lo envuelve en try/catch
 * devuelve «nada». Así se apagaron en silencio, del 30-oct al 4-nov, el recordatorio de la
 * víspera, la reserva vigente y el ciclo después de la clase.
 *
 * La prueba lee el código: ningún embed de franjas sin decir por cuál FK va.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RAIZ = join(__dirname, '..');

function archivos(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return archivos(p);
        return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
    });
}

describe('embeds de school_trial_slots desde los leads', () => {
    it('todo embed dice la FK (school_signup_leads_trial_slot_id_fkey o la del cupo separado)', () => {
        const ambiguos: string[] = [];
        for (const f of archivos(RAIZ)) {
            const lineas = readFileSync(f, 'utf8').split('\n');
            lineas.forEach((l, i) => {
                if (/^\s*(\/\/|\*|\/\*)/.test(l)) return; // comentarios
                if (/school_trial_slots(!inner)?\s*\(/.test(l) && !/from\(\s*'school_trial_slots'/.test(l)) {
                    ambiguos.push(`${relative(RAIZ, f)}:${i + 1}`);
                }
            });
        }
        expect(ambiguos).toEqual([]);
    });
});
