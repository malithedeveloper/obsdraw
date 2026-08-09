"use client";
import { useEffect } from "react";
export default function ZoomBlocker() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      const c = e.code;
      const keyHit = k === "+" || k === "=" || k === "-" || k === "_" || k === "0" || k === "Add" || k === "Subtract";
      const codeHit = c === "NumpadAdd" || c === "NumpadSubtract" || c === "Numpad0" || c === "Equal" || c === "Minus" || c === "Digit0";
      if (ctrl && (keyHit || codeHit)) {
        e.preventDefault();
      }
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
    };
    const onGestureChange = (e: Event) => { e.preventDefault(); };
    const onGestureEnd = (e: Event) => { e.preventDefault(); };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches && e.touches.length > 1) {
        e.preventDefault();
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("gesturestart", onGestureStart as EventListener, { passive: false } as AddEventListenerOptions);
    window.addEventListener("gesturechange", onGestureChange as EventListener, { passive: false } as AddEventListenerOptions);
    window.addEventListener("gestureend", onGestureEnd as EventListener, { passive: false } as AddEventListenerOptions);
    window.addEventListener("touchmove", onTouchMove as EventListener, { passive: false } as AddEventListenerOptions);
    return () => {
      window.removeEventListener("wheel", onWheel as EventListener);
      window.removeEventListener("keydown", onKeyDown as EventListener);
      window.removeEventListener("gesturestart", onGestureStart as EventListener);
      window.removeEventListener("gesturechange", onGestureChange as EventListener);
      window.removeEventListener("gestureend", onGestureEnd as EventListener);
      window.removeEventListener("touchmove", onTouchMove as EventListener);
    };
  }, []);
  return null;
}
