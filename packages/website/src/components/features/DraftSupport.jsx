import { Badge } from '@components/ui/badge';
import { Check } from 'lucide-react';

const draftVersions = [
  {
    name: 'Draft 07',
    version: '2017-11',
    status: 'full',
    description: '100% of the official test suite',
    features: ['All core keywords', 'All formats', '$ref', '$id', 'definitions/$defs'],
  },
  {
    name: 'Draft 2019-09',
    version: '2019-09',
    status: 'full',
    description: '100% of the official test suite',
    features: [
      'All Draft 07 keywords',
      '$anchor',
      'unevaluatedProperties / unevaluatedItems',
      '$recursiveRef / $recursiveAnchor',
      '$vocabulary',
      'Cross-draft references',
    ],
  },
  {
    name: 'Draft 2020-12',
    version: '2020-12',
    status: 'full',
    description: '100% of the official test suite',
    features: [
      'All Draft 2019-09 features',
      'prefixItems / items',
      '$dynamicRef / $dynamicAnchor',
      'format-annotation semantics',
    ],
  },
];

const keywordCategories = [
  {
    name: 'Validation',
    keywords: ['type', 'enum', 'const', 'multipleOf', 'maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties', 'minProperties', 'required', 'dependentRequired'],
  },
  {
    name: 'Applicator',
    keywords: ['prefixItems', 'items', 'additionalItems', 'contains', 'additionalProperties', 'properties', 'patternProperties', 'dependentSchemas', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties'],
  },
  {
    name: 'Metadata',
    keywords: ['title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples'],
  },
  {
    name: 'Format',
    keywords: ['format', 'date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex'],
  },
  {
    name: 'Reference',
    keywords: ['$ref', '$defs', '$anchor', '$id', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', '$schema'],
  },
  {
    name: 'Instance data',
    keywords: ['data (data-ref)', '$data'],
  },
  {
    name: 'Extensions',
    keywords: ['$query (cross-field assertions)'],
  },
];

function DraftSupport() {
  return (
    <div className="space-y-8">
      {/* Draft Versions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {draftVersions.map((draft) => (
          <div
            key={draft.name}
            className="rounded-lg border p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">{draft.name}</h3>
              <Badge variant="success">Complete</Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{draft.version}</p>
            <p className="text-sm text-muted-foreground mb-3">{draft.description}</p>
            <ul className="text-sm space-y-1">
              {draft.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-muted-foreground">
                  <Check className="h-3 w-3 text-green-500 shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Conformance Notice */}
      <div className="rounded-lg border border-dashed p-4 bg-muted/30">
        <h4 className="font-medium mb-2 flex items-center gap-2">
          <Check className="h-4 w-4 text-green-500" />
          Full conformance
        </h4>
        <p className="text-sm text-muted-foreground">
          Jaren passes 100% of the official{' '}
          <a
            className="text-primary hover:underline"
            href="https://github.com/json-schema-org/JSON-Schema-Test-Suite"
            target="_blank"
            rel="noreferrer"
          >
            JSON-Schema-Test-Suite
          </a>{' '}
          — including the optional format suites — for draft-07, 2019-09 and 2020-12.
        </p>
      </div>

      {/* Keyword Categories */}
      <div>
        <h3 className="font-semibold mb-4">Supported Keywords by Category</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {keywordCategories.map((category) => (
            <div key={category.name} className="rounded-lg border p-4">
              <h4 className="font-medium mb-3">{category.name}</h4>
              <div className="flex flex-wrap gap-1.5">
                {category.keywords.map((keyword) => (
                  <Badge key={keyword} variant="secondary" className="text-xs">
                    {keyword}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { DraftSupport, draftVersions, keywordCategories };
