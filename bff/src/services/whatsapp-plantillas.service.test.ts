/**
 * Cobranza por plantilla de Meta, por WABA de escuela.
 *
 * Lo que se vigila: que sin aprobación EN ESA WABA no salga nada, que sin
 * opt-in no salga nada, que las variables de _v3/_v4 vayan en el orden que Meta
 * aprobó (escuela en {{2}}, periodo en {{4}}), y que nada lance: todo faltante
 * vuelve como motivo para que el job caiga al correo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Record<string, any>[]>,
    rpc: {} as Record<string, (args: any) => { data: any; error: any }>,
    llamadasRpc: [] as { fn: string; args: any }[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas = [...(estado.tablas[tabla] ?? [])];
        let op: 'select' | 'update' | 'upsert' | 'insert' = 'select';
        let cambios: any = null;
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[c])); return api; },
            not: () => api,
            or: () => api,
            order: () => api,
            limit: () => api,
            update: (c: any) => { op = 'update'; cambios = c; return api; },
            upsert: (c: any) => {
                op = 'upsert';
                const lista = Array.isArray(c) ? c : [c];
                estado.tablas[tabla] = estado.tablas[tabla] ?? [];
                for (const f of lista) estado.tablas[tabla].push({ id: `id-${estado.tablas[tabla].length}`, ...f });
                return api;
            },
            insert: (c: any) => { op = 'insert'; estado.tablas[tabla] = [...(estado.tablas[tabla] ?? []), c]; filas = [c]; return api; },
            maybeSingle: () => Promise.resolve({ data: filas[0] ?? null, error: null }),
            then: (ok: any, ko: any) => {
                if (op === 'update') for (const f of filas) Object.assign(f, cambios);
                return Promise.resolve({ data: filas, error: null }).then(ok, ko);
            },
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => {
                estado.llamadasRpc.push({ fn, args });
                return Promise.resolve(estado.rpc[fn]?.(args) ?? { data: null, error: null });
            },
        },
    };
});

vi.mock('./whatsapp.service', () => ({ decryptToken: () => 'token-claro' }));

const svc = await import('./whatsapp-plantillas.service');
const { enviarCobroPorPlantilla, armarPayloadPlantilla, CONCEPTOS, plantillaAprobada } = svc;

/** Los componentes tal como están en el repo (= lo que se registró en Meta). */
const componentesDe = (archivo: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../whatsapp-templates', archivo), 'utf8')).components;

const INTEG = {
    id: 'integ-dynasty', school_id: 'school-dynasty', waba_id: '1096337621148583',
    phone_number_id: '1203129420220082', access_token_encrypted: 'gcm:x:y:z', status: 'active',
};

function filaPlantilla(nombre: string, archivo: string, extra: Record<string, any> = {}) {
    return {
        id: `tpl-${nombre}`, integration_id: INTEG.id, school_id: INTEG.school_id, waba_id: INTEG.waba_id,
        name: nombre, language: 'es_CO', category: 'UTILITY', status: 'APPROVED',
        components: componentesDe(archivo), synced_at: '2026-10-04T12:00:00Z', ...extra,
    };
}

const DATOS = {
    nombreContacto: 'Carolina',
    nombreAtleta: 'Samuel',
    nombreEscuela: 'Dynasty Volley Club',
    periodo: 'octubre 2026',
    fechaVencimiento: '5 de octubre',
    monto: '$150.000',
};

// Martes 2026-10-06 10:00 COT = 15:00 UTC: dentro del horario de cobranza.
const EN_HORARIO = new Date('2026-10-06T15:00:00Z');

const fetchMock = vi.fn();

beforeEach(() => {
    estado.tablas = {
        school_whatsapp_integrations: [{ ...INTEG }],
        whatsapp_template_status: [
            filaPlantilla('pago_recordatorio_previo_v3', 'pago_recordatorio_previo_v3.json'),
            filaPlantilla('pago_vence_hoy_v4', 'pago_vence_hoy_v4.json'),
        ],
        whatsapp_conversations: [{ id: 'conv-1', integration_id: INTEG.id, contact_wa_id: '573001234567' }],
    };
    estado.rpc = { wa_can_send_template: () => ({ data: true, error: null }) };
    estado.llamadasRpc = [];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.OK' }] }) });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const base = {
    schoolId: INTEG.school_id, telefono: '300 123 4567', datos: DATOS,
    tokenBoton: 'aB3xK9mQ', paymentId: 'pay-1', ahora: EN_HORARIO,
};

describe('enviarCobroPorPlantilla — controles', () => {
    it('sin aprobación en ESA WABA → motivo, sin llamar a Graph', async () => {
        estado.tablas.whatsapp_template_status[0].status = 'PENDING';
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'plantilla_no_aprobada' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aprobada en OTRA WABA (la escuela reconectó) no cuenta', async () => {
        estado.tablas.whatsapp_template_status[0].waba_id = '2239403120233193';
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'plantilla_no_aprobada' });
    });

    it('plantilla que no existe en la WABA (nunca sincronizada) → motivo', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'vence_manana' });
        expect(r).toMatchObject({ enviado: false, motivo: 'plantilla_no_aprobada' });
    });

    it('recategorizada a MARKETING → motivo propio (otro costo y otro consentimiento)', async () => {
        estado.tablas.whatsapp_template_status[0].category = 'MARKETING';
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'plantilla_recategorizada' });
    });

    it('sin opt-in → motivo, consultando wa_can_send_template con el wa_id normalizado', async () => {
        estado.rpc.wa_can_send_template = () => ({ data: false, error: null });
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'sin_optin' });
        expect(estado.llamadasRpc[0]).toEqual({
            fn: 'wa_can_send_template',
            args: { p_integration_id: INTEG.id, p_contact_wa_id: '573001234567' },
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('si la consulta de opt-in falla, NO se envía', async () => {
        estado.rpc.wa_can_send_template = () => ({ data: null, error: { message: 'timeout' } });
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'sin_optin' });
    });

    it('sin integración activa → motivo', async () => {
        estado.tablas.school_whatsapp_integrations[0].status = 'suspended';
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'sin_integracion' });
    });

    it('teléfono que no es celular colombiano → motivo', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, telefono: '601 555 1234', concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'telefono_invalido' });
    });

    it('sin periodo (variable vacía) → dato_faltante, Meta rechazaría el envío', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, datos: { ...DATOS, periodo: null }, concepto: 'vence_hoy' });
        expect(r).toMatchObject({ enviado: false, motivo: 'dato_faltante' });
    });

    it('sin token para el botón → sin_enlace (la ruta /p/:token aún no existe)', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, tokenBoton: null, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'sin_enlace' });
    });

    it('domingo → fuera_de_horario (Ley 2300 de 2023), aunque todo lo demás esté listo', async () => {
        const domingo = new Date('2026-10-04T15:00:00Z');
        const r = await enviarCobroPorPlantilla({ ...base, ahora: domingo, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'fuera_de_horario' });
    });

    it('festivo → fuera_de_horario igual que domingo (lunes 12-oct-2026, Día de la Raza)', async () => {
        const festivo = new Date('2026-10-12T15:00:00Z'); // lun 10:00 COT
        const r = await enviarCobroPorPlantilla({ ...base, ahora: festivo, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'fuera_de_horario' });
    });

    it('Graph rechaza → error_graph con el detalle, sin lanzar', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: '(#132001) Template name does not exist' } }) });
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'error_graph', detalle: expect.stringContaining('132001') });
    });

    it('lo aprobado en Meta cambió de número de variables → no se envía', async () => {
        estado.tablas.whatsapp_template_status[0].components = componentesDe('pago_recordatorio_previo_v2.json');
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toMatchObject({ enviado: false, motivo: 'variables_no_coinciden' });
    });
});

