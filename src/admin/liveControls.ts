/**
 * Admin Live Controls - Inline script for storefront pages.
 *
 * When the storefront is embedded in the admin's iframe, the admin sends
 * `editor::inject` postMessage events containing a script that handles
 * the preview navigation loop. This listener receives that script and
 * evaluates it in the page context.
 *
 * Include this script in the root layout (e.g., via a <script> tag) so
 * the admin can communicate with the storefront.
 */
export const LIVE_CONTROLS_SCRIPT = `
(function() {
  if (window.__DECO_LIVE_CONTROLS__) return;
  window.__DECO_LIVE_CONTROLS__ = true;

  addEventListener("message", function(event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    switch (data.type) {
      case "editor::inject":
        if (data.args && data.args.script) {
          try { eval(data.args.script); } catch(e) { console.error("[deco] inject error:", e); }
        }
        break;
    }
  });
})();
`;
