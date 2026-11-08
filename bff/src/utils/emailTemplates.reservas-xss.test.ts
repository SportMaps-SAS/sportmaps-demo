/**
 * Regresión: todo texto de reservas que entra a un correo sale ESCAPADO.
 * (nombre, cancha, motivo, fecha/hora, escuela). Usa el layout real, solo se simula el branding.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } }));
vi.mock('./schoolBrandingResolver', async (orig) => {
    const real: any = await orig();
    return {
        ...real,
        // El resolver real ya escapa el nombre de la escuela; se simula igual para probar la plantilla con un nombre hostil.
        resolveSchoolBranding: vi.fn(async () => ({
            schoolName: real.escapeHtml('<script>escuela()</script>'), logoUrl: null, primaryColor: '#248223', secondaryColor: '#1a1a1a', showWatermark: false,
        })),
    };
});

import { BrandedEmailTemplates } from './emailTemplates';

const PAYLOADS = ['<script>x</script>', '"><img src=x onerror=alert(1)>', `'><svg/onload=alert(1)>`, '</td><td onclick=alert(1)>'];
const noRaw = (html: string) => {
    expect(html).not.toMatch(/<script>x<\/script>/i);
    expect(html).not.toMatch(/<img src=x/i);
    expect(html).not.toMatch(/<svg\/onload/i);
    expect(html).not.toMatch(/<td onclick/i);
    expect(html).not.toContain('<script>escuela()');
};

describe('plantillas de reservas escapan texto del usuario', () => {
    for (const p of PAYLOADS) {
        it(`cancelación: ${p}`, async () => {
            const { html } = await BrandedEmailTemplates.reservationCancelled({ recipientName: p, facilityName: p, dateLabel: p, timeLabel: p, cancelReason: p, schoolId: 's' });
            noRaw(html);
            expect(html).toContain('&lt;');
        });
        it(`reprogramación: ${p}`, async () => {
            const { html } = await BrandedEmailTemplates.reservationRescheduled({ recipientName: p, facilityName: p, dateLabel: p, timeLabel: p, schoolId: 's' });
            noRaw(html);
        });
        it(`confirmación pública: ${p}`, async () => {
            const { html } = await BrandedEmailTemplates.publicBookingConfirmation({ recipientName: p, facilityName: p, dateLabel: p, timeLabel: p, schoolId: 's' });
            noRaw(html);
        });
        it(`clase agendada sin cuenta (titular y copia): ${p}`, async () => {
            const own = await BrandedEmailTemplates.enrollmentClassBooked({ recipientName: p, dateLabel: p, timeLabel: p, schoolId: 's' });
            const copy = await BrandedEmailTemplates.enrollmentClassBooked({ recipientName: p, forName: p, dateLabel: p, timeLabel: p, schoolId: 's' });
            noRaw(own.html);
            noRaw(copy.html);
            expect(copy.html).toContain('&lt;');
        });
    }
    it('un nombre normal con tilde y ampersand se ve bien (escapado una vez al menos)', async () => {
        const { html } = await BrandedEmailTemplates.reservationCancelled({ recipientName: 'Ñandú & Cía', facilityName: 'Cancha 1', dateLabel: '6 de noviembre', timeLabel: '18:00', cancelReason: 'Lluvia', schoolId: 's' });
        expect(html).toContain('Ñandú');
        expect(html).not.toContain('Ñandú & Cía');
    });
});
