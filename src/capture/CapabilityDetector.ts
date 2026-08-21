/**
 * Capability Detector — Phase 0's whole reason to exist (Rule 003, §7, §8).
 *
 * Every entry in the matrix is produced by running against the live platform. Where a
 * behavioural probe is possible it is used (instantiate the wasm, round-trip the worker,
 * read the pixel back, ask the GPU adapter for a device). Where only a symbol can be
 * inspected the record says `PRESENCE_CHECK`. Where the answer comes from the UA string
 * it says `INFERENCE`, and such records are barred from backing a phase pass.
 *
 * This module deliberately does NOT call getUserMedia. Opening the camera is Phase 1;
 * doing it here would make the capability matrix depend on a permission dialog.
 */

import { CapabilityState, DetectionMethod } from '../core/types';
import type { CapabilityMatrix, CapabilityRecord, DeviceInfo } from '../core/types';
import { runProbe, presence, functional, round2, withTimeout } from './probeKit';
import type { ProbeDefinition, ProbeOutcome } from './probeKit';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 41-byte WebAssembly module, hand-assembled:
 *   (module (func (export "add") (param i32 i32) (result i32)
 *     local.get 0  local.get 1  i32.add))
 *
 * Instantiated and *called* so the probe proves compilation and execution, not the
 * existence of the `WebAssembly` namespace.
 */
export const WASM_ADD_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // type: (i32,i32)->i32
  0x03, 0x02, 0x01, 0x00, // func: one function of type 0
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, // export "add"
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // code
]);

const WORKER_ECHO_SRC = `
self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.kind === 'ping') {
    self.postMessage({ kind: 'pong', token: msg.token });
    return;
  }
  if (msg && msg.kind === 'offscreen') {
    try {
      const canvas = msg.canvas;
      const ctx = canvas.getContext('2d');
      if (!ctx) { self.postMessage({ kind: 'offscreen-result', ok: false, reason: 'no 2d context in worker' }); return; }
      ctx.fillStyle = 'rgb(10, 20, 30)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(1, 1, 1, 1).data;
      self.postMessage({ kind: 'offscreen-result', ok: true, pixel: [px[0], px[1], px[2], px[3]] });
    } catch (err) {
      self.postMessage({ kind: 'offscreen-result', ok: false, reason: String(err) });
    }
  }
};
`;

/* -------------------------------------------------------------------------- */
/* Device info                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * OS/browser naming from the UA string is a guess and is labelled as one everywhere it
 * surfaces. `maxTouchPoints` is carried alongside because iPadOS reports a desktop UA,
 * so the UA alone cannot tell an iPad from a Mac.
 */
export function collectDeviceInfo(): DeviceInfo {
  const ua = navigator.userAgent;
  const maxTouchPoints = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;

  const isIPhoneUA = /iPhone|iPod/.test(ua);
  const isIPadUA = /iPad/.test(ua);
  // iPadOS 13+ sends a Macintosh UA; touch points are the only in-band discriminator.
  const isIPadDesktopUA = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const isLikelyIOS = isIPhoneUA || isIPadUA || isIPadDesktopUA;

  const isWebKit = /AppleWebKit/.test(ua);
  const isChromiumFamily = /Chrome|Chromium|CriOS|EdgiOS|FxiOS|OPR/.test(ua);
  const browserGuess = isChromiumFamily
    ? 'Chromium-family (or an iOS browser using WebKit under a different brand)'
    : isWebKit
      ? 'Safari / WebKit'
      : 'unknown';

  const versionMatch = /OS (\d+)[._](\d+)/.exec(ua);
  const osGuess = isLikelyIOS
    ? `iOS/iPadOS ${versionMatch ? `${versionMatch[1]}.${versionMatch[2]}` : 'version unknown'}`
    : /Android/.test(ua)
      ? 'Android'
      : /Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown';

  let timezone = 'unknown';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown';
  } catch {
    timezone = 'unavailable';
  }

  return {
    userAgent: ua,
    platformHint: typeof navigator.platform === 'string' ? navigator.platform : 'unknown',
    osGuess,
    browserGuess,
    isLikelyIOS,
    maxTouchPoints,
    screenWidth: screen.width,
    screenHeight: screen.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency:
      typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : -1,
    languages: Array.isArray(navigator.languages) ? [...navigator.languages] : [],
    timezone,
  };
}

/* -------------------------------------------------------------------------- */
/* Individual probes                                                            */
/* -------------------------------------------------------------------------- */

