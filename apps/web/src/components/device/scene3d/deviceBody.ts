// The construction follows pingdotgg/t3code commit 6577c6b6
// (`packages/client-runtime/src/device/phoneScene.ts`, MIT): an extruded body
// with glass and metal materials, the live screen as a textured face, side
// buttons and a rear camera. See THIRD_PARTY_NOTICES.md.
import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Ray,
  Shape,
  ShapeGeometry,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Texture,
} from "three";

import { traceSquircle } from "../deviceChassis";
import type { DeviceBodySpec, DeviceScreenCutout } from "./deviceShape";
import type { DeviceUvTurns } from "./deviceTurn";

export type { DeviceUvTurns } from "./deviceTurn";

/** A squircle centred on the origin, as a three.js shape. */
function squircleShape(width: number, height: number, radius: number): Shape {
  const shape = new Shape();
  traceSquircle(shape, -width / 2, -height / 2, width, height, radius);
  return shape;
}

/** A rounded rectangle with circular corners (camera plates, the island). */
function roundedShape(width: number, height: number, radius: number): Shape {
  const r = Math.min(radius, width / 2, height / 2);
  const x = -width / 2;
  const y = -height / 2;
  const shape = new Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(x + width, y + height - r);
  shape.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2, false);
  shape.lineTo(x + r, y + height);
  shape.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(x, y + r);
  shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** A tab hanging from y = 0 downward, with rounded lower corners and flared shoulders. */
function notchShape(width: number, height: number): Shape {
  const r = height * 0.55;
  const shoulder = height * 0.3;
  const x = -width / 2;
  const shape = new Shape();
  shape.moveTo(x - shoulder, 0);
  shape.quadraticCurveTo(x, 0, x, -shoulder);
  shape.lineTo(x, -height + r);
  shape.quadraticCurveTo(x, -height, x + r, -height);
  shape.lineTo(-x - r, -height);
  shape.quadraticCurveTo(-x, -height, -x, -height + r);
  shape.lineTo(-x, -shoulder);
  shape.quadraticCurveTo(-x, 0, -x + shoulder, 0);
  shape.lineTo(x - shoulder, 0);
  return shape;
}

/**
 * Where a point on the screen, as fractions from its top left (`s` across,
 * `t` down, both in the body's own portrait frame), falls in the frame
 * picture, as fractions from the frame's top left.
 */
export function bodyToFramePoint(
  s: number,
  t: number,
  uvTurns: DeviceUvTurns,
): { readonly x: number; readonly y: number } {
  if (uvTurns === 1) return { x: t, y: 1 - s };
  if (uvTurns === 3) return { x: 1 - t, y: s };
  return { x: s, y: t };
}

function applyScreenUv(
  geometry: BufferGeometry,
  width: number,
  height: number,
  uvTurns: DeviceUvTurns,
): void {
  const position = geometry.getAttribute("position");
  if (!position) return;
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    const s = (position.getX(index) + width / 2) / width;
    const t = (height / 2 - position.getY(index)) / height;
    const frame = bodyToFramePoint(s, t, uvTurns);
    // Canvas textures are flipped on upload: v runs bottom-up.
    uv[index * 2] = frame.x;
    uv[index * 2 + 1] = 1 - frame.y;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
}

function cutoutMesh(
  cutout: DeviceScreenCutout,
  screenWidth: number,
  screenHeight: number,
  material: MeshBasicMaterial,
): Mesh | null {
  switch (cutout.kind) {
    case "none":
      return null;
    case "island": {
      const height = cutout.height * screenHeight;
      const mesh = new Mesh(
        new ShapeGeometry(roundedShape(cutout.width * screenWidth, height, height / 2), 12),
        material,
      );
      mesh.position.y = screenHeight / 2 - cutout.top * screenHeight - height / 2;
      return mesh;
    }
    case "notch": {
      const mesh = new Mesh(
        new ShapeGeometry(notchShape(cutout.width * screenWidth, cutout.height * screenHeight), 10),
        material,
      );
      mesh.position.y = screenHeight / 2 + 0.0005;
      return mesh;
    }
    case "punch-hole": {
      const radius = cutout.radius * screenHeight;
      const mesh = new Mesh(new CircleGeometry(radius, 32), material);
      mesh.position.y = screenHeight / 2 - cutout.top * screenHeight - radius;
      return mesh;
    }
  }
}

const SCREEN_Z = 0.0012;

