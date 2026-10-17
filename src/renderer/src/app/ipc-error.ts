import { CAPTCHA_MARKER } from '../../../shared/ipc';

/**
 * Errors thrown in the main process lose their class over ipcRenderer.invoke: the renderer sees
 * "Error invoking remote method '…': Error: <message>". Recover the original message and the captcha flag.
 */
export function unwrapIpcError(e: unknown): { captcha: boolean; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^\w*Error:\s*/, '')
    .trim();
  if (message === CAPTCHA_MARKER) return { captcha: true, message: 'Сайт ДТЕК просить пройти перевірку' };
  return { captcha: false, message: message || 'Невідома помилка' };
}
