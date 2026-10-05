import { describe, expect, it } from "vitest";
import { renderEmail } from "../../src/lib/emailTemplate.js";

describe("email template", () => {
  it("renders the code, button and text version", () => {
    const { html, text } = renderEmail({
      preview: "Preview line",
      heading: "Confirm your email",
      paragraphs: ["First paragraph.", "Second paragraph."],
      code: "042137",
      button: { label: "Open", url: "https://app.example.com/x?token=abc.def" },
      footnote: "Small print.",
    });
    expect(html).toContain("042137");
    expect(html).toContain('href="https://app.example.com/x?token=abc.def"');
    expect(html).toContain("Preview line");
    expect(text).toBe(
      "First paragraph.\n\nSecond paragraph.\n\n042137\n\nhttps://app.example.com/x?token=abc.def\n\nSmall print.",
    );
  });

  it("escapes anything that comes from a user", () => {
    const { html } = renderEmail({
      preview: "p",
      heading: "h",
      paragraphs: ['Your endpoint https://x.example/"><script>alert(1)</script> was disabled.'],
      button: { label: "Open", url: 'https://x.example/"onmouseover="x' },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&lt;script&gt;");
  });
});
