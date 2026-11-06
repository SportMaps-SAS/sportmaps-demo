import { useState, useEffect } from 'react'
import { getDisplayMode, getLiveTenant, getPwaTenantName, getPwaTenantSlug, isIos, LIVE_TENANT_EVENT } from './tenant'

// Una sola llave para Android/escritorio e iOS: al cerrar con la X no debe
// volver a aparecer en ninguna pestaña ni al recargar, hasta que se instale.
const INSTALL_DISMISS_KEY = 'sm_install_dismissed'

function yaFueCerrado() {
  try { return localStorage.getItem(INSTALL_DISMISS_KEY) === '1' } catch { return false }
}

export function InstallBanner() {
  // Estado inicial = evento capturado por el script inline del index.html
  // (Chrome Android puede dispararlo antes de que monte este componente).
  const [prompt, setPrompt] = useState<any>(() => (yaFueCerrado() ? null : ((window as any).__installPrompt ?? null)))

  // iOS NUNCA dispara `beforeinstallprompt`: Safari no ofrece instalar, hay que
  // pasar por Compartir → Añadir a inicio. Sin esta rama, en iPhone no aparecia
  // absolutamente nada y no habia forma de saber que la app era instalable.
  const [mostrarIos, setMostrarIos] = useState(false)

  // Android: Chrome a veces NO lanza `beforeinstallprompt` (app ya instalada en
  // otra sesion, criterios de engagement, navegador interno de WhatsApp/Instagram).
  // Sin evento no habia aviso alguno. Respaldo: tras unos segundos, si no llego
  // el evento, se explica la instalacion manual (o que abra en Chrome).
  const [mostrarAndroid, setMostrarAndroid] = useState(false)

  // Escuela ya verificada de la sesion autenticada (usePwaTenantSync, corre
  // dentro del auth boundary). Se prefiere sobre resolveTenantSlug(), que es
  // el fallback conservador para visitantes anonimos (?t=, subdominio, o app
  // ya instalada) y por eso no se entera de un login normal a la app.
  const [liveTenant, setLiveTenantState] = useState(() => getLiveTenant())

  useEffect(() => {
    const onLiveTenant = () => setLiveTenantState(getLiveTenant())
    window.addEventListener(LIVE_TENANT_EVENT, onLiveTenant)
    return () => window.removeEventListener(LIVE_TENANT_EVENT, onLiveTenant)
  }, [])

  // Marca con la que se va a instalar. Es la MISMA que resolvio el script inline
  // del index.html para el manifest, asi que lo que anuncia el banner coincide
  // con el icono que va a quedar en la pantalla de inicio.
  const slug = liveTenant?.slug ?? getPwaTenantSlug()
  const nombreEscuela = liveTenant?.name ?? getPwaTenantName()
  const nombre = nombreEscuela || 'SportMaps'
  const icono = slug ? `/app-icon.png?s=${encodeURIComponent(slug)}` : '/icons/icon-72.png'

  useEffect(() => {
    // Reconciliar por si el evento llegó entre el render inicial y este efecto.
    const stashed = (window as any).__installPrompt
    if (stashed && !yaFueCerrado()) setPrompt(stashed)

    const onCanInstall = () => { if (!yaFueCerrado()) setPrompt((window as any).__installPrompt ?? null) }
    const onBeforePrompt = (e: any) => { e.preventDefault(); if (!yaFueCerrado()) setPrompt(e) }
    const onInstalled = () => setPrompt(null)
    // Otra pestaña cerró el banner: se sincroniza sin esperar a recargar.
    const onStorage = (e: StorageEvent) => {
      if (e.key === INSTALL_DISMISS_KEY && e.newValue === '1') {
        setPrompt(null)
        setMostrarIos(false)
        setMostrarAndroid(false)
      }
    }

    window.addEventListener('pwa:can-install', onCanInstall)
    window.addEventListener('beforeinstallprompt', onBeforePrompt)
    window.addEventListener('appinstalled', onInstalled)
    window.addEventListener('storage', onStorage)

    // iOS: se muestra automaticamente a todos (con o sin escuela) mientras este
    // en el navegador (no ya instalada) y no lo hayan cerrado. Sin escuela el
    // banner anuncia SportMaps. (Antes exigia `slug`; se quito 2026-11-06 porque
    // en iPhone nadie veia nunca el aviso de instalar.)
    if (isIos() && getDisplayMode() === 'browser' && !yaFueCerrado()) {
      setMostrarIos(true)
    }

    let timerAndroid: ReturnType<typeof setTimeout> | undefined
    try {
      if (/Android/i.test(navigator.userAgent) && getDisplayMode() === 'browser' && !yaFueCerrado()) {
        timerAndroid = setTimeout(() => {
          if (!(window as any).__installPrompt && !yaFueCerrado()) setMostrarAndroid(true)
        }, 4000)
      }
    } catch { /* sin UA: no se muestra respaldo */ }

    return () => {
      if (timerAndroid) clearTimeout(timerAndroid)
      window.removeEventListener('pwa:can-install', onCanInstall)
      window.removeEventListener('beforeinstallprompt', onBeforePrompt)
      window.removeEventListener('appinstalled', onInstalled)
      window.removeEventListener('storage', onStorage)
    }
  }, [slug])

  // Cerrar con la X vale para Android/escritorio e iOS por igual: no debe
  // reaparecer en ninguna pestaña ni al recargar, hasta que se instale.
  const cerrarDefinitivo = () => {
    setPrompt(null)
    setMostrarIos(false)
    setMostrarAndroid(false)
    try { localStorage.setItem(INSTALL_DISMISS_KEY, '1') } catch { /* modo privado: no persiste, pero cierra igual */ }
  }

  const Icono = () => (
    <img
      src={icono}
      className="w-10 h-10 rounded-lg shadow-sm object-contain shrink-0"
      alt={nombre}
      // Si el icono de la escuela no resuelve, cae al de SportMaps en vez de
      // dejar un hueco roto justo en el banner que invita a instalar.
      onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/icons/icon-72.png' }}
    />
  )

  const Cerrar = ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick} className="text-muted-foreground hover:text-foreground p-1 shrink-0" aria-label="Cerrar">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  )

  // Dentro de un iframe (vista /torneo/:slug/embed en la web de un club) nunca se ofrece instalar.
  if (typeof window !== 'undefined' && window.self !== window.top) return null

  // Android / escritorio: instalacion en un toque.
  if (prompt) {
    return (
      <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+1rem)] left-4 right-4 bg-card rounded-xl shadow-lg p-4 flex items-center gap-3 z-50 border border-border animate-in slide-in-from-bottom-5 duration-300">
        <Icono />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate text-foreground">Instalar {nombre}</p>
          <p className="text-xs text-muted-foreground truncate">Acceso rápido desde tu pantalla de inicio</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { prompt.prompt(); (window as any).__installPrompt = null; setPrompt(null) }}
            className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm px-3 py-1.5 rounded-lg font-medium transition-colors"
          >
            Instalar
          </button>
          <Cerrar onClick={cerrarDefinitivo} />
        </div>
      </div>
    )
  }

  // Android sin evento de instalacion: instrucciones manuales.
  if (mostrarAndroid && !prompt) {
    const enAppInterna = /FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)|MicroMessenger|TikTok/i.test(navigator.userAgent)
    return (
      <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+1rem)] left-4 right-4 bg-card rounded-xl shadow-lg p-4 flex items-start gap-3 z-50 border border-border animate-in slide-in-from-bottom-5 duration-300">
        <Icono />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground">Instalar {nombre}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {enAppInterna
              ? <>Abre este enlace en <strong className="text-foreground">Chrome</strong> (menú ⋮ → «Abrir en el navegador») y luego elige <strong className="text-foreground">Instalar app</strong>.</>
              : <>Toca el menú <strong className="text-foreground">⋮</strong> de Chrome y elige <strong className="text-foreground">Instalar app</strong> o <strong className="text-foreground">Añadir a pantalla de inicio</strong>.</>}
          </p>
        </div>
        <Cerrar onClick={cerrarDefinitivo} />
      </div>
    )
  }

  // iOS: no hay boton posible, solo se puede explicar el gesto.
  if (mostrarIos) {
    return (
      <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom)+1rem)] left-4 right-4 bg-card rounded-xl shadow-lg p-4 flex items-start gap-3 z-50 border border-border animate-in slide-in-from-bottom-5 duration-300">
        <Icono />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-foreground">Instalar {nombre}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Toca{' '}
            <span className="inline-flex items-center align-middle mx-0.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline text-primary"><path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M8 10H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-2"/></svg>
            </span>
            {' '}Compartir y después <strong className="text-foreground">Añadir a inicio</strong>.
          </p>
        </div>
        <Cerrar onClick={cerrarDefinitivo} />
      </div>
    )
  }

  return null
}
