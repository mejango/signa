export const REST_PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

/** The same for documentation, which changes only on deploy. */
export const REST_DOCS_HEADERS = { ...REST_PAGE_HEADERS, "Cache-Control": "public, max-age=300" } as const;
