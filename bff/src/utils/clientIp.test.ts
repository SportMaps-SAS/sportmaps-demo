import { describe, expect, it } from 'vitest';
import { clientIp, publicBookingRateKey } from './clientIp';

type Req = Parameters<typeof clientIp>[0];
const mk = (headers: Record<string, any>, ip?: string, remote?: string) =>
    ({ headers, ip, socket: remote ? { remoteAddress: remote } : undefined }) as unknown as Req;

describe('clientIp', () => {
    it('prefiere cf-connecting-ip sobre true-client-ip y req.ip', () => {
        expect(clientIp(mk({ 'cf-connecting-ip': '1.1.1.1', 'true-client-ip': '2.2.2.2' }, '3.3.3.3'))).toBe('1.1.1.1');
    });
    it('usa true-client-ip si no hay cf-connecting-ip', () => {
        expect(clientIp(mk({ 'true-client-ip': '2.2.2.2' }, '3.3.3.3'))).toBe('2.2.2.2');
    });
    it('cabecera como array toma el primero', () => {
        expect(clientIp(mk({ 'cf-connecting-ip': ['4.4.4.4', '5.5.5.5'] }, '3.3.3.3'))).toBe('4.4.4.4');
    });
    it('aplica trim', () => {
        expect(clientIp(mk({ 'cf-connecting-ip': '  1.1.1.1 ' }))).toBe('1.1.1.1');
        expect(clientIp(mk({}, ' 3.3.3.3 '))).toBe('3.3.3.3');
    });
    it('cabecera vacía o en blanco cae a la siguiente', () => {
        expect(clientIp(mk({ 'cf-connecting-ip': '  ', 'true-client-ip': '2.2.2.2' }))).toBe('2.2.2.2');
    });
    it('sin cabeceras cae a req.ip y luego al socket', () => {
        expect(clientIp(mk({}, '3.3.3.3', '6.6.6.6'))).toBe('3.3.3.3');
        expect(clientIp(mk({}, undefined, '6.6.6.6'))).toBe('6.6.6.6');
    });
    it('sin nada devuelve cadena vacía', () => {
        expect(clientIp(mk({}))).toBe('');
    });
    it('publicBookingRateKey usa la IP real: misma req.ip, distinto cf -> llaves distintas', () => {
        const a = publicBookingRateKey(mk({ 'cf-connecting-ip': '1.1.1.1' }, '9.9.9.9'));
        const b = publicBookingRateKey(mk({ 'cf-connecting-ip': '2.2.2.2' }, '9.9.9.9'));
        const c = publicBookingRateKey(mk({ 'cf-connecting-ip': '1.1.1.1' }, '8.8.8.8'));
        expect(a).toBe('public-booking-1.1.1.1');
        expect(a).not.toBe(b);
        expect(a).toBe(c);
    });
});

describe('publicBookingRateKey: IPv6 y cabeceras vacías', () => {
    it('IPv6 en cf-connecting-ip: dos direcciones del mismo /56 comparten llave (agrupa express-rate-limit), otro /56 no', () => {
        const a = publicBookingRateKey(mk({ 'cf-connecting-ip': '2001:db8:1:2::1' }, '9.9.9.9'));
        const b = publicBookingRateKey(mk({ 'cf-connecting-ip': '2001:db8:1:2:ffff::9' }, '9.9.9.9'));
        const c = publicBookingRateKey(mk({ 'cf-connecting-ip': '2001:db8:2:3::1' }, '9.9.9.9'));
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).not.toContain('9.9.9.9');
    });
    it('cabecera en blanco cae a req.ip', () => {
        expect(publicBookingRateKey(mk({ 'cf-connecting-ip': '   ' }, '9.9.9.9'))).toBe('public-booking-9.9.9.9');
    });
});
