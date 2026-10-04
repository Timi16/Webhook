"use client";

import { WithId } from "@/components/query";
import { ErrorAlert } from "@/components/ui";
import { WatchForm } from "@/components/watch-form";
import { useApi } from "@/lib/hooks";
import type { Watch } from "@/lib/types";

function EditWatch({ id }: { id: string }) {
  const detail = useApi<{ watch: Watch }>(`/v1/watches/${id}`);
  if (detail.error && !detail.data)
    return (
      <ErrorAlert error={detail.error} title="Couldn't load this watch." onRetry={detail.reload} />
    );
  if (!detail.data) return <div aria-busy="true" />;
  return <WatchForm watch={detail.data.watch} />;
}

export default function EditWatchPage() {
  return <WithId>{(id) => <EditWatch id={id} />}</WithId>;
}
