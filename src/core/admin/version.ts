/**
 * Version reported to admin.deco.cx by `/_healthcheck` and similar probes.
 *
 * **Pinning contract:** this constant must NOT track `@decocms/start`'s own
 * version (currently 5.x). Admin compares the returned value against
 * `deco-cx/deco`'s release range (currently 1.177.x). Bumping it shifts the
 * admin compatibility window — change deliberately and document in the
 * release notes when you do.
 */
export const ADMIN_COMPAT_VERSION = "1.177.5";
