/**
 * Server function input validation for section-related server functions.
 *
 * Validates that `loadDeferredSection` and similar server functions receive
 * well-formed input before reaching section loaders. Prevents malformed
 * requests from causing obscure runtime errors.
 *
 * @example
 * ```tsx
 * import { validateDeferredSectionInput } from "@decocms/start/middleware/validateSection";
 *
 * // In your storefront's middleware chain:
 * export const loadSection = createServerFn({ method: "GET" })
 *   .inputValidator(validateDeferredSectionInput)
 *   .handler(async (ctx) => { ... });
 * ```
 */

export interface DeferredSectionInput {
  component: string;
  rawProps: Record<string, unknown>;
  pagePath: string;
  pageUrl?: string;
  /** Original position in the page section list — for correct ordering after resolution. */
  index?: number;
}

/**
 * Validates input for deferred section loading server functions.
 * Throws descriptive errors for malformed requests.
 */
export function validateDeferredSectionInput(data: unknown): DeferredSectionInput {
  if (!data || typeof data !== "object") {
    throw new Error("[validateDeferredSectionInput] Expected an object, got " + typeof data);
  }
  const obj = data as Record<string, unknown>;

  if (!obj.component || typeof obj.component !== "string") {
    throw new Error(
      "[validateDeferredSectionInput] Missing or invalid 'component' field (expected string)",
    );
  }

  if (!obj.rawProps || typeof obj.rawProps !== "object" || Array.isArray(obj.rawProps)) {
    throw new Error(
      "[validateDeferredSectionInput] Missing or invalid 'rawProps' field (expected object)",
    );
  }

  if (!obj.pagePath || typeof obj.pagePath !== "string") {
    throw new Error(
      "[validateDeferredSectionInput] Missing or invalid 'pagePath' field (expected string)",
    );
  }

  if (obj.pageUrl !== undefined && typeof obj.pageUrl !== "string") {
    throw new Error(
      "[validateDeferredSectionInput] Invalid 'pageUrl' field (expected string or undefined)",
    );
  }

  if (obj.index !== undefined && typeof obj.index !== "number") {
    throw new Error(
      "[validateDeferredSectionInput] Invalid 'index' field (expected number or undefined)",
    );
  }

  return {
    component: obj.component as string,
    rawProps: obj.rawProps as Record<string, unknown>,
    pagePath: obj.pagePath as string,
    pageUrl: obj.pageUrl as string | undefined,
    index: obj.index as number | undefined,
  };
}

/**
 * Generic section props validator factory.
 * Creates a validator function that checks required fields exist.
 *
 * @example
 * ```tsx
 * const validate = createSectionValidator(["title", "maxItems"]);
 * const props = validate(rawInput); // throws if missing title or maxItems
 * ```
 */
export function createSectionValidator(requiredFields: string[]) {
  return (data: unknown): Record<string, unknown> => {
    if (!data || typeof data !== "object") {
      throw new Error("[SectionValidator] Expected an object");
    }
    const obj = data as Record<string, unknown>;
    for (const field of requiredFields) {
      if (obj[field] === undefined) {
        throw new Error(`[SectionValidator] Missing required field: "${field}"`);
      }
    }
    return obj;
  };
}
