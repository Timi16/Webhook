"use client";

import { API_URL } from "@/lib/api";
import { Icon } from "./icons";
import { useToast } from "./toast";

/** The request as a curl command, with the API key read from the shell's environment. */
export function curlCommand(method: string, path: string, body?: unknown): string {
  const lines = [
    `curl ${method === "GET" ? "" : `-X ${method} `}"${API_URL}${path}"`,
    `  -H "Authorization: Bearer $WEBHOOK_API_KEY"`,
  ];
  if (body !== undefined) {
    lines.push(`  -H "Content-Type: application/json"`);
    // Single quotes keep the JSON intact in a shell; a quote inside it is closed and re-opened.
    lines.push(`  -d '${JSON.stringify(body, null, 2).replace(/'/g, `'\\''`)}'`);
  }
  return lines.join(" \\\n");
}

/** Copies the API call behind this screen, so it can be pasted into a terminal or a script. */
export function CurlButton({
  method = "GET",
  path,
  body,
  small,
}: {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  small?: boolean;
}) {
  const toast = useToast();
  return (
    <button
      className={small ? "wh-btn is-sm is-ghost" : "wh-btn is-ghost"}
      type="button"
      title="Copy this request as a curl command"
      onClick={() => {
        void navigator.clipboard.writeText(curlCommand(method, path, body)).then(
          () => toast("Copied as cURL. Set WEBHOOK_API_KEY before running it."),
          () => toast("Couldn't copy to the clipboard.", { tone: "bad" }),
        );
      }}
    >
      <Icon name="code" size={small ? 14 : 16} />
      Copy as cURL
    </button>
  );
}
