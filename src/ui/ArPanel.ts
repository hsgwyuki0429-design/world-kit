/**
 * The game's camera view — video, overlay canvas, HUD and controls — kept across renders (v4 §38–§40).
 *
 * Every other screen rebuilds its DOM twice a second, and that is fine for numbers. It is not
 * fine for a game: a press held across a rebuild would lose its element, and a canvas recreated
 * per tick would flash. So this panel is built once and re-attached, the way `PreviewVideo` keeps
 * one video element, and `update` changes text and classes in place on every display frame.
 *
 * ## The HUD says what the engine says
 *
 * The state badge prints the game's state in the engine's own vocabulary (`READY`, `THROWING`,
 * `TRACKING_LOST`), and the tracking label prints the world's tracking state. Both are read back
 * from the DOM by the composition root and compared with the engine every tick (GAME-002,
 * VIEW-004). The Japanese line under them is guidance, never a state.
 */

import { getPreviewVideo } from './PreviewVideo';
import { el } from './dom';

export interface ArPanelHandlers {
  onPress: () => void;
  onRelease: () => void;
  onRetry: () => void;
  onNewStage: () => void;
  onPauseToggle: () => void;
  onSave: () => void;
  onResume: () => void;
  onToggleSurfaces: () => void;
}

export interface HudModel {
  readonly state: string;
  readonly tracking: string;
  readonly message: string;
  readonly detail: string;
  readonly power: number;
  readonly showPower: boolean;
  readonly surfaces: number;
  readonly confidence: number;
  readonly readyArea: number;
  readonly coverage: number;
  readonly successes: number;
  readonly throws: number;
  readonly difficulty: string;
  readonly paused: boolean;
  readonly canRetry: boolean;
  readonly canNewStage: boolean;
  readonly canSave: boolean;
  readonly canResume: boolean;
  readonly resumeLabel: string;
  readonly surfacesShown: boolean;
  readonly aspect: string;
}

export interface ArPanel {
  readonly root: HTMLElement;
  readonly stack: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /**
   * Put the shared preview video inside this panel. MUST be called in the same task that puts the
   * panel into the document — see `attachVideo` below for the defect that requirement comes from.
   */
  attachVideo(): void;
  update(model: HudModel): void;
  /** What the HUD shows right now, read from the DOM — never from the model it was given. */
  read(): { state: string | null; tracking: string | null };
}

let panel: ArPanel | null = null;
let handlersRef: ArPanelHandlers | null = null;

