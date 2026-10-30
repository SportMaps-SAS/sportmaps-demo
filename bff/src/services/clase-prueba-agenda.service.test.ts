/**
 * Agenda automática de la clase de prueba (plan B2/B3 §5.6 y plan maestro §3):
 * el contrato con B4 (`confirmarClasePruebaPagada`, idempotente), el aviso al
 * entrenador, los jobs de cupos separados y el aviso de «clase reprogramada».
 * Supabase y Meta moqueados; los jobs reciben sus dependencias inyectadas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
    const st = {
        tablas: {} as Record<string, any[]>,
        rpc: (_fn: string, _args: any): any => ({ data: null, error: null }),
        rpcs: [] as { fn: string; args: any }[],
        /** Error al pedir esas columnas (columna que todavía no existe). */
        errorDeSelect: (_tabla: string, _cols: string): any => null,
    };
    function builder(tabla: string) {
        const filtros: ((f: any) => boolean)[] = [];
        let cols = '';
        const filas = () => (st.tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
        const resultado = () => {
            const error = st.errorDeSelect(tabla, cols);
            return error ? { data: null, error } : { data: filas(), error: null };
        };
        const api: any = {
            select: (c?: string) => { cols = c ?? ''; return api; },
            eq: (c: string, v: any) => { filtros.push((f) => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((f) => vs.includes(f[c])); return api; },
            gte: () => api, lte: () => api, gt: () => api, order: () => api, limit: () => api, not: () => api, is: () => api,
            maybeSingle: async () => { const r = resultado(); return r.error ? r : { data: r.data![0] ?? null, error: null }; },
            then: (ok: any, err: any) => Promise.resolve(resultado()).then(ok, err),
        };
        return api;
    }
    return {
        st,
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => { st.rpcs.push({ fn, args }); return Promise.resolve(st.rpc(fn, args)); },
        },
    };
});
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));

import {
    tomarCupo, soltarCupo, confirmarClasePruebaPagada, confirmarClaseAgendada, avisarEntrenador, franjaDeAgenda,
    textoConfirmacion, lugarDeFranja, contenidoAvisoEntrenador, runCuposSeparados, avisarClasesCanceladas,
    runClasesReprogramadas, franjasAfectadas, motivoDeReprogramacion, cuandoVence, textoCupoPorVencer, textoClaseReprogramada, rangoDeHoras,
    BOTON_AGENDA, type FranjaAgenda, type LeadAgenda, type DepsAgenda, type DepsCupos, type DepsReprogramadas,
} from './clase-prueba-agenda.service';
import { ajustesClasePruebaDesdeFila } from './whatsapp-ajustes-escuela.service';
import { uuidDeClave } from './avisos-correo.service';

const CLASE = ajustesClasePruebaDesdeFila({ nombre_clase: 'prueba', trial_price: 15000, separar_horas: 24, avisar_entrenador: true });
const FRANJA: FranjaAgenda = {
    id: 's-sab31', fecha: '2026-10-31', horaInicio: '08:00', horaFin: '10:00', grupo: 'Infantil Femenino', teamId: 't-1',
    lugar: 'La Enseñanza', direccion: 'Calle 201 #67-12', mapsUrl: 'https://maps.app.goo.gl/abc',
    indicaciones: 'Entrada de deportistas por la portería 2. Si llueve, la clase se reprograma y te avisamos por aquí.',
    profe: 'Iván Sossa', coachUserIds: ['user-1', 'user-2'],
};
const LEAD: LeadAgenda = {
    id: 'lead-1', schoolId: 'monster', nombre: 'Mariana Gómez Rojas', acudiente: 'Carolina Rojas', telefono: '3001112233',
    fechaNacimiento: '2011-03-14', genero: 'F', respuestas: { posicion: 'Punta', trayectoria: 'Club y torneos' },
    trialSlotId: 's-sab31', conversationId: 'conv-1', sourceDetail: {},
};
const QUE_LLEVAR = 'Camiseta negra, pantaloneta, medias y tenis; agua abundante.';
const EMOJI = /\p{Extended_Pictographic}/gu;

beforeEach(() => {
    h.st.tablas = {};
    h.st.rpcs = [];
    h.st.rpc = () => ({ data: null, error: null });
    h.st.errorDeSelect = () => null;
});

