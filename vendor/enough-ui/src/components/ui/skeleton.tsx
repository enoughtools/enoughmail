"use client";

import { presentation } from '../../lib/presentation.js';

import * as React from "react"

import { cn } from "../../lib/utils.js"

function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        presentation.Skeleton,
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
