import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@components/ui/card';
import { cn } from '@lib/utils';

function FeatureCard({ icon: Icon, title, description, className }) {
  return (
    <Card className={cn('h-full', className)}>
      <CardHeader>
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
          )}
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-sm leading-relaxed">
          {description}
        </CardDescription>
      </CardContent>
    </Card>
  );
}

function FeatureGrid({ features }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {features.map((feature, index) => (
        <FeatureCard key={index} {...feature} />
      ))}
    </div>
  );
}

export { FeatureCard, FeatureGrid };
