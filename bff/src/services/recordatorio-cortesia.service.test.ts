import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    aFormatoWhatsApp: (t: string) => t,
    decryptToken: () => 'token',
}));

const svc = await import('./recordatorio-cortesia.service');
const cortesia = await import('./whatsapp-clase-cortesia.service');
const { runRecordatorioCortesia, tocaMismoDia, textoRecordatorio, nombresDelLead, sedeParaPlantilla, ahoraBogota } = svc;

// Martes 2026-10-06 18:00 COT = 23:00 UTC. Mañana = miércoles 2026-10-07.
const VISPERA = new Date('2026-10-06T23:00:00Z');

const INTEG = {
    id: 'integ-1', school_id: 'school-1', phone_number_id: 'pn', waba_id: 'waba', display_phone_number: null,
    access_token_encrypted: 'x', verify_token: null, status: 'active',
};

function reserva(extra: Partial<any> = {}): any {
    return {
        leadId: 'lead-1', schoolId: 'school-1', nombre: 'SAMUEL PEREZ GOMEZ', acudiente: 'Carolina Gomez',
        telefono: '3001234567', creadaEn: '2026-10-03T15:00:00Z',
        slot: { id: 'slot-1', label: 'Sub-11', slot_date: '2026-10-07', start_time: '16:00', end_time: '17:30', location: 'Coliseo Dynasty' },
        ...extra,
    };
}

let reservados: string[];
let cierres: any[];
let deps: any;

beforeEach(() => {
    reservados = [];
    cierres = [];
    deps = {
        reservasDelDia: vi.fn(async () => [reserva()]),
        integracion: vi.fn(async () => INTEG),
        conversacion: vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-03T15:00:00Z' })),
        escuela: vi.fn(async () => ({ nombre: 'Dynasty Volley Club', sedes: [{ name: 'Coliseo Dynasty DC', address: 'Cl. 12 Bis #71g-09', is_main: true }] })),
        reservar: vi.fn(async (r: any, tipo: string) => {
            const k = `${r.leadId}|${r.slot.id}|${tipo}`;
            if (reservados.includes(k)) return { estado: 'ya' };
            reservados.push(k);
            return { estado: 'ok', id: `rec-${reservados.length}` };
        }),
        cerrar: vi.fn(async (id: string, c: any) => { cierres.push({ id, ...c }); }),
        botEncendido: vi.fn(async () => true),
        tomada: vi.fn(async () => false),
        dadoDeBaja: vi.fn(async () => false),
        enviarTexto: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.T' })),
        registrarTexto: vi.fn(async () => undefined),
        enviarPlantilla: vi.fn(async () => ({ enviado: true, waMessageId: 'wamid.P', plantilla: 'recordatorio_clase_cortesia' })),
    };
});

describe('puras', () => {
    it('ahoraBogota: UTC-5', () => {
        expect(ahoraBogota(VISPERA)).toEqual({ iso: '2026-10-06', minutos: 18 * 60 });
    });

    it('mismo día: entre 2 h 30 y 3 h 15 antes, y solo de 7:00 a 20:00', () => {
        expect(tocaMismoDia('16:00', 13 * 60)).toBe(true);        // 3 h antes
        expect(tocaMismoDia('16:00', 13 * 60 + 30)).toBe(true);   // 2 h 30
        expect(tocaMismoDia('16:00', 14 * 60)).toBe(false);       // 2 h: tarde
        expect(tocaMismoDia('16:00', 12 * 60)).toBe(false);       // 4 h: temprano
        expect(tocaMismoDia('08:00', 5 * 60)).toBe(false);        // 5:00 a. m.: no
        expect(tocaMismoDia('23:00', 20 * 60)).toBe(false);       // 8:00 p. m.: no
    });

    it('saluda al acudiente y nombra al deportista', () => {
        expect(nombresDelLead({ full_name: 'SAMUEL PEREZ GOMEZ', guardian_name: 'carolina gomez' }))
            .toEqual({ saludo: 'Carolina', atleta: 'Samuel Perez' });
        expect(nombresDelLead({ full_name: 'Laura Ruiz', guardian_name: null })).toEqual({ saludo: 'Laura', atleta: 'Laura Ruiz' });
    });

    it('el texto trae día, hora, sede, qué llevar y CANCELAR', () => {
        const t = textoRecordatorio('vispera', {
            saludo: 'Carolina', atleta: 'Samuel Perez', esAcudiente: true, escuela: 'Dynasty',
            franja: { id: 's', grupo: 'Sub-11', fecha: '2026-10-07', horaInicio: '16:00', horaFin: '17:30', sede: 'Coliseo', cupos: 0, direccion: 'Cl. 12' },
        });
        expect(t).toMatch(/clase de cortesía de \*Samuel Perez\* mañana/);
        expect(t).toContain('miércoles 7 de octubre');
        expect(t).toContain('4:00 p. m.');
        expect(t).toContain('Coliseo (Cl. 12)');
        expect(t).toContain(cortesia.QUE_LLEVAR);
        expect(t).toContain('*CANCELAR*');
    });

    it('sede de la plantilla: la de la franja; si no, la principal', () => {
        const f: any = { sede: null, direccion: null };
        expect(sedeParaPlantilla(f, { name: 'Coliseo', address: 'Cl. 12' })).toBe('Coliseo (Cl. 12)');
        expect(sedeParaPlantilla(f, null)).toBe('la sede de la escuela');
    });
});