function probeSecureContext(): ProbeOutcome {
  const secure = window.isSecureContext === true;
  return {
    state: secure ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    method: DetectionMethod.FUNCTIONAL_PROBE,
    detail: secure
      ? `secure context over ${location.protocol}//${location.host}`
      : `NOT a secure context (${location.protocol}//${location.host}) — getUserMedia and ` +
        'DeviceMotion are unavailable here regardless of platform support',
    data: {
      isSecureContext: secure,
      protocol: location.protocol,
      host: location.host,
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : null,
    },
  };
}

function probeGetUserMedia(): ProbeOutcome {
  const md = navigator.mediaDevices as MediaDevices | undefined;
  const hasMediaDevices = typeof md === 'object' && md !== null;
  const hasGum = hasMediaDevices && typeof md.getUserMedia === 'function';
  const secure = window.isSecureContext === true;

  if (!hasGum) {
    return presence(false, 'navigator.mediaDevices.getUserMedia is not a function', {
      hasMediaDevices,
      hasGetUserMedia: hasGum,
      legacyGetUserMedia:
        typeof (navigator as unknown as { getUserMedia?: unknown }).getUserMedia === 'function',
    });
  }
  if (!secure) {
    return {
      state: CapabilityState.UNAVAILABLE,
      method: DetectionMethod.PRESENCE_CHECK,
      detail: 'getUserMedia exists but the page is not a secure context, so it cannot succeed',
      data: { hasMediaDevices, hasGetUserMedia: true, secureContext: false },
    };
  }
  return {
    state: CapabilityState.AVAILABLE,
    method: DetectionMethod.PRESENCE_CHECK,
    detail:
      'getUserMedia is present in a secure context. Not invoked in Phase 0 — opening the ' +
      'camera is Phase 1 (CAM-001), and probing it here would trigger a permission prompt',
    data: { hasMediaDevices, hasGetUserMedia: true, secureContext: true },
  };
}

async function probeEnumerateDevices(): Promise<ProbeOutcome> {
  const md = navigator.mediaDevices;
  if (!md || typeof md.enumerateDevices !== 'function') {
    return presence(false, 'navigator.mediaDevices.enumerateDevices is not a function');
  }
  const devices = await md.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  const labelsHidden = videoInputs.every((d) => d.label === '');
  const deviceIdsHidden = videoInputs.every((d) => d.deviceId === '');
  return functional(
    videoInputs.length > 0 ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    videoInputs.length > 0
      ? `${videoInputs.length} videoinput device(s) enumerated` +
          (labelsHidden ? ' (labels hidden until camera permission is granted — expected)' : '')
      : 'no videoinput devices enumerated; on some browsers the list stays empty until ' +
          'camera permission is granted, so this is not conclusive before Phase 1',
    {
      videoInputCount: videoInputs.length,
      audioInputCount: devices.filter((d) => d.kind === 'audioinput').length,
      totalDevices: devices.length,
      labelsHidden,
      deviceIdsHidden,
    },
  );
}

function probeSupportedConstraints(): ProbeOutcome {
  const md = navigator.mediaDevices;
  if (!md || typeof md.getSupportedConstraints !== 'function') {
    return presence(false, 'getSupportedConstraints is not a function');
  }
  const sc = md.getSupportedConstraints() as Record<string, boolean>;
  const keys = Object.keys(sc).filter((k) => sc[k]);
  // These are the constraints Phase 1 and Phase 2 actually depend on.
  const needed = ['facingMode', 'width', 'height', 'frameRate', 'aspectRatio', 'deviceId'];
  const missing = needed.filter((k) => !sc[k]);
  return functional(
    missing.length === 0 ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    missing.length === 0
      ? `all constraints required by Phase 1/2 are supported (${needed.join(', ')})`
      : `missing required constraints: ${missing.join(', ')}`,
    {
      supportedCount: keys.length,
      facingMode: sc['facingMode'] === true,
      width: sc['width'] === true,
      height: sc['height'] === true,
      frameRate: sc['frameRate'] === true,
      aspectRatio: sc['aspectRatio'] === true,
      deviceId: sc['deviceId'] === true,
      missing,
    },
  );
}

