/**
 * Inclinación 3D del carnet (spec carnet-3d-club.md §4).
 *
 * - Sigue el dedo/mouse y el giroscopio. En iOS el giroscopio pide permiso
 *   explícito con un toque («Activar movimiento»): `movimiento === 'requiere_permiso'`.
 * - Tocar gira el carnet (frente ↔ reverso).
 * - `prefers-reduced-motion`: sin inclinación, sin giroscopio, sin brillo
 *   animado; el giro lo resuelve el componente como un fundido.
 * - Rendimiento: el hook escribe `transform` y `opacity` directo en el DOM
 *   (sin re-render de React por cuadro), con UN requestAnimationFrame por
 *   cuadro, y se detiene cuando la tarjeta llega a su objetivo.
 *
 * La matemática está en funciones puras exportadas (probadas en useTilt3D.test.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

// ───────────────────────────────────────────────────────────────────────────
// Matemática pura
// ───────────────────────────────────────────────────────────────────────────

export const MAX_GRADOS = 14;

export interface Inclinacion {
  /** Rotación sobre X (grados): positivo = el borde de arriba se aleja. */
  rx: number;
  /** Rotación sobre Y (grados): positivo = el borde derecho se aleja. */
  ry: number;
}

export function limitar(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(max, Math.max(min, v));
}

/**
 * Puntero (coordenadas de pantalla) → inclinación. El centro de la tarjeta da
 * 0°, los bordes dan ±max. La tarjeta "mira" hacia el puntero.
 */
export function inclinacionDesdePuntero(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  max = MAX_GRADOS,
): Inclinacion {
  if (!rect.width || !rect.height) return { rx: 0, ry: 0 };
  const px = limitar((x - rect.left) / rect.width, 0, 1);
  const py = limitar((y - rect.top) / rect.height, 0, 1);
  return { rx: limitar((0.5 - py) * 2 * max, -max, max), ry: limitar((px - 0.5) * 2 * max, -max, max) };
}

/**
 * Giroscopio (DeviceOrientationEvent) → inclinación.
 * `beta` (adelante/atrás) se mide contra `betaBase` (la postura en que la
 * persona sostiene el celular); `gamma` (izquierda/derecha) contra 0. 30° de
 * movimiento del celular = inclinación máxima. En horizontal (90 / 270) se
 * intercambian los ejes.
 */
export function inclinacionDesdeGiroscopio(
  beta: number | null | undefined,
  gamma: number | null | undefined,
  betaBase: number,
  max = MAX_GRADOS,
  anguloPantalla = 0,
): Inclinacion {
  if (beta == null || gamma == null) return { rx: 0, ry: 0 };
  let adelante = beta - betaBase;
  let lado = gamma;
  const a = ((anguloPantalla % 360) + 360) % 360;
  if (a === 90) { const t = adelante; adelante = -lado; lado = t; }
  else if (a === 270) { const t = adelante; adelante = lado; lado = -t; }
  else if (a === 180) { adelante = -adelante; lado = -lado; }
  const k = max / 30;
  return { rx: limitar(-adelante * k, -max, max), ry: limitar(lado * k, -max, max) };
}

/** Interpolación lineal hacia el objetivo (factor 0..1 por cuadro). */
export function suavizar(actual: number, objetivo: number, factor: number): number {
  return actual + (objetivo - actual) * limitar(factor, 0, 1);
}

/** ¿Ya llegó? (para detener el requestAnimationFrame). */
export function llego(actual: number, objetivo: number, tolerancia = 0.05): boolean {
  return Math.abs(actual - objetivo) <= tolerancia;
}

/** El transform de la tarjeta: inclinación + giro (0° frente, 180° reverso). */
export function transformTarjeta(rx: number, ry: number, giro: number): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return `rotateX(${r(rx)}deg) rotateY(${r(ry + giro)}deg)`;
}

