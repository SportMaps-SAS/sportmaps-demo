/**
 * (Auditoría Monster 2026-11-26, bug 1) «voleibol» convertía cualquier conversación en la venta del Vacacional.
 *
 * `tokensDistintivos("Vacacional de voleibol — Sede Suba")` dejaba «voleibol» (y «suba») como palabras que
 * identifican el ítem; `inferirPorNombre` (anuncio-destino) e `itemNombradoEn` (venta-contexto) las usan, así que
 * «Jugué voleibol en el colegio», el texto de convocatorias que pega la escuela o un flyer de torneo reenviado
 * salían como el Vacacional. El arreglo va en el ORIGEN (whatsapp-venta-servicios.service.ts): los deportes, el
 * club, las sedes y los barrios no identifican un ítem; hace falta una palabra suya («vacacional», «armadores»).
 *
 * Textos reales del 26-nov (scratchpad/auditoria/dia_11-26.txt, sim4.txt) y catálogo real (fixture.json).
 */
import { describe, it, expect } from 'vitest';
import { tokensDistintivos, preguntaPorServicio, serviciosNombrados } from './whatsapp-venta-servicios.service';
import { itemNombradoEn, ventaActiva } from './whatsapp-venta-contexto';
import { inferirServicio, type ItemConFicha } from './whatsapp-anuncio-destino';
import type { FilaReciente } from './whatsapp-reglas-turno';

const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional',
    price: 100000, active: true, event_id: null, starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-11T16:00:00Z',
};
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 350000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
};
const COPA: ItemConFicha = {
    id: '11111111-2222-3333-4444-555555555555', name: 'Copa Relámpago Indoor', kind: 'torneo', price: 80000, active: true, event_id: null,
};
const SOLO_VACACIONAL = [VACACIONAL];

// Textos reales que daban el Vacacional (sim4.txt, «UNIDAD itemNombradoEn (catálogo vigente real)»).
const PEGADO_POR_LA_ESCUELA = '¡Queremos conocerte y conocer tu experiencia en el voleibol! Para orientarte hacia la convocatoria que mejor se adapte a tu perfil, cuéntanos: - *Año de nacimiento:* - *Trayectoria deportiva:* ¿En qué clubes has entrenado y en qué torneos has participado? - *Posición de juego:* ¿En qué posición juegas habitualmente? - *Género:* ¿Masculino o femenino?';
const NO_SON_EL_VACACIONAL = [
    'Jugué voleibol en el colegio',
    'Jugué voleibol en el colegio, quiero entrar al club',
    PEGADO_POR_LA_ESCUELA,
    '¡Hola! 🏐 En diciembre abrimos convocatorias de voleibol para armar nuestros equipos 2027.',
    'En el Club e.a.r Buster voleibol Torneo Zentasticos',
    'Duitama se prepara para recibir el mejor voleibol formativo del país',
    '¡Hola! Quiero inscribirme a la convocatoria de suba',
    '¿Tienen voleibol en la sede Suba?',
];

describe('tokensDistintivos: deportes, club, sedes y barrios no identifican un ítem', () => {
    it('«Vacacional de voleibol — Sede Suba» → solo «vacacional»', () => {
        expect(tokensDistintivos(VACACIONAL.name)).toEqual(['vacacional']);
    });
    it('lo que va desde «Sede» es el lugar, también sin separador', () => {
        expect(tokensDistintivos('Vacacional Sede Parque Pinar de Suba')).toEqual(['vacacional']);
        expect(tokensDistintivos('Campamento de fútbol (Sede Norte)')).toEqual(['campamento']);
    });
    it('los nombres propios del ítem siguen contando', () => {
        expect(tokensDistintivos(CLINICA.name)).toEqual(['clinica', 'armadores', 'atacantes']);
        expect(tokensDistintivos(COPA.name)).toEqual(['copa', 'relampago', 'indoor']);
        expect(tokensDistintivos('Torneo Fénix de baloncesto 2026')).toEqual(['torneo', 'fenix']);
        expect(tokensDistintivos('Clase de perfeccionamiento de natación')).toEqual(['perfeccionamiento']);
    });
});

describe('itemNombradoEn / inferirServicio: «voleibol» no es el Vacacional', () => {
    for (const texto of NO_SON_EL_VACACIONAL) {
        it(`«${texto.slice(0, 60)}» → ningún ítem`, () => {
            expect(itemNombradoEn(texto, SOLO_VACACIONAL)).toBeNull();
            expect(itemNombradoEn(texto, [VACACIONAL, CLINICA])).toBeNull();
            const inf = inferirServicio([texto], SOLO_VACACIONAL);
            expect(inf.tipo === 'uno' ? inf.item.id : inf.tipo).not.toBe(VACACIONAL.id);
        });
    }

    it('flyer de torneo reenviado: es un torneo sin servicio, no el Vacacional', () => {
        const inf = inferirServicio(['En el Club e.a.r Buster voleibol Torneo Zentasticos'], SOLO_VACACIONAL);
        expect(inf.tipo).toBe('evento_sin_servicio');
    });

    it('lo legítimo sigue: «vacacional» (o su nombre completo) sí es el Vacacional', () => {
        for (const t of ['Hola, info del vacacional', 'Quiero inscribir a mi hija en el vacacional de voleibol',
            'vacacional de voleibol sede suba', 'Vacacional']) {
            expect(itemNombradoEn(t, [VACACIONAL, CLINICA])?.id, t).toBe(VACACIONAL.id);
        }
        expect(itemNombradoEn('Quisiera info de la clínica de armadores', [VACACIONAL, CLINICA])?.id).toBe(CLINICA.id);
        expect(itemNombradoEn('quiero inscribirme a la copa relampago indoor', [VACACIONAL, COPA])?.id).toBe(COPA.id);
    });
});

describe('preguntaPorServicio / serviciosNombrados: el deporte no nombra el servicio', () => {
    it('«¿tienen voleibol para niños?» no pregunta por el Vacacional', () => {
        expect(preguntaPorServicio('¿tienen voleibol para niños?', [VACACIONAL.name])).toBe(false);
        expect(serviciosNombrados('¿tienen voleibol en suba?', [{ id: VACACIONAL.id, nombre: VACACIONAL.name, tipo: 'clase_extra' } as any]))
            .toEqual([]);
    });
});

describe('ventaActiva: el texto de convocatorias que pega la escuela no abre la venta del Vacacional', () => {
    const AHORA = new Date('2026-11-26T18:00:00Z').getTime();
    const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
    it('saliente de una persona (≥ 60 letras) con «voleibol» → sin venta', () => {
        const m: FilaReciente[] = [
            { direction: 'inbound', type: 'text', text_body: 'Club y torneos', created_at: hace(30) },
            { direction: 'outbound', type: 'text', text_body: PEGADO_POR_LA_ESCUELA, created_at: hace(20), ai_generated: false },
            { direction: 'inbound', type: 'text', text_body: '2006 Jugue en el club wizard, punta receptora, masculino', created_at: hace(10) },
        ];
        expect(ventaActiva(m, SOLO_VACACIONAL, { ahora: AHORA })).toBeNull();
    });
});
