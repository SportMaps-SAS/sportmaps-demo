/**
 * Plantillas de UTILIDAD de la clase de prueba (Monster, 2026-10-30): en el
 * catálogo de conceptos, con su JSON del repo, sin botón URL (salen sin token) y
 * sin «gratis» ni «cortesía».
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../config/supabase', () => ({ supabase: {} }));
import { CONCEPTOS, variablesDelCuerpo, tieneBotonUrlDinamico, renderizarCuerpo } from './whatsapp-plantillas.service';

const leer = (nombre: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../whatsapp-templates', `${nombre}.json`), 'utf8'));
const DATOS = {
    nombreContacto: 'Carolina', nombreAtleta: 'Mariana', nombreEscuela: 'Club Monsters Volley', monto: '$15.000',
    dia: 'sábado 31 de octubre', hora: '8:00 a. m.', sede: 'Sede Norte (Calle 201 #67-12)', vence: 'hoy a las 4:00 p. m.', motivo: 'lluvia',
};

describe.each([
    ['recordatorio_clase_prueba', ['Ahí estaremos', 'Cambiar horario', 'No puedo ir']],
    ['clase_prueba_cupo_por_vencer', []],
    ['clase_prueba_reprogramada', ['Elegir otro horario']],
] as const)('%s', (concepto, botones) => {
    const def = CONCEPTOS[concepto];
    const json = leer(def.plantilla);

    it('UTILITY, es_CO, no es cobro', () => {
        expect(json).toMatchObject({ name: def.plantilla, language: 'es_CO', category: 'UTILITY' });
        expect(def.esCobro).toBe(false);
    });

    it('tantas variables como el cuerpo y todas llenas', () => {
        const vars = def.variables(DATOS);
        expect(vars).toHaveLength(variablesDelCuerpo(json.components));
        expect(vars.every((v) => typeof v === 'string' && v.trim())).toBe(true);
        expect(renderizarCuerpo(json.components, vars as string[])).not.toMatch(/\{\{\d\}\}|gratis|cortes[ií]a/i);
    });

    it('botones de respuesta rápida (sin URL: sale sin token)', () => {
        expect(tieneBotonUrlDinamico(json.components)).toBe(false);
        const b = json.components.find((c: any) => c.type === 'BUTTONS')?.buttons ?? [];
        expect(b.map((x: any) => x.text)).toEqual(botones);
        expect(b.every((x: any) => x.type === 'QUICK_REPLY' && Array.from(x.text as string).length <= 25)).toBe(true);
    });
});
