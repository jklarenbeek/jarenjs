import { Badge } from '@components/ui/badge';
import { Check, Minus } from 'lucide-react';

const draftVersions = [
  {
    name: 'Draft 07',
    version: '2017-11',
    status: 'full',
    description: 'Complete support for all keywords',
    features: ['All core keywords', 'All formats', '$ref', '$id', 'definitions/$defs'],
  },
  {
    name: 'Draft 2019-09',
    version: '2019-09',
    status: 'partial',
    description: 'Full support except new dynamic reference keywords',
    features: [
      'All Draft 07 keywords',
      '$anchor',
      ' deprecated',
      ' readOnly/writeOnly',
      ' Unevaluated* (in progress)',
      ' $recursiveRef/$recursiveAnchor (in progress)',
    ],
  },
  {
    name: 'Draft 2020-12',
    version: '2020-12',
    status: 'partial',
    description: 'Full support except new dynamic reference keywords',
    features: [
      'All Draft 2019-09 features',
      'prefixItems',
      'type: null',
      ' $dynamicRef/$dynamicAnchor (in progress)',
      ' $vocabulary (in progress)',
    ],
  },
];

const unsupportedKeywords = [
  { name: 'unevaluatedItems', draft: '2019-09', status: 'in-progress' },
  { name: 'unevaluatedProperties', draft: '2019-09', status: 'in-progress' },
  { name: 'propertyDependencies', draft: '2020-12', status: 'in-progress' },
  { name: '$recursiveRef', draft: '2019-09', status: 'in-progress', note: 'deprecated in 2020-12' },
  { name: '$recursiveAnchor', draft: '2019-09', status: 'in-progress', note: 'deprecated in 2020-12' },
  { name: '$dynamicRef', draft: '2020-12', status: 'in-progress' },
  { name: '$dynamicAnchor', draft: '2020-12', status: 'in-progress' },
  { name: '$vocabulary', draft: '2020-12', status: 'in-progress' },
];

const keywordCategories = [
  {
    name: 'Validation',
    keywords: ['type', 'enum', 'const', 'multipleOf', 'maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum', 'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxProperties', 'minProperties', 'required', 'dependentRequired'],
  },
  {
    name: 'Applicator',
    keywords: ['prefixItems', 'items', 'contains', 'additionalProperties', 'properties', 'patternProperties', 'dependentSchemas', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'],
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
    keywords: ['$ref', '$defs', '$anchor', '$id'],
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
              <Badge variant={draft.status === 'full' ? 'success' : 'secondary'}>
                {draft.status === 'full' ? 'Complete' : 'Partial'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-3">{draft.version}</p>
            <p className="text-sm text-muted-foreground mb-3">{draft.description}</p>
            <ul className="text-sm space-y-1">
              {draft.features.map((feature) => (
                <li key={feature} className={`flex items-center gap-2 ${feature.startsWith(' ') ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>
                  {feature.startsWith(' ') ? (
                    <Minus className="h-3 w-3 text-amber-500" />
                  ) : (
                    <Check className="h-3 w-3 text-green-500" />
                  )}
                  {feature.trim()}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Limitations Notice */}
      <div className="rounded-lg border border-dashed p-4 bg-muted/30">
        <h4 className="font-medium mb-2 flex items-center gap-2">
          <span className="text-amber-500">⚠</span>
          Keywords In Progress
        </h4>
        <p className="text-sm text-muted-foreground mb-3">
          The following keywords from Draft 2019-09 and 2020-12 are not yet supported:
        </p>
        <div className="flex flex-wrap gap-2">
          {unsupportedKeywords.map((kw) => (
            <span
              key={kw.name}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100"
              title={kw.note || `Draft ${kw.draft}`}
            >
              {kw.name}
            </span>
          ))}
        </div>
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

export { DraftSupport, draftVersions, keywordCategories, unsupportedKeywords };