describe('formato', () => {
    it('confirmación: fecha, cancha y dirección, Maps, indicaciones, profe y qué llevar; ≤ 3 emojis y sin «gratis»', () => {
        const t = textoConfirmacion(FRANJA, { deportista: 'Mariana Gómez Rojas', nombreClase: 'prueba', queLlevar: QUE_LLEVAR });
        expect(t).toBe([
            'La clase de prueba de *Mariana* quedó agendada 🎉',
            '📅 Sábado 31 de octubre, 8:00 – 10:00 a. m.',
            '📍 La Enseñanza · Calle 201 #67-12',
            'Cómo llegar: https://maps.app.goo.gl/abc',
            'Entrada de deportistas por la portería 2. Si llueve, la clase se reprograma y te avisamos por aquí.',
            'Te recibe el profe Iván.',
            `Qué llevar: ${QUE_LLEVAR}`,
            '',
            '¡Te esperamos en la cancha!',
        ].join('\n'));
        expect((t.match(EMOJI) ?? []).length).toBeLessThanOrEqual(3);
        expect(t).not.toMatch(/gratis/i);
    });

    it('lo que no está cargado no se dice', () => {
        const t = textoConfirmacion({ ...FRANJA, direccion: null, mapsUrl: null, indicaciones: null, profe: null }, { nombreClase: null });
        expect(t).toBe('Tu clase de cortesía quedó agendada 🎉\n📅 Sábado 31 de octubre, 8:00 – 10:00 a. m.\n📍 La Enseñanza\n\n¡Te esperamos en la cancha!');
    });

    it('rango de horas con y sin cambio de a. m. a p. m.', () => {
        expect(rangoDeHoras('08:00', '10:00')).toBe('8:00 – 10:00 a. m.');
        expect(rangoDeHoras('11:00', '13:00')).toBe('11:00 a. m. – 1:00 p. m.');
        expect(rangoDeHoras('16:00', null)).toBe('4:00 p. m.');
    });

    it('lugarDeFranja: coincidencia EXACTA («Pinar» no es «Pinar 2»), luego la cancha del equipo y la sede', () => {
        const facs = [
            { id: 'f1', name: 'Pinar', address: 'Parque Pinar de Suba', maps_url: null, indicaciones: null },
            { id: 'f2', name: 'Pinar 2', address: 'Parque Pinar de Suba 2', maps_url: 'https://maps/p2', indicaciones: 'Si llueve, se reprograma.' },
        ];
        const sedes = [{ id: 'b1', name: 'Sede Suba', address: 'Calle 152 #94A-67' }];
        expect(lugarDeFranja('pinar 2', facs, null, sedes)).toEqual({ lugar: 'Pinar 2', direccion: 'Parque Pinar de Suba 2', mapsUrl: 'https://maps/p2', indicaciones: 'Si llueve, se reprograma.' });
        expect(lugarDeFranja('Pinar', facs, null, sedes).direccion).toBe('Parque Pinar de Suba');
        expect(lugarDeFranja('Cancha rara', facs, { facility_id: 'f2' }, sedes).lugar).toBe('Pinar 2');
        expect(lugarDeFranja('Fesan', [], { branch_id: 'b1' }, sedes)).toEqual({ lugar: 'Fesan', direccion: 'Calle 152 #94A-67', mapsUrl: null, indicaciones: null });
    });

    it('aviso al entrenador: sin teléfono, con año, sexo y respuestas', () => {
        const c = contenidoAvisoEntrenador('agendada', LEAD, FRANJA, 'prueba');
        expect(c.titulo).toBe('🔔 Clase de prueba agendada');
        expect(c.mensaje).toBe('Mariana Gómez Rojas · 2011 · Mujer · Punta · Club y torneos\nSábado 31 de octubre, 8:00 – 10:00 a. m.\nInfantil Femenino · La Enseñanza');
        expect(c.mensaje).not.toContain('3001112233');
    });
});

describe('RPC del cupo', () => {
    it('tomarCupo devuelve el estado de la RPC; sin la migración, error sin_rpc', async () => {
        h.st.rpc = () => ({ data: { estado: 'separada', hasta: '2026-10-30T23:45:00Z' }, error: null });
        expect(await tomarCupo('lead-1', 's-1')).toEqual({ estado: 'separada', hasta: '2026-10-30T23:45:00Z' });
        expect(h.st.rpcs[0]).toEqual({ fn: 'tomar_cupo_clase_prueba', args: { p_lead_id: 'lead-1', p_slot_id: 's-1' } });
        h.st.rpc = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
        expect(await tomarCupo('lead-1', 's-1')).toEqual({ estado: 'error', hasta: null, detalle: 'sin_rpc' });
    });

    it('soltarCupo suelta el de ESE lead', async () => {
        await soltarCupo('lead-1');
        expect(h.st.rpcs[0]).toEqual({ fn: 'soltar_cupos_separados', args: { p_lead_id: 'lead-1', p_limite: 1 } });
    });
});

