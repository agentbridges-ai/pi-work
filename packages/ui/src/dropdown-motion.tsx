import {
  default as React,
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export const DROPDOWN_ENTER_DURATION_MS = 150;
export const DROPDOWN_EXIT_DURATION_MS = 100;

type DropdownMotionPhase = "entered" | "entering" | "exiting" | "unmounted";

export interface DropdownMotionProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  open: boolean;
  placement?: "bottom" | "left" | "right" | "top";
}

/**
 * Keeps hand-authored dropdowns mounted long enough to match HeroUI Select's
 * enter/exit motion. HeroUI and Radix overlays use the same CSS class directly.
 */
export const DropdownMotion = forwardRef<HTMLDivElement, DropdownMotionProps>(
  function DropdownMotion({ children, className = "", open, placement = "bottom", ...props }, ref) {
    const [phase, setPhase] = useState<DropdownMotionPhase>("unmounted");
    const phaseRef = useRef<DropdownMotionPhase>("unmounted");
    const frameRef = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useLayoutEffect(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      if (open) {
        if (phaseRef.current === "unmounted") {
          phaseRef.current = "entering";
          setPhase("entering");
          frameRef.current = requestAnimationFrame(() => {
            phaseRef.current = "entered";
            setPhase("entered");
          });
        } else {
          // Reverse an in-progress exit from its current computed style instead
          // of restarting an entrance at opacity 0.
          phaseRef.current = "entered";
          setPhase("entered");
        }
      } else {
        if (phaseRef.current !== "unmounted") {
          phaseRef.current = "exiting";
          setPhase("exiting");
          timerRef.current = setTimeout(() => {
            phaseRef.current = "unmounted";
            setPhase("unmounted");
          }, DROPDOWN_EXIT_DURATION_MS);
        }
      }
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      };
    }, [open]);

    if (phase === "unmounted") return null;

    return (
      <div
        {...props}
        ref={ref}
        aria-hidden={open ? props["aria-hidden"] : true}
        className={`piwork-dropdown-motion ${className}`}
        data-dropdown-presence="true"
        data-entering={phase === "entering" || undefined}
        data-exiting={phase === "exiting" || undefined}
        data-placement={placement}
        inert={!open || undefined}
      >
        {children}
      </div>
    );
  },
);
