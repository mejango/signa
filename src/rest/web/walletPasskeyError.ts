/** Only for failures from a native passkey prompt; HTTP failures retain their recovery path. */
export function nativePasskeyError(error: unknown, aborted = false): { message: string; state: 'ready' | 'error' } {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'AbortError' || (name === 'NotAllowedError' && aborted))
    return { message: 'The device prompt was cancelled. You can try again.', state: 'ready' };
  // Browsers use the same name for cancellation, timeout and unavailable credentials.
  if (name === 'NotAllowedError')
    return { message: 'We couldn’t finish with your device. Try again and complete the prompt. If you just saved a new key, give it a moment to appear.', state: 'ready' };
  if (name === 'NotSupportedError')
    return { message: 'This browser or device cannot complete the request. Try another browser or device.', state: 'error' };
  if (name === 'SecurityError')
    return { message: 'This browser blocked the device request. Open the original secure account page and try again.', state: 'error' };
  return { message: 'The device prompt did not complete. Try again and complete the prompt.', state: 'error' };
}
