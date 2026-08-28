# shop

Version `5`, compatible with `4`. Generated from the jaren-contract document by @jarenjs/contract — do not edit; regenerate instead.

## Operations

| Operation | Method | Path | Kind | Task | Idempotency |
| --- | --- | --- | --- | --- | --- |
| [`catalog.load`](#catalogload) | `GET` | `/api/catalog` | read | `switch` | `none` |
| [`product.save`](#productsave) | `PUT` | `/api/products/{id}/master` | command | `exhaust` | `required` |
| [`image.bytes`](#imagebytes) | `GET` | `/api/images/{id}` | read | `switch` | `none` |
| [`product.search`](#productsearch) | `GET` | `/api/products` | read | `switch` | `none` |
| [`product.remove`](#productremove) | `POST` | `/product.remove` | command | `exhaust` | `optional` |

## catalog.load

The whole catalog snapshot.

`GET /api/catalog` — a read operation; task `switch`, idempotency `none`, cache `revision`.

### Parameters

| Name | In | Required | Schema |
| --- | --- | --- | --- |
| `since` | query | no | `string` (date-time) |

### Body

None.

### Responses

| Status | Description | Schema |
| --- | --- | --- |
| 200 | Success | [`CatalogLoadOutput`](#catalogloadoutput) |
| 409 | Declared failure `stale` | wire error |

### Errors

| Code | Status | Details |
| --- | --- | --- |
| `stale` | 409 | — |

## product.save

`PUT /api/products/{id}/master` — a command operation; task `exhaust`, idempotency `required`, cache `none`, revision `input:/revision`, retry up to 2 time(s) on `not-found`.

### Parameters

| Name | In | Required | Schema |
| --- | --- | --- | --- |
| `id` | path | yes | `integer` |
| `Idempotency-Key` | header | yes | `string` (the caller-generated idempotency key) |

### Body

`application/json` — an object of the [`ProductSaveInput`](#productsaveinput) members `revision`, `product`.

### Responses

| Status | Description | Schema |
| --- | --- | --- |
| 200 | Success | [`ProductSaveOutput`](#productsaveoutput) |
| 409 | Declared failure `conflict` | wire error |
| 404 | Declared failure `not-found` | wire error |

### Errors

| Code | Status | Details |
| --- | --- | --- |
| `conflict` | 409 | [`ProductSaveConflictDetails`](#productsaveconflictdetails) |
| `not-found` | 404 | — |

## image.bytes

`GET /api/images/{id}` — a read operation (opaque: the response bytes are not decoded by the contract); task `switch`, idempotency `none`, cache `none`.

### Parameters

| Name | In | Required | Schema |
| --- | --- | --- | --- |
| `id` | path | yes | `integer` |

### Body

None.

### Responses

| Status | Description | Schema |
| --- | --- | --- |
| 200 | Success | `application/octet-stream` bytes |

### Errors

None declared.

## product.search

`GET /api/products` — a read operation; task `switch`, idempotency `none`, cache `none`.

### Parameters

| Name | In | Required | Schema |
| --- | --- | --- | --- |
| `q` | query | no | `string` |
| `limit` | query | no | `integer` |
| `tag` | query | no | `array` of `string` |
| `flag` | query | no | `boolean` |

### Body

None.

### Responses

| Status | Description | Schema |
| --- | --- | --- |
| 200 | Success | [`ProductSearchOutput`](#productsearchoutput) |

### Errors

None declared.

## product.remove

`POST /product.remove` — a command operation; task `exhaust`, idempotency `optional`, cache `none`.

### Parameters

| Name | In | Required | Schema |
| --- | --- | --- | --- |
| `Idempotency-Key` | header | no | `string` (the caller-generated idempotency key) |

### Body

`application/json` — [`ProductRemoveInput`](#productremoveinput).

### Responses

| Status | Description | Schema |
| --- | --- | --- |
| 200 | Success | [`ProductRemoveOutput`](#productremoveoutput) |
| 404 | Declared failure `not-found` | wire error |

### Errors

| Code | Status | Details |
| --- | --- | --- |
| `not-found` | 404 | — |

# Types

## DateTime

An RFC 3339 string branded for the date operators;

structurally identical to the @jarenjs/linq and @jarenjs/db brand.

Type: `string and object`

## CatalogLoadInput

| Member | Type | Required |
| --- | --- | --- |
| `since` | `DateTime` | no |

## Product

| Member | Type | Required |
| --- | --- | --- |
| `id` | `number` | yes |
| `name` | `string` | yes |
| `price` | `number` | yes |
| `tags` | `array of string` | no |

## Catalog

| Member | Type | Required |
| --- | --- | --- |
| `revision` | `number` | yes |
| `products` | `array of Product` | yes |

## CatalogLoadOutput

Type: `Catalog`

## ProductSaveInput

| Member | Type | Required |
| --- | --- | --- |
| `id` | `number` | yes |
| `revision` | `number` | yes |
| `product` | `Product` | yes |

## ProductSaveOutput

Type: `Product`

## Conflict

| Member | Type | Required |
| --- | --- | --- |
| `current` | `Product` | yes |

## ProductSaveConflictDetails

Type: `Conflict`

## ImageBytesInput

| Member | Type | Required |
| --- | --- | --- |
| `id` | `number` | yes |

## ImageBytesOutput

Type: `any`

## ProductSearchInput

| Member | Type | Required |
| --- | --- | --- |
| `q` | `string` | no |
| `limit` | `number` | no |
| `tag` | `array of string` | no |
| `flag` | `boolean` | no |

## ProductSearchOutput

Type: `array of Product`

## ProductRemoveInput

| Member | Type | Required |
| --- | --- | --- |
| `id` | `number` | yes |

## ProductRemoveOutput

Type: `any`

