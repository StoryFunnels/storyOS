import { Children, isValidElement } from 'react';
import type { ReactNode } from 'react';
import type { MenuOption } from '@/components/ui/menu-select';

/**
 * #1114 — the items of a menu, read off `<option>` children: value, label and disabled. Lets a
 * picker keep the `<option>` form its call sites already use while the menu itself is the
 * product's own (ui/menu-select.tsx), not the browser's popup. Anything that is not an element
 * with a value (a stray string, null from a conditional) is skipped.
 */
export function optionsFromChildren(children: ReactNode): MenuOption[] {
  return Children.toArray(children).flatMap((child): MenuOption[] =>
    isValidElement<{ value?: string; disabled?: boolean; children?: ReactNode }>(child) && child.props.value !== undefined
      ? [{ value: String(child.props.value), label: child.props.children, disabled: child.props.disabled }]
      : [],
  );
}
