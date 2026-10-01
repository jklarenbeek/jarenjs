// Derived from the English catalogs by scripts/generate-message-pen.js.
import { deepFreeze } from '@jarenjs/core/object';
/** Canonical parameter names, grouped by their owning English catalog. */
export const CATALOGS = deepFreeze({
  "validate": {
    "type": [
      "type",
      "types"
    ],
    "required": [
      "missingProperty"
    ],
    "minimum": [
      "comparison",
      "limit"
    ],
    "maximum": [
      "comparison",
      "limit"
    ],
    "exclusiveMinimum": [
      "comparison",
      "limit"
    ],
    "exclusiveMaximum": [
      "comparison",
      "limit"
    ],
    "multipleOf": [
      "multipleOf"
    ],
    "minLength": [
      "limit"
    ],
    "maxLength": [
      "limit"
    ],
    "pattern": [
      "pattern"
    ],
    "additionalProperties": [
      "additionalProperty"
    ],
    "minProperties": [
      "limit"
    ],
    "maxProperties": [
      "limit"
    ],
    "minItems": [
      "limit"
    ],
    "maxItems": [
      "limit"
    ],
    "uniqueItems": [],
    "contains": [],
    "items": [],
    "allOf": [],
    "anyOf": [],
    "oneOf": [],
    "not": [],
    "format": [
      "format"
    ],
    "if": [],
    "then": [],
    "else": [],
    "false schema": [],
    "$query": [
      "code",
      "docPath"
    ],
    "JQ2001": [
      "code",
      "docPath"
    ],
    "JQ2003": [
      "code",
      "docPath"
    ]
  },
  "forms": {
    "form/required": [],
    "form/type": [
      "type"
    ],
    "form/const": [
      "constValue"
    ],
    "form/enum": [
      "enumValues"
    ],
    "form/minLength": [
      "len",
      "limit"
    ],
    "form/maxLength": [
      "len",
      "limit"
    ],
    "form/pattern": [
      "pattern"
    ],
    "form/format": [
      "format"
    ],
    "form/minimum": [
      "limit"
    ],
    "form/maximum": [
      "limit"
    ],
    "form/exclusiveMinimum": [
      "limit"
    ],
    "form/exclusiveMaximum": [
      "limit"
    ],
    "form/multipleOf": [
      "multipleOf"
    ],
    "form/minItems": [
      "limit"
    ],
    "form/maxItems": [
      "limit"
    ],
    "form/uniqueItems": [],
    "form/minProperties": [
      "limit"
    ],
    "form/maxProperties": [
      "limit"
    ],
    "x-form/assert": [],
    "form/addItem": [],
    "form/removeItem": [],
    "form/jsonPlaceholder": []
  },
  "contract": {
    "contract/not-found": [],
    "contract/method-not-allowed": [
      "allow"
    ],
    "contract/body-too-large": [
      "limit",
      "op"
    ],
    "contract/unsupported-media": [
      "media",
      "op"
    ],
    "contract/malformed-json": [
      "op"
    ],
    "contract/malformed-body": [
      "op"
    ],
    "contract/invalid-input": [
      "op"
    ],
    "contract/idempotency-key-required": [
      "op"
    ],
    "contract/handler-failed": [
      "op"
    ],
    "contract/idempotency-conflict": [
      "kind",
      "op"
    ],
    "contract/invalid-output": [
      "op"
    ],
    "contract/malformed-path": [],
    "contract/malformed-query": [],
    "contract/not-implemented": [
      "op"
    ],
    "contract/precondition-failed": [
      "op"
    ],
    "contract/invalid-header": [
      "header",
      "op"
    ],
    "contract/handler-error": [
      "code",
      "op"
    ],
    "contract/client-invalid-input": [
      "op"
    ],
    "contract/network": [
      "name",
      "op"
    ],
    "contract/cancelled": [
      "op"
    ],
    "contract/invalid-response": [
      "op"
    ],
    "contract/key-storage-failed": [
      "op"
    ],
    "contract/undeclared-response": [
      "op",
      "status"
    ],
    "contract/not-a-contract": [
      "id"
    ],
    "contract/incompatible": [
      "client",
      "id",
      "server"
    ],
    "contract/host-failed": [
      "op"
    ],
    "contract/local-handler-failed": [
      "op"
    ],
    "contract/unknown-operation": [],
    "contract/port-timeout": [
      "ms",
      "op"
    ],
    "contract/malformed-frame": [
      "op"
    ],
    "contract/channel-closed": [
      "op"
    ],
    "contract/not-a-stream": [
      "op"
    ],
    "contract/invalid-snapshot": [
      "op"
    ],
    "contract/seq-regression": [
      "op"
    ],
    "contract/stream-error": [
      "code",
      "op"
    ],
    "contract/heartbeat-missed": [
      "ms",
      "op"
    ],
    "contract/slow-consumer": [
      "op"
    ],
    "contract/reconnect-exhausted": [
      "attempts",
      "lastCode",
      "op"
    ]
  },
  "query": {
    "query/reason": [
      "reason"
    ],
    "query/detail": [
      "detail"
    ],
    "query/item/sequence": [
      "count"
    ],
    "query/item/empty": [],
    "query/item/null": [],
    "query/item/array": [],
    "query/item/object": [],
    "query/item/string": [],
    "query/item/number": [],
    "query/item/boolean": [],
    "query/item/other": [
      "type"
    ],
    "query/mixed-keys": [],
    "query/unknown-operator": [
      "key"
    ],
    "query/unknown-operator-suggest": [
      "key",
      "suggestion"
    ],
    "query/unknown-operator-use": [
      "key",
      "use"
    ],
    "query/unknown-operator-none": [
      "key"
    ],
    "query/use/head-of-reverse": [],
    "query/use/jsonpath-filter": [],
    "query/use/for-return": [],
    "query/use/for-phrase": [],
    "query/use/sort-objects": [],
    "query/use/sort-scalars": [],
    "query/use/entries-get": [],
    "query/use/geo-parse-text": [],
    "query/use/bbox-intersects": [],
    "query/use/renderer": [],
    "query/use/renderer-project": [],
    "query/use/similarity": [],
    "query/use/knn-desc": [],
    "query/use/knn": [],
    "query/use/top-k": [],
    "query/use/resample-fill": [],
    "query/use/resample-locf": [],
    "query/use/resample-linear": [],
    "query/use/rolling-mean": [],
    "query/phrase-keys": [
      "keys"
    ],
    "query/phrase-alone": [
      "key"
    ],
    "query/operands-array": [
      "op"
    ],
    "query/operands-exactly": [
      "count",
      "min",
      "op"
    ],
    "query/operands-at-least": [
      "count",
      "min",
      "op"
    ],
    "query/operands-range": [
      "count",
      "max",
      "min",
      "op"
    ],
    "query/variable-name-expected": [],
    "query/variable-name-invalid": [
      "name"
    ],
    "query/variable-duplicate": [
      "name"
    ],
    "query/bindings-object": [
      "clause"
    ],
    "query/bindings-empty": [
      "clause"
    ],
    "query/extended-let": [],
    "query/extended-quantifier": [],
    "query/window-kind": [],
    "query/window-size-required": [],
    "query/window-size": [],
    "query/window-step": [],
    "query/window-required": [],
    "query/for-key": [
      "key"
    ],
    "query/for-in-required": [],
    "query/for-at": [],
    "query/for-allowing-empty": [],
    "query/orderby-spec": [],
    "query/orderby-spec-key": [
      "key"
    ],
    "query/orderby-spec-key-required": [],
    "query/orderby-dir": [],
    "query/orderby-empty": [],
    "query/collation-name": [],
    "query/collation-unregistered": [
      "name"
    ],
    "query/fold-binding": [],
    "query/as-object": [],
    "query/as-empty": [],
    "query/as-unbound": [
      "name"
    ],
    "query/count-variable": [],
    "query/map-entry": [],
    "query/call-arguments": [],
    "query/call-unregistered": [
      "name"
    ],
    "query/apply-arguments": [],
    "query/apply-mode": [],
    "query/document-value": [
      "type"
    ],
    "query/invalid-path": [
      "path"
    ],
    "query/invalid-path-detail": [
      "detail",
      "path"
    ],
    "query/unbound-variable": [
      "declared",
      "name"
    ],
    "query/unbound-variable-closed": [
      "name"
    ],
    "query/version-unknown": [
      "version"
    ],
    "query/version-envelope": [],
    "query/schema-no-compiler": [],
    "query/schema-invalid": [
      "detail"
    ],
    "query/schema-no-predicate": [],
    "query/depth-limit": [
      "depth",
      "limit"
    ],
    "query/spec-member-required": [
      "member",
      "name"
    ],
    "query/spec-invalid": [
      "detail",
      "name"
    ],
    "query/date-pattern": [
      "detail"
    ],
    "query/time-bucket-invalid": [
      "detail"
    ],
    "query/lexical-arguments": [],
    "query/lexical-unregistered": [
      "name"
    ],
    "query/lexical-rejected": [],
    "query/lexical-no-request": [],
    "query/series-spec-object": [
      "got",
      "operator"
    ],
    "query/series-spec-member": [
      "allowed",
      "name",
      "operator"
    ],
    "query/series-spec-member-suggest": [
      "allowed",
      "name",
      "operator",
      "suggestion"
    ],
    "query/series-member-enum": [
      "allowed",
      "got",
      "member"
    ],
    "query/series-member-number": [
      "got",
      "member"
    ],
    "query/series-member-instant": [
      "got",
      "member"
    ],
    "query/series-member-duration": [
      "got",
      "member"
    ],
    "query/series-member-path": [
      "got",
      "member"
    ],
    "query/series-member-path-detail": [
      "detail",
      "member"
    ],
    "query/series-member-not-path": [
      "member"
    ],
    "query/series-member-whole-row": [
      "member"
    ],
    "query/series-member-singular": [
      "member"
    ],
    "query/series-zone": [
      "got"
    ],
    "query/series-zone-provider": [
      "zone"
    ],
    "query/series-calendar": [
      "detail"
    ],
    "query/expected-string": [
      "got"
    ],
    "query/expected-number": [
      "got"
    ],
    "query/cast-string": [
      "got"
    ],
    "query/cast-number": [
      "got"
    ],
    "query/not-json-number": [
      "value"
    ],
    "query/arithmetic-operand": [
      "got"
    ],
    "query/aggregate-not-number": [
      "got"
    ],
    "query/aggregate-null": [],
    "query/minmax-mixed": [
      "got"
    ],
    "query/sort-mixed": [
      "got"
    ],
    "query/regex-invalid": [
      "pattern"
    ],
    "query/replace-empty-match": [
      "pattern"
    ],
    "query/range-bounds": [
      "got"
    ],
    "query/range-guard": [
      "count",
      "limit"
    ],
    "query/index-of-item": [
      "got"
    ],
    "query/expected-datetime": [
      "got"
    ],
    "query/no-date-component": [
      "value"
    ],
    "query/no-time-component": [
      "value"
    ],
    "query/calendar-unit": [
      "got"
    ],
    "query/expected-duration": [
      "got"
    ],
    "query/expected-units": [
      "got"
    ],
    "query/expected-date-pattern": [
      "got"
    ],
    "query/datetime-epoch": [
      "got"
    ],
    "query/datetime-range": [
      "value"
    ],
    "query/span-no-date": [],
    "query/expected-bucket-width": [
      "got"
    ],
    "query/expected-geo": [
      "got"
    ],
    "query/expected-wkt": [
      "got"
    ],
    "query/expected-geohash": [
      "got"
    ],
    "query/geohash-precision": [
      "got"
    ],
    "query/simplify-tolerance": [
      "got"
    ],
    "query/expected-vector": [
      "got"
    ],
    "query/expected-vector-item": [
      "got",
      "index"
    ],
    "query/expected-series": [
      "got"
    ],
    "query/expected-interval": [
      "got"
    ],
    "query/member-cardinality": [
      "count",
      "name"
    ],
    "query/groupby-key": [
      "got"
    ],
    "query/lexical-text": [],
    "query/idiv-zero": [],
    "query/mod-zero": [],
    "query/ebv-sequence": [],
    "query/map-key": [
      "got"
    ],
    "query/orderby-key": [
      "got"
    ],
    "query/orderby-number-string": [],
    "query/orderby-string-number": [],
    "query/external-unbound": [
      "name"
    ],
    "query/assert-failed": [
      "got"
    ],
    "query/assert-failed-item": [
      "got",
      "index"
    ],
    "query/as-failed": [
      "got",
      "name"
    ],
    "query/as-failed-item": [
      "got",
      "index",
      "name"
    ],
    "query/fold-limit": [
      "limit"
    ],
    "query/phrase-limit": [
      "limit"
    ],
    "query/steps-limit": [
      "limit"
    ],
    "query/result-limit": [
      "count",
      "limit"
    ],
    "query/function-threw": [
      "detail",
      "name"
    ],
    "query/operator-threw": [
      "detail",
      "name"
    ],
    "query/input-undefined": [],
    "query/lexical-threw": [],
    "query/lexical-result": []
  }
});