function depsAgenda(op: { estados?: string[]; lead?: LeadAgenda | null; franja?: FranjaAgenda | null } = {}) {
    const estados = [...(op.estados ?? ['agendada'])];
    const d: DepsAgenda = {
        leerLead: vi.fn(async (schoolId: string) => (schoolId === 'monster' ? (op.lead === undefined ? LEAD : op.lead) : null)),
        franja: vi.fn(async () => (op.franja === undefined ? FRANJA : op.franja)),
        ajustes: vi.fn(async () => CLASE),
        queLlevar: vi.fn(async () => QUE_LLEVAR),
        confirmarCupo: vi.fn(async () => ({ estado: estados.shift() ?? 'ya_agendada', slot_id: 's-sab31' })),
        avanzarEtapa: vi.fn(async () => 'agendado' as const),
        avisarEntrenador: vi.fn(async () => 2),
        avisarEscuela: vi.fn(async () => {}),
    };
    return d;
}

describe('confirmarClasePruebaPagada (contrato B4 → B2)', () => {
    const P = { schoolId: 'monster', leadId: 'lead-1', paymentId: 'pay-1', telefono: '573001112233' };

    it('agenda, avisa una sola vez y es idempotente (mismo texto)', async () => {
        const d = depsAgenda({ estados: ['agendada', 'ya_agendada'] });
        const a = await confirmarClasePruebaPagada(P, d);
        const b = await confirmarClasePruebaPagada(P, d);
        expect(a).toEqual(b);
        expect(a.step).toBe('clase_prueba_agendada');
        expect(a.texto).toContain('La clase de prueba de *Mariana* quedó agendada 🎉');
        expect(a.texto).toContain('Te recibe el profe Iván.');
        expect(a.texto).toContain(`Qué llevar: ${QUE_LLEVAR}`);
        // Nunca contestó el consentimiento: va la pregunta con [Sí, claro][No, gracias].
        expect(a.texto).toMatch(/¿Te puedo escribir por aquí el recordatorio de la clase y las novedades del club\?$/);
        expect(a.botones).toEqual([{ id: BOTON_AGENDA.OPTIN_SI, title: 'Sí, claro' }, { id: BOTON_AGENDA.OPTIN_NO, title: 'No, gracias' }]);
        expect(d.avanzarEtapa).toHaveBeenCalledTimes(1);
        expect(d.avanzarEtapa).toHaveBeenCalledWith('lead-1', 'agendado', { agendado_por: 'pago', payment_id: 'pay-1' });
        expect(d.avisarEntrenador).toHaveBeenCalledTimes(1);
        expect(d.avisarEntrenador).toHaveBeenCalledWith('agendada', LEAD, FRANJA, { ajustes: CLASE });
        expect(d.avisarEscuela).toHaveBeenCalledTimes(1);
        expect(d.confirmarCupo).toHaveBeenCalledWith('lead-1', 'pay-1');
    });

    it('con el consentimiento ya contestado no se vuelve a preguntar', async () => {
        const d = depsAgenda({ lead: { ...LEAD, sourceDetail: { consentimiento: 'no' } } });
        const r = await confirmarClasePruebaPagada(P, d);
        expect(r.botones).toBeUndefined();
        expect(r.texto).not.toContain('¿Te puedo escribir');
    });

    it('sin_cupo → «Elegir horario» sin cobrar de nuevo', async () => {
        const r = await confirmarClasePruebaPagada(P, depsAgenda({ estados: ['sin_cupo'] }));
        expect(r).toEqual({
            texto: 'Recibí tu pago ✅ Pero el horario que separaste ya se llenó 😕\n\nToca *Elegir horario* y te muestro los que siguen abiertos; no tienes que pagar de nuevo.',
            botones: [{ id: 'sm_em_cambiar', title: 'Elegir horario' }], step: 'clase_prueba_sin_cupo',
        });
    });

    it('sin_separar → elegir horario', async () => {
        const r = await confirmarClasePruebaPagada(P, depsAgenda({ estados: ['sin_separar'] }));
        expect(r.step).toBe('clase_prueba_sin_horario');
        expect(r.botones).toEqual([{ id: 'sm_em_cambiar', title: 'Elegir horario' }]);
    });

    it('un lead de otra escuela da error (B4 lo pasa a una persona)', async () => {
        const d = depsAgenda();
        await expect(confirmarClasePruebaPagada({ ...P, schoolId: 'dynasty' }, d)).rejects.toThrow(/no existe en esta escuela/);
        expect(d.confirmarCupo).not.toHaveBeenCalled();
    });

    it('si la RPC falla, lanza y no avisa a nadie', async () => {
        const d = depsAgenda();
        (d.confirmarCupo as any).mockRejectedValueOnce(new Error('confirmar_cupo_clase_prueba: boom'));
        await expect(confirmarClasePruebaPagada(P, d)).rejects.toThrow(/boom/);
        expect(d.avisarEntrenador).not.toHaveBeenCalled();
    });

    it('confirmarClaseAgendada (sin pago): cambio de horario', async () => {
        const d = depsAgenda();
        const r = await confirmarClaseAgendada({ schoolId: 'monster', leadId: 'lead-1', slotId: 's-sab31', evento: 'cambiada', contactWaId: '573001112233' }, d);
        expect(r.texto).toMatch(/^Listo, cambié el horario de \*Mariana\* 🙌 Tu clase de prueba quedó agendada:/);
        expect(r.consentimientoPendiente).toBe(true);
        expect(d.avisarEntrenador).toHaveBeenCalledWith('cambiada', LEAD, FRANJA, { ajustes: CLASE });
        expect(d.avanzarEtapa).toHaveBeenCalledWith('lead-1', 'agendado', { agendado_por: 'bot' });
    });
});

