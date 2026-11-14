/**
 * Jugadores y balón en 3D. Siluetas GENÉRICAS (piernas, pantaloneta, camiseta
 * del color del equipo, cabeza) con el dorsal y la etiqueta en un cartel que
 * siempre mira a la cámara. Nunca fotos (consentimiento de menores, D5).
 *
 * Se mueven por fuera de React: el bucle de la escena interpola los cuadros y
 * acá cada cuadro solo se escriben posiciones y opacidades en los objetos ya
 * montados (nada de re-render a 60 fps).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import {
  ballFor, figureBoost, figureScale, labelScreenSize, shortTag, toMeters, visibleLabels,
  type Court3D, type LabelRect, type PlayerVisual,
} from '@/lib/school/tactical3d';
import { ballTexture, labelTexture } from './textures';
import { track, useResources } from './resources';
import { setFigureOpacity, useFigureGeometries, type FigureGeometries, type LiveRef } from './figureKit';


/** Alto del cartel en pantalla: fracción del alto de la vista (sprites sin
 *  atenuación por distancia: se leen igual de cerca y de lejos). Más chico en
 *  el celular vertical: labelScreenSize. */

/** Una figura. `userData.fade` = materiales a los que se les baja la opacidad. */
export function PlayerFigure({
  visual, scale, geos, selected = false, onSelect, groupRef, name,
}: {
  visual: Pick<PlayerVisual, 'number' | 'label' | 'color' | 'shorts' | 'numberColor'>;
  scale: number;
  geos: FigureGeometries;
  selected?: boolean;
  onSelect?: () => void;
  groupRef?: (g: THREE.Group | null) => void;
  name?: string;
}) {
  // Cartel corto (dorsal o iniciales) en todos; la etiqueta completa solo en el
  // jugador tocado: desde arriba los carteles largos se montaban unos sobre otros.
  const aspect = useThree((st) => st.size.width / Math.max(1, st.size.height));
  const boost = figureBoost(aspect);
  const labelScreen = labelScreenSize(aspect);
  const tag = shortTag(visual);
  const r = useResources(() => {
    const lbl = selected && visual.label
      ? labelTexture(visual.number, visual.label, visual.color, visual.numberColor)
      : tag ? labelTexture(tag, '', visual.color, visual.numberColor) : null;
    return {
      jersey: track(new THREE.MeshStandardMaterial({ color: visual.color, roughness: 0.6, transparent: true })),
      shorts: track(new THREE.MeshStandardMaterial({ color: visual.shorts ?? '#0f172a', roughness: 0.7, transparent: true })),
      skin: track(new THREE.MeshStandardMaterial({ color: '#e0b48f', roughness: 0.8, transparent: true })),
      shadow: track(new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: boost > 1 ? 0.5 : 0.3, depthWrite: false })),
      ring: track(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, side: THREE.DoubleSide, depthWrite: false })),
      ...(lbl ? {
        labelTex: track(lbl.texture),
        label: track(new THREE.SpriteMaterial({ map: lbl.texture, sizeAttenuation: false, depthTest: false, transparent: true })),
      } : {}),
    };
  }, [visual.color, visual.number, visual.label, visual.shorts, visual.numberColor, selected, tag, boost]);

  const labelImg = r.labelTex?.image as HTMLCanvasElement | undefined;
  const labelAspect = labelImg ? labelImg.width / labelImg.height : 1;
  const s = scale * boost;
  const local = useRef<THREE.Group | null>(null);
  useEffect(() => {
    const g = local.current;
    if (!g) return;
    g.userData.fade = [r.jersey, r.shorts, r.skin, r.label].filter(Boolean);
    g.userData.shadow = r.shadow;
    g.userData.shadowBase = boost > 1 ? 0.5 : 0.3;
  }, [r, boost]);

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!onSelect || e.delta > 8) return;
    e.stopPropagation();
    onSelect();
  };

  return (
    <group ref={(g) => { local.current = g; groupRef?.(g); }} name={name} onClick={onSelect ? click : undefined}>
      <group scale={s}>
        <mesh geometry={geos.shadow} material={r.shadow} rotation-x={-Math.PI / 2} position-y={0.015} renderOrder={1} />
        {selected && <mesh geometry={geos.ring} material={r.ring} rotation-x={-Math.PI / 2} position-y={0.02} renderOrder={2} />}
        <mesh geometry={geos.leg} material={r.skin} position={[-0.1, 0.26, 0]} />
        <mesh geometry={geos.leg} material={r.skin} position={[0.1, 0.26, 0]} />
        <mesh geometry={geos.shorts} material={r.shorts} position-y={0.62} />
        <mesh geometry={geos.torso} material={r.jersey} position-y={1.04} />
        <mesh geometry={geos.head} material={r.skin} position-y={1.62} />
      </group>
      {r.label && (
        <sprite
          material={r.label}
          position-y={2.05 * s}
          scale={[labelScreen * labelAspect, labelScreen, 1]}
          center={new THREE.Vector2(0.5, 0)}
          renderOrder={10}
          userData={{ label: true }}
        />
      )}
    </group>
  );
}

/**
 * Esconde, cuadro a cuadro, los carteles que se montan sobre otro más cercano
 * a la cámara (visibleLabels). Va DESPUÉS de las capas de jugadores en la
 * escena: lee las posiciones que ellas acaban de escribir.
 */
