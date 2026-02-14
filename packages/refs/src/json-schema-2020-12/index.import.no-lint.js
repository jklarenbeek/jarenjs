import metaSchema from './schema.json' with { type: 'json' };
import applicator from './meta/applicator.json' with { type: 'json' };
import unevaluated from './meta/unevaluated.json' with { type: 'json' };
import content from './meta/content.json' with { type: 'json' };
import core from './meta/core.json' with { type: 'json' };
import formatAnnotation from './meta/format-annotation.json' with { type: 'json' };
import formatAssertion from './meta/format-assertion.json' with { type: 'json' };
import metadata from './meta/meta-data.json' with { type: 'json' };
import validation from './meta/validation.json' with { type: 'json' };

export default {
  metaSchema,
  applicator,
  unevaluated,
  content,
  core,
  formatAnnotation,
  formatAssertion,
  metadata,
  validation,
}
