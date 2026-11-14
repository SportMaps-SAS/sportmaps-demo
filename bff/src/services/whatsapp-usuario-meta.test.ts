/**
 * Contactos de WhatsApp con nombre de usuario (sin teléfono).
 *
 * Caso real (Monster, 2026-11-09/10): @dr_xanl preguntó el precio de la clínica
 * desde un anuncio, @carovega12 mandó el comprobante de una clase de prueba, y
 * más de 30 chats así quedaron sin respuesta: el webhook llega sin `from` (trae
 * `from_user_id`) y el mensaje se descartaba antes de crear la conversación.
 *
 * Los payloads son los de la documentación de Meta (business-scoped user ids).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({}), rpc: async () => ({ data: null, error: null }) } }));

import {
    aliasDeBsuid, bsuidDeAlias, claveDeContacto, conDestinatarioDeMeta, esAliasDeUsuario, nombreConUsuario,
} from './whatsapp-usuario-meta';
import { encryptToken, parseInboundMessages, parseStatuses, sendTextMessage, sendInteractiveButtons } from './whatsapp.service';
import { telefonoDeLeadWa, variantesTelefonoLead } from './whatsapp-prospecto-lead.service';
import { claveTelefono } from './whatsapp-seguimiento-conversaciones.service';

const BSUID = 'CO.1349120865530274';

/** Webhook de alguien con nombre de usuario cuyo teléfono no nos consta: sin `from` ni `wa_id`. */
const webhookSinTelefono = (extra: Record<string, unknown> = {}) => ({
    entry: [{
        changes: [{
            field: 'messages',
            value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '573194505150', phone_number_id: 'PNID' },
                contacts: [{ profile: { name: 'Carolina Vega', username: 'carovega12' }, user_id: BSUID }],
                messages: [{
                    from_user_id: BSUID, id: 'wamid.SIN_TEL', timestamp: '1794250440',
                    type: 'text', text: { body: 'Hola, quiero información de la clínica' }, ...extra,
                }],
            },
        }],
    }],
});

describe('alias del BSUID', () => {
    it('ida y vuelta, y sin un solo dígito', () => {
        const alias = aliasDeBsuid(BSUID)!;
        expect(esAliasDeUsuario(alias)).toBe(true);
        expect(alias).not.toMatch(/\d/);
        expect(bsuidDeAlias(alias)).toBe(BSUID);
    });

    it('sirve para el formato de EE. UU. y para el BSUID padre', () => {
        for (const id of ['US.13491208655302741918', 'CO.ENT.11815799212886844830', 'BR.a1B2c3']) {
            expect(bsuidDeAlias(aliasDeBsuid(id))).toBe(id);
        }
    });

    it('no confunde un teléfono ni basura con un BSUID', () => {
        expect(aliasDeBsuid('573001112233')).toBeNull();
        expect(aliasDeBsuid('')).toBeNull();
        expect(aliasDeBsuid(null)).toBeNull();
        expect(aliasDeBsuid('CO.12-34')).toBeNull();
        expect(esAliasDeUsuario('573001112233')).toBe(false);
        expect(bsuidDeAlias('573001112233')).toBeNull();
    });

    it('ningún normalizador de teléfonos lo ve como celular', () => {
        const alias = aliasDeBsuid(BSUID)!;
        expect(alias.replace(/\D/g, '')).toBe('');
        expect(claveDeContacto(alias)).toBe(alias);
        expect(claveDeContacto('+57 300 111 2233')).toBe('573001112233');
        expect(claveTelefono(alias)).toBe(alias);
        expect(claveTelefono('573001112233')).toBe('3001112233');
    });

    it('el nombre de la conversación lleva el @usuario', () => {
        expect(nombreConUsuario('Carolina Vega', 'carovega12')).toBe('Carolina Vega (@carovega12)');
        expect(nombreConUsuario(null, '@carovega12')).toBe('@carovega12');
        expect(nombreConUsuario('Carolina Vega', null)).toBe('Carolina Vega');
        expect(nombreConUsuario(null, null)).toBeNull();
    });
});

