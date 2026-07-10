import * as React from 'react';
import { cn, copyToClipboard } from '@lib/utils';
import { Button } from './button';
import { Copy, Check } from 'lucide-react';

function CodeBlock({ className, children, showCopy = true }) {
  const [copied, setCopied] = React.useState(false);
  
  const handleCopy = async () => {
    const text = typeof children === 'string' ? children : '';
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  
  return (
    <div className={cn('relative group rounded-md bg-slate-950', className)}>
      {showCopy && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 hover:bg-slate-700 text-slate-400"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      )}
      <pre className="p-4 overflow-x-auto text-sm text-slate-50 font-mono">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function InlineCode({ className, children }) {
  return (
    <code
      className={cn(
        'relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm',
        className
      )}
    >
      {children}
    </code>
  );
}

export { CodeBlock, InlineCode };
