"use client";

import { spinnerVariants } from '../../lib/variants.js';

import * as React from "react"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"



interface SpinnerProps
  extends React.ComponentPropsWithoutRef<"span">,
    VariantProps<typeof spinnerVariants> {
  label?: string
}

const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size, label = "Loading", "aria-hidden": ariaHidden, ...props }, ref) => (
    <span
      {...props}
      ref={ref}
      data-slot="spinner"
      role={ariaHidden === true || ariaHidden === "true" ? undefined : props.role ?? "status"}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden === true || ariaHidden === "true" ? undefined : props["aria-label"] ?? label}
      className={cn(spinnerVariants({ size }), className)}
    >
      <svg
        data-slot="spinner-icon"
        aria-hidden="true"
        focusable="false"
        style={{ width: "100%", height: "100%" }}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
        <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  )
)
Spinner.displayName = "Spinner"

export { Spinner, spinnerVariants }
export type { SpinnerProps }
