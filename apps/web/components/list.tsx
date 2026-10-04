"use client";

import { useState } from "react";
import { Icon } from "./icons";

/** A filter button from the design, backed by a real <select> so keyboards and phones just work. */
export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  icon?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? "";
  return (
    <span className="select" style={{ position: "relative" }}>
      {icon ? <Icon name="calendar" size={14} /> : <span className="k">{label}</span>}
      {current} <Icon name="chevron-down" size={14} />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Cursor paging: the API hands out an opaque cursor for the next (older) page, so going back
 * means remembering the cursors already used. `reset` is the filter key: a new one starts over.
 */
export function usePager(reset: string) {
  const [state, setState] = useState<{ key: string; cursors: (string | undefined)[] }>({
    key: reset,
    cursors: [undefined],
  });
  const cursors = state.key === reset ? state.cursors : [undefined];
  return {
    cursor: cursors.at(-1),
    page: cursors.length,
    older: (next: string) => setState({ key: reset, cursors: [...cursors, next] }),
    newer: () => setState({ key: reset, cursors: cursors.slice(0, -1) }),
  };
}

export function Pager({
  page,
  count,
  noun,
  nextCursor,
  onOlder,
  onNewer,
}: {
  page: number;
  count: number;
  noun: string;
  nextCursor: string | null;
  onOlder: (cursor: string) => void;
  onNewer: () => void;
}) {
  return (
    <div className="pager">
      <span>
        Page {page} · {count} {count === 1 ? noun : `${noun}s`}
      </span>
      <span className="wh-row">
        <button className="wh-btn is-sm" type="button" disabled={page === 1} onClick={onNewer}>
          <Icon name="chevron-left" size={14} />
          Newer
        </button>
        <button
          className="wh-btn is-sm"
          type="button"
          disabled={!nextCursor}
          onClick={() => nextCursor && onOlder(nextCursor)}
        >
          Older
          <Icon name="chevron-right" size={14} />
        </button>
      </span>
    </div>
  );
}

export function TableSkeleton({ columns, widths }: { columns: string[]; widths: number[] }) {
  return (
    <div className="wh-resp">
      <table className="wh-table" aria-busy="true">
        <thead>
          <tr>
            {columns.map((c) => (
              <th scope="col" key={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <tr key={row}>
              {widths.map((width, i) => (
                <td key={i}>
                  <span className="wh-skel" style={{ width, height: 12 }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
