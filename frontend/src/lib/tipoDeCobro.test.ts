import { describe, it, expect } from 'vitest';
import {
    contarPorTipo,
    etiquetaDeFiltro,
    nombreDeQuienAsiste,
    textoDeTipo,
    tipoDeCobro,
} from './tipoDeCobro';

// Gestión de Pagos por tipo (blindaje de ventas de servicio §4.D, 2026-11-08).
// El caso que lo originó: el único cobro de la clínica de Monster (payments
// 8582859b) salía «Sin nombre» y como «clase extra».

const CLINICA_PROSPECTO = {
    payment_category: 'clase_extra',
    concept: 'Clínica de armadores y atacantes — Nicolás Cubides',
    child_id: null,
    parent_id: null,
    user_id: null,
    unregistered_athlete_id: null,
    signup_lead_id: 'lead-1',
};

describe('tipoDeCobro', () => {
    it('clínica de un prospecto: «Clínica» con el nombre del servicio, no «Clase extra»', () => {
        const t = tipoDeCobro(CLINICA_PROSPECTO);
        expect(t.clave).toBe('clinica');
        expect(t.etiqueta).toBe('Clínica');
        expect(t.servicio).toBe('Clínica de armadores y atacantes');
        expect(textoDeTipo(t)).toBe('Clínica · Clínica de armadores y atacantes');
        expect(t.color).toMatch(/fuchsia/);
    });

    it('clase extra que no nombra clínica sigue siendo «Clase extra»', () => {
        const t = tipoDeCobro({ payment_category: 'clase_extra', concept: 'Horas adicionales · 3 h — Ana Ruiz' });
        expect(t.clave).toBe('clase_extra');
        expect(t.etiqueta).toBe('Clase extra');
        expect(t.servicio).toBe('Horas adicionales · 3 h');
    });

    it('clínica con categoría nula u «otro»: la detecta el concepto', () => {
        expect(tipoDeCobro({ payment_category: null, concept: 'CLINICA de saque — Pedro' }).clave).toBe('clinica');
        expect(tipoDeCobro({ payment_category: 'otro', concept: 'Clínica de bloqueo — Pedro' }).clave).toBe('clinica');
    });

    it('clase de prueba de un prospecto: sin servicio redundante', () => {
        const t = tipoDeCobro({ payment_category: 'clase_prueba', concept: 'Clase de prueba — Sofía Gómez' });
        expect(t.clave).toBe('clase_prueba');
        expect(t.etiqueta).toBe('Clase de prueba');
        expect(t.servicio).toBeNull();
        expect(textoDeTipo(t)).toBe('Clase de prueba');
    });

    it('clase de cortesía: misma clave que la clase de prueba, con su nombre', () => {
        const t = tipoDeCobro({ payment_category: 'clase_prueba', concept: 'Clase de cortesía — Sofía Gómez' });
        expect(t.clave).toBe('clase_prueba');
        expect(t.etiqueta).toBe('Clase de cortesía');
        expect(t.servicio).toBeNull();
        expect(etiquetaDeFiltro('clase_prueba')).toBe('Clase de prueba / cortesía');
        // Fila vieja sin categoría.
        expect(tipoDeCobro({ payment_category: null, concept: 'Clase de prueba — Ana' }).clave).toBe('clase_prueba');
    });

    it('mensualidad de deportista', () => {
        const t = tipoDeCobro({ payment_category: 'mensualidad', concept: 'Plan PLAN PRO - 11/2026' });
        expect(t).toMatchObject({ clave: 'mensualidad', etiqueta: 'Mensualidad', servicio: null });
    });

    it('categoría nula con concepto «Mensualidad 11/2026 - X» es mensualidad', () => {
        const t = tipoDeCobro({ payment_category: null, concept: 'Mensualidad 11/2026 - Zoe Barrera' });
        expect(t).toMatchObject({ clave: 'mensualidad', etiqueta: 'Mensualidad', servicio: null });
        // NULL sin pistas también (las del cron nacen así).
        expect(tipoDeCobro({ payment_category: null, concept: 'Equipo RM — Plan 3x semana' }).clave).toBe('mensualidad');
        expect(tipoDeCobro({}).clave).toBe('mensualidad');
    });

    it('torneo: quita el prefijo repetido del servicio', () => {
        const t = tipoDeCobro({ payment_category: 'torneo', concept: 'Torneo · Mayores Masculino — Juan Pérez' });
        expect(t.clave).toBe('torneo');
        expect(t.servicio).toBe('Mayores Masculino');
        expect(textoDeTipo(t)).toBe('Torneo · Mayores Masculino');
        expect(textoDeTipo(tipoDeCobro({ payment_category: 'torneo', concept: 'Torneo Relámpago — Juan' }))).toBe('Torneo · Torneo Relámpago');
        // Sin categoría, «Inscripción torneo» es plata del torneo.
        expect(tipoDeCobro({ payment_category: null, concept: 'Inscripción torneo — Juan' }).clave).toBe('torneo');
    });

    it('vacacional', () => {
        const t = tipoDeCobro({ payment_category: 'vacacional', concept: 'Vacacional de voleibol — Luisa Mora' });
        expect(t).toMatchObject({ clave: 'vacacional', etiqueta: 'Vacacional', servicio: 'Vacacional de voleibol' });
    });

    it('inscripción / matrícula', () => {
        const t = tipoDeCobro({ payment_category: 'inscripcion', concept: 'Inscripción — Zoe Barrera' });
        expect(t).toMatchObject({ clave: 'inscripcion', etiqueta: 'Inscripción / Matrícula', servicio: null });
        expect(tipoDeCobro({ payment_category: null, concept: 'Matrícula 2027' }).clave).toBe('inscripcion');
    });

    it('uniforme / artículos', () => {
        const t = tipoDeCobro({ payment_category: 'articulos', concept: 'Uniforme de entrenamiento — Zoe' });
        expect(t).toMatchObject({ clave: 'articulos', etiqueta: 'Uniformes / Artículos', servicio: 'Uniforme de entrenamiento' });
        expect(tipoDeCobro({ payment_category: null, concept: 'Uniforme talla 10' }).clave).toBe('articulos');
    });

    it('seguro, viaje, horas adicionales, reserva y otro', () => {
        expect(tipoDeCobro({ payment_category: 'seguro', concept: 'Seguro de accidentes — Zoe' })).toMatchObject({ clave: 'seguro', etiqueta: 'Seguro', servicio: null });
        expect(tipoDeCobro({ payment_category: 'viaje', concept: 'Viaje a Cali — Zoe' }).etiqueta).toBe('Viaje');
        expect(tipoDeCobro({ payment_category: 'excedente', concept: 'Horas' }).etiqueta).toBe('Horas adicionales');
        expect(tipoDeCobro({ payment_category: 'reserva', concept: 'Cancha 2' }).etiqueta).toBe('Reserva');
        expect(tipoDeCobro({ payment_category: 'otro', concept: 'Donación' }).clave).toBe('otro');
    });

    it('una categoría que el front no conoce cae en «Otro», no en mensualidad', () => {
        expect(tipoDeCobro({ payment_category: 'futura', concept: 'Algo' }).clave).toBe('otro');
    });

    it('contarPorTipo cuenta por clave', () => {
        expect(contarPorTipo([
            CLINICA_PROSPECTO,
            { payment_category: 'mensualidad', concept: 'x' },
            { payment_category: null, concept: 'Mensualidad 11/2026 - X' },
            { payment_category: 'clase_extra', concept: 'Clase de técnica' },
        ])).toEqual({ clinica: 1, mensualidad: 2, clase_extra: 1 });
    });
});

