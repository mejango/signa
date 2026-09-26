/** Only for failures from a native passkey prompt; HTTP failures retain their recovery path. */
export function nativePasskeyError(error: unknown, aborted = false): { message: string; state: 'ready' | 'error' } {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'AbortError' || (name === 'NotAllowedError' && aborted))
    return { message: 'The device prompt was cancelled. You can try again.', state: 'ready' };
  // Browsers use the same name for cancellation, timeout and unavailable credentials.
  if (name === 'NotAllowedError')
    return { message: 'The device prompt didn’t finish. Try again.', state: 'ready' };
  if (name === 'NotSupportedError')
    return { message: 'This browser or device cannot complete the request. Try another browser or device.', state: 'error' };
  if (name === 'SecurityError')
    return { message: 'This browser blocked the device request. Open the original secure account page and try again.', state: 'error' };
  return { message: 'The device prompt did not complete. Try again and complete the prompt.', state: 'error' };
}

type Notice = { message: string; state: 'ready' | 'error' };
const noticeKey = 'signa:sign-in-notice';
/** A sign-in started on the signup page that fails goes back to the sign-in page, carrying its message.
 * Storage may be refused (a cross-site frame); the sign-in page then shows its usual line. */
export function carrySignInNotice(notice: Notice) { try { sessionStorage.setItem(noticeKey, JSON.stringify(notice)); } catch { /* not kept */ } }
export function takeSignInNotice(): Notice | null {
  try {
    const stored = sessionStorage.getItem(noticeKey); sessionStorage.removeItem(noticeKey);
    const notice = stored ? JSON.parse(stored) as Partial<Notice> : null;
    return notice && typeof notice.message === 'string' && notice.message.length <= 300 && (notice.state === 'ready' || notice.state === 'error')
      ? { message: notice.message, state: notice.state } : null;
  } catch { return null; }
}
