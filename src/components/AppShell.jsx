import { GlazePortalProvider } from "@/lib/glaze/portal";
import { TooltipProvider } from "@/components/glaze/ui/tooltip";
import Sidebar from "./Sidebar";

// The Glaze page shell: root scope, portal provider, the titlebar drag strip,
// the sidebar and the routed main area. It lives in components/ because Glaze
// utilities only compile from src/components, src/pages and src/lib/glaze.
export default function AppShell({ sidebar, children }) {
  return (
    <div className="glaze flex h-full w-full flex-col overflow-hidden bg-page text-text-1">
      <GlazePortalProvider>
        <TooltipProvider>
          {/* Custom titlebar drag region */}
          <div className="app-drag h-8 w-full shrink-0 border-b border-line-faint bg-shell" />

          <div className="flex flex-1 overflow-hidden">
            <Sidebar {...sidebar} />

            <main className="flex flex-1 flex-col overflow-hidden bg-page">
              {children}
            </main>
          </div>
        </TooltipProvider>
      </GlazePortalProvider>
    </div>
  );
}