describe('víspera', () => {
    it('ventana cerrada → plantilla recordatorio_clase_cortesia con las variables y el estado del flujo', async () => {
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(deps.reservasDelDia).toHaveBeenCalledWith('2026-10-07');
        expect(r).toMatchObject({ candidatas: 1, enviados: 1 });
        expect(deps.enviarTexto).not.toHaveBeenCalled();
        const arg = deps.enviarPlantilla.mock.calls[0][0];
        expect(arg).toMatchObject({ concepto: 'recordatorio_clase_cortesia', telefono: '573001234567', schoolId: 'school-1' });
        expect(arg.datos).toMatchObject({
            nombreContacto: 'Carolina', nombreEscuela: 'Dynasty Volley Club',
            dia: 'miércoles 7 de octubre', hora: '4:00 p. m.', sede: 'Coliseo Dynasty (Cl. 12 Bis #71g-09)',
        });
        expect(arg.payloadExtra).toMatchObject({ flujo: cortesia.FLUJO_CORTESIA, paso_cortesia: 'recordatorio' });
        expect(cierres[0]).toMatchObject({ estado: 'enviado', canal: 'plantilla' });
    });

    it('idempotente: la segunda corrida (otro BFF) no manda nada', async () => {
        await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        const r2 = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r2.enviados).toBe(0);
        expect(deps.enviarPlantilla).toHaveBeenCalledTimes(1);
    });

    it('ventana abierta → texto con botón y estado del flujo en el saliente', async () => {
        deps.conversacion = vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-06T20:00:00Z' }));
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r.enviados).toBe(1);
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
        expect(deps.registrarTexto.mock.calls[0][0].payload).toMatchObject({ paso_cortesia: 'recordatorio', step: 'recordatorio_cortesia_vispera' });
        expect(cierres[0]).toMatchObject({ estado: 'enviado', canal: 'texto' });
    });

    it('plantilla sin aprobar o sin opt-in: queda no_enviado con el motivo', async () => {
        deps.enviarPlantilla = vi.fn(async () => ({ enviado: false, motivo: 'sin_optin' }));
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r.noEnviados).toBe(1);
        expect(cierres[0]).toMatchObject({ estado: 'no_enviado', motivo: 'sin_optin' });
    });

    it('dado de baja con la ventana abierta: no se le escribe', async () => {
        deps.conversacion = vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-06T20:00:00Z' }));
        deps.dadoDeBaja = vi.fn(async () => true);
        await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(deps.enviarTexto).not.toHaveBeenCalled();
        expect(cierres[0]).toMatchObject({ estado: 'no_enviado', motivo: 'dado_de_baja' });
    });

    it('bot apagado o conversación tomada: nada', async () => {
        deps.botEncendido = vi.fn(async () => false);
        await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
        expect(cierres[0].motivo).toBe('bot_apagado');
    });

    it('sin teléfono de WhatsApp, sin integración o reserva de hace minutos: ni se reserva', async () => {
        deps.reservasDelDia = vi.fn(async () => [
            reserva({ leadId: 'fijo', telefono: '6015551234' }),
            reserva({ leadId: 'reciente', creadaEn: '2026-10-06T22:30:00Z' }),
        ]);
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r.omitidos).toBe(2);
        expect(deps.reservar).not.toHaveBeenCalled();
    });

    it('sin la tabla (migración sin aplicar) no manda nada', async () => {
        deps.reservar = vi.fn(async () => ({ estado: 'sin_tabla' }));
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r.sinTabla).toBe(true);
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
    });
});

