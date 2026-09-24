/** Name new passkeys by this site and the local time they were created. */
export function defaultPasskeyName(): string {
  const now = new Date();
  return `${location.hostname} | ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })} ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
