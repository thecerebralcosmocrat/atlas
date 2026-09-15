import { cn } from "@/lib/utils";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "ask", label: "Ask" },
  { id: "files", label: "Files" },
  { id: "graph", label: "Graph" },
  { id: "analyze", label: "Analyze" },
];

export default function RepoNav({ active, onChange }) {
  return (
    <nav
      aria-label="Repository views"
      className="flex shrink-0 gap-1 border-b border-border px-4"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;

        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
