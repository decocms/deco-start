/**
 * Analytics utilities using the data-event attribute pattern.
 * Compatible with Deco's analytics pipeline and GTM.
 */

export interface DataEventParams {
  on: "view" | "click" | "change";
  event: { name: string; params?: Record<string, unknown> };
}

export function useSendEvent({ on, event }: DataEventParams) {
  return {
    "data-event": encodeURIComponent(JSON.stringify(event)),
    "data-event-trigger": on,
  };
}

/**
 * Inline script that observes data-event attributes and dispatches events.
 * Inject once in the root layout via a <script> tag.
 */
export const ANALYTICS_SCRIPT = `
(function() {
  function dispatch(event) {
    if (window.dataLayer) {
      window.dataLayer.push({ event: event.name, ...event.params });
    }
    if (window.DECO && window.DECO.events) {
      window.DECO.events.dispatch(event);
    }
  }

  function getEvent(el) {
    var raw = el.getAttribute("data-event");
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(raw)); } catch(e) { return null; }
  }

  var viewObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var event = getEvent(entry.target);
        if (event) dispatch(event);
        viewObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  document.addEventListener("click", function(e) {
    var el = e.target.closest("[data-event-trigger='click']");
    if (el) {
      var event = getEvent(el);
      if (event) dispatch(event);
    }
  });

  function observeAll() {
    document.querySelectorAll("[data-event-trigger='view']").forEach(function(el) {
      viewObserver.observe(el);
    });
  }

  observeAll();
  new MutationObserver(observeAll).observe(document.body, { childList: true, subtree: true });
})();
`;

/** Returns a GTM container snippet. Returns empty string if no containerId. */
export function gtmScript(containerId?: string): string {
  if (!containerId) return "";
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${containerId}');`;
}