describe('entrante sin `from`', () => {
    it('entra con el alias, el nombre y el usuario (antes se descartaba)', () => {
        const [m] = parseInboundMessages(webhookSinTelefono());
        expect(m.contactWaId).toBe(aliasDeBsuid(BSUID));
        expect(m.contactName).toBe('Carolina Vega');
        expect(m.contactUsername).toBe('carovega12');
        expect(m.waMessageId).toBe('wamid.SIN_TEL');
        expect(m.textBody).toBe('Hola, quiero información de la clínica');
        expect(m.phoneNumberId).toBe('PNID');
    });

    it('el de anuncio conserva el `referral` para la atribución', () => {
        const [m] = parseInboundMessages(webhookSinTelefono({ referral: { source_id: 'AD1', source_type: 'ad', headline: 'Clínica' } }));
        expect(m.raw.referral.source_id).toBe('AD1');
        expect(m.contactWaId).toBe(aliasDeBsuid(BSUID));
    });

    it('con teléfono visible sigue llaveado por el teléfono, aunque traiga usuario', () => {
        const body = webhookSinTelefono({ from: '573001112233' });
        (body.entry[0].changes[0].value.contacts[0] as any).wa_id = '573001112233';
        const [m] = parseInboundMessages(body);
        expect(m.contactWaId).toBe('573001112233');
        expect(m.contactName).toBe('Carolina Vega');
        expect(m.contactUsername).toBe('carovega12');
    });

    it('sin `from` y sin `from_user_id` sigue sin contacto (se registra como descartado)', () => {
        const body = webhookSinTelefono();
        delete (body.entry[0].changes[0].value.messages[0] as any).from_user_id;
        expect(parseInboundMessages(body)[0].contactWaId).toBe('');
    });

    it('el estado de un mensaje enviado a un BSUID trae el alias', () => {
        const [st] = parseStatuses({
            entry: [{ changes: [{ field: 'messages', value: {
                metadata: { phone_number_id: 'PNID' },
                statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1794250500', recipient_user_id: BSUID }],
            } }] }],
        });
        expect(st.recipientWaId).toBe(aliasDeBsuid(BSUID));
    });
});

describe('prospecto de un contacto sin teléfono', () => {
    it('guarda el alias en `phone` (NOT NULL) y lo vuelve a encontrar por él', () => {
        const alias = aliasDeBsuid(BSUID)!;
        expect(telefonoDeLeadWa(alias)).toBe(alias);
        expect(variantesTelefonoLead(alias)).toEqual([alias]);
    });

    it('los teléfonos siguen igual', () => {
        expect(telefonoDeLeadWa('573001112233')).toBe('3001112233');
        expect(variantesTelefonoLead('573001112233')).toContain('+573001112233');
        expect(telefonoDeLeadWa('13105550100')).toBe('+13105550100');
    });
});

describe('envío a un contacto sin teléfono', () => {
    const integracion = () => ({
        id: 'i1', school_id: 's1', phone_number_id: 'PNID', waba_id: null, display_phone_number: null,
        access_token_encrypted: encryptToken('token-de-prueba'), verify_token: null, status: 'active',
    });
    let enviados: any[] = [];

    beforeEach(() => {
        process.env.WHATSAPP_TOKEN_ENC_KEY = process.env.WHATSAPP_TOKEN_ENC_KEY || 'clave-de-prueba';
        enviados = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
            enviados.push(JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) } as any;
        }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('el payload puro cambia `to` por `recipient`', () => {
        const alias = aliasDeBsuid(BSUID)!;
        expect(conDestinatarioDeMeta({ messaging_product: 'whatsapp', to: alias, type: 'text' }))
            .toEqual({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text' });
        const conTel = { messaging_product: 'whatsapp', to: '573001112233', type: 'text' };
        expect(conDestinatarioDeMeta(conTel)).toBe(conTel);
    });

    it('el texto sale con `recipient` y sin `to`', async () => {
        const r = await sendTextMessage(integracion(), aliasDeBsuid(BSUID)!, 'Hola 👋');
        expect(r).toEqual({ ok: true, waMessageId: 'wamid.OUT' });
        expect(enviados[0].recipient).toBe(BSUID);
        expect(enviados[0]).not.toHaveProperty('to');
        expect(enviados[0].text.body).toBe('Hola 👋');
    });

    it('los botones también', async () => {
        await sendInteractiveButtons(integracion(), aliasDeBsuid(BSUID)!, '¿Qué necesitas?', [{ id: 'a', title: 'Precio' }, { id: 'b', title: 'Fechas' }]);
        expect(enviados[0].recipient).toBe(BSUID);
        expect(enviados[0]).not.toHaveProperty('to');
        expect(enviados[0].type).toBe('interactive');
    });

    it('a un teléfono sale igual que siempre', async () => {
        await sendTextMessage(integracion(), '573001112233', 'Hola');
        expect(enviados[0].to).toBe('573001112233');
        expect(enviados[0]).not.toHaveProperty('recipient');
    });
});