function probeTrackControl(): ProbeOutcome {
  const proto =
    typeof MediaStreamTrack !== 'undefined'
      ? (MediaStreamTrack.prototype as unknown as Record<string, unknown>)
      : undefined;
  if (!proto) return presence(false, 'MediaStreamTrack is undefined');
  const hasCaps = typeof proto['getCapabilities'] === 'function';
  const hasSettings = typeof proto['getSettings'] === 'function';
  const hasApply = typeof proto['applyConstraints'] === 'function';
  const all = hasCaps && hasSettings && hasApply;
  return presence(
    all,
    all
      ? 'getCapabilities / getSettings / applyConstraints all present — Phase 2 can negotiate ' +
          'resolution and frame rate at runtime'
      : 'track introspection is incomplete; Phase 2 resolution adaptation will be limited',
    { getCapabilities: hasCaps, getSettings: hasSettings, applyConstraints: hasApply },
  );
}

async function probeWebAssembly(): Promise<ProbeOutcome> {
  if (typeof WebAssembly !== 'object' || WebAssembly === null) {
    return presence(false, 'WebAssembly namespace is absent');
  }
  const { instance } = await WebAssembly.instantiate(WASM_ADD_MODULE as BufferSource, {});
  const add = instance.exports['add'] as ((a: number, b: number) => number) | undefined;
  if (typeof add !== 'function') {
    return functional(CapabilityState.ERROR, 'module instantiated but export "add" is missing');
  }
  const result = add(2, 3);
  const ok = result === 5;
  return functional(
    ok ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    ok
      ? 'compiled and executed a real 41-byte module: add(2,3) === 5'
      : `module executed but returned ${result}, expected 5`,
    {
      moduleBytes: WASM_ADD_MODULE.length,
      addResult: result,
      hasInstantiateStreaming: typeof WebAssembly.instantiateStreaming === 'function',
      hasMemory: typeof WebAssembly.Memory === 'function',
    },
  );
}

function makeWorker(source: string): { worker: Worker; dispose: () => void } {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return {
    worker,
    dispose: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

async function probeWorker(): Promise<ProbeOutcome> {
  if (typeof Worker !== 'function') return presence(false, 'Worker constructor is absent');
  const token = `probe-${Date.now().toString(36)}`;
  const { worker, dispose } = makeWorker(WORKER_ECHO_SRC);
  try {
    const started = performance.now();
    const echoed = await withTimeout(
      new Promise<string>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          const d = e.data as { kind?: string; token?: string };
          if (d?.kind === 'pong') resolve(String(d.token));
        };
        worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || 'worker error'));
        worker.postMessage({ kind: 'ping', token });
      }),
      3000,
      'worker round-trip',
    );
    const rtt = round2(performance.now() - started);
    const ok = echoed === token;
    return functional(
      ok ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
      ok
        ? `blob worker round-trip succeeded in ${rtt} ms`
        : `worker replied with "${echoed}", expected "${token}"`,
      { roundTripMs: rtt, tokenMatched: ok },
    );
  } finally {
    dispose();
  }
}

function probeOffscreenCanvas(): ProbeOutcome {
  if (typeof OffscreenCanvas !== 'function') {
    return presence(false, 'OffscreenCanvas constructor is absent');
  }
  const canvas = new OffscreenCanvas(4, 4);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return functional(CapabilityState.UNAVAILABLE, 'OffscreenCanvas has no 2d context');
  ctx.fillStyle = 'rgb(10, 20, 30)';
  ctx.fillRect(0, 0, 4, 4);
  const px = ctx.getImageData(1, 1, 1, 1).data;
  const pixel = [px[0] ?? -1, px[1] ?? -1, px[2] ?? -1, px[3] ?? -1];
  const exact = pixel[0] === 10 && pixel[1] === 20 && pixel[2] === 30 && pixel[3] === 255;
  return functional(
    exact ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    exact
      ? 'drew and read back an exact pixel [10,20,30,255] from an OffscreenCanvas'
      : `pixel readback drifted: got [${pixel.join(',')}], expected [10,20,30,255]`,
    { pixel, exact },
  );
}

function probeTransferControlToOffscreen(): ProbeOutcome {
  const el = document.createElement('canvas');
  const fn = (el as unknown as { transferControlToOffscreen?: unknown })
    .transferControlToOffscreen;
  if (typeof fn !== 'function') {
    return presence(false, 'HTMLCanvasElement.transferControlToOffscreen is absent');
  }
  el.width = 4;
  el.height = 4;
  const off = el.transferControlToOffscreen();
  return functional(
    off instanceof OffscreenCanvas ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    'transferControlToOffscreen returned a live OffscreenCanvas',
    { width: off.width, height: off.height },
  );
}

