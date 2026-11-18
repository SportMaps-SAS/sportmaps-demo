/**
 * usageTracker — uso por pantalla y botón, agregado en el navegador.
 *
 * No manda un evento por clic: acumula contadores y los envía juntos (~cada 90 s
 * mientras hay actividad y al ocultar la pestaña) a POST /api/v1/usage. El BFF los
 * suma en `ui_usage_daily` (una fila por usuario y día). Ver la migración
 * 20261117115141 para el formato de las claves.
 *
 * Reglas de privacidad (no negociables):
 *  - Las rutas se normalizan: ids, uuids y tokens pasan a `:id`. Nunca va un query string.
 *  - Los botones solo se cuentan si traen `data-track` o si su texto empieza por un
 *    verbo de acción de una lista cerrada (ver ACCION_RE), sin dígitos ni '@'. Así un
 *    botón con el nombre de un deportista no entra.
 *  - Nunca se lee el contenido de formularios ni de las respuestas.
 *
 * Este módulo NO importa bffClient (bffClient lo importa a él para contar las
 * llamadas): quien lo monta le pasa el envío con `setUsageSender`.
 */

type Sender = (payload: { display_mode: string; app_version?: string; counters: Record<string, number> }) => Promise<unknown>;

const FLUSH_MS = 90_000;
const MAX_KEYS = 180; // el BFF acepta hasta 200 por envío

let counters: Record<string, number> = {};
let sender: Sender | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let currentRoute = '/';
let getMode: () => string = () => 'browser';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/teams/3f2a…/edit?x=1` → `/teams/:id/edit`. Segmentos con dígitos o muy largos → `:id`. */
export function normalizarRuta(path: string): string {
    const limpia = (path || '/').split('?')[0].split('#')[0];
    const segs = limpia.split('/').map((s) => {
        if (!s) return s;
        if (UUID.test(s) || /^\d+$/.test(s)) return ':id';
        if (/\d/.test(s) && s.length > 10) return ':id';
        if (s.length > 40) return ':id';
        return s.toLowerCase();
    });
    const r = segs.join('/') || '/';
    return r.length > 1 ? r.replace(/\/$/, '') : r;
}

function sumar(key: string, n = 1) {
    if (!(key in counters) && Object.keys(counters).length >= MAX_KEYS) return;
    counters[key] = (counters[key] ?? 0) + n;
}

export function trackScreen(path: string) {
    currentRoute = normalizarRuta(path);
    sumar(`v:${currentRoute}`);
}

/** Llamada al BFF: `a:POST /api/v1/attendance 201`. 0 = sin red. */
export function trackApi(method: string, path: string, status: number) {
    const ruta = normalizarRuta(path);
    if (ruta.startsWith('/api/v1/usage') || ruta.startsWith('/api/v1/devices')) return;
    sumar(`a:${method.toUpperCase()} ${ruta} ${status}`);
}

// Verbos de acción. Cerrada a propósito: un nombre propio casi nunca empieza por uno
// de estos seguido de límite de palabra, y así no se cuelan textos con datos personales.
const ACCION_RE =
    /^(guardar|crear|nuevo|nueva|agregar|añadir|anadir|editar|eliminar|borrar|cancelar|confirmar|enviar|aprobar|rechazar|inscribir|registrar|pagar|cobrar|descargar|exportar|importar|ver|abrir|cerrar|marcar|filtrar|buscar|siguiente|anterior|continuar|publicar|compartir|invitar|generar|activar|desactivar|pausar|reanudar|reintentar|subir|adjuntar|aceptar|omitir|finalizar|iniciar|actualizar|copiar|imprimir|vincular|desvincular|mover|asignar|conciliar|reasignar|restaurar|duplicar|aplicar|limpiar|ingresar|salir|volver)\b/i;

function etiquetaDe(el: Element): string | null {
    const tag = el.getAttribute('data-track');
    if (tag) return tag.slice(0, 80);
    if (!el.matches('button, [role="button"]')) return null;
    const texto = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (texto.length < 2 || texto.length > 30) return null;
    if (/[\d@]/.test(texto)) return null;
    if (!ACCION_RE.test(texto)) return null;
    return texto.toLowerCase();
}

function onClick(e: MouseEvent) {
    try {
        const el = (e.target as Element | null)?.closest?.('[data-track], button, [role="button"]');
        if (!el) return;
        const etiqueta = etiquetaDe(el);
        if (etiqueta) sumar(`c:${currentRoute}|${etiqueta}`);
    } catch {
        /* telemetría: jamás debe romper un clic */
    }
}

async function flush() {
    if (!sender) return;
    const keys = Object.keys(counters);
    if (keys.length === 0) return;
    const lote = counters;
    counters = {};
    try {
        await sender({
            display_mode: getMode(),
            app_version: (import.meta as any).env?.VITE_APP_VERSION || 'web-dev',
            counters: lote,
        });
    } catch {
        // Sin sesión o sin red: se devuelve el lote para el próximo intento (con tope).
        for (const k of Object.keys(lote)) {
            if (k in counters || Object.keys(counters).length < MAX_KEYS) counters[k] = (counters[k] ?? 0) + lote[k];
        }
    }
}

function onVisibility() {
    if (document.visibilityState === 'hidden') void flush();
}

/** Arranca el rastreo. Idempotente. `mode` lee el modo de visualización en cada envío. */
export function startUsageTracking(send: Sender, mode: () => string) {
    sender = send;
    getMode = mode;
    if (started) return;
    started = true;
    sumar('sess');
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);
    timer = setInterval(() => void flush(), FLUSH_MS);
}

/** Corta el rastreo (logout): descarta lo pendiente para no atribuirlo a otro usuario. */
export function stopUsageTracking() {
    if (!started) return;
    started = false;
    sender = null;
    counters = {};
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('visibilitychange', onVisibility);
    if (timer) clearInterval(timer);
    timer = null;
}
