// Humo: el mundo t1 se levanta (actores con JWT real, 3 escuelas, 6 canchas, tarifas) y el BFF responde.
import { describe, it, expect, afterAll } from 'vitest';
import { levantarMundo, closeDb, get, q } from './helpers/gemelo';

describe('mundo t1', () => {
    afterAll(closeDb);
    it('crea actores y escuelas', async () => {
        const m = await levantarMundo();
        expect(Object.keys(m.jwt).length).toBe(11);
        const rows = await q(`select has_entitlement(id,'reservations') ent, name from schools where name like 't1-%' order by name`);
        expect(rows.map((r: any) => r.ent)).toEqual([true, true, true]);
        const h = await get('/health');
        expect(h.status).toBe(200);
    });
});
