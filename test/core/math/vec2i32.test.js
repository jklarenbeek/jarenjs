import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mathi32_MULTIPLIER,
  Vec2i32,
  def_Vec2i32
} from '@jarenjs/core/calc';

describe('Vec2i32', () => {
  describe('Constructor and static methods', () => {
    it('should create a new Vec2i32 instance', () => {
      const v = new Vec2i32(1, 2);
      assert.equal(v.x, 1);
      assert.equal(v.y, 2);
    });

    it('should create a new Vec2i32 instance with default values', () => {
      const v = new Vec2i32();
      assert.equal(v.x, 0);
      assert.equal(v.y, 0);
    });

    it('should create a new Vec2i32 instance using static new method', () => {
      const v = Vec2i32.new(3, 4);
      assert.equal(v.x, 3);
      assert.equal(v.y, 4);
    });

    it('should create a copy of Vec2i32 instance using instance new method', () => {
      const v1 = new Vec2i32(5, 6);
      const v2 = v1.new();
      assert.equal(v2.x, 5);
      assert.equal(v2.y, 6);
      assert.notEqual(v1, v2);
    });
  });

  describe('Static primitive operators', () => {
    it('should negate a vector', () => {
      const v = new Vec2i32(1, -2);
      const result = Vec2i32.neg(v);
      assert.equal(result.x, -1);
      assert.equal(result.y, 2);
    });

    it('should add two vectors', () => {
      const a = new Vec2i32(1, 2);
      const b = new Vec2i32(3, 4);
      const result = Vec2i32.add(a, b);
      assert.equal(result.x, 4);
      assert.equal(result.y, 6);
    });

    it('should add a scalar to a vector', () => {
      const v = new Vec2i32(1, 2);
      const result = Vec2i32.adds(v, 3);
      assert.equal(result.x, 4);
      assert.equal(result.y, 5);
    });

    it('should subtract two vectors', () => {
      const a = new Vec2i32(5, 7);
      const b = new Vec2i32(2, 3);
      const result = Vec2i32.sub(a, b);
      assert.equal(result.x, 3);
      assert.equal(result.y, 4);
    });

    it('should subtract a scalar from a vector', () => {
      const v = new Vec2i32(5, 7);
      const result = Vec2i32.subs(v, 2);
      assert.equal(result.x, 3);
      assert.equal(result.y, 5);
    });

    it('should multiply two vectors', () => {
      const a = new Vec2i32(2, 3);
      const b = new Vec2i32(4, 5);
      const result = Vec2i32.mul(a, b);
      assert.equal(result.x, 8);
      assert.equal(result.y, 15);
    });

    it('should multiply a vector by a scalar', () => {
      const v = new Vec2i32(2, 3);
      const result = Vec2i32.muls(v, 4);
      assert.equal(result.x, 8);
      assert.equal(result.y, 12);
    });

    it('should divide two vectors', () => {
      const a = new Vec2i32(8, 15);
      const b = new Vec2i32(2, 3);
      const result = Vec2i32.div(a, b);
      assert.equal(result.x, 4);
      assert.equal(result.y, 5);
    });

    it('should divide a vector by a scalar', () => {
      const v = new Vec2i32(8, 12);
      const result = Vec2i32.divs(v, 4);
      assert.equal(result.x, 2);
      assert.equal(result.y, 3);
    });
  });

  describe('Static scalar products', () => {
    it('should calculate the magnitude squared of a vector', () => {
      const v = new Vec2i32(3, 4);
      const result = Vec2i32.mag2(v);
      assert.equal(result, 25);
    });

    it('should calculate the magnitude of a vector', () => {
      const v = new Vec2i32(3, 4);
      const result = Vec2i32.mag(v);
      assert.equal(result, 5);
    });

    it('should calculate the dot product of two vectors', () => {
      const a = new Vec2i32(2, 3);
      const b = new Vec2i32(4, 5);
      const result = Vec2i32.dot(a, b);
      assert.equal(result, 23);
    });

    it('should calculate the cross product of two vectors', () => {
      const a = new Vec2i32(2, 3);
      const b = new Vec2i32(4, 5);
      const result = Vec2i32.cross(a, b);
      assert.equal(result, -2);
    });

    it('should calculate the cross product of three vectors', () => {
      const a = new Vec2i32(1, 1);
      const b = new Vec2i32(2, 2);
      const c = new Vec2i32(3, 3);
      const result = Vec2i32.cross3(a, b, c);
      assert.equal(result, 0);
    });

    it.skip('should calculate the theta angle of a vector', () => {
      const v = new Vec2i32(1, 1);
      const result = Vec2i32.thetaEx(v);
      assert.equal(result, Math.round(Math.PI / 4 * mathi32_MULTIPLIER));
    });

    it.skip('should calculate the phi angle of a vector', () => {
      const v = new Vec2i32(3, 4);
      const result = Vec2i32.phiEx(v);
      assert.equal(result, Math.round(Math.asin(4 / 5) * mathi32_MULTIPLIER));
    });
  });

  describe('Static advanced functions', () => {
    it('should normalize a vector', () => {
      const v = new Vec2i32(3, 4);
      const result = Vec2i32.norm(v);
      assert.equal(result.x, 0);
      assert.equal(result.y, 0);
    });

    it('should rotate a vector -90 degrees', () => {
      const v = new Vec2i32(1, 2);
      const result = Vec2i32.rotn90(v);
      assert.equal(result.x, 2);
      assert.equal(result.y, -1);
    });

    it('should rotate a vector 90 degrees', () => {
      const v = new Vec2i32(1, 2);
      const result = Vec2i32.rot90(v);
      assert.equal(result.x, -2);
      assert.equal(result.y, 1);
    });
  });

  describe('Instance primitive operators', () => {
    it('should negate a vector in-place', () => {
      const v = new Vec2i32(1, -2);
      v.ineg();
      assert.equal(v.x, -1);
      assert.equal(v.y, 2);
    });

    it('should add another vector in-place', () => {
      const a = new Vec2i32(1, 2);
      const b = new Vec2i32(3, 4);
      a.iadd(b);
      assert.equal(a.x, 4);
      assert.equal(a.y, 6);
    });

    it('should add a scalar in-place', () => {
      const v = new Vec2i32(1, 2);
      v.iadds(3);
      assert.equal(v.x, 4);
      assert.equal(v.y, 5);
    });

    it('should subtract another vector in-place', () => {
      const a = new Vec2i32(5, 7);
      const b = new Vec2i32(2, 3);
      a.isub(b);
      assert.equal(a.x, 3);
      assert.equal(a.y, 4);
    });

    it('should subtract a scalar in-place', () => {
      const v = new Vec2i32(5, 7);
      v.isubs(2);
      assert.equal(v.x, 3);
      assert.equal(v.y, 5);
    });

    it('should multiply by another vector in-place', () => {
      const a = new Vec2i32(2, 3);
      const b = new Vec2i32(4, 5);
      a.imul(b);
      assert.equal(a.x, 8);
      assert.equal(a.y, 15);
    });

    it('should multiply by a scalar in-place', () => {
      const v = new Vec2i32(2, 3);
      v.imuls(4);
      assert.equal(v.x, 8);
      assert.equal(v.y, 12);
    });

    it('should divide by another vector in-place', () => {
      const a = new Vec2i32(8, 15);
      const b = new Vec2i32(2, 3);
      a.idiv(b);
      assert.equal(a.x, 4);
      assert.equal(a.y, 5);
    });

    it('should divide by a scalar in-place', () => {
      const v = new Vec2i32(8, 12);
      v.idivs(4);
      assert.equal(v.x, 2);
      assert.equal(v.y, 3);
    });
  });

  describe('Instance advanced functions', () => {
    it.skip('should normalize a vector in-place', () => {
      const v = new Vec2i32(3, 4);
      v.inorm();
      assert.equal(v.x, 0);
      assert.equal(v.y, 0);
    });

    it('should rotate a vector -90 degrees in-place', () => {
      const v = new Vec2i32(1, 2);
      v.irotn90();
      assert.equal(v.x, 2);
      assert.equal(v.y, -1);
    });

    it.skip('should rotate a vector 90 degrees in-place', () => {
      const v = new Vec2i32(1, 2);
      v.irot90();
      assert.equal(v.x, -2);
      assert.equal(v.y, 1);
    });
  });

  describe('Default Vec2i32 instance', () => {
    it('should have x and y set to 0', () => {
      assert.equal(def_Vec2i32.x, 0);
      assert.equal(def_Vec2i32.y, 0);
    });

    it('should be frozen', () => {
      assert(Object.isFrozen(def_Vec2i32));
    });

    it('should be sealed', () => {
      assert(Object.isSealed(def_Vec2i32));
    });
  });
});