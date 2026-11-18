/**
 * Carga el script del Widget de Wompi SOLO cuando alguien va a pagar.
 *
 * Antes iba como <script> síncrono en index.html: bloqueaba el render de TODAS
 * las páginas (~1,1 s en el login según Lighthouse, plan de arquitectura §11 R3.1)
 * aunque casi nadie abre el checkout. Ahora se inyecta bajo demanda; la carga
 * corre en paralelo con la llamada al BFF que firma el pago, así que al abrir la
 * pasarela normalmente ya está.
 *
 * Resuelve true si `window.WidgetCheckout` quedó disponible. Si falla o se pasa
 * del tiempo, resuelve false y la próxima llamada lo vuelve a intentar.
 */
const WIDGET_URL = 'https://checkout.wompi.co/widget.js';

let enCurso: Promise<boolean> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const widgetListo = () => typeof window !== 'undefined' && !!(window as any).WidgetCheckout;

export function cargarWidgetWompi(timeoutMs = 15000): Promise<boolean> {
    if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(false);
    if (widgetListo()) return Promise.resolve(true);
    if (enCurso) return enCurso;

    enCurso = new Promise<boolean>((resolve) => {
        const script = document.createElement('script');
        script.src = WIDGET_URL;
        script.async = true;
        let terminado = false;
        const fin = (ok: boolean) => {
            if (terminado) return;
            terminado = true;
            window.clearTimeout(reloj);
            const listo = ok && widgetListo();
            if (!listo) {
                // Permite reintentar en el próximo clic (red móvil intermitente).
                script.remove();
                enCurso = null;
            }
            resolve(listo);
        };
        const reloj = window.setTimeout(() => fin(false), timeoutMs);
        script.onload = () => fin(true);
        script.onerror = () => fin(false);
        document.head.appendChild(script);
    });
    return enCurso;
}
