import { redirect } from "next/navigation";

// Replaced by the landing page; until then the app opens on the dashboard.
export default function Home() {
  redirect("/overview");
}
