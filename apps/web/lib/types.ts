// The API's response shapes, taken from the same schemas that document it.
import type {
  apiKeyDetailResponse,
  apiKeyResponse,
  deliveryResponse,
  developerResponse,
  endpointDetailResponse,
  endpointResponse,
  eventDetailResponse,
  eventListResponse,
  overviewResponse,
  paymentDetailResponse,
  paymentListResponse,
  watchDetailResponse,
  watchResponse,
} from "@webhook/shared";
import type { z } from "zod";

export type Developer = z.infer<typeof developerResponse>;
export type ApiKey = z.infer<typeof apiKeyResponse>;
export type ApiKeyDetail = z.infer<typeof apiKeyDetailResponse>;
export type Endpoint = z.infer<typeof endpointResponse>;
export type EndpointDetail = z.infer<typeof endpointDetailResponse>["endpoint"];
export type Watch = z.infer<typeof watchResponse>;
export type WatchStats = z.infer<typeof watchDetailResponse>["stats"];
export type Delivery = z.infer<typeof deliveryResponse>;
export type Overview = z.infer<typeof overviewResponse>;
export type PaymentRow = z.infer<typeof paymentListResponse>["data"][number];
export type PaymentDetail = z.infer<typeof paymentDetailResponse>["payment"];
export type EventRow = z.infer<typeof eventListResponse>["data"][number];
export type EventDetail = z.infer<typeof eventDetailResponse>["event"];

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