describe('enviarCobroPorPlantilla — variables de _v3 / _v4', () => {
    it('pago_recordatorio_previo_v3: {{2}}=escuela, {{4}}=periodo, botón con el token', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'recordatorio_previo' });
        expect(r).toEqual({ enviado: true, waMessageId: 'wamid.OK', plantilla: 'pago_recordatorio_previo_v3' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toContain(`/${INTEG.phone_number_id}/messages`);
        const body = JSON.parse(init.body);
        expect(body.to).toBe('573001234567');
        expect(body.type).toBe('template');
        expect(body.template.name).toBe('pago_recordatorio_previo_v3');
        expect(body.template.language).toEqual({ code: 'es_CO' });
        expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual([
            'Carolina', 'Dynasty Volley Club', 'Samuel', 'octubre 2026', '5 de octubre', '$150.000',
        ]);
        expect(body.template.components[1]).toEqual({
            type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'aB3xK9mQ' }],
        });
    });

    it('pago_vence_hoy_v4: 5 variables, {{2}}=escuela, {{4}}=periodo', async () => {
        const r = await enviarCobroPorPlantilla({ ...base, concepto: 'vence_hoy' });
        expect(r).toMatchObject({ enviado: true, plantilla: 'pago_vence_hoy_v4' });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual([
            'Carolina', 'Dynasty Volley Club', 'Samuel', 'octubre 2026', '$150.000',
        ]);
    });

    it('registra el saliente en el buzón como template, con el texto renderizado', async () => {
        await enviarCobroPorPlantilla({ ...base, concepto: 'vence_hoy' });
        const rec = estado.llamadasRpc.find((c) => c.fn === 'wa_record_outbound_message');
        expect(rec?.args).toMatchObject({
            p_conversation_id: 'conv-1', p_type: 'template', p_wa_message_id: 'wamid.OK', p_to_wa_id: '573001234567',
        });
        expect(rec?.args.p_text_body).toContain('Dynasty Volley Club');
        expect(rec?.args.p_text_body).toContain('octubre 2026 vence hoy');
        expect(rec?.args.p_text_body).not.toMatch(/\{\{\d\}\}/);
    });

    it('cada concepto arma tantas variables como su JSON del repo', () => {
        const archivo: Record<string, string> = {
            recordatorio_previo: 'pago_recordatorio_previo_v3.json', vence_manana: 'pago_vence_manana.json',
            vence_hoy: 'pago_vence_hoy_v4.json', pendiente_suave: 'pago_pendiente_suave.json',
            pendiente_directo: 'pago_pendiente_directo.json', aviso_final: 'pago_aviso_final.json',
            pago_confirmado: 'pago_confirmado.json', abono_recibido: 'abono_recibido.json',
            comprobante_rechazado: 'comprobante_rechazado.json',
            pago_recibido_otro_concepto: 'pago_recibido_otro_concepto.json',
            comprobante_en_revision: 'comprobante_en_revision.json',
            recordatorio_clase_cortesia: 'recordatorio_clase_cortesia.json',
            recordatorio_clase_prueba: 'recordatorio_clase_prueba.json',
            clase_prueba_cupo_por_vencer: 'clase_prueba_cupo_por_vencer.json',
            clase_prueba_reprogramada: 'clase_prueba_reprogramada.json',
        };
        const datos = {
            ...DATOS, diasVencido: 7, montoAbono: '$75.000', saldoPendiente: '$75.000', motivo: 'no coincide el valor',
            conceptoPago: 'Uniforme', dia: 'sábado 11 de octubre', hora: '9:00 a. m.', sede: 'Coliseo',
        };
        for (const [concepto, def] of Object.entries(CONCEPTOS)) {
            const json = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../whatsapp-templates', archivo[concepto]), 'utf8'));
            expect(json.name, concepto).toBe(def.plantilla);
            expect(def.variables(datos).length, concepto).toBe(svc.variablesDelCuerpo(json.components));
        }
    });
});

