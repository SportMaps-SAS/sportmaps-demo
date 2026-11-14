/**
 * Marca de lo que se exporta de la pizarra, resuelta al exportar (sin React
 * Query: la pizarra no depende de él). Dos RPC por escuela, una sola vez por
 * sesión de la pizarra (quien llama guarda el resultado):
 *  - school_has_native_app(): solo con la app nativa de marca blanca se puede
 *    apagar «Hecho con SportMaps» (y solo si la escuela lo apagó), misma regla
 *    que useSportmapsWatermark;
 *  - school_has_branding_feature(): el TIER incluye la marca propia → logo del
 *    club (no confundir con school_shows_own_brand, que es por addon).
 */
import { supabase } from '@/integrations/supabase/client';
import { showsSportmapsWatermark } from '@/hooks/useSportmapsWatermark';
import { resolveExportBranding, type ExportBranding } from './tacticalWatermark';

export async function fetchExportBranding(opts: {
  schoolId: string | null;
  logoUrl: string | null | undefined;
  showWatermarkSetting: boolean | null | undefined;
}): Promise<ExportBranding> {
  if (!opts.schoolId) return { watermark: true, clubLogoUrl: null };
  const ask = async (fn: 'school_has_native_app' | 'school_has_branding_feature') => {
    try {
      const { data, error } = await supabase.rpc(fn, { p_school_id: opts.schoolId! });
      return !error && data === true;
    } catch {
      return false;
    }
  };
  const [nativeApp, brandingFeature] = await Promise.all([ask('school_has_native_app'), ask('school_has_branding_feature')]);
  return resolveExportBranding({
    showsSportmapsWatermark: showsSportmapsWatermark(nativeApp, opts.showWatermarkSetting),
    hasBrandingFeature: brandingFeature,
    logoUrl: opts.logoUrl,
  });
}