export interface DeviceBody {
  /** Turned by the orbit. */
  readonly root: Group;
  /** Turned by the device's orientation, inside `root`. */
  readonly orientation: Group;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /**
   * The screen under a ray from the camera through normalized device
   * coordinates, as fractions of the body's portrait screen (`s` across, `t`
   * down), or null when the ray misses it or meets it from behind.
   */
  readonly screenPointAt: (
    ndcX: number,
    ndcY: number,
    camera: Camera,
  ) => { readonly s: number; readonly t: number } | null;
  readonly setScreen: (texture: Texture, uvTurns: DeviceUvTurns) => void;
  readonly dispose: () => void;
}

/**
 * `environment` is the prefiltered studio the lit materials reflect. It is set
 * on each material rather than as the scene's environment: three.js ignores a
 * material's `envMapIntensity` for the scene's, and the lenses and the metal
 * need different amounts of it.
 */
export function createDeviceBody(
  spec: DeviceBodySpec,
  texture: Texture,
  uvTurns: DeviceUvTurns,
  environment: Texture | null = null,
): DeviceBody {
  const root = new Group();
  const orientation = new Group();
  root.add(orientation);

  const width = spec.screenWidth + 2 * spec.bezel;
  const height = spec.screenHeight + 2 * spec.bezel;
  const bodyRadius = spec.screenRadius + spec.bezel;
  const bevel = Math.min(0.016, spec.depth * 0.28);

  const frame = new MeshStandardMaterial({
    color: spec.colors.frame,
    metalness: spec.colors.metalness,
    roughness: spec.colors.roughness,
    envMap: environment,
    envMapIntensity: 0.9,
  });
  // The black glass round the screen, unlit: any sheen on this flat band (a
  // coat mirroring the studio, the key light's highlight) reads as a grey or
  // white rim beside the live picture, which real bezels never show.
  const glass = new MeshBasicMaterial({ color: 0x050506 });
  const back = new MeshPhysicalMaterial({
    color: spec.colors.back,
    metalness: spec.kind === "iPad" ? spec.colors.metalness : 0.25,
    roughness: spec.kind === "iPad" ? spec.colors.roughness : 0.5,
    clearcoat: spec.kind === "iPad" ? 0 : 0.6,
    clearcoatRoughness: 0.35,
    envMap: environment,
    envMapIntensity: 0.8,
  });
  // Dark lens glass: a dim reflection of the studio, not a mirror of its lights.
  const lensGlass = new MeshStandardMaterial({
    color: 0x020307,
    metalness: 0,
    roughness: 0.25,
    envMap: environment,
    envMapIntensity: 0.12,
  });
  const black = new MeshBasicMaterial({ color: 0x000000 });
  // The front camera in a tablet's bezel: a dark dot, unlit like the bezel.
  const bezelLens = new MeshBasicMaterial({ color: 0x1b1e26 });
  const flash = new MeshBasicMaterial({ color: 0xf1e9d2 });
  const screenMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const materials = [frame, glass, back, lensGlass, black, bezelLens, flash, screenMaterial];

  // The body: glass caps front and back, metal round the sides.
  const body = new Mesh(
    new ExtrudeGeometry(squircleShape(width - 2 * bevel, height - 2 * bevel, bodyRadius - bevel), {
      depth: Math.max(0.001, spec.depth - 2 * bevel),
      bevelEnabled: true,
      bevelSize: bevel,
      bevelThickness: bevel,
      bevelSegments: 4,
      curveSegments: 10,
    }),
    [glass, frame],
  );
  body.position.z = -spec.depth + bevel;
  orientation.add(body);

  const screenGeometry = new ShapeGeometry(
    squircleShape(spec.screenWidth, spec.screenHeight, spec.screenRadius),
    16,
  );
  applyScreenUv(screenGeometry, spec.screenWidth, spec.screenHeight, uvTurns);
  const screen = new Mesh(screenGeometry, screenMaterial);
  screen.position.z = SCREEN_Z;
  orientation.add(screen);

  const cutout = cutoutMesh(spec.cutout, spec.screenWidth, spec.screenHeight, black);
  if (cutout) {
    cutout.position.z = SCREEN_Z + 0.0006;
    orientation.add(cutout);
  }
  if (spec.bezelCamera) {
    const lens = new Mesh(new CircleGeometry(spec.bezel * 0.16, 24), bezelLens);
    lens.position.set(0, spec.screenHeight / 2 + spec.bezel / 2, SCREEN_Z);
    orientation.add(lens);
  }

  // A smooth panel over the back cap, in the back's own finish.
  const backPanel = new Mesh(
    new ShapeGeometry(
      squircleShape(width - 2 * bevel - 0.004, height - 2 * bevel - 0.004, bodyRadius - bevel),
      16,
    ),
    back,
  );
  backPanel.rotation.y = Math.PI;
  backPanel.position.z = -spec.depth - 0.0008;
  orientation.add(backPanel);

  // Side buttons.
  for (const button of spec.buttons) {
    const along = button.length;
    const geometry =
      button.side === "top"
        ? new BoxGeometry(along, spec.buttonProtrude * 2, spec.depth * 0.42)
        : new BoxGeometry(spec.buttonProtrude * 2, along, spec.depth * 0.42);
    const mesh = new Mesh(geometry, frame);
    if (button.side === "top") mesh.position.set(button.offset, height / 2, -spec.depth / 2);
    else
      mesh.position.set(
        (button.side === "left" ? -1 : 1) * (width / 2),
        button.offset,
        -spec.depth / 2,
      );
    orientation.add(mesh);
  }

  // The rear camera, laid out as seen from behind: the group faces out of the
  // back, so its +x is the viewer's right when looking at the back.
  const camera = spec.camera;
  const rear = new Group();
  rear.rotation.y = Math.PI;
  rear.position.set(
    width / 2 - camera.insetX - camera.width / 2,
    height / 2 - camera.insetY - camera.height / 2,
    -spec.depth - 0.001,
  );
  orientation.add(rear);
  const plateDepth = spec.kind === "iPad" ? 0.008 : 0.018;
  const plate = new Mesh(
    new ExtrudeGeometry(roundedShape(camera.width, camera.height, camera.radius), {
      depth: plateDepth,
      bevelEnabled: true,
      bevelSize: 0.006,
      bevelThickness: 0.005,
      bevelSegments: 3,
      curveSegments: 12,
    }),
    back,
  );
  rear.add(plate);
  const plateFront = plateDepth + 0.005;
  const ringDepth = spec.kind === "iPad" ? 0.012 : 0.022;
  for (const [x, y] of camera.lenses) {
    const ring = new Mesh(
      new CylinderGeometry(camera.lensRadius + 0.012, camera.lensRadius + 0.014, ringDepth, 36),
      frame,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, plateFront + ringDepth / 2 - 0.002);
    rear.add(ring);
    const lens = new Mesh(new CircleGeometry(camera.lensRadius, 36), lensGlass);
    lens.position.set(x, y, plateFront + ringDepth - 0.0015);
    rear.add(lens);
  }
  if (camera.flash) {
    const light = new Mesh(new CircleGeometry(0.022, 20), flash);
    light.position.set(camera.flash[0], camera.flash[1], plateFront + 0.0006);
    rear.add(light);
  }

  const inverse = new Matrix4();
  const ray = new Ray();
  const hit = new Vector3();
  const origin = new Vector3();
  const direction = new Vector3();

  return {
    root,
    orientation,
    width,
    height,
    depth: spec.depth,
    screenPointAt(ndcX, ndcY, view) {
      root.updateWorldMatrix(true, true);
      view.updateMatrixWorld(true);
      // A perspective ray from the camera through the pointer.
      origin.setFromMatrixPosition(view.matrixWorld);
      direction.set(ndcX, ndcY, 0.5).unproject(view).sub(origin).normalize();
      inverse.copy(screen.matrixWorld).invert();
      ray.set(origin, direction).applyMatrix4(inverse);
      // From behind the glass the screen cannot be touched.
      if (ray.direction.z >= -1e-6) return null;
      const distance = -ray.origin.z / ray.direction.z;
      if (distance <= 0) return null;
      ray.at(distance, hit);
      const s = (hit.x + spec.screenWidth / 2) / spec.screenWidth;
      const t = (spec.screenHeight / 2 - hit.y) / spec.screenHeight;
      if (s < 0 || s > 1 || t < 0 || t > 1) return null;
      return { s, t };
    },
    setScreen(next, nextUvTurns) {
      screenMaterial.map = next;
      screenMaterial.needsUpdate = true;
      applyScreenUv(screenGeometry, spec.screenWidth, spec.screenHeight, nextUvTurns);
    },
    dispose() {
      root.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose();
      });
      for (const material of materials) material.dispose();
    },
  };
}
