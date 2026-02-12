import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec2f64 } from '@jarenjs/core/calc';

describe('Vec2f64', () => {
  describe('constructor and new', () => {
    it('should create a new Vec2f64 with default values', () => {
      const v = new Vec2f64();
      assert.equal(v.x, 0);
      assert.equal(v.y, 0);
    });

    it('should create a new Vec2f64 with specified values', () => {
      const v = new Vec2f64(3, 4);
      assert.equal(v.x, 3);
      assert.equal(v.y, 4);
    });

    it('should create a new Vec2f64 from another Vec2f64', () => {
      const v1 = new Vec2f64(3, 4);
      const v2 = Vec2f64.new(v1);
      assert.equal(v2.x, 3);
      assert.equal(v2.y, 4);
    });
  });

  describe('static methods', () => {
    it('should negate a vector', () => {
      const v = new Vec2f64(3, 4);
      const result = Vec2f64.neg(v);
      assert.equal(result.x, -3);
      assert.equal(result.y, -4);
    });

    it('should apply ceil, floor, and round to a vector', () => {
      const v = new Vec2f64(1.3, 2.7);
      const ceil = Vec2f64.ceil(v);
      const floor = Vec2f64.floor(v);
      const round = Vec2f64.round(v);
      
      assert.deepEqual(ceil, new Vec2f64(2, 3));
      assert.deepEqual(floor, new Vec2f64(1, 2));
      assert.deepEqual(round, new Vec2f64(1, 3));
    });

    it('should return the minimum and maximum of two vectors', () => {
      const v1 = new Vec2f64(1, 4);
      const v2 = new Vec2f64(3, 2);
      const min = Vec2f64.min(v1, v2);
      const max = Vec2f64.max(v1, v2);
      
      assert.deepEqual(min, new Vec2f64(1, 2));
      assert.deepEqual(max, new Vec2f64(3, 4));
    });

    it('should invert a vector', () => {
      const v = new Vec2f64(2, 4);
      const result = Vec2f64.inv(v);
      assert.equal(result.x, 0.5);
      assert.equal(result.y, 0.25);
    });

    it('should add two vectors', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(3, 4);
      const result = Vec2f64.add(v1, v2);
      assert.equal(result.x, 4);
      assert.equal(result.y, 6);
    });

    it('should add a scalar to a vector', () => {
      const v = new Vec2f64(1, 2);
      const result = Vec2f64.adds(v, 3);
      assert.equal(result.x, 4);
      assert.equal(result.y, 5);
    });

    it('should add a scaled vector to another vector', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(3, 4);
      const result = Vec2f64.addms(v1, v2, 2);
      assert.equal(result.x, 7);
      assert.equal(result.y, 10);
    });

    it('should subtract two vectors', () => {
      const v1 = new Vec2f64(3, 4);
      const v2 = new Vec2f64(1, 2);
      const result = Vec2f64.sub(v1, v2);
      assert.equal(result.x, 2);
      assert.equal(result.y, 2);
    });

    it('should subtract a scalar from a vector', () => {
      const v = new Vec2f64(5, 6);
      const result = Vec2f64.subs(v, 2);
      assert.equal(result.x, 3);
      assert.equal(result.y, 4);
    });

    it('should multiply two vectors', () => {
      const v1 = new Vec2f64(2, 3);
      const v2 = new Vec2f64(4, 5);
      const result = Vec2f64.mul(v1, v2);
      assert.equal(result.x, 8);
      assert.equal(result.y, 15);
    });

    it('should divide two vectors', () => {
      const v1 = new Vec2f64(8, 15);
      const v2 = new Vec2f64(2, 3);
      const result = Vec2f64.div(v1, v2);
      assert.equal(result.x, 4);
      assert.equal(result.y, 5);
    });

    it('should calculate the magnitude squared of a vector', () => {
      const v = new Vec2f64(3, 4);
      const result = Vec2f64.mag2(v);
      assert.equal(result, 25);
    });

    it('should calculate the magnitude of a vector', () => {
      const v = new Vec2f64(3, 4);
      const result = Vec2f64.mag(v);
      assert.equal(result, 5);
    });

    it('should calculate the dot product of two vectors', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(3, 4);
      const result = Vec2f64.dot(v1, v2);
      assert.equal(result, 11);
    });

    it('should calculate the cross product of two vectors', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(3, 4);
      const result = Vec2f64.cross(v1, v2);
      assert.equal(result, -2);
    });

    it('should normalize a vector', () => {
      const v = new Vec2f64(3, 4);
      const result = Vec2f64.unit(v);
      assert.equal(result.x, 0.6);
      assert.equal(result.y, 0.8);
    });

    it('should rotate a vector', () => {
      const v = new Vec2f64(1, 0);
      const result = Vec2f64.rotate(v, Math.PI / 2);
      assert.equal(result.x.toFixed(6), '0.000000');
      assert.equal(result.y.toFixed(6), '1.000000');
    });

    it('should linearly interpolate between two vectors', () => {
      const v1 = new Vec2f64(0, 0);
      const v2 = new Vec2f64(10, 10);
      const result = Vec2f64.lerp(0.5, v1, v2);
      assert.equal(result.x, 5);
      assert.equal(result.y, 5);
    });

    it('should check if two vectors are equal within epsilon', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(1.0000001, 2.0000001);
      const v3 = new Vec2f64(1.1, 2.1);
      
      assert.ok(Vec2f64.equals(v1, v2));
      assert.ok(!Vec2f64.equals(v1, v3));
    });

    it('should calculate the distance and squared distance between two vectors', () => {
      const v1 = new Vec2f64(0, 0);
      const v2 = new Vec2f64(3, 4);
      
      assert.equal(Vec2f64.dist(v1, v2), 5);
      assert.equal(Vec2f64.dist2(v1, v2), 25);
    });

  });

  describe('instance methods', () => {
    it('should negate a vector in place', () => {
      const v = new Vec2f64(3, 4);
      v.ineg();
      assert.equal(v.x, -3);
      assert.equal(v.y, -4);
    });

    it('should add another vector in place', () => {
      const v1 = new Vec2f64(1, 2);
      const v2 = new Vec2f64(3, 4);
      v1.iadd(v2);
      assert.equal(v1.x, 4);
      assert.equal(v1.y, 6);
    });

    it('should subtract another vector in place', () => {
      const v1 = new Vec2f64(3, 4);
      const v2 = new Vec2f64(1, 2);
      v1.isub(v2);
      assert.equal(v1.x, 2);
      assert.equal(v1.y, 2);
    });

    it('should multiply by a scalar in place', () => {
      const v = new Vec2f64(2, 3);
      v.imuls(2);
      assert.equal(v.x, 4);
      assert.equal(v.y, 6);
    });

    it('should divide by a scalar in place', () => {
      const v = new Vec2f64(4, 6);
      v.idivs(2);
      assert.equal(v.x, 2);
      assert.equal(v.y, 3);
    });

    it('should calculate the magnitude of the vector', () => {
      const v = new Vec2f64(3, 4);
      const result = v.mag();
      assert.equal(result, 5);
    });

    it('should normalize the vector in place', () => {
      const v = new Vec2f64(3, 4);
      v.iunit();
      assert.equal(v.x, 0.6);
      assert.equal(v.y, 0.8);
    });

    it.skip('should rotate the vector in place', () => {
      const v = new Vec2f64(1, 0);
      v.irotate(Math.PI / 2);
      assert.equal(v.x.toFixed(6), '0.000000');
      assert.equal(v.y.toFixed(6), '1.000000');
    });

    it.skip('should rotate the vector in place (approximation)', () => {
      const v = new Vec2f64(1, 0);
      v.irotate(Math.PI / 2);
      assert.ok(Math.abs(v.x) < 1e-10); // Check if x is very close to 0
      assert.ok(Math.abs(v.y - 1) < 1e-10); // Check if y is very close to 1
    });

  });
});