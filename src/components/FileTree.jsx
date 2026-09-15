export default function FileTree({ items, depth = 0 }) {
  if (!items?.length) return null;

  return (
    <div
      className={
        depth === 0 ? "flex flex-col gap-1" : "mt-1 flex flex-col gap-1"
      }
    >
      {items.map((item) => (
        <div key={`${depth}-${item.name}`}>
          <div
            className="px-2 py-1.5 text-sm text-muted-foreground"
            style={{ paddingInlineStart: `${8 + depth * 16}px` }}
          >
            <span className="text-foreground">{item.name}</span>
            <span className="ms-2 text-[11px] uppercase tracking-wide">
              {item.type}
            </span>
          </div>
          {item.children?.length > 0 && (
            <FileTree items={item.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}
