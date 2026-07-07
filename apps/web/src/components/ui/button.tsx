import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-control)] text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-[var(--text-on-dark)] hover:bg-primary-hover',
        secondary: 'bg-card border border-border-default text-ink hover:bg-hover',
        ghost: 'text-ink-secondary hover:bg-hover',
        destructive: 'border border-error text-error hover:bg-error hover:text-white',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-7 px-2.5 text-[13px]',
        lg: 'h-10 px-5',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
