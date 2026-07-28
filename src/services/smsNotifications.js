// Renderer-side SMS notification helpers.
//
// Native notification display stays behind the preload bridge. The sound is
// intentionally a local asset so inbound SMS alerts do not depend on a
// network request or expose any Electron APIs to the renderer.

const SOUND_URL = `${process.env.PUBLIC_URL || '.'}/notification.wav`;

export function playInboundSmsSound() {
  if (typeof Audio === 'undefined') return;
  try {
    const audio = new Audio(SOUND_URL);
    audio.volume = 0.55;
    const result = audio.play();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        // Browsers may reject playback before the first user gesture.
      });
    }
  } catch (_) {
    // A notification should never break SMS polling if audio is unavailable.
  }
}

export function notifyInboundSms(message) {
  playInboundSmsSound();

  const operator =
    typeof window !== 'undefined' && window.operator
      ? window.operator
      : null;
  const show = operator?.notifications?.show;
  if (typeof show !== 'function') return;

  try {
    // Send only notification content through the narrow IPC contract; no
    // credentials or other main-process state crosses the bridge.
    Promise.resolve(
      show({
        number: message.number,
        body: message.body || '(empty message)',
      })
    ).catch(() => {
      // Native notification support is optional; sound still played.
    });
  } catch (_) {
    // Keep a bridge failure from interrupting the polling loop.
  }
}
