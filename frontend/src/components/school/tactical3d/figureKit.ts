/**
 * Piezas compartidas de las figuras 3D que no son componentes (separadas de
 * Figures3D.tsx por la regla de Fast Refresh).
 */
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import type { LiveState } from '@/lib/school/tactical3d';
import { track, useResources } from './resources';

/** Instante actual de la jugada (lo escribe el bucle de la escena). */
export type LiveRef = MutableRefObject<LiveState>;

/** Geometrías compartidas por todas las figuras de una capa. */
export function useFigureGeometries() {
  return useResources(() => ({
    leg: track(new THREE.CylinderGeometry(0.075, 0.07, 0.52, 8)),
    shorts: track(new THREE.CylinderGeometry(0.21, 0.2, 0.26, 12)),
    torso: track(new THREE.CapsuleGeometry(0.22, 0.4, 4, 12)),
    head: track(new THREE.SphereGeometry(0.13, 14, 10)),
    shadow: track(new THREE.CircleGeometry(0.42, 20)),
    ring: track(new THREE.RingGeometry(0.5, 0.62, 32)),
  }), []);
}
export type FigureGeometries = ReturnType<typeof useFigureGeometries>;

/** Opacidad de una figura (fade de entrada/salida de la animación). */
export function setFigureOpacity(g: THREE.Object3D, opacity: number) {
  const fade = g.userData.fade as THREE.Material[] | undefined;
  if (fade) for (const m of fade) m.opacity = opacity;
  const sh = g.userData.shadow as THREE.Material | undefined;
  // En el celular vertical la sombra es más marcada (shadowBase): ancla la figura al piso.
  if (sh) sh.opacity = ((g.userData.shadowBase as number | undefined) ?? 0.3) * opacity;
}

