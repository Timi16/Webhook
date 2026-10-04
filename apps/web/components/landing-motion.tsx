"use client";

import { useEffect } from "react";

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const FROM = { opacity: 0, transform: "translateY(24px)" };
const TO = { opacity: 1, transform: "none" };

/**
 * The landing page's motion: the hero fades up, sections reveal as they scroll into view, and the
 * bar under the nav tracks scroll progress. Without JavaScript, or with reduced motion, the page
 * is simply all there.
 */
export function LandingMotion() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    document.querySelectorAll<HTMLElement>(".lpr-hero [data-in]").forEach((element, i) => {
      element.animate([FROM, TO], { duration: 800, delay: i * 90, easing: EASE, fill: "backwards" });
    });

    const pending = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    for (const element of pending) element.style.opacity = "0";
    const observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((entry) => entry.isIntersecting)
          .forEach((entry, i) => {
            const element = entry.target as HTMLElement;
            observer.unobserve(element);
            element.style.opacity = "";
            element.animate([FROM, TO], { duration: 700, delay: i * 100, easing: EASE, fill: "backwards" });
          });
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    for (const element of pending) observer.observe(element);

    const bar = document.querySelector<HTMLElement>(".lpr-progress");
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      for (const element of pending) element.style.opacity = "";
    };
  }, []);
  return null;
}
