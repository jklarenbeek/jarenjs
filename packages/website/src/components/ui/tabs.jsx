import * as React from 'react';
import { cn } from '@lib/utils';

const TabsContext = React.createContext(null);

function Tabs({ defaultValue, value, onValueChange, children, className }) {
  const [tabValue, setTabValue] = React.useState(value || defaultValue);
  
  const currentValue = value !== undefined ? value : tabValue;
  
  const handleValueChange = React.useCallback((newValue) => {
    setTabValue(newValue);
    onValueChange?.(newValue);
  }, [onValueChange]);
  
  return (
    <TabsContext.Provider value={{ value: currentValue, onValueChange: handleValueChange }}>
      <div className={cn('w-full', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

function TabsList({ className, children }) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-10 items-center justify-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  );
}

function TabsTrigger({ className, value, children }) {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error('TabsTrigger must be used within Tabs');

  const isActive = context.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => context.onValueChange(value)}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        isActive
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'hover:bg-background/80 hover:text-foreground hover:shadow-sm',
        className
      )}
    >
      {children}
    </button>
  );
}

function TabsContent({ className, value, children }) {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error('TabsContent must be used within Tabs');
  
  const isActive = context.value === value;
  
  if (!isActive) return null;
  
  return (
    <div
      role="tabpanel"
      className={cn(
        'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className
      )}
    >
      {children}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