describe('avisarEntrenador', () => {
    it('team_coaches ∪ teams.coach_id (ids de school_staff) → usuarios por coach_auth_id o correo; id determinístico y enlace a «Mi semana»', async () => {
        h.st.tablas = {
            school_trial_slots: [{ id: 's-sab31', school_id: 'monster', label: 'Infantil Femenino', slot_date: '2026-10-31', start_time: '08:00:00', end_time: '10:00:00', location: 'La Enseñanza', team_id: 't-1' }],
            teams: [{ id: 't-1', name: 'Infantil Femenino', coach_id: 'staff-2', facility_id: null, branch_id: null }],
            team_coaches: [{ team_id: 't-1', coach_id: 'staff-1' }, { team_id: 't-1', coach_id: 'staff-2' }, { team_id: 't-1', coach_id: 'staff-3' }],
            school_staff: [
                { id: 'staff-1', full_name: 'Iván Sossa', coach_auth_id: 'user-1', email: 'ivan@club.co', status: 'active' },
                // Ficha sin vincular: se encuentra por el correo.
                { id: 'staff-2', full_name: 'Otra Persona', coach_auth_id: null, email: 'Otra@Club.co', status: 'active' },
                { id: 'staff-3', full_name: 'Ya no trabaja', coach_auth_id: 'user-3', email: 'x@club.co', status: 'inactive' },
            ],
            facilities: [{ id: 'f1', school_id: 'monster', name: 'La Enseñanza', address: 'Calle 201 #67-12', maps_url: null, indicaciones: null }],
            school_branches: [],
            profiles: [{ id: 'user-2', email: 'otra@club.co' }],
        };
        const f = await franjaDeAgenda('monster', 's-sab31');
        expect(f).toMatchObject({ coachUserIds: ['user-1', 'user-2'], profe: 'Iván Sossa', lugar: 'La Enseñanza', direccion: 'Calle 201 #67-12', horaInicio: '08:00' });
        const filas: any[] = [];
        const n = await avisarEntrenador('agendada', LEAD, f!, { ajustes: CLASE, insertar: async (fila) => { filas.push(fila); return { error: null }; } });
        expect(n).toBe(2);
        expect(filas.map((x) => x.id)).toEqual([
            uuidDeClave('clase_prueba_coach:agendada:lead-1:s-sab31:user-1'),
            uuidDeClave('clase_prueba_coach:agendada:lead-1:s-sab31:user-2'),
        ]);
        expect(filas[0]).toMatchObject({ user_id: 'user-1', category: 'enrollment', link: '/training-plans?tab=semana&fecha=2026-10-31' });
    });

    it('franja de otra escuela: null', async () => {
        h.st.tablas = { school_trial_slots: [{ id: 's-x', school_id: 'dynasty', slot_date: '2026-10-31', start_time: '08:00' }] };
        expect(await franjaDeAgenda('monster', 's-x')).toBeNull();
    });

    it('avisar_entrenador=false → 0 inserts; un 23505 (ya avisado) no cuenta', async () => {
        const insertar = vi.fn(async () => ({ error: null }));
        expect(await avisarEntrenador('agendada', LEAD, FRANJA, { ajustes: { ...CLASE, avisarEntrenador: false }, insertar })).toBe(0);
        expect(insertar).not.toHaveBeenCalled();
        const repetido = vi.fn(async () => ({ error: { code: '23505', message: 'duplicate key' } }));
        expect(await avisarEntrenador('agendada', LEAD, FRANJA, { ajustes: CLASE, insertar: repetido })).toBe(0);
        expect(repetido).toHaveBeenCalledTimes(2);
    });
});

