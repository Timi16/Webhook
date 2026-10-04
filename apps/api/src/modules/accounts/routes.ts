import { accountResponse, addressParamSchema } from "@webhook/shared";
import { Router } from "express";
import type { HorizonClient } from "../../lib/horizon.js";
import type { Api } from "../../openapi/registry.js";

/** Looks a wallet up on testnet. Not tenant data: anyone logged in may check any public address. */
export function createAccountsRouter(api: Api, horizon: HorizonClient): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/v1/accounts/:address",
      summary: "Check a wallet on testnet",
      description:
        "Whether the account exists on Stellar Testnet and which assets it can receive (XLM plus one per trustline). Use it before creating a watch to see if the wallet is ready. `exists` is `null` when Horizon cannot be reached.",
      tag: "Watches",
      auth: "any",
      params: addressParamSchema,
      response: accountResponse,
    },
    async ({ params }) => {
      const account = await horizon.account(params.address);
      return {
        address: params.address,
        exists: account ? account.exists : null,
        assets: account?.assets ?? [],
      };
    },
  );

  return router;
}
