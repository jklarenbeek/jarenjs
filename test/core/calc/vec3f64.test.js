import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3f64, Vec2f64 } from '@jarenjs/core/calc';

describe('Vec3f64', () => {
  describe('constructor and new', () => {
    it('should create a new Vec3f64 with default values', () => {
      const v = new Vec3f64();
      assert.equal(v.x, 0);
      assert.equal(v.y, 0);
      assert.equal(v.z, 0);
    });

    it('should create a new Vec3f64 with specified values', () => {
      const v = new Vec3f64(3, 4, 5);
      assert.equal(v.x, 3);
      assert.equal(v.y, 4);
      assert.equal(v.z, 5);
    });

    it('should create a new Vec3f64 from another Vec3f64', () => {
      const v1 = new Vec3f64(3, 4, 5);
      const v2 = Vec3f64.new(v1);
      assert.equal(v2.x, 3);
      assert.equal(v2.y, 4);
      assert.equal(v2.z, 5);
    });

    it.skip('should create a new Vec3f64 from a Vec2f64', () => {
      const v2d = new Vec2f64(3, 4);
      const v3d = Vec3f64.new(v2d, 5);
      assert.equal(v3d.x, 3);
      assert.equal(v3d.y, 4);
      assert.equal(v3d.z, 5);
    });
  });

  describe('static methods', () => {
    it('should add two vectors', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      const result = Vec3f64.add(v1, v2);
      assert.equal(result.x, 5);
      assert.equal(result.y, 7);
      assert.equal(result.z, 9);
    });

    it('should add a scalar to a vector', () => {
      const v = new Vec3f64(1, 2, 3);
      const result = Vec3f64.adds(v, 3);
      assert.equal(result.x, 4);
      assert.equal(result.y, 5);
      assert.equal(result.z, 6);
    });

    it('should subtract two vectors', () => {
      const v1 = new Vec3f64(4, 5, 6);
      const v2 = new Vec3f64(1, 2, 3);
      const result = Vec3f64.sub(v1, v2);
      assert.equal(result.x, 3);
      assert.equal(result.y, 3);
      assert.equal(result.z, 3);
    });

    it('should subtract a scalar from a vector', () => {
      const v = new Vec3f64(4, 5, 6);
      const result = Vec3f64.subs(v, 2);
      assert.equal(result.x, 2);
      assert.equal(result.y, 3);
      assert.equal(result.z, 4);
    });

    it('should multiply two vectors', () => {
      const v1 = new Vec3f64(2, 3, 4);
      const v2 = new Vec3f64(5, 6, 7);
      const result = Vec3f64.mul(v1, v2);
      assert.equal(result.x, 10);
      assert.equal(result.y, 18);
      assert.equal(result.z, 28);
    });

    it('should multiply a vector by a scalar', () => {
      const v = new Vec3f64(2, 3, 4);
      const result = Vec3f64.muls(v, 2);
      assert.equal(result.x, 4);
      assert.equal(result.y, 6);
      assert.equal(result.z, 8);
    });

    it('should divide two vectors', () => {
      const v1 = new Vec3f64(10, 18, 28);
      const v2 = new Vec3f64(2, 3, 4);
      const result = Vec3f64.div(v1, v2);
      assert.equal(result.x, 5);
      assert.equal(result.y, 6);
      assert.equal(result.z, 7);
    });

    it('should divide a vector by a scalar', () => {
      const v = new Vec3f64(4, 6, 8);
      const result = Vec3f64.divs(v, 2);
      assert.equal(result.x, 2);
      assert.equal(result.y, 3);
      assert.equal(result.z, 4);
    });

    it('should calculate the dot product of two vectors', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      const result = Vec3f64.dot(v1, v2);
      assert.equal(result, 32);
    });

    it('should calculate the cross product of two vectors', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      const result = Vec3f64.cross(v1, v2);
      assert.equal(result.x, -3);
      assert.equal(result.y, 6);
      assert.equal(result.z, -3);
    });

    it('should calculate the magnitude squared of a vector', () => {
      const v = new Vec3f64(3, 4, 5);
      const result = Vec3f64.mag2(v);
      assert.equal(result, 50);
    });

    it('should calculate the magnitude of a vector', () => {
      const v = new Vec3f64(3, 4, 5);
      const result = Vec3f64.mag(v);
      assert.equal(result, Math.sqrt(50));
    });

    it('should normalize a vector', () => {
      const v = new Vec3f64(3, 4, 5);
      const result = Vec3f64.unit(v);
      const mag = Math.sqrt(50);
      assert.equal(result.x, 3 / mag);
      assert.equal(result.y, 4 / mag);
      assert.equal(result.z, 5 / mag);
    });
  });

  describe('instance methods', () => {
    it('should add another vector in place', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      v1.iadd(v2);
      assert.equal(v1.x, 5);
      assert.equal(v1.y, 7);
      assert.equal(v1.z, 9);
    });

    it('should add a scalar in place', () => {
      const v = new Vec3f64(1, 2, 3);
      v.iadds(3);
      assert.equal(v.x, 4);
      assert.equal(v.y, 5);
      assert.equal(v.z, 6);
    });

    it('should subtract another vector in place', () => {
      const v1 = new Vec3f64(4, 5, 6);
      const v2 = new Vec3f64(1, 2, 3);
      v1.isub(v2);
      assert.equal(v1.x, 3);
      assert.equal(v1.y, 3);
      assert.equal(v1.z, 3);
    });

    it('should subtract a scalar in place', () => {
      const v = new Vec3f64(4, 5, 6);
      v.isubs(2);
      assert.equal(v.x, 2);
      assert.equal(v.y, 3);
      assert.equal(v.z, 4);
    });

    it('should multiply by another vector in place', () => {
      const v1 = new Vec3f64(2, 3, 4);
      const v2 = new Vec3f64(5, 6, 7);
      v1.imul(v2);
      assert.equal(v1.x, 10);
      assert.equal(v1.y, 18);
      assert.equal(v1.z, 28);
    });

    it('should multiply by a scalar in place', () => {
      const v = new Vec3f64(2, 3, 4);
      v.imuls(2);
      assert.equal(v.x, 4);
      assert.equal(v.y, 6);
      assert.equal(v.z, 8);
    });

    it('should divide by another vector in place', () => {
      const v1 = new Vec3f64(10, 18, 28);
      const v2 = new Vec3f64(2, 3, 4);
      v1.idiv(v2);
      assert.equal(v1.x, 5);
      assert.equal(v1.y, 6);
      assert.equal(v1.z, 7);
    });

    it('should divide by a scalar in place', () => {
      const v = new Vec3f64(4, 6, 8);
      v.idivs(2);
      assert.equal(v.x, 2);
      assert.equal(v.y, 3);
      assert.equal(v.z, 4);
    });

    it('should calculate the dot product with another vector', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      const result = v1.dot(v2);
      assert.equal(result, 32);
    });

    it.skip('should calculate the cross product with another vector in place', () => {
      const v1 = new Vec3f64(1, 2, 3);
      const v2 = new Vec3f64(4, 5, 6);
      v1.icross(v2);
      assert.equal(v1.x, -3);
      assert.equal(v1.y, 6);
      assert.equal(v1.z, -3);
    });

    it('should calculate the magnitude squared of the vector', () => {
      const v = new Vec3f64(3, 4, 5);
      const result = v.mag2();
      assert.equal(result, 50);
    });

    it('should calculate the magnitude of the vector', () => {
      const v = new Vec3f64(3, 4, 5);
      const result = v.mag();
      assert.equal(result, Math.sqrt(50));
    });

    it('should normalize the vector in place', () => {
      const v = new Vec3f64(3, 4, 5);
      v.iunit();
      const mag = Math.sqrt(50);
      assert.equal(v.x, 3 / mag);
      assert.equal(v.y, 4 / mag);
      assert.equal(v.z, 5 / mag);
    });
  });
});