/** The combination that Phase 2 actually needs: canvas work happening off the UI thread. */
async function probeOffscreenInWorker(): Promise<ProbeOutcome> {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') {
    return presence(false, 'Worker and/or OffscreenCanvas absent, so the transfer path cannot exist');
  }
  const { worker, dispose } = makeWorker(WORKER_ECHO_SRC);
  try {
    const canvas = new OffscreenCanvas(4, 4);
    const result = await withTimeout(
      new Promise<{ ok: boolean; pixel?: number[]; reason?: string }>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent) => {
          const d = e.data as { kind?: string; ok?: boolean; pixel?: number[]; reason?: string };
          if (d?.kind === 'offscreen-result') {
            resolve({ ok: d.ok === true, ...(d.pixel ? { pixel: d.pixel } : {}), ...(d.reason ? { reason: d.reason } : {}) });
          }
        };
        worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || 'worker error'));
        worker.postMessage({ kind: 'offscreen', canvas }, [canvas as unknown as Transferable]);
      }),
      3000,
      'offscreen transfer to worker',
    );
    const p = result.pixel;
    const exact = !!p && p[0] === 10 && p[1] === 20 && p[2] === 30 && p[3] === 255;
    return functional(
      result.ok && exact ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
      result.ok && exact
        ? 'transferred an OffscreenCanvas into a worker, drew there and read back the exact pixel'
        : `worker-side canvas failed: ${result.reason ?? `pixel [${p?.join(',') ?? 'none'}]`}`,
      { ok: result.ok, pixel: p ?? null, exact },
    );
  } finally {
    dispose();
  }
}

function probeSharedArrayBuffer(): ProbeOutcome {
  const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
  if (typeof SharedArrayBuffer !== 'function') {
    return presence(
      false,
      'SharedArrayBuffer is absent — requires COOP+COEP headers, which static hosting ' +
        'such as GitHub Pages cannot set. WASM threads must not be assumed.',
      { crossOriginIsolated: isolated },
    );
  }
  const sab = new SharedArrayBuffer(8);
  return functional(
    sab.byteLength === 8 ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    `allocated a real SharedArrayBuffer (crossOriginIsolated=${isolated})`,
    { byteLength: sab.byteLength, crossOriginIsolated: isolated },
  );
}

function probeWebGL2(): ProbeOutcome {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (!gl) return functional(CapabilityState.UNAVAILABLE, 'getContext("webgl2") returned null');

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const vendor = dbg
    ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    : String(gl.getParameter(gl.VENDOR));
  const maxTexture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const exts = gl.getSupportedExtensions() ?? [];
  const out = functional(CapabilityState.AVAILABLE, `WebGL2 context created on ${renderer}`, {
    renderer,
    vendor,
    rendererMasked: !dbg,
    maxTextureSize: maxTexture,
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
    // Needed if image pyramids are ever built in float textures on the GL fallback path.
    colorBufferFloat: exts.includes('EXT_color_buffer_float'),
    textureFloatLinear: exts.includes('OES_texture_float_linear'),
    extensionCount: exts.length,
  });
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return out;
}

async function probeWebGPU(): Promise<ProbeOutcome> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return functional(
      CapabilityState.UNAVAILABLE,
      'navigator.gpu is absent — the WebGL2/CPU fallback path will be used',
      { hasNavigatorGpu: false },
    );
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    return functional(
      CapabilityState.UNAVAILABLE,
      'navigator.gpu exists but requestAdapter() returned null — no usable adapter',
      { hasNavigatorGpu: true, adapter: null },
    );
  }
  const info = (adapter as unknown as { info?: Record<string, string> }).info;
  const device = await adapter.requestDevice();
  const limits = device.limits;
  const out = functional(
    CapabilityState.AVAILABLE,
    'requestAdapter() and requestDevice() both succeeded — a real GPU device was created',
    {
      vendor: info?.['vendor'] ?? 'unreported',
      architecture: info?.['architecture'] ?? 'unreported',
      device: info?.['device'] ?? 'unreported',
      description: info?.['description'] ?? 'unreported',
      features: Array.from(adapter.features ?? []).map(String),
      maxTextureDimension2D: limits.maxTextureDimension2D,
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxBufferSize: limits.maxBufferSize,
    },
  );
  // Release it: Phase 0 only needed to learn that a device can be created.
  device.destroy();
  return out;
}

