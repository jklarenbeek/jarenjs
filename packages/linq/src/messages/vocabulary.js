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
    "form/removeItem": []
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
  }
});
