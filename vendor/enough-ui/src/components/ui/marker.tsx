"use client";

import { markerVariants } from '../../lib/variants.js';

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils.js"
import { apiPresentation } from '../../lib/api-presentation.js'



interface MarkerProps
  extends React.ComponentPropsWithoutRef<"mark">,
    VariantProps<typeof markerVariants> {
  asChild?: boolean
}

const Marker = React.forwardRef<HTMLElement, MarkerProps>(
  ({ asChild = false, className, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : variant === "border" || variant === "separator" ? "div" : "mark"

    return (
      <Comp
        ref={ref as React.Ref<HTMLDivElement>}
        data-slot="marker"
        data-variant={variant ?? "default"}
        className={cn(markerVariants({ size, variant }), className)}
        {...props}
      />
    )
  }
)
Marker.displayName = "Marker"

const MarkerContent = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span ref={ref} data-slot="marker-content" className={cn(apiPresentation.MarkerContent, className)} {...props} />
  )
)
MarkerContent.displayName = "MarkerContent"

const MarkerIcon = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span ref={ref} data-slot="marker-icon" aria-hidden="true" className={cn(apiPresentation.MarkerIcon, className)} {...props} />
  )
)
MarkerIcon.displayName = "MarkerIcon"

export { Marker, MarkerContent, MarkerIcon, markerVariants }
export type { MarkerProps }