async function probeCreateImageBitmap(): Promise<ProbeOutcome> {
  if (typeof createImageBitmap !== 'function') {
    return presence(false, 'createImageBitmap is absent');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  if (!ctx) return functional(CapabilityState.ERROR, 'could not obtain a 2d context for the source');
  ctx.fillStyle = 'rgb(10, 20, 30)';
  ctx.fillRect(0, 0, 4, 4);
  const bmp = await createImageBitmap(canvas);
  const ok = bmp.width === 4 && bmp.height === 4;
  bmp.close();
  return functional(
    ok ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    ok ? 'created a real 4x4 ImageBitmap from a canvas' : 'ImageBitmap had unexpected dimensions',
    { width: 4, height: 4 },
  );
}

/** The declared fallback for CAP-0008 if OffscreenCanvas is missing. */
function probeCanvas2dReadback(): ProbeOutcome {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return functional(CapabilityState.UNAVAILABLE, 'no main-thread 2d context');
  ctx.fillStyle = 'rgb(10, 20, 30)';
  ctx.fillRect(0, 0, 4, 4);
  const px = ctx.getImageData(1, 1, 1, 1).data;
  const pixel = [px[0] ?? -1, px[1] ?? -1, px[2] ?? -1, px[3] ?? -1];
  const exact = pixel[0] === 10 && pixel[1] === 20 && pixel[2] === 30 && pixel[3] === 255;
  return functional(
    exact ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    exact
      ? 'main-thread canvas readback is byte-exact [10,20,30,255]'
      : `main-thread readback drifted: [${pixel.join(',')}]`,
    { pixel, exact },
  );
}

function probeImageCapture(): ProbeOutcome {
  const present = typeof (window as unknown as { ImageCapture?: unknown }).ImageCapture === 'function';
  return presence(
    present,
    present
      ? 'ImageCapture is present'
      : 'ImageCapture is absent (expected on WebKit) — frames must come from <video> plus ' +
          'VideoFrame/createImageBitmap/drawImage instead',
  );
}

function probeWebCodecs(): ProbeOutcome {
  const w = window as unknown as Record<string, unknown>;
  const hasVideoFrame = typeof w['VideoFrame'] === 'function';
  const hasDecoder = typeof w['VideoDecoder'] === 'function';
  const hasEncoder = typeof w['VideoEncoder'] === 'function';
  return presence(
    hasVideoFrame,
    hasVideoFrame
      ? 'VideoFrame is present — Phase 2 can pull frames without a canvas round-trip'
      : 'VideoFrame is absent; Phase 2 will fall back to createImageBitmap/drawImage',
    { VideoFrame: hasVideoFrame, VideoDecoder: hasDecoder, VideoEncoder: hasEncoder },
  );
}

function probeVideoFrameCallback(): ProbeOutcome {
  const proto =
    typeof HTMLVideoElement !== 'undefined'
      ? (HTMLVideoElement.prototype as unknown as Record<string, unknown>)
      : undefined;
  const has = !!proto && typeof proto['requestVideoFrameCallback'] === 'function';
  return presence(
    has,
    has
      ? 'requestVideoFrameCallback is present — frame scheduling can be driven by real ' +
          'decoded frames rather than by rAF guessing'
      : 'requestVideoFrameCallback is absent; the frame scheduler falls back to rAF plus ' +
          'currentTime change detection',
    {
      playsInline: !!proto && 'playsInline' in proto,
    },
  );
}

async function probeStorageEstimate(): Promise<ProbeOutcome> {
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage || typeof storage.estimate !== 'function') {
    return presence(false, 'navigator.storage.estimate is absent — save quota is unknown');
  }
  const est = await storage.estimate();
  return functional(
    CapabilityState.AVAILABLE,
    `storage quota reported by the platform: ${formatBytes(est.quota)} (used ${formatBytes(est.usage)})`,
    { quotaBytes: est.quota ?? null, usageBytes: est.usage ?? null },
  );
}

function probeLocalStorage(): ProbeOutcome {
  const key = '__ssm_probe__';
  try {
    localStorage.setItem(key, 'v');
    const readBack = localStorage.getItem(key);
    localStorage.removeItem(key);
    return functional(
      readBack === 'v' ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
      readBack === 'v' ? 'wrote, read and removed a real localStorage key' : 'read-back mismatch',
    );
  } catch (err) {
    // Private browsing and blocked-storage modes throw here. That is a real UNAVAILABLE,
    // and it matters because Phase 14 save/load has to cope with it.
    return functional(CapabilityState.UNAVAILABLE, `localStorage threw: ${String(err)}`);
  }
}

