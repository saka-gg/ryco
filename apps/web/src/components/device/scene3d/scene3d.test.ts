import { PerspectiveCamera, Quaternion, Texture, Vector3 } from "three";
import { describe, expect, it, vi } from "vite-plus/test";

import { bodyToFramePoint, createDeviceBody } from "./deviceBody";
import { deviceBodySpec, DEVICE_SCREEN_HEIGHT } from "./deviceShape";
import { deviceTurn3d } from "./deviceTurn";
import { DEVICE_VIEW_SNAPS, deviceViewRotation, nearestDeviceView } from "./deviceViewSnap";
import { deviceWheelNavigation } from "./deviceTrackpad";
import { createRenderScheduler } from "./renderScheduler";

const yaw = (radians: number) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), radians);

describe("deviceBodySpec", () => {
  it("sizes the screen from the device's own aspect and the 2D chassis numbers", () => {
    const spec = deviceBodySpec("iPhone", 402 / 874, "iPhone 18 Pro");
    expect(spec.screenHeight).toBe(DEVICE_SCREEN_HEIGHT);
    expect(spec.screenWidth).toBeCloseTo(DEVICE_SCREEN_HEIGHT * (402 / 874));
    // 54 of 2622 reference pixels of bezel, 186 of screen corner.
    expect(spec.bezel).toBeCloseTo((54 / 2622) * DEVICE_SCREEN_HEIGHT);
    expect(spec.screenRadius).toBeCloseTo((186 / 2622) * DEVICE_SCREEN_HEIGHT);
    // A landscape aspect is read as the same portrait screen.
    expect(deviceBodySpec("iPhone", 874 / 402, "iPhone 18 Pro").aspect).toBeCloseTo(402 / 874);
  });

  it("tells the iPhone generations apart by name, and falls back to a Pro for other names", () => {
    expect(deviceBodySpec("iPhone", 0.46, "iPhone 18 Pro").cutout.kind).toBe("island");
    expect(deviceBodySpec("iPhone", 0.46, "iPhone 16e").cutout.kind).toBe("notch");
    expect(deviceBodySpec("iPhone", 0.46, "iPhone 18 Pro").camera.lenses).toHaveLength(3);
    expect(deviceBodySpec("iPhone", 0.46, "iPhone 17").camera.lenses).toHaveLength(2);
    expect(deviceBodySpec("iPhone", 0.46, "iPhone Air").camera.lenses).toHaveLength(1);
    expect(deviceBodySpec("iPhone", 0.46, "QA phone").camera.lenses).toHaveLength(3);
  });

  it("gives tablets a thin body without a screen cutout and Android a punch hole", () => {
    const iPad = deviceBodySpec("iPad", 0.7, "iPad Pro 11-inch (M5)");
    expect(iPad.cutout.kind).toBe("none");
    expect(iPad.bezelCamera).toBe(true);
    expect(iPad.depth).toBeLessThan(deviceBodySpec("iPhone", 0.46, "iPhone 17").depth / 2);
    expect(deviceBodySpec("androidPhone", 0.45, "Pixel").cutout.kind).toBe("punch-hole");
  });
});

