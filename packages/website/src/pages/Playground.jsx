import { Container } from '@components/layout/Container';
import { LiveValidator } from '@components/demo/LiveValidator';

function Playground() {
  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Playground</h1>
          <p className="text-muted-foreground">
            Test JSON Schema validation in real-time. Edit the schema and data to see validation results instantly.
          </p>
        </div>
        
        <LiveValidator />
      </Container>
    </div>
  );
}

export { Playground };