export function getArPanel(handlers: ArPanelHandlers): ArPanel {
  handlersRef = handlers;
  if (panel) return panel;

  const canvas = el('canvas', { id: 'ar-canvas' });
  const state = el('span', { class: 'ar-badge', id: 'game-state' }, ['SCAN']);
  const tracking = el('span', { class: 'ar-badge ar-tracking', id: 'game-tracking' }, ['TRACKING INITIALIZING']);
  const message = el('div', { class: 'ar-message', id: 'game-message' }, ['']);
  const detail = el('div', { class: 'ar-detail', id: 'game-detail' }, ['']);
  const powerFill = el('div', { class: 'ar-power-fill' });
  const power = el('div', { class: 'ar-power', id: 'game-power' }, [powerFill]);
  const crosshair = el('div', { class: 'ar-crosshair' });

  const stack = el('div', { class: 'overlay-stack ar-stack', id: 'ar-stack' } as never, [
    canvas,
    el('div', { class: 'ar-hud-top' }, [state, tracking]),
    crosshair,
    el('div', { class: 'ar-hud-bottom' }, [message, power]),
  ]);

  const stats = el('div', { class: 'ar-stats', id: 'game-stats' }, ['']);
  const button = (id: string, label: string, on: () => void): HTMLButtonElement =>
    el('button', { class: 'secondary', id, textContent: label, onclick: on } as never);
  const retry = button('game-retry', 'リトライ', () => handlersRef?.onRetry());
  const newStage = button('game-new-stage', '別のステージ', () => handlersRef?.onNewStage());
  const pause = button('game-pause', '一時停止', () => handlersRef?.onPauseToggle());
  const save = button('game-save', '保存', () => handlersRef?.onSave());
  const resume = button('game-resume', '前回の続きから', () => handlersRef?.onResume());
  const toggle = button('game-surfaces', '面の表示: ON', () => handlersRef?.onToggleSurfaces());

  const root = el('div', { class: 'ar-panel', id: 'ar-panel' }, [
    stack,
    detail,
    stats,
    el('div', { class: 'button-row ar-buttons' }, [retry, newStage, pause]),
    el('div', { class: 'button-row ar-buttons' }, [save, resume, toggle]),
  ]);

  // The press: anywhere on the camera view. Released anywhere — including after a rebuild of the
  // screen around the panel, which is why the release listens on the window.
  let pressed = false;
  stack.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressed = true;
    handlersRef?.onPress();
  });
  const release = (): void => {
    if (!pressed) return;
    pressed = false;
    handlersRef?.onRelease();
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  let lastAspect = '';
  /**
   * The video moves into this panel synchronously, in the render that attaches the panel.
   *
   * The first version moved it on the next animation frame. Every earlier screen re-appends the
   * video inside the same render that replaces the old tree, so the element is out of the document
   * for no stable state at all. Deferring the move to `requestAnimationFrame` left it detached
   * across one — and a media element found outside the document at a stable state is **paused**
   * by the browser and stays paused when it is put back. Frame callbacks stopped, the pipeline
   * delivered nothing, and Phase 11 sat at `TRACKING INITIALIZING` after a ladder climb: the spatial
   * leg measured 62 frames completed in 188 s, every one of them before the screen changed.
   */
  const attachVideo = (): void => {
    const video = getPreviewVideo();
    if (video.parentElement !== stack) stack.prepend(video);
    // ...and should anything else ever detach it across a stable state, start it again rather
    // than leave a paused preview feeding a pipeline that measures nothing.
    if (video.srcObject && video.paused) void video.play().catch(() => undefined);
  };
  panel = {
    root,
    stack,
    canvas,
    attachVideo,
    update(m: HudModel): void {
      if (m.aspect !== lastAspect) {
        lastAspect = m.aspect;
        stack.style.aspectRatio = m.aspect;
      }
      attachVideo();
      setText(state, m.state);
      state.className = `ar-badge state-${m.state}`;
      setText(tracking, `TRACKING ${m.tracking}`);
      tracking.className = `ar-badge ar-tracking tracking-${m.tracking}`;
      setText(message, m.message);
      setText(detail, m.detail);
      power.style.visibility = m.showPower ? 'visible' : 'hidden';
      powerFill.style.width = `${Math.round(Math.max(0, Math.min(1, m.power)) * 100)}%`;
      setText(
        stats,
        `SURFACES ${m.surfaces} · CONFIDENCE ${m.confidence.toFixed(2)} · READY AREA ${m.readyArea.toFixed(2)} · ` +
          `COVERAGE ${m.coverage} · SCORE ${m.successes}/${m.throws}${m.difficulty ? ` · ${m.difficulty}` : ''}`,
      );
      retry.disabled = !m.canRetry;
      newStage.disabled = !m.canNewStage;
      setText(pause, m.paused ? '再開' : '一時停止');
      save.disabled = !m.canSave;
      resume.disabled = !m.canResume;
      setText(resume, m.resumeLabel);
      setText(toggle, `面の表示: ${m.surfacesShown ? 'ON' : 'OFF'}`);
    },
    read() {
      const s = document.getElementById('game-state');
      const t = document.getElementById('game-tracking');
      return { state: s ? s.textContent : null, tracking: t ? t.textContent : null };
    },
  };
  return panel;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}