async function probeIndexedDB(): Promise<ProbeOutcome> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return presence(false, 'indexedDB is absent');
  }
  const dbName = '__ssm_probe_db__';
  const opened = await withTimeout(
    new Promise<boolean>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('probe');
      req.onsuccess = () => {
        req.result.close();
        resolve(true);
      };
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB open blocked'));
    }),
    2500,
    'indexedDB open',
  );
  indexedDB.deleteDatabase(dbName);
  return functional(
    opened ? CapabilityState.AVAILABLE : CapabilityState.ERROR,
    'opened and deleted a real IndexedDB database — Phase 14 can persist worlds here',
  );
}

function probePerformanceMemory(): ProbeOutcome {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const has = typeof mem === 'object' && mem !== null && typeof mem.usedJSHeapSize === 'number';
  return presence(
    has,
    has
      ? 'performance.memory is present; heap numbers in the debug HUD will be real'
      : 'performance.memory is absent (expected on WebKit) — the debug HUD must show ' +
          'MEMORY: UNAVAILABLE rather than a fabricated figure',
    { deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null },
  );
}

/* --- spatial group: the honesty probes ------------------------------------ */

async function probeWebXR(): Promise<ProbeOutcome> {
  const xr = (navigator as unknown as { xr?: XRSystem }).xr;
  if (!xr || typeof xr.isSessionSupported !== 'function') {
    return functional(
      CapabilityState.UNAVAILABLE,
      'navigator.xr is absent — WebXR is the only standards-track route to device depth ' +
        'or AR pose from a browser, so neither is reachable here',
      { hasNavigatorXr: false },
    );
  }
  const ar = await xr.isSessionSupported('immersive-ar').catch(() => false);
  const vr = await xr.isSessionSupported('immersive-vr').catch(() => false);
  return functional(
    ar || vr ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    `WebXR present; immersive-ar=${ar}, immersive-vr=${vr}`,
    { hasNavigatorXr: true, immersiveAR: ar, immersiveVR: vr },
  );
}

function probeNativeBridge(): ProbeOutcome {
  // A WKWebView host app would expose handlers here. Mobile Safari does not.
  const webkit = (window as unknown as { webkit?: { messageHandlers?: Record<string, unknown> } })
    .webkit;
  const handlers = webkit?.messageHandlers;
  const names = handlers ? Object.keys(handlers) : [];
  return functional(
    names.length > 0 ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    names.length > 0
      ? `a native message bridge is present with handlers: ${names.join(', ')}`
      : 'no window.webkit.messageHandlers bridge — the page is not hosted by a native app, ' +
        'so no native iOS framework can be reached from JavaScript',
    { handlerNames: names },
  );
}

function probeCameraDepth(webxrAvailable: boolean): ProbeOutcome {
  const sc =
    navigator.mediaDevices && typeof navigator.mediaDevices.getSupportedConstraints === 'function'
      ? (navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>)
      : {};
  // No standard depth constraint exists; scan for any vendor-prefixed depth key rather
  // than assuming absence.
  const depthishKeys = Object.keys(sc).filter((k) => /depth|disparity|lidar/i.test(k));
  const available = depthishKeys.length > 0;
  return functional(
    available ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    available
      ? `depth-related media constraints found: ${depthishKeys.join(', ')}`
      : 'no depth-related media constraint and no WebXR depth-sensing route ' +
        `(webxr=${webxrAvailable}) — DEPTH: UNAVAILABLE. Any depth used later must be ` +
        'labelled MONOCULAR ESTIMATE and never presented as native depth (§44)',
    { depthConstraintKeys: depthishKeys, webxrAvailable },
  );
}

function probeNativeFramework(name: string, bridgePresent: boolean): ProbeOutcome {
  return functional(
    CapabilityState.UNAVAILABLE,
    `${name} has no JavaScript API. Probed for the only possible surface — a native ` +
      `message bridge — and found ${bridgePresent ? 'a bridge without ' + name + ' handlers' : 'none'}. ` +
      `${name}: UNAVAILABLE`,
    { nativeBridgePresent: bridgePresent },
  );
}

