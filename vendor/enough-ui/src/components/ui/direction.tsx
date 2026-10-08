"use client";

import * as React from "react";
import {
  DirectionProvider as RadixDirectionProvider,
  useDirection,
} from "@radix-ui/react-direction";
import {
  resolveDirection,
  type Direction,
} from "../../lib/minor-presentation.js";

interface DirectionProviderProps {
  direction?: Direction;
  dir?: Direction;
  children?: React.ReactNode;
}

function DirectionProvider({
  direction,
  dir,
  children,
}: DirectionProviderProps) {
  const resolvedDir = resolveDirection(direction, dir);
  return (
    <RadixDirectionProvider dir={resolvedDir}>
      {children}
    </RadixDirectionProvider>
  );
}

export { DirectionProvider, useDirection };
export type { Direction, DirectionProviderProps };
