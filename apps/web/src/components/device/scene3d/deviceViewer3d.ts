// Adapted from pingdotgg/t3code commit 6577c6b6
// (`packages/client-runtime/src/device/phoneViewer.ts`, MIT): a low-power WebGL
// renderer that draws the live decode canvas as the screen texture, renders
// only on change, and turns the body with a spring. See THIRD_PARTY_NOTICES.md.
import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  LinearFilter,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { bodyToFramePoint, createDeviceBody, type DeviceUvTurns } from "./deviceBody";
import { createDeviceFraming } from "./deviceFraming";
import { createDeviceMotion } from "./deviceMotion";
import type { DeviceBodySpec } from "./deviceShape";
import {
  DEVICE_VIEW_SNAPS,
  deviceViewRotation,
  nearestDeviceView,
  type DeviceViewName,
} from "./deviceViewSnap";
import { createRenderScheduler } from "./renderScheduler";

/*
 * This module is the 3D view's dynamic import: it and three.js load only when
 * a person turns the 3D view on, never with the device panel itself.
 */

export { bindDeviceTrackpad } from "./deviceTrackpad";
export { deviceBodySpec } from "./deviceShape";

/** How the body lies: its turn about the screen's normal, and how the frame maps onto it. */
export interface DeviceTurn {
  /** Counterclockwise radians, continuous (a quarter turn animates as a quarter turn). */
  readonly angle: number;
  readonly uvTurns: DeviceUvTurns;
}

export interface DeviceViewer3d {
  /** The decode canvas painted a new frame. */
  readonly frameUpdated: () => void;
  readonly setBody: (spec: DeviceBodySpec, turn: DeviceTurn) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  /**
   * The frame point under a canvas position (fractions of the canvas, from
   * its top left), as fractions of the frame picture, or null off the screen.
   */
  readonly framePoint: (x: number, y: number) => { readonly x: number; readonly y: number } | null;
  /** Orbit by a drag of this many canvas widths and heights. */
  readonly orbit: (deltaX: number, deltaY: number) => void;
  /** Zoom by `exp(logDelta)`. */
  readonly zoomBy: (logDelta: number) => void;
  readonly setInteractionActive: (active: boolean, mode: "touch" | "orbit") => void;
  readonly showView: (view: DeviceViewName) => void;
  /** Front view at the fitted size. */
  readonly restore: () => void;
  readonly dispose: () => void;
}

const TURN_MS = 450;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 2.6;

