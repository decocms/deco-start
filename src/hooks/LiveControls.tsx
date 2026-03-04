interface LiveControlsProps {
  site?: string;
  page?: any;
  flags?: any[];
}

/**
 * LiveControls bridges the deco admin (parent window) with the storefront (iframe).
 *
 * It:
 * 1. Injects __DECO_STATE for the admin to read
 * 2. Listens for postMessage events from the admin (scroll, inspect, rerender)
 * 3. Provides the Ctrl+Shift+E shortcut to open the editor
 */
export function LiveControls({ site, page, flags }: LiveControlsProps) {
  return (
    <>
      <script
        id="__DECO_STATE"
        type="application/json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            page: page || {},
            site: site || "storefront",
            flags: flags || [],
          }),
        }}
      />
      <LiveControlsScript />
    </>
  );
}

function LiveControlsScript() {
  const script = `
    (function() {
      var LIVE = JSON.parse(document.getElementById("__DECO_STATE")?.textContent || "{}");
      window.LIVE = LIVE;

      // Listen for admin postMessage events
      window.addEventListener("message", function(event) {
        var data = event.data;
        if (!data || typeof data !== "object") return;

        switch (data.type) {
          case "scrollToComponent":
            var el = document.querySelector('[data-manifest-key="' + data.args?.id + '"]');
            if (!el) el = document.getElementById(data.args?.id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            break;

          case "DOMInspector":
            // Toggle DOM inspector overlay (future implementation)
            break;

          case "editor::rerender":
            if (data.args?.url) {
              window.location.href = data.args.url;
            }
            break;
        }
      });

      // Ctrl+Shift+E or "." key shortcut to open editor
      if (window.self === window.top) {
        document.addEventListener("keydown", function(e) {
          if ((e.ctrlKey && e.shiftKey && e.key === "E") || (e.key === "." && !e.target.closest("input,textarea,[contenteditable]"))) {
            var site = LIVE.site || "storefront";
            var domain = window.location.hostname;
            window.location.href = "https://deco.cx/choose-editor?site=" + site + "&domain=" + domain;
          }
        });
      }
    })();
  `;

  return (
    <script
      type="module"
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
