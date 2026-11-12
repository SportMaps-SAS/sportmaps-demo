// frontend/src/hooks/usePdfBranding.ts
//
// Hook que prepara el branding listo para inyectar en recibos PDF, carnets,
// reportes. El gate es "¿la escuela tiene ALGÚN addon de marca propia?":
// pwa_branding (se le muestra su marca) O whitelabel (además app nativa) —
// cualquiera de los dos habilita el logo/colores propios en el PDF, igual
// que ya pasa en el resto de la app (ver [[project_marca_pwa_vs_app_nativa]]).
// Sin ninguno de los dos -> SportMaps default (verde/naranja, sin logo escuela).
//
// Se usa desde callsites de downloadReceipt() y otras generaciones PDF.
// Single source of truth para "qué branding inyectar en un PDF" — evita
// que cada callsite repita la lógica de gate.

import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';

const DEFAULT_BRANDING = {
    primary_color: '#248223',
    secondary_color: '#FB9F1E',
    show_sportmaps_watermark: true,
};

export interface PdfBranding {
    logoUrl: string | null;
    brandingSettings: {
        primary_color: string;
        secondary_color: string;
        show_sportmaps_watermark: boolean;
    };
    /** Nombre de escuela para usar en el PDF (sanitizado por el consumer si va a HTML). */
    schoolName: string | null;
    /** true si algún addon de marca propia (pwa_branding o whitelabel) está activo. */
    hasWhitelabel: boolean;
    /**
     * Fondo con el que el generador de íconos eligió mostrar el logo (`pwa_icon_bg`, mirando el logo:
     * negro para un escudo sobre negro). Sirve de fondo del encabezado de un PDF. null si no hay.
     */
    iconBg?: string | null;
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function usePdfBranding(): PdfBranding {
    const { schoolBranding, schoolName } = useSchoolContext();
    const entitlements = useEntitlements();

    const hasOwnBranding = entitlements.addons.pwa_branding || entitlements.addons.whitelabel;

    if (!hasOwnBranding) {
        return {
            logoUrl: null,
            brandingSettings: DEFAULT_BRANDING,
            schoolName: schoolName ?? null,
            hasWhitelabel: false,
        };
    }

    const dbSettings = schoolBranding?.branding_settings;
    const safeHex = (val: string | undefined, fallback: string) =>
        val && HEX_RE.test(val) ? val : fallback;

    return {
        logoUrl: schoolBranding?.logo_url ?? null,
        brandingSettings: {
            primary_color: safeHex(dbSettings?.primary_color, DEFAULT_BRANDING.primary_color),
            secondary_color: safeHex(dbSettings?.secondary_color, DEFAULT_BRANDING.secondary_color),
            show_sportmaps_watermark: dbSettings?.show_sportmaps_watermark ?? true,
        },
        schoolName: schoolName ?? null,
        hasWhitelabel: true,
        iconBg: safeHex((dbSettings as { pwa_icon_bg?: string } | undefined)?.pwa_icon_bg, '') || null,
    };
}