describe("bodyToFramePoint", () => {
  it("maps the body's screen onto a frame that turns with it or lies upright", () => {
    expect(bodyToFramePoint(0.25, 0.1, 0)).toEqual({ x: 0.25, y: 0.1 });
    // Body turned a quarter counterclockwise: its top edge is the picture's left.
    expect(bodyToFramePoint(0.5, 0, 1)).toEqual({ x: 0, y: 0.5 });
    expect(bodyToFramePoint(1, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(bodyToFramePoint(0, 0, 3)).toEqual({ x: 1, y: 0 });
  });
});

describe("deviceTurn3d", () => {
  it("turns an iOS body with its portrait frame, counterclockwise for a clockwise CSS turn", () => {
    const portraitFrame = { width: 1206, height: 2622 };
    expect(deviceTurn3d(0, portraitFrame)).toEqual({ angle: -0, uvTurns: 0 });
    expect(deviceTurn3d(90, portraitFrame)).toEqual({ angle: -Math.PI / 2, uvTurns: 0 });
    expect(deviceTurn3d(-90, portraitFrame).angle).toBeCloseTo(Math.PI / 2);
  });

  it("lays a body on its side for an upright landscape frame and maps the picture upright", () => {
    const turned = deviceTurn3d(0, { width: 2400, height: 1080 });
    expect(turned.angle).toBeCloseTo(Math.PI / 2);
    expect(turned.uvTurns).toBe(1);
    expect(deviceTurn3d(-90, { width: 2622, height: 1206 }).uvTurns).toBe(1);
    expect(deviceTurn3d(90, { width: 2622, height: 1206 }).uvTurns).toBe(3);
  });
});

describe("createDeviceBody screenPointAt", () => {
  const spec = deviceBodySpec("iPhone", 402 / 874, "iPhone 18 Pro");
  const camera = new PerspectiveCamera(30, 0.6, 0.1, 40);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  it("finds the screen point under a ray from the front and none from behind", () => {
    const body = createDeviceBody(spec, new Texture(), 0);
    const centre = body.screenPointAt(0, 0, camera);
    expect(centre?.s).toBeCloseTo(0.5);
    expect(centre?.t).toBeCloseTo(0.5);
    // Upward in normalized device coordinates is toward the top of the screen.
    expect(body.screenPointAt(0, 0.2, camera)!.t).toBeLessThan(0.5);
    // Off the device entirely.
    expect(body.screenPointAt(0.95, 0, camera)).toBeNull();
    // Turned round, the screen faces away and cannot be touched.
    body.root.quaternion.copy(yaw(Math.PI));
    expect(body.screenPointAt(0, 0, camera)).toBeNull();
    body.dispose();
  });

  it("follows the body's orientation turn", () => {
    const body = createDeviceBody(spec, new Texture(), 0);
    body.orientation.rotation.z = -Math.PI / 2;
    // Turned clockwise, the screen's top edge lies on the right.
    const right = body.screenPointAt(0.3, 0, camera);
    expect(right!.t).toBeLessThan(0.5);
    expect(right!.s).toBeCloseTo(0.5, 1);
    body.dispose();
  });
});

describe("nearestDeviceView", () => {
  it("levels the tilt and keeps the yaw within each view's band", () => {
    const tilted = yaw(0.3).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4));
    const settled = nearestDeviceView(tilted, DEVICE_VIEW_SNAPS)!;
    expect(settled.name).toBe("front");
    expect(settled.rotation.angleTo(yaw(0.3))).toBeLessThan(1e-6);
    expect(nearestDeviceView(yaw(1.5), DEVICE_VIEW_SNAPS)!.name).toBe("left");
    expect(nearestDeviceView(yaw(-1.5), DEVICE_VIEW_SNAPS)!.name).toBe("right");
    expect(nearestDeviceView(yaw(3), DEVICE_VIEW_SNAPS)!.name).toBe("back");
    expect(deviceViewRotation("back").angleTo(yaw(Math.PI))).toBeLessThan(1e-6);
  });
});

describe("deviceWheelNavigation", () => {
  const base = { deltaMode: 0, width: 400, height: 800 };
  it("orbits on a two-finger scroll and zooms on a pinch, in bounded steps", () => {
    expect(deviceWheelNavigation({ ...base, deltaX: -40, deltaY: 80, ctrlKey: false })).toEqual({
      type: "orbit",
      x: 0.1,
      y: -0.1,
    });
    expect(deviceWheelNavigation({ ...base, deltaX: 0, deltaY: -10, ctrlKey: true })).toEqual({
      type: "zoom",
      delta: 0.05,
    });
    // A mouse wheel notch on Ctrl is one bounded step, not a jump.
    expect(deviceWheelNavigation({ ...base, deltaX: 0, deltaY: -100, ctrlKey: true })).toEqual({
      type: "zoom",
      delta: 0.2,
    });
    expect(deviceWheelNavigation({ ...base, deltaX: 0, deltaY: 1, ctrlKey: false, width: 0 })).toBe(
      null,
    );
  });
});

describe("createRenderScheduler", () => {
  it("renders once per frame however often it is asked, and never after disposal", () => {
    const callbacks: FrameRequestCallback[] = [];
    const render = vi.fn();
    const scheduler = createRenderScheduler(
      render,
      (callback) => callbacks.push(callback),
      () => {},
    );
    scheduler.invalidate();
    scheduler.invalidate();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!(0);
    expect(render).toHaveBeenCalledTimes(1);
    scheduler.invalidate();
    scheduler.dispose();
    callbacks.shift()?.(0);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
