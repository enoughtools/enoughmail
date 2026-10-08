import { Checkbox } from '@rebnz/enough-ui/checkbox';
import type { ComponentProps } from 'react';
/** Adapt existing Mail field callbacks while using EnoughUI's accessible checkbox. */
export default function MailCheckbox({ onChange, ...props }: Omit<ComponentProps<typeof Checkbox>, 'onChange' | 'onCheckedChange'> & { onChange?: (event: { target: { checked: boolean } }) => void }) {
  return <Checkbox {...props} onCheckedChange={checked => onChange?.({ target: { checked: checked === true } })} />;
}