/**
 * Brillo holográfico / reflejo: se desplazan EN CONTRA de la inclinación
 * (la luz queda quieta y la tarjeta se mueve debajo). Devuelve el
 * desplazamiento en % del tamaño de la capa (que mide el doble de la tarjeta)
 * y la opacidad, que crece con la inclinación.
 */
export function brilloDesdeInclinacion(rx: number, ry: number, max = MAX_GRADOS): { tx: number; ty: number; opacidad: number } {
  const nx = max ? limitar(ry / max, -1, 1) : 0;
  const ny = max ? limitar(rx / max, -1, 1) : 0;
  const fuerza = Math.min(1, Math.hypot(nx, ny));
  const r = (n: number) => Math.round(n * 100) / 100;
  return { tx: r(-25 - nx * 20), ty: r(-25 + ny * 20), opacidad: r(0.15 + fuerza * 0.55) };
}

// ───────────────────────────────────────────────────────────────────────────
// Hook
// ───────────────────────────────────────────────────────────────────────────

export type EstadoMovimiento = 'no_disponible' | 'requiere_permiso' | 'activo' | 'denegado';

export interface UseTilt3DOpciones {
  /** false en modo 'plano': no hay listeners ni animación. */
  activo: boolean;
  maxGrados?: number;
  giradoInicial?: boolean;
}

type DOEConPermiso = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

