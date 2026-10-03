import { randomBytes } from "node:crypto";
import type { Developer, Endpoint, Prisma, PrismaClient, Watch } from "@prisma/client";
import { encryptSecret } from "../../src/lib/crypto.js";
import { generateWebhookSecret } from "../../src/lib/ids.js";
import { randomAddress, USDC } from "./payments.js";
import { testEnv } from "./testEnv.js";

const env = testEnv();

export async function seedDeveloper(prisma: PrismaClient): Promise<Developer> {
  return prisma.developer.create({
    data: {
      email: `dev-${randomBytes(5).toString("hex")}@example.com`,
      passwordHash: "not-a-real-hash",
    },
  });
}

export async function seedEndpoint(
  prisma: PrismaClient,
  developerId: string,
  overrides: Partial<Prisma.EndpointUncheckedCreateInput> = {},
): Promise<Endpoint & { secret: string }> {
  const secret = generateWebhookSecret();
  const endpoint = await prisma.endpoint.create({
    data: {
      developerId,
      url: "https://receiver.example.com/webhooks",
      secretEnc: encryptSecret(secret, env.ENCRYPTION_KEY),
      ...overrides,
    },
  });
  return { ...endpoint, secret };
}

export async function seedWatch(
  prisma: PrismaClient,
  developerId: string,
  endpointId: string,
  overrides: Partial<Prisma.WatchUncheckedCreateInput> = {},
): Promise<Watch> {
  return prisma.watch.create({
    data: {
      developerId,
      endpointId,
      walletAddress: randomAddress(),
      assets: [USDC],
      amountRule: { kind: "any" },
      memoRule: { kind: "any" },
      senderAllowlist: [],
      eventTypes: ["payment.received"],
      startLedger: 1,
      ...overrides,
    },
  });
}

/** Developer + endpoint + one watch, the usual starting point. */
export async function seedTenant(
  prisma: PrismaClient,
  watch: Partial<Prisma.WatchUncheckedCreateInput> = {},
) {
  const developer = await seedDeveloper(prisma);
  const endpoint = await seedEndpoint(prisma, developer.id);
  const created = await seedWatch(prisma, developer.id, endpoint.id, watch);
  return { developer, endpoint, watch: created };
}
