import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("invalid_email").max(254));
export const passwordSchema = z.string().min(10, "password_too_short").max(200);

export const signupSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
  workspace: z.string().trim().min(1).max(100).optional(),
});
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
export const forgotPasswordSchema = z.strictObject({ email: emailSchema });
export const resetPasswordSchema = z.strictObject({
  token: z.string().min(1).max(500),
  newPassword: passwordSchema,
});

/** What an API key may do. Reading watches and endpoints needs no scope. */
export const API_KEY_SCOPES = ["payments:read", "watches:write", "endpoints:write"] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPES);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

/** An IPv4 address or CIDR range, e.g. 203.0.113.7 or 203.0.113.0/24. */
export function isIpRule(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value);
  if (!match) return false;
  const octetsOk = match.slice(1, 5).every((octet) => parseInt(octet, 10) <= 255);
  return octetsOk && (match[5] === undefined || parseInt(match[5], 10) <= 32);
}

const apiKeyFields = {
  name: z.string().trim().min(1).max(100),
  note: z.string().trim().max(200).nullable(),
  scopes: z
    .array(apiKeyScopeSchema)
    .min(1, "scope_required")
    .max(API_KEY_SCOPES.length)
    .transform((scopes) => [...new Set(scopes)]),
  allowedIps: z
    .array(z.string().trim().refine(isIpRule, "invalid_ip_rule"))
    .max(20)
    .transform((rules) => [...new Set(rules)]),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
};
export const createApiKeySchema = z.strictObject({
  name: apiKeyFields.name,
  note: apiKeyFields.note.optional(),
  scopes: apiKeyFields.scopes.optional(),
  allowedIps: apiKeyFields.allowedIps.optional(),
  expiresAt: apiKeyFields.expiresAt.optional(),
});
export const updateApiKeySchema = z
  .strictObject({
    name: apiKeyFields.name.optional(),
    note: apiKeyFields.note.optional(),
    scopes: apiKeyFields.scopes.optional(),
    allowedIps: apiKeyFields.allowedIps.optional(),
    expiresAt: apiKeyFields.expiresAt.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing_to_update");
export const deleteApiKeyQuerySchema = z.strictObject({
  permanent: z.enum(["true", "false"]).optional(),
});

export const updateProfileSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    workspace: z.string().trim().max(100).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing_to_update");
export const changeEmailSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export const confirmEmailSchema = z.strictObject({ token: z.string().min(1).max(1000) });
export const deleteAccountSchema = z.strictObject({ password: z.string().min(1).max(200) });
