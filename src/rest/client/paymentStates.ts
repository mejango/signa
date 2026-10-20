/** The payment states that end a payment: nothing more happens to it, so it can be cleared and
 * never holds up a new sign-in or payment. The wallet client and the connect step share this rule. */
export const settledPaymentStates: readonly string[] = ['paid', 'reverted', 'cancelled', 'expired', 'refused'];
export const isSettledPayment = (status: string) => settledPaymentStates.includes(status);
