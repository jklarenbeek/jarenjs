import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
  ValidatorOptions,
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const compiler = new JarenValidator();
compiler.addFormats(formats.geoFormats);

describe('Schema Geospatial Formats', function () {

  describe('#formatGeohash()', function () {
    const validate = compiler.compile({ format: 'geohash' });

    it('should accept a valid geohash', function () {
      assert.isTrue(validate('u173zqmrfe4'));
    });

    it('should reject alphabet violations', function () {
      assert.isFalse(validate('u17a'));
      assert.isFalse(validate(''));
    });

    it('should ignore non-string values', function () {
      assert.isTrue(validate(42));
      assert.isTrue(validate({ hash: 'u173z' }));
    });
  });

  describe('#formatWkt()', function () {
    const validate = compiler.compile({ format: 'wkt' });

    it('should accept well-formed WKT', function () {
      assert.isTrue(validate('POINT (4.9041 52.3676)'));
      assert.isTrue(validate('GEOMETRYCOLLECTION (POINT (1 2), POLYGON ((0 0, 1 0, 1 1, 0 0)))'));
    });

    it('should reject an open polygon ring', function () {
      assert.isFalse(validate('POLYGON ((0 0, 4 0, 4 4, 1 1))'));
    });

    it('should ignore non-string values', function () {
      assert.isTrue(validate({ type: 'Point', coordinates: [1, 2] }));
    });
  });

  describe('#formatGeoJson()', function () {
    const validate = compiler.compile({ format: 'geojson' });

    it('should accept structurally valid GeoJSON objects', function () {
      assert.isTrue(validate({ type: 'Point', coordinates: [4.9, 52.4] }));
      assert.isTrue(validate({
        type: 'Feature',
        properties: { name: 'square' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }));
    });

    it('should reject the open ring a schema alone cannot', function () {
      assert.isFalse(validate({
        type: 'Polygon',
        coordinates: [[[0, 0], [4, 0], [4, 4], [1, 1]]],
      }));
    });

    it('should ignore non-object values', function () {
      assert.isTrue(validate('POINT (1 2)'));
      assert.isTrue(validate(7));
      assert.isTrue(validate([1, 2]), 'an array is not an object in JSON type terms');
    });

    it('should report an error in collecting mode', function () {
      const collecting = new JarenValidator(new ValidatorOptions({ collectErrors: true }));
      collecting.addFormats(formats.geoFormats);
      const validateErrors = collecting.compile({ format: 'geojson' });
      const result = validateErrors({ type: 'Circle', coordinates: [0, 0] });
      assert.isFalse(result.valid);
      assert.isTrue(result.errors.some((e) => e.keyword === 'format'));
    });
  });
});
