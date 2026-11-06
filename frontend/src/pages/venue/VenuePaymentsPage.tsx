import { SportMapsPaySettings } from '@/components/settings/SportMapsPaySettings';

/**
 * Forma de cobro del dueño de espacios. Reutiliza tal cual la configuración de
 * recaudo de la escuela (SportMapsPaySettings): la escuela-venue comparte
 * pagos con el resto del modelo (Camino A). Las reservas se cobran siempre con
 * la cuenta del dueño; SportMaps no recibe el dinero.
 */
export default function VenuePaymentsPage() {
  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Cobros</h1>
        <p className="text-muted-foreground">
          Define cómo te pagan las reservas de tus canchas.
        </p>
      </div>
      <SportMapsPaySettings />
    </div>
  );
}
