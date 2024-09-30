
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
    for (let j = 0; j < asserts.length; ++j) {
      const item = asserts[j];
      // @ts-ignore
      const valid = adaptor.run(validator, item.data) === item.valid;
      console.log(`- ${item.description} = ${valid}`);
    }
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
  
  createTest(test) {
    if (this.#adaptor) {
      const adaptor = this.#adaptor;
      // @ts-ignore
      const validator = this.#adaptor.setup(this.#instance, test.schema)
      return new TestValidator(adaptor, validator, test);
    }
  }

  static #validators = [];
  static #remotes = {};

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
    // TODO: unload remotes
    TestRunner.#remotes = remotes;
    for (let i = 0; i < TestRunner.#validators.length; ++i) {
      const validator = TestRunner.#validators[i];
      validator.load(remotes);
    }
  }

  static runTest(test) {
    console.log(`### test: '${test.description}'`);

    for (let i = 0; i < TestRunner.#validators.length; ++i) {
      const validator = TestRunner.#validators[i];
      const runner = validator.createTest(test);
      runner.test();
    }
  }
}
