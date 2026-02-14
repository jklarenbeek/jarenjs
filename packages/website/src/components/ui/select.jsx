import * as React from 'react';
import { cn } from '@lib/utils';
import { ChevronDown } from 'lucide-react';

const Select = React.forwardRef(({ className, children, ...props }, ref) => {
  return (
    <div className="relative">
      <select
        className={cn(
          'flex h-10 w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 pointer-events-none text-muted-foreground" />
    </div>
  );
});
Select.displayName = 'Select';

export { Select };
