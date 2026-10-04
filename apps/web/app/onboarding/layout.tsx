import type { ReactNode } from "react";
import { SessionGate } from "@/components/session";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}
