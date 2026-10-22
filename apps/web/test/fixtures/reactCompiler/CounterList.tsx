import { useState } from "react";

interface CounterListProps {
  readonly title: string;
  readonly items: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly onSelect?: (id: string) => void;
}

export function CounterList({ title, items, onSelect }: CounterListProps) {
  const [count, setCount] = useState(0);
  const visible = items.filter((item) => item.label.length > 0);
  const increment = () => setCount((value) => value + 1);

  return (
    <section aria-label={title}>
      <h2>{count > 0 ? `${title} (${count})` : title}</h2>
      <button type="button" onClick={increment}>
        Add
      </button>
      <ul>
        {visible.map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onSelect?.(item.id)}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
