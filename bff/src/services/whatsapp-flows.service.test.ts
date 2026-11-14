/**
 * Formularios de WhatsApp (Flows), fase F-a: la infraestructura sin endpoint.
 *
 * Lo que se vigila:
 *   · el Flow JSON del repo pasa las reglas de la doc de Meta (largos, un Footer
 *     por pantalla, sensitive, referencias, rutas, OptIn, nada de documento);
 *   · el validador SÍ ve los errores típicos (no es un validador que todo lo aprueba);
 *   · el flow_token: firmado, con vencimiento, sin secreto no hay token;
 *   · el mensaje `type: flow` cumple los límites (CTA ≤ 30 sin emoji, cuerpo ≤ 1024);
 *   · el `nfm_reply` se lee del webhook (response_json en texto) y nada más se confunde con él;
 *   · cuándo se manda: publicado + prendido + salud AVAILABLE/LIMITED (sin dato → no).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }));

import {
    validarFlowJson, validarDatosDeEntrada, leerFlowDelRepo, pantallaDeEntrada, firmarTokenFormulario,
    verificarTokenFormulario, payloadDeFormulario, ctaValido, respuestaDeFormulario, esRespuestaDeFormulario,
    decisionDeFormulario, saludGuardada, saludDesdeDetalle, esClienteSinFormularios, referenciasDe,
    FLOW_JSON_VERSION, HORAS_VIGENCIA_TOKEN, ENV_SECRETO_TOKEN,
} from './whatsapp-flows.service';
import { parseInboundMessages, parseStatuses } from './whatsapp.service';
import { armarFormularioServicio, PANTALLA_INICIAL_SERVICIO, TEXTO_OPTIN_DATOS, URL_POLITICA_DATOS } from './whatsapp-formulario-servicio';
import type { ItemConFicha } from './whatsapp-anuncio-destino';

const SECRETO = 'secreto-de-prueba-0123456789';
beforeAll(() => { process.env[ENV_SECRETO_TOKEN] = SECRETO; });

const copia = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const FLOW = leerFlowDelRepo('servicio_inscripcion');
const pantalla = (f: any, id: string) => f.screens.find((s: any) => s.id === id);

const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-404a-b0ff-f42dc66c59a8', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: 'Con Jorge Mesa. Incluye camiseta oficial y fotografía con los ponentes.',
};

describe('el Flow JSON del repo (servicio_inscripcion)', () => {
    it('pasa la validación local: 7.3, 4 pantallas, entrada FICHA, terminal RESUMEN', () => {
        expect(validarFlowJson(FLOW.json)).toEqual([]);
        expect(FLOW.json.version).toBe(FLOW_JSON_VERSION);
        expect(FLOW.json.screens.map((s: any) => s.id)).toEqual(['FICHA', 'DEPORTISTA', 'CONSENTIMIENTO', 'RESUMEN']);
        expect(pantallaDeEntrada(FLOW.json)).toBe('FICHA');
        expect(FLOW.versionRepo).toMatch(/^[0-9a-f]{12}$/);
    });

    it('sin endpoint: ni data_api_version, ni routing_model, ni data_exchange', () => {
        expect(FLOW.texto).not.toMatch(/data_api_version|routing_model|data_channel_uri|data_exchange/);
    });

    it('el consentimiento de datos es obligatorio y con «Leer más» a la política unificada', () => {
        const c = pantalla(FLOW.json, 'CONSENTIMIENTO').layout.children;
        const datos = c.find((x: any) => x.name === 'acepta_datos');
        expect(datos).toMatchObject({ type: 'OptIn', required: true, 'on-click-action': { name: 'open_url', url: 'https://app.sportmaps.co/politica-de-privacidad' } });
        // Lo que se guarda como prueba de qué aceptó es EXACTAMENTE lo que se le mostró.
        expect(datos.label).toBe(TEXTO_OPTIN_DATOS);
        expect(datos['on-click-action'].url).toBe(URL_POLITICA_DATOS);
        const novedades = c.find((x: any) => x.name === 'acepta_novedades');
        expect(novedades.type).toBe('OptIn');
        expect(novedades.required).toBeUndefined();
    });

    it('pide lo justo: nombre, fecha (DatePicker), afiliado y talla; nada de documento; nombre y fecha son sensibles', () => {
        const d = pantalla(FLOW.json, 'DEPORTISTA');
        const nombres = d.layout.children.filter((x: any) => x.name).map((x: any) => `${x.type}:${x.name}`);
        expect(nombres).toEqual(['TextInput:nombre_deportista', 'DatePicker:fecha_nacimiento', 'RadioButtonsGroup:afiliado', 'Dropdown:talla']);
        expect(d.sensitive).toEqual(['nombre_deportista', 'fecha_nacimiento']);
        expect(FLOW.texto).not.toMatch(/c[eé]dula|documento|tarjeta de identidad|pasaporte/i);
    });

    it('el complete manda todo lo que el handler lee', () => {
        const footer = pantalla(FLOW.json, 'RESUMEN').layout.children.find((x: any) => x.type === 'Footer');
        expect(footer['on-click-action'].name).toBe('complete');
        expect(Object.keys(footer['on-click-action'].payload).sort()).toEqual(
            ['acepta_datos', 'acepta_novedades', 'afiliado', 'fecha_nacimiento', 'forma_pago', 'formulario', 'nombre_deportista', 'talla']);
    });
});

describe('validarFlowJson ve lo que Meta rechazaría', () => {
    const conProblema = (cambiar: (f: any) => void, esperado: RegExp) => {
        const f = copia(FLOW.json);
        cambiar(f);
        const p = validarFlowJson(f);
        expect(p.map((x) => `${x.ruta}: ${x.problema}`).join('\n')).toMatch(esperado);
    };

    it('dos Footer en una pantalla', () => conProblema((f) => {
        pantalla(f, 'FICHA').layout.children.push({ type: 'Footer', label: 'Otro', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: 'DEPORTISTA' }, payload: {} } });
    }, /exactamente un Footer/));

    it('dato declarado sin __example__', () => conProblema((f) => { delete pantalla(f, 'FICHA').data.servicio.__example__; }, /__example__/));

    it('un campo que pide la cédula', () => conProblema((f) => {
        pantalla(f, 'DEPORTISTA').layout.children.splice(1, 0, { type: 'TextInput', name: 'cedula', label: 'Cédula', required: true });
    }, /documento de identidad/));

    it('más de 5 OptIn', () => conProblema((f) => {
        const c = pantalla(f, 'CONSENTIMIENTO').layout.children;
        for (let i = 0; i < 4; i++) c.splice(1, 0, { type: 'OptIn', name: `extra_${i}`, label: 'Otra casilla' });
    }, /más de 5 OptIn/));

    it('textos estáticos vacíos o largos', () => {
        conProblema((f) => { pantalla(f, 'FICHA').layout.children.find((x: any) => x.type === 'Footer').label = ' '; }, /texto vacío/);
        conProblema((f) => { pantalla(f, 'FICHA').layout.children.find((x: any) => x.type === 'Footer').label = 'Un botón con un texto demasiado largo para Meta'; }, /máx\. 35/);
        conProblema((f) => { pantalla(f, 'DEPORTISTA').layout.children[1].label = 'Nombre completo del deportista'; }, /máx\. 20/);
    });

    it('referencias rotas, pantallas sueltas, data_exchange y `sensitive` que no existe', () => {
        conProblema((f) => { pantalla(f, 'RESUMEN').layout.children[0].text = '${screen.FICHA.data.no_existe}'; }, /no está declarado/);
        conProblema((f) => { pantalla(f, 'RESUMEN').layout.children[2].text = '${screen.DEPORTISTA.form.cedula}'; }, /no es un campo/);
        conProblema((f) => { f.screens.push({ id: 'SUELTA', title: 'x', terminal: true, layout: { type: 'SingleColumnLayout', children: [{ type: 'Footer', label: 'Fin', 'on-click-action': { name: 'complete', payload: { a: '1' } } }] } }); }, /una sola pantalla de entrada/);
        conProblema((f) => { pantalla(f, 'FICHA').layout.children.find((x: any) => x.type === 'Footer')['on-click-action'] = { name: 'data_exchange', payload: {} }; }, /data_exchange necesita endpoint/);
        conProblema((f) => { pantalla(f, 'DEPORTISTA').sensitive = ['cedula']; }, /no es un campo de esta pantalla/);
    });

    it('referenciasDe lee las tres formas', () => {
        expect(referenciasDe('${data.a} ${form.b} ${screen.FICHA.data.c} ${screen.DEPORTISTA.form.d}')).toEqual([
            { pantalla: null, tipo: 'data', clave: 'a' }, { pantalla: null, tipo: 'form', clave: 'b' },
            { pantalla: 'FICHA', tipo: 'data', clave: 'c' }, { pantalla: 'DEPORTISTA', tipo: 'form', clave: 'd' },
        ]);
    });
});

describe('validarDatosDeEntrada (lo que se inyecta al enviar)', () => {
    const armado = armarFormularioServicio({ item: CLINICA, escuela: 'Monster´s Volley Club', hoy: '2026-11-04' })!;

    it('los datos de la clínica de Monster caben en la ficha', () => {
        expect(validarDatosDeEntrada(FLOW.json, PANTALLA_INICIAL_SERVICIO, armado.data)).toEqual([]);
    });

    it('ve una clave que falta, un null, un tipo equivocado, un texto vacío y una lista vacía', () => {
        const d = copia(armado.data) as Record<string, unknown>;
        delete d.cuando;
        d.abono = null;
        d.hay_abono = 'sí';
        d.servicio = '';
        d.tallas = [];
        const p = validarDatosDeEntrada(FLOW.json, PANTALLA_INICIAL_SERVICIO, d).map((x) => `${x.ruta}: ${x.problema}`).join('\n');
        expect(p).toMatch(/data\.cuando: falta/);
        expect(p).toMatch(/data\.abono: null/);
        expect(p).toMatch(/data\.hay_abono: tipo string/);
        expect(p).toMatch(/data\.servicio: vacío/);
        expect(p).toMatch(/data\.tallas: arreglo vacío/);
    });

    it('un texto inyectado más largo que su componente (TextHeading ≤ 80, OptIn ≤ 120)', () => {
        const d = { ...armado.data, servicio: 'x'.repeat(81), label_novedades: 'y'.repeat(121) };
        const p = validarDatosDeEntrada(FLOW.json, PANTALLA_INICIAL_SERVICIO, d).map((x) => x.problema).join('\n');
        expect(p).toMatch(/81 caracteres .*máx\. 80/);
        expect(p).toMatch(/121 caracteres .*máx\. 120/);
    });
});

describe('flow_token firmado', () => {
    const base = {
        schoolId: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c', conversationId: '5b0f2f0e-1111-4c1c-9c1c-1c1c1c1c1c1c',
        contactWaId: '573001234567', formulario: 'servicio_inscripcion', servicioId: CLINICA.id,
        precios: { lista: 300000, afiliado: 250000, abonoPct: 50 },
    };
    const AHORA = Date.parse('2026-11-04T15:00:00Z');

    it('ida y vuelta: escuela, conversación, contacto, servicio, precios y 72 h de vigencia', () => {
        const t = firmarTokenFormulario(base, { ahora: AHORA })!;
        expect(t).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        const v = verificarTokenFormulario(t, { ahora: AHORA + 3600_000 });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.token).toMatchObject({ ...base, venceEn: AHORA + HORAS_VIGENCIA_TOKEN * 3600_000 });
        expect(v.token.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    });

    it('vencido a las 72 h (y dice cuál era)', () => {
        const t = firmarTokenFormulario(base, { ahora: AHORA })!;
        const v = verificarTokenFormulario(t, { ahora: AHORA + 72 * 3600_000 + 1 });
        expect(v).toMatchObject({ ok: false, motivo: 'vencido', token: { servicioId: CLINICA.id } });
    });

    it('cualquier cambio en los datos o la firma lo invalida', () => {
        const t = firmarTokenFormulario(base, { ahora: AHORA })!;
        const [v, datos, firma] = t.split('.');
        const otro = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(datos, 'base64url').toString()), p: [1, 1, 50] })).toString('base64url');
        expect(verificarTokenFormulario(`${v}.${otro}.${firma}`, { ahora: AHORA })).toMatchObject({ ok: false, motivo: 'firma' });
        expect(verificarTokenFormulario(`${v}.${datos}.${firma.slice(0, -1)}${firma.endsWith('A') ? 'B' : 'A'}`, { ahora: AHORA })).toMatchObject({ ok: false, motivo: 'firma' });
        expect(verificarTokenFormulario(t, { ahora: AHORA, secreto: 'otro-secreto-de-16-caracteres' })).toMatchObject({ ok: false, motivo: 'firma' });
        expect(verificarTokenFormulario('unused', { ahora: AHORA })).toMatchObject({ ok: false, motivo: 'formato' });
        expect(verificarTokenFormulario(null, { ahora: AHORA })).toMatchObject({ ok: false, motivo: 'formato' });
    });

    it('sin secreto (o uno corto) no se firma ni se acepta nada', () => {
        expect(firmarTokenFormulario(base, { secreto: 'corto' })).toBeNull();
        const t = firmarTokenFormulario(base, { ahora: AHORA })!;
        expect(verificarTokenFormulario(t, { secreto: 'corto' })).toMatchObject({ ok: false, motivo: 'sin_secreto' });
    });
});

describe('el mensaje interactivo `flow`', () => {
    const m = {
        flowId: '1234567890', cta: 'Inscribirme', cuerpo: '¿Quieres dejar listo el cupo?', token: 'v1.a.b',
        pantalla: 'FICHA', data: { servicio: 'Clínica' },
    };

    it('arma el payload de Graph: flow_message_version 3, navigate a FICHA con los datos', () => {
        expect(payloadDeFormulario('573001234567', { ...m, modo: 'draft' })).toEqual({
            messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001234567', type: 'interactive',
            interactive: {
                type: 'flow',
                body: { text: '¿Quieres dejar listo el cupo?' },
                action: {
                    name: 'flow',
                    parameters: {
                        flow_message_version: '3', flow_id: '1234567890', flow_cta: 'Inscribirme', flow_token: 'v1.a.b',
                        mode: 'draft', flow_action: 'navigate', flow_action_payload: { screen: 'FICHA', data: { servicio: 'Clínica' } },
                    },
                },
            },
        });
    });

    it('published por defecto; data como texto si se pide', () => {
        const p: any = payloadDeFormulario('573001234567', { ...m, dataComoTexto: true });
        expect(p.interactive.action.parameters.mode).toBe('published');
        expect(p.interactive.action.parameters.flow_action_payload.data).toBe('{"servicio":"Clínica"}');
    });

    it('no cabe → null (y quien llama sigue por chat)', () => {
        expect(payloadDeFormulario('57300', { ...m, cta: 'Inscribirme 📝' })).toBeNull();
        expect(payloadDeFormulario('57300', { ...m, cta: 'x'.repeat(31) })).toBeNull();
        expect(payloadDeFormulario('57300', { ...m, cuerpo: 'x'.repeat(1025) })).toBeNull();
        expect(payloadDeFormulario('57300', { ...m, data: {} })).toBeNull();
        expect(payloadDeFormulario('57300', { ...m, flowName: 'otro' })).toBeNull();
        expect(payloadDeFormulario('57300', { ...m, token: '' })).toBeNull();
        expect(ctaValido('Inscribirme')).toBe(true);
        expect(ctaValido('🏐 Inscribirme')).toBe(false);
    });
});

describe('la respuesta (interactive.nfm_reply)', () => {
    const nfm = (response_json: unknown) => ({
        from: '573001234567', id: 'wamid.FORM1', timestamp: '1762268400', type: 'interactive',
        context: { from: '573188682241', id: 'wamid.ENVIO' },
        interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json } },
    });

    it('lee el response_json (texto), separa el flow_token', () => {
        const r = respuestaDeFormulario(nfm(JSON.stringify({ flow_token: 'v1.x.y', nombre_deportista: 'Mariana', acepta_datos: true })));
        expect(r).toEqual({ token: 'v1.x.y', datos: { nombre_deportista: 'Mariana', acepta_datos: true }, legible: true });
    });

    it('ilegible → legible false; un botón o un texto no son formularios', () => {
        expect(respuestaDeFormulario(nfm('{roto'))).toEqual({ token: null, datos: {}, legible: false });
        expect(respuestaDeFormulario({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Sí' } } })).toBeNull();
        expect(esRespuestaDeFormulario({ type: 'text', text: { body: 'hola' } })).toBe(false);
    });

    it('el webhook lo trae como interactive con «Formulario enviado» para el buzón y sin botonId', () => {
        const body = { entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '573001234567', profile: { name: 'Ana' } }],
            messages: [nfm(JSON.stringify({ flow_token: 't' }))],
        } }] }] };
        const [m] = parseInboundMessages(body);
        expect(m).toMatchObject({ type: 'interactive', textBody: 'Formulario enviado', botonId: null, waMessageId: 'wamid.FORM1' });
        expect(esRespuestaDeFormulario(m.raw)).toBe(true);
    });

    it('el estado fallido trae el código (131026 → sigue por chat)', () => {
        const [s] = parseStatuses({ entry: [{ changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: '111' },
            statuses: [{ id: 'wamid.ENVIO', status: 'failed', timestamp: '1762268400', recipient_id: '573001234567',
                errors: [{ code: 131026, title: 'Message Undeliverable' }] }],
        } }] }] });
        expect(s).toMatchObject({ status: 'failed', errorCode: 131026, errorDetail: 'Message Undeliverable' });
        expect(esClienteSinFormularios(s.errorCode, s.errorDetail)).toBe(true);
        expect(esClienteSinFormularios(131047, 'Re-engagement message')).toBe(false);
    });
});

describe('¿se manda el formulario?', () => {
    const fila = { flow_id: '123', activo: true, estado: 'PUBLISHED' };

    it('solo publicado, prendido, con flow_id y salud AVAILABLE/LIMITED', () => {
        expect(decisionDeFormulario(fila, 'AVAILABLE')).toBe('listo');
        expect(decisionDeFormulario(fila, 'LIMITED')).toBe('listo');
        expect(decisionDeFormulario(fila, 'BLOCKED')).toBe('bloqueado');
        expect(decisionDeFormulario(fila, null)).toBe('sin_salud');
        expect(decisionDeFormulario({ ...fila, activo: false }, 'AVAILABLE')).toBe('apagado');
        expect(decisionDeFormulario({ ...fila, estado: 'DRAFT' }, 'AVAILABLE')).toBe('no_publicado');
        expect(decisionDeFormulario({ ...fila, estado: 'THROTTLED' }, 'AVAILABLE')).toBe('no_publicado');
        expect(decisionDeFormulario({ ...fila, flow_id: null }, 'AVAILABLE')).toBe('sin_formulario');
        expect(decisionDeFormulario(null, 'AVAILABLE')).toBe('sin_formulario');
    });

    it('la salud guardada vale 24 h', () => {
        const ahora = Date.parse('2026-11-04T15:00:00Z');
        expect(saludGuardada({ health_can_send: 'AVAILABLE', health_revisado_at: '2026-11-04T00:00:00Z' }, ahora)).toBe('AVAILABLE');
        expect(saludGuardada({ health_can_send: 'AVAILABLE', health_revisado_at: '2026-11-03T14:00:00Z' }, ahora)).toBeUndefined();
        expect(saludGuardada({ health_can_send: null, health_revisado_at: '2026-11-04T00:00:00Z' }, ahora)).toBeUndefined();
    });

    it('lee el health_status de Meta (negocio sin verificar → BLOCKED con su motivo)', () => {
        const s = saludDesdeDetalle({
            status: 'DRAFT',
            health_status: {
                can_send_message: 'BLOCKED',
                entities: [
                    { entity_type: 'FLOW', id: '1', can_send_message: 'AVAILABLE' },
                    { entity_type: 'BUSINESS', id: '2', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'Business is not verified' }] },
                ],
            },
        });
        expect(s.estado).toBe('DRAFT');
        expect(s.puedeEnviar).toBe('BLOCKED');
        expect(s.entidades[1]).toEqual({ tipo: 'BUSINESS', id: '2', puede: 'BLOCKED', problemas: ['141006 Business is not verified'] });
    });
});
