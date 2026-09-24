/** Only for failures from a native passkey prompt; HTTP failures retain their recovery path. */
export function nativePasskeyError(error: unknown, aborted = false): { message: string; state: 'ready' | 'error' } {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'AbortError' || (name === 'NotAllowedError' && aborted))
    return { message: 'Passkey prompt cancelled. You can try again.', state: 'ready' };
  // Browsers use the same name for cancellation, timeout and unavailable credentials.
  if (name === 'NotAllowedError')
    return { message: 'We couldn’t finish with your passkey. Try again and complete the prompt. If you just saved a new passkey, give it a moment to appear.', state: 'ready' };
  if (name === 'NotSupportedError')
    return { message: 'This browser or passkey manager cannot complete this request. Try a browser that supports passkeys.', state: 'error' };
  if (name === 'SecurityError')
    return { message: 'This browser blocked the passkey request. Open the original secure account page and try again.', state: 'error' };
  return { message: 'The passkey prompt did not complete. Try again and complete the prompt.', state: 'error' };
}
