import * as React from 'react';
import { cn } from '../../lib/utils.js';
import { calloutStyles } from '../../lib/callout.js';

export interface CalloutProps extends React.ComponentProps<'aside'> {
  label: string;
  tone?: 'accent' | 'warn';
}

export function Callout({ label, tone = 'accent', className, children, ...props }: CalloutProps) {
  return <aside {...props} className={cn(calloutStyles.root, calloutStyles[tone], className)}>
    <span className={calloutStyles.label}>{label}</span>
    <div className={calloutStyles.content}>{children}</div>
  </aside>;
}