describe('nombreDeQuienAsiste', () => {
    it('clínica de un prospecto: el nombre sale del concepto y es externo', () => {
        expect(nombreDeQuienAsiste(CLINICA_PROSPECTO)).toEqual({ nombre: 'Nicolás Cubides', externo: true });
    });

    it('clase de prueba de un prospecto', () => {
        expect(nombreDeQuienAsiste({
            payment_category: 'clase_prueba', concept: 'Clase de prueba — Sofía Gómez', signup_lead_id: 'lead-2',
        })).toEqual({ nombre: 'Sofía Gómez', externo: true });
    });

    it('mensualidad de deportista: manda el nombre ya resuelto y no es externo', () => {
        expect(nombreDeQuienAsiste({
            payment_category: 'mensualidad', concept: 'Mensualidad 11/2026 - Zoe Barrera',
            child_id: 'c1', parent_id: 'p1', athlete_name: 'Zoe Barrera',
        })).toEqual({ nombre: 'Zoe Barrera', externo: false });
    });

    it('con alguien del club no lee el concepto (aunque traiga « — »)', () => {
        expect(nombreDeQuienAsiste({ concept: 'Torneo · Sub 12 — Juan', child_id: 'c1' })).toEqual({ nombre: null, externo: false });
        expect(nombreDeQuienAsiste({ concept: 'Torneo · Sub 12 — Juan', parent_id: 'p1' }).nombre).toBeNull();
    });

    it('prospecto que ya tiene ficha de deportista no es externo', () => {
        expect(nombreDeQuienAsiste({
            concept: 'Clase de prueba — Sofía', signup_lead_id: 'lead-2', unregistered_athlete_id: 'u1', athlete_name: 'Sofía Gómez',
        })).toEqual({ nombre: 'Sofía Gómez', externo: false });
    });

    it('sin nadie y sin « — » en el concepto: null (la pantalla dice «Sin nombre»)', () => {
        expect(nombreDeQuienAsiste({ concept: 'Clase de prueba' })).toEqual({ nombre: null, externo: false });
        expect(nombreDeQuienAsiste({ concept: 'Torneo — ' }).nombre).toBeNull();
    });
});
