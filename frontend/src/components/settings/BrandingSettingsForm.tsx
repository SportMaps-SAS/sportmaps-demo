import { useState, useEffect } from 'react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, Shield } from 'lucide-react';
import { useBranding } from '@/contexts/ThemeContext';
import { bffClient } from '@/lib/api/bffClient';
import { IdentidadClubEditor } from '@/components/cards/IdentidadClubEditor';
import { AthleteCard3D, datosDeEjemplo } from '@/components/cards/AthleteCard3D';
import { mensajeDeErrorIdentidad } from '@/lib/cards/identidadEditor';

const CSRF_HEADERS = { 'X-Requested-With': 'SportMaps' };

/**
 * Configuración → marca de la escuela.
 *
 * La parte de colores y escudo es el editor «Identidad del club» (carnet 3D,
 * F2 — docs/specs/carnet-3d-club.md §6), el mismo que usa IdentidadClubDialog.
 * Sin complemento el editor deja probar en la vista previa y muestra el
 * llamado a activarlo (D3); aquí queda solo la marca de agua.
 */
export function BrandingSettingsForm() {
    const { schoolId, refreshSchoolBranding } = useSchoolContext();
    const entitlements = useEntitlements();
    const { toast } = useToast();
    const currentBranding = useBranding();

    const [showWatermark, setShowWatermark] = useState(currentBranding.show_sportmaps_watermark);
    const [saving, setSaving] = useState(false);

    // Gate por ADDON, no por tier. `pwa_branding` (PWA con marca de la escuela)
    // se vende suelto; `whitelabel` (app nativa de marca blanca) lo incluye y la
    // vista v_school_entitlements ya resuelve esa equivalencia.
    //
    // OJO: no cambiar esto por un chequeo de tier. El gate de la DB
    // (school_has_branding_feature, que usa el RPC update_school_branding) SI
    // mira el tier, asi que una escuela puede pasar uno y no el otro. El addon
    // es el que refleja lo vendido y hace de allowlist del rollout.
    const hasWhitelabel = entitlements.marcaPropia;

    // El "Powered by SportMaps" solo lo apaga quien contrato la app NATIVA de
    // marca blanca. Con `pwa_branding` a secas la atribucion es fija: es lo que
    // hace que subir a app propia tenga sentido. Espejo de school_has_native_app().
    const puedeApagarWatermark = entitlements.appNativa;

    useEffect(() => {
        if (!schoolId) return;
        setShowWatermark(currentBranding.show_sportmaps_watermark);
    }, [schoolId, currentBranding.show_sportmaps_watermark]);

    const handleSaveWatermark = async () => {
        if (!schoolId) return;
        setSaving(true);
        try {
            await bffClient.put(
                `/api/v1/schools/${schoolId}/branding`,
                { show_watermark: showWatermark },
                CSRF_HEADERS,
            );
            await refreshSchoolBranding();
            toast({ title: 'Guardado', description: 'La marca de agua quedó actualizada.' });
        } catch (error) {
            console.error('Error saving watermark:', error);
            toast({ title: 'No se guardó', description: mensajeDeErrorIdentidad(error), variant: 'destructive' });
        } finally {
            setSaving(false);
        }
    };

    if (!schoolId) return null;

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Shield className="h-5 w-5 text-primary" />
                        Identidad del club
                    </CardTitle>
                    <CardDescription>
                        Colores y escudo de tu club. Salen en el carnet, la app, las invitaciones y los documentos.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <IdentidadClubEditor
                        schoolId={schoolId}
                        renderVistaPrevia={(identidad) => <AthleteCard3D datos={datosDeEjemplo(identidad)} modo="interactivo" ancho={220} />}
                    />
                </CardContent>
            </Card>

            {hasWhitelabel && (
                <Card>
                    <CardContent className="pt-6 space-y-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="space-y-0.5">
                                <Label>Marca de agua de SportMaps</Label>
                                <p className="text-sm text-muted-foreground">
                                    {puedeApagarWatermark
                                        ? 'Mostrar "Powered by SportMaps" junto a tu escudo.'
                                        : 'Se incluye "Powered by SportMaps". Se puede quitar con la app propia de marca blanca.'}
                                </p>
                            </div>
                            {/* Deshabilitado sin el addon `whitelabel`: el RPC
                                update_school_branding rechaza el apagado y fuerza
                                true. Dejar el switch activo invitaria a apagarlo
                                para que la pantalla lo revierta sola al recargar. */}
                            <Switch
                                checked={puedeApagarWatermark ? showWatermark : true}
                                onCheckedChange={setShowWatermark}
                                disabled={!puedeApagarWatermark}
                            />
                        </div>
                        {puedeApagarWatermark && (
                            <div className="flex justify-end">
                                <Button
                                    size="sm"
                                    onClick={handleSaveWatermark}
                                    disabled={saving || showWatermark === currentBranding.show_sportmaps_watermark}
                                    className="gap-2"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                    Guardar
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