function prefiereMenosMovimiento(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function esTactil(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function anguloPantalla(): number {
  if (typeof window === 'undefined') return 0;
  const so = window.screen?.orientation;
  return typeof so?.angle === 'number' ? so.angle : 0;
}

export function useTilt3D({ activo, maxGrados = MAX_GRADOS, giradoInicial = false }: UseTilt3DOpciones) {
  const refEscena = useRef<HTMLDivElement>(null);
  const refTarjeta = useRef<HTMLDivElement>(null);
  const [girado, setGirado] = useState(giradoInicial);
  const [reducido, setReducido] = useState(prefiereMenosMovimiento);
  const [movimiento, setMovimiento] = useState<EstadoMovimiento>('no_disponible');

  const s = useRef({
    rx: 0, ry: 0, giro: giradoInicial ? 180 : 0,
    orx: 0, ory: 0, ogiro: giradoInicial ? 180 : 0,
    raf: 0,
    puntero: false,
    betaBase: null as number | null,
    brillos: [] as HTMLElement[],
  });

  // prefers-reduced-motion en vivo.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cambio = () => setReducido(mq.matches);
    mq.addEventListener?.('change', cambio);
    return () => mq.removeEventListener?.('change', cambio);
  }, []);

  const animado = activo && !reducido;

  const pintar = useCallback(() => {
    const st = s.current;
    st.raf = 0;
    const el = refTarjeta.current;
    if (!el) return;
    st.rx = suavizar(st.rx, st.orx, 0.16);
    st.ry = suavizar(st.ry, st.ory, 0.16);
    st.giro = suavizar(st.giro, st.ogiro, 0.14);
    const fin = llego(st.rx, st.orx) && llego(st.ry, st.ory) && llego(st.giro, st.ogiro, 0.3);
    if (fin) { st.rx = st.orx; st.ry = st.ory; st.giro = st.ogiro; }
    el.style.transform = transformTarjeta(st.rx, st.ry, st.giro);
    if (st.brillos.length === 0) st.brillos = Array.from(el.querySelectorAll<HTMLElement>('[data-brillo]'));
    const b = brilloDesdeInclinacion(st.rx, st.ry, maxGrados);
    for (const g of st.brillos) {
      const signo = g.dataset.brillo === 'reflejo' ? -1 : 1;
      g.style.transform = `translate3d(${b.tx * signo}%, ${b.ty * signo}%, 0)`;
      g.style.opacity = String(g.dataset.brillo === 'reflejo' ? b.opacidad * 0.6 : b.opacidad);
    }
    if (!fin) st.raf = requestAnimationFrame(pintar);
  }, [maxGrados]);

  const pedirCuadro = useCallback(() => {
    if (!s.current.raf) s.current.raf = requestAnimationFrame(pintar);
  }, [pintar]);

  // Al cambiar a reducido o plano: la tarjeta queda derecha, sin transform.
  useEffect(() => {
    const st = s.current;
    if (!animado) {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      st.rx = st.ry = st.orx = st.ory = 0;
      if (refTarjeta.current) refTarjeta.current.style.transform = '';
      return;
    }
    st.brillos = [];
    st.giro = st.ogiro = girado ? 180 : 0;
    pedirCuadro();
    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
    };
    // girado se sincroniza en girar(); acá solo al entrar/salir del modo animado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animado, pedirCuadro]);

  // Giroscopio.
  const escucharGiroscopio = useCallback(() => {
    const alMoverse = (e: DeviceOrientationEvent) => {
      const st = s.current;
      if (st.puntero || e.beta == null || e.gamma == null) return;
      st.betaBase = st.betaBase == null ? e.beta : suavizar(st.betaBase, e.beta, 0.01);
      const inc = inclinacionDesdeGiroscopio(e.beta, e.gamma, st.betaBase, maxGrados, anguloPantalla());
      st.orx = inc.rx;
      st.ory = inc.ry;
      pedirCuadro();
    };
    window.addEventListener('deviceorientation', alMoverse);
    return () => window.removeEventListener('deviceorientation', alMoverse);
  }, [maxGrados, pedirCuadro]);

  const quitarGiroscopio = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!animado || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      setMovimiento('no_disponible');
      return;
    }
    const DOE = window.DeviceOrientationEvent as DOEConPermiso;
    if (typeof DOE.requestPermission === 'function') {
      setMovimiento((m) => (m === 'activo' || m === 'denegado' ? m : 'requiere_permiso'));
    } else if (esTactil()) {
      quitarGiroscopio.current = escucharGiroscopio();
      setMovimiento('activo');
    } else {
      setMovimiento('no_disponible');
    }
    return () => {
      quitarGiroscopio.current?.();
      quitarGiroscopio.current = null;
    };
  }, [animado, escucharGiroscopio]);

  /** iOS: debe llamarse desde un toque del usuario. */
  const activarMovimiento = useCallback(async () => {
    const DOE = (typeof window !== 'undefined' ? window.DeviceOrientationEvent : undefined) as DOEConPermiso | undefined;
    if (!DOE?.requestPermission) return;
    try {
      const r = await DOE.requestPermission();
      if (r === 'granted') {
        quitarGiroscopio.current?.();
        quitarGiroscopio.current = escucharGiroscopio();
        setMovimiento('activo');
      } else {
        setMovimiento('denegado');
      }
    } catch {
      setMovimiento('denegado');
    }
  }, [escucharGiroscopio]);

  const girar = useCallback(() => {
    setGirado((g) => {
      const nuevo = !g;
      s.current.ogiro = nuevo ? 180 : 0;
      return nuevo;
    });
    if (animado) pedirCuadro();
  }, [animado, pedirCuadro]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!animado) return;
    const el = refEscena.current;
    if (!el) return;
    const inc = inclinacionDesdePuntero(e.clientX, e.clientY, el.getBoundingClientRect(), maxGrados);
    const st = s.current;
    st.puntero = true;
    // El reverso ya está rotado 180° dentro de la tarjeta: la misma
    // inclinación vale para las dos caras, sin espejar.
    st.orx = inc.rx;
    st.ory = inc.ry;
    pedirCuadro();
  }, [animado, maxGrados, pedirCuadro]);

  const onPointerLeave = useCallback(() => {
    const st = s.current;
    st.puntero = false;
    if (!animado) return;
    st.orx = 0;
    st.ory = 0;
    pedirCuadro();
  }, [animado, pedirCuadro]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      girar();
    }
  }, [girar]);

  return {
    refEscena,
    refTarjeta,
    girado,
    girar,
    reducido,
    animado,
    movimiento,
    activarMovimiento,
    manejadores: { onPointerMove, onPointerLeave, onPointerCancel: onPointerLeave, onClick: girar, onKeyDown },
  };
}
