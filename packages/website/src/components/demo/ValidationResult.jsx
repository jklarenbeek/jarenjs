import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { AlertCircle, CheckCircle, Info } from 'lucide-react';
import { cn } from '@lib/utils';

function ValidationResult({ isValid, errors, className }) {
  const hasResult = isValid !== null;

  return (
    <Card className={cn('h-full', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          Validation Result
          {hasResult && (
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
        {!hasResult ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Info className="h-12 w-12 mb-4 opacity-50" />
            <p>Compile a schema and validate data to see results</p>
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
  const { keyword, instancePath, schemaPath, message, params } = error;
  
  return (
    <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-destructive">
            {message || `Validation failed for keyword '${keyword}'`}
          </p>
          
          {instancePath && (
            <p className="text-xs text-muted-foreground mt-1">
              Path: <code className="bg-background px-1 rounded">{instancePath}</code>
            </p>
          )}
          
          {keyword && (
            <p className="text-xs text-muted-foreground mt-1">
              Keyword: <code className="bg-background px-1 rounded">{keyword}</code>
            </p>
          )}
          
          {params && Object.keys(params).length > 0 && (
            <div className="mt-2 text-xs">
              <p className="text-muted-foreground mb-1">Parameters:</p>
              <div className="bg-background rounded p-2 font-mono overflow-x-auto">
                {Object.entries(params).map(([key, value]) => (
                  <div key={key} className="flex gap-2">
                    <span className="text-primary">{key}:</span>
                    <span className="text-foreground">
                      {typeof value === 'object' 
                        ? JSON.stringify(value) 
                        : String(value)
                      }
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { ValidationResult };
