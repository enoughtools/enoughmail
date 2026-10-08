"use client";

import React from 'react';
import { cn } from '../../lib/utils.js';

export interface GroupLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  accent?: boolean;
  onInk?: boolean;
  marker?: boolean;
}

export function GroupLabel({ children, accent = false, onInk = false, marker = false, className, ...props }: GroupLabelProps) {
  const textColorClass = onInk
    ? (accent ? 'text-[var(--color-accent-on-ink)]' : 'text-[var(--color-dark-text-3)]')
    : (accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-3)]');

  return (
    <div
      className={cn(
        "flex items-center gap-[12px] font-sans text-[10px] uppercase tracking-[0.12em]",
        textColorClass,
        className
      )}
      {...props}
    >
      {marker && (
        <span
          className={cn(
            "inline-block box-border w-[8px] h-[8px]",
            accent ? "bg-[var(--color-accent)] border-none" : `border border-current bg-transparent`
          )}
        />
      )}
      {children}
    </div>
  );
}
