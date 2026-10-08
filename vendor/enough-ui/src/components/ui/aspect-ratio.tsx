"use client";

import * as React from "react";
import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";
import { cn } from "../../lib/utils.js";
import { normalizeAspectRatio, aspectRatioClasses } from "../../lib/minor-presentation.js";

interface AspectRatioProps
  extends React.ComponentPropsWithoutRef<typeof AspectRatioPrimitive.Root> {}

const AspectRatio = React.forwardRef<
  React.ElementRef<typeof AspectRatioPrimitive.Root>,
  AspectRatioProps
>(({ ratio = 1, className, ...props }, ref) => (
  <AspectRatioPrimitive.Root
    ref={ref}
    ratio={normalizeAspectRatio(ratio)}
    data-slot="aspect-ratio"
    className={cn(aspectRatioClasses.inner, className)}
    {...props}
  />
));
AspectRatio.displayName = AspectRatioPrimitive.Root.displayName;

export { AspectRatio };
export type { AspectRatioProps };