// ─── Jobs ────────────────────────────────────────────────────────────────────

const INTEG = { id: 'int-1', school_id: 'monster', phone_number_id: 'pn', waba_id: 'w', display_phone_number: null, access_token_encrypted: 'x' } as any;
const haceHoras = (ahora: Date, h: number) => new Date(ahora.getTime() - h * 3600_000).toISOString();

function depsEnvio(ahora: Date, op: { ultimoEntrante?: string | null } = {}) {
    return {
        ahora: () => ahora,
        integracion: vi.fn(async () => INTEG),
        conversacion: vi.fn(async () => ({ id: 'conv-1', last_inbound_at: op.ultimoEntrante === undefined ? haceHoras(ahora, 22) : op.ultimoEntrante })),
        puedeEscribir: vi.fn(async () => true),
        enviarTexto: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.1' })),
        registrarSaliente: vi.fn(async () => {}),
        enviarPlantilla: vi.fn(async () => ({ enviado: true as const, waMessageId: 'wamid.t', plantilla: 'x' })),
        reservar: vi.fn(async () => true),
        log: { info: vi.fn(), warn: vi.fn() },
    };
}

describe('runCuposSeparados', () => {
    // Viernes 30 de octubre, 2:00 p. m. en Bogotá; el cupo vence a las 4:00 p. m.
    const AHORA = new Date('2026-10-30T19:00:00.000Z');
    const HASTA = '2026-10-30T21:00:00.000Z';
    const LEAD_SEP = {
        id: 'lead-1', school_id: 'monster', full_name: 'Mariana Gómez', guardian_name: 'Carolina Rojas', phone: '3001112233',
        cupo_separado_slot_id: 's-sab31', cupo_separado_hasta: HASTA, source_detail: {},
    };
    const SLOT = { id: 's-sab31', slot_date: '2026-10-31', start_time: '08:00:00', team_id: 't-1' };

    function deps(op: { ultimoEntrante?: string | null; porVencer?: any[] | 'sin_migracion'; vencidos?: any[] | 'sin_migracion'; ahora?: Date } = {}) {
        const ahora = op.ahora ?? AHORA;
        const d: Partial<DepsCupos> = {
            ...depsEnvio(ahora, op),
            cuposPorVencer: vi.fn(async () => op.porVencer ?? [LEAD_SEP]),
            slots: vi.fn(async () => [SLOT]),
            soltarVencidos: vi.fn(async () => op.vencidos ?? []),
            leads: vi.fn(async () => [{ id: 'lead-2', full_name: 'Sofía' }]),
            ajustes: vi.fn(async () => CLASE),
            avisarLiberado: vi.fn(async () => {}),
            alConfirmar: vi.fn(async () => null),
        };
        return d;
    }

    afterEach(() => { delete process.env.DISABLE_CUPOS_SEPARADOS; });

    it('aviso «tu cupo vence en 2 h» por texto dentro de la ventana, una sola vez por cupo', async () => {
        const d = deps();
        const r = await runCuposSeparados({ deps: d });
        expect(r).toMatchObject({ porVencer: 1, avisados: 1, omitidos: 0 });
        expect(d.reservar).toHaveBeenCalledWith('lead-1', 'aviso_cupo_por_vencer', { id: `s-sab31:${HASTA}`, at: AHORA.toISOString() });
        const [, waId, texto] = (d.enviarTexto as any).mock.calls[0];
        expect(waId).toBe('573001112233');
        expect(texto).toBe('Hola, Carolina 👋 El cupo que te separé para la clase de prueba de *Mariana* (sábado 31 de octubre, 8:00 a. m.) ' +
            'vence hoy a las 4:00 p. m. ⏳\n\nSi ya pagaste, envíame aquí la foto o el PDF del comprobante 📸 y queda agendada.');
        expect((d.registrarSaliente as any).mock.calls[0][0].payload).toEqual({
            step: 'clase_prueba_cupo_por_vencer', flujo: 'embudo', paso_embudo: 'esperando_pago',
            datos_embudo: { leadId: 'lead-1', slotId: 's-sab31', hasta: HASTA, teamId: 't-1' },
        });
        expect(d.enviarPlantilla).not.toHaveBeenCalled();
    });

    it('ventana cerrada → plantilla de utilidad clase_prueba_cupo_por_vencer', async () => {
        const d = deps({ ultimoEntrante: haceHoras(AHORA, 30) });
        const r = await runCuposSeparados({ deps: d });
        expect(r.avisados).toBe(1);
        expect(d.enviarTexto).not.toHaveBeenCalled();
        expect(d.enviarPlantilla).toHaveBeenCalledWith(expect.objectContaining({
            schoolId: 'monster', concepto: 'clase_prueba_cupo_por_vencer', telefono: '573001112233', tokenBoton: null,
            datos: expect.objectContaining({ nombreContacto: 'Carolina', nombreAtleta: 'Mariana', monto: '$15.000', vence: 'hoy a las 4:00 p. m.', dia: 'sábado 31 de octubre', hora: '8:00 a. m.' }),
        }));
    });

    it('ya avisado para ese cupo: no se repite', async () => {
        const d = deps({ porVencer: [{ ...LEAD_SEP, source_detail: { aviso_cupo_por_vencer: { id: `s-sab31:${HASTA}` } } }] });
        const r = await runCuposSeparados({ deps: d });
        expect(r.porVencer).toBe(0);
        expect(d.reservar).not.toHaveBeenCalled();
    });

    it('otro BFF ya lo reservó: no se manda', async () => {
        const d = deps();
        (d.reservar as any).mockResolvedValueOnce(false);
        const r = await runCuposSeparados({ deps: d });
        expect(r).toMatchObject({ avisados: 0, omitidos: 1 });
        expect(d.enviarTexto).not.toHaveBeenCalled();
    });

    it('de noche no se escribe', async () => {
        const d = deps({ ahora: new Date('2026-10-31T03:30:00.000Z') }); // 10:30 p. m. en Bogotá
        await runCuposSeparados({ deps: d });
        expect(d.reservar).not.toHaveBeenCalled();
    });

    it('vencidos: libera SIN mensaje y avisa a la escuela; con pago, confirma y se lo dice (en la ventana)', async () => {
        const d = deps({
            porVencer: [],
            vencidos: [
                { lead_id: 'lead-2', school_id: 'monster', phone: '3009998877', accion: 'liberada', slot_id: 's-1' },
                { lead_id: 'lead-3', school_id: 'monster', phone: '3005556677', accion: 'confirmada' },
            ],
        });
        (d.alConfirmar as any).mockResolvedValueOnce({ texto: 'La clase de prueba de *Ana* quedó agendada 🎉', telefono: '3005556677', slotId: 's-9', teamId: 't-1' });
        const r = await runCuposSeparados({ deps: d });
        expect(r).toMatchObject({ liberados: 1, confirmados: 1 });
        expect(d.avisarLiberado).toHaveBeenCalledWith(expect.objectContaining({ lead_id: 'lead-2' }), { id: 'lead-2', full_name: 'Sofía' }, 24);
        expect(d.alConfirmar).toHaveBeenCalledWith(expect.objectContaining({ lead_id: 'lead-3' }));
        // Solo la confirmada recibe mensaje; la liberada, nada.
        expect(d.enviarTexto).toHaveBeenCalledTimes(1);
        expect((d.enviarTexto as any).mock.calls[0].slice(1, 3)).toEqual(['573005556677', 'La clase de prueba de *Ana* quedó agendada 🎉']);
        expect((d.registrarSaliente as any).mock.calls[0][0].payload).toMatchObject({ step: 'clase_prueba_agendada', paso_embudo: 'agendada' });
        expect(d.enviarPlantilla).not.toHaveBeenCalled();
    });

    it('sin la migración no hace nada; con el kill-switch tampoco', async () => {
        expect(await runCuposSeparados({ deps: deps({ porVencer: 'sin_migracion' }) })).toMatchObject({ sinMigracion: true });
        process.env.DISABLE_CUPOS_SEPARADOS = 'true';
        const d = deps();
        expect(await runCuposSeparados({ deps: d })).toMatchObject({ desactivado: true });
        expect(d.cuposPorVencer).not.toHaveBeenCalled();
    });
});

