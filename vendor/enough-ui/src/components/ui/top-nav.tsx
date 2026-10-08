"use client";

import React from 'react';
import { Button } from './button.js';
import { cn } from '../../lib/utils.js';

export interface TopNavLink {
  label: string;
  href: string;
}

export interface TopNavProps {
  links?: TopNavLink[];
  active?: string;
  brand?: React.ReactNode;
  homeHref?: string;
  homeLabel?: string;
  skipToHref?: string;
  showLauncher?: boolean;
  launcherLabel?: string;
  /** Optional primary action, rendered as a link unless onCta is supplied. */
  cta?: string;
  ctaHref?: string;
  onCta?: () => void;
  onPalette?: () => void;
  className?: string;
}

export function TopNav({
  links = [],
  active,
  brand = 'EnoughUI',
  homeHref = '/',
  homeLabel = 'Home',
  skipToHref = '#main',
  onPalette,
  showLauncher = Boolean(onPalette),
  launcherLabel = 'Open the launcher',
  cta,
  ctaHref = '/',
  onCta,
  className,
}: TopNavProps) {
  return (
    <header className={cn("border-b border-[var(--color-ink)] bg-[var(--color-paper)] font-sans", className)}>
      <a href={skipToHref} className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-[var(--color-ink)] focus:px-4 focus:py-2 focus:text-[var(--color-dark-text)]">Skip to content</a>
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-6 py-[14px] lg:px-[64px] lg:py-[18px]">
        <a href={homeHref} aria-label={homeLabel} className="font-serif font-bold text-[19px] text-[var(--color-text-main)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-accent)]">
          {brand}
        </a>
        <nav aria-label="Main navigation" className="order-3 -mx-6 flex w-[calc(100%+3rem)] gap-x-5 overflow-x-auto whitespace-nowrap border-t border-[var(--color-hairline)] px-6 pt-3 text-[13px] font-medium lg:order-none lg:mx-0 lg:w-auto lg:gap-x-[28px] lg:overflow-visible lg:border-t-0 lg:px-0 lg:pt-0 lg:text-[14px]">
          {links.map(({ label, href }) => {
            const isActive = active === label;
            return <a key={href + label} href={href} aria-current={isActive ? 'page' : undefined} className={cn(
              "py-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-accent)]",
              isActive
                ? "border-b-2 border-[var(--color-accent)] pb-[2px] text-[var(--color-text-main)]"
                : (active ? "text-[var(--color-text-3)] hover:text-[var(--color-text-main)]" : "text-[var(--color-text-main)] hover:text-[var(--color-text-2)]")
            )}>{label}</a>;
          })}
        </nav>
        <div className="flex items-center gap-[14px]">
          {showLauncher && <button
            type="button"
            data-palette-trigger
            onClick={onPalette}
            aria-keyshortcuts="Meta+K"
            aria-haspopup="dialog"
            className="inline-flex h-[41px] cursor-pointer items-center border border-[var(--color-border-mid)] bg-[var(--color-surface)] px-[14px] font-sans text-[12px] text-[var(--color-text-3)] hover:text-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          >
            <span aria-hidden="true">⌘K launcher</span>
            <span className="sr-only">{launcherLabel}</span>
          </button>}
          {cta && (onCta ? (
            <Button variant="ink" onClick={onCta}>{cta}</Button>
          ) : (
            <Button variant="ink" asChild><a href={ctaHref}>{cta}</a></Button>
          ))}
        </div>
      </div>
    </header>
  );
}