describe('utilidades', () => {
    it('aWaId normaliza celulares colombianos y rechaza lo demás', () => {
        expect(svc.aWaId('+57 300-123-4567')).toBe('573001234567');
        expect(svc.aWaId('3001234567')).toBe('573001234567');
        expect(svc.aWaId('573001234567')).toBe('573001234567');
        expect(svc.aWaId('6015551234')).toBeNull();
        expect(svc.aWaId(null)).toBeNull();
    });

    it('limpiarParametro quita saltos de línea y espacios repetidos (error 132018 de Meta)', () => {
        expect(svc.limpiarParametro(' Samuel\n  Pérez\t ')).toBe('Samuel Pérez');
    });

    it('horario de cobranza: L-V 7-19, sábado 8-15, domingo nunca (COT)', () => {
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-06T11:59:00Z'))).toBe(false); // mar 06:59
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-06T12:00:00Z'))).toBe(true);  // mar 07:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-07T00:00:00Z'))).toBe(false); // mar 19:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-10T19:30:00Z'))).toBe(true);  // sáb 14:30
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-10T20:00:00Z'))).toBe(false); // sáb 15:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-06T07:15:00Z'))).toBe(false); // 02:15, hora del job de vencidos
    });

    it('horario de cobranza: festivos nunca, ni en hora hábil (Ley 2300 art. 3)', () => {
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-12T15:00:00Z'))).toBe(false); // lun festivo 10:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-12-08T15:00:00Z'))).toBe(false); // mar 8-dic 10:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2027-05-01T15:00:00Z'))).toBe(false); // sáb festivo 10:00
        expect(svc.dentroDeHorarioDeCobranza(new Date('2026-10-13T15:00:00Z'))).toBe(true);  // mar siguiente 10:00
    });

    it('armarPayloadPlantilla sin token no agrega el botón', () => {
        const p = armarPayloadPlantilla({ toWaId: '57300', plantilla: 'x', idioma: 'es_CO', variables: ['a'], tokenBoton: null });
        expect(p.template.components).toHaveLength(1);
    });

    it('plantillaAprobada devuelve los componentes aprobados', async () => {
        const r = await plantillaAprobada(INTEG.id, 'vence_hoy');
        expect(r.aprobada).toBe(true);
    });
});

