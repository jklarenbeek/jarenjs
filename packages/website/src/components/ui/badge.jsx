import * as React from 'react';
import { cn } from '@lib/utils';

const badgeVariants = {
  default: 'border-transparent bg-[hsl(var(--primary-hsl))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary-hsl))]/80',
  secondary: 'border-transparent bg-[hsl(var(--secondary-hsl))] text-[hsl(var(--secondary-foreground))] hover:bg-[hsl(var(--secondary-hsl))]/80',
  destructive: 'border-transparent bg-red-500 text-white hover:bg-red-500/80',
  outline: 'text-foreground',
  success: 'border-transparent bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900 dark:text-green-100',
  warning: 'border-transparent bg-yellow-100 text-yellow-800 hover:bg-yellow-200 dark:bg-yellow-900 dark:text-yellow-100',
};

function Badge({ className, variant = 'default', ...props }) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        badgeVariants[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
