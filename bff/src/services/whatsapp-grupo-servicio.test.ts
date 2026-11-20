import { describe, it, expect, afterEach } from 'vitest';
import { grupoDelServicio, textoGrupo } from './whatsapp-grupo-servicio';
import { textoVentaRecibida } from '../jobs/whatsapp-queue.job';

const LINK = 'https://chat.whatsapp.com/L5ZPm0PyCQJ07PjXshcdPD';
const ENV = JSON.stringify({ 'Clínica de armadores y atacantes': LINK });
const CLINICA = 'Clínica de armadores y atacantes';

describe('link del grupo del servicio', () => {
    afterEach(() => { delete process.env.WA_GRUPO_SERVICIO_JSON; });

    it('apagado sin variable, o con una variable mal formada', () => {
        expect(grupoDelServicio(CLINICA, undefined)).toBeNull();
        expect(grupoDelServicio(CLINICA, 'no es json')).toBeNull();
    });

    it('compara el nombre sin tildes ni mayúsculas y solo acepta enlaces de grupos de WhatsApp', () => {
        expect(grupoDelServicio('CLINICA DE ARMADORES Y ATACANTES', ENV)).toBe(LINK);
        expect(grupoDelServicio('Vacacional de voleibol', ENV)).toBeNull();
        expect(grupoDelServicio(CLINICA, JSON.stringify({ [CLINICA]: 'https://malo.example/x' }))).toBeNull();
    });

    it('al aprobar un pago o abono la escuela, el texto lleva el grupo', () => {
        process.env.WA_GRUPO_SERVICIO_JSON = ENV;
        const t = textoVentaRecibida({ monto: 175000, servicio: CLINICA, nombre: null, aprobado: true });
        expect(t).toContain('Tu cupo está confirmado.');
        expect(t).toContain(textoGrupo(LINK));
    });

    it('el saldo de un abono ya aprobado no repite el link', () => {
        process.env.WA_GRUPO_SERVICIO_JSON = ENV;
        const t = textoVentaRecibida({ monto: 175000, servicio: CLINICA, nombre: null, aprobado: true, saldo: { total: 350000 } });
        expect(t).not.toContain('chat.whatsapp.com');
    });

    it('antes de que la escuela apruebe no sale el link, y sin variable el texto no cambia', () => {
        process.env.WA_GRUPO_SERVICIO_JSON = ENV;
        expect(textoVentaRecibida({ monto: 175000, servicio: CLINICA, nombre: null })).not.toContain('chat.whatsapp.com');
        delete process.env.WA_GRUPO_SERVICIO_JSON;
        expect(textoVentaRecibida({ monto: 175000, servicio: CLINICA, nombre: null, aprobado: true })).not.toContain('chat.whatsapp.com');
    });
});