describe('sincronizarPlantillas', () => {
    it('guarda lo que lista Meta y marca DELETED lo que desapareció', async () => {
        estado.tablas.whatsapp_template_status.push(filaPlantilla('pago_vence_hoy_v2', 'pago_vence_hoy_v2.json'));
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                data: [
                    { id: '1', name: 'pago_recordatorio_previo_v3', language: 'es_CO', category: 'UTILITY', status: 'PENDING', components: [] },
                    { id: '2', name: 'pago_vence_hoy_v4', language: 'es_CO', category: 'UTILITY', status: 'APPROVED', components: [] },
                    { id: '3', name: 'rara', language: 'es_CO', category: 'UTILITY', status: 'ALGO_NUEVO', components: [] },
                ],
            }),
        });
        const r = await svc.sincronizarPlantillas(INTEG.id);
        expect(r).toMatchObject({ ok: true, fuente: 'graph', plantillas: 3, aprobadas: 1 });
        expect(fetchMock.mock.calls[0][0]).toContain(`/${INTEG.waba_id}/message_templates`);
        const filas = estado.tablas.whatsapp_template_status;
        expect(filas.find((f) => f.name === 'rara')?.status).toBe('UNKNOWN');
        expect(filas.find((f) => f.name === 'pago_vence_hoy_v2')?.status).toBe('DELETED');
    });

    it('si Graph falla, aplica los eventos del webhook posteriores al último sync', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { message: 'token vencido' } }) });
        estado.tablas.whatsapp_account_events = [{
            field: 'message_template_status_update', template_name: 'pago_vence_hoy_v4', nuevo_estado: 'DISABLED',
            created_at: '2026-10-05T00:00:00Z', integration_id: INTEG.id, waba_id: INTEG.waba_id,
            payload: { value: { event: 'DISABLED', reason: 'NONE', message_template_name: 'pago_vence_hoy_v4', message_template_language: 'es_CO' } },
        }];
        const r = await svc.sincronizarPlantillas(INTEG.id);
        expect(r).toMatchObject({ ok: false, fuente: 'webhook', plantillas: 1, error: 'token vencido' });
        expect(estado.tablas.whatsapp_template_status.find((f) => f.name === 'pago_vence_hoy_v4')?.status).toBe('DISABLED');
    });
});
