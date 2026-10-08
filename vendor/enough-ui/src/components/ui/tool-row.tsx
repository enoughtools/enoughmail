"use client";

import React from 'react';
import { cn } from '../../lib/utils.js';

export interface ToolRowProps {
  domain?: string;
  tile?: string;
  icon?: React.ReactNode;
  title: string;
  meta?: string;
  metaColor?: string;
  action?: string;
  actionAccent?: boolean;
  surface?: 'light' | 'selected' | 'dark' | 'gap' | 'transparent';
  onClick?: () => void;
  className?: string;
}

import { surfaces, metaColors } from '../../lib/tool-row.js';

export function ToolRow({ domain, tile, icon, title, meta, metaColor, action, actionAccent = false, surface = 'light', onClick, className }: ToolRowProps) {
  const onDark = surface === 'dark' || surface === 'gap';
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (onClick && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn(
        "flex items-center w-full gap-[13px] font-sans",
        surface !== 'transparent' && "px-[16px] py-[13px]",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]",
        onClick && (onDark
          ? "hover:bg-[var(--color-ink)] active:bg-[var(--color-ink-border)]"
          : "hover:bg-[var(--color-hover)] active:bg-[var(--color-active)]"),
        surfaces[surface],
        className
      )}
    >
      {icon ? (
        <span className="flex w-[22px] h-[22px] items-center justify-center">
          {icon}
        </span>
      ) : domain ? (
        <img src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`} width={22} height={22} alt="" />
      ) : (
        <span
          className={cn(
            "flex w-[22px] h-[22px] items-center justify-center text-[11px] font-bold border",
            onDark
              ? "border-[var(--color-dark-text-3)] text-[var(--color-dark-text-2)]"
              : "border-[var(--color-ink)] text-[var(--color-ink)]"
          )}
        >
          {tile || 'P'}
        </span>
      )}

      <div className="flex-1 text-left">
        <div className="text-[15px] font-semibold">{title}</div>
        {meta && (
          <div
            className="text-[12px]"
            style={{ color: metaColor }}
          >
            <span className={cn(!metaColor && metaColors[surface])}>{meta}</span>
          </div>
        )}
      </div>

      {action && (
        <span
          className={cn(
            "font-sans text-[11px] uppercase tracking-[0.08em] whitespace-nowrap",
            actionAccent
              ? (onDark ? "text-[var(--color-accent-on-ink)]" : "text-[var(--color-accent)]")
              : (onDark ? "text-[var(--color-dark-text-3)]" : "text-[var(--color-text-4)]")
          )}
        >
          {action}
        </span>
      )}
    </div>
  );
}
