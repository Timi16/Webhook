"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Empty } from "./ui";

function Inner({ children }: { children: (id: string) => ReactNode }) {
  const id = useSearchParams().get("id");
  if (!id) {
    return (
      <Empty icon="search" title="Nothing to show">
        This page needs an ID in its address. Go back and open the item from its list.
      </Empty>
    );
  }
  return <>{children(id)}</>;
}

/**
 * Detail pages take their ID from `?id=`: the app is a static site, so it cannot have a route
 * per record.
 */
export function WithId({ children }: { children: (id: string) => ReactNode }) {
  return (
    <Suspense>
      <Inner>{children}</Inner>
    </Suspense>
  );
}
