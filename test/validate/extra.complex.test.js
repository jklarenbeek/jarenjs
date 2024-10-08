import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const compiler = new JarenValidator();
compiler.addFormats(formats.stringFormats)
  .addFormats(formats.dateTimeFormats);

// from: https://json-schema.org/learn/miscellaneous-examples#conditional-validation-with-dependentrequired

describe('Schema Complex Examples', function () {

  describe('#complex_basic()', function () {
    it('should validate a complex strings', function () {
      const validate = compiler.compile({
        type: 'string',
        required: true,
        minLength: 2,
        allOf: [
          { maxLength: 3 },
          { maxLength: 5 },
        ],
      });

      assert.isFalse(validate(undefined));
      assert.isFalse(validate(null));
      assert.isFalse(validate('A'), 'A string is too small');
      assert.isTrue(validate('AB'), 'AB string has valid length');
      assert.isTrue(validate('ABC'), 'ABC string has valid length');
      assert.isFalse(validate('ABCDEF'), 'ABCDEF is to long');
    });

    it('should compile a basic complex schema', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/person.schema.json',
        title: 'Person',
        type: 'object',
        properties: {
          firstName: {
            type: 'string',
            description: "The person's first name.",
          },
          lastName: {
            type: 'string',
            description: "The person's last name.",
          },
          age: {
            description: 'Age in years which must be equal to or greater than zero.',
            type: 'integer',
            minimum: 0,
          },
        },
      });


      assert.isTrue(validate({
        firstName: 'John',
        lastName: 'Doe',
        age: 21,
      }), 'John Doe, aged 21 is a valid person entry');

    });
  });

  describe('#complex_arrays()', function () {
    it('should compile a schema with an reference to an array', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/arrays.schema.json',
        description: 'A representation of a person, company, organization, or place',
        type: 'object',
        properties: {
          fruits: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          vegetables: {
            type: 'array',
            items: { $ref: '#/$defs/veggie' },
          },
        },
        $defs: {
          veggie: {
            type: 'object',
            required: ['veggieName', 'veggieLike'],
            properties: {
              veggieName: {
                type: 'string',
                description: 'The name of the vegetable.',
              },
              veggieLike: {
                type: 'boolean',
                description: 'Do I like this vegetable?',
              },
            },
          },
        },
      });


      assert.isTrue(validate({
        fruits: ['apple', 'orange', 'pear'],
        vegetables: [
          {
            veggieName: 'potato',
            veggieLike: true,
          },
          {
            veggieName: 'broccoli',
            veggieLike: false,
          },
        ],
      }));
    });
  });

  describe('#complex_enums()', function () {
    it('should handle enum data', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/enumerated-values.schema.json',
        title: 'Enumerated Values',
        type: 'object',
        properties: {
          data: {
            enum: [42, true, 'hello', null, [1, 2, 3]],
          },
        },
      });


      assert.isTrue(validate({
        data: [1, 2, 3],
      }), 'The data of the object has the right value');
    });
  });

  describe('#complex_nested()', function () {
    it('should compile a complex schema with nested properties', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/complex-object.schema.json',
        title: 'Complex Object',
        type: 'object',
        properties: {
          name: {
            type: 'string',
          },
          age: {
            type: 'integer',
            minimum: 0,
          },
          address: {
            type: 'object',
            properties: {
              street: {
                type: 'string',
              },
              city: {
                type: 'string',
              },
              state: {
                type: 'string',
              },
              postalCode: {
                type: 'string',
                pattern: '\\d{5}',
              },
            },
            required: ['street', 'city', 'state', 'postalCode'],
          },
          hobbies: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['name', 'age'],
      });


      assert.isTrue(validate({
        name: 'John Doe',
        age: 25,
        address: {
          street: '123 Main St',
          city: 'New York',
          state: 'NY',
          postalCode: '10001',
        },
        hobbies: ['reading', 'running'],
      }), 'The complex schema with nested properties is valid');
    });
  });

  describe('#complex_fstab()', function () {
    it('should validate a /etc/fstab json file', function () {
      // https://json-schema.org/learn/file-system
      const entrySchema = {
        $id: 'https://example.com/entry-schema',
        description: 'JSON Schema for an fstab entry',
        type: 'object',
        required: ['storage'],
        properties: {
          storage: {
            type: 'object',
            oneOf: [
              { $ref: '#/$defs/diskDevice' },
              { $ref: '#/$defs/diskUUID' },
              { $ref: '#/$defs/nfs' },
              { $ref: '#/$defs/tmpfs' },
            ],
          },
          fstype: {
            enum: ['ext3', 'ext4', 'btrfs'],
          },
          options: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'string',
            },
            uniqueItems: true,
          },
          readonly: {
            type: 'boolean',
          },
        },
        $defs: {
          diskDevice: {
            properties: {
              type: {
                enum: ['disk'],
              },
              device: {
                type: 'string',
                pattern: '^/dev/[^/]+(/[^/]+)*$',
              },
            },
            required: ['type', 'device'],
            additionalProperties: false,
          },
          diskUUID: {
            properties: {
              type: {
                enum: ['disk'],
              },
              label: {
                type: 'string',
                pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',
              },
            },
            required: ['type', 'label'],
            additionalProperties: false,
          },
          nfs: {
            properties: {
              type: { enum: ['nfs'] },
              remotePath: {
                type: 'string',
                pattern: '^(/[^/]+)+$',
              },
              server: {
                type: 'string',
                oneOf: [
                  { format: 'hostname' },
                  { format: 'ipv4' },
                  { format: 'ipv6' },
                ],
              },
            },
            required: ['type', 'server', 'remotePath'],
            additionalProperties: false,
          },
          tmpfs: {
            properties: {
              type: { enum: ['tmpfs'] },
              sizeInMB: {
                type: 'integer',
                minimum: 16,
                maximum: 512,
              },
            },
            required: ['type', 'sizeInMB'],
            additionalProperties: false,
          },
        },
      };

      const validate = compiler.compile({
        $id: 'https://example.com/fstab',
        type: 'object',
        required: ['/'],
        properties: {
          '/': { $ref: 'https://example.com/entry-schema' },
        },
        patternProperties: {
          '^(/[^/]+)+$': { $ref: 'https://example.com/entry-schema' },
        },
        additionalProperties: false,
      }, [entrySchema]);

      assert.isTrue(validate({
        '/': {
          storage: {
            type: 'disk',
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
        '/var': {
          storage: {
            type: 'disk',
            label: '8f3ba6f4-5c70-46ec-83af-0d5434953e5f',
          },
          fstype: 'ext4',
          options: ['nosuid'],
        },
        '/tmp': {
          storage: {
            type: 'tmpfs',
            sizeInMB: 64,
          },
        },
        '/var/www': {
          storage: {
            type: 'nfs',
            server: 'my.nfs.server',
            remotePath: '/exports/mypath',
          },
        },
      }), 'a valid fstab json file');
      assert.isFalse(validate(1), 'not an object');
      assert.isTrue(validate({
        '/': {
          storage: {
            type: 'disk',
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'root only is valid');
      assert.isFalse(validate({
        'no-root/': {
          storage: {
            type: 'disk',
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'missing root entry');
      assert.isFalse(validate({
        '/': {
          storage: {
            type: 'disk',
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
        'invalid/var': {
          storage: {
            type: 'disk',
            label: '8f3ba6f4-5c70-46ec-83af-0d5434953e5f',
          },
          fstype: 'ext4',
          options: ['nosuid'],
        },
      }), 'invalid entry key');
      assert.isFalse(validate({
        '/': {
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'missing storage in entry');
      assert.isFalse(validate({
        '/': {
          storage: {
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'missing storage type');
      assert.isFalse(validate({
        '/': {
          storage: {
            type: null,
            device: '/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'storage type should be a string');
      assert.isFalse(validate({
        '/': {
          storage: {
            type: null,
            device: 'invalid/dev/sda1',
          },
          fstype: 'btrfs',
          readonly: true,
        },
      }), 'storage device should match pattern');
    });

    it('should validate a device type', function () {
      const deviceSchema = {
        $id: 'https://example.com/device.schema.json',
        type: 'object',
        properties: {
          deviceType: {
            type: 'string',
          },
        },
        required: ['deviceType'],
        oneOf: [
          {
            properties: {
              deviceType: { const: 'smartphone' },
            },
            $ref: 'https://example.com/smartphone.schema.json',
          },
          {
            properties: {
              deviceType: { const: 'laptop' },
            },
            $ref: 'https://example.com/laptop.schema.json',
          },
        ],
      };

      const smartphoneSchema = {
        $id: 'https://example.com/smartphone.schema.json',
        type: 'object',
        properties: {
          brand: {
            type: 'string',
          },
          model: {
            type: 'string',
          },
          screenSize: {
            type: 'number',
          },
        },
        required: ['brand', 'model', 'screenSize'],
      };

      const laptopSchema = {
        $id: 'https://example.com/laptop.schema.json',
        type: 'object',
        properties: {
          brand: {
            type: 'string',
          },
          model: {
            type: 'string',
          },
          processor: {
            type: 'string',
          },
          ramSize: {
            type: 'number',
          },
        },
        required: ['brand', 'model', 'processor', 'ramSize'],
      };

      const validate = compiler.compile(
        deviceSchema,
        [smartphoneSchema, laptopSchema]
      );

      assert.isTrue(validate({
        deviceType: 'smartphone',
        brand: 'Samsung',
        model: 'Galaxy S21',
        screenSize: 6.2,
      }), 'a valid device type');

    });

    it('should validate an address similar to http://microformats.org/wiki/h-card', function () {
      // https://json-schema.org/learn/json-schema-examples
      const validate = compiler.compile({
        $id: 'https://example.com/address.schema.json',
        description: 'An address similar to http://microformats.org/wiki/h-card',
        type: 'object',
        properties: {
          postOfficeBox: {
            type: 'string',
          },
          extendedAddress: {
            type: 'string',
          },
          streetAddress: {
            type: 'string',
          },
          locality: {
            type: 'string',
          },
          region: {
            type: 'string',
          },
          postalCode: {
            type: 'string',
          },
          countryName: {
            type: 'string',
          },
        },
        required: ['locality', 'region', 'countryName'],
        dependentRequired: {
          postOfficeBox: ['streetAddress'],
          extendedAddress: ['streetAddress'],
        },
      });

      assert.isTrue(validate({
        postOfficeBox: '123',
        streetAddress: '456 Main St',
        locality: 'Cityville',
        region: 'State',
        postalCode: '12345',
        countryName: 'Country',
      }), 'a valid address');

    });

    it('should validate an ecommerce entry', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/ecommerce.schema.json',
        $defs: {
          product: {
            $anchor: 'ProductSchema',
            type: 'object',
            properties: {
              name: { type: 'string' },
              price: { type: 'number', minimum: 0 },
            },
          },
          order: {
            $anchor: 'OrderSchema',
            type: 'object',
            properties: {
              orderId: { type: 'string' },
              items: {
                type: 'array',
                items: { $ref: '#ProductSchema' },
              },
            },
          },
        },
      });

      assert.isTrue(validate({
        order: {
          orderId: 'ORD123',
          items: [
            {
              name: 'Product A',
              price: 50,
            },
            {
              name: 'Product B',
              price: 30,
            },
          ],
        },
      }), 'should validate an ecommerce order');

    });

    it('should validate a job posting', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/job-posting.schema.json',
        description: 'A representation of a job posting',
        type: 'object',
        required: ['title', 'company', 'location', 'description'],
        properties: {
          title: {
            type: 'string',
          },
          company: {
            type: 'string',
          },
          location: {
            type: 'string',
          },
          description: {
            type: 'string',
          },
          employmentType: {
            type: 'string',
          },
          salary: {
            type: 'number',
            minimum: 0,
          },
          applicationDeadline: {
            type: 'string',
            format: 'date',
          },
        },
      });

      assert.isTrue(validate({
        title: 'Software Engineer',
        company: 'Tech Solutions Inc.',
        location: 'Cityville',
        description: 'Join our team as a software engineer...',
        employmentType: 'Full-time',
        salary: 80000,
        applicationDeadline: '2023-09-15',
      }), 'the job posting is complete');

    });

    it('should validate a movie record', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/movie.schema.json',
        description: 'A representation of a movie',
        type: 'object',
        required: ['title', 'director', 'releaseDate'],
        properties: {
          title: {
            type: 'string',
          },
          director: {
            type: 'string',
          },
          releaseDate: {
            type: 'string',
            format: 'date',
          },
          genre: {
            type: 'string',
            enum: ['Action', 'Comedy', 'Drama', 'Science Fiction'],
          },
          duration: {
            type: 'string',
          },
          cast: {
            type: 'array',
            items: {
              type: 'string',
            },
            additionalItems: false,
          },
        },
      });

      assert.isTrue(validate({
        title: 'Sample Movie',
        director: 'John Director',
        releaseDate: '2023-07-01',
        genre: 'Action',
        duration: '2h 15m',
        cast: ['Actor A', 'Actress B', 'Actor C'],
      }), 'a valid sample movie');
    });
  });

  describe('#complex_user()', function () {
    const userProfileSchema = {
      $id: 'https://example.com/user-profile.schema.json',
      description: 'A representation of a user profile',
      type: 'object',
      required: ['username', 'email'],
      properties: {
        username: {
          type: 'string',
        },
        email: {
          type: 'string',
          format: 'email',
        },
        fullName: {
          type: 'string',
        },
        age: {
          type: 'integer',
          minimum: 0,
        },
        location: {
          type: 'string',
        },
        interests: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    };

    it('should validate a user profile', function () {
      const validate = compiler.compile(userProfileSchema);

      assert.isTrue(validate({
        username: 'user123',
        email: 'user@example.com',
        fullName: 'John Doe',
        age: 30,
        location: 'Cityville',
        interests: ['Travel', 'Technology'],
      }), 'a valid user profile');
    });

    it('should validate a blog post entry', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/blog-post.schema.json',
        description: 'A representation of a blog post',
        type: 'object',
        required: ['title', 'content', 'author'],
        properties: {
          title: {
            type: 'string',
          },
          content: {
            type: 'string',
          },
          publishedDate: {
            type: 'string',
            format: 'date-time',
          },
          author: {
            $ref: 'https://example.com/user-profile.schema.json',
          },
          tags: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
      }, [userProfileSchema]);

      assert.isTrue(validate({
        title: 'New Blog Post',
        content: 'This is the content of the blog post...',
        publishedDate: '2023-08-25T15:00:00Z',
        author: {
          username: 'authoruser',
          email: 'author@example.com',
        },
        tags: ['Technology', 'Programming'],
      }));

    });

    const geoLocationSchema = {
      $id: 'https://example.com/geographical-location.schema.json',
      title: 'Longitude and Latitude Values',
      description: 'A geographical coordinate.',
      required: ['latitude', 'longitude'],
      type: 'object',
      properties: {
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
        },
      },
    };

    it('should verify a geographical location', function () {
      const validate = compiler.compile(geoLocationSchema);

      assert.isTrue(validate({
        latitude: 48.858093,
        longitude: 2.294694,
      }), 'the geolocation is valid');

    });

    it('should validate a calendar event', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/calendar.schema.json',
        description: 'A representation of an event',
        type: 'object',
        required: ['startDate', 'summary'],
        properties: {
          startDate: {
            type: 'string',
            description: 'Event starting time',
          },
          endDate: {
            type: 'string',
            description: 'Event ending time',
          },
          summary: {
            type: 'string',
          },
          location: {
            type: 'string',
          },
          url: {
            type: 'string',
          },
          duration: {
            type: 'string',
            description: 'Event duration',
          },
          recurrenceDate: {
            type: 'string',
            description: 'Recurrence date',
          },
          recurrenceRule: {
            type: 'string',
            description: 'Recurrence rule',
          },
          category: {
            type: 'string',
          },
          description: {
            type: 'string',
          },
          geo: {
            $ref: 'https://example.com/geographical-location.schema.json',
          },
        },
      }, [geoLocationSchema]);


      assert.isTrue(validate({
        startDate: '2023-08-25T10:00:00Z',
        endDate: '2023-08-25T12:00:00Z',
        summary: 'Conference Presentation',
        location: 'Conference Center',
        recurrenceRule: 'FREQ=DAILY;COUNT=5',
      }), 'a valid calendar event');

    });

    it('should represent a health record', function () {
      const validate = compiler.compile({
        $id: 'https://example.com/health-record.schema.json',
        description: 'Schema for representing a health record',
        type: 'object',
        required: ['patientName', 'dateOfBirth', 'bloodType'],
        properties: {
          patientName: {
            type: 'string',
          },
          dateOfBirth: {
            type: 'string',
            format: 'date',
          },
          bloodType: {
            type: 'string',
          },
          allergies: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          conditions: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          medications: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          emergencyContact: {
            $ref: 'https://example.com/user-profile.schema.json',
          },
        },
      }, [userProfileSchema]);

      assert.isTrue(validate({
        patientName: 'Jane Doe',
        dateOfBirth: '1985-02-15',
        bloodType: 'A+',
        allergies: ['Pollen', 'Penicillin'],
        conditions: ['Hypertension', 'Diabetes'],
        medications: ['Lisinopril', 'Metformin'],
        emergencyContact: {
          username: 'emergencyuser',
          email: 'emergency@example.com',
        },
      }), 'validate a health record');
    });
  });
});