/** Owns only presentation resources: the decode canvas and the stream stay with the caller. */
export function createDeviceViewer3d(options: {
  readonly canvas: HTMLCanvasElement;
  readonly source: HTMLCanvasElement;
  readonly body: DeviceBodySpec;
  readonly turn: DeviceTurn;
  readonly onUnavailable: (reason: string) => void;
}): DeviceViewer3d {
  const { canvas, source } = options;
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;

  const makeTexture = () => {
    const next = new CanvasTexture(source);
    next.colorSpace = SRGBColorSpace;
    next.minFilter = LinearFilter;
    next.magFilter = LinearFilter;
    next.generateMipmaps = false;
    next.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    return next;
  };
  let texture = makeTexture();
  let textureWidth = source.width;
  let textureHeight = source.height;

  const scene = new Scene();
  // A procedural studio, prefiltered once, for the metal and glass reflections.
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  const ambient = new AmbientLight(0xffffff, 0.35);
  const key = new DirectionalLight(0xf2f5ff, 1.6);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 1.2);
  rim.position.set(3, 1, -3);
  scene.add(ambient, key, rim);

  const camera = new PerspectiveCamera(30, 1, 0.1, 40);
  camera.position.z = 6;

  let spec = options.body;
  let uvTurns = options.turn.uvTurns;
  let turnAngle = options.turn.angle;
  let turnAnimation: { from: number; to: number; startedAt: number } | null = null;
  let body = createDeviceBody(spec, texture, uvTurns, environment.texture);
  scene.add(body.root);
  let disposed = false;
  let zoom = 1;

  const front = new Quaternion();
  const motion = createDeviceMotion({
    choose: (rotation) => nearestDeviceView(rotation, DEVICE_VIEW_SNAPS)?.rotation ?? front,
  });
  motion.setPose(front, performance.now(), true);
  const framing = createDeviceFraming();
  const reducedMotion = () =>
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  let viewport = { width: 0, height: 0, pixelRatio: 1 };
  let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };

  const applyPose = () => {
    body.root.quaternion.copy(motion.rotation);
    body.orientation.rotation.z = turnAngle;
  };
  const applyCamera = () => {
    camera.position.set(framing.center.x, framing.center.y, framing.distance() / zoom);
    camera.lookAt(framing.center.x, framing.center.y, 0);
    camera.updateProjectionMatrix();
  };
  const fit = (immediate = false) => {
    if (!viewport.width || !viewport.height) return;
    camera.aspect = viewport.width / viewport.height;
    body.root.updateMatrixWorld(true);
    framing.setBounds(
      new Box3().setFromObject(body.root),
      (camera.fov * Math.PI) / 360,
      camera.aspect,
      performance.now(),
      immediate,
    );
    applyCamera();
  };

  const scheduler = createRenderScheduler(() => {
    if (disposed || !viewport.width || !viewport.height) return;
    try {
      if (
        drawingBuffer.width !== viewport.width ||
        drawingBuffer.height !== viewport.height ||
        drawingBuffer.pixelRatio !== viewport.pixelRatio
      ) {
        // Resizing clears the canvas; commit the new size with the redraw.
        renderer.setPixelRatio(viewport.pixelRatio);
        renderer.setSize(viewport.width, viewport.height, false);
        drawingBuffer = viewport;
      }
      const now = performance.now();
      const reduced = reducedMotion();
      if (motion.advance(now, reduced)) {
        applyPose();
        fit(reduced);
      }
      if (turnAnimation) {
        const progress = reduced ? 1 : Math.min(1, (now - turnAnimation.startedAt) / TURN_MS);
        const eased = progress * progress * (3 - 2 * progress);
        turnAngle = turnAnimation.from + (turnAnimation.to - turnAnimation.from) * eased;
        if (progress === 1) turnAnimation = null;
        applyPose();
        fit(reduced);
      }
      framing.advance(now, reduced);
      applyCamera();
      renderer.render(scene, camera);
      if (motion.needsFrame() || framing.needsFrame() || turnAnimation) scheduler.invalidate();
    } catch {
      options.onUnavailable("The 3D view stopped rendering.");
    }
  });

  /** A new frame size needs a new texture; the old one is released. */
  const syncTexture = () => {
    if (textureWidth === source.width && textureHeight === source.height) return;
    const previous = texture;
    texture = makeTexture();
    textureWidth = source.width;
    textureHeight = source.height;
    body.setScreen(texture, uvTurns);
    previous.dispose();
  };

  const setTurn = (turn: DeviceTurn) => {
    if (turn.uvTurns !== uvTurns) {
      uvTurns = turn.uvTurns;
      body.setScreen(texture, uvTurns);
    }
    if (turn.angle === (turnAnimation?.to ?? turnAngle)) return;
    turnAnimation = { from: turnAngle, to: turn.angle, startedAt: performance.now() };
  };

  const contextLost = (event: Event) => {
    event.preventDefault();
    options.onUnavailable("The browser dropped the 3D view's graphics context.");
  };
  canvas.addEventListener("webglcontextlost", contextLost);
  applyPose();

  return {
    frameUpdated() {
      if (disposed) return;
      syncTexture();
      texture.needsUpdate = true;
      scheduler.invalidate();
    },
    setBody(nextSpec, turn) {
      if (disposed) return;
      if (nextSpec !== spec) {
        scene.remove(body.root);
        body.dispose();
        spec = nextSpec;
        uvTurns = turn.uvTurns;
        body = createDeviceBody(spec, texture, uvTurns, environment.texture);
        scene.add(body.root);
        turnAnimation = null;
        turnAngle = turn.angle;
        applyPose();
        fit(true);
      } else {
        setTurn(turn);
      }
      scheduler.invalidate();
    },
    resize(width, height, pixelRatio) {
      if (disposed) return;
      if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
      const ratio = Math.min(2, Math.max(1, pixelRatio));
      if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio)
        return;
      viewport = { width, height, pixelRatio: ratio };
      fit(true);
      scheduler.invalidate();
    },
    framePoint(x, y) {
      if (disposed) return null;
      applyPose();
      const point = body.screenPointAt(x * 2 - 1, 1 - y * 2, camera);
      return point ? bodyToFramePoint(point.s, point.t, uvTurns) : null;
    },
    orbit(deltaX, deltaY) {
      if (disposed) return;
      motion.orbit(deltaX * viewport.width, deltaY * viewport.height, performance.now());
      scheduler.invalidate();
    },
    zoomBy(logDelta) {
      if (disposed || !Number.isFinite(logDelta)) return;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(logDelta)));
      scheduler.invalidate();
    },
    setInteractionActive(active, mode) {
      if (disposed) return;
      const now = performance.now();
      if (mode === "orbit") motion.dragActive(active, now);
      else {
        // The screen must not move under a finger that is on it.
        motion.hold(active, now);
        framing.hold(active, now);
      }
      scheduler.invalidate();
    },
    showView(view) {
      if (disposed) return;
      motion.reset(deviceViewRotation(view), performance.now());
      scheduler.invalidate();
    },
    restore() {
      if (disposed) return;
      zoom = 1;
      motion.reset(front, performance.now());
      scheduler.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      canvas.removeEventListener("webglcontextlost", contextLost);
      scene.remove(body.root);
      body.dispose();
      texture.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
