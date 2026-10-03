import type { Watch } from "@prisma/client";
import {
  assetSchema,
  memoRuleSchema,
  storedAmountRuleSchema,
  type AmountRule,
  type Asset,
  type MemoRule,
} from "@webhook/shared";
import { z } from "zod";

export interface ParsedWatch {
  id: string;
  developerId: string;
  endpointId: string;
  walletAddress: string;
  label: string | null;
  assets: Asset[];
  amountRule: AmountRule;
  memoRule: MemoRule;
  senderAllowlist: string[];
  eventTypes: string[];
  startLedger: number;
  active: boolean;
  deletedAt: Date | null;
}

const assetsSchema = z.array(assetSchema).min(1);

/** Never trust raw JSON from the database: rules are re-parsed on every read. Throws if invalid. */
export function parseWatch(row: Watch): ParsedWatch {
  return {
    id: row.id,
    developerId: row.developerId,
    endpointId: row.endpointId,
    walletAddress: row.walletAddress,
    label: row.label,
    assets: assetsSchema.parse(row.assets),
    amountRule: storedAmountRuleSchema.parse(row.amountRule),
    memoRule: memoRuleSchema.parse(row.memoRule),
    senderAllowlist: row.senderAllowlist,
    eventTypes: row.eventTypes,
    startLedger: row.startLedger,
    active: row.active,
    deletedAt: row.deletedAt,
  };
}
