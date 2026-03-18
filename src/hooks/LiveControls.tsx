import React from "react";

interface LiveControlsProps {
  site?: string;
  page?: { id?: string; pathTemplate?: string };
  flags?: any[];
}

/**
 * LiveControls bridges the deco admin (parent window) with the storefront (iframe).
 *
 * Mirrors production behavior (apps/website/components/_Controls.tsx):
 * 1. Injects __DECO_STATE for the admin to read
 * 2. Listens for postMessage events from the admin (inject scripts, scroll, rerender)
 * 3. "." opens admin in same tab, Ctrl/Cmd+"." opens in new tab, Ctrl+Shift+E also works
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
            site: { name: site || "storefront" },
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
      if (window.__DECO_LIVE_CONTROLS__) return;
      window.__DECO_LIVE_CONTROLS__ = true;

      var TRUSTED_ORIGINS = ["https://deco.cx", "https://admin.deco.cx", "https://play.deco.cx"];
      function isTrustedOrigin(origin) {
        return TRUSTED_ORIGINS.indexOf(origin) !== -1 ||
          origin.endsWith(".deco.cx") ||
          origin === window.location.origin;
      }

      var LIVE = JSON.parse(document.getElementById("__DECO_STATE")?.textContent || "{}");
      window.LIVE = { ...window.LIVE, ...LIVE };

      window.addEventListener("message", function(event) {
        if (!isTrustedOrigin(event.origin)) return;

        var data = event.data;
        if (!data || typeof data !== "object") return;

        switch (data.type) {
          case "editor::inject":
            if (data.args && data.args.script) {
              try { eval(data.args.script); } catch(e) { console.error("[deco] inject error:", e); }
            }
            break;

          case "scrollToComponent":
            var el = document.querySelector('[data-manifest-key="' + CSS.escape(data.args?.id || "") + '"]');
            if (!el) el = document.getElementById(data.args?.id);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            break;

          case "DOMInspector":
            break;

          case "editor::rerender":
            if (data.args?.url) {
              try {
                var targetUrl = new URL(data.args.url, window.location.origin);
                if (targetUrl.origin === window.location.origin) {
                  window.location.href = targetUrl.href;
                }
              } catch(e) {}
            }
            break;
        }
      });

      if (window.self === window.top) {
        document.body.addEventListener("keydown", function(e) {
          if (e.target !== document.body) return;
          if (e.defaultPrevented) return;

          if (
            (e.ctrlKey && e.shiftKey && e.key === "E") ||
            e.key === "."
          ) {
            e.preventDefault();
            e.stopPropagation();

            var siteName = (window.LIVE.site && window.LIVE.site.name) || window.LIVE.site || "storefront";
            var pageId = (window.LIVE.page && window.LIVE.page.id) || "";
            var pathTemplate = (window.LIVE.page && window.LIVE.page.pathTemplate) || "/*";

            var href = new URL("/choose-editor", "https://admin.deco.cx");
            href.searchParams.set("site", siteName);
            href.searchParams.set("domain", window.location.origin);
            if (pageId) href.searchParams.set("pageId", pageId);
            href.searchParams.set("path", encodeURIComponent(window.location.pathname + window.location.search));
            href.searchParams.set("pathTemplate", encodeURIComponent(pathTemplate));

            if ((e.ctrlKey || e.metaKey) && e.key === ".") {
              window.open(href.toString(), "_blank");
              return;
            }
            window.location.href = href.toString();
          }
        });
      }
    })();
  `;

  return <script type="module" dangerouslySetInnerHTML={{ __html: script }} />;
}
