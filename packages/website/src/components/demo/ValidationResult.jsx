import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { AlertCircle, CheckCircle, Info, FileWarning } from 'lucide-react';
import { cn } from '@lib/utils';

function ValidationResult({ isValid, errors, compileError, className }) {
  const hasResult = isValid !== null;

  return (
    <Card className={cn('h-full', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          Validation Result
          {hasResult && !compileError && (
            <Badge
              variant={isValid ? 'success' : 'destructive'}
              className="ml-2"
            >
              {isValid ? 'Valid' : 'Invalid'}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {compileError ? (
          <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/5 p-4">
            <FileWarning className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-destructive">Schema failed to compile</p>
              <p className="text-sm text-muted-foreground mt-1">{compileError}</p>
            </div>
          </div>
        ) : !hasResult ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Info className="h-12 w-12 mb-4 opacity-50" />
            <p>Edit the schema or data to see live validation results</p>
          </div>
        ) : isValid ? (
          <div className="flex flex-col items-center justify-center py-8 text-success">
            <CheckCircle className="h-16 w-16 mb-4" />
            <p className="text-lg font-medium">Validation Passed</p>
            <p className="text-sm text-muted-foreground mt-2">
              The data conforms to the schema
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">Validation Failed</span>
              <Badge variant="destructive" className="ml-auto">
                {errors?.length || 0} error{errors?.length !== 1 ? 's' : ''}
              </Badge>
            </div>

            {errors && errors.length > 0 && (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {errors.map((error, index) => (
                  <ErrorItem key={index} error={error} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ErrorItem({ error }) {
  const { keyword, instancePath, message, params } = error;
  const paramEntries = params ? Object.entries(params) : [];

  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs font-semibold bg-destructive/10 text-destructive px-1.5 py-0.5 rounded">
              {instancePath || '(root)'}
            </code>
            <p className="font-medium text-destructive">
              {message || `validation failed for keyword '${keyword}'`}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-muted-foreground">
            {keyword && (
              <span>
                keyword <code className="bg-background px-1 rounded">{keyword}</code>
              </span>
            )}
            {paramEntries.map(([key, value]) => (
              <span key={key}>
                {key}{' '}
                <code className="bg-background px-1 rounded">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </code>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { ValidationResult };