describe('mismo día', () => {
    // Miércoles 2026-10-07 13:00 COT = 18:00 UTC; la clase es a las 16:00.
    const MEDIODIA = new Date('2026-10-07T18:00:00Z');

    it('ventana abierta → texto «hoy»', async () => {
        deps.conversacion = vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-07T12:00:00Z' }));
        const r = await runRecordatorioCortesia('mismo_dia', { ahora: MEDIODIA, deps });
        expect(deps.reservasDelDia).toHaveBeenCalledWith('2026-10-07');
        expect(r.enviados).toBe(1);
        expect(deps.enviarTexto.mock.calls[0][2]).toMatch(/ hoy en \*Dynasty Volley Club\*/);
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
    });

    it('ventana cerrada → nada, y no se reserva (un tick posterior puede mandarlo)', async () => {
        const r = await runRecordatorioCortesia('mismo_dia', { ahora: MEDIODIA, deps });
        expect(r.enviados).toBe(0);
        expect(deps.reservar).not.toHaveBeenCalled();
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
    });

    it('fuera del rango de 3 h: no aplica', async () => {
        deps.conversacion = vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-07T12:00:00Z' }));
        const r = await runRecordatorioCortesia('mismo_dia', { ahora: new Date('2026-10-07T15:00:00Z'), deps }); // 10:00
        expect(r.candidatas).toBe(0);
    });
});

describe('respuesta «CANCELAR» al recordatorio', () => {
    const franja = { id: 'slot-1', grupo: 'Sub-11', fecha: '2026-10-07', horaInicio: '16:00', horaFin: null, sede: null, cupos: 0 };

    function ctx(extra: Partial<any> = {}) {
        const enviados: any[] = [];
        const c: any = {
            conversationId: 'conv-1', schoolId: 'school-1', contactWaId: '573001234567',
            enviar: vi.fn(async (texto: string, step: string, estado: any) => { enviados.push({ texto, step, estado }); }),
            leerEstado: async () => ({ paso: 'recordatorio', datos: { franja, nombre: 'Samuel' } }),
            cancelar: vi.fn(async () => ({ ok: true, franja })),
            avisarEscuela: vi.fn(async () => undefined),
            reservaVigente: async () => ({ leadId: 'lead-1', nombre: 'Samuel', franja }),
            ahora: () => new Date('2026-10-07T12:00:00Z'),
            ...extra,
        };
        return { c, enviados };
    }

    it('«CANCELAR» libera el cupo con la RPC y avisa a la escuela', async () => {
        const { c, enviados } = ctx();
        expect(await cortesia.atenderTurnoCortesia(c, 'CANCELAR', null, { iniciar: false })).toBe(true);
        expect(c.cancelar).toHaveBeenCalledWith('school-1', '573001234567');
        expect(enviados[0].step).toBe('cortesia_cancelada');
        expect(c.avisarEscuela).toHaveBeenCalled();
    });

    it('«no puedo ir» también; «gracias, allá estaremos» no es para el flujo', async () => {
        const a = ctx();
        expect(await cortesia.atenderTurnoCortesia(a.c, 'Hola, no puedo ir mañana', null, { iniciar: false })).toBe(true);
        expect(a.c.cancelar).toHaveBeenCalled();
        const b = ctx();
        expect(await cortesia.atenderTurnoCortesia(b.c, 'Gracias, allá estaremos', null, { iniciar: false })).toBe(false);
        expect(b.c.cancelar).not.toHaveBeenCalled();
    });

    it('cancelaTrasRecordatorio', () => {
        expect(cortesia.cancelaTrasRecordatorio('Cancelar.')).toBe(true);
        expect(cortesia.cancelaTrasRecordatorio('cancelo')).toBe(true);
        expect(cortesia.cancelaTrasRecordatorio('ok')).toBe(false);
        expect(cortesia.cancelaTrasRecordatorio('cancelaron el partido?')).toBe(false);
    });
});


// ─── Integración (2026-10-30): escuela con embudo (Monster) ─────────────────
const { textosDeClase } = await import('./textos-clase-prueba');