export function LabelDeclutter() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), c: new THREE.Vector3() }), []);
  useFrame(() => {
    const sprites: THREE.Sprite[] = [];
    scene.traverse((o) => { if ((o as THREE.Sprite).isSprite && o.userData.label) sprites.push(o as THREE.Sprite); });
    if (sprites.length < 2) return;
    camera.getWorldPosition(tmp.c);
    const px = camera.projectionMatrix.elements;
    const rects: LabelRect[] = [];
    sprites.forEach((s, id) => {
      s.visible = true;
      if (!s.parent?.visible) return;
      s.updateWorldMatrix(true, false);
      tmp.v.setFromMatrixPosition(s.matrixWorld);
      const depth = tmp.v.distanceTo(tmp.c);
      tmp.v.project(camera);
      if (tmp.v.z < -1 || tmp.v.z > 1) return;
      // Sprite sin atenuación: el tamaño en NDC es escala × proyección.
      const w = s.scale.x * px[0] * size.width / 2;
      const h = s.scale.y * px[5] * size.height / 2;
      const x = (tmp.v.x + 1) / 2 * size.width - w / 2;
      const y = (1 - tmp.v.y) / 2 * size.height - h;
      rects.push({ id, x, y, w, h, depth });
    });
    const keep = visibleLabels(rects);
    for (const r of rects) sprites[r.id].visible = keep.has(r.id);
  });
  return null;
}

/** Los jugadores de una capa (la jugada o la superposición del rival). */
export function Players3D({
  court, keys, visuals, live, layer, selectedKey, onSelect,
}: {
  court: Court3D;
  keys: string[];
  visuals: Record<string, PlayerVisual>;
  live: LiveRef;
  layer: 'main' | 'overlay';
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  const geos = useFigureGeometries();
  const scale = figureScale(court);
  const refs = useRef(new Map<string, THREE.Group>());

  useFrame(() => {
    const frame = layer === 'main' ? live.current.main : live.current.overlay;
    const byKey = new Map((frame?.players ?? []).map((p) => [p.key, p]));
    for (const [key, g] of refs.current) {
      const p = byKey.get(key);
      if (!p || p.opacity <= 0.01) { g.visible = false; continue; }
      const m = toMeters(court, p.x, p.y);
      g.visible = true;
      g.position.set(m.x, 0, m.z);
      setFigureOpacity(g, p.opacity);
    }
  });

  return (
    <group name={`players-${layer}`}>
      {keys.map((key) => (
        <PlayerFigure
          key={key}
          name={`player:${layer}:${key}`}
          visual={visuals[key]}
          scale={scale}
          geos={geos}
          selected={selectedKey === key}
          onSelect={onSelect ? () => onSelect(key) : undefined}
          groupRef={(g) => { if (g) refs.current.set(key, g); else refs.current.delete(key); }}
        />
      ))}
    </group>
  );
}

/** Balón del deporte. Con `live` sigue al balón de la jugada (rodando);
 *  sin `live`, queda quieto en `position` (material «balón» de la pizarra). */
export function Ball3D({ court, live, position, opacity = 1 }: {
  court: Court3D; live?: LiveRef; position?: [number, number]; opacity?: number;
}) {
  const spec = ballFor(court.sport);
  // Exagerado a propósito: un balón real (22 cm) no se ve desde la tribuna.
  const radius = spec.radius * figureScale(court) * 1.8;
  const height = Math.max(radius, spec.height * figureScale(court));
  const r = useResources(() => {
    const tex = track(ballTexture(spec.style));
    return {
      tex,
      geo: track(new THREE.SphereGeometry(radius, 20, 14)),
      mat: track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, transparent: true })),
      shadowGeo: track(new THREE.CircleGeometry(radius * 1.2, 16)),
      shadowMat: track(new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false })),
    };
  }, [spec.style, radius]);
  const group = useRef<THREE.Group>(null);
  const ball = useRef<THREE.Mesh>(null);
  const last = useRef<{ x: number; z: number } | null>(null);
  const axis = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const g = group.current;
    const b = ball.current;
    if (!g || !b) return;
    const state = live ? live.current.ball : position ? { ...toMeters(court, position[0], position[1]), opacity } : null;
    if (!state || state.opacity <= 0.01) { g.visible = false; last.current = null; return; }
    g.visible = true;
    g.position.set(state.x, 0, state.z);
    r.mat.opacity = state.opacity;
    r.shadowMat.opacity = 0.35 * state.opacity;
    // Rodar: gira sobre el eje perpendicular al avance, distancia / radio.
    const prev = last.current;
    if (prev) {
      const dx = state.x - prev.x;
      const dz = state.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        axis.set(dz, 0, -dx).normalize();
        b.rotateOnWorldAxis(axis, d / radius);
      }
    }
    last.current = { x: state.x, z: state.z };
  });

  return (
    <group ref={group} name="ball">
      <mesh ref={ball} geometry={r.geo} material={r.mat} position-y={height} />
      <mesh geometry={r.shadowGeo} material={r.shadowMat} rotation-x={-Math.PI / 2} position-y={0.012} />
    </group>
  );
}
