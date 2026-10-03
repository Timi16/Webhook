import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("invalid_email").max(254));
export const passwordSchema = z.string().min(10, "password_too_short").max(200);

export const signupSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
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

export const createApiKeySchema = z.strictObject({ name: z.string().trim().min(1).max(100) });
