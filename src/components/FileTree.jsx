import { Badge } from "@/components/glaze/ui/badge";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/components/glaze/ui/item";
import { Truncate } from "@/components/glaze/ui/truncate";

function flatten(items, depth, parentKey, rows) {
  for (const item of items) {
    const key = `${parentKey}/${item.name}`;

    rows.push({ key, item, depth });
    if (item.children?.length > 0) {
      flatten(item.children, depth + 1, key, rows);
    }
  }
  return rows;
}

// Glaze has no tree: one list of rows, indented by depth from the space tokens.
export default function FileTree({ items, depth = 0 }) {
  if (!items?.length) return null;

  const rows = flatten(items, depth, "", []);

  return (
    <ItemGroup variant="plain" aria-label="Repository files">
      {rows.map(({ key, item, depth: rowDepth }) => (
        <Item
          key={key}
          size="sm"
          className="ps-(--indent)"
          style={{
            "--indent": `calc(var(--space-3) + ${rowDepth} * var(--space-4))`,
          }}
        >
          <ItemContent>
            <ItemTitle>
              <Truncate className="mono">{item.name}</Truncate>
            </ItemTitle>
          </ItemContent>
          <Badge>{item.type}</Badge>
        </Item>
      ))}
    </ItemGroup>
  );
}