describe('víspera de una escuela con embudo (B2/B3)', () => {
    const PRUEBA = textosDeClase({ nombre_clase: 'prueba', trial_price: 15000 });
    const LUGARES = [
        { id: 'p2', nombre: 'Parque Pinar de Suba 2', branchId: 'suba', direccion: 'Cl. 145 #91-19', mapsUrl: 'https://maps.app.goo.gl/p2', indicaciones: null },
        { id: 'p1', nombre: 'Parque Pinar', branchId: 'suba', direccion: 'Cra. 92 #147', mapsUrl: null, indicaciones: null },
    ];
    beforeEach(() => {
        deps.reservasDelDia = vi.fn(async () => [reserva({
            slot: { id: 'slot-9', label: 'U9 Y U11 MIXTO', slot_date: '2026-10-07', start_time: '08:00', end_time: '10:00', location: 'Parque Pinar de Suba 2', team_id: 'team-u9' },
        })]);
        deps.escuela = vi.fn(async () => ({
            nombre: 'Monsters Volley', sedes: [{ name: 'Sede Suba', address: 'Calle 152 #94A-67', is_main: true }],
            lugares: LUGARES, embudo: true, textos: PRUEBA,
        }));
    });

    it('ventana cerrada → plantilla recordatorio_clase_prueba con el estado del embudo y la cancha exacta', async () => {
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r.enviados).toBe(1);
        const arg = deps.enviarPlantilla.mock.calls[0][0];
        expect(arg.concepto).toBe('recordatorio_clase_prueba');
        expect(arg.datos.sede).toBe('Parque Pinar de Suba 2 (Cl. 145 #91-19)');
        expect(arg.payloadExtra).toMatchObject({
            flujo: 'embudo', paso_embudo: 'agendada', step: 'recordatorio_cortesia_vispera', lead_id: 'lead-1',
            datos_embudo: { leadId: 'lead-1', teamId: 'team-u9', slotId: 'slot-9' },
        });
        expect(arg.payloadExtra.flujo).not.toBe(cortesia.FLUJO_CORTESIA);
    });

    it('ventana abierta → texto con la clase de prueba, botones del embudo y sin «gratis» ni CANCELAR', async () => {
        deps.conversacion = vi.fn(async () => ({ id: 'conv-1', last_inbound_at: '2026-10-06T20:00:00Z' }));
        await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        const [, , texto, botones] = deps.enviarTexto.mock.calls[0];
        expect(texto).toContain('la clase de prueba de *Samuel Perez*');
        expect(texto).toContain('Cambiar horario');
        expect(texto).not.toMatch(/gratis|cortes[ií]a|CANCELAR/i);
        expect(botones.map((b: any) => b.id)).toEqual(['sm_em_ahi', 'sm_em_cambiar']);
        expect(deps.registrarTexto.mock.calls[0][0].payload).toMatchObject({ flujo: 'embudo', paso_embudo: 'agendada' });
    });

    it('la sesión se canceló y ya se avisó «clase reprogramada»: no se recuerda', async () => {
        deps.reservasDelDia = vi.fn(async () => [reserva({
            slot: { id: 'slot-9', label: 'U9', slot_date: '2026-10-07', start_time: '08:00', end_time: '10:00', location: 'Parque Pinar de Suba 2', team_id: 'team-u9' },
            reprogramadaSlotId: 'slot-9',
        })]);
        const r = await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        expect(r).toMatchObject({ candidatas: 1, enviados: 0, omitidos: 1 });
        expect(deps.enviarPlantilla).not.toHaveBeenCalled();
    });

    it('Dynasty igual: sin embudo, la plantilla y el estado de la cortesía de siempre', async () => {
        deps.escuela = vi.fn(async () => ({ nombre: 'Dynasty Volley Club', sedes: [{ name: 'Coliseo Dynasty DC', address: 'Cl. 12 Bis #71g-09', is_main: true }] }));
        deps.reservasDelDia = vi.fn(async () => [reserva()]);
        await runRecordatorioCortesia('vispera', { ahora: VISPERA, deps });
        const arg = deps.enviarPlantilla.mock.calls[0][0];
        expect(arg.concepto).toBe('recordatorio_clase_cortesia');
        expect(arg.datos.sede).toBe('Coliseo Dynasty (Cl. 12 Bis #71g-09)');
        expect(arg.payloadExtra).toMatchObject({ flujo: cortesia.FLUJO_CORTESIA, paso_cortesia: 'recordatorio' });
    });
});
