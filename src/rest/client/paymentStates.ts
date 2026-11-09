/** Every state a reviewed payment can be in.
 * `expired`: published but never included before its signed validity ended; it cannot execute.
 * `refused`: Signa refused to send it and retired the approval; Signa never sends it, and a fresh payment takes its nonce. */
export const paymentStates = ['reviewing', 'approved', 'submitting', 'pending', 'confirming', 'paid', 'reverted', 'cancelled', 'unknown', 'expired', 'refused'] as const;
export type CenterWalletPaymentState = typeof paymentStates[number];
/** The payment states that end a payment: nothing more happens to it, so it can be cleared and
 * never holds up a new sign-in or payment. The wallet client and the connect step share this rule. */
const settledPaymentStates: readonly CenterWalletPaymentState[] = ['paid', 'reverted', 'cancelled', 'expired', 'refused'];
/** The payment states in which a sent payment moves on by itself, so an app follows it until it settles. */
const followedPaymentStates: readonly CenterWalletPaymentState[] = ['submitting', 'pending', 'confirming'];
export const isSettledPayment = (status: string) => (settledPaymentStates as readonly string[]).includes(status);
export const isFollowedPayment = (status: string) => (followedPaymentStates as readonly string[]).includes(status);