function probeMetricScale(): ProbeOutcome {
  return {
    state: CapabilityState.UNKNOWN,
    method: DetectionMethod.NOT_ATTEMPTED,
    detail:
      'A monocular camera provides no absolute scale (§18, §90). No depth sensor, WebXR ' +
      'session or native bridge is reachable to supply one, so the world will be built in ' +
      'LOCAL UNITS and SCALE stays UNKNOWN until something actually measures it.',
    data: { scaleStatus: 'UNKNOWN', units: 'LOCAL_UNITS' },
  };
}

function probeIOSInference(info: DeviceInfo): ProbeOutcome {
  return {
    state: info.isLikelyIOS ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    method: DetectionMethod.INFERENCE,
    detail:
      'Guessed from the user-agent string. UA sniffing is not a measurement — iPadOS ' +
      'reports a Macintosh UA and any UA can be overridden. This record is barred from ' +
      'backing a phase pass criterion.',
    data: {
      osGuess: info.osGuess,
      browserGuess: info.browserGuess,
      maxTouchPoints: info.maxTouchPoints,
    },
  };
}

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/* -------------------------------------------------------------------------- */
/* Detector                                                                     */
/* -------------------------------------------------------------------------- */

export class CapabilityDetector {
  private records = new Map<string, CapabilityRecord>();
  private startedAt = 0;
  private completedAt = 0;

  /**
   * Run every probe that does not require a user gesture.
   *
   * Motion and orientation are excluded on purpose: `DeviceMotionEvent.requestPermission`
   * throws outside a user gesture on iOS, so calling it here would manufacture a failure.
   * They are seeded as PERMISSION_REQUIRED / NOT_ATTEMPTED and filled in by
   * `MotionCapabilityProbe` when the user taps.
   */
  async detectAll(): Promise<CapabilityMatrix> {
    this.startedAt = Date.now();
    const info = collectDeviceInfo();

    // Sequential rather than parallel: concurrent GPU/worker/canvas probes would
    // contend and make the per-probe durations meaningless, and those durations are
    // part of the evidence.
    const ordered: ProbeDefinition[] = [
      { id: 'platform.secureContext', group: 'platform', label: 'Secure context (HTTPS)', run: probeSecureContext },
      { id: 'platform.iosSafariGuess', group: 'platform', label: 'iOS/Safari (UA guess)', run: () => probeIOSInference(info) },
      { id: 'camera.getUserMedia', group: 'camera', label: 'getUserMedia', run: probeGetUserMedia },
      { id: 'camera.enumerateDevices', group: 'camera', label: 'Video input devices', run: probeEnumerateDevices },
      { id: 'camera.supportedConstraints', group: 'camera', label: 'Media constraints', run: probeSupportedConstraints },
      { id: 'camera.trackControl', group: 'camera', label: 'Track capability control', run: probeTrackControl },
      { id: 'compute.webassembly', group: 'compute', label: 'WebAssembly (executed)', run: probeWebAssembly },
      { id: 'compute.worker', group: 'compute', label: 'Web Worker round-trip', run: probeWorker },
      { id: 'compute.offscreenCanvas', group: 'compute', label: 'OffscreenCanvas', run: probeOffscreenCanvas },
      { id: 'compute.transferControlToOffscreen', group: 'compute', label: 'Canvas -> Offscreen transfer', run: probeTransferControlToOffscreen },
      { id: 'compute.offscreenInWorker', group: 'compute', label: 'OffscreenCanvas inside worker', run: probeOffscreenInWorker },
      { id: 'compute.sharedArrayBuffer', group: 'compute', label: 'SharedArrayBuffer', run: probeSharedArrayBuffer },
      { id: 'graphics.webgl2', group: 'graphics', label: 'WebGL2', run: probeWebGL2 },
      { id: 'graphics.webgpu', group: 'graphics', label: 'WebGPU', run: probeWebGPU, timeoutMs: 8000 },
      { id: 'graphics.createImageBitmap', group: 'graphics', label: 'createImageBitmap', run: probeCreateImageBitmap },
      { id: 'graphics.canvas2dReadback', group: 'graphics', label: 'Canvas 2D readback', run: probeCanvas2dReadback },
      { id: 'media.imageCapture', group: 'media', label: 'ImageCapture', run: probeImageCapture },
      { id: 'media.webcodecs', group: 'media', label: 'WebCodecs VideoFrame', run: probeWebCodecs },
      { id: 'media.videoFrameCallback', group: 'media', label: 'requestVideoFrameCallback', run: probeVideoFrameCallback },
      { id: 'storage.estimate', group: 'storage', label: 'Storage quota', run: probeStorageEstimate },
      { id: 'storage.localStorage', group: 'storage', label: 'localStorage', run: probeLocalStorage },
      { id: 'storage.indexedDB', group: 'storage', label: 'IndexedDB', run: probeIndexedDB },
      { id: 'storage.performanceMemory', group: 'storage', label: 'JS heap metrics', run: probePerformanceMemory },
      { id: 'spatial.webxr', group: 'spatial', label: 'WebXR', run: probeWebXR, timeoutMs: 5000 },
      { id: 'spatial.nativeBridge', group: 'spatial', label: 'Native app bridge', run: probeNativeBridge },
    ];

    for (const def of ordered) {
      const record = await runProbe(def);
      this.records.set(record.id, record);
    }

    // These depend on results above, so they are derived after the sweep rather than
    // asserted up front.
    const webxrAvailable = this.records.get('spatial.webxr')?.state === CapabilityState.AVAILABLE;
    const bridgePresent =
      this.records.get('spatial.nativeBridge')?.state === CapabilityState.AVAILABLE;

    const derived: ProbeDefinition[] = [
      { id: 'spatial.cameraDepth', group: 'spatial', label: 'Camera depth', run: () => probeCameraDepth(webxrAvailable) },
      { id: 'spatial.arkit', group: 'spatial', label: 'Native ARKit', run: () => probeNativeFramework('ARKit', bridgePresent) },
      { id: 'spatial.roomplan', group: 'spatial', label: 'RoomPlan', run: () => probeNativeFramework('RoomPlan', bridgePresent) },
      { id: 'spatial.metricScale', group: 'spatial', label: 'Metric scale', run: probeMetricScale },
    ];
    for (const def of derived) {
      const record = await runProbe(def);
      this.records.set(record.id, record);
    }

    // Gesture-gated entries, seeded honestly so the matrix is never missing a row.
    this.seedGestureGated();

    this.completedAt = Date.now();
    return this.getMatrix();
  }

