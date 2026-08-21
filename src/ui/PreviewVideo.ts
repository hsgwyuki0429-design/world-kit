/**
 * The single camera preview element, shared by every screen that shows one.
 *
 * There is exactly one, and it is kept across renders. Re-creating it would tear down and
 * re-attach the stream on every state change, which restarts frame delivery — that would
 * corrupt CAM-003's continuity measurement in Phase 1 and FRAME-001's in Phase 2, both of
 * which measure exactly the thing a re-attach interrupts.
 *
 * Extracted from `Phase1Screen` when Phase 2 needed the same element: two screens each
 * owning "the" preview would be two preview elements, and the second one to render would
 * silently be showing nothing.
 */

let videoEl: HTMLVideoElement | null = null;

export function getPreviewVideo(): HTMLVideoElement {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'camera-preview';
    // All three are required for an inline preview on iOS; without playsInline the stream
    // takes over the screen in a native player.
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('muted', '');
  }
  return videoEl;
}

/** True when an image is actually on screen — read from the DOM, not from intent. */
export function isPreviewPresented(): boolean {
  const v = document.getElementById('camera-preview') as HTMLVideoElement | null;
  if (!v || !v.isConnected) return false;
  return v.videoWidth > 0 && v.videoHeight > 0 && !!v.srcObject;
}
