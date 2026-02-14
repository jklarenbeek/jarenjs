import { cn } from '@lib/utils';

function Container({ className, children, size = 'default' }) {
  const sizeClasses = {
    sm: 'max-w-3xl',
    default: 'max-w-7xl',
    lg: 'max-w-8xl',
    full: 'max-w-full',
  };
  
  return (
    <div className={cn('container mx-auto px-4 sm:px-6 lg:px-8', sizeClasses[size], className)}>
      {children}
    </div>
  );
}

export { Container };
