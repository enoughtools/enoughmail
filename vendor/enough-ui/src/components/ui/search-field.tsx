"use client";

import React from 'react';
import { cn } from '../../lib/utils.js';

export interface SearchFieldProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  placeholder?: string;
  onActivate?: () => void;
}

/** The hero search field: 2px ink border, hard blue offset shadow, ⌘K hint. It opens the launcher, so it is a button. */
export function SearchField({ placeholder = 'What do you need to ship?', onActivate, className, ...props }: SearchFieldProps) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K"
      className={cn(
        "flex w-full cursor-pointer items-center border-2 border-[var(--color-ink)] bg-[var(--color-surface)] text-left shadow-[var(--shadow-pop)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]",
        className
      )}
      {...props}
    >
      <span className="flex-1 px-[20px] py-[17px] font-sans text-[16px] text-[var(--color-text-4)]">
        {placeholder}
      </span>
      <span aria-hidden="true" className="font-sans text-[12px] text-[var(--color-text-3)] pr-[18px]">
        ⌘K
      </span>
    </button>
  );
}
