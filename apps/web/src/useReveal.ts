import { useLayoutEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// GSAP owns section entrances; Motion owns the interactive content inside them.
export function useReveal() {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const targets = node.querySelectorAll(".reveal-item");
      gsap.from(targets, {
        opacity: 0,
        y: 22,
        duration: 0.75,
        stagger: 0.13,
        ease: "power3.out",
        clearProps: "opacity,transform",
        scrollTrigger: { trigger: node, start: "top 88%", once: true },
      });
    }, node);
    return () => media.revert();
  }, []);
  return ref;
}
