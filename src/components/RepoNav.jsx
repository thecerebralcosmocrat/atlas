import { Tabs, TabsList, TabsTrigger } from "@/components/glaze/ui/tabs";

const tabs = [
  { id: "ask", label: "Ask" },
  { id: "overview", label: "Overview" },
  { id: "files", label: "Files" },
  { id: "graph", label: "Graph" },
  { id: "analyze", label: "Analyze" },
];

export default function RepoNav({ active, onChange }) {
  return (
    <div className="shrink-0 border-b border-line-faint px-4 py-2">
      <Tabs value={active} onValueChange={onChange}>
        <TabsList aria-label="Repository">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
