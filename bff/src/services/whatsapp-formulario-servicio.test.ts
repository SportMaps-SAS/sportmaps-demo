/**
 * Formulario F2 «Inscripción a un servicio» (fase F-a): lo que se inyecta al
 * enviar y lo que hace el bot con la respuesta. Sin base y sin Meta: el
 * contexto es un doble.
 *
 * Lo que se vigila:
 *   · la ficha del formulario dice el precio de HOY, el que sigue, el de
 *     afiliado y el abono; pide talla solo si el servicio incluye camiseta;
 *   · la respuesta: consentimientos (+ opt-in con «novedades»), lead con los
 *     datos, motivo esperado con el monto ELEGIDO (completo/abono, afiliado) y
 *     los datos de pago — UN mensaje;
 *   · sin consentimiento de datos: nada personal guardado, se pide aceptarlo;
 *   · token inválido / vencido / de otro contacto: no aplica nada, avisa al buzón;
 *   · servicio desactivado: a una persona; precio cambiado: el vigente y se le dice;
 *   · respuesta duplicada: silencio (ya se contestó).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }));

import {
    armarFormularioServicio, atenderRespuestaDeFormulario, leerRespuestaServicio, fechaDeNacimiento, cobroDelFormulario,
    pideTalla, tallasDe, sinDatosPersonales, textoConfirmacion, textoRespaldoFormulario, textoOptinNovedades,
    TEXTO_OPTIN_DATOS, VERSION_POLITICA_DATOS, FORMULARIO_SERVICIO,
    type CtxRespuestaFormulario, type ConsentimientoNuevo, type LeadDeFormulario,
} from './whatsapp-formulario-servicio';
import { firmarTokenFormulario, ENV_SECRETO_TOKEN, type PreciosMostrados } from './whatsapp-flows.service';
import { atenderDestinoDeAnuncio, type CtxAnuncio, type ItemConFicha } from './whatsapp-anuncio-destino';
import type { FilaReciente } from './whatsapp-reglas-turno';

beforeAll(() => { process.env[ENV_SECRETO_TOKEN] = 'secreto-de-prueba-0123456789'; });

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CONV = '5b0f2f0e-1111-4c1c-9c1c-1c1c1c1c1c1c';
const TEL = '573001234567';
const CLINICA: ItemConFicha = {
    id: '16766d2e-f8b0-404a-b0ff-f42dc66c59a8', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:00Z',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null,
    description: 'Clínica con Jorge Mesa. 21 y 22 de noviembre. Incluye camiseta oficial y fotografía con los ponentes.',
};
const VACACIONAL: ItemConFicha = {
    id: 'fff41827-cd2f-404a-b0ff-f42dc66c59a8', name: 'Vacacional de voleibol', kind: 'vacacional', price: 100000, active: true,
    event_id: null, starts_at: null, ends_at: null, description: null,
    opciones: [{ clave: '1', etiqueta: '1 semana', precio: 100000 }],
};
const HOY = '2026-11-04';
const AHORA = new Date('2026-11-04T15:00:00Z');
const MOSTRADOS: PreciosMostrados = { lista: 300000, afiliado: 250000, abonoPct: 50 };

// ─── Lo que se inyecta ───────────────────────────────────────────────────────

describe('armarFormularioServicio (la ficha del formulario)', () => {
    it('la clínica de Monster: precio de hoy con el tramo que sigue, afiliado, abono, talla y cuándo', () => {
        const a = armarFormularioServicio({ item: CLINICA, escuela: 'Monster´s Volley Club', hoy: HOY })!;
        expect(a.precios).toEqual(MOSTRADOS);
        expect(a.data).toMatchObject({
            servicio: 'Clínica de armadores y atacantes',
            valor: 'Valor hoy: $300.000 (hasta el 10 de noviembre; desde el 11 de noviembre, $350.000)',
            valor_afiliado: 'Si ya entrena en el club: $250.000', hay_afiliado: true,
            abono: 'Separas el cupo con un abono mínimo de $150.000 (50 %); $125.000 si ya entrena en el club.', hay_abono: true,
            hay_cuando: true, hay_incluye: true, fecha_max: HOY, pide_talla: true,
            label_novedades: 'Quiero recibir novedades de Monster´s Volley Club por WhatsApp.',
            resumen_valores: 'Valor completo: $300.000\nAbono para separar el cupo: $150.000',
            resumen_valores_afiliado: 'Valor de afiliado: $250.000\nAbono para separar el cupo: $125.000',
        });
        expect(a.data.cuando).toMatch(/^Del 21 al 22 de noviembre$/);
        expect((a.data.tallas as any[]).length).toBe(10);
        expect(a.cuerpo).toContain('*Clínica de armadores y atacantes*');
        expect(a.cuerpo).toContain('*Inscribirme*');
        expect(JSON.stringify(a.data)).not.toMatch(/undefined|null|NaN|gratis/);
    });

    it('desde el 11 de noviembre: $350.000 y sin «tramo que sigue»', () => {
        const a = armarFormularioServicio({ item: CLINICA, escuela: 'Monster', hoy: '2026-11-11' })!;
        expect(a.data.valor).toBe('Valor hoy: $350.000');
        expect(a.precios).toEqual({ lista: 350000, afiliado: 250000, abonoPct: 50 });
    });

    it('sin afiliado, sin abono, sin fecha, sin descripción: textos «—» ocultos, nunca vacíos', () => {
        const a = armarFormularioServicio({
            item: { ...CLINICA, precio_afiliado: null, allow_installments: false, starts_at: null, ends_at: null, description: null },
            escuela: 'Monster', hoy: HOY,
        })!;
        expect(a.data).toMatchObject({ hay_afiliado: false, valor_afiliado: '—', hay_abono: false, abono: '—', hay_cuando: false, cuando: '—', hay_incluye: false, incluye: '—', pide_talla: false });
        expect(a.data.tallas).toEqual([{ id: 'na', title: 'No aplica' }]);
        expect(a.data.resumen_valores_afiliado).toBe(a.data.resumen_valores);
        expect(a.precios).toEqual({ lista: 300000, afiliado: null, abonoPct: null });
    });

    it('con opciones por semana (vacacional) no hay formulario: sigue el chat', () => {
        expect(armarFormularioServicio({ item: VACACIONAL, escuela: 'Monster', hoy: HOY })).toBeNull();
        expect(armarFormularioServicio({ item: { ...CLINICA, price: null, precios_por_fecha: null }, escuela: 'Monster', hoy: HOY })).toBeNull();
    });

    it('talla: por la descripción, o la escuela lo fija; sus tallas si son válidas', () => {
        expect(pideTalla(CLINICA)).toBe(true);
        expect(pideTalla({ name: 'Torneo', description: 'Inscripción por equipo' })).toBe(false);
        expect(pideTalla({ name: 'Torneo', description: 'Inscripción' }, { pedir_talla: 'siempre' })).toBe(true);
        expect(pideTalla(CLINICA, { pedir_talla: 'nunca' })).toBe(false);
        expect(tallasDe({ tallas: ['S', 'M', 'L'] })).toEqual(['S', 'M', 'L']);
        expect(tallasDe({ tallas: ['S', ''] })).toHaveLength(10);
        expect(textoOptinNovedades('x'.repeat(200))).toBe('Quiero recibir novedades de la escuela por WhatsApp.');
    });
});

// ─── Lo que llega ────────────────────────────────────────────────────────────

describe('leer la respuesta', () => {
    it('datos limpios; «na» no es talla; booleanos en texto también', () => {
        expect(leerRespuestaServicio({
            nombre_deportista: '  Mariana   Gómez ', fecha_nacimiento: '2012-05-09', afiliado: 'si', talla: 'na',
            acepta_datos: 'true', acepta_novedades: false, forma_pago: 'abono',
        }, HOY)).toEqual({
            deportista: 'Mariana Gómez', fechaNacimiento: '2012-05-09', afiliado: 'si', talla: null,
            aceptaDatos: true, aceptaNovedades: false, formaPago: 'abono',
        });
        expect(leerRespuestaServicio({}, HOY)).toMatchObject({ deportista: null, aceptaDatos: false, formaPago: 'completo' });
    });

    it('fecha: YYYY-MM-DD real, no futura; milisegundos de clientes viejos', () => {
        expect(fechaDeNacimiento('2012-02-30', HOY)).toBeNull();
        expect(fechaDeNacimiento('2027-01-01', HOY)).toBeNull();
        expect(fechaDeNacimiento('1890-01-01', HOY)).toBeNull();
        expect(fechaDeNacimiento(String(Date.UTC(2012, 4, 9, 5)), HOY)).toBe('2012-05-09');
    });

    it('sin consentimiento solo quedan las casillas y la forma de pago', () => {
        expect(sinDatosPersonales({ formulario: 'x', nombre_deportista: 'Ana', fecha_nacimiento: '2012-01-01', acepta_datos: false, forma_pago: 'abono', talla: 'M' }))
            .toEqual({ formulario: 'x', acepta_datos: false, forma_pago: 'abono' });
    });

    it('cobro: abono del valor que le corresponde y lo que vio en el formulario', () => {
        expect(cobroDelFormulario(CLINICA, { formaPago: 'abono' }, { deAfiliado: false, hoy: HOY, mostrados: MOSTRADOS }))
            .toEqual({ precio: 300000, abono: 150000, monto: 150000, pct: 50, deAfiliado: false, montoMostrado: 150000 });
        expect(cobroDelFormulario(CLINICA, { formaPago: 'completo' }, { deAfiliado: true, hoy: HOY, mostrados: MOSTRADOS }))
            .toMatchObject({ precio: 250000, abono: null, monto: 250000, montoMostrado: 250000 });
        // Lo llenó el 10 y lo mandó el 11: el vigente es $350.000.
        expect(cobroDelFormulario(CLINICA, { formaPago: 'completo' }, { deAfiliado: false, hoy: '2026-11-11', mostrados: MOSTRADOS }))
            .toMatchObject({ monto: 350000, montoMostrado: 300000 });
        // Abono pedido en un servicio sin abono: completo.
        expect(cobroDelFormulario({ ...CLINICA, allow_installments: false }, { formaPago: 'abono' }, { deAfiliado: false, hoy: HOY, mostrados: null }))
            .toMatchObject({ abono: null, monto: 300000, montoMostrado: null });
    });
});

// ─── El motor ────────────────────────────────────────────────────────────────

interface Registro {
    enviados: { texto: string; contexto: Record<string, unknown> }[];
    respuestas: Record<string, unknown>[];
    cierres: { resultado: string; detalle: Record<string, unknown> }[];
    consentimientos: ConsentimientoNuevo[];
    optins: number;
    leads: LeadDeFormulario[];
    esperados: { motivo: string; leadId: string | null; monto: number }[];
    avisos: string[];
    reenvios: number;
}

function ctxDe(o: {
    item?: ItemConFicha | null; afiliado?: boolean; cuentas?: { tipo: string; numero: string }[];
    duplicada?: boolean; contacto?: string; reenviar?: boolean;
} = {}): { ctx: CtxRespuestaFormulario; reg: Registro } {
    const reg: Registro = { enviados: [], respuestas: [], cierres: [], consentimientos: [], optins: 0, leads: [], esperados: [], avisos: [], reenvios: 0 };
    const ctx: CtxRespuestaFormulario = {
        schoolId: ESCUELA, contactWaId: o.contacto ?? TEL, conversationId: CONV, escuela: 'Monster´s Volley Club',
        guardarRespuesta: async (r) => {
            if (o.duplicada) return { estado: 'duplicada', id: null };
            reg.respuestas.push(r as any);
            return { estado: 'nueva', id: 'resp-1' };
        },
        cerrarRespuesta: async (_id, resultado, detalle) => { reg.cierres.push({ resultado, detalle }); },
        servicio: async () => (o.item === undefined ? CLINICA : o.item),
        afiliado: async () => o.afiliado ?? false,
        cuentas: async () => o.cuentas ?? [{ tipo: 'Nequi', numero: '3194505150' }],
        guardarConsentimientos: async (c) => { reg.consentimientos.push(...c); return true; },
        registrarOptin: async () => { reg.optins++; return true; },
        guardarLead: async (l) => { reg.leads.push(l); return 'lead-1'; },
        registrarEsperado: async (e) => { reg.esperados.push(e); return true; },
        enviar: async (texto, contexto) => { reg.enviados.push({ texto, contexto }); },
        reenviarFormulario: async () => { reg.reenvios++; return o.reenviar ?? true; },
        avisarEscuela: async (d) => { reg.avisos.push(d); },
        ahora: () => AHORA,
    };
    return { ctx, reg };
}

const tokenDe = (o: { ahora?: number; precios?: PreciosMostrados; contacto?: string; servicioId?: string; secreto?: string } = {}) =>
    firmarTokenFormulario({
        schoolId: ESCUELA, conversationId: CONV, contactWaId: o.contacto ?? TEL, formulario: FORMULARIO_SERVICIO,
        servicioId: o.servicioId ?? CLINICA.id, precios: o.precios ?? MOSTRADOS,
    }, { ahora: o.ahora ?? AHORA.getTime(), ...(o.secreto ? { secreto: o.secreto } : {}) })!;

const respuesta = (datos: Record<string, unknown> = {}, token: string | null = tokenDe()) => ({
    token, legible: true,
    datos: {
        formulario: FORMULARIO_SERVICIO, nombre_deportista: 'Mariana Gómez', fecha_nacimiento: '2012-05-09', afiliado: 'no',
        talla: 'M', acepta_datos: true, acepta_novedades: true, forma_pago: 'completo', ...datos,
    },
});

describe('atenderRespuestaDeFormulario', () => {
    it('completo, no afiliado: consentimientos + opt-in, lead con los datos, esperado de $300.000 y los datos de pago', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderRespuestaDeFormulario(ctx, respuesta())).toBe('procesada');
        expect(reg.consentimientos).toEqual([
            { tipo: 'datos', aceptado: true, texto: TEXTO_OPTIN_DATOS, versionPolitica: VERSION_POLITICA_DATOS },
            { tipo: 'novedades', aceptado: true, texto: 'Quiero recibir novedades de Monster´s Volley Club por WhatsApp.', versionPolitica: VERSION_POLITICA_DATOS },
        ]);
        expect(reg.optins).toBe(1);
        expect(reg.leads).toHaveLength(1);
        expect(reg.leads[0]).toMatchObject({
            servicio: { id: CLINICA.id, nombre: CLINICA.name, tipo: 'clase_extra' }, deportista: 'Mariana Gómez', fechaNacimiento: '2012-05-09',
            formulario: { nombre: FORMULARIO_SERVICIO, respuesta_id: 'resp-1', talla: 'M', forma_pago: 'completo', afiliado_declarado: false, monto: 300000 },
        });
        expect(reg.esperados).toEqual([{ motivo: 'clase_extra', leadId: 'lead-1', monto: 300000 }]);
        expect(reg.enviados).toHaveLength(1);
        const t = reg.enviados[0].texto;
        expect(t).toContain('*Mariana Gómez*');
        expect(t).toContain('Valor a pagar: *$300.000*');
        expect(t).toContain('Talla de camiseta: M');
        expect(t).toMatch(/Nequi al número 3194505150[\s\S]*comprobante/);
        expect(t).not.toMatch(/cambió|afiliado|undefined|null|gratis/);
        expect(reg.enviados[0].contexto).toMatchObject({ step: 'formulario_respuesta', monto: 300000, forma_pago: 'completo', motivo_esperado: { motivo: 'clase_extra', monto: 300000, registrado: true } });
        expect(reg.avisos).toEqual([]);
        expect(reg.cierres).toEqual([{ resultado: 'procesada', detalle: expect.objectContaining({ monto: 300000, lead_id: 'lead-1', optin: true }) }]);
        expect(reg.respuestas[0]).toMatchObject({ formulario: FORMULARIO_SERVICIO, servicioId: CLINICA.id, responseJson: expect.objectContaining({ nombre_deportista: 'Mariana Gómez' }) });
    });

    it('abono, no afiliado: $150.000 esperado y «quedan $150.000»', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ forma_pago: 'abono', acepta_novedades: false }))).toBe('procesada');
        expect(reg.esperados[0].monto).toBe(150000);
        expect(reg.enviados[0].texto).toContain('Pagas ahora el abono para separar el cupo: *$150.000* (50 %); quedan $150.000 pendientes.');
        expect(reg.optins).toBe(0);
        expect(reg.consentimientos[1]).toMatchObject({ tipo: 'novedades', aceptado: false });
    });

    it('afiliado verificado por el número: $250.000, sin aviso', async () => {
        const { ctx, reg } = ctxDe({ afiliado: true });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ afiliado: 'no' }))).toBe('procesada');
        expect(reg.esperados[0].monto).toBe(250000);
        expect(reg.enviados[0].texto).toContain('Valor a pagar (afiliado): *$250.000*');
        expect(reg.enviados[0].texto).not.toMatch(/la escuela confirma/);
        expect(reg.avisos).toEqual([]);
    });

    it('dice que es del club pero el número no lo confirma: valor de afiliado, se lo dice y avisa a la escuela', async () => {
        const { ctx, reg } = ctxDe({ afiliado: false });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ afiliado: 'si', forma_pago: 'abono' }))).toBe('procesada');
        expect(reg.esperados[0].monto).toBe(125000);
        expect(reg.enviados[0].texto).toContain('Valor de afiliado: $250.000');
        expect(reg.enviados[0].texto).toContain('la escuela confirma que el deportista ya entrena en el club');
        expect(reg.avisos.join(' ')).toMatch(/valor de afiliado .* confírmalo/);
    });

    it('sin consentimiento de datos: nada personal, ni lead ni esperado; se lo pide y reenvía el formulario', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ acepta_datos: false }))).toBe('sin_consentimiento');
        expect(reg.respuestas[0].responseJson).toEqual({ formulario: FORMULARIO_SERVICIO, acepta_datos: false, acepta_novedades: true, forma_pago: 'completo' });
        expect(reg.consentimientos).toEqual([]);
        expect(reg.optins).toBe(0);
        expect(reg.leads).toEqual([]);
        expect(reg.esperados).toEqual([]);
        expect(reg.reenvios).toBe(1);
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toMatch(/aceptes la política[\s\S]*Te lo dejo otra vez/);
    });

    it('sin consentimiento y sin poder reenviar: pide escribir y avisa al buzón', async () => {
        const { ctx, reg } = ctxDe({ reenviar: false });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ acepta_datos: false }))).toBe('sin_consentimiento');
        expect(reg.enviados[0].texto).toMatch(/alguien de la escuela te ayuda/);
        expect(reg.avisos).toHaveLength(1);
    });

    it('token con la firma alterada: no aplica nada, avisa al buzón y no guarda datos personales', async () => {
        const { ctx, reg } = ctxDe();
        const malo = tokenDe({ secreto: 'otro-secreto-de-16-caracteres' });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({}, malo))).toBe('token_invalido');
        expect(reg.respuestas[0].responseJson).not.toHaveProperty('nombre_deportista');
        expect([reg.consentimientos, reg.leads, reg.esperados]).toEqual([[], [], []]);
        expect(reg.enviados).toHaveLength(1);
        expect(reg.enviados[0].texto).toMatch(/No pude validar este formulario/);
        expect(reg.avisos).toHaveLength(1);
        expect(reg.cierres[0]).toMatchObject({ resultado: 'token_invalido', detalle: { motivo: 'firma' } });
    });

    it('sin token (formulario de otro lado) o de OTRO contacto: inválido', async () => {
        const a = ctxDe();
        expect(await atenderRespuestaDeFormulario(a.ctx, respuesta({}, null))).toBe('token_invalido');
        const b = ctxDe({ contacto: '573009999999' });
        expect(await atenderRespuestaDeFormulario(b.ctx, respuesta())).toBe('token_invalido');
        expect(b.reg.cierres[0].detalle).toEqual({ motivo: 'ajeno' });
        expect(b.reg.leads).toEqual([]);
    });

    it('token vencido (más de 72 h): se lo dice y avisa', async () => {
        const { ctx, reg } = ctxDe();
        const viejo = tokenDe({ ahora: AHORA.getTime() - 73 * 3600_000 });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({}, viejo))).toBe('token_vencido');
        expect(reg.enviados[0].texto).toMatch(/ya venció/);
        expect(reg.avisos[0]).toMatch(/vencido/);
        expect(reg.leads).toEqual([]);
    });

    it('el servicio se desactivó entre el envío y la respuesta: lead para la escuela, sin esperado, a una persona', async () => {
        const { ctx, reg } = ctxDe({ item: { ...CLINICA, active: false } });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta())).toBe('servicio_inactivo');
        expect(reg.consentimientos).toHaveLength(2);
        expect(reg.leads).toHaveLength(1);
        expect(reg.esperados).toEqual([]);
        expect(reg.enviados[0].texto).toMatch(/\*Clínica de armadores y atacantes\* ya no está abierta[\s\S]*alguien te responde/);
        expect(reg.avisos[0]).toMatch(/ya no está activo/);
    });

    it('el servicio ya no existe: igual a una persona', async () => {
        const { ctx, reg } = ctxDe({ item: null });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta())).toBe('servicio_inactivo');
        expect(reg.enviados[0].texto).toMatch(/ese servicio ya no está abierta/);
    });

    it('el precio cambió (vio $280.000): se cobra el vigente y se le dice', async () => {
        const { ctx, reg } = ctxDe();
        const conOtro = tokenDe({ precios: { lista: 280000, afiliado: 250000, abonoPct: 50 } });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({}, conOtro))).toBe('procesada_precio_nuevo');
        expect(reg.esperados[0].monto).toBe(300000);
        expect(reg.enviados[0].texto).toContain('El valor cambió desde que te envié el formulario: antes era $280.000 y hoy es *$300.000*.');
        expect(reg.cierres[0]).toMatchObject({ resultado: 'procesada_precio_nuevo', detalle: { monto_mostrado: 280000, monto: 300000 } });
    });

    it('respuesta duplicada (mismo wa_message_id): nada más', async () => {
        const { ctx, reg } = ctxDe({ duplicada: true });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta())).toBe('duplicada');
        expect([reg.enviados, reg.leads, reg.esperados, reg.consentimientos, reg.avisos]).toEqual([[], [], [], [], []]);
    });

    it('sin cuentas de pago: «la escuela te escribe» y aviso', async () => {
        const { ctx, reg } = ctxDe({ cuentas: [] });
        expect(await atenderRespuestaDeFormulario(ctx, respuesta())).toBe('procesada');
        expect(reg.enviados[0].texto).toMatch(/La escuela te escribe por aquí con los datos de pago/);
        expect(reg.enviados[0].contexto).toMatchObject({ sin_cuentas: true });
        expect(reg.avisos[0]).toMatch(/no tiene cuentas de pago/);
    });

    it('sin nombre del deportista: no se inventa, a una persona', async () => {
        const { ctx, reg } = ctxDe();
        expect(await atenderRespuestaDeFormulario(ctx, respuesta({ nombre_deportista: '  ' }))).toBe('error');
        expect(reg.leads).toEqual([]);
        expect(reg.avisos).toHaveLength(1);
    });

    it('textos: confirmación sin renglones repetidos ni basura; respaldo con y sin cuentas', () => {
        const t = textoConfirmacion({
            deportista: 'Ana', servicio: 'Clínica', talla: null, afiliadoSinVerificar: false, cuentas: [],
            cobro: { precio: 300000, abono: 150000, monto: 150000, pct: 50, deAfiliado: false, montoMostrado: 150000 },
        });
        const renglones = t.split('\n').filter((r) => r.trim().length > 12);
        expect(new Set(renglones).size).toBe(renglones.length);
        expect(t).not.toMatch(/undefined|null|NaN/);
        expect(textoRespaldoFormulario(true)).toMatch(/transfiere con los datos que te envié/);
        expect(textoRespaldoFormulario(false)).toMatch(/La escuela te escribe/);
    });
});

// ─── Cuándo se manda (destino por anuncio) ───────────────────────────────────

describe('el destino por anuncio ofrece el formulario DESPUÉS de la ficha', () => {
    const hace = (seg: number) => new Date(Date.now() - seg * 1000).toISOString();
    const entrante = (texto: string, payload: any = {}): FilaReciente => ({ direction: 'inbound', text_body: texto, payload, created_at: hace(2), wa_timestamp: hace(2) });
    const ANUNCIO = { source_id: '120210000000001', source_type: 'ad', headline: 'Clínica de armadores y atacantes', body: '¡Separa tu cupo!' };

    function ctxAnuncio(items: ItemConFicha[], ofrecer?: (p: any) => Promise<boolean>) {
        const orden: string[] = [];
        const ctx: CtxAnuncio = {
            schoolId: ESCUELA,
            recientes: async () => [entrante('Hola, quiero información', { referral: ANUNCIO })],
            mapeo: async () => null, servicios: async () => items, afiliado: async () => false,
            cuentas: async () => [{ tipo: 'Nequi', numero: '3194505150' }], saludo: async () => '', yaContestado: async () => false,
            guardarLead: async () => 'lead-1', registrarEsperado: async () => true,
            enviar: async (_t, c) => { orden.push(`enviar:${String(c.destino_anuncio)}`); },
            avisarEscuela: async () => undefined, iniciarEmbudo: async () => true,
            ...(ofrecer ? { ofrecerFormulario: async (p) => { orden.push(`formulario:${p.item.id}`); return ofrecer(p); } } : {}),
            ahora: () => AHORA,
        };
        return { ctx, orden };
    }

    it('con formulario: la ficha y luego el formulario (con la info de cuentas)', async () => {
        let recibido: any = null;
        const { ctx, orden } = ctxAnuncio([CLINICA], async (p) => { recibido = p; return true; });
        expect(await atenderDestinoDeAnuncio(ctx, 'Hola, quiero información', 'anuncio')).toBe('anuncio_servicio');
        expect(orden).toEqual(['enviar:servicio', `formulario:${CLINICA.id}`]);
        expect(recibido).toMatchObject({ sinCuentas: false, leadId: 'lead-1' });
    });

    it('con opciones por semana no se ofrece; sin el gancho, el chat de hoy', async () => {
        const vac = { ...VACACIONAL, name: 'Clínica vacacional' };
        const a = ctxAnuncio([vac], async () => true);
        await atenderDestinoDeAnuncio(a.ctx, 'Hola, quiero información', 'anuncio');
        expect(a.orden).toEqual(['enviar:servicio']);
        const b = ctxAnuncio([CLINICA]);
        await atenderDestinoDeAnuncio(b.ctx, 'Hola, quiero información', 'anuncio');
        expect(b.orden).toEqual(['enviar:servicio']);
    });
});
