export type JbcenterEnv = {
  Bindings: { incoming?: { url?: string } };
  Variables: {
    client: string;
    requestId: string;
    /** The public error code of a failed response, for the request log. */
    errorCode?: string;
    /** A bounded, data-free error message for the request log line. */
    errorDetail?: string;
    /** Time spent authenticating the signed request, for the request log line. */
    authMs?: number;
  };
};

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