describe('clases reprogramadas', () => {
    // Jueves 29 de octubre, 3:00 p. m. en Bogotá.
    const AHORA = new Date('2026-10-29T20:00:00.000Z');
    const SLOTS = [
        { id: 's1', team_id: 't-1', slot_date: '2026-10-31', start_time: '08:00:00' },
        { id: 's2', team_id: 't-1', slot_date: '2026-10-31', start_time: '10:00:00' },
        { id: 's3', team_id: 't-2', slot_date: '2026-10-31', start_time: '08:00:00' },
        { id: 's4', team_id: 't-1', slot_date: '2026-11-01', start_time: '08:00:00' },
    ];

    it('franjasAfectadas: cancelada todo el día, cancelada a una hora, movida; extra no afecta', () => {
        const ids = (e: any[]) => franjasAfectadas(e, SLOTS).map((a) => a.slot.id);
        expect(ids([{ team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null }])).toEqual(['s1', 's2']);
        expect(ids([{ team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: '10:00:00' }])).toEqual(['s2']);
        expect(ids([{ team_id: 't-1', fecha: '2026-10-31', tipo: 'movida', hora_original: '08:00' }])).toEqual(['s1']);
        expect(ids([{ team_id: 't-1', fecha: '2026-10-31', tipo: 'extra', hora_original: null }])).toEqual([]);
        expect(ids([{ team_id: 't-9', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null }])).toEqual([]);
    });

    function deps(op: { leads?: any[]; excepciones?: any[] | 'sin_tabla' } = {}) {
        const base = depsEnvio(AHORA);
        (base.conversacion as any).mockImplementation(async (_i: string, waId: string) => ({
            id: `conv-${waId}`, last_inbound_at: waId === '573001112233' ? haceHoras(AHORA, 3) : haceHoras(AHORA, 72),
        }));
        const d: Partial<DepsReprogramadas> = {
            ...base,
            excepciones: vi.fn(async () => op.excepciones ?? [{ team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada' as const, hora_original: null }]),
            slotsDeEquipos: vi.fn(async () => SLOTS),
            leadsDeFranjas: vi.fn(async () => op.leads ?? [
                { id: 'lead-a', full_name: 'Mariana Gómez', guardian_name: 'Carolina', phone: '3001112233', trial_slot_id: 's1', source_detail: {} },
                { id: 'lead-b', full_name: 'Sofía', guardian_name: null, phone: '3009998877', trial_slot_id: 's2', source_detail: {} },
                { id: 'lead-c', full_name: 'Ana', guardian_name: null, phone: '3005556677', trial_slot_id: null, cupo_separado_slot_id: 's1', source_detail: { reprogramada: { id: 's1' } } },
                { id: 'lead-d', full_name: 'Otra', guardian_name: null, phone: '3004443322', trial_slot_id: 's4', source_detail: {} },
            ]),
            ajustes: vi.fn(async () => CLASE),
        };
        return d;
    }

    it('a cada agendado una vez: texto con «Elegir otro horario» en la ventana, plantilla fuera; sin volver a cobrar', async () => {
        const d = deps();
        const r = await avisarClasesCanceladas({ schoolId: 'monster', deps: d });
        expect(r).toMatchObject({ excepciones: 1, franjas: 2, agendados: 3, porTexto: 1, porPlantilla: 1, yaAvisados: 1 });
        const [, waId, texto, botones] = (d.enviarTexto as any).mock.calls[0];
        expect(waId).toBe('573001112233');
        expect(texto).toBe('Hola, Carolina 👋 La clase de prueba de *Mariana* del sábado 31 de octubre a las 8:00 a. m. no se va a realizar ' +
            'por un cambio en la programación del entrenamiento. 🙏\n\nToca *Elegir otro horario* y escoge una nueva fecha, sin costo adicional.');
        expect(botones).toEqual([{ id: 'sm_em_reprogramar', title: 'Elegir otro horario' }]);
        expect((d.registrarSaliente as any).mock.calls[0][0].payload).toEqual({
            step: 'clase_prueba_reprogramada', flujo: 'embudo', paso_embudo: 'reprogramar',
            datos_embudo: { leadId: 'lead-a', teamId: 't-1', slotId: 's1', reprogramada: true },
        });
        expect(d.enviarPlantilla).toHaveBeenCalledWith(expect.objectContaining({
            concepto: 'clase_prueba_reprogramada', telefono: '573009998877',
            datos: expect.objectContaining({ nombreAtleta: 'Sofía', dia: 'sábado 31 de octubre', hora: '10:00 a. m.', motivo: 'un cambio en la programación del entrenamiento' }),
            payloadExtra: expect.objectContaining({ flujo: 'embudo', paso_embudo: 'reprogramar' }),
        }));
        expect(d.reservar).toHaveBeenCalledWith('lead-a', 'reprogramada', expect.objectContaining({ id: 's1', tipo: 'cancelada' }));
        expect(d.reservar).not.toHaveBeenCalledWith('lead-c', expect.anything(), expect.anything());
        // La clase del domingo sigue: a lead-d no se le escribe.
        expect(d.reservar).not.toHaveBeenCalledWith('lead-d', expect.anything(), expect.anything());
    });

    it('con el motivo del profe («lluvia») el aviso lo dice, en el texto y en la plantilla', async () => {
        const d = deps({ excepciones: [{ team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null, motivo: 'Por lluvia.' }] });
        await avisarClasesCanceladas({ schoolId: 'monster', deps: d });
        expect((d.enviarTexto as any).mock.calls[0][2]).toContain('no se va a realizar por lluvia. 🙏');
        expect(d.enviarPlantilla).toHaveBeenCalledWith(expect.objectContaining({ datos: expect.objectContaining({ motivo: 'lluvia' }) }));
    });

    it('motivoDeReprogramacion', () => {
        expect(motivoDeReprogramacion('  por   lluvia ')).toBe('lluvia');
        expect(motivoDeReprogramacion('Partido del equipo.')).toBe('Partido del equipo');
        expect(motivoDeReprogramacion('   ')).toBeNull();
        expect(motivoDeReprogramacion(null)).toBeNull();
        expect(Array.from(motivoDeReprogramacion('x'.repeat(200))!).length).toBe(120);
    });

    it('la lectura de excepciones trae el motivo; sin la columna, lee sin ella', async () => {
        h.st.tablas = { team_schedule_exceptions: [{ school_id: 'monster', team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null, motivo: 'lluvia' }] };
        const vistas: any[] = [];
        const d = deps();
        delete (d as any).excepciones; // la lectura real (Supabase moqueado)
        (d.slotsDeEquipos as any).mockImplementation(async () => { vistas.push('slots'); return SLOTS; });
        await avisarClasesCanceladas({ schoolId: 'monster', deps: d });
        expect((d.enviarTexto as any).mock.calls[0][2]).toContain('por lluvia');
        // Sin la migración del motivo: pedir la columna falla y se vuelve a leer sin ella.
        h.st.tablas.team_schedule_exceptions = [{ school_id: 'monster', team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null }];
        h.st.errorDeSelect = (t, cols) => (t === 'team_schedule_exceptions' && cols.includes('motivo')
            ? { code: '42703', message: 'column team_schedule_exceptions.motivo does not exist' } : null);
        const d2 = deps();
        delete (d2 as any).excepciones;
        const r = await avisarClasesCanceladas({ schoolId: 'monster', deps: d2 });
        expect(r.sinTabla).toBeUndefined();
        expect((d2.enviarTexto as any).mock.calls[0][2]).toContain('por un cambio en la programación del entrenamiento');
    });

    it('sin la tabla de la semana del profe: no hace nada', async () => {
        expect(await avisarClasesCanceladas({ schoolId: 'monster', deps: deps({ excepciones: 'sin_tabla' }) })).toMatchObject({ sinTabla: true, porTexto: 0 });
    });

    it('runClasesReprogramadas: una consulta, una pasada por escuela', async () => {
        const d = deps();
        const r = await runClasesReprogramadas({
            deps: {
                ...d,
                recientes: async () => [
                    { school_id: 'monster', team_id: 't-1', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null },
                    { school_id: 'otra', team_id: 't-2', fecha: '2026-10-31', tipo: 'cancelada', hora_original: null },
                ],
            },
        });
        expect(r.escuelas).toBe(2);
        expect(d.slotsDeEquipos).toHaveBeenCalledWith('monster', ['t-1'], ['2026-10-31']);
        expect(d.slotsDeEquipos).toHaveBeenCalledWith('otra', ['t-2'], ['2026-10-31']);
    });
});

describe('textos de los jobs', () => {
    it('cuándo vence: hoy, mañana u otro día', () => {
        const ahora = new Date('2026-10-30T19:00:00.000Z');
        expect(cuandoVence('2026-10-30T21:00:00.000Z', ahora)).toBe('hoy a las 4:00 p. m.');
        expect(cuandoVence('2026-10-31T05:30:00.000Z', ahora)).toBe('mañana a las 12:30 a. m.');
        expect(cuandoVence('2026-11-02T15:00:00.000Z', ahora)).toBe('el lunes 2 de noviembre a las 10:00 a. m.');
    });

    it('nunca dicen «gratis»', () => {
        const a = textoCupoPorVencer({ deportista: 'Mariana', nombreClase: 'prueba', fecha: '2026-10-31', horaInicio: '08:00', vence: 'hoy a las 4:00 p. m.' });
        const b = textoClaseReprogramada({ deportista: 'Mariana', nombreClase: 'prueba', fecha: '2026-10-31', horaInicio: '08:00', motivo: 'lluvia' });
        expect(`${a}\n${b}`).not.toMatch(/gratis|cortes[ií]a/i);
    });
});
