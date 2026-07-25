
class TestValidator {
  #adaptor = null;
  #validator = null;
  #test = {};
  constructor(adaptor, validator, test) {
    this.#adaptor = adaptor;
    this.#validator = validator;
    this.#test = test;
  }
  test() {
    const adaptor = this.#adaptor;
    if (adaptor == null)
      throw new Error('No adaptor');

    const validator = this.#validator;
    if (validator == null)
      throw new Error('No validator');

    const asserts = this.#test.tests;
    let failures = 0;

    const start = performance.now();
    for (let j = 0; j < asserts.length; ++j) {
      const item = asserts[j];
      // @ts-ignore
      const valid = adaptor.run(validator, item.data) === item.valid;
      if (!valid) {
        failures++;
        if (adaptor.name === 'Jaren') {
           console.log(`FAIL at ${adaptor.name} -> [${this.#test.description}]: ${item.description}(${j})`);
           // console.log('Schema:', JSON.stringify(this.#test.schema, null, 2));
           // console.log('Data:', JSON.stringify(item.data, null, 2));
           // console.log('Expected:', item.valid);
        }
      }
    }
    const end = performance.now();

    return {
      failures,
      total: asserts.length,
      time: end - start
    };
  }

}

export class TestRunner {
  #draft = '';
  #adaptor = null;
  #instance = null;

  constructor(draft, adaptor) {
    this.#draft = draft;
    this.#adaptor = adaptor;
    this.#instance = null;
  }

  load(remotes) {
    if (this.#adaptor) {
      // @ts-ignore
      this.#instance = this.#adaptor.loader(this.#draft, remotes);
    }
  }

  createTest(test, suiteName = undefined) {
    if (this.#adaptor) {
      const adaptor = this.#adaptor;
      // @ts-ignore
      const validator = adaptor.setup(this.#instance, test.schema, suiteName)
      return new TestValidator(adaptor, validator, test);
    }
  }

  static #validators = [];

  static initialize(draft, ...adaptors) {
    const validators = [];
    for (let i = 0; i < adaptors.length; ++i) {
      const adaptor = adaptors[i];
      const validator = new TestRunner(draft, adaptor);
      validators.push(validator);
    }
    TestRunner.#validators = validators;
  }

  static load(remotes) {
    for (let i = 0; i < TestRunner.#validators.length; ++i) {
      const validator = TestRunner.#validators[i];
      validator.load(remotes);
    }
  }

  static runTest(test, suiteName = undefined) {
    const results = [];
    for (let i = 0; i < TestRunner.#validators.length; ++i) {
      const validator = TestRunner.#validators[i];
      const adaptorName = validator.#adaptor.name;
      try {
        const runner = validator.createTest(test, suiteName);
        const result = runner.test();
        results.push({
          validator: adaptorName,
          ...result
        });
      } catch (err) {
        console.log(`- ${adaptorName} failed: ${err.message}`);
        results.push({
          validator: adaptorName,
          error: err.message,
          failures: 0,
          total: 0,
          time: 0
        });
      }
    }
    return results;
  }
}