  private seedGestureGated(): void {
    const needsPermission = (ctor: unknown): boolean =>
      typeof ctor === 'function' &&
      typeof (ctor as { requestPermission?: unknown }).requestPermission === 'function';

    const motionCtor = (window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent;
    const orientationCtor = (window as unknown as { DeviceOrientationEvent?: unknown })
      .DeviceOrientationEvent;

    const seed = (id: string, label: string, ctor: unknown, eventName: string): void => {
      if (typeof ctor !== 'function') {
        this.records.set(id, {
          id,
          group: 'motion',
          label,
          state: CapabilityState.UNAVAILABLE,
          method: DetectionMethod.PRESENCE_CHECK,
          detail: `${eventName} constructor is absent on this platform`,
          data: {},
          durationMs: 0,
          timestamp: Date.now(),
        });
        return;
      }
      const gated = needsPermission(ctor);
      this.records.set(id, {
        id,
        group: 'motion',
        label,
        state: gated ? CapabilityState.PERMISSION_REQUIRED : CapabilityState.UNKNOWN,
        method: DetectionMethod.NOT_ATTEMPTED,
        detail: gated
          ? `${eventName} requires requestPermission() from inside a user gesture (iOS 13+). ` +
            'Not attempted automatically — tap the sensor probe button.'
          : `${eventName} exists and needs no permission gate, but no events have been ` +
            'observed yet. Capability is UNKNOWN until real sensor data arrives.',
        data: { requiresPermission: gated },
        durationMs: 0,
        timestamp: Date.now(),
      });
    };

    seed('motion.deviceMotion', 'DeviceMotion', motionCtor, 'DeviceMotionEvent');
    seed('motion.deviceOrientation', 'DeviceOrientation', orientationCtor, 'DeviceOrientationEvent');
  }

  /** Replace a record after a gesture-gated probe has actually run. */
  upsert(record: CapabilityRecord): void {
    this.records.set(record.id, record);
    this.completedAt = Date.now();
  }

  get(id: string): CapabilityRecord | undefined {
    return this.records.get(id);
  }

  getMatrix(): CapabilityMatrix {
    const records = [...this.records.values()];
    return {
      records,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      // Sum of measured probe durations, not wall clock: wall clock would silently
      // include the time a user spent looking at the screen before tapping.
      totalDurationMs: round2(records.reduce((acc, r) => acc + r.durationMs, 0)),
    };
  }
}
